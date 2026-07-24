import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createDockerWorkloadLease, loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import { loadResourceWatchdogSupervisorStatus } from '../../src/docker-workload/resource-watchdog-supervisor.js';
import type { ResourceWatchdogPolicy } from '../../src/docker/resource-watchdog.js';
import { isRuntimeAvailable } from '../helpers/container-runtimes.js';

const enabled = process.env.WATCHDOG_SUPERVISOR_INTEGRATION === '1';
const ready = enabled && isRuntimeAvailable('docker');
const execFile = promisify(execFileCallback);

describe.skipIf(!ready)('detached resource-watchdog supervisor process', () => {
  it('survives coordinator exit and revokes a later hard-threshold breach', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchdog-detached-integration-'));
    chmodSync(directory, 0o700);
    const stateRoot = join(directory, 'state');
    const daemonState = join(stateRoot, 'daemon');
    mkdirSync(daemonState, { recursive: true });
    const leasePath = join(directory, 'lease.json');
    const policyPath = join(directory, 'policy.json');
    const statusPath = join(directory, 'status.json');
    const stopRequestPath = join(directory, 'stop.json');
    const resultPath = join(directory, 'coordinator-result.json');
    const entrypointPath = resolve('dist/docker-workload/resource-watchdog-supervisor-main.js');
    const coordinatorPath = resolve('test/docker-workload/fixtures/watchdog-coordinator.mjs');
    let supervisorPid: number | undefined;

    try {
      const stats = lstatSync(stateRoot);
      const policy: ResourceWatchdogPolicy = {
        schemaVersion: 1,
        policyId: 'docker-detached-watchdog-v1',
        targetRoot: stateRoot,
        targetDevice: stats.dev,
        targetInode: stats.ino,
        stateClasses: [{ id: 'daemon-state', relativePath: 'daemon', kind: 'directory', required: true }],
        sampleIntervalMs: 100,
        sampleTimeoutMs: 100,
        staleAfterMs: 300,
        softEvidenceBytes: 512 * 1024,
        hardSafetyBytes: 1024 * 1024,
        hostReserveBytes: 1,
        maximumOvershootBytes: 4 * 1024 * 1024,
        cleanupInventoryGapMs: 100,
      };
      const policyBytes = Buffer.from(`${JSON.stringify(policy)}\n`);
      writeFileSync(policyPath, policyBytes, { mode: 0o400 });
      chmodSync(policyPath, 0o400);
      const watchdogPolicySha256 = createHash('sha256').update(policyBytes).digest('hex');
      createDockerWorkloadLease(leasePath, {
        leaseId: 'lease-detached-integration-001',
        bundleId: 'bundle-detached-integration-001',
        generation: 'generation-detached-integration-001',
        runtimeKind: 'docker',
        paths: {
          workspaceRoot: join(directory, 'workspace'),
          stateRoot,
          runtimeRoot: join(stateRoot, 'runtime'),
          apiRoot: join(stateRoot, 'api'),
          exchangeRoot: join(stateRoot, 'exchange'),
          stagingRoot: join(stateRoot, 'staging'),
        },
        bindings: {
          catalogSha256: '2'.repeat(64),
          profileSha256: '3'.repeat(64),
          performanceBudgetSha256: '4'.repeat(64),
          watchdogPolicySha256,
          toolchainDigest: '6'.repeat(64),
        },
        cleanupInventoryGapMs: 100,
      });

      await execFile(
        process.execPath,
        [coordinatorPath, leasePath, policyPath, statusPath, stopRequestPath, entrypointPath, resultPath],
        { timeout: 10_000, maxBuffer: 1024 * 1024 },
      );
      const launched = JSON.parse(readFileSync(resultPath, 'utf8')) as { readonly pid: number };
      supervisorPid = launched.pid;
      expect(loadResourceWatchdogSupervisorStatus(statusPath)).toMatchObject({
        supervisorPid,
        state: 'ready',
      });

      writeFileSync(join(daemonState, 'threshold.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
      await waitForClosed(statusPath);
      expect(loadDockerWorkloadLease(leasePath)).toMatchObject({
        status: 'closed',
        cleanup: { exactOuterResourcesAbsent: true, stateRootAbsent: true },
      });
      expect(() => lstatSync(stateRoot)).toThrow();
      await waitForProcessExit(supervisorPid);
      supervisorPid = undefined;
    } finally {
      if (supervisorPid !== undefined && processIsAlive(supervisorPid)) process.kill(supervisorPid, 'SIGTERM');
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

async function waitForClosed(statusPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = loadResourceWatchdogSupervisorStatus(statusPath);
    if (status.state === 'closed') return;
    if (status.state === 'incident') throw new Error(`watchdog supervisor incident: ${status.detail ?? 'unknown'}`);
    if (Date.now() >= deadline) throw new Error('watchdog supervisor did not close after threshold breach');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline) throw new Error('watchdog supervisor did not exit after closing its lease');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
