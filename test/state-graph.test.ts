/**
 * Unit tests for extractStateGraph().
 */

import { describe, it, expect } from 'vitest';
import { extractStateGraph } from '../src/web-ui/state-graph.js';
import type { WorkflowDefinition } from '../src/workflow/types.js';

function makeMinimalDefinition(
  states: WorkflowDefinition['states'],
  initial = Object.keys(states)[0],
): WorkflowDefinition {
  return {
    name: 'test-workflow',
    description: 'A test workflow',
    initial,
    states,
  };
}

describe('extractStateGraph', () => {
  it('extracts agent states with transitions', () => {
    const definition = makeMinimalDefinition({
      plan: {
        type: 'agent',
        description: 'Creates a plan',
        persona: 'planner',
        prompt: 'Create a plan',
        inputs: [],
        outputs: ['plan'],
        transitions: [
          { to: 'review', when: { verdict: 'approved' } },
          { to: 'failed', guard: 'isStalled' },
        ],
      },
      review: { type: 'terminal', description: 'Done' },
      failed: { type: 'terminal', description: 'Failed' },
    });

    const graph = extractStateGraph(definition);

    expect(graph.states).toHaveLength(3);
    expect(graph.states[0]).toEqual({
      id: 'plan',
      type: 'agent',
      persona: 'planner',
      label: 'Plan',
      description: 'Creates a plan',
    });
    expect(graph.states[1]).toEqual({
      id: 'review',
      type: 'terminal',
      persona: undefined,
      label: 'Review',
      description: 'Done',
    });

    expect(graph.transitions).toHaveLength(2);
    expect(graph.transitions[0]).toEqual({
      from: 'plan',
      to: 'review',
      guard: undefined,
      label: 'approved',
    });
  });

  it('extracts human_gate states with event transitions', () => {
    const definition = makeMinimalDefinition({
      plan_review: {
        type: 'human_gate',
        description: 'Human review gate',
        acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
        transitions: [
          { to: 'implement', event: 'APPROVE' },
          { to: 'plan', event: 'FORCE_REVISION' },
          { to: 'aborted', event: 'ABORT' },
        ],
      },
      implement: { type: 'terminal', description: 'Implement' },
      plan: { type: 'terminal', description: 'Plan' },
      aborted: { type: 'terminal', description: 'Aborted' },
    });

    const graph = extractStateGraph(definition);

    const gateNode = graph.states.find((s) => s.id === 'plan_review');
    expect(gateNode).toEqual({
      id: 'plan_review',
      type: 'human_gate',
      persona: undefined,
      label: 'Plan Review',
      description: 'Human review gate',
    });

    const gateTransitions = graph.transitions.filter((t) => t.from === 'plan_review');
    expect(gateTransitions).toHaveLength(3);
    expect(gateTransitions[0]).toEqual({
      from: 'plan_review',
      to: 'implement',
      event: 'APPROVE',
      label: 'Approve',
    });
  });

  it('extracts deterministic states with guard transitions', () => {
    const definition = makeMinimalDefinition({
      validate: {
        type: 'deterministic',
        description: 'Runs tests',
        run: [['npm', 'test']],
        transitions: [
          { to: 'done', guard: 'isPassed' },
          { to: 'fix', when: { verdict: 'rejected' } },
        ],
      },
      done: { type: 'terminal', description: 'Done' },
      fix: { type: 'terminal', description: 'Fix' },
    });

    const graph = extractStateGraph(definition);

    const validateNode = graph.states.find((s) => s.id === 'validate');
    expect(validateNode?.type).toBe('deterministic');
    expect(validateNode?.persona).toBeUndefined();

    expect(graph.transitions).toHaveLength(2);
    expect(graph.transitions[0].guard).toBe('isPassed');
  });

  it('handles terminal states with no transitions', () => {
    const definition = makeMinimalDefinition({
      done: { type: 'terminal', description: 'Done' },
    });

    const graph = extractStateGraph(definition);

    expect(graph.states).toHaveLength(1);
    expect(graph.states[0]).toEqual({
      id: 'done',
      type: 'terminal',
      persona: undefined,
      label: 'Done',
      description: 'Done',
    });
    expect(graph.transitions).toHaveLength(0);
  });

  it('formats snake_case labels to Title Case', () => {
    const definition = makeMinimalDefinition({
      design_review_gate: {
        type: 'human_gate',
        description: 'Design review gate',
        acceptedEvents: ['APPROVE'],
        transitions: [{ to: 'done', event: 'APPROVE' }],
      },
      done: { type: 'terminal', description: 'Done' },
    });

    const graph = extractStateGraph(definition);
    const gate = graph.states.find((s) => s.id === 'design_review_gate');
    expect(gate?.label).toBe('Design Review Gate');
  });

  it('handles a full design-and-code workflow', () => {
    const definition = makeMinimalDefinition(
      {
        plan: {
          type: 'agent',
          description: 'Creates a plan',
          persona: 'planner',
          prompt: 'Create plan',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'plan_review' }],
        },
        plan_review: {
          type: 'human_gate',
          description: 'Human review gate',
          acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
          present: ['plan'],
          transitions: [
            { to: 'implement', event: 'APPROVE' },
            { to: 'plan', event: 'FORCE_REVISION' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        implement: {
          type: 'agent',
          description: 'Writes code',
          persona: 'coder',
          prompt: 'Implement',
          inputs: ['plan'],
          outputs: ['code'],
          transitions: [
            { to: 'review', when: { verdict: 'approved' } },
            { to: 'done', guard: 'isRoundLimitReached' },
          ],
        },
        review: {
          type: 'agent',
          description: 'Reviews code',
          persona: 'critic',
          prompt: 'Review',
          inputs: ['code'],
          outputs: ['review'],
          transitions: [
            { to: 'done', when: { verdict: 'approved' } },
            { to: 'implement', when: { verdict: 'rejected' } },
          ],
        },
        done: { type: 'terminal', description: 'Done' },
        aborted: { type: 'terminal', description: 'Aborted' },
      },
      'plan',
    );

    const graph = extractStateGraph(definition);

    expect(graph.states).toHaveLength(6);
    expect(graph.transitions.length).toBeGreaterThanOrEqual(7);

    // Verify the loop: review -> implement (backward edge)
    const backEdge = graph.transitions.find((t) => t.from === 'review' && t.to === 'implement');
    expect(backEdge).toBeDefined();
    expect(backEdge?.label).toBe('rejected');
  });
});
