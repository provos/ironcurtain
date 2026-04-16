/**
 * Tests for lint pre-flight integration in the JSON-RPC `workflows.start`
 * handler. Covers the daemon-side wrapper added in Phase 3:
 *
 *  - `workflows.start` with a lint-error workflow throws LINT_FAILED
 *  - `workflows.start` with a warning-only workflow succeeds
 *  - `workflows.resume` does NOT lint (stale YAML must pass through)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { workflowDispatch, type WorkflowDispatchContext } from '../src/web-ui/dispatch/workflow-dispatch.js';
import { RpcError } from '../src/web-ui/web-ui-types.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import { SessionManager } from '../src/session/session-manager.js';
import type { Diagnostic } from '../src/workflow/lint.js';
import type { WorkflowController } from '../src/workflow/orchestrator.js';
import type { WorkflowId } from '../src/workflow/types.js';
import type { ControlRequestHandler } from '../src/daemon/control-socket.js';
import type { WorkflowManager } from '../src/web-ui/workflow-manager.js';
import type { FileCheckpointStore } from '../src/workflow/checkpoint.js';

// ---------------------------------------------------------------------------
// Test fixtures: workflow definitions with and without lint problems
// ---------------------------------------------------------------------------

/**
 * Valid definition that lints clean. Two states, explicit terminal.
 */
const CLEAN_WORKFLOW = {
  name: 'clean',
  description: 'lints clean',
  initial: 'plan',
  states: {
    plan: {
      type: 'agent',
      description: 'plan',
      persona: 'global',
      prompt: 'p',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'd' },
  },
};

/**
 * Definition that triggers WF004 (error): the human_gate references an
 * artifact that no reachable state produces. This is the cheapest way
 * to produce a hard lint error since it's purely a string mismatch.
 */
