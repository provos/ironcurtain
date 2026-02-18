export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface IronCurtainConfig {
  anthropicApiKey: string;
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
}
