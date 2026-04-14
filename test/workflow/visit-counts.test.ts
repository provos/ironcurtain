/**
 * Functional test for visit-count-based prompt selection.
 *
 * Validates that the first entry to a state gets the full first-visit prompt
 * (with role instructions) and subsequent entries get the abbreviated re-visit
 * prompt. Uses the real buildWorkflowMachine + XState machine + buildAgentCommand
 * pipeline with only the agent execution mocked.
 */

import { describe, it, expect } from 'vitest';
import { createActor, fromPromise } from 'xstate';
import {
  buildWorkflowMachine,
  type AgentInvokeInput,
  type AgentInvokeResult,
} from '../../src/workflow/machine-builder.js';
import { buildAgentCommand } from '../../src/workflow/prompt-builder.js';
import type { AgentStateDefinition, WorkflowDefinition } from '../../src/workflow/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentResult(overrides: Partial<AgentInvokeResult> = {}): AgentInvokeResult {
  return {
    output: {
      completed: true,
      verdict: 'approved',
      confidence: 'high',
      escalation: null,
      testCount: null,
      notes: null,
    },
    sessionId: 'test-session',
    artifacts: {},
    outputHash: 'hash-1',
    responseText: 'Agent response text',
    ...overrides,
  };
}

function makeRejectedResult(responseText = 'Needs improvement'): AgentInvokeResult {
  return makeAgentResult({
    output: {
      completed: true,
      verdict: 'rejected',
      confidence: 'high',
      escalation: null,
      testCount: null,
      notes: 'needs work',
    },
    outputHash: 'rejected-hash',
    responseText,
  });
}

/** Wait for the machine to settle after async transitions. */
function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Workflow definition: implement -> review -> implement (loop) -> done
// ---------------------------------------------------------------------------

