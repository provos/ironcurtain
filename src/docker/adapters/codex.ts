/**
 * Codex CLI adapter for Docker Agent Mode.
 *
 * Runs OpenAI Codex CLI non-interactively through the same container,
 * MCP proxy, and MITM fake-token path as other Docker agents. The adapter
 * uses Codex's ChatGPT OAuth/access-token flow, not OPENAI_API_KEY.
 */

import type {
  AgentAdapter,
  AgentConfigFile,
  AgentId,
  AgentResponse,
  ConversationStateConfig,
  OrientationContext,
} from '../agent-adapter.js';
import type { DockerAuthKind, IronCurtainConfig } from '../../config/types.js';
import type { ProviderConfig } from '../provider-config.js';
import type { AuthMethod } from '../oauth-credentials.js';
import type { ResolvedOpenRouterProfile, ResolvedUserConfig } from '../../config/user-config.js';
import { DEFAULT_GLM_SLUG, OPENROUTER_API_V1, OPENROUTER_HOST } from '../../config/user-config.js';
import { buildSystemPrompt } from '../../session/prompts.js';
import { codexAuthProvider, codexChatGptProvider } from '../provider-config.js';
import { makeOpenRouterProviderForProfile, openRouterCredential } from '../openrouter.js';
import { loadCodexOAuthCredentials } from '../oauth-credentials.js';
import { parseModelId } from '../../config/model-provider.js';
import {
  buildAttributionSection,
  buildCheckPtySizeScript,
  buildNetworkSection,
  buildPolicySection,
  buildResizePtyScript,
} from './shared-scripts.js';

const CODEX_IMAGE = 'ironcurtain-codex:latest';
const CODEX_FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  'eyJlbWFpbCI6Imlyb25jdXJ0YWluQGV4YW1wbGUuaW52YWxpZCIsImh0dHBzOi8vYXBpLm9wZW5haS5jb20vYXV0aCI6eyJjaGF0Z3B0X3BsYW5fdHlwZSI6InBybyIsImNoYXRncHRfdXNlcl9pZCI6Imlyb25jdXJ0YWluLXVzZXIiLCJjaGF0Z3B0X2FjY291bnRfaWQiOiJpcm9uY3VydGFpbi1hY2NvdW50IiwiY2hhdGdwdF9hY2NvdW50X2lzX2ZlZHJhbXAiOmZhbHNlfX0.' +
  'c2ln';

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildCodexDockerEnvironmentPrompt(context: OrientationContext): string {
  return `## Docker Environment

### Workspace (\`${context.workspaceDir}\`)
This is your workspace inside the container. You have full access here.
For local file operations inside ${context.workspaceDir}, use your built-in shell tools.

### External Operations (MCP tools)
Use the IronCurtain MCP server for operations that require external access:
- Network requests (HTTP fetches, web searches, API calls)
- Git remote operations (clone, push, pull, fetch)
- Reading files outside ${context.workspaceDir}

After cloning a repo or writing files via MCP tools, use your built-in
tools for subsequent file operations.

${buildNetworkSection('the IronCurtain MCP tools')}
${buildPolicySection('MCP tool call')}
${buildAttributionSection()}`;
}

function buildStartScript(): string {
  return `#!/bin/bash
if [ -n "$IRONCURTAIN_INITIAL_COLS" ] && [ -n "$IRONCURTAIN_INITIAL_ROWS" ]; then
  stty cols "$IRONCURTAIN_INITIAL_COLS" rows "$IRONCURTAIN_INITIAL_ROWS" 2>/dev/null
fi
cd /workspace

MODEL_ARGS=()
if [ -n "$IRONCURTAIN_MODEL" ]; then
  MODEL_ARGS=(--model "$IRONCURTAIN_MODEL")
fi

exec codex --ask-for-approval never --sandbox danger-full-access "\${MODEL_ARGS[@]}" --cd /workspace
`;
}

/**
 * Codex slug under an openrouter-type profile (D2). Codex has NO native model
 * field in IronCurtain config, so it must never passthrough an unmapped OpenAI
 * id — the `modelMap` does NOT participate. The slug is exactly
 * `perAgent.codex ?? DEFAULT_GLM_SLUG`.
 */
function codexSlugFor(profile: ResolvedOpenRouterProfile): string {
  return profile.perAgent.codex ?? DEFAULT_GLM_SLUG;
}

/**
 * Builds the Codex `config.toml` string. Under an openrouter-type profile the
 * two root keys (`model`, `model_provider`) are PREPENDED before the first
 * `[table]` (TOML is order-sensitive — root keys must precede any table header,
 * §4.6/B1), and the `[model_providers.openrouter]` table is APPENDED.
 */
