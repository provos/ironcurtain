import { describe, it, expect } from 'vitest';
import { createActor, fromPromise, type AnyActor } from 'xstate';
import {
  buildWorkflowMachine,
  createInitialContext,
  type AgentInvokeInput,
  type AgentInvokeResult,
  type DeterministicInvokeInput,
  type DeterministicInvokeResult,
} from '../../src/workflow/machine-builder.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';

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
    ...overrides,
  };
}

function makeRejectedResult(notes = 'needs work'): AgentInvokeResult {
  return makeAgentResult({
    output: {
      completed: true,
      verdict: 'rejected',
      confidence: 'high',
      escalation: null,
      testCount: null,
      notes,
    },
    outputHash: 'rejected-hash',
  });
}

function makeDeterministicResult(overrides: Partial<DeterministicInvokeResult> = {}): DeterministicInvokeResult {
  return {
    passed: true,
    testCount: 10,
    ...overrides,
  };
}

/** Wait for the machine to settle after an async transition. */
function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Collects state values visited by an actor. */
function trackStates(actor: AnyActor): string[] {
  const visited: string[] = [];
  actor.subscribe((snap) => {
    visited.push(String(snap.value));
  });
  return visited;
}

// ---------------------------------------------------------------------------
// Fixture definitions
// ---------------------------------------------------------------------------

/** Simple linear: plan -> design -> done */
const linearDefinition: WorkflowDefinition = {
  name: 'linear-test',
  description: 'Simple linear workflow',
  initial: 'plan',
  states: {
    plan: {
      type: 'agent',
      persona: 'planner',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'design' }],
    },
    design: {
      type: 'agent',
      persona: 'architect',
      inputs: ['plan'],
      outputs: ['design'],
      transitions: [{ to: 'done' }],
    },
    done: {
      type: 'terminal',
      outputs: ['plan', 'design'],
    },
  },
};

/** plan -> gate -> design -> done */
const gatedDefinition: WorkflowDefinition = {
  name: 'gated-test',
  description: 'Workflow with a human gate',
  initial: 'plan',
  states: {
    plan: {
      type: 'agent',
      persona: 'planner',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'review_gate' }],
    },
    review_gate: {
      type: 'human_gate',
      acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
      present: ['plan'],
      transitions: [
        { to: 'design', event: 'APPROVE' },
        { to: 'plan', event: 'FORCE_REVISION' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    design: {
      type: 'agent',
      persona: 'architect',
      inputs: ['plan'],
      outputs: ['design'],
      transitions: [{ to: 'done' }],
    },
    done: {
      type: 'terminal',
      outputs: ['plan', 'design'],
    },
    aborted: {
      type: 'terminal',
    },
  },
};

/** plan -> implement -> test(deterministic) -> done/implement loop */
const deterministicLoopDefinition: WorkflowDefinition = {
  name: 'deterministic-loop-test',
  description: 'Workflow with a deterministic state loop',
  initial: 'plan',
  states: {
    plan: {
      type: 'agent',
      persona: 'planner',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'implement' }],
    },
    implement: {
      type: 'agent',
      persona: 'coder',
      inputs: ['plan'],
      outputs: ['code'],
      transitions: [{ to: 'test' }],
    },
    test: {
      type: 'deterministic',
      run: [['npm', 'test']],
      transitions: [{ to: 'done', guard: 'isPassed' }, { to: 'implement' }],
    },
    done: {
      type: 'terminal',
      outputs: ['plan', 'code'],
    },
  },
};

