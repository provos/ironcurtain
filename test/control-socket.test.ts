import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ControlSocketServer,
  sendControlRequest,
  isDaemonRunning,
  type ControlRequestHandler,
} from '../src/daemon/control-socket.js';
import type { JobDefinition, RunRecord } from '../src/cron/types.js';
import type { JobId } from '../src/cron/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestSocketPath(dir: string): string {
  return resolve(dir, 'test-daemon.sock');
}

function createMockHandler(): ControlRequestHandler & {
  calls: Array<{ method: string; args: unknown[] }>;
  mockListJobs: Array<{
    job: JobDefinition;
    nextRun: Date | undefined;
    lastRun: RunRecord | undefined;
    isRunning: boolean;
  }>;
  mockRunRecord: RunRecord;
} {
  const handler = {
    calls: [] as Array<{ method: string; args: unknown[] }>,
    mockListJobs: [] as Array<{
      job: JobDefinition;
      nextRun: Date | undefined;
      lastRun: RunRecord | undefined;
      isRunning: boolean;
    }>,
    mockRunRecord: {
      startedAt: '2026-03-05T09:00:00Z',
      completedAt: '2026-03-05T09:01:00Z',
      outcome: { kind: 'success' as const },
      budget: { totalTokens: 1000, stepCount: 5, elapsedSeconds: 60, estimatedCostUsd: 0.05 },
      summary: 'Test run completed.',
      escalationsEncountered: 0,
      escalationsApproved: 0,
      discardedChanges: null,
    },
    async addJob(job: JobDefinition) {
      handler.calls.push({ method: 'addJob', args: [job] });
    },
    async removeJob(jobId: string) {
      handler.calls.push({ method: 'removeJob', args: [jobId] });
    },
    async enableJob(jobId: string) {
      handler.calls.push({ method: 'enableJob', args: [jobId] });
    },
    async disableJob(jobId: string) {
      handler.calls.push({ method: 'disableJob', args: [jobId] });
    },
    async recompileJob(jobId: string) {
      handler.calls.push({ method: 'recompileJob', args: [jobId] });
    },
    async runJobNow(jobId: string): Promise<RunRecord> {
      handler.calls.push({ method: 'runJobNow', args: [jobId] });
      return handler.mockRunRecord;
    },
    listJobs() {
      handler.calls.push({ method: 'listJobs', args: [] });
      return handler.mockListJobs;
    },
  };
  return handler;
}

function createTestJob(id: string = 'test-job'): JobDefinition {
  return {
    id: id as JobId,
    name: 'Test Job',
    schedule: '0 9 * * *',
    taskDescription: 'Do the thing',
    taskConstitution: 'Allow doing the thing',
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ControlSocketServer', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: ControlSocketServer;
  let handler: ReturnType<typeof createMockHandler>;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-socket-'));
    socketPath = createTestSocketPath(tmpDir);
    handler = createMockHandler();
    server = new ControlSocketServer(handler, socketPath);
  });

  afterEach(async () => {
    await server.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts and stops cleanly', async () => {
    await server.start();
    expect(existsSync(socketPath)).toBe(true);

    await server.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  it('responds to ping', async () => {
    await server.start();
    const response = await sendControlRequest({ command: 'ping' }, socketPath);

    expect(response).not.toBeNull();
    expect(response!.ok).toBe(true);
    expect((response as { ok: true; data: unknown }).data).toEqual({ status: 'running' });
  });

  it('stop is idempotent', async () => {
    await server.start();
    await server.stop();
    await server.stop(); // should not throw
  });

  it('stop is safe when never started', async () => {
    await server.stop(); // should not throw
  });
});

