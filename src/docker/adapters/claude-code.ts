/**
 * Claude Code agent adapter -- reference implementation.
 *
 * Configures a Docker container running Claude Code CLI with:
 * - MCP server discovery via settings.json (socat bridge to UDS)
 * - System prompt injection via --append-system-prompt
 * - --continue for session resume across turns
 * - --dangerously-skip-permissions (IronCurtain handles security)
 *
 * The system prompt composes two layers:
 * 1. Code Mode instructions (from session/prompts.ts) for tool discovery
 * 2. Docker environment context explaining workspace, host access, and policy
 */

import type {
  AgentAdapter,
  AgentConfigFile,
  AgentId,
  AgentResponse,
  ConversationStateConfig,
  OrientationContext,
} from '../agent-adapter.js';
import type { IronCurtainConfig } from '../../config/types.js';
import type { ProviderConfig } from '../provider-config.js';
import type { ResolvedUserConfig } from '../../config/user-config.js';
import { parseModelId } from '../../config/model-provider.js';
import {
  anthropicProvider,
  claudePlatformProvider,
  anthropicOAuthProvider,
  claudePlatformOAuthProvider,
} from '../provider-config.js';
import { buildSystemPrompt } from '../../session/prompts.js';
import {
  buildResizePtyScript,
  buildCheckPtySizeScript,
  buildNetworkSection,
  buildPolicySection,
  buildAttributionSection,
} from './shared-scripts.js';

const CLAUDE_CODE_IMAGE = 'ironcurtain-claude-code:latest';

function buildDockerEnvironmentPrompt(context: OrientationContext): string {
  return `## Docker Environment

### Workspace (\`${context.workspaceDir}\`)
This is YOUR local workspace inside the container. Use your normal built-in
tools (Bash, Read, Write, Edit, etc.) freely here -- no restrictions.

### When to use \`execute_code\` (MCP tools)
Use \`execute_code\` ONLY for operations that your built-in tools cannot do:
- **Network requests**: HTTP fetches, web searches, API calls
- **Git remote operations**: clone, push, pull, fetch
- **Reading files outside ${context.workspaceDir}**

For everything else -- listing, reading, searching, writing, and editing files
inside ${context.workspaceDir} -- use your built-in tools (Bash, Read, Write,
Edit, Glob, Grep, etc.). Do NOT use MCP filesystem or git tools for local file
operations inside ${context.workspaceDir}.

After cloning a repo or writing files via \`execute_code\`, switch to built-in
tools for all subsequent file operations on the cloned/written files.
When cloning repos, use ${context.workspaceDir} as the target directory
(e.g. \`${context.workspaceDir}/repo-name\`).

${buildNetworkSection('the sandbox tools via `execute_code`')}

IMPORTANT: Your built-in server-side web search tool (WebSearch) is DISABLED
and will NOT work — it is stripped by the security proxy. You MUST use the
sandbox tools via \`execute_code\` instead. Do NOT attempt to use your
built-in WebSearch or WebFetch tools.

To search the web:
  \`const results = fetch.web_search({ query: "search terms" });\`
To fetch a URL:
  \`const page = fetch.http_fetch({ url: "https://example.com" });\`

${buildPolicySection('tool call through `execute_code`')}

${buildAttributionSection()}
`;
}

