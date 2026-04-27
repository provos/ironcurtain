/**
 * Tests for `workflows.get` dispatch (B3): live-path backwards compatibility,
 * disk-fallback success cases (terminal + interrupted), and RPC error mapping
 * for `not_found` and `corrupted`.
 *
 * Also covers the small pure helpers shared with B4 (`computePastRunPhase`,
 * `buildDetailFromPastRun`) and the `workflows.messageLog` dispatch (B5)
 * with cursor-based pagination semantics.
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import {
  workflowDispatch,
  computePastRunPhase,
  synthesizePhaseFromMessageLog,
  buildDetailFromPastRun,
  buildPastRunDto,
  type WorkflowDispatchContext,
} from '../src/web-ui/dispatch/workflow-dispatch.js';
import { RpcError, type PastRunDto, type MessageLogResponseDto } from '../src/web-ui/web-ui-types.js';
import type { MessageLogEntry } from '../src/workflow/message-log.js';
import type { WorkflowRunSummary } from '../src/workflow/workflow-discovery.js';
import * as logger from '../src/logger.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import { SessionManager } from '../src/session/session-manager.js';
import type { WorkflowController, WorkflowDetail } from '../src/workflow/orchestrator.js';
import type {
  WorkflowId,
  WorkflowStatus,
  WorkflowCheckpoint,
  WorkflowContext,
  WorkflowDefinition,
} from '../src/workflow/types.js';
import type { ControlRequestHandler } from '../src/daemon/control-socket.js';
import type { PastRunLoadSuccess, WorkflowManager, PastRunLoadResult } from '../src/web-ui/workflow-manager.js';
import type { FileCheckpointStore } from '../src/workflow/checkpoint.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    taskDescription: 'do the thing',
    artifacts: {},
    round: 2,
    maxRounds: 4,
    previousOutputHashes: {},
    previousTestCount: null,
    humanPrompt: null,
    reviewHistory: [],
    parallelResults: {},
    worktreeBranches: [],
    totalTokens: 1234,
    lastError: null,
    agentConversationsByState: {},
    previousAgentOutput: null,
    previousAgentNotes: null,
    previousStateName: null,
    visitCounts: { plan: 1, review: 2 },
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<WorkflowCheckpoint> = {}): WorkflowCheckpoint {
  return {
    machineState: 'plan',
    context: makeContext(),
    timestamp: '2026-04-23T10:00:00.000Z',
    transitionHistory: [],
    definitionPath: '/tmp/def.json',
    workspacePath: '/tmp/workspace',
    ...overrides,
  };
}

function makeDefinition(overrides?: {
  initial?: string;
  states?: WorkflowDefinition['states'];
  name?: string;
}): WorkflowDefinition {
  return {
    name: overrides?.name ?? 'test-flow',
    description: 'Test workflow',
    initial: overrides?.initial ?? 'plan',
    states: overrides?.states ?? {
      plan: {
        type: 'agent',
        description: 'Plan stage',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: ['plan'],
        transitions: [{ to: 'done' }],
      },
      done: { type: 'terminal', description: 'finished' },
    },
  };
}

/** Minimal status fixtures for live-path coverage. */
function makeRunningStatus(state = 'plan'): WorkflowStatus {
  return { phase: 'running', currentState: state, activeAgents: [] };
}

function makeFailedStatus(error = 'boom', lastState = 'plan'): WorkflowStatus {
  return { phase: 'failed', error, lastState };
}

function makeDetail(overrides: Partial<WorkflowDetail> = {}): WorkflowDetail {
  return {
    definition: makeDefinition(),
    transitionHistory: [],
    workspacePath: '/tmp/workspace',
    context: {
      taskDescription: 'do the thing',
      round: 2,
      maxRounds: 4,
      totalTokens: 1234,
      visitCounts: { plan: 1 },
    },
    ...overrides,
  };
}

/** Builds a successful past-run load fixture with the new shape (B4+B5). */
function makeLoad(opts: {
  checkpoint?: WorkflowCheckpoint | undefined;
  definition?: WorkflowDefinition;
  messageLogPath?: string;
  isLive?: boolean;
}): PastRunLoadSuccess {
  return {
    checkpoint: 'checkpoint' in opts ? opts.checkpoint : makeCheckpoint(),
    definition: opts.definition ?? makeDefinition(),
    messageLogPath: opts.messageLogPath ?? '/tmp/nonexistent-messages.jsonl',
    isLive: opts.isLive ?? false,
  };
}

/** Builds a `WorkflowRunSummary` fixture for B6/B7/B8 callers. */
function makeSummary(opts: {
  workflowId: WorkflowId;
  baseDir?: string;
  mtime?: Date;
  hasCheckpoint?: boolean;
  hasDefinition?: boolean;
  hasMessageLog?: boolean;
}): WorkflowRunSummary {
  const baseDir = opts.baseDir ?? '/tmp';
  return {
    workflowId: opts.workflowId,
    directoryPath: resolve(baseDir, opts.workflowId),
    hasCheckpoint: opts.hasCheckpoint ?? true,
    hasDefinition: opts.hasDefinition ?? true,
    hasMessageLog: opts.hasMessageLog ?? false,
    mtime: opts.mtime ?? new Date('2026-04-23T10:00:00.000Z'),
  };
}

/** Writes a JSONL message log at `{baseDir}/{workflowId}/messages.jsonl`. */
function writeMessageLogFile(baseDir: string, workflowId: string, entries: readonly MessageLogEntry[]): string {
  const dir = resolve(baseDir, workflowId);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'messages.jsonl');
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
  writeFileSync(path, content, 'utf-8');
  return path;
}

/** Writes a `definition.json` and a `checkpoint.json`/`messages.jsonl` per-flag. */
function seedRunDirectory(
  baseDir: string,
  workflowId: string,
  opts: {
    definition?: WorkflowDefinition;
    checkpoint?: WorkflowCheckpoint | undefined;
    messages?: readonly MessageLogEntry[];
  },
): void {
  const dir = resolve(baseDir, workflowId);
  mkdirSync(dir, { recursive: true });
  if (opts.definition) {
    writeFileSync(resolve(dir, 'definition.json'), JSON.stringify(opts.definition), 'utf-8');
  }
  if (opts.checkpoint) {
    writeFileSync(resolve(dir, 'checkpoint.json'), JSON.stringify(opts.checkpoint), 'utf-8');
  }
  if (opts.messages) {
    writeMessageLogFile(baseDir, workflowId, opts.messages);
  }
}

/**
 * Builds a dispatch context with stubbable controller + manager. Mirrors the
 * pattern used in workflow-lint-dispatch.test.ts to avoid spinning up a real
 * orchestrator.
 */
function createContext(opts: {
  controller?: Partial<WorkflowController>;
  loadPastRun?: (id: WorkflowId) => PastRunLoadResult;
  baseDir?: string;
}): WorkflowDispatchContext {
  const controller: WorkflowController = {
    start: vi.fn().mockResolvedValue('mock-id' as WorkflowId),
    resume: vi.fn().mockResolvedValue(undefined),
    listResumable: vi.fn().mockReturnValue([]),
    getStatus: vi.fn().mockReturnValue(undefined),
    getDetail: vi.fn().mockReturnValue(undefined),
    listActive: vi.fn().mockReturnValue([]),
    resolveGate: vi.fn(),
    abort: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn(),
    shutdownAll: vi.fn().mockResolvedValue(undefined),
    ...opts.controller,
  };

  const manager = {
    getOrchestrator: () => controller,
    getCheckpointStore: () => ({ load: () => undefined }) as unknown as FileCheckpointStore,
    importExternalCheckpoint: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getBaseDir: () => opts.baseDir ?? '/tmp',
    loadPastRun: opts.loadPastRun ?? (() => ({ error: 'not_found' as const })),
  } as unknown as WorkflowManager;

  return {
    handler: {} as ControlRequestHandler,
    sessionManager: new SessionManager(),
    mode: { kind: 'docker', agent: 'claude-code' as never },
    eventBus: new WebEventBus(),
    maxConcurrentWebSessions: 5,
    sessionQueues: new Map(),
    workflowManager: manager,
  };
}

// ---------------------------------------------------------------------------
// computePastRunPhase
// ---------------------------------------------------------------------------

