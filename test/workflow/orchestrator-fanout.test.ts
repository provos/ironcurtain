import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
        { to: 'human_escalation', when: { verdict: 'escalate' } },
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
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };

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
    subscribeToActor: (instance: unknown) => void;
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
  internal.subscribeToActor(instance);
  const visited: string[] = [];
  actor.subscribe((snap) => {
    const value = String((snap as { value: unknown }).value);
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

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

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

  it('promotes cognition and computes the canonical stop_signals exactly once at the barrier for a workers:3 batch', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    // A sample state whose run carries a real evolve_result.py command, so the
    // orchestrator drives the barrier-side sample_batch, promote_cognition, and
    // compute_stop_signals through executeDeterministicState (the bare commands
    // in fanOutDefinition are not recognized as evolve commands, so none fire).
    const sampleCommand = [
      '/opt/workflow-venv/bin/python',
      '/workflow-scripts/evolve_result.py',
      'sample',
      '--run-dir',
      '/workspace/.evolve_runs/main',
      '--query-from-spec',
      '--context-file',
      '/workspace/.evolve_runs/main/current/context.json',
      '--result-file',
      '/workspace/.evolve_runs/main/current/sample.json',
    ];
    const attachCommand = [
      '/opt/workflow-venv/bin/python',
      '/workflow-scripts/evolve_result.py',
      'attach_analysis',
      '--run-dir',
      '/workspace/.evolve_runs/main',
      '--step-from-current',
      '--analysis-file',
      '/workspace/.evolve_runs/main/current/analysis.md',
      '--result-file',
      '/workspace/.evolve_runs/main/current/analysis_record.json',
    ];
    const evolveDefinition: WorkflowDefinition = {
      ...fanOutDefinition,
      settings: { ...fanOutDefinition.settings, workers: 3 },
      states: {
        ...fanOutDefinition.states,
        sample: { ...fanOutDefinition.states.sample, run: [sampleCommand] },
        analysis_record: { ...fanOutDefinition.states.analysis_record, run: [attachCommand] },
      },
    };

    let orchestratorTurn = 0;
    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') {
        orchestratorTurn += 1;
        return makeVerdictResult(orchestratorTurn === 1 ? 'design' : 'finished');
      }
      return makeAgentResult();
    };

    const stopSignalsCalls: DeterministicInvokeInput[] = [];
    const promotionCalls: DeterministicInvokeInput[] = [];
    const sampleBatchCalls: DeterministicInvokeInput[] = [];
    const barrierOrder: string[] = [];
    const deterministicStub: DeterministicStub = async (input) => {
      if (input.stateId === 'sample_batch') {
        barrierOrder.push(input.stateId);
        sampleBatchCalls.push(input);
        // Return one prepared lane payload per worker so prepareFanOutLaneResults
        // can hand each child its sample result.
        return {
          passed: true,
          verdict: 'sample_batch_prepared',
          payload: { lanes: [0, 1, 2].map((lane) => ({ lane, step_name: `step_0001_lane_${lane}` })) },
        };
      }
      if (input.stateId === 'analysis_record_promote_cognition') {
        barrierOrder.push(input.stateId);
        promotionCalls.push(input);
        return {
          passed: true,
          verdict: 'cognition_promoted',
          payload: { promoted_count: 3, duplicate_count: 0 },
        };
      }
      if (input.stateId === 'sample_stop_signals') {
        barrierOrder.push(input.stateId);
        stopSignalsCalls.push(input);
        return { passed: true, verdict: 'stop_signals_computed', payload: { stop_reason: null } };
      }
      return recordedDeterministicStub(input);
    };

    const { actor } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub, evolveDefinition);
    await settle();

    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().value).toBe('done');
    // Cognition promotion is barrier-owned: exactly ONE promote_cognition call
    // over all recorded lanes, before the single stop_signals recompute.
    expect(promotionCalls).toHaveLength(1);
    expect(promotionCalls[0].commands[0]).toEqual(
      expect.arrayContaining([
        'promote_cognition',
        '--run-dir',
        '/workspace/.evolve_runs/main',
        '--lane',
        '0',
        '--lane',
        '1',
        '--lane',
        '2',
      ]),
    );
    expect(promotionCalls[0].resultFile).toBe('.evolve_runs/main/current/cognition_promotion.json');
    // The barrier owns the canonical stop_signals: exactly ONE compute per batch,
    // not one per lane.
    expect(stopSignalsCalls).toHaveLength(1);
    expect(stopSignalsCalls[0].commands[0]).toEqual(
      expect.arrayContaining(['compute_stop_signals', '--run-dir', '/workspace/.evolve_runs/main']),
    );
    // And the canonical file is the bare current/stop_signals.json the
    // orchestrator routes on (no lane_ segment), written once.
    expect(stopSignalsCalls[0].resultFile).not.toContain('lane_');
    // The single barrier-side sample_batch fired once (not one sample per lane).
    expect(sampleBatchCalls).toHaveLength(1);
    expect(barrierOrder).toEqual(['sample_batch', 'analysis_record_promote_cognition', 'sample_stop_signals']);
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
    // The joined context carries the aggregated lane reason for the single gate.
    expect(actor.getSnapshot().context.previousAgentOutput).toContain('lane 0 blocked: evaluator needs credentials');
    expect(actor.getSnapshot().context.lastDeterministicResult).toMatchObject({
      verdict: 'escalate',
      payload: { issues: [{ index: 0, status: 'blocked', reason: 'evaluator needs credentials' }] },
    });
  });

  it('drains peer lanes on the first blocked child and opens one aggregated gate', async () => {
    const raiseGate = vi.fn();
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { raiseGate }));
    const parallelDefinition: WorkflowDefinition = {
      ...fanOutDefinition,
      settings: { ...fanOutDefinition.settings, workers: 3 },
    };

    const pendingResearchers = new Map<number, Deferred<AgentInvokeResult>>();
    const deterministicCalls: Array<{ stateId: string; laneId: number | undefined }> = [];
    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') {
        return makeVerdictResult('design');
      }
      const lane = input.context.lane?.id ?? -1;
      if (lane === 0) {
        return makeAgentResult({ outputHash: 'researcher-lane-0' });
      }
      const hold = deferred<AgentInvokeResult>();
      pendingResearchers.set(lane, hold);
      return hold.promise;
    };
    const deterministicStub: DeterministicStub = async (input) => {
      deterministicCalls.push({ stateId: input.stateId, laneId: input.context.lane?.id });
      if (input.stateId === 'sample') return { passed: true, verdict: 'sampled' };
      if (input.stateId === 'evaluate' && input.context.lane?.id === 0) {
        return { passed: false, verdict: 'evaluator_blocked', errors: 'lane 0 evaluator blocked' };
      }
      if (input.stateId === 'evaluate') {
        throw new Error(`lane ${input.context.lane?.id} should have been drained before evaluate`);
      }
      return recordedDeterministicStub(input);
    };

    const { actor } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub, parallelDefinition);
    await settle();

    expect(actor.getSnapshot().value).toBe('human_escalation');
    expect(actor.getSnapshot().status).toBe('active');
    expect(raiseGate).toHaveBeenCalledTimes(1);
    expect(raiseGate.mock.calls[0][0]).toMatchObject({
      stateName: 'human_escalation',
      summary: expect.stringContaining('lane 0 blocked: lane 0 evaluator blocked'),
    });
    expect(actor.getSnapshot().context.previousAgentOutput).toContain('lane 0 blocked: lane 0 evaluator blocked');
    expect(actor.getSnapshot().context.lastDeterministicResult).toMatchObject({
      verdict: 'escalate',
      payload: { issues: [{ index: 0, status: 'blocked', reason: 'lane 0 evaluator blocked' }] },
    });

    expect(pendingResearchers.has(1)).toBe(true);
    expect(pendingResearchers.has(2)).toBe(true);
    expect(
      deterministicCalls
        .filter((call) => call.stateId === 'evaluate')
        .map((call) => call.laneId)
        .sort(),
    ).toEqual([0]);
    expect(deterministicCalls.some((call) => call.stateId === 'analysis_record')).toBe(false);

    const log = readFileSync(join(tmpDir, 'messages.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; verdict?: string; children?: Array<{ status: string }> });
    expect(log.find((entry) => entry.type === 'fanout_join')).toMatchObject({
      verdict: 'escalate',
      children: [{ status: 'blocked' }, { status: 'drained' }, { status: 'drained' }],
    });

    for (const hold of pendingResearchers.values()) {
      hold.resolve(makeAgentResult());
    }
  });

  it('APPROVE after a drained escalation lets the orchestrator start a fresh batch', async () => {
    const raiseGate = vi.fn();
    const dismissGate = vi.fn();
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { raiseGate, dismissGate }));
    const parallelDefinition: WorkflowDefinition = {
      ...fanOutDefinition,
      settings: { ...fanOutDefinition.settings, workers: 3 },
    };

    const firstBatchHeldResearchers = new Map<number, Deferred<AgentInvokeResult>>();
    const deterministicCalls: Array<{ stateId: string; laneId: number | undefined; turn: number }> = [];
    let orchestratorTurn = 0;
    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') {
        orchestratorTurn += 1;
        return makeVerdictResult(orchestratorTurn <= 2 ? 'design' : 'finished');
      }
      const lane = input.context.lane?.id ?? -1;
      if (orchestratorTurn === 1 && lane !== 0) {
        const hold = deferred<AgentInvokeResult>();
        firstBatchHeldResearchers.set(lane, hold);
        return hold.promise;
      }
      return makeAgentResult({ outputHash: `researcher-turn-${orchestratorTurn}-lane-${lane}` });
    };
    const deterministicStub: DeterministicStub = async (input) => {
      deterministicCalls.push({ stateId: input.stateId, laneId: input.context.lane?.id, turn: orchestratorTurn });
      if (input.stateId === 'sample') return { passed: true, verdict: 'sampled' };
      if (input.stateId === 'evaluate' && orchestratorTurn === 1 && input.context.lane?.id === 0) {
        return { passed: false, verdict: 'evaluator_blocked', errors: 'lane 0 evaluator blocked' };
      }
      if (input.stateId === 'evaluate') return { passed: true, verdict: 'evaluated' };
      if (input.stateId === 'analysis_record') return { passed: true, verdict: 'recorded' };
      return recordedDeterministicStub(input);
    };

    const { actor, visited } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub, parallelDefinition);
    await settle();

    expect(actor.getSnapshot().value).toBe('human_escalation');
    expect(raiseGate).toHaveBeenCalledTimes(1);
    expect(
      deterministicCalls.filter((call) => call.turn === 1 && call.stateId === 'evaluate').map((call) => call.laneId),
    ).toEqual([0]);

    for (const hold of firstBatchHeldResearchers.values()) {
      hold.resolve(makeAgentResult());
    }
    orchestrator.resolveGate(WF_ID, { type: 'APPROVE' });
    await settle();

    expect(dismissGate).toHaveBeenCalledTimes(1);
    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().value).toBe('done');
    expect(visited.filter((state) => state === 'human_escalation')).toHaveLength(1);
    expect(visited.filter((state) => state === 'workers')).toHaveLength(2);
    expect(visited).not.toContain('evaluate');
    expect(
      deterministicCalls
        .filter((call) => call.turn === 2 && call.stateId === 'sample')
        .map((call) => call.laneId)
        .sort(),
    ).toEqual([0, 1, 2]);
    expect(
      deterministicCalls
        .filter((call) => call.turn === 2 && call.stateId === 'analysis_record')
        .map((call) => call.laneId)
        .sort(),
    ).toEqual([0, 1, 2]);
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
    expect(actor.getSnapshot().context.lastError).toContain('lane 0 errored: researcher crashed');
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
    expect(actor.getSnapshot().context.lastError).toContain('lane 0 errored: evaluate harness crashed');
  });
});
