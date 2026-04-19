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
  /**
   * When true, the escalation was approved by the auto-approver
   * rather than a human. Only present when escalationResult is 'approved'.
   */
  autoApproved?: boolean;

  /**
   * When true, the escalation was bypassed because a whitelist
   * pattern matched. The whitelistPatternId links to the original
   * approval that created the pattern.
   */
  whitelistApproved?: boolean;

  /**
   * ID of the whitelist pattern that matched, linking back to the
   * original escalation approval. Only present when whitelistApproved is true.
   */
  whitelistPatternId?: string;

  /**
   * Persona under which the tool call was evaluated. Set by the
   * `ToolCallCoordinator` from its `currentPersona` field (updated
   * inside `loadPolicy`). Absent for single-session modes (CLI, daemon,
   * cron) that never call `loadPolicy`. In workflow runs every audit
   * entry carries a persona because `loadPolicy` is invoked before the
   * first tool call of each agent-state entry.
   */
  persona?: string;
}
