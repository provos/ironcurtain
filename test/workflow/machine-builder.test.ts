import { describe, it, expect } from 'vitest';
import { createActor, fromPromise, type AnyActor } from 'xstate';
import {
  buildWorkflowMachine,
  createInitialContext,
  truncateAgentOutput,
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
    responseText: 'Agent response text',
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
      description: 'Creates a plan',
      persona: 'planner',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'design' }],
    },
    design: {
      type: 'agent',
      description: 'Creates a design',
      persona: 'architect',
      prompt: 'You are an architect.',
      inputs: ['plan'],
      outputs: ['design'],
      transitions: [{ to: 'done' }],
    },
    done: {
      type: 'terminal',
      description: 'Done',
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
      description: 'Creates a plan',
      persona: 'planner',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'review_gate' }],
    },
    review_gate: {
      type: 'human_gate',
      description: 'Human review gate',
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
      description: 'Creates a design',
      persona: 'architect',
      prompt: 'You are an architect.',
      inputs: ['plan'],
      outputs: ['design'],
      transitions: [{ to: 'done' }],
    },
    done: {
      type: 'terminal',
      description: 'Done',
      outputs: ['plan', 'design'],
    },
    aborted: {
      type: 'terminal',
      description: 'Aborted',
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
      description: 'Creates a plan',
      persona: 'planner',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'implement' }],
    },
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: ['plan'],
      outputs: ['code'],
      transitions: [{ to: 'test' }],
    },
    test: {
      type: 'deterministic',
      description: 'Runs tests',
      run: [['npm', 'test']],
      transitions: [{ to: 'done', guard: 'isPassed' }, { to: 'implement' }],
    },
    done: {
      type: 'terminal',
      description: 'Done',
      outputs: ['plan', 'code'],
    },
  },
};

