/**
 * Shared test infrastructure for workflow orchestrator tests.
 *
 * Provides MockSession, response builders, artifact simulation,
 * and polling helpers used across all workflow test files.
 */

import { vi } from 'vitest';
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AgentConversationId,
  AgentTurnResult,
  SessionInfo,
  SessionId,
  BudgetStatus,
  ConversationTurn,
  DiagnosticEvent,
  EscalationRequest,
} from '../../src/session/types.js';
import type { Session } from '../../src/session/types.js';
import { createAgentConversationId } from '../../src/session/types.js';
import { GLOBAL_PERSONA, type WorkflowId, type HumanGateRequest } from '../../src/workflow/types.js';
import {
  WorkflowOrchestrator,
  type WorkflowOrchestratorDeps,
  type WorkflowTabHandle,
} from '../../src/workflow/orchestrator.js';
import { FileCheckpointStore } from '../../src/workflow/checkpoint.js';
import type { ResolvedUserConfig } from '../../src/config/user-config.js';

// ---------------------------------------------------------------------------
// MockSession
// ---------------------------------------------------------------------------

export type MockResponse = string | AgentTurnResult;
export type ResponseFn = (msg: string) => MockResponse | Promise<MockResponse>;

export class MockSession implements Session {
  readonly sentMessages: string[] = [];
  readonly rotateCalls: number[] = [];
  readonly rotatedIds: AgentConversationId[] = [];
  closed = false;
  private readonly sessionId: string;
  private readonly responseFn: ResponseFn;

  constructor(opts: { sessionId?: string; responses: ResponseFn | MockResponse[] }) {
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
    const { text } = await this.sendMessageDetailed(msg);
    return text;
  }

  async sendMessageDetailed(msg: string): Promise<AgentTurnResult> {
    this.sentMessages.push(msg);
    const result = await this.responseFn(msg);
    if (typeof result === 'string') return { text: result, hardFailure: false };
    return result;
  }

  rotateAgentConversationId(): AgentConversationId {
    this.rotateCalls.push(this.sentMessages.length);
    const id = createAgentConversationId();
    this.rotatedIds.push(id);
    return id;
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

/**
 * Minimal `ResolvedUserConfig` for orchestrator tests. Defaults memory ON
 * (matches the runtime default) so existing tests' behavior is preserved.
 * Tests that exercise memory-gate semantics override `memory.enabled` via
 * the `createDeps` overrides argument.
 */
export function makeTestUserConfig(overrides: Partial<ResolvedUserConfig> = {}): ResolvedUserConfig {
  return {
    agentModelId: 'anthropic:claude-sonnet-4-6',
    policyModelId: 'anthropic:claude-sonnet-4-6',
    prefilterModelId: 'anthropic:claude-haiku-4-5',
    anthropicApiKey: 'test-anthropic-key',
    googleApiKey: '',
    openaiApiKey: '',
    anthropicBaseUrl: '',
    openaiBaseUrl: '',
    googleBaseUrl: '',
    escalationTimeoutSeconds: 300,
    resourceBudget: {
      maxTotalTokens: 1_000_000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5.0,
      warnThresholdPercent: 80,
    },
    autoCompact: {
      enabled: true,
      thresholdTokens: 160_000,
      keepRecentMessages: 10,
      summaryModelId: 'anthropic:claude-haiku-4-5',
    },
    autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
    auditRedaction: { enabled: false },
    memory: {
      enabled: true,
      autoSave: true,
      llmBaseUrl: undefined,
      llmApiKey: undefined,
    },
    webSearch: { provider: null, brave: null, tavily: null, serpapi: null },
    serverCredentials: {},
    signal: null,
    gooseProvider: 'anthropic',
    gooseModel: 'claude-sonnet-4-20250514',
    preferredDockerAgent: 'claude-code',
    packageInstall: {
      enabled: true,
      quarantineDays: 2,
      allowedPackages: [],
      deniedPackages: [],
    },
    ...overrides,
  };
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
    userConfig: makeTestUserConfig(),
    // Default no-op control-plane stubs so shared-container tests that
    // don't assert on these calls can omit them. Tests that do assert
    // (see orchestrator-policy-cycling.test.ts) override with `vi.fn(...)`.
    startWorkflowControlServer: async () => {},
    loadPolicyRpc: async () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Persona stub helpers
// ---------------------------------------------------------------------------

/**
 * Extracts all unique persona names from a WorkflowDefinition,
 * excluding "global" (which does not need a directory).
 */
function collectPersonaNames(definition: { states: Record<string, { type: string; persona?: string }> }): string[] {
  const names = new Set<string>();
  for (const state of Object.values(definition.states)) {
    if (state.type === 'agent' && state.persona && state.persona !== GLOBAL_PERSONA) {
      names.add(state.persona);
    }
  }
  return [...names];
}

/**
 * Creates stub persona directories so that `validatePersonas()` passes
 * for test workflow definitions. Uses a sibling directory `{baseDir}-home`
 * as IRONCURTAIN_HOME to avoid polluting the orchestrator's baseDir
 * (which uses the same tmpDir and breaks `findWorkflowDir`).
 *
 * Returns a cleanup function that restores the original env var.
 */
export function stubPersonasForTest(
  baseDir: string,
  ...definitions: Array<{ states: Record<string, { type: string; persona?: string }> }>
): () => void {
  const originalHome = process.env.IRONCURTAIN_HOME;
  const homeDir = `${baseDir}-home`;
  mkdirSync(homeDir, { recursive: true });
  process.env.IRONCURTAIN_HOME = homeDir;

  const allNames = new Set<string>();
  for (const def of definitions) {
    for (const name of collectPersonaNames(def)) {
      allNames.add(name);
    }
  }

  for (const name of allNames) {
    const personaDir = resolve(homeDir, 'personas', name);
    mkdirSync(personaDir, { recursive: true });
    writeFileSync(resolve(personaDir, 'persona.json'), JSON.stringify({ name, description: 'test stub' }));
  }

  return () => {
    if (originalHome === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = originalHome;
    }
    rmSync(homeDir, { recursive: true, force: true });
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