const loopDefinition: WorkflowDefinition = {
  name: 'visit-count-test',
  description: 'Two-state loop for visit count testing',
  initial: 'implement',
  settings: { maxRounds: 4 },
  states: {
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      freshSession: false,
      prompt: 'You are a coder. Write clean code.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'agent',
      description: 'Reviews code',
      persona: 'reviewer',
      freshSession: false,
      prompt: 'You are a code reviewer. Check for bugs.',
      inputs: ['code'],
      outputs: ['reviews'],
      transitions: [
        { to: 'done', guard: 'isApproved' },
        { to: 'implement', guard: 'isRejected' },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('visitCounts prompt selection', () => {
  it('sends first-visit prompt on first entry and re-visit prompt on second entry', async () => {
    const { machine } = buildWorkflowMachine(loopDefinition, 'Build a widget');

    // Track the commands generated for each agent invocation
    const capturedCommands: Array<{ stateId: string; command: string }> = [];
    let invocationCount = 0;

    const testMachine = machine.provide({
      actors: {
        agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
          // Call the real prompt builder with the context the machine provides
          const command = buildAgentCommand(input.stateId, input.stateConfig, input.context, loopDefinition);
          capturedCommands.push({ stateId: input.stateId, command });

          invocationCount++;

          // First review: reject to trigger the loop back to implement.
          // Second review: approve to end the workflow.
          if (input.stateId === 'review') {
            if (invocationCount <= 2) {
              return makeRejectedResult('Found bugs in the code');
            }
            return makeAgentResult({ responseText: 'Looks good now' });
          }

          return makeAgentResult({ responseText: 'Here is the code' });
        }),
      },
    });

    const actor = createActor(testMachine);
    actor.start();
    await settle(200);

    expect(actor.getSnapshot().status).toBe('done');

    // Expected flow: implement(1) -> review(1) -> implement(2) -> review(2) -> done
    // That's 4 agent invocations
    expect(capturedCommands).toHaveLength(4);

    // -- implement: first entry (visitCount=1) --
    const implement1 = capturedCommands[0];
    expect(implement1.stateId).toBe('implement');
    // First visit gets the full prompt with role instructions
    expect(implement1.command).toContain('You are a coder. Write clean code.');
    // All agents use Workflow Context heading
    expect(implement1.command).toContain('## Workflow Context');

    // -- review: first entry (visitCount=1) --
    const review1 = capturedCommands[1];
    expect(review1.stateId).toBe('review');
    expect(review1.command).toContain('You are a code reviewer. Check for bugs.');
    expect(review1.command).toContain('## Workflow Context');

    // -- implement: second entry (visitCount=2) -> re-visit prompt --
    const implement2 = capturedCommands[2];
    expect(implement2.stateId).toBe('implement');
    // Re-visit prompt should NOT contain the role instructions or section headings
    expect(implement2.command).not.toContain('You are a coder. Write clean code.');
    expect(implement2.command).not.toContain('## Task');
    expect(implement2.command).not.toContain('## Workflow Context');
    expect(implement2.command).not.toContain('## Your Role');
    // Re-visit prompt SHOULD contain the previous agent output
    expect(implement2.command).toContain('## New Input from review');
    expect(implement2.command).toContain('Found bugs in the code');
    // Re-visit prompt should include round information
    expect(implement2.command).toContain('## Round');

    // -- review: second entry (visitCount=2) -> re-visit prompt --
    const review2 = capturedCommands[3];
    expect(review2.stateId).toBe('review');
    expect(review2.command).not.toContain('You are a code reviewer. Check for bugs.');
    expect(review2.command).not.toContain('## Task');
    expect(review2.command).not.toContain('## Workflow Context');
    expect(review2.command).not.toContain('## Your Role');
    expect(review2.command).toContain('## New Input from implement');
  });

  it('increments visitCounts on entry, not on completion', async () => {
    const { machine } = buildWorkflowMachine(loopDefinition, 'Test task');

    const contextSnapshots: Array<{ stateId: string; visitCounts: Record<string, number> }> = [];

    const testMachine = machine.provide({
      actors: {
        agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
          // Capture the context at the time the agent service is invoked
          // (after entry actions have run)
          contextSnapshots.push({
            stateId: input.stateId,
            visitCounts: { ...input.context.visitCounts },
          });

          // Single loop: implement -> review(reject) -> implement -> review(approve)
          if (input.stateId === 'review') {
            if (contextSnapshots.length <= 2) {
              return makeRejectedResult();
            }
            return makeAgentResult();
          }
          return makeAgentResult();
        }),
      },
    });

    const actor = createActor(testMachine);
    actor.start();
    await settle(200);

    expect(actor.getSnapshot().status).toBe('done');
    expect(contextSnapshots).toHaveLength(4);

    // First entry to implement: visitCounts should show implement=1
    expect(contextSnapshots[0].stateId).toBe('implement');
    expect(contextSnapshots[0].visitCounts['implement']).toBe(1);

    // First entry to review: visitCounts should show implement=1, review=1
    expect(contextSnapshots[1].stateId).toBe('review');
    expect(contextSnapshots[1].visitCounts['review']).toBe(1);

    // Second entry to implement: visitCounts should show implement=2, review=1
    expect(contextSnapshots[2].stateId).toBe('implement');
    expect(contextSnapshots[2].visitCounts['implement']).toBe(2);

    // Second entry to review: visitCounts should show implement=2, review=2
    expect(contextSnapshots[3].stateId).toBe('review');
    expect(contextSnapshots[3].visitCounts['review']).toBe(2);
  });

  it('fresh-session state gets full first-visit prompt on re-entry', async () => {
    // Override implement to use default freshSession (true) instead of the
    // loopDefinition's explicit false — verifying that the default produces
    // a fresh session with the full first-visit prompt on re-entry.
    const freshDef: WorkflowDefinition = {
      ...loopDefinition,
      states: {
        ...loopDefinition.states,
        implement: {
          ...(loopDefinition.states.implement as AgentStateDefinition),
          freshSession: undefined,
        } as WorkflowDefinition['states'][string],
      },
    };

    const { machine } = buildWorkflowMachine(freshDef, 'Build a widget');
    const capturedCommands: Array<{ stateId: string; command: string }> = [];
    let invocationCount = 0;

    const testMachine = machine.provide({
      actors: {
        agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
          const command = buildAgentCommand(input.stateId, input.stateConfig, input.context, freshDef);
          capturedCommands.push({ stateId: input.stateId, command });
          invocationCount++;

          if (input.stateId === 'review') {
            if (invocationCount <= 2) {
              return makeRejectedResult('Found bugs in the code');
            }
            return makeAgentResult({ responseText: 'Looks good now' });
          }
          return makeAgentResult({ responseText: 'Here is the code' });
        }),
      },
    });

    const actor = createActor(testMachine);
    actor.start();
    await settle(200);

    expect(actor.getSnapshot().status).toBe('done');
    // Flow: implement(1) -> review(1) -> implement(2) -> review(2) -> done
    expect(capturedCommands).toHaveLength(4);

    // implement second entry (visitCount=2) should still get the full first-visit prompt
    // because freshSession is true
    const implement2 = capturedCommands[2];
    expect(implement2.stateId).toBe('implement');
    expect(implement2.command).toContain('You are a coder. Write clean code.');
    expect(implement2.command).toContain('## Workflow Context');
    expect(implement2.command).toContain('## Your Role');
    // Should NOT use the re-visit format
    expect(implement2.command).not.toContain('## Round');
    expect(implement2.command).not.toContain('## New Input from');
  });

  it('non-fresh-session state still gets re-visit prompt on re-entry', async () => {
    // Use the loopDefinition (freshSession: false) and verify the
    // re-visit behavior is preserved
    const { machine } = buildWorkflowMachine(loopDefinition, 'Build a widget');
    const capturedCommands: Array<{ stateId: string; command: string }> = [];
    let invocationCount = 0;

    const testMachine = machine.provide({
      actors: {
        agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
          const command = buildAgentCommand(input.stateId, input.stateConfig, input.context, loopDefinition);
          capturedCommands.push({ stateId: input.stateId, command });
          invocationCount++;

          if (input.stateId === 'review') {
            if (invocationCount <= 2) {
              return makeRejectedResult('Found bugs in the code');
            }
            return makeAgentResult({ responseText: 'Looks good now' });
          }
          return makeAgentResult({ responseText: 'Here is the code' });
        }),
      },
    });

    const actor = createActor(testMachine);
    actor.start();
    await settle(200);

    expect(actor.getSnapshot().status).toBe('done');
    expect(capturedCommands).toHaveLength(4);

    // implement second entry should get abbreviated re-visit prompt (default behavior)
    const implement2 = capturedCommands[2];
    expect(implement2.stateId).toBe('implement');
    expect(implement2.command).not.toContain('You are a coder. Write clean code.');
    expect(implement2.command).not.toContain('## Your Role');
    expect(implement2.command).toContain('## Round');
  });

  it('fresh-session state has undefined previousSessionId on re-entry', async () => {
    // Override implement to use default freshSession (true) — verifying
    // that previousSessionId is undefined when freshSession is not false.
    const freshDef: WorkflowDefinition = {
      ...loopDefinition,
      states: {
        ...loopDefinition.states,
        implement: {
          ...(loopDefinition.states.implement as AgentStateDefinition),
          freshSession: undefined,
        } as WorkflowDefinition['states'][string],
      },
    };

    const { machine } = buildWorkflowMachine(freshDef, 'Build a widget');
    const capturedInputs: Array<{ stateId: string; previousSessionId: string | undefined }> = [];
    let invocationCount = 0;

    const testMachine = machine.provide({
      actors: {
        agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
          // Track the previousSessionId that would be used by the orchestrator
          const previousSessionId =
            input.stateConfig.freshSession === false ? input.context.sessionsByState[input.stateId] : undefined;
          capturedInputs.push({ stateId: input.stateId, previousSessionId });
          invocationCount++;

          if (input.stateId === 'review') {
            if (invocationCount <= 2) {
              return makeRejectedResult('Found bugs');
            }
            return makeAgentResult();
          }
          return makeAgentResult({ sessionId: `session-${input.stateId}-${invocationCount}` });
        }),
      },
    });

    const actor = createActor(testMachine);
    actor.start();
    await settle(200);

    expect(actor.getSnapshot().status).toBe('done');
    expect(capturedInputs).toHaveLength(4);

    // implement first entry: no previous session exists
    expect(capturedInputs[0].stateId).toBe('implement');
    expect(capturedInputs[0].previousSessionId).toBeUndefined();

    // implement second entry: freshSession=true -> previousSessionId is undefined
    // even though sessionsByState has a session ID from the first invocation
    expect(capturedInputs[2].stateId).toBe('implement');
    expect(capturedInputs[2].previousSessionId).toBeUndefined();

    // review (non-fresh) second entry: should have the previous session ID
    expect(capturedInputs[3].stateId).toBe('review');
    expect(capturedInputs[3].previousSessionId).toBeDefined();
  });

  it('isRoundLimitReached fires correctly with entry-based counts', async () => {
    // Use a definition where the round limit guard is in the transition chain
    const roundLimitDef: WorkflowDefinition = {
      name: 'round-limit-test',
      description: 'Tests round limit with entry-based counts',
      initial: 'implement',
      settings: { maxRounds: 2 },
      states: {
        implement: {
          type: 'agent',
          description: 'Writes code',
          persona: 'coder',
          prompt: 'You are a coder.',
          inputs: [],
          outputs: ['code'],
          transitions: [{ to: 'review' }],
        },
        review: {
          type: 'agent',
          description: 'Reviews code',
          persona: 'reviewer',
          prompt: 'You are a reviewer.',
          inputs: ['code'],
          outputs: ['reviews'],
          transitions: [
            { to: 'done', guard: 'isApproved' },
            { to: 'escalated', guard: 'isRoundLimitReached' },
            { to: 'implement', guard: 'isRejected' },
          ],
        },
        done: { type: 'terminal', description: 'Done' },
        escalated: { type: 'terminal', description: 'Escalated due to round limit' },
      },
    };

    const { machine } = buildWorkflowMachine(roundLimitDef, 'Test task');
    const visited: string[] = [];

    const testMachine = machine.provide({
      actors: {
        agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
          visited.push(input.stateId);
          // Always reject to force the loop
          return makeRejectedResult();
        }),
      },
    });

    const actor = createActor(testMachine);
    actor.start();
    await settle(200);

    // With maxRounds=2 and entry-based counting:
    // implement(1) -> review(1, reject) -> implement(2, count=2 >= maxRounds) -> review(2, isRoundLimitReached fires)
    // The round limit should fire when review sees implement has been visited 2 times
    expect(actor.getSnapshot().status).toBe('done');
    const finalState = String(actor.getSnapshot().value);
    expect(finalState).toBe('escalated');
  });
});
