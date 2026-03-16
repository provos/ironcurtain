import type { PolicyDecisionStatus } from '../types/mcp.js';
import type { ArgumentRole } from '../types/argument-roles.js';

export interface EvaluationResult {
  decision: PolicyDecisionStatus;
  rule: string;
  reason: string;
  /**
   * When decision is 'escalate', the role(s) whose independent evaluation
   * produced the escalation. Used by whitelist candidate extraction to
   * generate constraints only for the roles that actually caused the
   * escalation, not all resource-identifier roles on the tool.
   *
   * Populated by:
   * - evaluateCompiledRules(): roles whose per-role evaluation was 'escalate'
   *   and whose severity matched the final most-restrictive result.
   * - evaluateStructuralInvariants(): the specific role that triggered
   *   structural-domain-escalate.
   *
   * Undefined for non-escalate decisions and as a defensive fallback
   * (extraction falls back to all resource-identifier roles).
   */
  escalatedRoles?: readonly ArgumentRole[];
}
