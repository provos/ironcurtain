/**
 * Orchestrator retry-loop tests.
 *
 * Exercise agent-turn recovery around `session.sendMessageDetailed()`:
 *
 *  - Hard failure (upstream stall, empty output): re-send the ORIGINAL
 *    command up to MAX_HARD_RETRIES (2) times, rotating the agent
 *    conversation id between attempts so the agent CLI doesn't hit
 *    "Session ID is already in use".
 *  - Status failure (missing/malformed block or invalid verdict): run a
 *    bounded same-conversation commit loop, then replace routed executors.
 *
 * Paired with `test/docker-agent-session-retry.test.ts` which covers
 * the session/adapter plumbing in isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import { WorkflowOrchestrator, type WorkflowLifecycleEvent } from '../../src/workflow/orchestrator.js';
import { isCheckpointResumable } from '../../src/workflow/checkpoint.js';
import {
  MockSession,
  approvedResponse,
  rejectedResponse,
  noStatusResponse,
  simulateArtifacts,
  findWorkflowDir,
  writeDefinitionFile,
  createDeps,
  createCheckpointStore,
  waitForCompletion,
  waitForGate,
  stubPersonasForTest,
} from './test-helpers.js';

const simpleAgentDef: WorkflowDefinition = {
  name: 'simple-agent',
  description: 'Single agent to done',
  initial: 'implement',
  settings: { mode: 'builtin' },
  states: {
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

// Used by the checkpoint-id regression test: a gate after the agent
// state pauses the workflow so the checkpoint carries the pre-terminal
// machineState for inspection (a terminal-state save would overwrite it
// with `finalStatus` populated but the terminal state as `machineState`).
const agentThenGateDef: WorkflowDefinition = {
  name: 'agent-then-gate',
  description: 'Agent followed by human gate',
  initial: 'implement',
  settings: { mode: 'builtin' },
  states: {
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'review_gate' }],
    },
    review_gate: {
      type: 'human_gate',
      description: 'Human review',
      acceptedEvents: ['APPROVE', 'ABORT'],
      present: ['code'],
      transitions: [
        { to: 'done', event: 'APPROVE' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

const artifactHandoffDef: WorkflowDefinition = {
  name: 'artifact-handoff',
  description: 'Producer with a validated artifact handoff',
  initial: 'build',
  settings: { mode: 'builtin' },
  states: {
    build: {
      type: 'agent',
      description: 'Builds a harness',
      persona: 'coder',
      prompt: 'Build the harness.',
      inputs: [],
      outputs: ['harness_build'],
      artifactHandoff: { requiredFiles: ['harness_build/README.md'] },
      transitions: [{ to: 'validate' }],
    },
    validate: {
      type: 'agent',
      description: 'Validates the harness',
      persona: 'reviewer',
      prompt: 'Validate the harness.',
      inputs: ['harness_build'],
      outputs: ['validation'],
      transitions: [
        { to: 'done', when: { verdict: 'approved' } },
        { to: 'aborted', when: { verdict: 'rejected' } },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

const failedTerminalDef: WorkflowDefinition = {
  name: 'failed-terminal',
  description: 'Agent errors route to an explicit failed terminal',
  initial: 'implement',
  settings: { mode: 'builtin' },
  states: {
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      prompt: 'Write code.',
      inputs: [],
      outputs: ['code'],
      transitions: [
        { to: 'done', when: { verdict: 'approved' } },
        { to: 'failed', when: { verdict: 'rejected' } },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    failed: { type: 'terminal', description: 'Failed' },
  },
};

const statusRoutedNoGateDef: WorkflowDefinition = {
  name: 'status-routed-no-gate',
  description: 'Status-routed agent with only terminal recovery targets',
  initial: 'review',
  settings: { mode: 'builtin' },
  states: {
    review: {
      type: 'agent',
      description: 'Reviews the result',
      persona: 'reviewer',
      prompt: 'Review the result.',
      inputs: [],
      outputs: [],
      transitions: [
        { to: 'done', when: { verdict: 'approved' } },
        { to: 'aborted', when: { verdict: 'rejected' } },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

const HARD_FAILURE_TEXT = 'Agent exited with code 143.\n\nOutput:\n';

describe('WorkflowOrchestrator retry loop', () => {
  let tmpDir: string;
  let activeOrchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orchestrator-retry-test-'));
    activeOrchestrator = undefined;
    cleanupPersonas = stubPersonasForTest(
      tmpDir,
      simpleAgentDef,
      agentThenGateDef,
      artifactHandoffDef,
      failedTerminalDef,
      statusRoutedNoGateDef,
    );
  });

  afterEach(async () => {
    if (activeOrchestrator) {
      await activeOrchestrator.shutdownAll();
    }
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
    const baseName = resolve(tmpDir).split('/').pop()!;
    const ckptDir = resolve(tmpDir, '..', `${baseName}-ckpt`);
    rmSync(ckptDir, { recursive: true, force: true });
  });

  it('recovers when the first turn hard-fails and the retry succeeds', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      let callCount = 0;
      const session = new MockSession({
        responses: () => {
          callCount++;
          if (callCount === 1) {
            return { text: HARD_FAILURE_TEXT, hardFailure: true };
          }
          if (callCount === 2) {
            simulateArtifacts(findWorkflowDir(tmpDir), ['code']);
            return approvedResponse('recovered after hard failure');
          }
          throw new Error(`Unexpected call ${callCount}`);
        },
      });
      allSessions.push(session);
      return session;
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

    const session = allSessions[0];
    // Two turns sent; the retry re-sends the ORIGINAL command (not a
    // missing-status-block reprompt). Both messages must be identical.
    expect(session.sentMessages).toHaveLength(2);
    expect(session.sentMessages[0]).toBe(session.sentMessages[1]);
    expect(session.sentMessages[1]).not.toContain('missing the required agent_status block');

    // Rotation was invoked between the hard failure and the retry.
    expect(session.rotateCalls).toEqual([1]);
  });

  it('fails with an upstream-stall error when all 3 attempts hard-fail', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      const session = new MockSession({
        responses: [
          { text: HARD_FAILURE_TEXT, hardFailure: true },
          { text: HARD_FAILURE_TEXT, hardFailure: true },
          { text: HARD_FAILURE_TEXT, hardFailure: true },
        ],
      });
      allSessions.push(session);
      return session;
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    // The workflow proceeds to the onError target with the error recorded in
    // context.lastError, so even a generically named terminal is not success.
    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('failed');

    const session = allSessions[0];
    expect(session.sentMessages).toHaveLength(3);
    // All three attempts send the ORIGINAL command (not a reprompt).
    expect(session.sentMessages[0]).toBe(session.sentMessages[1]);
    expect(session.sentMessages[1]).toBe(session.sentMessages[2]);
    // Rotation happened between attempts 1→2 and 2→3, but NOT after the
    // final attempt (no point — we're about to throw).
    expect(session.rotateCalls).toEqual([1, 2]);

    // lastError surface via checkpoint would be nice to verify but the
    // in-memory status doesn't expose it directly; reaching the terminal
    // via the error path is already the primary signal.
  });

  it('reports an explicit failed terminal with exact error/last state and keeps it resumable', async () => {
    const checkpointStore = createCheckpointStore(tmpDir);
    const lifecycleEvents: string[] = [];
    const session = new MockSession({
      responses: [
        { text: HARD_FAILURE_TEXT, hardFailure: true },
        { text: HARD_FAILURE_TEXT, hardFailure: true },
        { text: HARD_FAILURE_TEXT, hardFailure: true },
      ],
    });
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, { createSession: vi.fn(async () => session), checkpointStore }),
    );
    activeOrchestrator = orchestrator;
    orchestrator.onEvent((event) => lifecycleEvents.push(event.kind));

    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, failedTerminalDef), 'write code');
    await waitForCompletion(orchestrator, workflowId);

    const status = orchestrator.getStatus(workflowId);
    expect(status).toEqual({
      phase: 'failed',
      error: 'Agent failed to produce output after 3 attempts (upstream stall)',
      lastState: 'implement',
    });
    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint).toBeDefined();
    expect(isCheckpointResumable(checkpoint!)).toBe(true);
    expect(lifecycleEvents).not.toContain('completed');
  });

  it('reports a verdict-routed failed terminal as resumable instead of completed', async () => {
    const checkpointStore = createCheckpointStore(tmpDir);
    const lifecycleEvents: string[] = [];
    const session = new MockSession({
      responses: () => {
        simulateArtifacts(findWorkflowDir(tmpDir), ['code']);
        return rejectedResponse('implementation failed review');
      },
    });
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, { createSession: vi.fn(async () => session), checkpointStore }),
    );
    activeOrchestrator = orchestrator;
    orchestrator.onEvent((event) => lifecycleEvents.push(event.kind));

    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, failedTerminalDef), 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)).toEqual({
      phase: 'failed',
      error: 'Workflow reached failed state "failed"',
      lastState: 'implement',
    });
    expect(isCheckpointResumable(checkpointStore.load(workflowId)!)).toBe(true);
    expect(lifecycleEvents).toContain('failed');
    expect(lifecycleEvents).not.toContain('completed');
  });

  it('uses the missing-status-block reprompt for soft failures (no hard-failure retry)', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      let callCount = 0;
      const session = new MockSession({
        responses: () => {
          callCount++;
          if (callCount === 1) {
            simulateArtifacts(findWorkflowDir(tmpDir), ['code']);
            return noStatusResponse();
          }
          if (callCount === 2) {
            return approvedResponse('status block on retry');
          }
          throw new Error(`Unexpected call ${callCount}`);
        },
      });
      allSessions.push(session);
      return session;
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

    const session = allSessions[0];
    expect(session.sentMessages).toHaveLength(2);
    // The second message is the reprompt, NOT the original command.
    expect(session.sentMessages[0]).not.toBe(session.sentMessages[1]);
    expect(session.sentMessages[1]).toContain('agent_status');
    // No rotation for soft failures — the agent produced text, the
    // session id is still valid, `--resume` will work.
    expect(session.rotateCalls).toEqual([]);
  });

  it('recovers from a hard failure followed by a soft failure followed by success', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      let callCount = 0;
      const session = new MockSession({
        responses: () => {
          callCount++;
          if (callCount === 1) {
            return { text: HARD_FAILURE_TEXT, hardFailure: true };
          }
          if (callCount === 2) {
            simulateArtifacts(findWorkflowDir(tmpDir), ['code']);
            return noStatusResponse();
          }
          if (callCount === 3) {
            return approvedResponse('recovered through both retry paths');
          }
          throw new Error(`Unexpected call ${callCount}`);
        },
      });
      allSessions.push(session);
      return session;
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

    const session = allSessions[0];
    expect(session.sentMessages).toHaveLength(3);
    // Turn 1 and turn 2 both send the ORIGINAL command (hard-failure retry).
    expect(session.sentMessages[0]).toBe(session.sentMessages[1]);
    // Turn 3 is the missing-status-block reprompt (not the original).
    expect(session.sentMessages[2]).not.toBe(session.sentMessages[0]);
    expect(session.sentMessages[2]).toContain('agent_status');
    // Exactly one rotation: between attempt 1 (hard fail) and attempt 2.
    expect(session.rotateCalls).toEqual([1]);
  });

  it('stops status recovery before an extra turn when the cumulative budget is exhausted', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const lifecycleEvents: { kind: string; error?: string }[] = [];
    const session = new MockSession({ responses: [noStatusResponse()] });
    vi.spyOn(session, 'getBudgetStatus').mockReturnValue({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
      elapsedSeconds: 0,
      estimatedCostUsd: 0,
      tokenTrackingAvailable: true,
      limits: {
        maxTotalTokens: 100,
        maxSteps: 1,
        maxSessionSeconds: 100,
        maxEstimatedCostUsd: 10,
        warnThresholdPercent: 80,
      },
      cumulative: {
        totalInputTokens: 1,
        totalOutputTokens: 1,
        totalTokens: 2,
        stepCount: 1,
        activeSeconds: 1,
        estimatedCostUsd: 0,
      },
    });

    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { createSession: vi.fn(async () => session) }));
    activeOrchestrator = orchestrator;
    orchestrator.onEvent((event) => lifecycleEvents.push(event));

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(session.sentMessages).toHaveLength(1);
    expect(lifecycleEvents.find((event) => event.kind === 'failed')?.error).toContain(
      'Status recovery stopped: step budget exhausted',
    );
  });

  // Regression: `maxSessionSeconds` is a PER-TURN limit. Summing every turn's
  // active time against it turned it into a ceiling on the state's total
  // duration, tearing down long agent states mid-build. The between-turn
  // admission check must ignore elapsed time entirely.
  it('still runs status recovery when cumulative active time exceeds the per-turn maxSessionSeconds', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    let callCount = 0;
    const session = new MockSession({
      responses: () => {
        callCount++;
        if (callCount === 1) {
          simulateArtifacts(findWorkflowDir(tmpDir), ['code']);
          return noStatusResponse();
        }
        if (callCount === 2) {
          return approvedResponse('status block on recovery turn');
        }
        throw new Error(`Unexpected call ${callCount}`);
      },
    });
    vi.spyOn(session, 'getBudgetStatus').mockReturnValue({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
      elapsedSeconds: 0,
      estimatedCostUsd: 0,
      tokenTrackingAvailable: true,
      limits: {
        maxTotalTokens: 100_000,
        maxSteps: 1_000,
        maxSessionSeconds: 100,
        maxEstimatedCostUsd: 100,
        warnThresholdPercent: 80,
      },
      cumulative: {
        totalInputTokens: 1,
        totalOutputTokens: 1,
        totalTokens: 2,
        stepCount: 1,
        // Far past the per-turn limit; no other budget is close to exhausted.
        activeSeconds: 10_805,
        estimatedCostUsd: 0,
      },
    });

    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { createSession: vi.fn(async () => session) }));
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    // The recovery turn was launched rather than refused on elapsed time.
    expect(session.sentMessages).toHaveLength(2);
    expect(session.sentMessages[1]).toContain('agent_status');
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
  });

  it('keeps exhausted status-routed recovery without a direct gate as failed and resumable', async () => {
    const checkpointStore = createCheckpointStore(tmpDir);
    const lifecycleEvents: WorkflowLifecycleEvent[] = [];
    const session = new MockSession({ responses: () => noStatusResponse() });
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, { createSession: vi.fn(async () => session), checkpointStore }),
    );
    activeOrchestrator = orchestrator;
    orchestrator.onEvent((event) => lifecycleEvents.push(event));

    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, statusRoutedNoGateDef), 'review result');
    await waitForCompletion(orchestrator, workflowId);

    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('failed');
    if (status?.phase === 'failed') {
      expect(status.error).toContain('Fresh replacement returned missing final agent_status block');
      expect(status.lastState).toBe('review');
    }
    expect(isCheckpointResumable(checkpointStore.load(workflowId)!)).toBe(true);
    await vi.waitFor(() => {
      expect(lifecycleEvents.filter((event) => event.kind === 'failed' && event.phase === 'failed')).toHaveLength(1);
    });
    expect(lifecycleEvents.some((event) => event.kind === 'completed')).toBe(false);
  });

  it('rotates and fails when a same-conversation status recovery turn hard-fails', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const session = new MockSession({
      responses: [noStatusResponse(), { text: HARD_FAILURE_TEXT, hardFailure: true }],
    });
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { createSession: vi.fn(async () => session) }));
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(session.sentMessages).toHaveLength(2);
    expect(session.rotateCalls).toEqual([2]);
  });

  it('keeps explicit ABORT from an error recovery gate as aborted', async () => {
    const raiseGate = vi.fn();
    const session = new MockSession({ responses: () => noStatusResponse() });
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, { createSession: vi.fn(async () => session), raiseGate }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, agentThenGateDef), 'write code');
    const [gate] = await waitForGate(raiseGate, 1);
    expect(gate.stateName).toBe('review_gate');
    expect(gate.summary).toContain('missing final agent_status block');

    orchestrator.resolveGate(workflowId, { type: 'ABORT' });
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');
  });

  it('uses the explicit artifact handoff only for a non-empty required regular file', async () => {
    const defPath = writeDefinitionFile(tmpDir, artifactHandoffDef);
    const sessions: MockSession[] = [];
    let invocation = 0;
    const sessionFactory = vi.fn(async () => {
      invocation++;
      const session =
        invocation === 1
          ? new MockSession({
              responses: () => {
                const readme = resolve(findWorkflowDir(tmpDir), 'workspace', '.workflow', 'harness_build', 'README.md');
                mkdirSync(resolve(readme, '..'), { recursive: true });
                writeFileSync(readme, 'build instructions');
                return noStatusResponse();
              },
            })
          : new MockSession({
              responses: (message) => {
                expect(message).toContain('handing them to the configured validator');
                simulateArtifacts(findWorkflowDir(tmpDir), ['validation']);
                return approvedResponse('validated');
              },
            });
      sessions.push(session);
      return session;
    });

    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { createSession: sessionFactory }));
    activeOrchestrator = orchestrator;
    const workflowId = await orchestrator.start(defPath, 'build harness');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    expect(sessions[0].sentMessages).toHaveLength(3);
    expect(sessions[0].rotateCalls).toEqual([]);
  });

  it('keeps exhausted recovery without a direct gate as a resumable failure', async () => {
    const defPath = writeDefinitionFile(tmpDir, artifactHandoffDef);
    const checkpointStore = createCheckpointStore(tmpDir);
    const lifecycleEvents: WorkflowLifecycleEvent[] = [];
    const session = new MockSession({
      responses: () => {
        const readme = resolve(findWorkflowDir(tmpDir), 'workspace', '.workflow', 'harness_build', 'README.md');
        mkdirSync(resolve(readme, '..'), { recursive: true });
        writeFileSync(readme, '');
        return noStatusResponse();
      },
    });
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, { createSession: vi.fn(async () => session), checkpointStore }),
    );
    activeOrchestrator = orchestrator;
    orchestrator.onEvent((event) => lifecycleEvents.push(event));

    const workflowId = await orchestrator.start(defPath, 'build harness');
    await waitForCompletion(orchestrator, workflowId);

    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('failed');
    if (status?.phase === 'failed') {
      expect(status.error).toContain('missing final agent_status block');
      expect(status.lastState).toBe('build');
    }
    expect(isCheckpointResumable(checkpointStore.load(workflowId)!)).toBe(true);
    await vi.waitFor(() => {
      expect(lifecycleEvents.filter((event) => event.kind === 'failed' && event.phase === 'failed')).toHaveLength(1);
    });
    expect(lifecycleEvents.some((event) => event.kind === 'completed')).toBe(false);
  });

  it('rejects artifact handoff through a symlinked output ancestor', async () => {
    const session = new MockSession({
      responses: () => {
        const artifactRoot = resolve(findWorkflowDir(tmpDir), 'workspace', '.workflow');
        const actualBuild = resolve(artifactRoot, 'actual-build');
        mkdirSync(actualBuild, { recursive: true });
        writeFileSync(resolve(actualBuild, 'README.md'), 'build instructions');
        const declaredOutput = resolve(artifactRoot, 'harness_build');
        try {
          symlinkSync(actualBuild, declaredOutput, 'dir');
        } catch {
          // The same response fixture runs for every recovery turn.
        }
        return noStatusResponse();
      },
    });
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { createSession: vi.fn(async () => session) }));
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, artifactHandoffDef), 'build harness');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('failed');
  });

  it('stamps the ROTATED conversation id into the checkpoint (not the stale pre-rotation id)', async () => {
    // Regression guard: after a hard-failure rotation + success, the
    // transcript on disk is under the NEW id. If the orchestrator wrote
    // the old id into agentConversationsByState, a later freshSession:false
    // visit would try to resume a transcript that doesn't exist.
    //
    // Uses agentThenGateDef so the workflow pauses at a gate after the
    // agent state — we need a non-terminal resting point so the checkpoint's
    // `machineState` reflects the pre-terminal state (a terminal completion
    // would save a checkpoint with terminal `machineState` and `finalStatus`).
    const defPath = writeDefinitionFile(tmpDir, agentThenGateDef);
    const checkpointStore = createCheckpointStore(tmpDir);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      let callCount = 0;
      const session = new MockSession({
        responses: () => {
          callCount++;
          if (callCount === 1) {
            return { text: HARD_FAILURE_TEXT, hardFailure: true };
          }
          simulateArtifacts(findWorkflowDir(tmpDir), ['code']);
          return approvedResponse('recovered');
        },
      });
      allSessions.push(session);
      return session;
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, { createSession: sessionFactory, checkpointStore, raiseGate });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForGate(raiseGate, 1);

    const session = allSessions[0];
    expect(session.rotatedIds).toHaveLength(1);
    const rotatedId = session.rotatedIds[0];

    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.context.agentConversationsByState['implement']).toBe(rotatedId);
  });
});
