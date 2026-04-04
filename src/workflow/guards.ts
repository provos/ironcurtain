import type { WorkflowContext, WorkflowEvent, AgentOutput } from './types.js';

// ---------------------------------------------------------------------------
// Guard function type
// ---------------------------------------------------------------------------

export type GuardFunction = (params: { readonly context: WorkflowContext; readonly event: WorkflowEvent }) => boolean;

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extracts AgentOutput from an AGENT_COMPLETED event.
 * Returns undefined if the event is not an AGENT_COMPLETED event.
 */
function extractAgentOutput(event: WorkflowEvent): AgentOutput | undefined {
  if (event.type === 'AGENT_COMPLETED') {
    return event.output;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Guard implementations
// ---------------------------------------------------------------------------

/** Agent verdict is 'approved' (any confidence). */
const isApproved: GuardFunction = ({ event }) => {
  const output = extractAgentOutput(event);
  return output?.verdict === 'approved';
};

/** Agent verdict is 'rejected'. */
const isRejected: GuardFunction = ({ event }) => {
  const output = extractAgentOutput(event);
  return output?.verdict === 'rejected';
};

/** Agent verdict is 'approved' but confidence is 'low'. */
const isLowConfidence: GuardFunction = ({ event }) => {
  const output = extractAgentOutput(event);
  return output?.verdict === 'approved' && output.confidence === 'low';
};

/**
 * Per-state round limit check. Compares the maximum visit count
 * across all states against maxRounds. This fires when any state
 * has been visited enough times to hit the limit.
 *
 * In the typical coder-critic loop, this checks whether the loop
 * has iterated enough times to warrant escalation.
 */
const isRoundLimitReached: GuardFunction = ({ context }) => {
  const counts = Object.values(context.visitCounts);
  if (counts.length === 0) return false;
  const maxVisits = Math.max(...counts);
  return maxVisits >= context.maxRounds;
};

/**
 * Per-role stall detection. Compares the current output hash against
 * the hash stored for the same role from the previous invocation.
 *
 * The event must carry stateId and outputHash for this guard to fire.
 * In Phase 1 we work with WorkflowEvent directly; the orchestrator
 * will attach these via context updates. For now, we check the context's
 * previousOutputHashes against the current state's stored hash.
 *
 * NOTE: This guard operates on context state that the orchestrator
 * updates between rounds. It checks whether the last recorded hash
 * for a given role matches the current hash (carried on the event
 * via a convention TBD in the machine builder phase).
 */
const isStalled: GuardFunction = ({ event }) => {
  if (event.type !== 'AGENT_COMPLETED') return false;
  // The orchestrator sets context.previousOutputHashes[stateId] after
  // each agent invocation. The stall check compares the hash from the
  // current invocation (not yet in context) against the stored one.
  // In the guards-only phase, we expose this as a context-driven check.
  // The machine builder will wire stateId + outputHash through the event.
  return false; // Requires machine builder integration; stubbed for Phase 1
};

/** Test count has decreased compared to the previous round. */
const hasTestCountRegression: GuardFunction = ({ context, event }) => {
  const output = extractAgentOutput(event);
  if (context.previousTestCount == null || output?.testCount == null) {
    return false;
  }
  return output.testCount < context.previousTestCount;
};

/**
 * For deterministic states. Checks whether the validation passed.
 * The event type is VALIDATION_PASSED for passing results.
 */
const isPassed: GuardFunction = ({ event }) => {
  return event.type === 'VALIDATION_PASSED';
};

// ---------------------------------------------------------------------------
// Guard registry
// ---------------------------------------------------------------------------

export const guardImplementations: Readonly<Record<string, GuardFunction>> = {
  isApproved,
  isRejected,
  isLowConfidence,
  isRoundLimitReached,
  isStalled,
  hasTestCountRegression,
  isPassed,
};

/** Set of all registered guard names. Used by validation to check definitions. */
export const REGISTERED_GUARDS: ReadonlySet<string> = new Set(Object.keys(guardImplementations));
