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
}
