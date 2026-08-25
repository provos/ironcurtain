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
  TransientFailureKind,
} from '../agent-adapter.js';
import type { DockerAuthKind, IronCurtainConfig } from '../../config/types.js';
import type { ProviderConfig } from '../provider-config.js';
import type { AuthMethod } from '../oauth-credentials.js';
import type { ResolvedUserConfig } from '../../config/user-config.js';
import { OPENROUTER_BASE_URL, OPENROUTER_HOST } from '../../config/user-config.js';
import { parseModelId } from '../../config/model-provider.js';
import { makeOpenRouterProviderForProfile, openRouterCredential, resolveMappedModel } from '../openrouter.js';
import { CONTAINER_RUNTIME_CA_CERT } from '../runtime-trust.js';
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
  buildWorkspaceAccessSection,
  buildNestedDockerSection,
  buildPolicySection,
  buildAttributionSection,
} from './shared-scripts.js';

const CLAUDE_CODE_IMAGE = 'ironcurtain-claude-code:latest';

/**
 * Claude Code streaming-watchdog tuning vars forwarded from the host env into
 * all Claude containers when set (see `buildEnv`). Curated allowlist — these govern
 * the idle-stream abort ("Response stalled mid-stream", issue #367) and let it
 * be exercised against the MITM stream-delay knob without rebuilding the image.
 */
const WATCHDOG_ENV_PASSTHROUGH = [
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  'CLAUDE_ENABLE_STREAM_WATCHDOG',
  'CLAUDE_ENABLE_BYTE_WATCHDOG',
  'API_FORCE_IDLE_TIMEOUT',
  'API_TIMEOUT_MS',
] as const;

/**
 * Container path used as the parent for Claude Code's skill discovery.
 * Claude Code's `--add-dir <path>` flag scans `<path>/.claude/skills/`,
 * so the bind-mount target is the deeper `.claude/skills/` subpath
 * while the CLI is pointed at this parent.
 *
 * Picked deliberately to NOT nest under any other mount target — in
 * particular, the conversation-state mount lives at
 * `/home/codespace/.claude/`, so we cannot stage skills under that
 * tree (nested bind mounts are unreliable across platforms; see
 * `agent-adapter.ts` for context).
 */
const CLAUDE_SKILLS_PARENT = '/home/codespace/skills';
const CLAUDE_SKILLS_MOUNT_TARGET = `${CLAUDE_SKILLS_PARENT}/.claude/skills`;

