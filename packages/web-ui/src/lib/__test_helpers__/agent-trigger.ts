/**
 * Test helpers for synthesizing AgentTransitionTrigger fixtures.
 *
 * Lives next to (but separate from) production code so test fixtures
 * never leak into the runtime bundle. Re-exporting AgentTransitionTrigger
 * from the graph module keeps the helper a thin convenience and the type
 * source-of-truth in one place.
 */

import type { AgentTransitionTrigger } from '$lib/components/features/state-machine-graph.svelte';

const DEFAULT_TRIGGER: AgentTransitionTrigger = {
  id: 1,
  kind: 'completed',
  stateId: 'a',
  peerStateId: 'b',
  notes: 'handoff',
};

/**
 * Build an AgentTransitionTrigger with sensible defaults; any field can
 * be overridden. Use in tests that need to fire a transition without
 * caring about the full payload shape.
 */
export function makeAgentTrigger(overrides: Partial<AgentTransitionTrigger> = {}): AgentTransitionTrigger {
  return { ...DEFAULT_TRIGGER, ...overrides };
}