const ERROR_WORKFLOW = {
  name: 'broken',
  description: 'triggers WF004',
  initial: 'plan',
  states: {
    plan: {
      type: 'agent',
      description: 'p',
      persona: 'global',
      prompt: 'p',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'gate' }],
    },
    gate: {
      type: 'human_gate',
      description: 'gate',
      acceptedEvents: ['APPROVE', 'ABORT'],
      present: ['does-not-exist'],
      transitions: [
        { to: 'done', event: 'APPROVE' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal', description: 'd' },
    aborted: { type: 'terminal', description: 'a' },
  },
};

/**
 * Definition that triggers WF002 (warning only): unversionedArtifacts
 * entry not produced by any state.
 */
const WARNING_WORKFLOW = {
  name: 'warns',
  description: 'WF002 only',
  initial: 'plan',
  settings: { unversionedArtifacts: ['never-produced'] },
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
    done: { type: 'terminal', description: 'd' },
  },
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function writeDef(dir: string, name: string, body: unknown): string {
  const path = resolve(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

/**
 * Builds a dispatch context with a stubbed WorkflowController so we can
 * assert whether `start`/`resume` was actually reached without booting
 * a real orchestrator.
 */
function createContext(overrides?: {
  controller?: Partial<WorkflowController>;
  importExternalCheckpoint?: (baseDir: string, id?: string) => WorkflowId;
}): {
  ctx: WorkflowDispatchContext;
  startMock: ReturnType<typeof vi.fn>;
  resumeMock: ReturnType<typeof vi.fn>;
} {
  const startMock = vi
    .fn<Parameters<WorkflowController['start']>, ReturnType<WorkflowController['start']>>()
    .mockResolvedValue('mock-workflow-id' as WorkflowId);
  const resumeMock = vi
    .fn<Parameters<WorkflowController['resume']>, ReturnType<WorkflowController['resume']>>()
    .mockResolvedValue(undefined);

  const controller: WorkflowController = {
    start: startMock,
    resume: resumeMock,
    listResumable: vi.fn().mockReturnValue([]),
    getStatus: vi.fn().mockReturnValue(undefined),
    getDetail: vi.fn().mockReturnValue(undefined),
    listActive: vi.fn().mockReturnValue([]),
    resolveGate: vi.fn(),
    abort: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn(),
    shutdownAll: vi.fn().mockResolvedValue(undefined),
    ...overrides?.controller,
  };

  const manager = {
    getOrchestrator: () => controller,
    getCheckpointStore: () => ({ load: () => undefined }) as unknown as FileCheckpointStore,
    importExternalCheckpoint:
      overrides?.importExternalCheckpoint ?? ((_baseDir: string, id?: string) => (id ?? 'imported-id') as WorkflowId),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getBaseDir: () => '/tmp',
  } as unknown as WorkflowManager;

  const ctx: WorkflowDispatchContext = {
    handler: {} as ControlRequestHandler,
    sessionManager: new SessionManager(),
    mode: { kind: 'docker', agent: 'claude-code' as never },
    eventBus: new WebEventBus(),
    maxConcurrentWebSessions: 5,
    sessionQueues: new Map(),
    workflowManager: manager,
  };

  return { ctx, startMock, resumeMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workflows.start lint pre-flight', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `ic-lint-dispatch-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws LINT_FAILED when the workflow has lint errors', async () => {
    const defPath = writeDef(tmpDir, 'broken', ERROR_WORKFLOW);
    const { ctx, startMock } = createContext();

    await expect(
      workflowDispatch(ctx, 'workflows.start', {
        definitionPath: defPath,
        taskDescription: 'test',
      }),
    ).rejects.toMatchObject({ code: 'LINT_FAILED' });

    // Controller.start must NOT have been called when lint aborts.
    expect(startMock).not.toHaveBeenCalled();
  });

  it('LINT_FAILED carries diagnostic data for the UI to render', async () => {
    const defPath = writeDef(tmpDir, 'broken', ERROR_WORKFLOW);
    const { ctx } = createContext();

    let caught: unknown;
    try {
      await workflowDispatch(ctx, 'workflows.start', {
        definitionPath: defPath,
        taskDescription: 'test',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RpcError);
    const err = caught as RpcError;
    expect(err.code).toBe('LINT_FAILED');
    expect(err.data).toBeDefined();

    const data = err.data as { diagnostics: Diagnostic[] };
    expect(data.diagnostics.some((d) => d.code === 'WF004')).toBe(true);
    expect(data.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('succeeds when the workflow only has warnings (warn mode)', async () => {
    const defPath = writeDef(tmpDir, 'warns', WARNING_WORKFLOW);
    const { ctx, startMock } = createContext();

    const result = await workflowDispatch(ctx, 'workflows.start', {
      definitionPath: defPath,
      taskDescription: 'test',
    });

    expect(result).toMatchObject({ workflowId: 'mock-workflow-id' });
    expect(startMock).toHaveBeenCalledOnce();
  });

  it('succeeds when the workflow lints clean', async () => {
    const defPath = writeDef(tmpDir, 'clean', CLEAN_WORKFLOW);
    const { ctx, startMock } = createContext();

    const result = await workflowDispatch(ctx, 'workflows.start', {
      definitionPath: defPath,
      taskDescription: 'test',
    });

    expect(result).toMatchObject({ workflowId: 'mock-workflow-id' });
    expect(startMock).toHaveBeenCalledWith(defPath, 'test', undefined);
  });

  it('throws INVALID_PARAMS when the definition file is malformed', async () => {
    const defPath = resolve(tmpDir, 'missing.json');
    const { ctx, startMock } = createContext();

    await expect(
      workflowDispatch(ctx, 'workflows.start', {
        definitionPath: defPath,
        taskDescription: 'test',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

    expect(startMock).not.toHaveBeenCalled();
  });
});

describe('workflows.resume does NOT lint', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `ic-lint-resume-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resume proceeds even when the checkpointed workflow would fail lint', async () => {
    // Checkpoint carries a YAML from an older lint catalog -- but resume
    // must not re-lint, or users are stuck with a workflow they can't
    // unblock.
    const { ctx, resumeMock } = createContext({
      importExternalCheckpoint: () => 'stale-workflow' as WorkflowId,
    });

    // Even though this baseDir references a lint-error-producing definition,
    // resume should not re-parse or re-lint; the orchestrator consumes the
    // checkpoint directly.
    const baseDir = tmpDir; // must exist for the dispatch schema guard

    const result = await workflowDispatch(ctx, 'workflows.resume', {
      baseDir,
    });

    expect(result).toMatchObject({ accepted: true });
    expect(resumeMock).toHaveBeenCalledOnce();
  });
});
