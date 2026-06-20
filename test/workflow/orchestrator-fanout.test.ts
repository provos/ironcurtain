import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createActor, type AnyActorRef } from 'xstate';
import { MessageLog } from '../../src/workflow/message-log.js';
import {
  buildWorkflowMachine,
  type AgentInvokeInput,
  type AgentInvokeResult,
  type DeterministicInvokeInput,
  type DeterministicInvokeResult,
} from '../../src/workflow/machine-builder.js';
import type { WorkflowDefinition, WorkflowId } from '../../src/workflow/types.js';
import { WorkflowOrchestrator } from '../../src/workflow/orchestrator.js';
import { createDeps, createMockTab } from './test-helpers.js';
import { makeAgentResult, makeVerdictResult, settle } from './machine-test-helpers.js';

// ---------------------------------------------------------------------------
// Focused unit tests for the fan-out join path in WorkflowOrchestrator:
// runFanOutSegment / waitForRoundChild / joinFanOutBatch. These are the
// runnable proof of MUST-FIX #1 (child onError -> errored) and #2 (the
// evaluator_blocked reason surfaced from previousAgentOutput).
//
// We drive the REAL parent machine (built via buildWorkflowMachine and wired
// with the orchestrator's own provideActors), so the parent's
// orchestrator -> workers -> orchestrator loop, the child round machine, the
// barrier (waitForRoundChild), and the verdict fold (joinFanOutBatch) all run
// for real. Only the two LEAF executors (executeAgentState /
// executeDeterministicState) are stubbed via bracket access — the same focused
// seam orchestrator-deterministic.test.ts uses — so each test controls per-
// stateId verdicts and rejections without spinning up sessions or Docker.
// ---------------------------------------------------------------------------

const WF_ID = 'wf-fanout-test' as WorkflowId;

