/**
 * Orchestrator transient-failure short-circuit tests.
 *
 * Sibling of `orchestrator-quota.test.ts`. The transient-failure path
 * fires when the adapter detects a degenerate response envelope (e.g.,
 * `usage.output_tokens === 0` AND `stop_reason === null`) — indicating a
 * sustained upstream stall. The orchestrator must:
 *
 *  - Halt the run immediately (no reprompt, no rotation — an in-loop
 *    retry against a stalled upstream is hopeless).
 *  - Force `phase: 'aborted'` regardless of which terminal
 *    `findErrorTarget` resolved to, so the on-disk checkpoint is
 *    preserved and `isCheckpointResumable` returns true.
 *  - Append exactly ONE structured `transient_failure` log entry and
 *    NO generic `error` entry (double-log regression guard).
 *  - Allow `workflow resume` to re-enter the failing agent state and
 *    drive the run forward once the upstream is healthy. This is the
 *    primary acceptance criterion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import { WorkflowOrchestrator } from '../../src/workflow/orchestrator.js';
import type { MessageLogEntry, TransientFailureEntry, QuotaExhaustedEntry } from '../../src/workflow/message-log.js';
import {
  MockSession,
  noStatusResponse,
  approvedResponse,
  simulateArtifacts,
  findWorkflowDir,
  writeDefinitionFile,
  createDeps,
  createCheckpointStore,
  waitForCompletion,
  stubPersonasForTest,
} from './test-helpers.js';

// Workflow definition whose ONLY terminal is `done` — no `aborted`/`failed`
// terminal. This is the critical shape: without the
// `instance.transientFailure` stamp, `handleWorkflowComplete` would mark
// the run `phase: 'completed'`, leaving a terminal checkpoint that
// `isCheckpointResumable` treats as non-resumable and thus breaking
// resume.
const simpleAgentDef: WorkflowDefinition = {
  name: 'simple-agent-transient',
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

const RAW_MESSAGE = '{"result":"preamble only","usage":{"output_tokens":0},"stop_reason":null}';

function readMessageLog(baseDir: string): MessageLogEntry[] {
  const logPath = resolve(findWorkflowDir(baseDir), 'messages.jsonl');
  if (!existsSync(logPath)) return [];
  const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
  return lines.map((l) => JSON.parse(l) as MessageLogEntry);
}

describe('WorkflowOrchestrator transient-failure short-circuit', () => {
  let tmpDir: string;
  let activeOrchestrators: WorkflowOrchestrator[];
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orchestrator-transient-test-'));
    activeOrchestrators = [];
    cleanupPersonas = stubPersonasForTest(tmpDir, simpleAgentDef);
  });

  afterEach(async () => {
    for (const o of activeOrchestrators) {
      await o.shutdownAll();
    }
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
    const baseName = resolve(tmpDir).split('/').pop()!;
    const ckptDir = resolve(tmpDir, '..', `${baseName}-ckpt`);
    rmSync(ckptDir, { recursive: true, force: true });
  });

  function trackOrchestrator(o: WorkflowOrchestrator): WorkflowOrchestrator {
    activeOrchestrators.push(o);
    return o;
  }

  it('halts immediately when the primary turn reports transientFailure, preserves checkpoint, and does not double-log', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      const session = new MockSession({
        responses: [
          {
            text: 'preamble only',
            hardFailure: false,
            transientFailure: { kind: 'degenerate_response', rawMessage: RAW_MESSAGE },
          },
        ],
      });
      allSessions.push(session);
      return session;
    });

    const checkpointStore = createCheckpointStore(tmpDir);
    const deps = createDeps(tmpDir, { createSession: sessionFactory, checkpointStore });
    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    // The workflow has no `aborted` terminal — `findErrorTarget` would
    // route to `done` and `handleWorkflowComplete` would mark the run
    // `completed` if not for the `instance.transientFailure` stamp. The
    // user's resumability requirement hinges on this assertion.
    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('aborted');
    if (status?.phase === 'aborted') {
      expect(status.reason).toContain('Upstream stall');
      expect(status.reason).toContain('degenerate_response');
      expect(status.reason).toContain('resume');
    }

    // Checkpoint MUST be preserved so `workflow resume` works.
    expect(checkpointStore.load(workflowId)).not.toBeNull();

    // Exactly ONE turn — no rotation, no reprompt.
    const session = allSessions[0];
    expect(session.sentMessages).toHaveLength(1);
    expect(session.rotateCalls).toEqual([]);

    // Exactly one transient_failure entry, zero generic error entries.
    const log = readMessageLog(tmpDir);
    const transientEntries = log.filter((e): e is TransientFailureEntry => e.type === 'transient_failure');
    expect(transientEntries).toHaveLength(1);
    expect(transientEntries[0].role).toBe('coder');
    expect(transientEntries[0].kind).toBe('degenerate_response');
    expect(transientEntries[0].rawMessage).toBe(RAW_MESSAGE);

    const errorEntries = log.filter((e) => e.type === 'error');
    expect(errorEntries).toHaveLength(0);
  });

  it('forces aborted phase even when the workflow definition has no aborted terminal (resume-eligibility guarantee)', async () => {
    // Explicit duplicate of the assertion above, called out separately
    // because this is THE acceptance criterion for the user's
    // requirement: a transient upstream error must leave the workflow
    // in a resumable state, regardless of YAML shape.
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const sessionFactory = vi.fn(
      async () =>
        new MockSession({
          responses: [
            {
              text: 'preamble',
              hardFailure: false,
              transientFailure: { kind: 'degenerate_response', rawMessage: RAW_MESSAGE },
            },
          ],
        }),
    );

    const checkpointStore = createCheckpointStore(tmpDir);
    const deps = createDeps(tmpDir, { createSession: sessionFactory, checkpointStore });
    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');
    expect(checkpointStore.load(workflowId)).not.toBeNull();
  });

  it('end-to-end resume round-trip: aborts on transient failure, then resume() re-runs the agent state to completion', async () => {
    // Primary acceptance test: user must be able to recover the run via
    // `workflow resume <id>` once the upstream is healthy.
    //
    // Uses a two-agent workflow so the failure on the second agent is
    // preceded by a state-transition checkpoint that pins the failing
    // state — that's the checkpoint `handleWorkflowComplete` preserves
    // when stamping `phase: 'aborted'` on transient failure. (A single
    // initial-state failure has no prior state-transition checkpoint;
    // out of scope for this fix.)
    const twoAgentDef: WorkflowDefinition = {
      name: 'two-agent-transient',
      description: 'Plan then implement',
      initial: 'plan',
      settings: { mode: 'builtin' },
      states: {
        plan: {
          type: 'agent',
          description: 'Plans',
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
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
    const cleanup = stubPersonasForTest(tmpDir, twoAgentDef);
    try {
      const defPath = writeDefinitionFile(tmpDir, twoAgentDef);

      // First orchestrator: planner succeeds, coder transient-fails.
      const failingFactory = vi.fn(async (opts: { persona?: string }) => {
        if (opts.persona === 'planner') {
          const wfDir = findWorkflowDir(tmpDir);
          simulateArtifacts(wfDir, ['plan']);
          return new MockSession({ responses: [approvedResponse('planned')] });
        }
        return new MockSession({
          responses: [
            {
              text: 'preamble',
              hardFailure: false,
              transientFailure: { kind: 'degenerate_response', rawMessage: RAW_MESSAGE },
            },
          ],
        });
      });

      const checkpointStore = createCheckpointStore(tmpDir);
      const deps1 = createDeps(tmpDir, {
        createSession: failingFactory as unknown as ReturnType<typeof vi.fn>,
        checkpointStore,
      });
      const orchestrator1 = trackOrchestrator(new WorkflowOrchestrator(deps1));

      const workflowId = await orchestrator1.start(defPath, 'write code');
      await waitForCompletion(orchestrator1, workflowId);

      expect(orchestrator1.getStatus(workflowId)?.phase).toBe('aborted');
      const cp = checkpointStore.load(workflowId);
      expect(cp).not.toBeNull();
      // Checkpoint must point at the failing state, not the terminal.
      expect(cp!.machineState).toBe('implement');
      expect(cp!.finalStatus?.phase).toBe('aborted');

      // Second orchestrator: coder now succeeds. Resume re-enters
      // 'implement' and drives to completion.
      await orchestrator1.shutdownAll();

      const healthyFactory = vi.fn(async (opts: { persona?: string }) => {
        const wfDir = findWorkflowDir(tmpDir);
        simulateArtifacts(wfDir, ['code']);
        return new MockSession({ responses: [approvedResponse(`${opts.persona} resumed`)] });
      });

      const deps2 = createDeps(tmpDir, {
        createSession: healthyFactory as unknown as ReturnType<typeof vi.fn>,
        checkpointStore,
      });
      const orchestrator2 = trackOrchestrator(new WorkflowOrchestrator(deps2));

      await orchestrator2.resume(workflowId);
      await waitForCompletion(orchestrator2, workflowId);

      // The coder must have been re-invoked on resume.
      expect(healthyFactory).toHaveBeenCalled();
      expect(orchestrator2.getStatus(workflowId)?.phase).toBe('completed');
    } finally {
      cleanup();
    }
  });

  it('prefers the quota short-circuit over the transient-failure short-circuit when both signals are set', async () => {
    // Document precedence: quota exhaustion is checked first. When both
    // signals are set on a turn, the quota path wins — only a
    // quota_exhausted log entry is emitted, no transient_failure entry.
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const sessionFactory = vi.fn(
      async () =>
        new MockSession({
          responses: [
            {
              text: 'stalled',
              hardFailure: false,
              quotaExhausted: { rawMessage: 'rate limited' },
              transientFailure: { kind: 'degenerate_response', rawMessage: RAW_MESSAGE },
            },
          ],
        }),
    );

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');

    const log = readMessageLog(tmpDir);
    const quotaEntries = log.filter((e): e is QuotaExhaustedEntry => e.type === 'quota_exhausted');
    const transientEntries = log.filter((e): e is TransientFailureEntry => e.type === 'transient_failure');
    expect(quotaEntries).toHaveLength(1);
    expect(transientEntries).toHaveLength(0);
  });

  it.todo(
    'resume re-enters the failing state after a transient failure on the initial agent state ' +
      '(blocked: orchestrator does not checkpoint on initial-state entry, so the abort-time checkpoint ' +
      'falls back to the terminal snapshot — same gap exists for quotaExhausted)',
  );

  it('halts when transientFailure surfaces on the missing-status-block reprompt', async () => {
    // The four `sendAgentTurn` call sites share the same closure, so
    // coverage of two sites (initial + missing-status-block reprompt)
    // is sufficient to confirm the short-circuit applies uniformly.
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      let callCount = 0;
      const session = new MockSession({
        responses: () => {
          callCount++;
          if (callCount === 1) {
            // Primary turn: produces text but no agent_status block,
            // triggering the missing-status-block reprompt.
            simulateArtifacts(findWorkflowDir(tmpDir), ['code']);
            return noStatusResponse();
          }
          if (callCount === 2) {
            return {
              text: 'preamble',
              hardFailure: false,
              transientFailure: { kind: 'degenerate_response', rawMessage: RAW_MESSAGE },
            };
          }
          throw new Error(`Unexpected call ${callCount} — reprompt should have short-circuited`);
        },
      });
      allSessions.push(session);
      return session;
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');

    const session = allSessions[0];
    expect(session.sentMessages).toHaveLength(2);
    expect(session.rotateCalls).toEqual([]);

    const log = readMessageLog(tmpDir);
    const transientEntries = log.filter((e): e is TransientFailureEntry => e.type === 'transient_failure');
    expect(transientEntries).toHaveLength(1);
  });
});
