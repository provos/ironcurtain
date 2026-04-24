/**
 * Tests for `workflows.get` dispatch (B3): live-path backwards compatibility,
 * disk-fallback success cases (terminal + interrupted), and RPC error mapping
 * for `not_found` and `corrupted`.
 *
 * Also covers the small pure helpers shared with B4 (`computePastRunPhase`,
 * `buildDetailFromPastRun`) and the `workflows.messageLog` dispatch (B5)
 * with cursor-based pagination semantics.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import {
  workflowDispatch,
  computePastRunPhase,
  buildDetailFromPastRun,
  buildPastRunDto,
  type WorkflowDispatchContext,
} from '../src/web-ui/dispatch/workflow-dispatch.js';
import { RpcError, type PastRunDto, type MessageLogResponseDto } from '../src/web-ui/web-ui-types.js';
import type { MessageLogEntry } from '../src/workflow/message-log.js';
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
import type { WorkflowManager, PastRunLoadResult } from '../src/web-ui/workflow-manager.js';
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
});

// ---------------------------------------------------------------------------
// buildDetailFromPastRun
// ---------------------------------------------------------------------------

describe('buildDetailFromPastRun', () => {
  it('produces a WorkflowDetailDto with synthesized "interrupted" phase', () => {
    const id = 'wf-001' as WorkflowId;
    const cp = makeCheckpoint({ machineState: 'plan' });
    const def = makeDefinition();

    const dto = buildDetailFromPastRun(id, cp, def, false);

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

    const dto = buildDetailFromPastRun(id, cp, def, false);
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

    const dto = buildDetailFromPastRun(id, cp, def, false);
    expect(dto.phase).toBe('completed');
    expect(dto.error).toBeUndefined();
  });

  it('falls back to empty workspacePath when checkpoint has none', () => {
    const id = 'wf-004' as WorkflowId;
    const cp = makeCheckpoint({ workspacePath: undefined });
    const def = makeDefinition();

    const dto = buildDetailFromPastRun(id, cp, def, false);
    expect(dto.workspacePath).toBe('');
  });

  it('builds a state graph from the definition', () => {
    const id = 'wf-005' as WorkflowId;
    const cp = makeCheckpoint();
    const def = makeDefinition();

    const dto = buildDetailFromPastRun(id, cp, def, false);
    expect(dto.stateGraph.states.length).toBeGreaterThan(0);
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
      loadPastRun: () => ({ checkpoint: cp, definition: def, isLive: false }),
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
      loadPastRun: () => ({ checkpoint: cp, definition: def, isLive: false }),
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

    const dto = buildPastRunDto(id, cp, def, false);

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

    const dto = buildPastRunDto(id, cp, def, false);
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
    const dto = buildPastRunDto(id, cp, makeDefinition(), false);
    expect(dto.error).toBe('boom');
  });

  it('omits error for completed runs', () => {
    const id = 'wf-103' as WorkflowId;
    const cp = makeCheckpoint({
      machineState: 'done',
      context: makeContext({ lastError: 'stale residual error' }),
    });
    const dto = buildPastRunDto(id, cp, makeDefinition(), false);
    expect(dto.phase).toBe('completed');
    expect(dto.error).toBeUndefined();
  });

  it('coerces a race-with-start "running" phase to "interrupted" to keep the DTO well-typed', () => {
    const id = 'wf-104' as WorkflowId;
    const cp = makeCheckpoint({ machineState: 'plan' });
    // computePastRunPhase returns 'running' when isLive=true; PastRunDto.phase
    // excludes 'running', so buildPastRunDto must coerce.
    const dto = buildPastRunDto(id, cp, makeDefinition(), true);
    expect(dto.phase).toBe('interrupted');
  });

  it('leaves durationMs undefined because checkpoints do not persist start/end timestamps', () => {
    const id = 'wf-105' as WorkflowId;
    const cp = makeCheckpoint();
    const dto = buildPastRunDto(id, cp, makeDefinition(), false);
    expect(dto.durationMs).toBeUndefined();
  });

  it('leaves workspacePath undefined when checkpoint has none', () => {
    const id = 'wf-106' as WorkflowId;
    const cp = makeCheckpoint({ workspacePath: undefined });
    const dto = buildPastRunDto(id, cp, makeDefinition(), false);
    expect(dto.workspacePath).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// workflows.listResumable (B4)
// ---------------------------------------------------------------------------

describe('workflows.listResumable', () => {
  it('returns widened PastRunDto rows for every checkpoint enumerated', async () => {
    const idA = 'wf-A' as WorkflowId;
    const idB = 'wf-B' as WorkflowId;
    const cpA = makeCheckpoint({ machineState: 'plan', timestamp: '2026-04-22T09:00:00.000Z' });
    const cpB = makeCheckpoint({ machineState: 'done', timestamp: '2026-04-23T11:00:00.000Z' });
    const def = makeDefinition();

    const ctx = createContext({
      controller: {
        listResumable: vi.fn().mockReturnValue([idA, idB]),
        listActive: vi.fn().mockReturnValue([]),
      },
      loadPastRun: (id) => {
        if (id === idA) return { checkpoint: cpA, definition: def, isLive: false };
        if (id === idB) return { checkpoint: cpB, definition: def, isLive: false };
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
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const ctx = createContext({
      controller: {
        listResumable: vi.fn().mockReturnValue([idGood, idBad]),
        listActive: vi.fn().mockReturnValue([]),
      },
      loadPastRun: (id) => {
        if (id === idGood) return { checkpoint: cp, definition: makeDefinition(), isLive: false };
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

  it('skips a not_found row silently (deletion race) without warning', async () => {
    const idMissing = 'wf-missing' as WorkflowId;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const ctx = createContext({
      controller: {
        listResumable: vi.fn().mockReturnValue([idMissing]),
        listActive: vi.fn().mockReturnValue([]),
      },
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
    const ctx = createContext({
      controller: {
        listResumable: vi.fn().mockReturnValue([id]),
        listActive: vi.fn().mockReturnValue([]),
      },
      loadPastRun: () => ({ checkpoint: cp, definition: makeDefinition(), isLive: false }),
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
    const ctx = createContext({
      controller: {
        listResumable: vi.fn().mockReturnValue([idDone, idAbort, idGate]),
        listActive: vi.fn().mockReturnValue([]),
      },
      loadPastRun: (id) => {
        if (id === idDone) {
          return {
            checkpoint: makeCheckpoint({ machineState: 'done', timestamp: '2026-04-23T03:00:00.000Z' }),
            definition: def,
            isLive: false,
          };
        }
        if (id === idAbort) {
          return {
            checkpoint: makeCheckpoint({ machineState: 'aborted', timestamp: '2026-04-23T02:00:00.000Z' }),
            definition: def,
            isLive: false,
          };
        }
        return {
          checkpoint: makeCheckpoint({ machineState: 'review', timestamp: '2026-04-23T01:00:00.000Z' }),
          definition: def,
          isLive: false,
        };
      },
    });

    const dtos = (await workflowDispatch(ctx, 'workflows.listResumable', {})) as PastRunDto[];

    expect(dtos).toHaveLength(3);
    const byId = new Map(dtos.map((d) => [d.workflowId, d]));
    expect(byId.get(idDone)?.phase).toBe('completed');
    expect(byId.get(idAbort)?.phase).toBe('aborted');
    expect(byId.get(idGate)?.phase).toBe('waiting_human');
  });

  it('leaves durationMs undefined for every row (checkpoint schema gap)', async () => {
    const id = 'wf-dur' as WorkflowId;
    const ctx = createContext({
      controller: {
        listResumable: vi.fn().mockReturnValue([id]),
        listActive: vi.fn().mockReturnValue([]),
      },
      loadPastRun: () => ({
        checkpoint: makeCheckpoint({ machineState: 'done' }),
        definition: makeDefinition(),
        isLive: false,
      }),
    });

    const dtos = (await workflowDispatch(ctx, 'workflows.listResumable', {})) as PastRunDto[];
    expect(dtos[0].durationMs).toBeUndefined();
  });

  it('calls controller.listActive() exactly once regardless of row count', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e'].map((s) => `wf-${s}` as WorkflowId);
    const listActive = vi.fn().mockReturnValue([]);
    const cp = makeCheckpoint({ machineState: 'plan' });
    const ctx = createContext({
      controller: {
        listResumable: vi.fn().mockReturnValue(ids),
        listActive,
      },
      loadPastRun: () => ({ checkpoint: cp, definition: makeDefinition(), isLive: false }),
    });

    await workflowDispatch(ctx, 'workflows.listResumable', {});
    expect(listActive).toHaveBeenCalledTimes(1);
  });

  it('treats a row in controller.listActive() as live and coerces phase to "interrupted" for the resumable list', async () => {
    const id = 'wf-race' as WorkflowId;
    const cp = makeCheckpoint({ machineState: 'plan' });
    const ctx = createContext({
      controller: {
        // listResumable normally excludes active ids, but a race could include one.
        listResumable: vi.fn().mockReturnValue([id]),
        listActive: vi.fn().mockReturnValue([id]),
      },
      // The manager's loadPastRun would set isLive=true; the dispatch layer
      // computes its own from the once-sampled active set, so the input here
      // doesn't matter for the assertion -- we just need a successful load.
      loadPastRun: () => ({ checkpoint: cp, definition: makeDefinition(), isLive: true }),
    });

    const dtos = (await workflowDispatch(ctx, 'workflows.listResumable', {})) as PastRunDto[];
    expect(dtos).toHaveLength(1);
    expect(dtos[0].phase).toBe('interrupted');
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
      ({
        checkpoint: makeCheckpoint(),
        definition: makeDefinition(),
        isLive: false,
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