export function createClaudeCodeAdapter(userConfig?: ResolvedUserConfig): AgentAdapter {
  const modelId = userConfig?.agentModelId ? parseModelId(userConfig.agentModelId).modelId : undefined;

  return {
    id: 'claude-code' as AgentId,
    displayName: 'Claude Code',

    // eslint-disable-next-line @typescript-eslint/require-await -- interface requires Promise return
    async getImage(): Promise<string> {
      return CLAUDE_CODE_IMAGE;
    },

    // Generates MCP config file passed via --mcp-config on the command line.
    // socketPath is either a UDS path or a TCP host:port address.
    generateMcpConfig(socketPath: string): AgentConfigFile[] {
      const isTcp = socketPath.includes(':');
      const mcpConfig = {
        mcpServers: {
          ironcurtain: {
            command: 'socat',
            args: isTcp ? ['STDIO', `TCP:${socketPath}`] : ['STDIO', `UNIX-CONNECT:${socketPath}`],
          },
        },
      };

      return [
        {
          path: 'claude-mcp-config.json',
          content: JSON.stringify(mcpConfig, null, 2),
        },
      ];
    },

    generateOrientationFiles(): AgentConfigFile[] {
      // Wrapper script for PTY mode -- avoids shell quoting issues by reading
      // the system prompt from $IRONCURTAIN_SYSTEM_PROMPT (set by entrypoint).
      // Sets initial PTY size from host-provided env vars before exec, so the
      // PTY has the correct dimensions before Claude even starts.
      const startScript = `#!/bin/bash
# Set initial terminal size from host env vars
if [ -n "$IRONCURTAIN_INITIAL_COLS" ] && [ -n "$IRONCURTAIN_INITIAL_ROWS" ]; then
  stty cols "$IRONCURTAIN_INITIAL_COLS" rows "$IRONCURTAIN_INITIAL_ROWS" 2>/dev/null
fi
cd /workspace

MODEL_ARGS=()
if [ -n "$IRONCURTAIN_MODEL" ]; then
  MODEL_ARGS=(--model "$IRONCURTAIN_MODEL")
fi

# shellcheck disable=SC2086
if [ -n "$IRONCURTAIN_RESUME_FLAGS" ]; then
  # Try resume; if --continue fails (no conversation), fall back to fresh start
  claude --dangerously-skip-permissions --mcp-config /etc/ironcurtain/claude-mcp-config.json --append-system-prompt "$IRONCURTAIN_SYSTEM_PROMPT" "\${MODEL_ARGS[@]}" $IRONCURTAIN_RESUME_FLAGS
  STATUS=$?
  if [ $STATUS -ne 0 ]; then
    claude --dangerously-skip-permissions --mcp-config /etc/ironcurtain/claude-mcp-config.json --append-system-prompt "$IRONCURTAIN_SYSTEM_PROMPT" "\${MODEL_ARGS[@]}"
    STATUS=$?
  fi
else
  claude --dangerously-skip-permissions --mcp-config /etc/ironcurtain/claude-mcp-config.json --append-system-prompt "$IRONCURTAIN_SYSTEM_PROMPT" "\${MODEL_ARGS[@]}"
  STATUS=$?
fi

# Save .claude.json into the mounted state dir so it persists for resume.
# Contains conversation metadata that --continue needs to find the session.
cp "$HOME/.claude.json" "$HOME/.claude/.claude.json.saved" 2>/dev/null
exit $STATUS
`;

      // Helper scripts for PTY resize — use shared generators parameterized by process name.
      const resizeScript = buildResizePtyScript('claude');
      const checkSizeScript = buildCheckPtySizeScript('claude');

      return [
        { path: 'start-claude.sh', content: startScript, mode: 0o755 },
        { path: 'resize-pty.sh', content: resizeScript, mode: 0o755 },
        { path: 'check-pty-size.sh', content: checkSizeScript, mode: 0o755 },
      ];
    },

    buildCommand(
      message: string,
      systemPrompt: string,
      options: {
        readonly sessionId: string;
        readonly firstTurn: boolean;
        readonly modelOverride?: string;
      },
    ): readonly string[] {
      // `claude -p --continue` in non-interactive print mode does NOT update
      // ~/.claude.json's project->session mapping, so subsequent `--continue`
      // calls silently start new sessions. Instead, pin the session UUID on
      // the first turn with `--session-id`, then resume it explicitly with
      // `--resume <uuid>` on later turns.
      const cmd = [
        'claude',
        options.firstTurn ? '--session-id' : '--resume',
        options.sessionId,
        '--dangerously-skip-permissions',
        '--output-format',
        'json',
        '--mcp-config',
        '/etc/ironcurtain/claude-mcp-config.json',
        '--append-system-prompt',
        systemPrompt,
      ];
      const effectiveModelId = options.modelOverride ? parseModelId(options.modelOverride).modelId : modelId;
      if (effectiveModelId) {
        cmd.push('--model', effectiveModelId);
      }
      cmd.push('-p', message);
      return cmd;
    },

    buildSystemPrompt(context: OrientationContext): string {
      // Layer 1: Code Mode instructions (tool discovery, sync calls, return semantics)
      const codeModePrompt = buildSystemPrompt(context.serverListings, context.hostSandboxDir);

      // Layer 2: Docker environment specifics (workspace, host access, policy)
      const dockerPrompt = buildDockerEnvironmentPrompt(context);

      return `${codeModePrompt}\n${dockerPrompt}`;
    },

    getProviders(authKind?: 'oauth' | 'apikey'): readonly ProviderConfig[] {
      if (authKind === 'oauth') {
        return [anthropicOAuthProvider, claudePlatformOAuthProvider];
      }
      return [anthropicProvider, claudePlatformProvider];
    },

    buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Record<string, string> {
      const env: Record<string, string> = {
        CLAUDE_CODE_DISABLE_UPDATE_CHECK: '1',
        // Node.js does not use the system CA store -- must set this explicitly
        NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/ironcurtain-ca.crt',
      };

      if (modelId) {
        env.IRONCURTAIN_MODEL = modelId;
      }

      const fakeKey = fakeKeys.get('api.anthropic.com');
      if (!fakeKey) {
        throw new Error('No fake key generated for api.anthropic.com — cannot configure Claude Code authentication');
      }

      if (config.dockerAuth?.kind === 'oauth') {
        // OAuth mode: pass fake token via Claude Code's native env var.
        // Claude Code reads CLAUDE_CODE_OAUTH_TOKEN as its highest-priority auth.
        env.CLAUDE_CODE_OAUTH_TOKEN = fakeKey;
      } else {
        // API key mode: pass the fake key via a non-Claude env var; apiKeyHelper
        // in settings.json echoes it so Claude Code never prompts for approval.
        env.IRONCURTAIN_API_KEY = fakeKey;
      }

      return env;
    },

    extractResponse(exitCode: number, stdout: string): AgentResponse {
      if (exitCode !== 0) {
        // Before falling back to the generic "exited non-zero" wrapper,
        // look inside Claude Code's JSON envelope for a structured
        // quota-exhaustion signal. Claude Code exits non-zero on 429
        // but still prints its result envelope on stdout — we would
        // otherwise throw that signal away.
        const quotaExhausted = extractClaudeCodeQuotaSignal(stdout);
        if (quotaExhausted) {
          return { text: quotaExhausted.rawMessage, quotaExhausted };
        }
        // Zero output on non-zero exit indicates the claude process was
        // killed (SIGTERM) or crashed before producing any assistant text —
        // typically an upstream provider stall. The session id has been
        // consumed by the failed attempt, so the caller must rotate it
        // before retrying.
        const hardFailure = stdout.trim().length === 0;
        return { text: `Agent exited with code ${exitCode}.\n\nOutput:\n${stdout}`, hardFailure };
      }
      return parseClaudeCodeJson(stdout);
    },

    buildPtyCommand(
      _systemPrompt: string,
      ptySockPath: string | undefined,
      ptyPort: number | undefined,
    ): readonly string[] {
      // The socat listener target depends on platform
      const listenArg = ptySockPath
        ? `UNIX-LISTEN:${ptySockPath},fork` // Linux UDS
        : `TCP-LISTEN:${ptyPort},reuseaddr`; // macOS TCP

      // Interactive mode: claude runs via a wrapper script that reads the system
      // prompt from an env var set by the entrypoint. This avoids shell quoting
      // issues that occur when embedding large prompts in socat EXEC: strings.
      return ['socat', listenArg, 'EXEC:/etc/ironcurtain/start-claude.sh,pty,setsid,ctty,stderr,rawer'];
    },

    getConversationStateConfig(): ConversationStateConfig {
      return {
        hostDirName: 'claude-state',
        containerMountPath: '/home/codespace/.claude/',
        seed: [
          { path: 'projects/', content: '' }, // directory, populated by Claude Code
        ],
        resumeFlags: ['--continue'],
      };
    },
  };
}

