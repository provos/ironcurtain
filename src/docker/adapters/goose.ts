/**
 * Goose agent adapter for Docker Agent Mode.
 *
 * Configures a Docker container running Goose (by Block) with:
 * - MCP server discovery via config.yaml (YAML, Goose extensions format)
 * - System prompt injection via --instructions file
 * - Multi-provider support (Anthropic, OpenAI, Google)
 * - GOOSE_MODE=auto to skip all permission prompts
 *
 * Key differences from Claude Code adapter:
 * - Config format is YAML (not JSON)
 * - System prompt is file-based (not inline CLI flag)
 * - No session continuity in batch mode (each turn is independent)
 * - Output is plain text (no --output-format json)
 * - Provider-specific credential detection (not Anthropic-only)
 */

import { randomBytes } from 'node:crypto';
import type { AgentAdapter, AgentConfigFile, AgentId, AgentResponse, OrientationContext } from '../agent-adapter.js';
import type { IronCurtainConfig } from '../../config/types.js';
import type { ProviderConfig } from '../provider-config.js';
import type { AuthMethod } from '../oauth-credentials.js';
import type { ResolvedUserConfig, GooseProvider } from '../../config/user-config.js';
import { anthropicProvider, openaiProvider, googleProvider } from '../provider-config.js';
import { buildSystemPrompt } from '../../session/prompts.js';
import { resolveApiKeyForProvider } from '../../config/model-provider.js';
import {
  buildResizePtyScript,
  buildCheckPtySizeScript,
  buildNetworkSection,
  buildPolicySection,
  buildAttributionSection,
} from './shared-scripts.js';

const GOOSE_IMAGE = 'ironcurtain-goose:latest';

/** Default heredoc delimiter for shell commands. */
const DEFAULT_HEREDOC_DELIMITER = 'IRONCURTAIN_EOF';

// ─── Provider Helpers ────────────────────────────────────────

/**
 * Returns the provider config for the selected Goose provider.
 */
export function getProviderConfig(provider: GooseProvider): ProviderConfig {
  switch (provider) {
    case 'anthropic':
      return anthropicProvider;
    case 'openai':
      return openaiProvider;
    case 'google':
      return googleProvider;
  }
}

// ─── Response Parsing ────────────────────────────────────────

/**
 * Strips ANSI escape codes from a string.
 */
export function stripAnsi(text: string): string {
  // Matches common ANSI escape sequences: CSI (ESC[), OSC (ESC]), and simple ESC sequences
  // eslint-disable-next-line no-control-regex -- ANSI escape codes are control characters by definition
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]/g, '');
}

/**
 * Parses Goose's `--output-format json` envelope and returns the
 * concatenated text of all assistant messages. Returns null if the
 * envelope is missing, malformed, or has no assistant text — the caller
 * falls back to the raw stripped output in that case.
 *
 * Goose emits one assistant message per agent invocation, so a turn
 * with intermediate tool calls produces multiple assistant messages
 * separated by tool-call/tool-result entries. Concatenating their text
 * preserves the model's narrative without surfacing the tool chrome.
 */
export function extractAssistantText(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;

  const segments: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const c of msg.content) {
      if (!c || typeof c !== 'object') continue;
      const item = c as { type?: unknown; text?: unknown };
      if (item.type === 'text' && typeof item.text === 'string') {
        segments.push(item.text);
      }
    }
  }

  if (segments.length === 0) return null;
  return segments.join('\n\n').trim();
}

// ─── Heredoc Escaping ────────────────────────────────────────

/**
 * Ensures a heredoc delimiter does not collide with the input content.
 *
 * If the default delimiter appears in the content, appends random hex
 * suffixes until a unique delimiter is found. The content itself is
 * never modified -- only the delimiter changes.
 */
export function escapeHeredoc(content: string): { delimiter: string } {
  let delimiter = DEFAULT_HEREDOC_DELIMITER;

  while (content.includes(delimiter)) {
    const suffix = randomBytes(4).toString('hex');
    delimiter = `${DEFAULT_HEREDOC_DELIMITER}_${suffix}`;
  }

  return { delimiter };
}

// ─── System Prompt ───────────────────────────────────────────

