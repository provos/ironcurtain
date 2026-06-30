/**
 * End-to-end integration test for the agent-driven workflow gate loop.
 *
 * Boots the REAL daemon WS surface (`WebUiServer` on an OS-assigned port, a mock
 * `ControlRequestHandler`, a real `WorkflowManager` wired to the server's event
 * bus) and drives a gated fixture workflow through the REAL `DaemonClient` —
 * proving the agent loop (start -> gate -> inspect -> resolve -> terminal) over
 * the actual JSON-RPC transport.
 *
 * Hermetic: no LLM key, no Docker. The fixture runs in `builtin` mode and the
 * `WorkflowManager.sessionFactoryOverride` DI seam supplies an artifact-writing
 * stub session, so the pre-gate `agent` state resolves instantly.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebUiServer, type WebUiServerOptions } from '../../src/web-ui/web-ui-server.js';
import { WorkflowManager } from '../../src/workflow/workflow-manager.js';
import { SessionManager } from '../../src/session/session-manager.js';
import type { ControlRequestHandler } from '../../src/daemon/control-socket.js';
import { createDaemonClient, type DaemonClient, type DaemonEvent } from '../../src/daemon-client/daemon-client.js';
import { createArtifactAwareSession, approvedResponse } from './test-helpers.js';
import type { Session, SessionOptions } from '../../src/session/types.js';
import type { WorkflowDetailDto } from '../../src/web-ui/web-ui-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, 'fixtures', 'test-gate-smoke', 'workflow.yaml');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeMockHandler(): ControlRequestHandler {
  return {
    getStatus: vi.fn().mockReturnValue({
      uptimeSeconds: 0,
      jobs: { total: 0, enabled: 0, running: 0 },
      signalConnected: false,
      nextFireTime: undefined,
    }),
    addJob: vi.fn().mockResolvedValue(undefined),
    removeJob: vi.fn().mockResolvedValue(undefined),
    enableJob: vi.fn().mockResolvedValue(undefined),
    disableJob: vi.fn().mockResolvedValue(undefined),
    recompileJob: vi.fn().mockResolvedValue(undefined),
    reloadJob: vi.fn().mockResolvedValue(undefined),
    runJobNow: vi.fn().mockResolvedValue({}),
    listJobs: vi.fn().mockReturnValue([]),
  };
}

interface Harness {
  readonly server: WebUiServer;
  readonly client: DaemonClient;
  readonly baseDir: string;
}

const harnesses: Harness[] = [];

/**
 * Builds the full stack and connects a real client. The stub session factory
 * writes the `draft` artifact (so the gate can `present` it) and returns an
 * approved status block, on every `produce` visit.
 */
async function boot(): Promise<Harness> {
  const baseDir = mkdtempSync(resolve(tmpdir(), 'ic-gate-loop-'));

  const sessionFactoryOverride: (opts: SessionOptions) => Promise<Session> = () =>
    Promise.resolve(createArtifactAwareSession([{ text: approvedResponse(), artifacts: ['draft'] }], baseDir));

  const opts: WebUiServerOptions = {
    port: 0,
    host: '127.0.0.1',
    handler: makeMockHandler(),
    sessionManager: new SessionManager(),
    mode: { kind: 'builtin' },
    maxConcurrentWebSessions: 3,
  };
  const server = new WebUiServer(opts);
  const url = await server.start();

  const manager = new WorkflowManager({
    eventBus: server.getEventBus(),
    baseDirOverride: baseDir,
    sessionFactoryOverride,
  });
  server.setWorkflowManager(manager);

  const parsed = new URL(url);
  const client = createDaemonClient({
    endpoint: {
      host: '127.0.0.1',
      port: parseInt(parsed.port, 10),
      token: parsed.searchParams.get('token') ?? '',
    },
  });
  await client.connect();

  const harness: Harness = { server, client, baseDir };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const h of harnesses) {
    await h.client.close().catch(() => {});
    await h.server.stop().catch(() => {});
    rmSync(h.baseDir, { recursive: true, force: true });
  }
  harnesses.length = 0;
});

// ---------------------------------------------------------------------------
// Event helpers (mirror the `await` command's resolution logic)
// ---------------------------------------------------------------------------

/** Waits for a workflow event of `eventName` targeting `workflowId`. */
function waitForEvent(client: DaemonClient, eventName: string, workflowId: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      unsubscribe();
      rejectP(new Error(`Timed out waiting for ${eventName} on ${workflowId}`));
    }, timeoutMs);
    const unsubscribe = client.onEvent((e: DaemonEvent) => {
      const payloadId = (e.payload as { workflowId?: string }).workflowId;
      if (e.event === eventName && payloadId === workflowId) {
        clearTimeout(timer);
        unsubscribe();
        resolveP();
      }
    });
  });
}

/**
 * Blocks until the workflow is at a gate (`waiting_human`). Mirrors the
 * `await` command's race-closer: the stub workflow can reach the gate during
 * the `workflows.start` RPC (before any subscription attaches), so a purely
 * event-driven wait would deadlock. We subscribe first, then poll `get`, and
 * resolve on whichever lands first.
 */