/**
 * Matches the human-readable reset timestamp that litellm / Anthropic
 * surface in the 429 error `result` string, e.g.
 *   "Usage limit reached for 5 hour. Your limit will reset at 2026-04-22 18:27:36"
 * The timestamp has no timezone suffix in practice; we treat it as UTC.
 */
const QUOTA_RESET_REGEX = /Your limit will reset at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/;

/**
 * Extracts a quota-exhaustion signal from Claude Code's JSON error
 * envelope. Returns undefined when the envelope is missing, malformed,
 * or carries a different error class. When present, `rawMessage` is
 * always set (from the envelope's `result` string or a stringified
 * fallback) and `resetAt` is populated only when the human-readable
 * reset timestamp can be parsed.
 *
 * Contract: this helper populates `AgentResponse.quotaExhausted`,
 * which the workflow orchestrator treats as a terminal "pause and
 * resume later" signal — do not fold unrelated errors into this path.
 */
function extractClaudeCodeQuotaSignal(stdout: string): AgentResponse['quotaExhausted'] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.api_error_status !== 429) return undefined;

  const resultText = typeof obj.result === 'string' ? obj.result : undefined;
  const rawMessage = resultText ?? stdout.trim();
  const match = resultText ? QUOTA_RESET_REGEX.exec(resultText) : null;
  if (match) {
    const [, date, time] = match;
    const resetAt = new Date(`${date}T${time}Z`);
    if (!Number.isNaN(resetAt.getTime())) {
      return { resetAt, rawMessage };
    }
  }
  return { rawMessage };
}

