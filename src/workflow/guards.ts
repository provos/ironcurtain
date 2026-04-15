import type { WorkflowContext, WorkflowEvent } from './types.js';

// ---------------------------------------------------------------------------
// Guard function type
// ---------------------------------------------------------------------------

export type GuardFunction = (params: { readonly context: WorkflowContext; readonly event: WorkflowEvent }) => boolean;

// ---------------------------------------------------------------------------
// Guard implementations
// ---------------------------------------------------------------------------

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

// Stall detection is handled by the machine builder's guard adapter
// (machine-builder.ts), which has access to outputHash and stateId from
// the invoke result. This stub exists so 'isStalled' passes definition
// validation via REGISTERED_GUARDS.
const isStalled: GuardFunction = () => false;

const isPassed: GuardFunction = ({ event }) => {
  return event.type === 'VALIDATION_PASSED';
};

// ---------------------------------------------------------------------------
// Guard registry
// ---------------------------------------------------------------------------

export const guardImplementations: Readonly<Record<string, GuardFunction>> = {
  isRoundLimitReached,
  isStalled,
  isPassed,
};

/** Set of all registered guard names. Used by validation to check definitions. */
export const REGISTERED_GUARDS: ReadonlySet<string> = new Set(Object.keys(guardImplementations));
