/**
 * Shared test infrastructure for workflow orchestrator tests.
 *
 * Provides MockSession, response builders, artifact simulation,
 * and polling helpers used across all workflow test files.
 */

import { vi } from 'vitest';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  SessionInfo,
  SessionId,
  BudgetStatus,
  ConversationTurn,
  DiagnosticEvent,
  EscalationRequest,
} from '../../src/session/types.js';
import type { Session } from '../../src/session/types.js';
import type { WorkflowId, HumanGateRequest } from '../../src/workflow/types.js';
import {
  WorkflowOrchestrator,
  type WorkflowOrchestratorDeps,
  type WorkflowTabHandle,
} from '../../src/workflow/orchestrator.js';
import { FileCheckpointStore } from '../../src/workflow/checkpoint.js';

// ---------------------------------------------------------------------------
// MockSession
// ---------------------------------------------------------------------------

export type ResponseFn = (msg: string) => string | Promise<string>;

export class MockSession implements Session {
  readonly sentMessages: string[] = [];
  closed = false;
  private readonly sessionId: string;
  private readonly responseFn: ResponseFn;

  constructor(opts: { sessionId?: string; responses: ResponseFn | string[] }) {
    this.sessionId = opts.sessionId ?? `mock-${Math.random().toString(36).slice(2, 8)}`;
    if (Array.isArray(opts.responses)) {
      let idx = 0;
      const arr = opts.responses;
      this.responseFn = () => {
        if (idx >= arr.length) throw new Error(`MockSession ${this.sessionId} exhausted at call ${idx + 1}`);
        return arr[idx++];
      };
    } else {
      this.responseFn = opts.responses;
    }
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
  async resolveEscalation(): Promise<void> {
    /* no-op */
  }
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

export function approvedResponse(notes = 'done'): string {
  return [
    'I completed the task.',
    '```',
    'agent_status:',
    '  completed: true',
    '  verdict: approved',
    '  confidence: high',
    '  escalation: null',
    '  test_count: null',
    `  notes: "${notes}"`,
    '```',
  ].join('\n');
}

export function rejectedResponse(notes: string): string {
  return [
    'Found issues.',
    '```',
    'agent_status:',
    '  completed: true',
    '  verdict: rejected',
    '  confidence: high',
    '  escalation: null',
    '  test_count: null',
    `  notes: "${notes}"`,
    '```',
  ].join('\n');
}

export function noStatusResponse(): string {
  return 'I did the work. Here is the result.\nNo structured status block.';
}

/**
 * Builds a status block with a given verdict and notes.
 * Used by spike.test.ts which constructs responses with inline status blocks.
 */
export function statusBlock(verdict: string, notes: string): string {
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

// ---------------------------------------------------------------------------
// Artifact simulation
// ---------------------------------------------------------------------------

/**
 * Creates artifact directories with placeholder files inside a workflow dir.
 * The `workflowDir` should be the workflow instance directory
 * (e.g., `{baseDir}/{workflowId}`), not the artifact dir itself.
 */
export function simulateArtifacts(workflowDir: string, names: string[]): void {
  for (const name of names) {
    const dir = resolve(workflowDir, 'workspace', '.workflow', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${name}.md`), `content for ${name}`);
  }
}

/**
 * Finds the workflow instance directory inside a base dir.
 * The orchestrator creates `{baseDir}/{workflowId}/` directories;
 * this finds the last non-JSON entry.
 */
export function findWorkflowDir(baseDir: string): string {
  const entries = readdirSync(baseDir);
  const dirs = entries.filter((e) => !e.endsWith('.json'));
  if (dirs.length === 0) {
    throw new Error(`No workflow directory found in ${baseDir}`);
  }
  return resolve(baseDir, dirs[dirs.length - 1]);
}

/**
 * Creates a MockSession that simulates artifact creation on each response.
 * Artifacts are created inside the workflow dir found in `baseDir`.
 */
export function createArtifactAwareSession(
  responses: Array<{ text: string; artifacts?: string[] }>,
  baseDir: string,
  sessionId?: string,
): MockSession {
  let index = 0;
  return new MockSession({
    sessionId,
    responses: () => {
      if (index >= responses.length) {
        throw new Error(`MockSession exhausted at call ${index + 1}`);
      }
      const entry = responses[index++];
      if (entry.artifacts) {
        simulateArtifacts(findWorkflowDir(baseDir), entry.artifacts);
      }
      return entry.text;
    },
  });
}

// ---------------------------------------------------------------------------
// Test infrastructure helpers
// ---------------------------------------------------------------------------

export function writeDefinitionFile(tmpDir: string, def: { name: string }): string {
  const defPath = resolve(tmpDir, `${def.name}.json`);
  writeFileSync(defPath, JSON.stringify(def));
  return defPath;
}

export function createMockTab(): WorkflowTabHandle {
  return {
    write: vi.fn(),
    setLabel: vi.fn(),
    close: vi.fn(),
  };
}

export function createCheckpointStore(tmpDir: string): FileCheckpointStore {
  const baseName = resolve(tmpDir).split('/').pop()!;
  return new FileCheckpointStore(resolve(tmpDir, '..', `${baseName}-ckpt`));
}

export function createDeps(
  tmpDir: string,
  overrides: Partial<WorkflowOrchestratorDeps> = {},
): WorkflowOrchestratorDeps {
  return {
    createSession: vi.fn(async () => new MockSession({ responses: [] })),
    createWorkflowTab: vi.fn(() => createMockTab()),
    raiseGate: vi.fn(),
    dismissGate: vi.fn(),
    baseDir: tmpDir,
    checkpointStore: createCheckpointStore(tmpDir),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Polling helpers
// ---------------------------------------------------------------------------

export async function waitForGate(
  raiseGateMock: ReturnType<typeof vi.fn>,
  expectedCount: number,
  timeoutMs = 5000,
): Promise<HumanGateRequest[]> {
  const start = Date.now();
  while (raiseGateMock.mock.calls.length < expectedCount) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${expectedCount} gate(s), got ${raiseGateMock.mock.calls.length}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return raiseGateMock.mock.calls.map((c: unknown[]) => c[0] as HumanGateRequest);
}

export async function waitForCompletion(
  orchestrator: WorkflowOrchestrator,
  workflowId: WorkflowId,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const status = orchestrator.getStatus(workflowId);
    if (status?.phase === 'completed' || status?.phase === 'failed' || status?.phase === 'aborted') {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for workflow completion, current status: ${JSON.stringify(status)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function waitForGateOrCompletion(
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