describe('isDaemonRunning', () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-socket-'));
    socketPath = createTestSocketPath(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when no socket file exists', async () => {
    const result = await isDaemonRunning(socketPath);
    expect(result).toBe(false);
  });

  it('returns true when daemon is running', async () => {
    const handler = createMockHandler();
    const server = new ControlSocketServer(handler, socketPath);
    await server.start();

    try {
      const result = await isDaemonRunning(socketPath);
      expect(result).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

describe('sendControlRequest', () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-socket-'));
    socketPath = createTestSocketPath(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no socket file exists', async () => {
    const result = await sendControlRequest({ command: 'ping' }, socketPath);
    expect(result).toBeNull();
  });
});

describe('Control socket commands', () => {
  let tmpDir: string;
  let socketPath: string;
  let server: ControlSocketServer;
  let handler: ReturnType<typeof createMockHandler>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-socket-'));
    socketPath = createTestSocketPath(tmpDir);
    handler = createMockHandler();
    server = new ControlSocketServer(handler, socketPath);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('forwards remove-job to handler', async () => {
    const response = await sendControlRequest({ command: 'remove-job', jobId: 'my-job' }, socketPath);
    expect(response).not.toBeNull();
    expect(response!.ok).toBe(true);
    expect(handler.calls).toEqual([{ method: 'removeJob', args: ['my-job'] }]);
  });

  it('forwards enable-job to handler', async () => {
    const response = await sendControlRequest({ command: 'enable-job', jobId: 'my-job' }, socketPath);
    expect(response).not.toBeNull();
    expect(response!.ok).toBe(true);
    expect(handler.calls).toEqual([{ method: 'enableJob', args: ['my-job'] }]);
  });

  it('forwards disable-job to handler', async () => {
    const response = await sendControlRequest({ command: 'disable-job', jobId: 'my-job' }, socketPath);
    expect(response).not.toBeNull();
    expect(response!.ok).toBe(true);
    expect(handler.calls).toEqual([{ method: 'disableJob', args: ['my-job'] }]);
  });

  it('forwards recompile-job to handler', async () => {
    const response = await sendControlRequest({ command: 'recompile-job', jobId: 'my-job' }, socketPath);
    expect(response).not.toBeNull();
    expect(response!.ok).toBe(true);
    expect(handler.calls).toEqual([{ method: 'recompileJob', args: ['my-job'] }]);
  });

  it('forwards run-job and returns run record', async () => {
    const response = await sendControlRequest({ command: 'run-job', jobId: 'my-job' }, socketPath);
    expect(response).not.toBeNull();
    expect(response!.ok).toBe(true);
    expect(handler.calls).toEqual([{ method: 'runJobNow', args: ['my-job'] }]);

    const data = (response as { ok: true; data: RunRecord }).data;
    expect(data.outcome).toEqual({ kind: 'success' });
    expect(data.budget.totalTokens).toBe(1000);
  });

  it('forwards add-job with job definition', async () => {
    const job = createTestJob();
    const response = await sendControlRequest({ command: 'add-job', job }, socketPath);
    expect(response).not.toBeNull();
    expect(response!.ok).toBe(true);
    expect(handler.calls).toHaveLength(1);
    expect(handler.calls[0].method).toBe('addJob');
    expect((handler.calls[0].args[0] as JobDefinition).id).toBe('test-job');
  });

  it('forwards list-jobs and returns serialized data', async () => {
    handler.mockListJobs = [
      {
        job: createTestJob(),
        nextRun: new Date('2026-03-05T09:00:00Z'),
        lastRun: undefined,
        isRunning: false,
      },
    ];

    const response = await sendControlRequest({ command: 'list-jobs' }, socketPath);
    expect(response).not.toBeNull();
    expect(response!.ok).toBe(true);

    const data = (response as { ok: true; data: unknown[] }).data;
    expect(data).toHaveLength(1);

    const entry = data[0] as Record<string, unknown>;
    expect((entry.job as JobDefinition).id).toBe('test-job');
    expect(entry.nextRun).toBe('2026-03-05T09:00:00.000Z');
    expect(entry.isRunning).toBe(false);
  });

  it('returns error response when handler throws', async () => {
    // Override the handler to throw
    handler.removeJob = async () => {
      throw new Error('Job not found: nonexistent');
    };

    const response = await sendControlRequest({ command: 'remove-job', jobId: 'nonexistent' }, socketPath);
    expect(response).not.toBeNull();
    expect(response!.ok).toBe(false);
    expect((response as { ok: false; error: string }).error).toBe('Job not found: nonexistent');
  });

  it('handles multiple sequential requests', async () => {
    const r1 = await sendControlRequest({ command: 'enable-job', jobId: 'job-1' }, socketPath);
    const r2 = await sendControlRequest({ command: 'disable-job', jobId: 'job-2' }, socketPath);
    const r3 = await sendControlRequest({ command: 'ping' }, socketPath);

    expect(r1!.ok).toBe(true);
    expect(r2!.ok).toBe(true);
    expect(r3!.ok).toBe(true);
    expect(handler.calls).toHaveLength(2);
    expect(handler.calls[0]).toEqual({ method: 'enableJob', args: ['job-1'] });
    expect(handler.calls[1]).toEqual({ method: 'disableJob', args: ['job-2'] });
  });
});

describe('Stale socket cleanup', () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-socket-'));
    socketPath = createTestSocketPath(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes stale socket file and starts successfully', async () => {
    // Create a stale socket file (just a regular file, no one listening)
    const { writeFileSync } = await import('node:fs');
    writeFileSync(socketPath, 'stale');
    expect(existsSync(socketPath)).toBe(true);

    const handler = createMockHandler();
    const server = new ControlSocketServer(handler, socketPath);
    await server.start();

    try {
      const running = await isDaemonRunning(socketPath);
      expect(running).toBe(true);
    } finally {
      await server.stop();
    }
  });
});
