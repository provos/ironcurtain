export interface ToolCallRequest {
  requestId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  timestamp: string;
}

export type PolicyDecisionStatus = 'allow' | 'deny' | 'escalate';

export interface PolicyDecision {
  status: PolicyDecisionStatus;
  rule: string;
  reason: string;
}

export interface ToolCallResult {
  requestId: string;
  status: 'success' | 'denied' | 'error';
  content: unknown;
  policyDecision: PolicyDecision;
  durationMs: number;
}
