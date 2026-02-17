import type { ToolCallRequest, PolicyDecisionStatus } from '../types/mcp.js';

export interface PolicyRule {
  name: string;
  description: string;
  condition: (request: ToolCallRequest, allowedDirectory: string) => boolean;
  decision: PolicyDecisionStatus;
  reason: string;
}

export interface EvaluationResult {
  decision: PolicyDecisionStatus;
  rule: string;
  reason: string;
}
