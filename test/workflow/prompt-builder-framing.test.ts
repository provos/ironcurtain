/**
 * Unit tests for buildAgentCommand re-entry framing.
 *
 * Focuses on same-state vs cross-state re-entry and the placement of
 * human feedback. A FORCE_REVISION that routes back to the same state
 * must frame the previous output as the agent's own work (self-revision),
 * not as some other agent's review. Human feedback must appear at the
 * top of the prompt in both first-visit and re-visit layouts.
 */

import { describe, it, expect } from 'vitest';
import { buildAgentCommand } from '../../src/workflow/prompt-builder.js';
import type { AgentStateDefinition, WorkflowContext, WorkflowDefinition } from '../../src/workflow/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgentState(overrides: Partial<AgentStateDefinition> = {}): AgentStateDefinition {
  return {
    type: 'agent',
    description: 'Test agent',
    persona: 'global',
    prompt: 'You are a test agent.',
    inputs: [],
    outputs: ['result'],
    transitions: [{ to: 'next' }],
    ...overrides,
  };
}

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    taskDescription: 'Some task',
    artifacts: {},
    round: 1,
    maxRounds: 10,
    previousOutputHashes: {},
    previousTestCount: null,
    humanPrompt: null,
    reviewHistory: [],
    parallelResults: {},
    worktreeBranches: [],
    totalTokens: 0,
    flaggedForReview: false,
    lastError: null,
    sessionsByState: {},
    previousAgentOutput: null,
    previousStateName: null,
    visitCounts: {},
    ...overrides,
  };
}

const definition: WorkflowDefinition = {
  name: 'test',
  description: 'framing tests',
  initial: 'work',
  states: {
    work: makeAgentState(),
    next: { type: 'terminal', description: 'Done' },
  },
};

// ---------------------------------------------------------------------------
// First-visit prompt (fresh session: the relevant case after removing
// `freshSession: false` from harness_design / harness_build)
// ---------------------------------------------------------------------------

describe('buildAgentCommand — first-visit FORCE_REVISION framing', () => {
  it("same-state re-entry frames previous output as the agent's own prior work", () => {
    const state = makeAgentState();
    const context = makeContext({
      humanPrompt: 'The harness executes instead of designing — produce a design doc.',
      previousAgentOutput: 'Prior output that went off-pattern.',
      previousStateName: 'work',
      visitCounts: { work: 2 },
    });

    const command = buildAgentCommand('work', state, context, definition);

    // Self-revision framing, not cross-agent-review framing
    expect(command).toContain('## Your Previous Output');
    expect(command).toContain('This is your own prior output');
    expect(command).not.toContain('The work agent produced the following output');
    expect(command).not.toContain('reviewed your work');

    // Human feedback appears BEFORE previous output (feedback is the driver)
    const feedbackIdx = command.indexOf('Human Feedback');
    const prevOutputIdx = command.indexOf('Your Previous Output');
    expect(feedbackIdx).toBeGreaterThan(-1);
    expect(prevOutputIdx).toBeGreaterThan(-1);
    expect(feedbackIdx).toBeLessThan(prevOutputIdx);

    // Same-state heading includes the "revise" cue
    expect(command).toContain('revise your previous work');
  });

  it('cross-state re-entry keeps the "Output from X" framing', () => {
    const state = makeAgentState();
    const context = makeContext({
      humanPrompt: 'Please reconsider.',
      previousAgentOutput: 'Output from a different agent.',
      previousStateName: 'reviewer',
      visitCounts: { work: 1 },
    });

    const command = buildAgentCommand('work', state, context, definition);

    expect(command).toContain('## Output from reviewer');
    expect(command).toContain('The reviewer agent produced the following output');
    expect(command).not.toContain('## Your Previous Output');
    expect(command).not.toContain('revise your previous work');

    // Human feedback still sits above the previous agent output
    const feedbackIdx = command.indexOf('Human Feedback');
    const prevOutputIdx = command.indexOf('## Output from reviewer');
    expect(feedbackIdx).toBeLessThan(prevOutputIdx);
  });

  it('human feedback appears above workflow context on first visit', () => {
    const state = makeAgentState();
    const context = makeContext({
      humanPrompt: 'Feedback goes here.',
      previousAgentOutput: null,
      previousStateName: null,
    });

    const command = buildAgentCommand('work', state, context, definition);

    const feedbackIdx = command.indexOf('Human Feedback');
    const contextIdx = command.indexOf('Workflow Context');
    expect(feedbackIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeGreaterThan(feedbackIdx);
  });

  it('no human feedback: first-visit prompt omits the feedback section', () => {
    const state = makeAgentState();
    const context = makeContext({
      humanPrompt: null,
      previousAgentOutput: 'prior',
      previousStateName: 'other',
    });

    const command = buildAgentCommand('work', state, context, definition);

    expect(command).not.toContain('Human Feedback');
    expect(command).toContain('## Output from other');
  });
});

// ---------------------------------------------------------------------------
// Re-visit prompt (freshSession: false path)
// ---------------------------------------------------------------------------

describe('buildAgentCommand — re-visit FORCE_REVISION framing', () => {
  it('same-state re-visit uses self-revision framing with feedback on top', () => {
    const state = makeAgentState({ freshSession: false });
    const context = makeContext({
      humanPrompt: 'Revise this output.',
      previousAgentOutput: 'Prior output.',
      previousStateName: 'work',
      visitCounts: { work: 2 },
    });

    const command = buildAgentCommand('work', state, context, definition);

    // Re-visit: no role prompt, no workflow context heading
    expect(command).not.toContain('## Workflow Context');
    expect(command).not.toContain('## Your Role');

    // Self-revision framing
    expect(command).toContain('## Your Previous Output');
    expect(command).toContain('This is your own prior output');
    expect(command).not.toContain('reviewed your work');

    // Feedback above prior output
    const feedbackIdx = command.indexOf('Human Feedback');
    const prevOutputIdx = command.indexOf('Your Previous Output');
    expect(feedbackIdx).toBeGreaterThan(-1);
    expect(feedbackIdx).toBeLessThan(prevOutputIdx);
  });

  it('cross-state re-visit labels the previous output by its source state', () => {
    const state = makeAgentState({ freshSession: false });
    const context = makeContext({
      humanPrompt: null,
      previousAgentOutput: 'review output',
      previousStateName: 'review',
      visitCounts: { work: 2 },
    });

    const command = buildAgentCommand('work', state, context, definition);

    expect(command).toContain('## New Input from review');
    expect(command).toContain('The review agent produced the following output');
    // No longer say "reviewed your work" — that was misleading when it was
    // actually the same state self-revising.
    expect(command).not.toContain('reviewed your work');
    expect(command).not.toContain('## Your Previous Output');
  });
});