/**
 * Detects the degenerate "upstream stall" envelope: exit=0, JSON parses,
 * `result` non-empty (typically the agent's preamble), but
 * `usage.output_tokens === 0` AND `stop_reason === null` (or undefined).
 * Matches the captured envelopes from a sustained LiteLLM/Z.AI outage
 * where the stream hung server-side and no assistant message was
 * generated.
 *
 * Predicate is strict (AND of both signals) so legitimate empty
 * completions — `stop_reason === 'end_turn'` with `output_tokens === 0`
 * — and partial streams — `output_tokens > 0` with `stop_reason === null`
 * — do NOT match. Reads defensively: if `usage` is absent or wrongly
 * typed (CLI version drift), returns undefined and lets the caller
 * treat the response as healthy. False positives here would route a
 * normal completion to the resumable-abort path, which is much worse
 * than a missed detection.
 */
function detectClaudeCodeTransientFailure(
  parsed: Record<string, unknown>,
  stdout: string,
): { rawMessage: string } | undefined {
  const usage = parsed.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const outputTokens = (usage as Record<string, unknown>).output_tokens;
  if (typeof outputTokens !== 'number' || outputTokens !== 0) return undefined;
  const stopReason = parsed.stop_reason;
  if (stopReason !== null && stopReason !== undefined) return undefined;
  return { rawMessage: stdout.trim() };
}

/**
 * Parses Claude Code's `--output-format json` response.
 * Falls back to raw stdout when the output is not valid JSON.
 */
function parseClaudeCodeJson(stdout: string): AgentResponse {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && 'result' in parsed) {
      const obj = parsed as Record<string, unknown>;
      const text = typeof obj.result === 'string' ? obj.result : stdout.trim();
      const transient = detectClaudeCodeTransientFailure(obj, stdout);
      const base: AgentResponse =
        typeof obj.total_cost_usd === 'number' ? { text, costUsd: obj.total_cost_usd } : { text };
      if (transient) {
        return { ...base, transientFailure: { kind: 'degenerate_response', rawMessage: transient.rawMessage } };
      }
      return base;
    }
  } catch {
    // JSON parse failed -- fall through to raw text
  }
  return { text: stdout.trim() };
}
