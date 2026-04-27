/**
 * Agent adapter interface and supporting types.
 *
 * Each supported external agent (Claude Code, Goose, etc.) has an adapter
 * that handles its specific configuration needs: Docker image, MCP client
 * config format, system prompt injection, and output parsing.
 */

import type { IronCurtainConfig } from '../config/types.js';
import type { ProviderConfig } from './provider-config.js';
import type { ServerListing } from '../session/prompts.js';
import type { AuthMethod } from './oauth-credentials.js';

/**
 * The workspace directory inside Docker containers. The host sandbox
 * directory is bind-mounted at this path. Used for path rewriting
 * between container and host in both directions.
 */
export const CONTAINER_WORKSPACE_DIR = '/workspace';

/**
 * Structured response from an agent adapter, carrying both the
 * text response and optional cost/usage metadata reported by the agent.
 */
export interface AgentResponse {
  /** The agent's text response. */
  readonly text: string;
  /** Cumulative session cost in USD, if reported by the agent. */
  readonly costUsd?: number;
  /**
   * Set when the agent process was killed or crashed before producing
   * any output (e.g., upstream provider closed the stream mid-generation).
   * Signals to callers that a retry with a fresh conversation id is
   * appropriate; a reprompt against the same id will fail because the
   * agent CLI considers the id consumed.
   */
  readonly hardFailure?: boolean;
  /**
   * Set when the adapter detected that the agent aborted because of
   * upstream quota exhaustion — the kind the agent CLI's own retry loop
   * cannot recover from within a reasonable window (e.g. a multi-hour
   * provider usage-limit reset, surfaced by Claude Code as an
   * `api_error_status: 429` JSON envelope with a human-readable
   * "limit will reset at ..." message).
   *
   * Adapters MUST populate this whenever their CLI surfaces such a
   * signal. The orchestrator will neither retry nor spend further
   * budget on a turn that sets it — it throws a dedicated error class
   * so the workflow can be paused and resumed once the quota window
   * opens instead of aborting. Leaving this undefined causes the
   * orchestrator to fall through to the generic abort path — acceptable
   * only when the adapter's CLI has no machine-readable quota signal.
   *
   * `rawMessage` is the original provider/CLI text, preserved for
   * diagnostics and CLI output. `resetAt` is optional because not every
   * provider emits a parseable timestamp; when absent the caller picks
   * a conservative default pause.
   */
  readonly quotaExhausted?: {
    readonly resetAt?: Date;
    readonly rawMessage: string;
  };
  /**
   * Set when the adapter detected a transient upstream failure that
   * produced a syntactically-valid envelope with no usable content —
   * for instance, a sustained LiteLLM/Z.AI stall surfaced by Claude Code
   * as `usage.output_tokens === 0` AND `stop_reason === null` while
   * `result` contains only the agent's preamble. The CLI exits 0 and
   * its JSON parses, but no assistant message was generated.
   *
   * Shaped as a discriminated union (`kind`) so future detected shapes
   * (`'connection_reset'`, `'5xx_passthrough'`, etc.) can extend without
   * a breaking change. Mirrors the contract of `quotaExhausted`: the
   * orchestrator MUST treat this as terminal-but-resumable, MUST NOT
   * retry the turn (the in-loop reprompt against a stalled upstream is
   * hopeless), and MUST preserve the checkpoint so `workflow resume`
   * can re-enter the failing state once the upstream is healthy.
   *
   * `rawMessage` is the original envelope/stdout, preserved for
   * diagnostics. Adapters that cannot produce this signal must leave
   * the field undefined; falling through to the generic abort path is
   * acceptable when the CLI offers no machine-readable transient
   * signal.
   */
  readonly transientFailure?: {
    readonly kind: 'degenerate_response';
    readonly rawMessage: string;
  };
}

/**
 * Branded agent identifier to prevent mixing with other string types.
 */
export type AgentId = string & { readonly __brand: 'AgentId' };

/**
 * Configuration for persisting an agent's conversation state across
 * container restarts, enabling session resume.
 *
 * Each adapter that supports resume returns this from
 * `getConversationStateConfig()`. The generic infrastructure uses it
 * to create/mount a host-side state directory and to append resume
 * flags on subsequent runs.
 */
export interface ConversationStateConfig {
  /** Host-side subdirectory name within sessionDir (e.g., 'claude-state'). */
  readonly hostDirName: string;

  /** Container-side mount target (e.g., '/root/.claude/'). */
  readonly containerMountPath: string;

  /**
   * Files/directories to pre-populate on first session start.
   * Paths are relative to the host-side directory.
   *
   * When `content` is a string, a file is created with that content.
   * An empty string creates a directory instead.
   * When `content` is a function, it is called to produce the content;
   * returning `undefined` skips creation of that entry.
   */
  readonly seed: ReadonlyArray<{
    readonly path: string;
    readonly content: string | (() => string | undefined);
  }>;

  /**
   * CLI flag(s) the agent uses to continue a previous conversation.
   * Appended to the PTY command on resume (e.g., ['--continue']).
   * If empty, the agent handles resume via presence of state files alone.
   */
  readonly resumeFlags: readonly string[];
}

/**
 * A file to write into the container's orientation or config directory.
 */
export interface AgentConfigFile {
  /** Path relative to the orientation directory (or absolute in the container). */
  readonly path: string;
  /** File content. */
  readonly content: string;
  /** Optional file mode (e.g. 0o755 for executable scripts). */
  readonly mode?: number;
}

/**
 * Context passed to the adapter for generating orientation content.
 */