/** Parent orchestrator -> workers; child segment sample -> researcher -> evaluate -> analysis_record. */
const fanOutDefinition: WorkflowDefinition = {
  name: 'fanout-join-test',
  description: 'Fan-out workflow for join-path unit tests',
  initial: 'orchestrator',
  settings: { mode: 'builtin', workers: 1, maxRounds: 10 },
  states: {
    orchestrator: {
      type: 'agent',
      description: 'Chooses the next batch',
      persona: 'global',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: [],
      transitions: [{ to: 'workers', when: { verdict: 'design' } }, { to: 'done' }],
    },
    workers: {
      type: 'deterministic',
      description: 'Runs the child round',
      run: [],
      fanOut: { count: 'workers', join: 'barrier' },
      segment: ['sample', 'researcher', 'evaluate', 'analysis_record'],
      transitions: [
        { to: 'orchestrator', when: { verdict: 'recorded' } },
        { to: 'human_escalation', when: { verdict: 'evaluator_blocked' } },
        { to: 'failed', when: { verdict: 'result_file_error' } },
      ],
    },
    sample: {
      type: 'deterministic',
      description: 'Samples parents',
      run: [['sample']],
      fanOutMember: true,
      transitions: [{ to: 'researcher', when: { verdict: 'sampled' } }, { to: 'failed' }],
    },
    researcher: {
      type: 'agent',
      description: 'Writes a candidate',
      persona: 'global',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: [],
      fanOutMember: true,
      transitions: [{ to: 'evaluate' }],
    },
    evaluate: {
      type: 'deterministic',
      description: 'Evaluates candidate',
      run: [['evaluate']],
      fanOutMember: true,
      transitions: [
        { to: 'analysis_record', when: { verdict: 'evaluated' } },
        { to: 'human_escalation', when: { verdict: 'evaluator_blocked' } },
        { to: 'failed' },
      ],
    },
    analysis_record: {
      type: 'deterministic',
      description: 'Records candidate',
      run: [['record']],
      fanOutMember: true,
      transitions: [{ to: 'orchestrator', when: { verdict: 'recorded' } }, { to: 'failed' }],
    },
    human_escalation: {
      type: 'human_gate',
      description: 'Human review',
      acceptedEvents: ['APPROVE', 'ABORT'],
      transitions: [
        { to: 'orchestrator', event: 'APPROVE' },
        { to: 'failed', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    failed: { type: 'terminal', description: 'Failed' },
  },
};

type AgentStub = (input: AgentInvokeInput) => Promise<AgentInvokeResult>;
type DeterministicStub = (input: DeterministicInvokeInput) => Promise<DeterministicInvokeResult>;

// The real method signatures provideActors closes over: it calls
// `this.executeAgentState(workflowId, input, definition)` and
// `this.executeDeterministicState(workflowId, input)`. The override must match
// that arity so `input` lands in the right parameter position.
type ExecuteAgent = (id: WorkflowId, input: AgentInvokeInput, def: WorkflowDefinition) => Promise<AgentInvokeResult>;
type ExecuteDeterministic = (id: WorkflowId, input: DeterministicInvokeInput) => Promise<DeterministicInvokeResult>;

/**
 * Registers a synthetic instance with the real round machines, overrides the
 * two leaf executors with the supplied stubs, builds the parent actor via the
 * orchestrator's own provideActors, and tracks every parent state value the
 * actor enters. Returns the actor plus the ordered visit list.
 */
function driveParent(
  orchestrator: WorkflowOrchestrator,
  tmpDir: string,
  agentStub: AgentStub,
  deterministicStub: DeterministicStub,
  definition: WorkflowDefinition = fanOutDefinition,
): { actor: AnyActorRef; visited: string[] } {
  const { machine, roundMachinesByState, gateStateNames, terminalStateNames } = buildWorkflowMachine(
    definition,
    'task',
  );

  const instance = {
    id: WF_ID,
    definition,
    definitionPath: join(tmpDir, 'workflow.yaml'),
    workflowSkillsDir: undefined,
    workflowScriptsDir: undefined,
    containerSnapshots: undefined,
    roundMachinesByState,
    gateStateNames,
    terminalStateNames,
    activeSessions: new Set(),
    artifactDir: join(tmpDir, '.workflow'),
    workspacePath: tmpDir,
    tab: createMockTab(),
    transitionHistory: [],
    currentState: 'orchestrator',
    messageLog: new MessageLog(join(tmpDir, 'messages.jsonl')),
    bundlesByScope: new Map(),
    policyDirByPersona: new Map(),
    currentPersonaByBundle: new Map(),
    mintedServersByBundle: new Map(),
    aborted: false,
    tokens: { outputTokens: 0, sessionIds: new Set() },
  } as Record<string, unknown> & { actor?: AnyActorRef; currentState: string };
  const internal = orchestrator as unknown as {
    workflows: Map<WorkflowId, unknown>;
    executeAgentState: ExecuteAgent;
    executeDeterministicState: ExecuteDeterministic;
    provideActors: (
      machine: unknown,
      id: WorkflowId,
      def: WorkflowDefinition,
      rounds: ReadonlyMap<string, unknown>,
    ) => unknown;
  };
  internal.workflows.set(WF_ID, instance);
  // Override the leaf executors so the child round machine resolves verdicts
  // from the stubs. provideActors closes over `this.executeAgentState` /
  // `this.executeDeterministicState`, so replacing the methods here redirects
  // every lane's invoke to the stub. `input` is the SECOND argument in both.
  internal.executeAgentState = (_id, input) => agentStub(input);
  internal.executeDeterministicState = (_id, input) => deterministicStub(input);

  const provided = internal.provideActors(machine, WF_ID, definition, roundMachinesByState);
  const actor = createActor(provided as Parameters<typeof createActor>[0]);
  instance.actor = actor as AnyActorRef;
  const visited: string[] = [];
  actor.subscribe((snap) => {
    const value = String((snap as { value: unknown }).value);
    instance.currentState = value;
    visited.push(value);
  });
  actor.start();
  return { actor: actor as AnyActorRef, visited };
}

/** Maps the child segment's stateIds to deterministic verdicts for the happy path. */
const recordedDeterministicStub: DeterministicStub = async (input) => {
  const verdicts: Record<string, string> = {
    sample: 'sampled',
    evaluate: 'evaluated',
    analysis_record: 'recorded',
  };
  return { passed: true, testCount: 10, verdict: verdicts[input.stateId] };
};

describe('WorkflowOrchestrator fan-out join path', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fanout-join-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(a)+(d) a recorded child re-enters orchestrator exactly once per round', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

    // orchestrator returns `design` on its first turn (fan out), then anything
    // else (-> `done`) on the second so the run terminates after one batch.
    let orchestratorTurn = 0;
    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') {
        orchestratorTurn += 1;
        return makeVerdictResult(orchestratorTurn === 1 ? 'design' : 'finished');
      }
      return makeAgentResult(); // researcher
    };

    const { actor, visited } = driveParent(orchestrator, tmpDir, agentStub, recordedDeterministicStub);
    await settle();

    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().value).toBe('done');

    // The parent enters `orchestrator` exactly twice across one round: the
    // initial fan-out decision, and the re-entry after the batch recorded. The
    // parent stays at `workers` for the whole batch (single-active-state spine),
    // so `workers` appears once, never the child segment stateIds.
    expect(visited.filter((v) => v === 'orchestrator')).toHaveLength(2);
    expect(visited.filter((v) => v === 'workers')).toHaveLength(1);
    expect(visited).not.toContain('sample');
    expect(visited).not.toContain('researcher');
  });

  it('runs three recorded lanes as three child rounds and joins once at the parent', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    const parallelDefinition: WorkflowDefinition = {
      ...fanOutDefinition,
      settings: { ...fanOutDefinition.settings, workers: 3 },
    };

    let orchestratorTurn = 0;
    let reenteredOrchestratorTokens: number | undefined;
    const researcherLaneIds: number[] = [];
    const deterministicCalls: Array<{ stateId: string; laneId: number | undefined }> = [];
    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') {
        orchestratorTurn += 1;
        if (orchestratorTurn === 2) {
          reenteredOrchestratorTokens = input.context.totalTokens;
        }
        return makeVerdictResult(orchestratorTurn === 1 ? 'design' : 'finished');
      }
      researcherLaneIds.push(input.context.lane?.id ?? -1);
      const internal = orchestrator as unknown as {
        workflows: Map<WorkflowId, { tokens: { outputTokens: number } }>;
      };
      const instance = internal.workflows.get(WF_ID);
      if (!instance) throw new Error('fan-out test instance missing');
      instance.tokens.outputTokens += 11;
      return makeAgentResult({
        outputHash: `researcher-${input.context.lane?.id ?? 'none'}`,
        totalTokens: instance.tokens.outputTokens,
      });
    };
    const deterministicStub: DeterministicStub = async (input) => {
      deterministicCalls.push({ stateId: input.stateId, laneId: input.context.lane?.id });
      return recordedDeterministicStub(input);
    };

    const { actor, visited } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub, parallelDefinition);
    await settle();

    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().value).toBe('done');
    expect(visited.filter((v) => v === 'orchestrator')).toHaveLength(2);
    expect(visited.filter((v) => v === 'workers')).toHaveLength(1);
    expect(reenteredOrchestratorTokens).toBe(33);
    expect(researcherLaneIds.sort()).toEqual([0, 1, 2]);
    expect(
      deterministicCalls
        .filter((call) => call.stateId === 'sample')
        .map((call) => call.laneId)
        .sort(),
    ).toEqual([0, 1, 2]);
    expect(
      deterministicCalls
        .filter((call) => call.stateId === 'evaluate')
        .map((call) => call.laneId)
        .sort(),
    ).toEqual([0, 1, 2]);
    expect(
      deterministicCalls
        .filter((call) => call.stateId === 'analysis_record')
        .map((call) => call.laneId)
        .sort(),
    ).toEqual([0, 1, 2]);

    const log = readFileSync(join(tmpDir, 'messages.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; workers?: number; children?: unknown[] });
    expect(log.find((entry) => entry.type === 'fanout_join')).toMatchObject({
      workers: 3,
      children: [
        { index: 0, status: 'recorded' },
        { index: 1, status: 'recorded' },
        { index: 2, status: 'recorded' },
      ],
    });
  });

  it('(b) a blocked child routes the parent to human_escalation with the reason surfaced', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

    const agentStub: AgentStub = async (input) =>
      input.stateId === 'orchestrator' ? makeVerdictResult('design') : makeAgentResult();
    const deterministicStub: DeterministicStub = async (input) => {
      if (input.stateId === 'sample') return { passed: true, verdict: 'sampled' };
      if (input.stateId === 'evaluate') {
        return { passed: false, verdict: 'evaluator_blocked', errors: 'evaluator needs credentials' };
      }
      return { passed: true, verdict: 'recorded' };
    };

    const { actor } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub);
    await settle();

    // Parent waits at the human gate; the gate is a non-final state.
    expect(actor.getSnapshot().value).toBe('human_escalation');
    expect(actor.getSnapshot().status).toBe('active');
    // MUST-FIX #2: evaluator_blocked writes the reason to previousAgentOutput,
    // and joinFanOutBatch surfaces it (lastError stays null on the block path).
    expect(actor.getSnapshot().context.previousAgentOutput).toBe('evaluator needs credentials');
  });

  it('(c) a thrown agent service drives the lane to errored and the parent to failed', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') return makeVerdictResult('design');
      throw new Error('researcher crashed'); // the lane's agent rejects
    };

    const { actor } = driveParent(orchestrator, tmpDir, agentStub, recordedDeterministicStub);
    await settle();

    // Without the child onError -> errored fix, the crashed lane would land in
    // `recorded`, the batch verdict would be `recorded`, and the parent would
    // re-enter `orchestrator` (then `done`) instead of `failed`. This is the
    // runnable discrimination test for MUST-FIX #1.
    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().context.lastError).toBe('researcher crashed');
  });

  it('(c2) a thrown deterministic service also drives the parent to failed', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

    const agentStub: AgentStub = async (input) =>
      input.stateId === 'orchestrator' ? makeVerdictResult('design') : makeAgentResult();
    const deterministicStub: DeterministicStub = async (input) => {
      if (input.stateId === 'sample') return { passed: true, verdict: 'sampled' };
      throw new Error('evaluate harness crashed'); // the lane's evaluate rejects
    };

    const { actor } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub);
    await settle();

    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().context.lastError).toBe('evaluate harness crashed');
  });
});
