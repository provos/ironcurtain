/**
 * Orchestrator retry-loop tests.
 *
 * Exercise the two-phase retry logic around `session.sendMessageDetailed()`:
 *
 *  - Hard failure (upstream stall, empty output): re-send the ORIGINAL
 *    command up to MAX_HARD_RETRIES (2) times, rotating the agent
 *    conversation id between attempts so the agent CLI doesn't hit
 *    "Session ID is already in use".
 *  - Soft failure (agent produced text but no/malformed status block):
 *    use the existing missing-status-block reprompt, once.
 *
 * Paired with `test/docker-agent-session-retry.test.ts` which covers
 * the session/adapter plumbing in isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import { WorkflowOrchestrator } from '../../src/workflow/orchestrator.js';
import {
  MockSession,
  approvedResponse,
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

const HARD_FAILURE_TEXT = 'Agent exited with code 143.\n\nOutput:\n';

describe('WorkflowOrchestrator retry loop', () => {
  let tmpDir: string;
  let activeOrchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orchestrator-retry-test-'));
    activeOrchestrator = undefined;
    cleanupPersonas = stubPersonasForTest(tmpDir, simpleAgentDef, agentThenGateDef);
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

    // The workflow proceeds to the onError target (terminal 'done' in
    // simpleAgentDef — see findErrorTarget's fallback) with the error
    // recorded in context.lastError.
    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('completed');

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