export interface OrientationContext {
  /** The sandbox directory path inside the container. */
  readonly workspaceDir: string;
  /** The host-side path that is bind-mounted as workspaceDir. */
  readonly hostSandboxDir: string;
  /** Server listings for progressive tool disclosure. */
  readonly serverListings: ServerListing[];
  /** Domains the agent may access via fetch MCP tool. */
  readonly allowedDomains: string[];
  /** Container network mode: 'none' (Linux UDS) or 'bridge' (macOS TCP). */
  readonly networkMode: 'none' | 'bridge';
}

/**
 * An agent adapter encapsulates the differences between external agents.
 *
 * Each adapter knows:
 * - What Docker image to use
 * - How to configure MCP server discovery for the agent
 * - How to construct the docker exec command
 * - How to collect the agent's response
 */
export interface AgentAdapter {
  /** Unique identifier for this agent type. */
  readonly id: AgentId;

  /** Human-readable name for display. */
  readonly displayName: string;

  /**
   * Returns the Docker image to use for this agent.
   * May trigger a build if the image doesn't exist yet.
   */
  getImage(): Promise<string>;

  /**
   * Generates the MCP client configuration file that tells
   * the agent how to connect to IronCurtain's proxy.
   *
   * @param socketPath - container-side UDS path (e.g., /run/ironcurtain/proxy.sock)
   */
  generateMcpConfig(socketPath: string): AgentConfigFile[];

  /**
   * Generates orientation documents that teach the agent about
   * the MCP-mediated environment.
   */
  generateOrientationFiles(context: OrientationContext): AgentConfigFile[];

  /**
   * Constructs the docker exec command for a turn.
   *
   * @param message - the user's message for this turn
   * @param systemPrompt - the orientation prompt
   * @param options - per-turn options:
   *   - sessionId: stable identifier for the conversation (e.g., for
   *     `claude --session-id <uuid>` / `--resume <uuid>`). Typically
   *     the session's UUID.
   *   - firstTurn: true when this is the first turn of a fresh
   *     conversation state; false when resuming an existing
   *     conversation. Adapters that don't distinguish may ignore.
   *   - modelOverride: qualified model ID ("provider:model-name") to use
   *     for this turn instead of the adapter's captured default. Adapters
   *     that cannot switch models per-turn (e.g., Goose reads `GOOSE_MODEL`
   *     at container start) must document their limitation.
   */
  buildCommand(
    message: string,
    systemPrompt: string,
    options: {
      readonly sessionId: string;
      readonly firstTurn: boolean;
      readonly modelOverride?: string;
    },
  ): readonly string[];

  /**
   * Builds the system prompt to append to the agent's default system prompt.
   */
  buildSystemPrompt(context: OrientationContext): string;

  /**
   * Returns LLM provider configurations for this agent.
   * The MITM proxy uses these to build the host allowlist,
   * generate fake API keys, swap keys in requests, and filter endpoints.
   *
   * @param authKind - When 'oauth', returns providers configured for bearer
   *   token injection instead of header-based API key injection.
   */
  getProviders(authKind?: 'oauth' | 'apikey'): readonly ProviderConfig[];

  /**
   * Constructs environment variables for the container.
   * Receives fake keys instead of real keys -- the real keys never
   * enter the container.
   *
   * @param fakeKeys - map of provider host -> fake sentinel key
   */
  buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Readonly<Record<string, string>>;

  /**
   * Parses the agent's output to extract the response and optional cost.
   *
   * IMPORTANT: adapters are the sole place where CLI-specific error
   * envelopes are translated into structured signals for the workflow
   * engine. In particular, when the underlying CLI exposes a
   * quota-exhaustion / rate-limit-exceeded signal (e.g. Claude Code's
   * `api_error_status: 429` JSON envelope), the adapter MUST surface
   * it via `AgentResponse.quotaExhausted`. See the Claude Code adapter
   * (`adapters/claude-code.ts`) for the canonical implementation.
   * Failing to surface this signal causes the orchestrator to treat
   * quota exhaustion as a generic abort, wasting the workflow run.
   *
   * @param exitCode - the container's exit code
   * @param stdout - captured stdout from the container
   */
  extractResponse(exitCode: number, stdout: string): AgentResponse;

  /**
   * Returns the Docker container command for PTY mode.
   * When provided, the container runs this command directly instead of
   * `sleep infinity`, and the host attaches via a PTY proxy.
   *
   * Adapters that do not implement this method do not support PTY mode.
   *
   * @param systemPrompt - the orientation prompt (written to a file, not embedded in shell)
   * @param ptySockPath - the UDS path for the PTY listener (Linux), or undefined for TCP mode
   * @param ptyPort - the TCP port for the PTY listener (macOS), or undefined for UDS mode
   */
  buildPtyCommand?(
    systemPrompt: string,
    ptySockPath: string | undefined,
    ptyPort: number | undefined,
  ): readonly string[];

  /**
   * Detects available credentials for this agent.
   * When not implemented, prepareDockerInfrastructure() falls back to
   * detectAuthMethod() (Anthropic OAuth + API key detection).
   */
  detectCredential?(config: IronCurtainConfig): AuthMethod;

  /**
   * Error message to show when no credentials are detected.
   * When not set, the default Anthropic-oriented message is used.
   */
  readonly credentialHelpText?: string;

  /**
   * Returns the conversation state configuration for this agent.
   * If undefined, the agent does not support conversation persistence
   * and sessions will not be marked as resumable.
   */
  getConversationStateConfig?(): ConversationStateConfig;
}
