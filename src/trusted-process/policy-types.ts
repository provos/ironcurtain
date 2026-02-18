import type { PolicyDecisionStatus } from '../types/mcp.js';

export interface EvaluationResult {
  decision: PolicyDecisionStatus;
  rule: string;
  reason: string;
}
