import type { PolicyDecision } from './mcp.js';

export interface AuditEntry {
  timestamp: string;
  requestId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  policyDecision: PolicyDecision;
  escalationResult?: 'approved' | 'denied';
  result: {
    status: 'success' | 'denied' | 'error';
    content?: unknown;
    error?: string;
  };
  durationMs: number;
  /** Whether the MCP server process was running inside an OS-level sandbox. */
  sandboxed?: boolean;
}
