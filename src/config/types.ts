import type { ResolvedUserConfig } from './user-config.js';

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

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
}
