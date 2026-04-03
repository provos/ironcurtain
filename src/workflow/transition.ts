import type { AgentOutput, WorkflowEvent } from './types.js';

/**
 * Maps an AgentOutput to the appropriate WorkflowEvent.
 *
 * Mapping rules (evaluated in order):
 * 1. completed=false -> AGENT_FAILED (agent could not finish)
 * 2. verdict='spec_flaw' -> SPEC_FLAW_DETECTED
 * 3. verdict='blocked' -> AGENT_FAILED with escalation reason
 * 4. verdict='rejected' -> AGENT_COMPLETED (guards handle reject routing)
 * 5. verdict='approved', confidence='low' -> AGENT_COMPLETED (isLowConfidence guard handles)
 * 6. verdict='approved' -> AGENT_COMPLETED
 */
export function agentOutputToEvent(output: AgentOutput): WorkflowEvent {
  // Not completed => failure
  if (!output.completed) {
    return {
      type: 'AGENT_FAILED',
      error: output.escalation ?? output.notes ?? 'Agent did not complete',
    };
  }

  // Spec flaw
  if (output.verdict === 'spec_flaw') {
    return { type: 'SPEC_FLAW_DETECTED' };
  }

  // Blocked
  if (output.verdict === 'blocked') {
    return {
      type: 'AGENT_FAILED',
      error: output.escalation ?? output.notes ?? 'Agent is blocked',
    };
  }

  // All other verdicts (approved, rejected) => AGENT_COMPLETED
  // The guards (isApproved, isRejected, isLowConfidence) handle routing
  return {
    type: 'AGENT_COMPLETED',
    output,
  };
}