function buildGooseDockerEnvironmentPrompt(context: OrientationContext): string {
  return `## Docker Environment

### Workspace (\`${context.workspaceDir}\`)
This is your workspace inside the container. You have full access here.
For local file operations inside ${context.workspaceDir}, use your built-in tools.

### External Operations (MCP tools)
Use the IronCurtain MCP extension for operations that require external access:
- Network requests (HTTP fetches, web searches, API calls)
- Git remote operations (clone, push, pull, fetch)
- Reading files outside ${context.workspaceDir}

After cloning a repo or writing files via MCP tools, use your built-in
tools for subsequent file operations.

${buildNetworkSection('the IronCurtain MCP tools')}
${buildPolicySection('MCP tool call')}
${buildAttributionSection()}`;
}

// ─── Orientation Scripts ─────────────────────────────────────

function buildStartScript(): string {
  return `#!/bin/bash
# Set initial terminal size from host env vars
if [ -n "$IRONCURTAIN_INITIAL_COLS" ] && [ -n "$IRONCURTAIN_INITIAL_ROWS" ]; then
  stty cols "$IRONCURTAIN_INITIAL_COLS" rows "$IRONCURTAIN_INITIAL_ROWS" 2>/dev/null
fi
# Write system prompt to temp file for --instructions
PROMPT_FILE=$(mktemp /tmp/goose-prompt-XXXXXX.md)
trap 'rm -f "$PROMPT_FILE"' EXIT
printf '%s' "$IRONCURTAIN_SYSTEM_PROMPT" > "$PROMPT_FILE"
exec goose run -s -i "$PROMPT_FILE"
`;
}

// ─── Adapter Factory ─────────────────────────────────────────

/**
 * Creates a Goose agent adapter configured with the user's provider preferences.
 *
 * @param userConfig - Resolved user config. When undefined, uses defaults
 *   (anthropic provider, default model). This enables --list-agents to work
 *   without loading config.
 */