/** Coder -> critic loop using `when` clauses instead of named guards */
const coderCriticWhenDefinition: WorkflowDefinition = {
  name: 'coder-critic-when-test',
  description: 'Workflow with coder-critic loop using when clauses',
  initial: 'implement',
  settings: { maxRounds: 3 },
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
      persona: 'critic',
      prompt: 'You are a critic.',
      inputs: ['code'],
      outputs: ['review'],
      transitions: [
        { to: 'done', when: { verdict: 'approved' } },
        { to: 'escalate_gate', guard: 'isRoundLimitReached' },
        { to: 'implement', when: { verdict: 'rejected' } },
        { to: 'escalate_gate' },
      ],
    },
    escalate_gate: {
      type: 'human_gate',
      description: 'Human escalation gate',
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
      description: 'Done',
      outputs: ['code'],
    },
    aborted: {
      type: 'terminal',
      description: 'Aborted',
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
      persona: 'critic',
      prompt: 'You are a critic.',
      inputs: ['code'],
      outputs: ['review'],
      transitions: [
        { to: 'done', when: { verdict: 'approved' } },
        { to: 'escalate_gate', guard: 'isRoundLimitReached' },
        { to: 'implement', when: { verdict: 'rejected' } },
        { to: 'escalate_gate' },
      ],
    },
    escalate_gate: {
      type: 'human_gate',
      description: 'Human escalation gate',
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
      description: 'Done',
      outputs: ['code'],
    },
    aborted: {
      type: 'terminal',
      description: 'Aborted',
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
      description: 'Creates a plan',
      persona: 'planner',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: ['spec'],
      transitions: [{ to: 'implement' }],
    },
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: ['spec'],
      outputs: ['code'],
      transitions: [{ to: 'done' }],
      parallelKey: 'spec.modules',
      worktree: true,
    },
    done: {
      type: 'terminal',
      description: 'Done',
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
      expect(ctx.sessionsByState).toEqual({});
      expect(ctx.previousAgentOutput).toBeNull();
      expect(ctx.previousStateName).toBeNull();
      expect(ctx.visitCounts).toEqual({});
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

    it('stores humanPrompt from gate events and clears it after agent runs', async () => {
      const result = buildWorkflowMachine(gatedDefinition, 'task');
      let capturedHumanPrompt: string | null = null;

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            // Capture the humanPrompt that the agent receives
            if (input.stateId === 'design') {
              capturedHumanPrompt = input.context.humanPrompt;
            }
            return makeAgentResult();
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();
      actor.send({ type: 'HUMAN_APPROVE', prompt: 'Looks good, proceed' });
      await settle();

      // The design agent should have received the human prompt
      expect(capturedHumanPrompt).toBe('Looks good, proceed');
      // After the agent runs, humanPrompt is cleared
      expect(actor.getSnapshot().context.humanPrompt).toBeNull();
    });
  });

  describe('when clause evaluation', () => {
    it('routes via when clause on approved verdict', async () => {
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

    it('routes via when clause on rejected verdict', async () => {
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
      // before the rejected when clause can route back to implement
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

    it('tracks sessionsByState from agent results', async () => {
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
      expect(ctx.sessionsByState['plan']).toBe('session-1');
      expect(ctx.sessionsByState['design']).toBe('session-2');
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

    it('stores previousAgentOutput (truncated) and previousStateName from agent results', async () => {
      const result = buildWorkflowMachine(linearDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            return makeAgentResult({
              responseText: `Response from ${input.stateId}`,
            });
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      const ctx = actor.getSnapshot().context;
      // After plan -> design -> done, the last agent was "design"
      expect(ctx.previousAgentOutput).toBe('Response from design');
      expect(ctx.previousStateName).toBe('design');
    });

    it('increments visitCounts per state on each agent completion', async () => {
      const result = buildWorkflowMachine(coderCriticDefinition, 'task');
      let reviewCount = 0;

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            if (input.stateId === 'review') {
              reviewCount++;
              if (reviewCount === 1) return makeRejectedResult('needs work');
              return makeAgentResult(); // approve second time
            }
            return makeAgentResult();
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      const ctx = actor.getSnapshot().context;
      // implement ran twice (initial + after rejection), review ran twice
      expect(ctx.visitCounts['implement']).toBe(2);
      expect(ctx.visitCounts['review']).toBe(2);
    });

    it('clears humanPrompt after agent completion', async () => {
      const result = buildWorkflowMachine(gatedDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => makeAgentResult()),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();
      // At gate, send FORCE_REVISION with feedback
      actor.send({ type: 'HUMAN_FORCE_REVISION', prompt: 'Fix the plan' });
      await settle();

      // After the agent runs again, humanPrompt should be cleared
      expect(actor.getSnapshot().context.humanPrompt).toBeNull();
    });
  });

  describe('truncateAgentOutput', () => {
    it('returns short text unchanged', () => {
      expect(truncateAgentOutput('hello')).toBe('hello');
    });

    it('returns empty string unchanged', () => {
      expect(truncateAgentOutput('')).toBe('');
    });

    it('returns text exactly at 32KB limit unchanged', () => {
      const text = 'a'.repeat(32_768);
      expect(truncateAgentOutput(text)).toBe(text);
    });

    it('truncates text exceeding 32KB and appends notice', () => {
      const text = 'a'.repeat(40_000);
      const result = truncateAgentOutput(text);

      expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(32_768);
      expect(result).toContain('[Output truncated. Read the artifact directories for full details.]');
      expect(result.length).toBeLessThan(text.length);
    });

    it('handles multi-byte characters gracefully', () => {
      // Each emoji is 4 bytes in UTF-8
      const text = '\u{1F600}'.repeat(10_000); // 40,000 bytes
      const result = truncateAgentOutput(text);

      expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(32_768);
      expect(result).toContain('[Output truncated');
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

  describe('when clause guard evaluation', () => {
    it('routes via when: { verdict: "approved" } on approved output', async () => {
      const result = buildWorkflowMachine(coderCriticWhenDefinition, 'task');

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

    it('routes via when: { verdict: "rejected" } on rejected output', async () => {
      const result = buildWorkflowMachine(coderCriticWhenDefinition, 'task');
      let reviewCount = 0;

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            if (input.stateId === 'review') {
              reviewCount++;
              if (reviewCount === 1) return makeRejectedResult();
              return makeAgentResult(); // approve second time
            }
            return makeAgentResult();
          }),
        },
      });

      const actor = createActor(testMachine);
      const visited = trackStates(actor);
      actor.start();

      await settle();

      // implement -> review(reject) -> implement -> review(approve) -> done
      expect(visited.filter((s) => s === 'implement').length).toBe(2);
      expect(visited.filter((s) => s === 'review').length).toBe(2);
      expect(actor.getSnapshot().status).toBe('done');
    });

    it('multi-field when requires all fields to match', async () => {
      // Build a definition where done requires both approved + high confidence
      const multiFieldDef: WorkflowDefinition = {
        name: 'multi-field-when-test',
        description: 'Test multi-field when',
        initial: 'implement',
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
            persona: 'critic',
            prompt: 'You are a critic.',
            inputs: ['code'],
            outputs: ['review'],
            transitions: [
              { to: 'done', when: { verdict: 'approved', confidence: 'high' } },
              { to: 'escalate_gate' }, // fallthrough
            ],
          },
          escalate_gate: {
            type: 'human_gate',
            description: 'Human escalation gate',
            acceptedEvents: ['APPROVE', 'ABORT'],
            transitions: [
              { to: 'done', event: 'APPROVE' },
              { to: 'aborted', event: 'ABORT' },
            ],
          },
          done: { type: 'terminal', description: 'Done' },
          aborted: { type: 'terminal', description: 'Aborted' },
        },
      };

      const result = buildWorkflowMachine(multiFieldDef, 'task');

      // Agent returns approved but LOW confidence -- should NOT match the when
      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            if (input.stateId === 'review') {
              return makeAgentResult({
                output: {
                  completed: true,
                  verdict: 'approved',
                  confidence: 'low', // does not match "high"
                  escalation: null,
                  testCount: null,
                  notes: null,
                },
              });
            }
            return makeAgentResult();
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      // Should fall through to escalate_gate, not done
      expect(actor.getSnapshot().matches('escalate_gate')).toBe(true);
    });

    it('when falls through on non-match to unconditional transition', async () => {
      // Agent returns "blocked" -- neither approved nor rejected when matches
      const result = buildWorkflowMachine(coderCriticWhenDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
            if (input.stateId === 'review') {
              return makeAgentResult({
                output: {
                  completed: true,
                  verdict: 'blocked',
                  confidence: 'high',
                  escalation: null,
                  testCount: null,
                  notes: null,
                },
              });
            }
            return makeAgentResult();
          }),
        },
      });

      const actor = createActor(testMachine);
      actor.start();

      await settle();

      // Neither when clause matches, isRoundLimitReached is false (round 0),
      // so falls through to the unconditional escalate_gate transition
      expect(actor.getSnapshot().matches('escalate_gate')).toBe(true);
    });

    it('when with null value matches null field', async () => {
      const nullMatchDef: WorkflowDefinition = {
        name: 'null-when-test',
        description: 'Test null matching',
        initial: 'agent',
        states: {
          agent: {
            type: 'agent',
            description: 'Does work',
            persona: 'worker',
            prompt: 'Do work.',
            inputs: [],
            outputs: ['result'],
            transitions: [{ to: 'done', when: { escalation: null } }, { to: 'escalated' }],
          },
          done: { type: 'terminal', description: 'Done' },
          escalated: { type: 'terminal', description: 'Escalated' },
        },
      };

      // Test that null matches null
      const result1 = buildWorkflowMachine(nullMatchDef, 'task');
      const machine1 = result1.machine.provide({
        actors: {
          agentService: fromPromise(async () =>
            makeAgentResult({
              output: {
                completed: true,
                verdict: 'approved',
                confidence: 'high',
                escalation: null, // matches when: { escalation: null }
                testCount: null,
                notes: null,
              },
            }),
          ),
        },
      });
      const actor1 = createActor(machine1);
      actor1.start();
      await settle();
      expect(actor1.getSnapshot().matches('done')).toBe(true);

      // Test that non-null does NOT match null
      const result2 = buildWorkflowMachine(nullMatchDef, 'task');
      const machine2 = result2.machine.provide({
        actors: {
          agentService: fromPromise(async () =>
            makeAgentResult({
              output: {
                completed: true,
                verdict: 'approved',
                confidence: 'high',
                escalation: 'needs human review', // does NOT match when: { escalation: null }
                testCount: null,
                notes: null,
              },
            }),
          ),
        },
      });
      const actor2 = createActor(machine2);
      actor2.start();
      await settle();
      expect(actor2.getSnapshot().matches('escalated')).toBe(true);
    });

    it('when coexists with guard on different transitions', async () => {
      // coderCriticWhenDefinition already has when + isRoundLimitReached guard
      const result = buildWorkflowMachine(coderCriticWhenDefinition, 'task');
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

      // With maxRounds=3, the guard isRoundLimitReached fires
      expect(actor.getSnapshot().matches('escalate_gate')).toBe(true);
    });

    it('when preserves flag behavior', async () => {
      const flagDef: WorkflowDefinition = {
        name: 'flag-when-test',
        description: 'Test flag with when',
        initial: 'review',
        states: {
          review: {
            type: 'agent',
            description: 'Reviews code',
            persona: 'critic',
            prompt: 'Review.',
            inputs: [],
            outputs: ['review'],
            transitions: [{ to: 'done', when: { verdict: 'approved' }, flag: 'low confidence approval' }],
          },
          done: { type: 'terminal', description: 'Done' },
        },
      };

      const result = buildWorkflowMachine(flagDef, 'task');
      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => makeAgentResult()),
        },
      });

      const actor = createActor(testMachine);
      actor.start();
      await settle();

      expect(actor.getSnapshot().context.flaggedForReview).toBe(true);
      expect(actor.getSnapshot().status).toBe('done');
    });

    it('when: { completed: false } matches falsy boolean', async () => {
      const boolDef: WorkflowDefinition = {
        name: 'bool-when-test',
        description: 'Test boolean false matching',
        initial: 'agent',
        states: {
          agent: {
            type: 'agent',
            description: 'Does work',
            persona: 'worker',
            prompt: 'Do work.',
            inputs: [],
            outputs: ['result'],
            transitions: [{ to: 'retry', when: { completed: false } }, { to: 'done' }],
          },
          retry: { type: 'terminal', description: 'Retry' },
          done: { type: 'terminal', description: 'Done' },
        },
      };

      const result = buildWorkflowMachine(boolDef, 'task');
      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () =>
            makeAgentResult({
              output: {
                completed: false, // falsy but should match false exactly
                verdict: 'approved',
                confidence: 'high',
                escalation: null,
                testCount: null,
                notes: null,
              },
            }),
          ),
        },
      });

      const actor = createActor(testMachine);
      actor.start();
      await settle();

      // Should match when: { completed: false }, not fall through to done
      expect(actor.getSnapshot().matches('retry')).toBe(true);
    });

    it('transition without when or guard fires unconditionally (existing behavior)', async () => {
      const result = buildWorkflowMachine(linearDefinition, 'task');

      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => makeAgentResult()),
        },
      });

      const actor = createActor(testMachine);
      const visited = trackStates(actor);
      actor.start();

      await settle();

      // Linear definition has no guards or when -- transitions fire unconditionally
      expect(visited).toContain('plan');
      expect(visited).toContain('design');
      expect(visited).toContain('done');
      expect(actor.getSnapshot().status).toBe('done');
    });

    it('empty when object fails closed (defensive: bypasses validation)', async () => {
      // Normally validation rejects empty `when: {}`. This test passes an
      // unvalidated definition directly to buildWorkflowMachine to verify
      // the guard's defensive check falls through rather than silently
      // matching (vacuous `every` over empty would otherwise return true).
      const bypassDef: WorkflowDefinition = {
        name: 'empty-when-test',
        description: 'Bypasses validation with empty when',
        initial: 'agent',
        states: {
          agent: {
            type: 'agent',
            description: 'Does work',
            persona: 'worker',
            prompt: 'Do work.',
            inputs: [],
            outputs: ['result'],
            transitions: [
              // Empty when -- defensive check must reject this
              { to: 'should_not_reach', when: {} },
              // Unconditional fallthrough
              { to: 'safe_done' },
            ],
          },
          should_not_reach: { type: 'terminal', description: 'Should not reach' },
          safe_done: { type: 'terminal', description: 'Safe done' },
        },
      };

      const result = buildWorkflowMachine(bypassDef, 'task');
      const testMachine = result.machine.provide({
        actors: {
          agentService: fromPromise(async () => makeAgentResult()),
        },
      });

      const actor = createActor(testMachine);
      actor.start();
      await settle();

      // Guard must fail closed on empty when, falling through to safe_done
      expect(actor.getSnapshot().matches('safe_done')).toBe(true);
      expect(actor.getSnapshot().matches('should_not_reach')).toBe(false);
    });
  });
});