async function waitForGate(client: DaemonClient, workflowId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Subscribe before the first poll so a gate raised between polls is caught.
  const gateEvent = waitForEvent(client, 'workflow.gate_raised', workflowId, timeoutMs).catch(() => {});
  for (;;) {
    const detail = await getDetail(client, workflowId);
    if (detail.phase === 'waiting_human') return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for gate on ${workflowId} (phase=${detail.phase})`);
    await Promise.race([gateEvent, new Promise((r) => setTimeout(r, 50))]);
  }
}

async function getDetail(client: DaemonClient, workflowId: string): Promise<WorkflowDetailDto> {
  const result = await client.call<WorkflowDetailDto>('workflows.get', { workflowId });
  if (!result.ok) throw new Error(`workflows.get failed: ${result.code} ${result.message}`);
  return result.payload;
}

/**
 * Blocks until the workflow reaches a terminal phase, returning the
 * authoritative phase. Subscribe-then-poll (same race-closer as
 * {@link waitForGate}): a terminal can be reached during the `resolveGate` RPC.
 */
async function waitForTerminal(client: DaemonClient, workflowId: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const completed = waitForEvent(client, 'workflow.completed', workflowId, timeoutMs).catch(() => {});
  const failed = waitForEvent(client, 'workflow.failed', workflowId, timeoutMs).catch(() => {});
  for (;;) {
    const detail = await getDetail(client, workflowId);
    if (detail.phase === 'completed' || detail.phase === 'failed' || detail.phase === 'aborted') {
      return detail.phase;
    }
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for terminal on ${workflowId} (phase=${detail.phase})`);
    await Promise.race([completed, failed, new Promise((r) => setTimeout(r, 50))]);
  }
}

async function startFixture(client: DaemonClient): Promise<string> {
  const started = await client.call<{ workflowId: string }>('workflows.start', {
    definitionPath: FIXTURE_PATH,
    taskDescription: 'Draft and review a thing',
  });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error('start failed');
  return started.payload.workflowId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agent gate loop (integration)', () => {
  it('drives start -> gate -> show -> FORCE_REVISION -> gate -> APPROVE -> completed', async () => {
    const { client } = await boot();

    const workflowId = await startFixture(client);
    await waitForGate(client, workflowId);

    // Machine-readable gate visibility (requirement #2).
    const atGate = await getDetail(client, workflowId);
    expect(atGate.phase).toBe('waiting_human');
    expect(atGate.gate?.stateName).toBe('review');
    expect(atGate.gate?.presentedArtifacts).toContain('draft');
    expect(atGate.gate?.acceptedEvents).toEqual(expect.arrayContaining(['APPROVE', 'FORCE_REVISION', 'ABORT']));

    // Inspect the presented artifact (names -> content).
    const artifact = await client.call<{ files: { path: string; content: string }[] }>('workflows.artifacts', {
      workflowId,
      artifactName: 'draft',
    });
    expect(artifact.ok).toBe(true);
    if (artifact.ok) {
      expect(artifact.payload.files.length).toBeGreaterThan(0);
      expect(artifact.payload.files[0].content).toContain('content for draft');
    }

    // Empty-prompt FORCE_REVISION must be rejected by the daemon (feedback rule).
    const emptyRevision = await client.call('workflows.resolveGate', {
      workflowId,
      event: 'FORCE_REVISION',
      prompt: '',
    });
    expect(emptyRevision.ok).toBe(false);
    if (!emptyRevision.ok) expect(emptyRevision.code).toBe('INVALID_PARAMS');

    // Valid FORCE_REVISION loops back to `produce` and raises the gate again.
    const revision = await client.call('workflows.resolveGate', {
      workflowId,
      event: 'FORCE_REVISION',
      prompt: 'tighten it',
    });
    expect(revision.ok).toBe(true);
    await waitForGate(client, workflowId);

    const atSecondGate = await getDetail(client, workflowId);
    expect(atSecondGate.phase).toBe('waiting_human');
    expect(atSecondGate.gate?.stateName).toBe('review');

    // APPROVE drives to a `completed` terminal (requirement #3).
    const approve = await client.call('workflows.resolveGate', { workflowId, event: 'APPROVE' });
    expect(approve.ok).toBe(true);

    // Authoritative phase, read from `workflows.get` (not the event name).
    const phase = await waitForTerminal(client, workflowId);
    expect(phase).toBe('completed');
  }, 30_000);

  it('drives start -> gate -> ABORT -> aborted (event is completed, phase is aborted)', async () => {
    const { client } = await boot();

    const workflowId = await startFixture(client);
    await waitForGate(client, workflowId);

    const atGate = await getDetail(client, workflowId);
    expect(atGate.phase).toBe('waiting_human');

    // A gate-ABORT routes to the `aborted` terminal, which emits a
    // `workflow.completed` lifecycle event — so the event name is NOT
    // authoritative; the follow-up `workflows.get` reports `phase:'aborted'`.
    const abort = await client.call('workflows.resolveGate', { workflowId, event: 'ABORT' });
    expect(abort.ok).toBe(true);

    const phase = await waitForTerminal(client, workflowId);
    expect(phase).toBe('aborted');
  }, 30_000);
});