describe('computePastRunPhase', () => {
  it('returns "running" when isLive is true', () => {
    const cp = makeCheckpoint({ machineState: 'plan' });
    const def = makeDefinition();
    expect(computePastRunPhase(cp, def, true)).toBe('running');
  });

  it('returns "completed" when terminal state name does not look aborted', () => {
    const cp = makeCheckpoint({ machineState: 'done' });
    const def = makeDefinition({
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'finished' },
      },
    });
    expect(computePastRunPhase(cp, def, false)).toBe('completed');
  });

  it('returns "aborted" for a terminal state literally named "aborted"', () => {
    const cp = makeCheckpoint({ machineState: 'aborted' });
    const def = makeDefinition({
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'aborted' }],
        },
        aborted: { type: 'terminal', description: 'a' },
      },
    });
    expect(computePastRunPhase(cp, def, false)).toBe('aborted');
  });

  it('returns "aborted" when a terminal state name contains "abort"', () => {
    const cp = makeCheckpoint({ machineState: 'user_aborted' });
    const def = makeDefinition({
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'user_aborted' }],
        },
        user_aborted: { type: 'terminal', description: 'a' },
      },
    });
    expect(computePastRunPhase(cp, def, false)).toBe('aborted');
  });

  it('returns "waiting_human" when stopped at a human_gate state', () => {
    const cp = makeCheckpoint({ machineState: 'review' });
    const def = makeDefinition({
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'review' }],
        },
        review: {
          type: 'human_gate',
          description: 'review',
          acceptedEvents: ['APPROVE', 'ABORT'],
          transitions: [
            { to: 'done', event: 'APPROVE' },
            { to: 'done', event: 'ABORT' },
          ],
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
    expect(computePastRunPhase(cp, def, false)).toBe('waiting_human');
  });

  it('returns "interrupted" for a non-live, non-terminal, non-gate state', () => {
    const cp = makeCheckpoint({ machineState: 'plan' });
    const def = makeDefinition();
    expect(computePastRunPhase(cp, def, false)).toBe('interrupted');
  });

  it('short-circuits via finalStatus.phase when present (B3b post-B)', () => {
    const cp = makeCheckpoint({
      machineState: 'plan', // heuristic would say 'interrupted'
      finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
    });
    const def = makeDefinition();
    // Short-circuit wins over the state-name heuristic.
    expect(computePastRunPhase(cp, def, false)).toBe('completed');
  });

  it('falls through to state-name heuristic when finalStatus is absent (legacy pre-B3b)', () => {
    const cp = makeCheckpoint({ machineState: 'done', finalStatus: undefined });
    const def = makeDefinition({
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'finished' },
      },
    });
    expect(computePastRunPhase(cp, def, false)).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// synthesizePhaseFromMessageLog
// ---------------------------------------------------------------------------

describe('synthesizePhaseFromMessageLog', () => {
  const workflowId = 'wf-synth' as const;

  /**
   * Helper to build a `state_transition` entry. The orchestrator stores the
   * destination state name in the `event` field (see orchestrator.ts line
   * 1257-1262); `from` carries the previous state.
   */
  function transitionTo(to: string, from: string, ts: string): MessageLogEntry {
    return {
      type: 'state_transition',
      ts,
      workflowId,
      state: from,
      from,
      event: to,
    };
  }

  function defWithStates(states: WorkflowDefinition['states'], initial = 'start'): WorkflowDefinition {
    return {
      name: 'synth-test',
      description: 'synth-test description',
      initial,
      states,
    };
  }

  it('returns "interrupted" for empty entries (case 1)', () => {
    const def = defWithStates({
      start: {
        type: 'agent',
        description: 's',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });
    expect(synthesizePhaseFromMessageLog([], def)).toBe('interrupted');
  });

  it('returns "aborted" when last transition lands on a terminal state named "aborted" (case 2)', () => {
    const def = defWithStates({
      start: {
        type: 'agent',
        description: 's',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'aborted' }],
      },
      aborted: { type: 'terminal', description: 'terminated' },
    });
    const entries: MessageLogEntry[] = [transitionTo('aborted', 'start', '2026-04-23T10:00:00.000Z')];
    expect(synthesizePhaseFromMessageLog(entries, def)).toBe('aborted');
  });

  it('returns "completed" when last transition lands on a terminal state named "done" (case 3)', () => {
    const def = defWithStates({
      start: {
        type: 'agent',
        description: 's',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'done' }],
      },
      done: { type: 'terminal', description: 'finished' },
    });
    const entries: MessageLogEntry[] = [transitionTo('done', 'start', '2026-04-23T10:00:00.000Z')];
    expect(synthesizePhaseFromMessageLog(entries, def)).toBe('completed');
  });

  it('returns "waiting_human" when last transition lands on a human_gate state (case 4)', () => {
    const def = defWithStates({
      start: {
        type: 'agent',
        description: 's',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'review' }],
      },
      review: {
        type: 'human_gate',
        description: 'review gate',
        acceptedEvents: ['APPROVE', 'ABORT'],
        transitions: [
          { to: 'done', event: 'APPROVE' },
          { to: 'done', event: 'ABORT' },
        ],
      },
      done: { type: 'terminal', description: 'd' },
    });
    const entries: MessageLogEntry[] = [transitionTo('review', 'start', '2026-04-23T10:00:00.000Z')];
    expect(synthesizePhaseFromMessageLog(entries, def)).toBe('waiting_human');
  });

  it('returns "interrupted" when entries exist but none are state_transition (case 5)', () => {
    const def = defWithStates({
      start: {
        type: 'agent',
        description: 's',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });
    const entries: MessageLogEntry[] = [
      {
        type: 'agent_sent',
        ts: '2026-04-23T10:00:00.000Z',
        workflowId,
        state: 'start',
        role: 'planner',
        message: 'hello',
      },
      {
        type: 'agent_received',
        ts: '2026-04-23T10:00:01.000Z',
        workflowId,
        state: 'start',
        role: 'planner',
        message: 'ok',
        verdict: null,
        confidence: null,
      },
    ];
    expect(synthesizePhaseFromMessageLog(entries, def)).toBe('interrupted');
  });

  it('returns "aborted" when last state is non-terminal and a quota_exhausted follows (case 6)', () => {
    const def = defWithStates({
      start: {
        type: 'agent',
        description: 's',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'plan' }],
      },
      plan: {
        type: 'agent',
        description: 'p',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });
    const entries: MessageLogEntry[] = [
      transitionTo('plan', 'start', '2026-04-23T10:00:00.000Z'),
      {
        type: 'quota_exhausted',
        ts: '2026-04-23T10:05:00.000Z',
        workflowId,
        state: 'plan',
        role: 'planner',
        rawMessage: 'rate limit hit',
      },
    ];
    expect(synthesizePhaseFromMessageLog(entries, def)).toBe('aborted');
  });

  it('returns "failed" when last state is non-terminal and an error follows with no quota (case 7)', () => {
    const def = defWithStates({
      start: {
        type: 'agent',
        description: 's',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'plan' }],
      },
      plan: {
        type: 'agent',
        description: 'p',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });
    const entries: MessageLogEntry[] = [
      transitionTo('plan', 'start', '2026-04-23T10:00:00.000Z'),
      {
        type: 'error',
        ts: '2026-04-23T10:05:00.000Z',
        workflowId,
        state: 'plan',
        error: 'agent crashed',
      },
    ];
    expect(synthesizePhaseFromMessageLog(entries, def)).toBe('failed');
  });

  it('returns "interrupted" when last state is non-terminal and no post-transition events exist (case 8)', () => {
    const def = defWithStates({
      start: {
        type: 'agent',
        description: 's',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'plan' }],
      },
      plan: {
        type: 'agent',
        description: 'p',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });
    const entries: MessageLogEntry[] = [transitionTo('plan', 'start', '2026-04-23T10:00:00.000Z')];
    expect(synthesizePhaseFromMessageLog(entries, def)).toBe('interrupted');
  });

  it('picks the latest transition by ts, not by array index', () => {
    // Out-of-order array: a newer transition appears before an older one.
    // The helper uses ts comparison, so the terminal "done" (ts=11:00) wins.
    const def = defWithStates({
      start: {
        type: 'agent',
        description: 's',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'plan' }, { to: 'done' }],
      },
      plan: {
        type: 'agent',
        description: 'p',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'done' }],
      },
      done: { type: 'terminal', description: 'finished' },
    });
    const entries: MessageLogEntry[] = [
      transitionTo('done', 'plan', '2026-04-23T11:00:00.000Z'), // latest ts, but first in array
      transitionTo('plan', 'start', '2026-04-23T10:00:00.000Z'),
    ];
    expect(synthesizePhaseFromMessageLog(entries, def)).toBe('completed');
  });

  it('returns "aborted" when last state is non-terminal and a transient_failure follows', () => {
    // Mirrors the quota_exhausted case for the new transient-failure
    // signal: a checkpoint-less past run that aborted via the transient
    // path must classify as `'aborted'` (not `'interrupted'`) so the
    // past-runs UI labels it correctly.
    const def = defWithStates({
      start: {
        type: 'agent',
        description: 's',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'plan' }],
      },
      plan: {
        type: 'agent',
        description: 'p',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });
    const entries: MessageLogEntry[] = [
      transitionTo('plan', 'start', '2026-04-23T10:00:00.000Z'),
      {
        type: 'transient_failure',
        ts: '2026-04-23T10:05:00.000Z',
        workflowId,
        state: 'plan',
        role: 'planner',
        kind: 'degenerate_response',
        rawMessage: '{"usage":{"output_tokens":0},"stop_reason":null}',
      },
    ];
    expect(synthesizePhaseFromMessageLog(entries, def)).toBe('aborted');
  });

  it('prefers "aborted" over "failed" when both quota_exhausted and error follow the last transition', () => {
    const def = defWithStates({
      start: {
        type: 'agent',
        description: 's',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'plan' }],
      },
      plan: {
        type: 'agent',
        description: 'p',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });
    const entries: MessageLogEntry[] = [
      transitionTo('plan', 'start', '2026-04-23T10:00:00.000Z'),
      {
        type: 'error',
        ts: '2026-04-23T10:05:00.000Z',
        workflowId,
        state: 'plan',
        error: 'agent crashed',
      },
      {
        type: 'quota_exhausted',
        ts: '2026-04-23T10:06:00.000Z',
        workflowId,
        state: 'plan',
        role: 'planner',
        rawMessage: 'rate limit hit',
      },
    ];
    expect(synthesizePhaseFromMessageLog(entries, def)).toBe('aborted');
  });

  it('prefers "aborted" over "failed" when both transient_failure and error follow the last transition', () => {
    // Symmetric to the quota_exhausted + error precedence test above:
    // the new transient_failure signal must also outrank a generic
    // error entry in phase synthesis.
    const def = defWithStates({
      start: {
        type: 'agent',
        description: 's',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'plan' }],
      },
      plan: {
        type: 'agent',
        description: 'p',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });
    const entries: MessageLogEntry[] = [
      transitionTo('plan', 'start', '2026-04-23T10:00:00.000Z'),
      {
        type: 'error',
        ts: '2026-04-23T10:05:00.000Z',
        workflowId,
        state: 'plan',
        error: 'agent crashed',
      },
      {
        type: 'transient_failure',
        ts: '2026-04-23T10:06:00.000Z',
        workflowId,
        state: 'plan',
        role: 'planner',
        kind: 'degenerate_response',
        rawMessage: '{"usage":{"output_tokens":0},"stop_reason":null}',
      },
    ];
    expect(synthesizePhaseFromMessageLog(entries, def)).toBe('aborted');
  });

  it('ignores events that occurred BEFORE the last transition', () => {
    // quota_exhausted at ts=09:00 predates the transition at ts=10:00; ignored.
    const def = defWithStates({
      start: {
        type: 'agent',
        description: 's',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'plan' }],
      },
      plan: {
        type: 'agent',
        description: 'p',
        persona: 'global',
        prompt: 'p',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });
    const entries: MessageLogEntry[] = [
      {
        type: 'quota_exhausted',
        ts: '2026-04-23T09:00:00.000Z',
        workflowId,
        state: 'start',
        role: 'planner',
        rawMessage: 'earlier quota issue',
      },
      transitionTo('plan', 'start', '2026-04-23T10:00:00.000Z'),
    ];
    // No events after the last transition → interrupted.
    expect(synthesizePhaseFromMessageLog(entries, def)).toBe('interrupted');
  });
});