function buildDockerEnvironmentPrompt(context: OrientationContext): string {
  return `## Docker Environment

${buildWorkspaceAccessSection(context, 'built-in tools (Bash, Read, Write, Edit, Glob, Grep)', '`execute_code`')}

${buildNestedDockerSection(context)}

Built-in WebSearch and WebFetch are disabled. Use these through \`execute_code\`:
  \`const results = fetch.web_search({ query: "search terms" });\`
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
    skills: {
      containerPath: CLAUDE_SKILLS_MOUNT_TARGET,
      batchArgs: ['--add-dir', CLAUDE_SKILLS_PARENT],
      ptyEnv: { IRONCURTAIN_SKILLS_DIR: CLAUDE_SKILLS_PARENT },
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- interface requires Promise return
    async getImage(): Promise<string> {
      return CLAUDE_CODE_IMAGE;
    },

    // Claude Code is installed unpinned in the image; log the resolved version
    // at infra prep so a silent minor bump (which can change subagent semantics
    // — issue #367) is visible.
    versionProbe: ['claude', '--version'],

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
      //
      // $IRONCURTAIN_SKILLS_DIR (optional): when set, appended as
      // `--add-dir <dir>` so Claude Code's native skill discovery picks
      // up `<dir>/.claude/skills/<name>/SKILL.md`. Empty/unset = no extra
      // flags (keeps `--add-dir <missing-path>` from erroring on sessions
      // without a skills mount). Mirrors the batch-mode wiring exposed
      // via `skills.batchArgs`; the PTY driver merges `skills.ptyEnv`
      // into the container environment, which is how this var arrives here.
      const startScript = `#!/bin/bash
# Runtime-native PTY exec does not inherit variables exported by PID 1.
# Read the mounted prompt here as well as in the image entrypoint.
if [ -f /etc/ironcurtain/system-prompt.txt ]; then
  export IRONCURTAIN_SYSTEM_PROMPT
  IRONCURTAIN_SYSTEM_PROMPT=$(cat /etc/ironcurtain/system-prompt.txt)
fi

# Set initial terminal size from host env vars
if [ -n "$IRONCURTAIN_INITIAL_COLS" ] && [ -n "$IRONCURTAIN_INITIAL_ROWS" ]; then
  stty cols "$IRONCURTAIN_INITIAL_COLS" rows "$IRONCURTAIN_INITIAL_ROWS" 2>/dev/null
fi
cd /workspace

MODEL_ARGS=()
if [ -n "$IRONCURTAIN_MODEL" ]; then
  MODEL_ARGS=(--model "$IRONCURTAIN_MODEL")
fi

SKILLS_ARGS=()
if [ -n "$IRONCURTAIN_SKILLS_DIR" ]; then
  SKILLS_ARGS=(--add-dir "$IRONCURTAIN_SKILLS_DIR")
fi

# shellcheck disable=SC2086
if [ -n "$IRONCURTAIN_RESUME_FLAGS" ]; then
  # Try resume; if --continue fails (no conversation), fall back to fresh start
  claude --dangerously-skip-permissions --mcp-config /etc/ironcurtain/claude-mcp-config.json --append-system-prompt "$IRONCURTAIN_SYSTEM_PROMPT" "\${MODEL_ARGS[@]}" "\${SKILLS_ARGS[@]}" $IRONCURTAIN_RESUME_FLAGS
  STATUS=$?
  if [ $STATUS -ne 0 ]; then
    claude --dangerously-skip-permissions --mcp-config /etc/ironcurtain/claude-mcp-config.json --append-system-prompt "$IRONCURTAIN_SYSTEM_PROMPT" "\${MODEL_ARGS[@]}" "\${SKILLS_ARGS[@]}"
    STATUS=$?
  fi
else
  claude --dangerously-skip-permissions --mcp-config /etc/ironcurtain/claude-mcp-config.json --append-system-prompt "$IRONCURTAIN_SYSTEM_PROMPT" "\${MODEL_ARGS[@]}" "\${SKILLS_ARGS[@]}"
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
      const codeModePrompt = buildSystemPrompt(context.serverListings);

      // Layer 2: Docker environment specifics (workspace, host access, policy)
      const dockerPrompt = buildDockerEnvironmentPrompt(context);

      return `${codeModePrompt}\n${dockerPrompt}`;
    },

    getProviders(config: IronCurtainConfig, authKind?: DockerAuthKind): readonly ProviderConfig[] {
      const profile = config.activeProviderProfile;
      if (profile?.type === 'openrouter') {
        // OpenRouter routing: the single bearer-auth provider replaces both
        // the Anthropic API and telemetry providers (and the OAuth pair). No
        // api.anthropic.com host is allowlisted (decision B); Claude Code's
        // telemetry calls are simply blocked at CONNECT.
        return [makeOpenRouterProviderForProfile('messages', profile, 'claude-code')];
      }
      if (authKind === 'oauth') {
        return [anthropicOAuthProvider, claudePlatformOAuthProvider];
      }
      return [anthropicProvider, claudePlatformProvider];
    },

    detectCredential(config: IronCurtainConfig): AuthMethod | undefined {
      // B2a/B2b: an OpenRouter-only user has no Anthropic OAuth/API key, so the
      // generic detectAuthMethod() would throw. openRouterCredential reports an
      // api-key AuthMethod for a keyed OpenRouter profile (authKind ⇒ 'apikey'),
      // { kind: 'none' } for an empty-key profile (feeds m5), and `undefined`
      // for a native profile — DEFERRING to detectAuthMethod() and preserving
      // today's OAuth+API-key detection byte-for-byte.
      return openRouterCredential(config);
    },

    buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Record<string, string> {
      const env: Record<string, string> = {
        CLAUDE_CODE_DISABLE_UPDATE_CHECK: '1',
        // Node.js does not use the system CA store -- must set this explicitly
        NODE_EXTRA_CA_CERTS: CONTAINER_RUNTIME_CA_CERT,
      };

      if (modelId) {
        env.IRONCURTAIN_MODEL = modelId;
      }

      // DEBUG / operability (issue #367 watchdog harness): forward a curated
      // allowlist of Claude Code streaming-watchdog tuning vars from the host
      // env into every Claude container when explicitly set. One-shot mode
      // still forces its required stream-watchdog default in buildBatchEnv,
      // while PTY users retain an escape hatch for long interactive turns.
      for (const key of WATCHDOG_ENV_PASSTHROUGH) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }

      const profile = config.activeProviderProfile;
      if (profile?.type === 'openrouter') {
        // B2c: OpenRouter mode auth-var exclusivity. Claude Code sends its
        // credential as `Authorization: Bearer` ONLY when it comes from
        // ANTHROPIC_AUTH_TOKEN (not ANTHROPIC_API_KEY, which is sent as
        // x-api-key). We therefore inject the sentinel via ANTHROPIC_AUTH_TOKEN
        // and set NEITHER CLAUDE_CODE_OAUTH_TOKEN NOR IRONCURTAIN_API_KEY — even
        // when host OAuth creds exist (OpenRouter overrides OAuth detection).
        const fakeKey = fakeKeys.get(OPENROUTER_HOST);
        if (!fakeKey) {
          throw new Error(
            `No fake key generated for ${OPENROUTER_HOST} — cannot configure Claude Code OpenRouter authentication`,
          );
        }
        env.ANTHROPIC_BASE_URL = OPENROUTER_BASE_URL;
        env.ANTHROPIC_AUTH_TOKEN = fakeKey;
        // Suppress Anthropic-only pre-release beta fields (e.g. context_management)
        // that non-Anthropic upstreams reject (§4.3 belt; the MITM strips too).
        env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
        // m2: per-tier model hints for the agent's own context budgeting /
        // [1m] handling. The MITM does the authoritative remap; these are hints
        // only. Each resolves as perAgent['claude-code'] ?? glob-map(probe) ??
        // omit (the DEFAULT_MODEL_MAP *sonnet*/*opus*/*haiku* globs match these
        // probe strings).
        const perAgent = profile.perAgent['claude-code'];
        const sonnet = perAgent ?? resolveMappedModel('claude-sonnet', profile.modelMap);
        const opus = perAgent ?? resolveMappedModel('claude-opus', profile.modelMap);
        const haiku = perAgent ?? resolveMappedModel('claude-haiku', profile.modelMap);
        if (sonnet !== undefined) env.ANTHROPIC_DEFAULT_SONNET_MODEL = sonnet;
        if (opus !== undefined) env.ANTHROPIC_DEFAULT_OPUS_MODEL = opus;
        if (haiku !== undefined) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
        return env;
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

    buildBatchEnv(): Record<string, string> {
      return {
        // Force subagents (Agent/Task tool) and `run_in_background` to run in the
        // FOREGROUND (synchronously), disabling auto-backgrounding. As of Claude
        // Code v2.1.198 subagents run in the *background* by default: the tool
        // returns immediately and the parent is "notified automatically when it
        // completes" via a persistent supervisor that re-fires the session. We
        // invoke `claude -p` as a one-shot subprocess with no such supervisor, so
        // when a workflow agent (e.g. vuln-discovery `analyze`) fans out to
        // parallel subagents, the turn never receives their completions and stalls
        // ("Response stalled mid-stream" / no `agent_status` block). This env var
        // restores the pre-2.1.198 synchronous behavior, which the FSM's
        // one-turn=one-result model requires. See docs/en/env-vars.
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
        // Disable the streaming idle watchdog (on by default since Claude
        // Code v2.1.196). Behind the MITM proxy, long tool-use turns and
        // SSE re-buffering trip the watchdog's idle threshold, which
        // aborts the request with "API Error: Response stalled
        // mid-stream" — the actual root cause of issue #367 (PR #372's
        // background-task fix alone did not resolve it). Turning the
        // watchdog off restores the pre-2.1.196 behavior; the workflow
        // orchestrator already enforces its own wall-clock/step budgets.
        CLAUDE_ENABLE_STREAM_WATCHDOG: '0',
        // Disable the BYTE-stream idle watchdog for batch/workflow
        // containers. This is separate from CLAUDE_ENABLE_STREAM_WATCHDOG
        // above: turning that one off leaves the byte watchdog in charge of
        // the idle deadline, and the byte deadline is HARD-CLAMPED to 30
        // minutes inside the CLI (floor 10s, ceiling 1_800_000ms; the
        // default is 180_000ms — 3 min — whenever the base URL resolves to
        // api.anthropic.com, which is exactly what the MITM presents).
        //
        // A self-hosted gateway (e.g. a DGX-backed vLLM lane) can legitimately
        // take longer than 30 minutes to produce a single response, and some
        // requests arrive NON-streaming, where no bytes at all reach the client
        // until generation completes. For those, no idle value below the full
        // generation time can ever pass — the ceiling is unreachable by
        // construction. Turning the watchdog off is the only setting that
        // tolerates them; the orchestrator's per-turn wall-clock budget
        // (`resourceBudget.maxSessionSeconds`, applied as the docker-exec
        // timeout) remains the backstop against a genuinely wedged upstream.
        CLAUDE_ENABLE_BYTE_WATCHDOG: '0',
        // Kept at the ceiling so that if the watchdog is ever re-enabled
        // (host env / future default flip), the deadline is as generous as
        // the CLI permits rather than the 3-minute first-party default.
        CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: '1800000',
      };
    },

    extractResponse(exitCode: number, stdout: string): AgentResponse {
      if (exitCode !== 0) {
        // The CLI exits non-zero on 429 (quota), on transient upstream
        // 5xx (`api_error_status: 5xx`, after the SDK exhausts its
        // internal retries), and on the upstream-stall envelope
        // (`type: 'result'`, `output_tokens=0`, `stop_reason=null`); all
        // three signals must survive the non-zero exit. Parse stdout once
        // and dispatch to each detector.
        const parsed = tryParseJsonObject(stdout);
        const quotaExhausted = parsed ? extractClaudeCodeQuotaSignal(parsed, stdout) : undefined;
        if (quotaExhausted) {
          return { text: quotaExhausted.rawMessage, quotaExhausted };
        }
        // Both transient-failure branches are resumable-aborts (NOT
        // hardFailure): the orchestrator's hard-retry rotation cannot
        // recover an upstream that's currently 5xx-ing or stalled — the
        // SDK already exhausted its internal retries within the failed
        // turn. Surface the synthetic `result` string as the agent's
        // text so the message log records what happened.
        const transientText = typeof parsed?.result === 'string' ? parsed.result : stdout.trim();
        const asTransientFailure = (kind: TransientFailureKind, rawMessage: string): AgentResponse => ({
          text: transientText,
          transientFailure: { kind, rawMessage },
        });
        const upstream5xx = parsed ? detectUpstreamFiveXx(parsed, stdout) : undefined;
        if (upstream5xx) {
          return asTransientFailure('upstream_5xx', upstream5xx.rawMessage);
        }
        const transient = parsed ? detectTransientFailure(parsed, stdout) : undefined;
        if (transient) {
          return asTransientFailure('degenerate_response', transient.rawMessage);
        }
        const apiError = parsed ? detectTerminalApiError(parsed, stdout) : undefined;
        if (apiError) {
          return asTransientFailure('upstream_api_error', apiError.rawMessage);
        }
        // Zero output on non-zero exit indicates the claude process was
        // killed (SIGTERM) or crashed before producing any assistant text —
        // typically an upstream provider stall. The session id has been
        // consumed by the failed attempt, so the caller must rotate it
        // before retrying.
        const hardFailure = stdout.trim().length === 0;
        return { text: `Agent exited with code ${exitCode}.\n\nOutput:\n${stdout}`, hardFailure };
      }
      if (stdout.trim().length === 0) {
        return {
          text:
            'Claude Code exited without producing output. Check the session log for startup failures ' +
            '(for example, exhausted Docker storage).',
          hardFailure: true,
        };
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

    buildPtyExecCommand(): readonly string[] {
      return ['/etc/ironcurtain/start-claude.sh'];
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

/** JSON.parse with defensive narrowing to a Record. Returns undefined on parse error or non-object. */
function tryParseJsonObject(stdout: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * Extracts a quota-exhaustion signal from a parsed Claude Code envelope.
 * Returns undefined when the envelope carries a different error class.
 * `resetAt` is populated only when the human-readable reset timestamp
 * can be parsed.
 *
 * Contract: this helper populates `AgentResponse.quotaExhausted`, which
 * the workflow orchestrator treats as a terminal "pause and resume
 * later" signal — do not fold unrelated errors into this path.
 */
function extractClaudeCodeQuotaSignal(
  parsed: Record<string, unknown>,
  stdout: string,
): AgentResponse['quotaExhausted'] | undefined {
  if (parsed.api_error_status !== 429) return undefined;

  const resultText = typeof parsed.result === 'string' ? parsed.result : undefined;
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
 * Detects the degenerate "upstream stall" envelope: a Claude Code result
 * envelope where `usage.output_tokens === 0` AND `stop_reason === null/undefined`.
 *
 * False positives here are much worse than missed detections — they would
 * route a healthy completion to the resumable-abort path. Hence the
 * `type === 'result'` + `typeof result === 'string'` envelope gates (a
 * real Claude Code result envelope always carries both), the strict AND
 * on the two stall signals (so legitimate empty completions with
 * `stop_reason === 'end_turn'` and partial streams with
 * `output_tokens > 0` do not match), and the defensive `usage`
 * narrowing (CLI version drift / schema change yields undefined).
 */
function detectTransientFailure(parsed: Record<string, unknown>, stdout: string): { rawMessage: string } | undefined {
  if (parsed.type !== 'result') return undefined;
  if (typeof parsed.result !== 'string') return undefined;
  const usage = parsed.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const outputTokens = (usage as Record<string, unknown>).output_tokens;
  if (typeof outputTokens !== 'number' || outputTokens !== 0) return undefined;
  const stopReason = parsed.stop_reason;
  if (stopReason !== null && stopReason !== undefined) return undefined;
  return { rawMessage: stdout.trim() };
}

/**
 * Detects the synthetic "upstream 5xx" envelope: Claude Code's SDK
 * retries transient provider 5xx responses three times internally; if
 * all three fail (e.g. a sustained Anthropic outage with mid-SSE-stream
 * aborts), the CLI emits a `type: 'result'` envelope with
 * `api_error_status` in the 5xx range and exits non-zero.
 *
 * Mirrors the defensive intent of `detectTransientFailure`: false
 * positives would silently swallow real errors, so the predicate is
 * strict. Restricted to 5xx so that 4xx envelopes (400 poisoned-
 * history, 401, 403) the SDK does NOT retry are NOT misclassified —
 * those are real errors the agent should see unmodified.
 */
function detectUpstreamFiveXx(parsed: Record<string, unknown>, stdout: string): { rawMessage: string } | undefined {
  if (parsed.type !== 'result') return undefined;
  if (parsed.is_error !== true) return undefined;
  const status = parsed.api_error_status;
  if (typeof status !== 'number') return undefined;
  if (status < 500 || status >= 600) return undefined;
  return { rawMessage: stdout.trim() };
}

/**
 * Detects the terminal API-error envelope: Claude Code's API layer gave up on
 * the turn after exhausting its internal retries, and the CLI finalized
 * whatever partial content it had.
 *
 * Recognizable ONLY by `terminal_reason === 'api_error'`. This covers more
 * than one underlying cause — the byte-stream idle watchdog firing ("the
 * response stopped arriving") and a failed connection ("Connection refused")
 * both produce it, with an identical envelope shape — so the kind is named
 * for the signal, not for a mechanism it cannot actually distinguish.
 *
 * The sibling detectors cannot see this envelope:
 *   - `detectUpstreamFiveXx` requires a numeric `api_error_status`; this
 *     envelope carries `null` (there is no HTTP status — no response ever
 *     completed).
 *   - `detectTransientFailure` requires `output_tokens === 0` and a null
 *     `stop_reason`; an abort that interrupts a partially-yielded response
 *     reports the tokens already emitted, and the CLI *synthesizes* a
 *     `stop_reason` (observed: `"stop_sequence"`) for the partial message.
 *
 * Without this branch the envelope falls through to the generic
 * `Agent exited with code N` text, and the orchestrator mistakes a dead turn
 * for one that merely forgot its `agent_status` block — burning its single
 * reprompt on a conversation the CLI can no longer continue.
 *
 * `terminal_reason` is a closed enum in practice (`completed` | `api_error`
 * across every captured run), so gating on it has no false-positive surface
 * beyond the `is_error === true` guard that already precedes it.
 */
function detectTerminalApiError(parsed: Record<string, unknown>, stdout: string): { rawMessage: string } | undefined {
  if (parsed.type !== 'result') return undefined;
  if (parsed.is_error !== true) return undefined;
  if (parsed.terminal_reason !== 'api_error') return undefined;
  return { rawMessage: stdout.trim() };
}

/**
 * Parses Claude Code's `--output-format json` response.
 * Falls back to raw stdout when the output is not valid JSON.
 */
function parseClaudeCodeJson(stdout: string): AgentResponse {
  const parsed = tryParseJsonObject(stdout);
  if (parsed && 'result' in parsed) {
    const text = typeof parsed.result === 'string' ? parsed.result : stdout.trim();
    const base: AgentResponse =
      typeof parsed.total_cost_usd === 'number' ? { text, costUsd: parsed.total_cost_usd } : { text };
    // Quota and 5xx envelopes both arrive with exit ≠ 0 by design, so
    // they're handled in the non-zero-exit branch of extractResponse.
    // Only the degenerate-response shape (exit = 0 but empty completion)
    // is reachable here.
    const transient = detectTransientFailure(parsed, stdout);
    if (transient) {
      return { ...base, transientFailure: { kind: 'degenerate_response', rawMessage: transient.rawMessage } };
    }
    return base;
  }
  return { text: stdout.trim() };
}
