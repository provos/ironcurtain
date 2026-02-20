import type { ResolvedUserConfig } from './user-config.js';

/**
 * Network access configuration for a sandboxed MCP server.
 *
 * Invariant: when `allowedDomains` is empty, no network access is permitted.
 * `deniedDomains` takes precedence and is checked first.
 */
export interface SandboxNetworkConfig {
  /** Domains the server may connect to. Supports wildcards (e.g., "*.github.com"). */
  readonly allowedDomains: string[];
  /** Domains explicitly blocked even if they match an allowed pattern. */
  readonly deniedDomains?: string[];
}

/**
 * Filesystem access configuration for a sandboxed MCP server.
 *
 * Invariant: `allowWrite` always includes the session sandbox directory
 * (injected at runtime, not specified here). Paths listed here are
 * *additional* write-allowed directories beyond the sandbox.
 *
 * Reads are allowed by default. Use `denyRead` to block sensitive
 * paths like ~/.ssh or ~/.gnupg.
 */
export interface SandboxFilesystemConfig {
  /** Additional directories the server may write to, beyond the session sandbox. */
  readonly allowWrite?: string[];
  /** Directories the server may not read. */
  readonly denyRead?: string[];
  /** Directories the server may not write to, even within allowed paths. */
  readonly denyWrite?: string[];
}

/**
 * Per-server sandbox configuration.
 *
 * Discriminated on presence/shape:
 * - `false`: server opts out of sandboxing entirely
 * - `object`: server is sandboxed with the specified overrides
 * - `undefined` (omitted): server is sandboxed with restrictive defaults
 *   (session sandbox write-only, no network)
 */
export type ServerSandboxConfig = false | {
  /** Filesystem restrictions beyond the automatic session sandbox directory. */
  readonly filesystem?: SandboxFilesystemConfig;
  /**
   * Network access. `false` means no network (default).
   * An object specifies allowed/denied domains.
   */
  readonly network?: false | SandboxNetworkConfig;
};

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** OS-level sandbox configuration. Omit for restrictive defaults, `false` to opt out. */
  sandbox?: ServerSandboxConfig;
}

/**
 * Controls behavior when sandbox-runtime is unavailable on the current
 * platform (e.g., Windows, Linux without bubblewrap).
 *
 * - "enforce": refuse to start servers that require sandboxing
 * - "warn": log a warning and start the server without sandbox (default)
 */
export type SandboxAvailabilityPolicy = 'enforce' | 'warn';

export interface IronCurtainConfig {
  auditLogPath: string;
  allowedDirectory: string;
  mcpServers: Record<string, MCPServerConfig>;
  protectedPaths: string[];
  generatedDir: string;
  constitutionPath: string;
  /** Per-session escalation directory for file-based IPC with the proxy. Optional for backward compatibility. */
  escalationDir?: string;
  /** Per-session log file path for capturing child process output. Optional for backward compatibility. */
  sessionLogPath?: string;
  /** Per-session LLM interaction log path. When set, all LLM calls are logged to this JSONL file. */
  llmLogPath?: string;
  /** AI SDK model ID for the interactive agent (e.g. 'anthropic:claude-sonnet-4-6'). */
  agentModelId: string;
  /** Escalation timeout in seconds (30-600). Controls how long to wait for human approval. */
  escalationTimeoutSeconds: number;
  /** Resolved user configuration. Provides API keys for model resolution. */
  userConfig: ResolvedUserConfig;
  /**
   * Controls behavior when OS-level sandboxing is unavailable.
   * Default: "warn" -- log and continue without sandbox.
   */
  sandboxPolicy?: SandboxAvailabilityPolicy;
}