// ---------------------------------------------------------------------------
// buildDetailFromPastRun
// ---------------------------------------------------------------------------

describe('buildDetailFromPastRun', () => {
  it('produces a WorkflowDetailDto with synthesized "interrupted" phase', () => {
    const id = 'wf-001' as WorkflowId;
    const cp = makeCheckpoint({ machineState: 'plan' });
    const def = makeDefinition();

    const dto = buildDetailFromPastRun(
      id,
      makeLoad({ checkpoint: cp, definition: def }),
      makeSummary({ workflowId: id }),
    );

    expect(dto.workflowId).toBe(id);
    expect(dto.name).toBe('test-flow');
    expect(dto.phase).toBe('interrupted');
    expect(dto.currentState).toBe('plan');
    expect(dto.taskDescription).toBe('do the thing');
    expect(dto.round).toBe(2);
    expect(dto.maxRounds).toBe(4);
    expect(dto.totalTokens).toBe(1234);
    expect(dto.startedAt).toBe('2026-04-23T10:00:00.000Z');
    expect(dto.workspacePath).toBe('/tmp/workspace');
    expect(dto.gate).toBeUndefined();
    expect(dto.error).toBeUndefined();
  });

  it('surfaces context.lastError as the DTO error for non-completed runs', () => {
    const id = 'wf-002' as WorkflowId;
    const cp = makeCheckpoint({
      machineState: 'plan',
      context: makeContext({ lastError: 'agent crashed' }),
    });
    const def = makeDefinition();

    const dto = buildDetailFromPastRun(
      id,
      makeLoad({ checkpoint: cp, definition: def }),
      makeSummary({ workflowId: id }),
    );
    expect(dto.phase).toBe('interrupted');
    expect(dto.error).toBe('agent crashed');
  });

  it('omits error for completed runs even if context.lastError is set', () => {
    const id = 'wf-003' as WorkflowId;
    const cp = makeCheckpoint({
      machineState: 'done',
      context: makeContext({ lastError: 'stale residual error' }),
    });
    const def = makeDefinition();

    const dto = buildDetailFromPastRun(
      id,
      makeLoad({ checkpoint: cp, definition: def }),
      makeSummary({ workflowId: id }),
    );
    expect(dto.phase).toBe('completed');
    expect(dto.error).toBeUndefined();
  });

  it('falls back to empty workspacePath when checkpoint has none', () => {
    const id = 'wf-004' as WorkflowId;
    const cp = makeCheckpoint({ workspacePath: undefined });
    const def = makeDefinition();

    const dto = buildDetailFromPastRun(
      id,
      makeLoad({ checkpoint: cp, definition: def }),
      makeSummary({ workflowId: id }),
    );
    expect(dto.workspacePath).toBe('');
  });

  it('builds a state graph from the definition', () => {
    const id = 'wf-005' as WorkflowId;
    const cp = makeCheckpoint();
    const def = makeDefinition();

    const dto = buildDetailFromPastRun(
      id,
      makeLoad({ checkpoint: cp, definition: def }),
      makeSummary({ workflowId: id }),
    );
    expect(dto.stateGraph.states.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Checkpoint-less branch (B8 / D7)
  // -------------------------------------------------------------------------

  describe('without checkpoint', () => {
    let baseDir: string;

    beforeEach(() => {
      baseDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-detail-nocp-'));
    });

    afterEach(() => {
      rmSync(baseDir, { recursive: true, force: true });
    });

    it('synthesizes phase from message log for a terminal-state transition', () => {
      const id = 'wf-no-cp-1' as WorkflowId;
      const def = makeDefinition({
        initial: 'plan',
        states: {
          plan: {
            type: 'agent',
            description: 'p',
            persona: 'global',
            prompt: 'p',
            inputs: [],
            outputs: ['plan'],
            transitions: [{ to: 'aborted' }],
          },
          aborted: { type: 'terminal', description: 'a' },
        },
      });
      const messages: MessageLogEntry[] = [
        {
          type: 'state_transition',
          ts: '2026-04-23T11:00:00.000Z',
          workflowId: id,
          state: 'plan',
          from: 'plan',
          event: 'aborted',
        },
      ];
      const messageLogPath = writeMessageLogFile(baseDir, id, messages);
      const summaryMtime = new Date('2026-04-23T11:30:00.000Z');

      const dto = buildDetailFromPastRun(
        id,
        makeLoad({ checkpoint: undefined, definition: def, messageLogPath }),
        makeSummary({ workflowId: id, baseDir, mtime: summaryMtime }),
      );

      expect(dto.phase).toBe('aborted');
      expect(dto.currentState).toBe('aborted');
      expect(dto.startedAt).toBe(summaryMtime.toISOString());
      expect(dto.taskDescription).toBe(def.description);
      expect(dto.description).toBe(def.description);
      expect(dto.round).toBe(0);
      expect(dto.maxRounds).toBe(0);
      expect(dto.totalTokens).toBe(0);
      expect(dto.latestVerdict).toBeUndefined();
      expect(dto.error).toBeUndefined();
      expect(dto.workspacePath).toBe('');
      expect(dto.gate).toBeUndefined();
      // No persisted history on disk; live log entries are surfaced via
      // workflows.messageLog and must not be double-rendered here.
      expect(dto.transitionHistory).toEqual([]);
      // State graph still rendered from the definition.
      expect(dto.stateGraph.states.length).toBeGreaterThan(0);
    });

    it('falls back to definition.initial when no state_transition entries exist', () => {
      const id = 'wf-no-cp-2' as WorkflowId;
      const def = makeDefinition();
      const messageLogPath = writeMessageLogFile(baseDir, id, []);
      const dto = buildDetailFromPastRun(
        id,
        makeLoad({ checkpoint: undefined, definition: def, messageLogPath }),
        makeSummary({ workflowId: id, baseDir }),
      );
      expect(dto.currentState).toBe(def.initial);
      // Empty log → 'interrupted' per synthesizePhaseFromMessageLog case 1.
      expect(dto.phase).toBe('interrupted');
    });
  });
});

// ---------------------------------------------------------------------------
// workflows.get -- live path (backwards compatibility)
// ---------------------------------------------------------------------------

describe('workflows.get -- live path', () => {
  it('returns a detail DTO for a running workflow', async () => {
    const id = 'wf-live' as WorkflowId;
    const ctx = createContext({
      controller: {
        getStatus: vi.fn().mockReturnValue(makeRunningStatus('plan')),
        getDetail: vi.fn().mockReturnValue(makeDetail()),
      },
    });

    const result = (await workflowDispatch(ctx, 'workflows.get', { workflowId: id })) as {
      workflowId: string;
      phase: string;
      taskDescription: string;
      round: number;
      maxRounds: number;
      totalTokens: number;
      currentState: string;
    };

    expect(result.workflowId).toBe(id);
    expect(result.phase).toBe('running');
    expect(result.currentState).toBe('plan');
    expect(result.taskDescription).toBe('do the thing');
    expect(result.round).toBe(2);
    expect(result.maxRounds).toBe(4);
    expect(result.totalTokens).toBe(1234);
  });

  it('populates `error` from the live status for failed runs', async () => {
    const id = 'wf-failed' as WorkflowId;
    const ctx = createContext({
      controller: {
        getStatus: vi.fn().mockReturnValue(makeFailedStatus('disk full', 'plan')),
        getDetail: vi.fn().mockReturnValue(makeDetail()),
      },
    });

    const result = (await workflowDispatch(ctx, 'workflows.get', { workflowId: id })) as {
      phase: string;
      error?: string;
    };

    expect(result.phase).toBe('failed');
    expect(result.error).toBe('disk full');
  });

  it('does not call loadPastRun when the live status is present', async () => {
    const id = 'wf-live-2' as WorkflowId;
    const loadPastRun = vi.fn();
    const ctx = createContext({
      controller: {
        getStatus: vi.fn().mockReturnValue(makeRunningStatus('plan')),
        getDetail: vi.fn().mockReturnValue(makeDetail()),
      },
      loadPastRun,
    });

    await workflowDispatch(ctx, 'workflows.get', { workflowId: id });
    expect(loadPastRun).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// workflows.get -- disk fallback path
// ---------------------------------------------------------------------------

describe('workflows.get -- disk fallback', () => {
  it('returns a detail DTO synthesized from disk when no live status exists', async () => {
    const id = 'wf-disk' as WorkflowId;
    const cp = makeCheckpoint({ machineState: 'plan' });
    const def = makeDefinition();
    const ctx = createContext({
      loadPastRun: () => makeLoad({ checkpoint: cp, definition: def }),
    });

    const result = (await workflowDispatch(ctx, 'workflows.get', { workflowId: id })) as {
      workflowId: string;
      phase: string;
      taskDescription: string;
      currentState: string;
      startedAt: string;
    };

    expect(result.workflowId).toBe(id);
    // Mid-run state, not live -> 'interrupted' per D1.
    expect(result.phase).toBe('interrupted');
    expect(result.currentState).toBe('plan');
    expect(result.taskDescription).toBe('do the thing');
    expect(result.startedAt).toBe('2026-04-23T10:00:00.000Z');
  });

  it('maps a terminal-state checkpoint to phase "completed"', async () => {
    const id = 'wf-completed' as WorkflowId;
    const cp = makeCheckpoint({ machineState: 'done' });
    const def = makeDefinition();
    const ctx = createContext({
      loadPastRun: () => makeLoad({ checkpoint: cp, definition: def }),
    });

    const result = (await workflowDispatch(ctx, 'workflows.get', { workflowId: id })) as {
      phase: string;
      currentState: string;
    };

    expect(result.phase).toBe('completed');
    expect(result.currentState).toBe('done');
  });

  it('throws WORKFLOW_NOT_FOUND when neither live nor disk has the workflow', async () => {
    const id = 'wf-missing' as WorkflowId;
    const ctx = createContext({
      loadPastRun: () => ({ error: 'not_found' }),
    });

    let caught: unknown;
    try {
      await workflowDispatch(ctx, 'workflows.get', { workflowId: id });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as RpcError).code).toBe('WORKFLOW_NOT_FOUND');
  });

  it('throws WORKFLOW_CORRUPTED with the loader message when the checkpoint is corrupt', async () => {
    const id = 'wf-corrupt' as WorkflowId;
    const ctx = createContext({
      loadPastRun: () => ({ error: 'corrupted', message: 'bad JSON at line 3' }),
    });

    let caught: unknown;
    try {
      await workflowDispatch(ctx, 'workflows.get', { workflowId: id });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RpcError);
    const err = caught as RpcError;
    expect(err.code).toBe('WORKFLOW_CORRUPTED');
    expect(err.message).toContain('bad JSON at line 3');
  });

  it('throws WORKFLOW_CORRUPTED with a fallback message when the loader omits one', async () => {
    const id = 'wf-corrupt-2' as WorkflowId;
    const ctx = createContext({
      loadPastRun: () => ({ error: 'corrupted' }),
    });

    let caught: unknown;
    try {
      await workflowDispatch(ctx, 'workflows.get', { workflowId: id });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as RpcError).code).toBe('WORKFLOW_CORRUPTED');
    expect((caught as RpcError).message).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// buildPastRunDto (B4)
// ---------------------------------------------------------------------------

describe('buildPastRunDto', () => {
  it('produces all widened PastRunDto fields for an interrupted run', () => {
    const id = 'wf-100' as WorkflowId;
    const cp = makeCheckpoint({ machineState: 'plan' });
    const def = makeDefinition();

    const dto = buildPastRunDto(id, makeLoad({ checkpoint: cp, definition: def }), makeSummary({ workflowId: id }));

    expect(dto.workflowId).toBe(id);
    expect(dto.name).toBe('test-flow');
    expect(dto.phase).toBe('interrupted');
    expect(dto.currentState).toBe('plan');
    expect(dto.lastState).toBe('plan');
    expect(dto.taskDescription).toBe('do the thing');
    expect(dto.round).toBe(2);
    expect(dto.maxRounds).toBe(4);
    expect(dto.totalTokens).toBe(1234);
    expect(dto.timestamp).toBe('2026-04-23T10:00:00.000Z');
    expect(dto.workspacePath).toBe('/tmp/workspace');
    expect(dto.error).toBeUndefined();
    expect(dto.latestVerdict).toBeUndefined();
  });

  it('maps a terminal-state checkpoint to phase "completed"', () => {
    const id = 'wf-101' as WorkflowId;
    const cp = makeCheckpoint({ machineState: 'done' });
    const def = makeDefinition();

    const dto = buildPastRunDto(id, makeLoad({ checkpoint: cp, definition: def }), makeSummary({ workflowId: id }));
    expect(dto.phase).toBe('completed');
    expect(dto.currentState).toBe('done');
    expect(dto.lastState).toBe('done');
  });

  it('surfaces context.lastError for failed/interrupted runs', () => {
    const id = 'wf-102' as WorkflowId;
    const cp = makeCheckpoint({
      machineState: 'plan',
      context: makeContext({ lastError: 'boom' }),
    });
    const dto = buildPastRunDto(id, makeLoad({ checkpoint: cp }), makeSummary({ workflowId: id }));
    expect(dto.error).toBe('boom');
  });

  it('omits error for completed runs', () => {
    const id = 'wf-103' as WorkflowId;
    const cp = makeCheckpoint({
      machineState: 'done',
      context: makeContext({ lastError: 'stale residual error' }),
    });
    const dto = buildPastRunDto(id, makeLoad({ checkpoint: cp }), makeSummary({ workflowId: id }));
    expect(dto.phase).toBe('completed');
    expect(dto.error).toBeUndefined();
  });

  it('coerces a race-with-start "running" phase to "interrupted" to keep the DTO well-typed', () => {
    const id = 'wf-104' as WorkflowId;
    const cp = makeCheckpoint({ machineState: 'plan' });
    // computePastRunPhase returns 'running' when isLive=true; PastRunDto.phase
    // excludes 'running', so buildPastRunDto must coerce.
    const dto = buildPastRunDto(id, makeLoad({ checkpoint: cp, isLive: true }), makeSummary({ workflowId: id }));
    expect(dto.phase).toBe('interrupted');
  });

  it('leaves durationMs undefined because checkpoints do not persist start/end timestamps', () => {
    const id = 'wf-105' as WorkflowId;
    const cp = makeCheckpoint();
    const dto = buildPastRunDto(id, makeLoad({ checkpoint: cp }), makeSummary({ workflowId: id }));
    expect(dto.durationMs).toBeUndefined();
  });

  it('leaves workspacePath undefined when checkpoint has none', () => {
    const id = 'wf-106' as WorkflowId;
    const cp = makeCheckpoint({ workspacePath: undefined });
    const dto = buildPastRunDto(id, makeLoad({ checkpoint: cp }), makeSummary({ workflowId: id }));
    expect(dto.workspacePath).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Checkpoint-less branch (B7 / D7)
  // -------------------------------------------------------------------------

  describe('without checkpoint', () => {
    let baseDir: string;

    beforeEach(() => {
      baseDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-pastrun-nocp-'));
    });

    afterEach(() => {
      rmSync(baseDir, { recursive: true, force: true });
    });

    it('synthesizes phase + state from message log; timestamp from summary mtime', () => {
      const id = 'wf-no-cp-pr-1' as WorkflowId;
      const def = makeDefinition({
        initial: 'plan',
        states: {
          plan: {
            type: 'agent',
            description: 'p',
            persona: 'global',
            prompt: 'p',
            inputs: [],
            outputs: ['plan'],
            transitions: [{ to: 'aborted' }],
          },
          aborted: { type: 'terminal', description: 'a' },
        },
      });
      const messages: MessageLogEntry[] = [
        {
          type: 'state_transition',
          ts: '2026-04-23T11:00:00.000Z',
          workflowId: id,
          state: 'plan',
          from: 'plan',
          event: 'aborted',
        },
      ];
      const messageLogPath = writeMessageLogFile(baseDir, id, messages);
      const summaryMtime = new Date('2026-04-23T11:30:00.000Z');

      const dto = buildPastRunDto(
        id,
        makeLoad({ checkpoint: undefined, definition: def, messageLogPath }),
        makeSummary({ workflowId: id, baseDir, mtime: summaryMtime }),
      );

      expect(dto.phase).toBe('aborted');
      expect(dto.currentState).toBe('aborted');
      expect(dto.lastState).toBe('aborted');
      expect(dto.timestamp).toBe(summaryMtime.toISOString());
      expect(dto.taskDescription).toBe(def.description);
      expect(dto.round).toBe(0);
      expect(dto.maxRounds).toBe(0);
      expect(dto.totalTokens).toBe(0);
      expect(dto.latestVerdict).toBeUndefined();
      expect(dto.error).toBeUndefined();
      expect(dto.workspacePath).toBeUndefined();
      expect(dto.durationMs).toBeUndefined();
      expect(dto.name).toBe(def.name);
    });

    it('falls back to definition.initial when no state_transition entries exist', () => {
      const id = 'wf-no-cp-pr-2' as WorkflowId;
      const def = makeDefinition();
      const messageLogPath = writeMessageLogFile(baseDir, id, []);
      const dto = buildPastRunDto(
        id,
        makeLoad({ checkpoint: undefined, definition: def, messageLogPath }),
        makeSummary({ workflowId: id, baseDir }),
      );
      expect(dto.currentState).toBe(def.initial);
      expect(dto.lastState).toBe(def.initial);
      expect(dto.phase).toBe('interrupted');
    });
  });
});

// ---------------------------------------------------------------------------
// workflows.listResumable (B4)
// ---------------------------------------------------------------------------

describe('workflows.listResumable', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-listres-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('returns widened PastRunDto rows for every directory enumerated under baseDir', async () => {
    const idA = 'wf-A' as WorkflowId;
    const idB = 'wf-B' as WorkflowId;
    const cpA = makeCheckpoint({ machineState: 'plan', timestamp: '2026-04-22T09:00:00.000Z' });
    const cpB = makeCheckpoint({ machineState: 'done', timestamp: '2026-04-23T11:00:00.000Z' });
    const def = makeDefinition();
    seedRunDirectory(baseDir, idA, { definition: def, checkpoint: cpA });
    seedRunDirectory(baseDir, idB, { definition: def, checkpoint: cpB });

    const ctx = createContext({
      baseDir,
      controller: { listActive: vi.fn().mockReturnValue([]) },
      loadPastRun: (id) => {
        if (id === idA) return makeLoad({ checkpoint: cpA, definition: def });
        if (id === idB) return makeLoad({ checkpoint: cpB, definition: def });
        return { error: 'not_found' };
      },
    });

    const dtos = (await workflowDispatch(ctx, 'workflows.listResumable', {})) as PastRunDto[];

    expect(dtos).toHaveLength(2);
    // Sorted by timestamp descending: B (2026-04-23) before A (2026-04-22).
    expect(dtos[0].workflowId).toBe(idB);
    expect(dtos[0].phase).toBe('completed');
    expect(dtos[1].workflowId).toBe(idA);
    expect(dtos[1].phase).toBe('interrupted');
    // Widened fields populated on every row.
    for (const dto of dtos) {
      expect(dto.name).toBe('test-flow');
      expect(dto.taskDescription).toBe('do the thing');
      expect(dto.round).toBe(2);
      expect(dto.maxRounds).toBe(4);
      expect(dto.totalTokens).toBe(1234);
    }
  });

  it('skips a corrupted checkpoint with a logger warning and still returns the other rows', async () => {
    const idGood = 'wf-good' as WorkflowId;
    const idBad = 'wf-bad' as WorkflowId;
    const cp = makeCheckpoint({ machineState: 'plan' });
    seedRunDirectory(baseDir, idGood, { definition: makeDefinition(), checkpoint: cp });
    seedRunDirectory(baseDir, idBad, { definition: makeDefinition(), checkpoint: cp });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const ctx = createContext({
      baseDir,
      controller: { listActive: vi.fn().mockReturnValue([]) },
      loadPastRun: (id) => {
        if (id === idGood) return makeLoad({ checkpoint: cp, definition: makeDefinition() });
        return { error: 'corrupted', message: 'bad JSON at line 3' };
      },
    });

    const dtos = (await workflowDispatch(ctx, 'workflows.listResumable', {})) as PastRunDto[];

    expect(dtos).toHaveLength(1);
    expect(dtos[0].workflowId).toBe(idGood);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(idBad);
    expect(warnSpy.mock.calls[0][0]).toContain('bad JSON at line 3');
    warnSpy.mockRestore();
  });

  it('skips a not_found row silently (e.g. directory with no loadable definition)', async () => {
    const idMissing = 'wf-missing' as WorkflowId;
    seedRunDirectory(baseDir, idMissing, { messages: [] });
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const ctx = createContext({
      baseDir,
      controller: { listActive: vi.fn().mockReturnValue([]) },
      loadPastRun: () => ({ error: 'not_found' }),
    });

    const dtos = (await workflowDispatch(ctx, 'workflows.listResumable', {})) as PastRunDto[];

    expect(dtos).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('synthesizes phase "interrupted" for a non-terminal row that is not active', async () => {
    const id = 'wf-int' as WorkflowId;
    const cp = makeCheckpoint({ machineState: 'plan' });
    seedRunDirectory(baseDir, id, { definition: makeDefinition(), checkpoint: cp });
    const ctx = createContext({
      baseDir,
      controller: { listActive: vi.fn().mockReturnValue([]) },
      loadPastRun: () => makeLoad({ checkpoint: cp, definition: makeDefinition() }),
    });

    const dtos = (await workflowDispatch(ctx, 'workflows.listResumable', {})) as PastRunDto[];

    expect(dtos).toHaveLength(1);
    expect(dtos[0].phase).toBe('interrupted');
  });

  it('passes through terminal phases correctly (completed, aborted, waiting_human)', async () => {
    const idDone = 'wf-done' as WorkflowId;
    const idAbort = 'wf-abort' as WorkflowId;
    const idGate = 'wf-gate' as WorkflowId;
    const def = makeDefinition({
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'review' }],
        },
        review: {
          type: 'human_gate',
          description: 'review',
          acceptedEvents: ['APPROVE', 'ABORT'],
          transitions: [
            { to: 'done', event: 'APPROVE' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        done: { type: 'terminal', description: 'd' },
        aborted: { type: 'terminal', description: 'a' },
      },
    });
    seedRunDirectory(baseDir, idDone, {
      definition: def,
      checkpoint: makeCheckpoint({ machineState: 'done', timestamp: '2026-04-23T03:00:00.000Z' }),
    });
    seedRunDirectory(baseDir, idAbort, {
      definition: def,
      checkpoint: makeCheckpoint({ machineState: 'aborted', timestamp: '2026-04-23T02:00:00.000Z' }),
    });
    seedRunDirectory(baseDir, idGate, {
      definition: def,
      checkpoint: makeCheckpoint({ machineState: 'review', timestamp: '2026-04-23T01:00:00.000Z' }),
    });
    const ctx = createContext({
      baseDir,
      controller: { listActive: vi.fn().mockReturnValue([]) },
      loadPastRun: (id) => {
        if (id === idDone) {
          return makeLoad({
            checkpoint: makeCheckpoint({ machineState: 'done', timestamp: '2026-04-23T03:00:00.000Z' }),
            definition: def,
          });
        }
        if (id === idAbort) {
          return makeLoad({
            checkpoint: makeCheckpoint({ machineState: 'aborted', timestamp: '2026-04-23T02:00:00.000Z' }),
            definition: def,
          });
        }
        return makeLoad({
          checkpoint: makeCheckpoint({ machineState: 'review', timestamp: '2026-04-23T01:00:00.000Z' }),
          definition: def,
        });
      },
    });

    const dtos = (await workflowDispatch(ctx, 'workflows.listResumable', {})) as PastRunDto[];

    expect(dtos).toHaveLength(3);
    const byId = new Map(dtos.map((d) => [d.workflowId, d]));
    expect(byId.get(idDone)?.phase).toBe('completed');
    expect(byId.get(idAbort)?.phase).toBe('aborted');
    expect(byId.get(idGate)?.phase).toBe('waiting_human');
  });

  it('surfaces a transient-aborted run as phase "aborted" in listResumable (resume-eligibility)', async () => {
    // The orchestrator forces `finalStatus.phase = 'aborted'` when the
    // adapter reports `transientFailure`, even when the workflow's only
    // terminal is `done`. listResumable must surface that as 'aborted'
    // (via computePastRunPhase short-circuiting on finalStatus.phase) so
    // the past-runs UI shows a Resume affordance for the row.
    const id = 'wf-transient-aborted' as WorkflowId;
    const def = makeDefinition({
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'finished' },
      },
    });
    // Checkpoint preserves the failing agent state's machineState (the
    // orchestrator does NOT overwrite it on transient abort) and
    // stamps finalStatus.phase = 'aborted'.
    const cp = makeCheckpoint({
      machineState: 'plan',
      timestamp: '2026-04-23T15:00:00.000Z',
      finalStatus: { phase: 'aborted', reason: 'Upstream stall: agent returned no content' },
    });
    seedRunDirectory(baseDir, id, { definition: def, checkpoint: cp });

    const ctx = createContext({
      baseDir,
      controller: { listActive: vi.fn().mockReturnValue([]) },
      loadPastRun: () => makeLoad({ checkpoint: cp, definition: def }),
    });

    const dtos = (await workflowDispatch(ctx, 'workflows.listResumable', {})) as PastRunDto[];

    expect(dtos).toHaveLength(1);
    expect(dtos[0].workflowId).toBe(id);
    expect(dtos[0].phase).toBe('aborted');
    // The failing agent state is preserved, so resume can re-enter it.
    expect(dtos[0].currentState).toBe('plan');
  });

  it('leaves durationMs undefined for every row (checkpoint schema gap)', async () => {
    const id = 'wf-dur' as WorkflowId;
    seedRunDirectory(baseDir, id, {
      definition: makeDefinition(),
      checkpoint: makeCheckpoint({ machineState: 'done' }),
    });
    const ctx = createContext({
      baseDir,
      controller: { listActive: vi.fn().mockReturnValue([]) },
      loadPastRun: () =>
        makeLoad({ checkpoint: makeCheckpoint({ machineState: 'done' }), definition: makeDefinition() }),
    });

    const dtos = (await workflowDispatch(ctx, 'workflows.listResumable', {})) as PastRunDto[];
    expect(dtos[0].durationMs).toBeUndefined();
  });

  it('skips a row currently active in controller.listActive() (belongs to workflows.list)', async () => {
    const idLive = 'wf-live' as WorkflowId;
    const idPast = 'wf-past' as WorkflowId;
    const cp = makeCheckpoint({ machineState: 'plan' });
    seedRunDirectory(baseDir, idLive, { definition: makeDefinition(), checkpoint: cp });
    seedRunDirectory(baseDir, idPast, { definition: makeDefinition(), checkpoint: cp });

    const ctx = createContext({
      baseDir,
      controller: { listActive: vi.fn().mockReturnValue([idLive]) },
      loadPastRun: (id) => {
        if (id === idPast) return makeLoad({ checkpoint: cp, definition: makeDefinition() });
        return { error: 'not_found' };
      },
    });

    const dtos = (await workflowDispatch(ctx, 'workflows.listResumable', {})) as PastRunDto[];
    expect(dtos).toHaveLength(1);
    expect(dtos[0].workflowId).toBe(idPast);
  });

  it('end-to-end: mixes live, completed, checkpoint-less, corrupted, and empty rows', async () => {
    const idLive = 'wf-mix-live' as WorkflowId;
    const idCompleted = 'wf-mix-completed' as WorkflowId;
    const idNoCp = 'wf-mix-nocp' as WorkflowId;
    const idCorrupt = 'wf-mix-corrupt' as WorkflowId;
    const idEmpty = 'wf-mix-empty' as WorkflowId;

    const def = makeDefinition({
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'finished' },
      },
    });

    // (a) live row — has a checkpoint, but listActive() includes it; should be skipped.
    seedRunDirectory(baseDir, idLive, {
      definition: def,
      checkpoint: makeCheckpoint({ machineState: 'plan', timestamp: '2026-04-23T20:00:00.000Z' }),
    });
    // (b) completed checkpoint with finalStatus.
    const cpCompleted = makeCheckpoint({
      machineState: 'done',
      timestamp: '2026-04-23T15:00:00.000Z',
      finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
    });
    seedRunDirectory(baseDir, idCompleted, { definition: def, checkpoint: cpCompleted });
    // (c) directory with only definition.json + messages.jsonl (synth phase).
    const synthMessages: MessageLogEntry[] = [
      {
        type: 'state_transition',
        ts: '2026-04-23T12:00:00.000Z',
        workflowId: idNoCp,
        state: 'plan',
        from: 'plan',
        event: 'done',
      },
    ];
    seedRunDirectory(baseDir, idNoCp, { definition: def, messages: synthMessages });
    // (d) corrupted directory — has a checkpoint but the loader will report 'corrupted'.
    seedRunDirectory(baseDir, idCorrupt, { definition: def, checkpoint: makeCheckpoint() });
    // (e) directory with nothing — loader returns 'not_found' silently.
    mkdirSync(resolve(baseDir, idEmpty), { recursive: true });

    // Snapshot mtime after seeding so the assertion can predict the sort.
    const noCpMtime = new Date(statSync(resolve(baseDir, idNoCp)).mtime).toISOString();

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const ctx = createContext({
      baseDir,
      controller: { listActive: vi.fn().mockReturnValue([idLive]) },
      loadPastRun: (id) => {
        if (id === idCompleted) return makeLoad({ checkpoint: cpCompleted, definition: def });
        if (id === idNoCp) {
          return makeLoad({
            checkpoint: undefined,
            definition: def,
            messageLogPath: resolve(baseDir, idNoCp, 'messages.jsonl'),
          });
        }
        if (id === idCorrupt) return { error: 'corrupted', message: 'simulated corruption' };
        // idEmpty (and any other id) → not_found silently.
        return { error: 'not_found' };
      },
    });

    const dtos = (await workflowDispatch(ctx, 'workflows.listResumable', {})) as PastRunDto[];

    // Live row skipped; corrupted/empty rows skipped (corrupted with a warn).
    const ids = dtos.map((d) => d.workflowId);
    expect(ids).toContain(idCompleted);
    expect(ids).toContain(idNoCp);
    expect(ids).not.toContain(idLive);
    expect(ids).not.toContain(idCorrupt);
    expect(ids).not.toContain(idEmpty);
    expect(dtos).toHaveLength(2);

    // Sorted newest-first by `timestamp`. Completed row uses checkpoint.timestamp
    // (2026-04-23T15:00); checkpoint-less row uses summary.mtime (now-ish, set
    // when seedRunDirectory wrote the directory). The mtime is the larger one.
    expect(dtos[0].timestamp >= dtos[1].timestamp).toBe(true);

    // Checkpoint-less row is the synthesized one; assert its synthesized fields.
    const noCpDto = dtos.find((d) => d.workflowId === idNoCp);
    expect(noCpDto).toBeDefined();
    if (noCpDto) {
      expect(noCpDto.phase).toBe('completed');
      expect(noCpDto.currentState).toBe('done');
      expect(noCpDto.timestamp).toBe(noCpMtime);
      expect(noCpDto.round).toBe(0);
      expect(noCpDto.maxRounds).toBe(0);
      expect(noCpDto.totalTokens).toBe(0);
      expect(noCpDto.workspacePath).toBeUndefined();
    }

    const completedDto = dtos.find((d) => d.workflowId === idCompleted);
    expect(completedDto?.phase).toBe('completed');

    // Corrupted row produced a logger.warn; empty (not_found) row did not.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(idCorrupt);
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// workflows.messageLog (B5)
// ---------------------------------------------------------------------------

describe('workflows.messageLog', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-msglog-test-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  /** Writes a JSONL message log for the given workflowId at the standard relative path. */
  function writeMessageLog(workflowId: string, entries: readonly MessageLogEntry[]): void {
    const dir = resolve(baseDir, workflowId);
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, 'messages.jsonl');
    const content = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
    writeFileSync(path, content, 'utf-8');
  }

  /** Builds N synthetic state_transition entries with monotonically increasing timestamps. */
  function makeEntries(workflowId: string, count: number, startMs = 0): MessageLogEntry[] {
    const entries: MessageLogEntry[] = [];
    for (let i = 0; i < count; i++) {
      entries.push({
        type: 'state_transition',
        ts: new Date(1_700_000_000_000 + startMs + i * 1000).toISOString(),
        workflowId,
        state: `state-${i}`,
        from: 'a',
        event: 'NEXT',
      });
    }
    return entries;
  }

  /** Stub a present checkpoint so existence validation passes. */
  function presentLoadPastRun(): () => PastRunLoadResult {
    return () =>
      makeLoad({
        checkpoint: makeCheckpoint(),
        definition: makeDefinition(),
      }) as PastRunLoadResult;
  }

  it('returns an empty page with hasMore=false when the log file is missing', async () => {
    const id = 'wf-empty' as WorkflowId;
    const ctx = createContext({ baseDir, loadPastRun: presentLoadPastRun() });
    const res = (await workflowDispatch(ctx, 'workflows.messageLog', {
      workflowId: id,
    })) as MessageLogResponseDto;
    expect(res.entries).toEqual([]);
    expect(res.hasMore).toBe(false);
  });

  it('returns all entries newest-first with hasMore=false when N < default limit', async () => {
    const id = 'wf-small' as WorkflowId;
    const entries = makeEntries(id, 5);
    writeMessageLog(id, entries);

    const ctx = createContext({ baseDir, loadPastRun: presentLoadPastRun() });
    const res = (await workflowDispatch(ctx, 'workflows.messageLog', {
      workflowId: id,
    })) as MessageLogResponseDto;

    expect(res.entries).toHaveLength(5);
    expect(res.hasMore).toBe(false);
    // Newest-first: ts strictly descending
    for (let i = 1; i < res.entries.length; i++) {
      expect(res.entries[i - 1].ts > res.entries[i].ts).toBe(true);
    }
  });

  it('returns the first 200 newest entries with hasMore=true when N=300 and no before', async () => {
    const id = 'wf-page' as WorkflowId;
    const entries = makeEntries(id, 300);
    writeMessageLog(id, entries);

    const ctx = createContext({ baseDir, loadPastRun: presentLoadPastRun() });
    const res = (await workflowDispatch(ctx, 'workflows.messageLog', {
      workflowId: id,
    })) as MessageLogResponseDto;

    expect(res.entries).toHaveLength(200);
    expect(res.hasMore).toBe(true);
    // First entry of the page is the newest of all 300
    expect(res.entries[0].ts).toBe(entries[299].ts);
    // Last entry of page is the 200th newest = entries[100]
    expect(res.entries[199].ts).toBe(entries[100].ts);
  });

  it('returns the next 100 entries with hasMore=false when paged via before cursor', async () => {
    const id = 'wf-page2' as WorkflowId;
    const entries = makeEntries(id, 300);
    writeMessageLog(id, entries);
    const ctx = createContext({ baseDir, loadPastRun: presentLoadPastRun() });

    const first = (await workflowDispatch(ctx, 'workflows.messageLog', {
      workflowId: id,
    })) as MessageLogResponseDto;
    expect(first.entries).toHaveLength(200);

    const cursor = first.entries[first.entries.length - 1].ts;
    const second = (await workflowDispatch(ctx, 'workflows.messageLog', {
      workflowId: id,
      before: cursor,
    })) as MessageLogResponseDto;

    expect(second.entries).toHaveLength(100);
    expect(second.hasMore).toBe(false);
    // All entries on second page are strictly older than the cursor
    for (const e of second.entries) {
      expect(e.ts < cursor).toBe(true);
    }
    // Newest-first within page
    for (let i = 1; i < second.entries.length; i++) {
      expect(second.entries[i - 1].ts > second.entries[i].ts).toBe(true);
    }
  });

  it('strictly excludes entries with ts equal to the before cursor', async () => {
    const id = 'wf-strict' as WorkflowId;
    const sharedTs = '2026-04-23T12:00:00.000Z';
    const entries: MessageLogEntry[] = [
      { type: 'state_transition', ts: '2026-04-23T11:00:00.000Z', workflowId: id, state: 's0', from: 'a', event: 'E' },
      { type: 'state_transition', ts: sharedTs, workflowId: id, state: 's1', from: 'a', event: 'E' },
      { type: 'state_transition', ts: sharedTs, workflowId: id, state: 's2', from: 'a', event: 'E' },
      { type: 'state_transition', ts: '2026-04-23T13:00:00.000Z', workflowId: id, state: 's3', from: 'a', event: 'E' },
    ];
    writeMessageLog(id, entries);

    const ctx = createContext({ baseDir, loadPastRun: presentLoadPastRun() });
    const res = (await workflowDispatch(ctx, 'workflows.messageLog', {
      workflowId: id,
      before: sharedTs,
    })) as MessageLogResponseDto;

    // Only the 11:00 entry; both sharedTs entries excluded by strict less-than.
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].state).toBe('s0');
  });

  it('orders entries newest-first even when on-disk file is in arbitrary order', async () => {
    const id = 'wf-order' as WorkflowId;
    const entries: MessageLogEntry[] = [
      { type: 'state_transition', ts: '2026-04-23T12:00:00.000Z', workflowId: id, state: 'mid', from: 'a', event: 'E' },
      {
        type: 'state_transition',
        ts: '2026-04-23T10:00:00.000Z',
        workflowId: id,
        state: 'old',
        from: 'a',
        event: 'E',
      },
      {
        type: 'state_transition',
        ts: '2026-04-23T14:00:00.000Z',
        workflowId: id,
        state: 'new',
        from: 'a',
        event: 'E',
      },
    ];
    writeMessageLog(id, entries);

    const ctx = createContext({ baseDir, loadPastRun: presentLoadPastRun() });
    const res = (await workflowDispatch(ctx, 'workflows.messageLog', {
      workflowId: id,
    })) as MessageLogResponseDto;

    expect(res.entries.map((e) => e.state)).toEqual(['new', 'mid', 'old']);
  });

  it('respects an explicit limit smaller than the default', async () => {
    const id = 'wf-explicit' as WorkflowId;
    const entries = makeEntries(id, 10);
    writeMessageLog(id, entries);

    const ctx = createContext({ baseDir, loadPastRun: presentLoadPastRun() });
    const res = (await workflowDispatch(ctx, 'workflows.messageLog', {
      workflowId: id,
      limit: 3,
    })) as MessageLogResponseDto;

    expect(res.entries).toHaveLength(3);
    expect(res.hasMore).toBe(true);
    expect(res.entries[0].ts).toBe(entries[9].ts);
  });

  it('reports hasMore=false when page exactly equals the remaining set', async () => {
    const id = 'wf-exact' as WorkflowId;
    const entries = makeEntries(id, 5);
    writeMessageLog(id, entries);

    const ctx = createContext({ baseDir, loadPastRun: presentLoadPastRun() });
    const res = (await workflowDispatch(ctx, 'workflows.messageLog', {
      workflowId: id,
      limit: 5,
    })) as MessageLogResponseDto;

    // Page is full (5 of limit 5) but no entry is strictly older than the cursor.
    expect(res.entries).toHaveLength(5);
    expect(res.hasMore).toBe(false);
  });

  it('throws WORKFLOW_NOT_FOUND when the workflow is unknown', async () => {
    const id = 'wf-missing' as WorkflowId;
    const ctx = createContext({
      baseDir,
      loadPastRun: () => ({ error: 'not_found' }),
    });

    let caught: unknown;
    try {
      await workflowDispatch(ctx, 'workflows.messageLog', { workflowId: id });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as RpcError).code).toBe('WORKFLOW_NOT_FOUND');
  });

  it('throws WORKFLOW_CORRUPTED with the loader message when the checkpoint is corrupt', async () => {
    const id = 'wf-corrupt' as WorkflowId;
    const ctx = createContext({
      baseDir,
      loadPastRun: () => ({ error: 'corrupted', message: 'bad JSON at line 7' }),
    });

    let caught: unknown;
    try {
      await workflowDispatch(ctx, 'workflows.messageLog', { workflowId: id });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as RpcError).code).toBe('WORKFLOW_CORRUPTED');
    expect((caught as RpcError).message).toContain('bad JSON at line 7');
  });

  it('rejects an over-cap limit with INVALID_PARAMS', async () => {
    const id = 'wf-toobig' as WorkflowId;
    const ctx = createContext({ baseDir, loadPastRun: presentLoadPastRun() });

    let caught: unknown;
    try {
      await workflowDispatch(ctx, 'workflows.messageLog', { workflowId: id, limit: 5000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as RpcError).code).toBe('INVALID_PARAMS');
  });

  it('skips malformed lines in the JSONL log without surfacing an error', async () => {
    const id = 'wf-tolerant' as WorkflowId;
    const validEntries = makeEntries(id, 2);
    const dir = resolve(baseDir, id);
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, 'messages.jsonl');
    // Mix valid lines with a truncated/malformed one in between.
    const content =
      JSON.stringify(validEntries[0]) + '\n' + 'not json at all\n' + JSON.stringify(validEntries[1]) + '\n';
    writeFileSync(path, content, 'utf-8');

    const ctx = createContext({ baseDir, loadPastRun: presentLoadPastRun() });
    const res = (await workflowDispatch(ctx, 'workflows.messageLog', {
      workflowId: id,
    })) as MessageLogResponseDto;
    // Only the two valid entries survive — silent skip is the documented contract.
    expect(res.entries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// workflows.fileTree -- workspace path resolution (live + disk fallback)
//
// `workflows.fileTree`, `.fileContent`, and `.artifacts` all share the same
// `getWorkspacePath()` helper, so testing one RPC end-to-end covers the
// resolution branch for all three.
// ---------------------------------------------------------------------------

describe('workflows.fileTree -- workspace path resolution', () => {
  let baseDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-ws-test-'));
    workspaceDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-ws-content-'));
    // Seed a couple of files so listDirectory has non-empty output.
    writeFileSync(resolve(workspaceDir, 'README.md'), '# hi\n', 'utf-8');
    mkdirSync(resolve(workspaceDir, 'src'), { recursive: true });
    writeFileSync(resolve(workspaceDir, 'src', 'index.ts'), 'export {};\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('uses the live controller detail when the workflow is active', async () => {
    const id = 'wf-live' as WorkflowId;
    // If the live path is honoured, loadPastRun should not be consulted.
    const loadPastRun = vi.fn();
    const ctx = createContext({
      baseDir,
      controller: {
        getDetail: vi.fn().mockReturnValue(makeDetail({ workspacePath: workspaceDir })),
      },
      loadPastRun,
    });

    const res = (await workflowDispatch(ctx, 'workflows.fileTree', {
      workflowId: id,
    })) as { entries: { name: string; type: string }[] };

    expect(loadPastRun).not.toHaveBeenCalled();
    const names = res.entries.map((e) => e.name).sort();
    expect(names).toContain('README.md');
    expect(names).toContain('src');
  });

  it('falls back to the past-run checkpoint workspacePath for non-live workflows', async () => {
    const id = 'wf-past' as WorkflowId;
    const cp = makeCheckpoint({ workspacePath: workspaceDir });
    const ctx = createContext({
      baseDir,
      controller: {
        // No live detail -> forces the disk fallback branch.
        getDetail: vi.fn().mockReturnValue(undefined),
      },
      loadPastRun: () => makeLoad({ checkpoint: cp, definition: makeDefinition() }),
    });

    const res = (await workflowDispatch(ctx, 'workflows.fileTree', {
      workflowId: id,
    })) as { entries: { name: string; type: string }[] };

    const names = res.entries.map((e) => e.name).sort();
    expect(names).toContain('README.md');
    expect(names).toContain('src');
  });

  it('throws WORKFLOW_NOT_FOUND when neither live nor disk has the workflow', async () => {
    const id = 'wf-missing' as WorkflowId;
    const ctx = createContext({
      baseDir,
      controller: { getDetail: vi.fn().mockReturnValue(undefined) },
      loadPastRun: () => ({ error: 'not_found' }),
    });

    let caught: unknown;
    try {
      await workflowDispatch(ctx, 'workflows.fileTree', { workflowId: id });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as RpcError).code).toBe('WORKFLOW_NOT_FOUND');
  });

  it('throws WORKFLOW_NOT_FOUND when the past-run load succeeds but has no checkpoint', async () => {
    const id = 'wf-no-cp' as WorkflowId;
    const ctx = createContext({
      baseDir,
      controller: { getDetail: vi.fn().mockReturnValue(undefined) },
      // checkpoint:undefined is a valid PastRunLoadSuccess shape (message-log-only dir).
      loadPastRun: () => makeLoad({ checkpoint: undefined, definition: makeDefinition() }),
    });

    let caught: unknown;
    try {
      await workflowDispatch(ctx, 'workflows.fileTree', { workflowId: id });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as RpcError).code).toBe('WORKFLOW_NOT_FOUND');
  });

  it('throws WORKFLOW_NOT_FOUND when the checkpoint has no workspacePath', async () => {
    const id = 'wf-no-ws' as WorkflowId;
    // Pre-checkpoint-retention checkpoints can lack workspacePath.
    const cp = makeCheckpoint({ workspacePath: undefined as unknown as string });
    const ctx = createContext({
      baseDir,
      controller: { getDetail: vi.fn().mockReturnValue(undefined) },
      loadPastRun: () => makeLoad({ checkpoint: cp, definition: makeDefinition() }),
    });

    let caught: unknown;
    try {
      await workflowDispatch(ctx, 'workflows.fileTree', { workflowId: id });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as RpcError).code).toBe('WORKFLOW_NOT_FOUND');
  });

  // ── Container-metadata recovery for checkpoint-less runs ─────────────
  //
  // When a past run has no checkpoint but session-metadata.json files
  // remain on disk under `<baseDir>/<id>/containers/*/states/*/`, the
  // helper recovers a workspacePath from the newest entry. Verifies the
  // fallback chain: checkpoint → container metadata → WORKFLOW_NOT_FOUND.

  it('recovers workspacePath from container session metadata for a checkpoint-less past run', async () => {
    const id = 'wf-recovered' as WorkflowId;
    // Seed `<baseDir>/<id>/containers/<container>/states/<state>/session-metadata.json`
    // pointing at the real workspaceDir so listDirectory can read it.
    const stateDir = resolve(baseDir, id, 'containers', 'container-a', 'states', 'planner');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      resolve(stateDir, 'session-metadata.json'),
      JSON.stringify({
        createdAt: '2026-04-23T20:40:44.055Z',
        workspacePath: workspaceDir,
        agentConversationId: 'conv-1',
      }),
      'utf-8',
    );

    const ctx = createContext({
      baseDir,
      controller: { getDetail: vi.fn().mockReturnValue(undefined) },
      // checkpoint:undefined exercises the recovery branch.
      loadPastRun: () => makeLoad({ checkpoint: undefined, definition: makeDefinition() }),
    });

    const res = (await workflowDispatch(ctx, 'workflows.fileTree', {
      workflowId: id,
    })) as { entries: { name: string; type: string }[] };

    const names = res.entries.map((e) => e.name).sort();
    expect(names).toContain('README.md');
    expect(names).toContain('src');
  });

  it('throws WORKFLOW_NOT_FOUND when neither checkpoint nor container metadata yields a workspacePath', async () => {
    const id = 'wf-no-recovery' as WorkflowId;
    // Container directory exists but session-metadata.json is missing.
    mkdirSync(resolve(baseDir, id, 'containers', 'container-a', 'states', 'planner'), { recursive: true });

    const ctx = createContext({
      baseDir,
      controller: { getDetail: vi.fn().mockReturnValue(undefined) },
      loadPastRun: () => makeLoad({ checkpoint: undefined, definition: makeDefinition() }),
    });

    let caught: unknown;
    try {
      await workflowDispatch(ctx, 'workflows.fileTree', { workflowId: id });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as RpcError).code).toBe('WORKFLOW_NOT_FOUND');
  });
});