export function createGooseAdapter(userConfig?: ResolvedUserConfig): AgentAdapter {
  const gooseProvider: GooseProvider = userConfig?.gooseProvider ?? 'anthropic';
  const gooseModel: string = userConfig?.gooseModel ?? 'claude-sonnet-4-20250514';

  const credentialHelpText =
    `No API key found for Goose provider "${gooseProvider}". ` +
    'Set the appropriate API key in your environment ' +
    '(ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY) ' +
    'or via `ironcurtain config`.';

  const adapter: AgentAdapter = {
    id: 'goose' as AgentId,
    displayName: 'Goose',
    credentialHelpText,

    // eslint-disable-next-line @typescript-eslint/require-await -- interface requires Promise return
    async getImage(): Promise<string> {
      return GOOSE_IMAGE;
    },

    generateMcpConfig(socketPath: string): AgentConfigFile[] {
      const isTcp = socketPath.includes(':');
      const connectTarget = isTcp ? `TCP:${socketPath}` : `UNIX-CONNECT:${socketPath}`;

      const yaml = [
        'GOOSE_TELEMETRY_ENABLED: false',
        'extensions:',
        '  ironcurtain:',
        '    name: IronCurtain Sandbox',
        '    type: stdio',
        '    enabled: true',
        '    cmd: socat',
        '    args:',
        '      - STDIO',
        `      - ${connectTarget}`,
        '    timeout: 600',
        '',
      ].join('\n');

      return [{ path: 'goose-config.yaml', content: yaml }];
    },

    generateOrientationFiles(): AgentConfigFile[] {
      return [
        { path: 'start-goose.sh', content: buildStartScript(), mode: 0o755 },
        { path: 'resize-pty.sh', content: buildResizePtyScript('goose'), mode: 0o755 },
        { path: 'check-pty-size.sh', content: buildCheckPtySizeScript('goose'), mode: 0o755 },
      ];
    },

    // Goose reads GOOSE_MODEL from container env at startup, so a per-turn
    // override cannot switch models inside a running container. Goose batch
    // mode also doesn't use session resume options.
    buildCommand(
      message: string,
      systemPrompt: string,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _options: {
        readonly sessionId: string;
        readonly firstTurn: boolean;
        readonly modelOverride?: string;
      },
    ): readonly string[] {
      const instructions = `${systemPrompt}\n\n---\n\nUser request:\n${message}`;
      const { delimiter } = escapeHeredoc(instructions);

      return [
        '/bin/sh',
        '-c',
        `PROMPT_FILE=$(mktemp /tmp/goose-prompt-XXXXXX.md) && ` +
          `trap 'rm -f "$PROMPT_FILE"' EXIT && ` +
          `cat > "$PROMPT_FILE" << '${delimiter}'\n${instructions}\n${delimiter}\n` +
          `goose run --no-session --quiet --output-format json -i "$PROMPT_FILE"`,
      ];
    },

    buildSystemPrompt(context: OrientationContext): string {
      const codeModePrompt = buildSystemPrompt(context.serverListings, context.hostSandboxDir);
      const dockerPrompt = buildGooseDockerEnvironmentPrompt(context);
      return `${codeModePrompt}\n${dockerPrompt}`;
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface requires authKind parameter
    getProviders(_authKind?: 'oauth' | 'apikey'): readonly ProviderConfig[] {
      // Goose uses exactly one provider based on user config.
      // The authKind parameter is ignored because Goose does not support OAuth.
      return [getProviderConfig(gooseProvider)];
    },

    buildEnv(_config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Record<string, string> {
      const env: Record<string, string> = {
        GOOSE_PROVIDER: gooseProvider,
        GOOSE_MODEL: gooseModel,
        GOOSE_MODE: 'auto',
        GOOSE_MAX_TURNS: '200',
        // Defensive TLS cert env vars for Rust-based Goose.
        // Covers native-tls and rustls-native-certs backends.
        SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
        SSL_CERT_DIR: '/etc/ssl/certs',
      };

      const providerHost = getProviderConfig(gooseProvider).host;
      const fakeKey = fakeKeys.get(providerHost);
      if (!fakeKey) {
        throw new Error(`No fake key generated for ${providerHost}`);
      }

      switch (gooseProvider) {
        case 'anthropic':
          env.ANTHROPIC_API_KEY = fakeKey;
          break;
        case 'openai':
          env.OPENAI_API_KEY = fakeKey;
          break;
        case 'google':
          env.GOOGLE_API_KEY = fakeKey;
          break;
      }

      return env;
    },

    /**
     * NOTE: this adapter does NOT currently populate
     * `AgentResponse.quotaExhausted` or `AgentResponse.transientFailure`.
     * Goose's `--output-format json` envelope wraps provider errors as
     * plain assistant text (e.g. "Ran into this error: Authentication
     * error: ... 401 ...") with no structured `api_error_status` field
     * or `usage.output_tokens` / `stop_reason` to key off of. A workflow
     * run that hits a 429 or a sustained upstream stall under Goose
     * therefore takes the generic abort path instead of pausing cleanly
     * or marking the run as transient-resumable.
     *
     * Closing these gaps requires either (a) Goose surfacing structured
     * error envelopes upstream, or (b) a fragile regex against known
     * provider messages ("Usage limit reached", "429",
     * "rate_limit_exceeded"); (b) is deliberately not attempted without
     * broader testing across providers. See the Claude Code adapter
     * (`adapters/claude-code.ts`) for the target contract and
     * `AgentResponse.quotaExhausted` / `AgentResponse.transientFailure`
     * in `../agent-adapter.ts` for the interface-level requirement on
     * adapters.
     */
    extractResponse(exitCode: number, stdout: string): AgentResponse {
      const clean = stripAnsi(stdout);

      if (exitCode !== 0) {
        return { text: `Goose exited with code ${exitCode}.\n\nOutput:\n${clean.trim()}` };
      }

      // `goose run --output-format json` returns a structured envelope
      // listing every turn message with typed content. We pick the
      // assistant text — tool_use entries, user echoes, and the CLI
      // chrome are dropped without heuristic guesswork. Fall back to the
      // raw stripped output if the schema ever drifts so we degrade to
      // "noisy but functional" rather than dropping content.
      return { text: extractAssistantText(clean) ?? clean.trim() };
    },

    buildPtyCommand(
      _systemPrompt: string,
      ptySockPath: string | undefined,
      ptyPort: number | undefined,
    ): readonly string[] {
      const listenArg = ptySockPath ? `UNIX-LISTEN:${ptySockPath},fork` : `TCP-LISTEN:${ptyPort},reuseaddr`;

      return ['socat', listenArg, 'EXEC:/etc/ironcurtain/start-goose.sh,pty,setsid,ctty,stderr,rawer'];
    },

    detectCredential(config: IronCurtainConfig): AuthMethod {
      const key = resolveApiKeyForProvider(gooseProvider, config.userConfig);
      if (key) return { kind: 'apikey', key };
      return { kind: 'none' };
    },
  };

  return adapter;
}