function buildCodexToml(connectTarget: string, profile: ResolvedOpenRouterProfile | undefined): string {
  const rootKeys = ['cli_auth_credentials_store = "file"', 'project_doc_fallback_filenames = ["CLAUDE.md"]'];
  const openrouterRootKeys = profile
    ? [`model = ${tomlString(codexSlugFor(profile))}`, 'model_provider = "openrouter"']
    : [];
  const openrouterProviderTable = profile
    ? [
        '',
        '[model_providers.openrouter]',
        `base_url = ${tomlString(OPENROUTER_API_V1)}`,
        'env_key = "OPENROUTER_API_KEY"',
        'wire_api = "responses"',
      ]
    : [];

  return [
    ...openrouterRootKeys,
    ...rootKeys,
    '',
    '[projects."/workspace"]',
    'trust_level = "trusted"',
    ...openrouterProviderTable,
    '',
    '[mcp_servers.ironcurtain]',
    'command = "socat"',
    `args = ["STDIO", ${tomlString(connectTarget)}]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 600',
    'default_tools_approval_mode = "auto"',
    '',
  ].join('\n');
}

/**
 * @param userConfig - Resolved user config, accepted for factory-signature
 *   symmetry with the other adapters (m3). Codex reads no non-profile field
 *   from it today; the ACTIVE PROFILE is read from the per-session stamped
 *   `config.activeProviderProfile` at method-call time, never captured here
 *   (§9 F1 — a factory-captured profile would leak across the process-global
 *   registry's cached instance).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- userConfig kept for factory-signature symmetry (m3)
export function createCodexAdapter(userConfig?: ResolvedUserConfig): AgentAdapter {
  return {
    id: 'codex' as AgentId,
    displayName: 'Codex CLI',
    credentialHelpText:
      'No Codex OAuth credentials found. Run `codex login` on the host; OPENAI_API_KEY is not required.',

    // eslint-disable-next-line @typescript-eslint/require-await -- interface requires Promise return
    async getImage(): Promise<string> {
      return CODEX_IMAGE;
    },

    generateMcpConfig(socketPath: string, config: IronCurtainConfig): AgentConfigFile[] {
      const isTcp = socketPath.includes(':');
      const connectTarget = isTcp ? `TCP:${socketPath}` : `UNIX-CONNECT:${socketPath}`;

      const profile = config.activeProviderProfile;
      const openrouterProfile = profile?.type === 'openrouter' ? profile : undefined;
      const toml = buildCodexToml(connectTarget, openrouterProfile);

      return [{ path: 'codex-config.toml', content: toml }];
    },

    generateOrientationFiles(): AgentConfigFile[] {
      return [
        { path: 'start-codex.sh', content: buildStartScript(), mode: 0o755 },
        { path: 'resize-pty.sh', content: buildResizePtyScript('codex'), mode: 0o755 },
        { path: 'check-pty-size.sh', content: buildCheckPtySizeScript('codex'), mode: 0o755 },
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
      const prompt = `${systemPrompt}\n\n---\n\nUser request:\n${message}`;
      const cmd = ['codex', '--ask-for-approval', 'never', '--sandbox', 'danger-full-access'];
      if (options.modelOverride) {
        cmd.push('--model', parseModelId(options.modelOverride).modelId);
      }
      cmd.push('exec', '--json', '--skip-git-repo-check', '--cd', '/workspace', prompt);
      return cmd;
    },

    buildSystemPrompt(context: OrientationContext): string {
      const codeModePrompt = buildSystemPrompt(context.serverListings, context.hostSandboxDir);
      const dockerPrompt = buildCodexDockerEnvironmentPrompt(context);
      return `${codeModePrompt}\n${dockerPrompt}`;
    },

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- authKind kept for adapter interface symmetry
    getProviders(config: IronCurtainConfig, _authKind?: DockerAuthKind): readonly ProviderConfig[] {
      const profile = config.activeProviderProfile;
      if (profile?.type === 'openrouter') {
        // Codex speaks the Responses wire format; the bearer OpenRouter provider
        // replaces the ChatGPT OAuth providers entirely.
        return [makeOpenRouterProviderForProfile('responses', profile, 'codex')];
      }
      return [codexChatGptProvider, codexAuthProvider];
    },

    buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Record<string, string> {
      const profile = config.activeProviderProfile;
      if (profile?.type === 'openrouter') {
        // OpenRouter mode: Codex reads OPENROUTER_API_KEY (referenced by the
        // generated config.toml's env_key). Drop the Codex OAuth token env
        // entirely — the ChatGPT auth flow is not used here.
        const fakeKey = fakeKeys.get(OPENROUTER_HOST);
        if (!fakeKey) {
          throw new Error(
            `No fake key generated for ${OPENROUTER_HOST} — cannot configure Codex OpenRouter authentication`,
          );
        }
        return {
          CODEX_HOME: '/home/codespace/.codex',
          OPENROUTER_API_KEY: fakeKey,
          CODEX_CA_CERTIFICATE: '/usr/local/share/ca-certificates/ironcurtain-ca.crt',
          SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
          RUST_LOG: 'error',
        };
      }

      const fakeToken = fakeKeys.get('chatgpt.com');
      if (!fakeToken) {
        throw new Error('No fake token generated for chatgpt.com — cannot configure Codex authentication');
      }

      return {
        CODEX_HOME: '/home/codespace/.codex',
        IRONCURTAIN_CODEX_ACCESS_TOKEN: fakeToken,
        IRONCURTAIN_CODEX_ID_TOKEN: CODEX_FAKE_ID_TOKEN,
        IRONCURTAIN_CODEX_ACCOUNT_ID: 'ironcurtain-account',
        CODEX_CA_CERTIFICATE: '/usr/local/share/ca-certificates/ironcurtain-ca.crt',
        SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
        RUST_LOG: 'error',
      };
    },

    /**
     * NOTE on quota / transient-failure handling and the assumed Codex
     * envelope schema.
     *
     * Codex `exec --json` emits a JSONL event stream, one JSON object per
     * line. The happy path carries `item.completed` events whose `item.type`
     * is `agent_message` (the model's text). We CANNOT confirm Codex's exact
     * failure-event schema from the repo, so detection is intentionally
     * conservative and generic (see `scanCodexEvents`):
     *
     *   - A top-level event is treated as a failure when its `type` ends in
     *     `.failed` (e.g. `turn.failed`) or equals `error`, OR when its
     *     `item.type` is `error`. We pull a human-readable message from the
     *     event's / item's `error.message`, `message`, or `text` field.
     *   - From that failure message (plus the non-zero-exit stderr/stdout on
     *     the error path), `withFailureSignal` does narrow, string-based
     *     matching: a rate-limit / usage-limit / quota / HTTP-429 hit sets
     *     `quotaExhausted` (the orchestrator pauses-and-resumes instead of
     *     burning the run); anything else error-shaped sets a transient
     *     `degenerate_response` failure.
     *
     * Detection is deliberately narrow so it cannot misfire on normal
     * output: the happy-path return value below is byte-identical to the
     * previous implementation (last `agent_message`, else raw stdout). See
     * the Claude Code adapter (`adapters/claude-code.ts`) for the canonical
     * contract and `AgentResponse.quotaExhausted` / `transientFailure` in
     * `../agent-adapter.ts` for the interface requirement.
     */
    extractResponse(exitCode: number, stdout: string, stderr?: string): AgentResponse {
      const clean = stdout.trim();
      const scan = scanCodexEvents(clean);

      if (exitCode !== 0) {
        const errorOutput = [clean, stderr?.trim()].filter((part) => part && part.length > 0).join('\n\n');
        const baseText = `Codex exited with code ${exitCode}.\n\nOutput:\n${errorOutput}`;
        // Combine any in-band failure message with the raw error output so a
        // 429 surfaced either in-band OR only in stderr/stdout is detected.
        const probe = [scan.errorMessage, clean, stderr].filter((p) => p && p.length > 0).join('\n');
        return withFailureSignal({ text: baseText }, probe);
      }

      // Exit 0: prefer the model's final message. If none is present but the
      // stream carried a failure event, describe the failure (and attach the
      // structured signal) instead of dumping a raw JSONL line.
      if (scan.finalMessage) {
        return { text: scan.finalMessage };
      }
      if (scan.errorMessage) {
        return withFailureSignal({ text: `Codex reported an error:\n\n${scan.errorMessage}` }, scan.errorMessage);
      }
      return { text: clean };
    },

    buildPtyCommand(
      _systemPrompt: string,
      ptySockPath: string | undefined,
      ptyPort: number | undefined,
    ): readonly string[] {
      const listenArg = ptySockPath ? `UNIX-LISTEN:${ptySockPath},fork` : `TCP-LISTEN:${ptyPort},reuseaddr`;
      return ['socat', listenArg, 'EXEC:/etc/ironcurtain/start-codex.sh,pty,setsid,ctty,stderr,rawer'];
    },

    detectCredential(config: IronCurtainConfig): AuthMethod {
      // OpenRouter mode: credential presence is the profile's non-empty apiKey
      // (no `codex login` needed); empty ⇒ 'none' (feeds m5). Native ⇒ undefined,
      // so fall through to Codex ChatGPT OAuth detection.
      const openRouter = openRouterCredential(config);
      if (openRouter) return openRouter;
      const credentials = loadCodexOAuthCredentials();
      if (!credentials) return { kind: 'none' };
      return {
        kind: 'oauth',
        credentials: {
          accessToken: credentials.accessToken,
          refreshToken: credentials.refreshToken,
          expiresAt: credentials.expiresAt,
        },
        source: 'file',
      };
    },

    getConversationStateConfig(): ConversationStateConfig {
      return {
        hostDirName: 'codex-state',
        containerMountPath: '/home/codespace/.codex/',
        seed: [
          { path: 'sessions/', content: '' },
          { path: 'logs/', content: '' },
        ],
        resumeFlags: [],
      };
    },
  };
}

/**
 * Result of a single pass over the Codex JSONL event stream.
 *
 * `finalMessage` is the last `agent_message` text (the happy path).
 * `errorMessage` is the first failure/error message detected, if any.
 */
interface CodexScanResult {
  readonly finalMessage: string | null;
  readonly errorMessage: string | null;
}

/**
 * Single-pass scan over the Codex `exec --json` JSONL stream.
 *
 * Collects the last `agent_message` text and the first detected
 * failure/error message. Malformed/truncated lines are skipped (the JSONL
 * stream can be truncated when a process is killed), so a valid
 * `agent_message` on a later line is still recovered.
 */
function scanCodexEvents(stdout: string): CodexScanResult {
  if (stdout.length === 0) return { finalMessage: null, errorMessage: null };

  let lastAgentMessage: string | null = null;
  let errorMessage: string | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const event = parsed as Record<string, unknown>;

    const item = event.item && typeof event.item === 'object' ? (event.item as Record<string, unknown>) : undefined;

    if (item && item.type === 'agent_message' && typeof item.text === 'string') {
      lastAgentMessage = item.text;
    }

    if (errorMessage === null) {
      errorMessage = extractCodexErrorMessage(event, item);
    }
  }

  return { finalMessage: lastAgentMessage?.trim() || null, errorMessage };
}

/**
 * Recognizes a Codex failure/error envelope generically (the exact schema
 * is not confirmable from the repo): a top-level `type` ending in `.failed`
 * or equal to `error`, or an item whose `type` is `error`. Returns a
 * best-effort human-readable message, or null when the event is not a
 * failure shape.
 */
function extractCodexErrorMessage(
  event: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
): string | null {
  const eventType = typeof event.type === 'string' ? event.type : undefined;
  const isEventFailure = eventType !== undefined && (eventType.endsWith('.failed') || eventType === 'error');
  const isItemFailure = item !== undefined && item.type === 'error';
  if (!isEventFailure && !isItemFailure) return null;

  return pickErrorMessage(event) ?? (item ? pickErrorMessage(item) : undefined) ?? eventType ?? 'unknown Codex error';
}

/** Pulls a message string from an `error.message` / `message` / `text` field. */
function pickErrorMessage(obj: Record<string, unknown>): string | undefined {
  const nested = obj.error;
  if (nested && typeof nested === 'object') {
    const msg = (nested as Record<string, unknown>).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  if (typeof obj.message === 'string' && obj.message.length > 0) return obj.message;
  if (typeof obj.text === 'string' && obj.text.length > 0) return obj.text;
  return undefined;
}

/** Narrow, case-insensitive substring matches for upstream quota/rate-limit. */
const QUOTA_PROBE_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /rate.?limit/i,
  /usage.?limit/i,
  /\bquota\b/i,
  /too many requests/i,
];

/**
 * Best-effort classification of a Codex error string into a structured
 * signal. Quota / rate-limit / 429 hits map to `quotaExhausted`; any other
 * non-empty error string maps to a transient `degenerate_response`.
 * Returns the response unchanged when `probe` is empty.
 *
 * Detection is intentionally string-based and narrow so it cannot misfire
 * on normal model output (only reached when a failure event was detected or
 * the process exited non-zero).
 */
function withFailureSignal(response: AgentResponse, probe: string): AgentResponse {
  const trimmed = probe.trim();
  if (trimmed.length === 0) return response;

  if (QUOTA_PROBE_PATTERNS.some((re) => re.test(trimmed))) {
    return { ...response, quotaExhausted: { rawMessage: trimmed } };
  }
  return { ...response, transientFailure: { kind: 'degenerate_response', rawMessage: trimmed } };
}
