import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { SessionOptions } from '../../src/session/types.js';
import type { Session } from '../../src/session/types.js';
import type { HumanGateRequest } from '../../src/workflow/types.js';
import { FileCheckpointStore } from '../../src/workflow/checkpoint.js';
import {
  WorkflowOrchestrator,
  type WorkflowOrchestratorDeps,
  type WorkflowLifecycleEvent,
} from '../../src/workflow/orchestrator.js';
import {
  MockSession,
  statusBlock,
  simulateArtifacts,
  findWorkflowDir,
  waitForGateOrCompletion,
  waitForCompletion,
} from './test-helpers.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workflow-spike demo definition', () => {
  let tmpDir: string;
  let orchestrator: WorkflowOrchestrator | undefined;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const definitionPath = resolve(__dirname, '../../examples/workflow-demo.json');

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'spike-test-'));
    orchestrator = undefined;
  });

  afterEach(async () => {
    if (orchestrator) {
      await orchestrator.shutdownAll();
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('drives the full demo workflow to completion with auto-approved gates', async () => {
    let criticCallCount = 0;
    const allSessions: MockSession[] = [];

    const sessionFactory = async (opts: SessionOptions): Promise<Session> => {
      const persona = opts.persona ?? 'unknown';

      const session = new MockSession({
        sessionId: `${persona}-${Date.now()}`,
        responses: () => {
          switch (persona) {
            case 'planner':
              simulateArtifacts(findWorkflowDir(tmpDir), ['plan']);
              return `Plan created.\n\n${statusBlock('approved', 'Plan complete')}`;

            case 'architect':
              simulateArtifacts(findWorkflowDir(tmpDir), ['spec']);
              return `Design spec created.\n\n${statusBlock('approved', 'Design complete')}`;

            case 'coder':
              simulateArtifacts(findWorkflowDir(tmpDir), ['code']);
              return `Code implemented.\n\n${statusBlock('approved', 'Code complete')}`;

            case 'critic': {
              criticCallCount++;
              simulateArtifacts(findWorkflowDir(tmpDir), ['reviews']);
              if (criticCallCount === 1) {
                return `Issues found.\n\n${statusBlock('rejected', 'Missing validation')}`;
              }
              return `All good.\n\n${statusBlock('approved', 'Code approved')}`;
            }

            default:
              throw new Error(`Unknown persona: ${persona}`);
          }
        },
      });
      allSessions.push(session);
      return session;
    };

    const raisedGates: HumanGateRequest[] = [];
    const deps: WorkflowOrchestratorDeps = {
      createSession: sessionFactory,
      createWorkflowTab: () => ({ write() {}, setLabel() {}, close() {} }),
      raiseGate: (gate) => raisedGates.push(gate),
      dismissGate: () => {},
      baseDir: tmpDir,
      checkpointStore: new FileCheckpointStore(resolve(tmpDir, '..', `${resolve(tmpDir).split('/').pop()!}-ckpt`)),
    };

    orchestrator = new WorkflowOrchestrator(deps);
    const lifecycleEvents: WorkflowLifecycleEvent[] = [];
    orchestrator.onEvent((e) => lifecycleEvents.push(e));

    const workflowId = await orchestrator.start(definitionPath, 'Build a REST API');

    // Expected flow:
    // plan -> plan_review (gate) -> design -> design_review (gate) ->
    // implement -> validate -> review (reject) -> implement -> validate ->
    // review (approve) -> done

    // Gate 1: plan_review
    let result = await waitForGateOrCompletion(orchestrator, workflowId);
    expect(result).toBe('gate');
    expect(raisedGates).toHaveLength(1);
    expect(raisedGates[0].stateName).toBe('plan_review');
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });

    // Gate 2: design_review
    result = await waitForGateOrCompletion(orchestrator, workflowId);
    expect(result).toBe('gate');
    expect(raisedGates).toHaveLength(2);
    expect(raisedGates[1].stateName).toBe('design_review');
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });

    // From here: implement -> validate -> review(reject) -> implement ->
    // validate -> review -- at this point round >= maxRounds so
    // isRoundLimitReached fires, sending to escalate_gate.
    result = await waitForGateOrCompletion(orchestrator, workflowId);

    // The round counter increments per agent invocation. With maxRounds=3 and
    // 4+ agent calls (plan, architect, coder, critic-reject, coder), by the
    // time the second critic runs, isRoundLimitReached triggers escalate_gate.
    if (result === 'gate') {
      const lastGate = raisedGates[raisedGates.length - 1];
      expect(lastGate.stateName).toBe('escalate_gate');
      orchestrator.resolveGate(workflowId, { type: 'APPROVE' });
    }

    await waitForCompletion(orchestrator, workflowId);

    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('completed');

    // Verify the coder-critic loop happened (critic called at least once)
    expect(criticCallCount).toBeGreaterThanOrEqual(1);

    // All sessions closed
    expect(allSessions.every((s) => s.closed)).toBe(true);

    // Verify lifecycle states include the expected progression
    const stateEvents = lifecycleEvents
      .filter((e) => e.kind === 'state_entered')
      .map((e) => (e as { state: string }).state);
    expect(stateEvents).toContain('plan');
    expect(stateEvents).toContain('plan_review');
    expect(stateEvents).toContain('design');
    expect(stateEvents).toContain('design_review');
    expect(stateEvents).toContain('implement');
    expect(stateEvents).toContain('validate');
    expect(stateEvents).toContain('review');
    expect(stateEvents).toContain('done');
  });

  it('FORCE_REVISION at plan_review sends planner back with feedback', async () => {
    let plannerCallCount = 0;
    const allSessions: MockSession[] = [];

    const sessionFactory = async (opts: SessionOptions): Promise<Session> => {
      const persona = opts.persona ?? 'unknown';

      const session = new MockSession({
        sessionId: `${persona}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        responses: () => {
          switch (persona) {
            case 'planner':
              plannerCallCount++;
              simulateArtifacts(findWorkflowDir(tmpDir), ['plan']);
              return `Plan v${plannerCallCount}.\n\n${statusBlock('approved', `Plan v${plannerCallCount}`)}`;

            case 'architect':
              simulateArtifacts(findWorkflowDir(tmpDir), ['spec']);
              return `Spec.\n\n${statusBlock('approved', 'Design done')}`;

            case 'coder':
              simulateArtifacts(findWorkflowDir(tmpDir), ['code']);
              return `Code.\n\n${statusBlock('approved', 'Code done')}`;

            case 'critic':
              simulateArtifacts(findWorkflowDir(tmpDir), ['reviews']);
              return `LGTM.\n\n${statusBlock('approved', 'Approved')}`;

            default:
              throw new Error(`Unknown persona: ${persona}`);
          }
        },
      });
      allSessions.push(session);
      return session;
    };

    const raisedGates: HumanGateRequest[] = [];
    const deps: WorkflowOrchestratorDeps = {
      createSession: sessionFactory,
      createWorkflowTab: () => ({ write() {}, setLabel() {}, close() {} }),
      raiseGate: (gate) => raisedGates.push(gate),
      dismissGate: () => {},
      baseDir: tmpDir,
      checkpointStore: new FileCheckpointStore(resolve(tmpDir, '..', `${resolve(tmpDir).split('/').pop()!}-ckpt`)),
    };

    orchestrator = new WorkflowOrchestrator(deps);
    const workflowId = await orchestrator.start(definitionPath, 'Build API');

    // Gate 1: plan_review -> FORCE_REVISION
    await waitForGateOrCompletion(orchestrator, workflowId);
    expect(raisedGates[0].stateName).toBe('plan_review');
    orchestrator.resolveGate(workflowId, {
      type: 'FORCE_REVISION',
      prompt: 'Add security considerations',
    });

    // Gate 2: plan_review again (after re-plan)
    await waitForGateOrCompletion(orchestrator, workflowId);
    expect(raisedGates).toHaveLength(2);
    expect(raisedGates[1].stateName).toBe('plan_review');

    // Check that the second planner session received the feedback
    const secondPlanner = allSessions[1];
    expect(secondPlanner.sentMessages[0]).toContain('Add security considerations');

    // Now approve and let the rest flow
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });

    // Auto-approve design_review
    await waitForGateOrCompletion(orchestrator, workflowId);
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });

    await waitForCompletion(orchestrator, workflowId);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    expect(plannerCallCount).toBe(2);
  });

  it('ABORT at a gate terminates the workflow', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const sessionFactory = async (opts: SessionOptions): Promise<Session> => {
      return new MockSession({
        responses: () => {
          simulateArtifacts(findWorkflowDir(tmpDir), ['plan']);
          return `Plan.\n\n${statusBlock('approved', 'Plan done')}`;
        },
      });
    };

    const raisedGates: HumanGateRequest[] = [];
    const deps: WorkflowOrchestratorDeps = {
      createSession: sessionFactory,
      createWorkflowTab: () => ({ write() {}, setLabel() {}, close() {} }),
      raiseGate: (gate) => raisedGates.push(gate),
      dismissGate: () => {},
      baseDir: tmpDir,
      checkpointStore: new FileCheckpointStore(resolve(tmpDir, '..', `${resolve(tmpDir).split('/').pop()!}-ckpt`)),
    };

    orchestrator = new WorkflowOrchestrator(deps);
    const workflowId = await orchestrator.start(definitionPath, 'Build API');

    await waitForGateOrCompletion(orchestrator, workflowId);
    orchestrator.resolveGate(workflowId, { type: 'ABORT' });

    await waitForCompletion(orchestrator, workflowId);
    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('aborted');
  });
});
