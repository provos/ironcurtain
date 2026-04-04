import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type {
  SessionOptions,
  SessionInfo,
  SessionId,
  BudgetStatus,
  ConversationTurn,
  DiagnosticEvent,
  EscalationRequest,
} from '../../src/session/types.js';
import type { Session } from '../../src/session/types.js';
import type { WorkflowId, HumanGateRequest } from '../../src/workflow/types.js';
import { FileCheckpointStore } from '../../src/workflow/checkpoint.js';
import {
  WorkflowOrchestrator,
  type WorkflowOrchestratorDeps,
  type WorkflowLifecycleEvent,
} from '../../src/workflow/orchestrator.js';

// ---------------------------------------------------------------------------
// MockSession (same pattern as orchestrator.test.ts)
// ---------------------------------------------------------------------------

type ResponseFn = (msg: string) => string | Promise<string>;

class MockSession implements Session {
  readonly sentMessages: string[] = [];
  closed = false;
  private readonly sessionId: string;
  private readonly responseFn: ResponseFn;

  constructor(opts: { sessionId?: string; responses: ResponseFn }) {
    this.sessionId = opts.sessionId ?? `mock-${Math.random().toString(36).slice(2, 8)}`;
    this.responseFn = opts.responses;
  }

  getInfo(): SessionInfo {
    return {
      id: this.sessionId as SessionId,
      status: this.closed ? 'closed' : 'ready',
      turnCount: this.sentMessages.length,
      createdAt: new Date().toISOString(),
    };
  }

  async sendMessage(msg: string): Promise<string> {
    this.sentMessages.push(msg);
    return this.responseFn(msg);
  }

  getHistory(): readonly ConversationTurn[] {
    return [];
  }
  getDiagnosticLog(): readonly DiagnosticEvent[] {
    return [];
  }
  async resolveEscalation(): Promise<void> {}
  getPendingEscalation(): EscalationRequest | undefined {
    return undefined;
  }
  getBudgetStatus(): BudgetStatus {
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
      elapsedSeconds: 0,
      estimatedCostUsd: 0,
      limits: {} as BudgetStatus['limits'],
      cumulative: {} as BudgetStatus['cumulative'],
      tokenTrackingAvailable: false,
    };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function statusBlock(verdict: string, notes: string): string {
  return [
    '```',
    'agent_status:',
    '  completed: true',
    `  verdict: ${verdict}`,
    '  confidence: high',
    '  escalation: null',
    '  test_count: null',
    `  notes: "${notes}"`,
    '```',
  ].join('\n');
}

function simulateArtifacts(baseDir: string, names: string[]): void {
  const entries = readdirSync(baseDir);
  const dirs = entries.filter((e) => !e.endsWith('.json'));
  if (dirs.length === 0) throw new Error(`No workflow dir in ${baseDir}`);
  const artifactDir = resolve(baseDir, dirs[dirs.length - 1], 'artifacts');
  for (const name of names) {
    const dir = resolve(artifactDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${name}.md`), `content for ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Polling helpers
// ---------------------------------------------------------------------------

async function waitForGateOrCompletion(
  orchestrator: WorkflowOrchestrator,
  workflowId: WorkflowId,
  timeoutMs = 5000,
): Promise<'gate' | 'done'> {
  const start = Date.now();
  for (;;) {
    const status = orchestrator.getStatus(workflowId);
    if (!status) return 'done';
    if (status.phase === 'completed' || status.phase === 'failed' || status.phase === 'aborted') return 'done';
    if (status.phase === 'waiting_human') return 'gate';
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for gate or completion, status: ${JSON.stringify(status)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitForCompletion(
  orchestrator: WorkflowOrchestrator,
  workflowId: WorkflowId,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const status = orchestrator.getStatus(workflowId);
    if (!status) return;
    if (status.phase === 'completed' || status.phase === 'failed' || status.phase === 'aborted') return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for completion, status: ${JSON.stringify(status)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

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
              simulateArtifacts(tmpDir, ['plan']);
              return `Plan created.\n\n${statusBlock('approved', 'Plan complete')}`;

            case 'architect':
              simulateArtifacts(tmpDir, ['spec']);
              return `Design spec created.\n\n${statusBlock('approved', 'Design complete')}`;

            case 'coder':
              simulateArtifacts(tmpDir, ['code']);
              return `Code implemented.\n\n${statusBlock('approved', 'Code complete')}`;

            case 'critic': {
              criticCallCount++;
              simulateArtifacts(tmpDir, ['reviews']);
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
              simulateArtifacts(tmpDir, ['plan']);
              return `Plan v${plannerCallCount}.\n\n${statusBlock('approved', `Plan v${plannerCallCount}`)}`;

            case 'architect':
              simulateArtifacts(tmpDir, ['spec']);
              return `Spec.\n\n${statusBlock('approved', 'Design done')}`;

            case 'coder':
              simulateArtifacts(tmpDir, ['code']);
              return `Code.\n\n${statusBlock('approved', 'Code done')}`;

            case 'critic':
              simulateArtifacts(tmpDir, ['reviews']);
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
          simulateArtifacts(tmpDir, ['plan']);
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