/** Coder -> critic loop with guards and round limits */
const coderCriticDefinition: WorkflowDefinition = {
  name: 'coder-critic-test',
  description: 'Workflow with coder-critic loop',
  initial: 'implement',
  settings: { maxRounds: 3 },
  states: {
    implement: {
      type: 'agent',
      persona: 'coder',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'agent',
      persona: 'critic',
      inputs: ['code'],
      outputs: ['review'],
      transitions: [
        { to: 'done', guard: 'isApproved' },
        { to: 'escalate_gate', guard: 'isRoundLimitReached' },
        { to: 'implement', guard: 'isRejected' },
        { to: 'escalate_gate' },
      ],
    },
    escalate_gate: {
      type: 'human_gate',
      acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
      present: ['code', 'review'],
      transitions: [
        { to: 'done', event: 'APPROVE' },
        { to: 'implement', event: 'FORCE_REVISION' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    done: {
      type: 'terminal',
      outputs: ['code'],
    },
    aborted: {
      type: 'terminal',
    },
  },
};

/** Agent state with parallelKey */
const parallelDefinition: WorkflowDefinition = {
  name: 'parallel-test',
  description: 'Workflow with parallel key',
  initial: 'plan',
  states: {
    plan: {
      type: 'agent',
      persona: 'planner',
      inputs: [],
      outputs: ['spec'],
      transitions: [{ to: 'implement' }],
    },
    implement: {
      type: 'agent',
      persona: 'coder',
      inputs: ['spec'],
      outputs: ['code'],
      transitions: [{ to: 'done' }],
      parallelKey: 'spec.modules',
      worktree: true,
    },
    done: {
      type: 'terminal',
      outputs: ['spec', 'code'],
    },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildWorkflowMachine', () => {
  describe('basic machine building', () => {
    it('builds a machine from a simple linear definition', () => {
      const result = buildWorkflowMachine(linearDefinition, 'Build something');

      expect(result.machine).toBeDefined();
      expect(result.gateStateNames.size).toBe(0);
      expect(result.terminalStateNames).toEqual(new Set(['done']));
    });

    it('identifies human gate state names', () => {
      const result = buildWorkflowMachine(gatedDefinition, 'task');

      expect(result.gateStateNames).toEqual(new Set(['review_gate']));
      expect(result.terminalStateNames).toEqual(new Set(['done', 'aborted']));
    });

    it('identifies multiple terminal state names', () => {
      const result = buildWorkflowMachine(coderCriticDefinition, 'task');

      expect(result.terminalStateNames).toEqual(new Set(['done', 'aborted']));
      expect(result.gateStateNames).toEqual(new Set(['escalate_gate']));
    });
  });

  describe('createInitialContext', () => {
    it('creates context with default maxRounds', () => {
      const ctx = createInitialContext(linearDefinition);

      expect(ctx.round).toBe(0);
      expect(ctx.maxRounds).toBe(4);
      expect(ctx.artifacts).toEqual({});
      expect(ctx.previousOutputHashes).toEqual({});
      expect(ctx.previousTestCount).toBeNull();
      expect(ctx.humanPrompt).toBeNull();
      expect(ctx.reviewHistory).toEqual([]);
      expect(ctx.parallelResults).toEqual({});
      expect(ctx.worktreeBranches).toEqual([]);
      expect(ctx.totalTokens).toBe(0);
      expect(ctx.flaggedForReview).toBe(false);
      expect(ctx.lastError).toBeNull();
      expect(ctx.sessionsByRole).toEqual({});
    });

    it('uses settings maxRounds when provided', () => {
      const ctx = createInitialContext(coderCriticDefinition);
      expect(ctx.maxRounds).toBe(3);
    });
  });

  describe('linear workflow transitions', () => {
    it('transitions plan -> design -> done with approved agent', async () => {
      const result = buildWorkflowMachine(linearDefinition, 'Build it');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            return makeAgentResult({
              artifacts: { [input.stateId]: `/tmp/${input.stateId}` },
            });
          }),
        },
      });

      const actor = createActor(testMachine);
      const visited = trackStates(actor);
      actor.start();

      await settle();

      expect(visited).toContain('plan');
      expect(visited).toContain('design');
      expect(visited).toContain('done');
      expect(actor.getSnapshot().status).toBe('done');
    });

    it('bakes taskDescription into initial context', async () => {
      const result = buildWorkflowMachine(linearDefinition, 'My specific task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            // Verify taskDescription is in the context passed to the service
            expect(input.context.taskDescription).toBe('My specific task');
            return makeAgentResult();
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();
      await settle();

      expect(actor.getSnapshot().context.taskDescription).toBe('My specific task');
    });
  });

  describe('human gate states', () => {
    it('pauses at human gate until HUMAN_APPROVE is sent', async () => {
      const result = buildWorkflowMachine(gatedDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => makeAgentResult()),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      // Wait for plan to complete -> enters gate
      await settle();
      expect(actor.getSnapshot().matches('review_gate')).toBe(true);

      // Send human approval
      actor.send({ type: 'HUMAN_APPROVE' });
      await settle();

      // Should advance to design, then done
      expect(actor.getSnapshot().status).toBe('done');
    });

    it('routes HUMAN_FORCE_REVISION back to plan', async () => {
      const result = buildWorkflowMachine(gatedDefinition, 'task');
      let callCount = 0;

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => {
            callCount++;
            return makeAgentResult();
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();
      expect(actor.getSnapshot().matches('review_gate')).toBe(true);
      expect(callCount).toBe(1);

      // Force revision -> back to plan
      actor.send({ type: 'HUMAN_FORCE_REVISION' });
      await settle();

      // Plan should have been invoked again
      expect(callCount).toBe(2);
      expect(actor.getSnapshot().matches('review_gate')).toBe(true);
    });

    it('routes HUMAN_ABORT to aborted terminal', async () => {
      const result = buildWorkflowMachine(gatedDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => makeAgentResult()),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();
      expect(actor.getSnapshot().matches('review_gate')).toBe(true);

      actor.send({ type: 'HUMAN_ABORT' });
      await settle();

      expect(actor.getSnapshot().matches('aborted')).toBe(true);
      expect(actor.getSnapshot().status).toBe('done');
    });

    it('stores humanPrompt from gate events', async () => {
      const result = buildWorkflowMachine(gatedDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => makeAgentResult()),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();
      actor.send({ type: 'HUMAN_APPROVE', prompt: 'Looks good, proceed' });
      await settle();

      expect(actor.getSnapshot().context.humanPrompt).toBe('Looks good, proceed');
    });
  });

  describe('guard evaluation', () => {
    it('routes via isApproved guard on approved verdict', async () => {
      const result = buildWorkflowMachine(coderCriticDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            if (input.stateId === 'review') {
              return makeAgentResult(); // approved
            }
            return makeAgentResult();
          }),
        },
      });

      const actor = createActor(testMachine);
      const visited = trackStates(actor);
      actor.start();

      await settle();

      expect(visited).toContain('implement');
      expect(visited).toContain('review');
      expect(visited).toContain('done');
      expect(actor.getSnapshot().status).toBe('done');
    });

    it('routes via isRejected guard on rejected verdict', async () => {
      const result = buildWorkflowMachine(coderCriticDefinition, 'task');
      let reviewCount = 0;

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            if (input.stateId === 'review') {
              reviewCount++;
              // First review rejects, second approves
              if (reviewCount === 1) return makeRejectedResult();
              return makeAgentResult(); // approved
            }
            return makeAgentResult();
          }),
        },
      });

      const actor = createActor(testMachine);
      const visited = trackStates(actor);
      actor.start();

      await settle();

      // Should have looped: implement -> review(reject) -> implement -> review(approve) -> done
      expect(visited.filter((s) => s === 'implement').length).toBe(2);
      expect(visited.filter((s) => s === 'review').length).toBe(2);
      expect(actor.getSnapshot().status).toBe('done');
    });

    it('routes to escalation gate when round limit is reached', async () => {
      const result = buildWorkflowMachine(coderCriticDefinition, 'task');
      let reviewCount = 0;

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            if (input.stateId === 'review') {
              reviewCount++;
              // Always reject to exhaust rounds
              return makeRejectedResult(`rejection ${reviewCount}`);
            }
            return makeAgentResult();
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle(200);

      // With maxRounds=3, after 3 rounds the isRoundLimitReached guard fires
      // before isRejected can route back to implement
      expect(actor.getSnapshot().matches('escalate_gate')).toBe(true);
    });
  });

  describe('deterministic states', () => {
    it('routes to done when deterministic service passes', async () => {
      const result = buildWorkflowMachine(deterministicLoopDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => makeAgentResult()),
          deterministicService: fromPromise(async () => makeDeterministicResult({ passed: true })),
        },
      });

      const actor = createActor(testMachine);
      const visited = trackStates(actor);
      actor.start();

      await settle();

      expect(visited).toContain('test');
      expect(visited).toContain('done');
      expect(actor.getSnapshot().status).toBe('done');
    });

    it('loops back when deterministic service fails', async () => {
      const result = buildWorkflowMachine(deterministicLoopDefinition, 'task');
      let testCount = 0;

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => makeAgentResult()),
          deterministicService: fromPromise(async () => {
            testCount++;
            // Fail first time, pass second
            if (testCount === 1) return makeDeterministicResult({ passed: false, errors: 'test failed' });
            return makeDeterministicResult({ passed: true });
          }),
        },
      });

      const actor = createActor(testMachine);
      const visited = trackStates(actor);
      actor.start();

      await settle();

      // implement -> test(fail) -> implement -> test(pass) -> done
      expect(visited.filter((s) => s === 'test').length).toBe(2);
      expect(actor.getSnapshot().status).toBe('done');
    });

    it('passes commands and context to deterministic service', async () => {
      const result = buildWorkflowMachine(deterministicLoopDefinition, 'my task');
      let capturedInput: DeterministicInvokeInput | undefined;

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => makeAgentResult()),
          deterministicService: fromPromise(async ({ input }: { input: DeterministicInvokeInput }) => {
            capturedInput = input;
            return makeDeterministicResult({ passed: true });
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      expect(capturedInput).toBeDefined();
      expect(capturedInput!.stateId).toBe('test');
      expect(capturedInput!.commands).toEqual([['npm', 'test']]);
      expect(capturedInput!.context.taskDescription).toBe('my task');
    });
  });

  describe('context updates', () => {
    it('increments round on each agent completion', async () => {
      const result = buildWorkflowMachine(coderCriticDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            void input.context;
            if (input.stateId === 'review') return makeAgentResult(); // approve
            return makeAgentResult();
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      // After implement(round 0->1) and review(round 1->2), context should show round=2
      expect(actor.getSnapshot().context.round).toBe(2);
    });

    it('updates previousOutputHashes per state', async () => {
      const result = buildWorkflowMachine(linearDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            return makeAgentResult({ outputHash: `hash-${input.stateId}` });
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      const ctx = actor.getSnapshot().context;
      expect(ctx.previousOutputHashes['plan']).toBe('hash-plan');
      expect(ctx.previousOutputHashes['design']).toBe('hash-design');
    });

    it('stores artifacts from agent results', async () => {
      const result = buildWorkflowMachine(linearDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            return makeAgentResult({
              artifacts: { [input.stateId]: `/tmp/artifacts/${input.stateId}` },
            });
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      const ctx = actor.getSnapshot().context;
      expect(ctx.artifacts['plan']).toBe('/tmp/artifacts/plan');
      expect(ctx.artifacts['design']).toBe('/tmp/artifacts/design');
    });

    it('appends to reviewHistory on rejected verdict', async () => {
      const result = buildWorkflowMachine(coderCriticDefinition, 'task');
      let reviewCount = 0;

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            if (input.stateId === 'review') {
              reviewCount++;
              if (reviewCount === 1) return makeRejectedResult('issue found');
              return makeAgentResult(); // approve second time
            }
            return makeAgentResult();
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      expect(actor.getSnapshot().context.reviewHistory).toContain('issue found');
    });

    it('tracks sessionsByRole from agent results', async () => {
      const result = buildWorkflowMachine(linearDefinition, 'task');
      let sessionCounter = 0;

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => {
            sessionCounter++;
            return makeAgentResult({ sessionId: `session-${sessionCounter}` });
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      const ctx = actor.getSnapshot().context;
      expect(ctx.sessionsByRole['plan']).toBe('session-1');
      expect(ctx.sessionsByRole['design']).toBe('session-2');
    });

    it('updates previousTestCount from deterministic results', async () => {
      const result = buildWorkflowMachine(deterministicLoopDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => makeAgentResult()),
          deterministicService: fromPromise(async () => makeDeterministicResult({ passed: true, testCount: 42 })),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      expect(actor.getSnapshot().context.previousTestCount).toBe(42);
    });
  });

  describe('terminal states', () => {
    it('reaches final state and reports done status', async () => {
      const result = buildWorkflowMachine(linearDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => makeAgentResult()),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      expect(actor.getSnapshot().status).toBe('done');
    });

    it('terminal states are identified in terminalStateNames', () => {
      const result = buildWorkflowMachine(gatedDefinition, 'task');
      expect(result.terminalStateNames.has('done')).toBe(true);
      expect(result.terminalStateNames.has('aborted')).toBe(true);
      expect(result.terminalStateNames.has('plan')).toBe(false);
    });
  });

  describe('parallel key states', () => {
    it('passes parallelKey config to agent service input', async () => {
      const result = buildWorkflowMachine(parallelDefinition, 'task');
      let capturedInput: AgentInvokeInput | undefined;

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            if (input.stateId === 'implement') {
              capturedInput = input;
            }
            return makeAgentResult();
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      expect(capturedInput).toBeDefined();
      expect(capturedInput!.stateConfig.parallelKey).toBe('spec.modules');
      expect(capturedInput!.stateConfig.worktree).toBe(true);
    });
  });

  describe('error handling', () => {
    it('transitions to error target when agent service throws', async () => {
      const result = buildWorkflowMachine(linearDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            if (input.stateId === 'plan') {
              throw new Error('Agent crashed');
            }
            return makeAgentResult();
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      // Error target for plan state falls through to terminal 'done'
      const ctx = actor.getSnapshot().context;
      expect(ctx.lastError).toBe('Agent crashed');
      expect(actor.getSnapshot().status).toBe('done');
    });

    it('transitions to error target when deterministic service throws', async () => {
      const result = buildWorkflowMachine(deterministicLoopDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => makeAgentResult()),
          deterministicService: fromPromise(async () => {
            throw new Error('Command failed');
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      const ctx = actor.getSnapshot().context;
      expect(ctx.lastError).toBe('Command failed');
    });
  });

  describe('validation', () => {
    it('throws on invalid definition', () => {
      expect(() =>
        buildWorkflowMachine(
          {
            name: 'bad',
            description: 'bad workflow',
            initial: 'nonexistent',
            states: {},
          },
          'task',
        ),
      ).toThrow();
    });
  });
});
