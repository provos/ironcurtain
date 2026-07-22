/**
 * Cross-process proof that the detached resource-watchdog supervisor survives
 * a coordinator SIGKILL and still enforces bundle revocation.
 *
 * A real coordinator-role child process creates the lease, renders the policy,
 * and launches the real detached supervisor through the production spawn path
 * (`launchDetachedResourceWatchdogSupervisor` -> resource-watchdog-supervisor-main).
 * The test then SIGKILLs the coordinator and proves the supervisor is still
 * alive, does not revoke while nothing has tripped, and — once the frozen hard
 * state threshold is breached after the coordinator is dead — revokes the
 * leased container, removes the exact bundle state, closes the lease with a
 * two-inventory cleanup proof, and exits.
 *
 * Hermetic: no Docker daemon. The supervisor's DockerManager resolves a
 * stateful `docker` stub from PATH; the stub logs every invocation to a JSONL
 * evidence file the test asserts against.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import {
  loadResourceWatchdogSupervisorStatus,
  type ResourceWatchdogSupervisorStatus,
} from '../../src/docker-workload/resource-watchdog-supervisor.js';
import type { WatchdogPolicyTemplate } from '../../src/docker-workload/watchdog-policy.js';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const coordinatorPath = join(repoRoot, 'test', 'docker-workload', 'fixtures', 'watchdog-sigkill-coordinator.ts');
const dockerStubPath = join(repoRoot, 'test', 'docker-workload', 'fixtures', 'watchdog-sigkill-docker-stub.ts');
const entrypointPath = join(repoRoot, 'src', 'docker-workload', 'resource-watchdog-supervisor-main.ts');

const GENERATION = 'generation-sigkill-cross-001';
const CONTAINER_ID = `cafe${'0123456789abcdef'.repeat(3)}baseddecafc0ffee`;
const CONTAINER_NAME = 'ironcurtain-sigkill-agent-001';
const LABEL_KEY = 'ironcurtain.workload.generation';

const template: WatchdogPolicyTemplate = {
  schemaVersion: 1,
  policyId: 'sigkill-cross-process-watchdog-v1',
  stateClasses: [{ id: 'daemon-state', relativePath: 'daemon', kind: 'directory', required: true }],
  sampleIntervalMs: 100,
  sampleTimeoutMs: 500,
  // Generous staleness bound so CI scheduling hiccups cannot fake a
  // sample-stale trip; hard-threshold detection still happens on the next
  // ~100ms tick after the breach.
  staleAfterMs: 2000,
  softEvidenceBytes: 256 * 1024,
  hardSafetyBytes: 1024 * 1024,
  hostReserveBytes: 1,
  maximumOvershootBytes: 16 * 1024 * 1024,
  cleanupInventoryGapMs: 100,
};

const temporaryDirectories: string[] = [];
const spawnedPids: number[] = [];

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already exited.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('resource watchdog supervisor across a coordinator SIGKILL', () => {
  it('outlives the coordinator and revokes a post-mortem hard-threshold breach', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchdog-sigkill-'));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o700);
    const binDir = join(directory, 'bin');
    const stubDir = join(directory, 'stub');
    mkdirSync(binDir);
    mkdirSync(stubDir);
    const stateRoot = join(directory, 'state');
    const leasePath = join(directory, 'lease.json');
    const statusPath = join(directory, 'status.json');
    const resultPath = join(directory, 'coordinator-result.json');
    const configPath = join(stubDir, 'config.json');
    const logPath = join(stubDir, 'invocations.log');

    writeFileSync(
      configPath,
      `${JSON.stringify({
        controlDir: directory,
        leaseId: 'lease-sigkill-cross-001',
        bundleId: 'bundle-sigkill-cross-001',
        generation: GENERATION,
        containerId: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        labelKey: LABEL_KEY,
        labelValue: GENERATION,
        template,
        logPath,
        removedMarkerPath: join(stubDir, 'removed.marker'),
      })}\n`,
      { mode: 0o600 },
    );
    const dockerShim = join(binDir, 'docker');
    writeFileSync(
      dockerShim,
      [
        '#!/bin/bash',
        // The stub is TypeScript; keep the tsx loader registration the test
        // injects through NODE_OPTIONS so plain node can execute it.
        `cd ${JSON.stringify(repoRoot)}`,
        `export IRONCURTAIN_WATCHDOG_DOCKER_STUB_CONFIG=${JSON.stringify(configPath)}`,
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(dockerStubPath)} "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const coordinator = spawn(process.execPath, [coordinatorPath, configPath, entrypointPath, resultPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: '--import tsx',
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const coordinatorPid = coordinator.pid;
    expect(coordinatorPid).toBeDefined();
    if (coordinatorPid !== undefined) spawnedPids.push(coordinatorPid);
    let coordinatorStderr = '';
    coordinator.stderr.on('data', (chunk: Buffer) => {
      coordinatorStderr += chunk.toString('utf8');
    });
    coordinator.stdout.resume();
    const coordinatorExit = watchExit(coordinator);

    let supervisorPid: number | undefined;
    try {
      // Coordinator admits the bundle and launches the detached supervisor.
      await pollUntil(
        30_000,
        () => existsSync(resultPath),
        () => {
          const exited = coordinatorExit.exited ? ` (coordinator exited early)` : '';
          return `coordinator never reported a launch result${exited}: ${coordinatorStderr}`;
        },
      );
      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
        readonly supervisorPid?: number;
        readonly error?: string;
      };
      if (result.error !== undefined || result.supervisorPid === undefined) {
        throw new Error(
          `coordinator failed before launch completed: ${result.error ?? 'no pid'}\n${coordinatorStderr}`,
        );
      }
      supervisorPid = result.supervisorPid;
      spawnedPids.push(supervisorPid);
      expect(loadResourceWatchdogSupervisorStatus(statusPath)).toMatchObject({
        supervisorPid,
        state: 'ready',
        policyId: template.policyId,
      });

      // Negative proof: while the coordinator is alive and heartbeating, the
      // supervisor neither revokes nor touches the container runtime.
      const heartbeatBefore = loadDockerWorkloadLease(leasePath).coordinator.heartbeatAt;
      const negativeDeadline = Date.now() + 600;
      while (Date.now() < negativeDeadline) {
        expect(loadResourceWatchdogSupervisorStatus(statusPath).state).toBe('ready');
        expect(loadDockerWorkloadLease(leasePath).status).toBe('active');
        expect(existsSync(logPath)).toBe(false);
        await sleep(50);
      }
      await pollUntil(
        3000,
        () => Date.parse(loadDockerWorkloadLease(leasePath).coordinator.heartbeatAt) > Date.parse(heartbeatBefore),
        () => 'coordinator stub never advanced its lease heartbeat',
      );
      expect(processAlive(coordinatorPid as number)).toBe(true);

      // SIGKILL the coordinator (no graceful exit) and prove the detached
      // supervisor survives and still does not revoke without a trip.
      process.kill(coordinatorPid as number, 'SIGKILL');
      await pollUntil(
        5000,
        () => coordinatorExit.exited,
        () => 'coordinator did not die from SIGKILL',
      );
      expect(processAlive(supervisorPid)).toBe(true);
      const survivalDeadline = Date.now() + 500;
      while (Date.now() < survivalDeadline) {
        expect(processAlive(supervisorPid)).toBe(true);
        expect(loadResourceWatchdogSupervisorStatus(statusPath).state).toBe('ready');
        await sleep(50);
      }

      // Breach the frozen hard state threshold now that the coordinator is
      // dead; the orphaned supervisor must detect and revoke on its own.
      const breachedAtMs = Date.now();
      writeFileSync(join(stateRoot, 'daemon', 'threshold.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
      let status: ResourceWatchdogSupervisorStatus | undefined;
      await pollUntil(
        20_000,
        () => {
          status = loadResourceWatchdogSupervisorStatus(statusPath);
          if (status.state === 'incident') {
            throw new Error(`watchdog supervisor incident instead of revocation: ${status.detail ?? 'unknown'}`);
          }
          return status.state === 'closed';
        },
        () => `watchdog supervisor never closed after the breach (state=${status?.state ?? 'unknown'})`,
      );
      const detectionLatencyMs = Date.now() - breachedAtMs;
      expect(status).toMatchObject({
        state: 'closed',
        supervisorPid,
        trip: { code: 'hard-state-threshold' },
      });

      // Revocation duty: exact container removal proof, exact state removal,
      // and a closed lease carrying the two-empty-inventory cleanup proof.
      const lease = loadDockerWorkloadLease(leasePath);
      expect(lease).toMatchObject({
        status: 'closed',
        cleanup: { exactOuterResourcesAbsent: true, stateRootAbsent: true },
      });
      expect(lease.resources).toEqual([
        expect.objectContaining({
          requestId: 'agent-container-001',
          observedId: CONTAINER_ID,
          removal: expect.objectContaining({ proof: 'immutable-id-absent', identity: CONTAINER_ID }),
        }),
      ]);
      expect(existsSync(stateRoot)).toBe(false);

      // The docker stub proves the runtime side of revocation was exercised
      // with the exact leased identity.
      const invocations = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(invocations).toContainEqual(['container', 'inspect', CONTAINER_ID]);
      expect(invocations).toContainEqual(['stop', '-t', '10', CONTAINER_ID]);
      expect(invocations).toContainEqual(['rm', '-f', CONTAINER_ID]);
      expect(invocations).toContainEqual(['inspect', CONTAINER_ID]);
      const stopIndex = invocations.findIndex((args) => args[0] === 'stop');
      const removeIndex = invocations.findIndex((args) => args[0] === 'rm');
      const existsProbeIndex = invocations.findIndex((args) => args[0] === 'inspect');
      expect(stopIndex).toBeLessThan(removeIndex);
      expect(removeIndex).toBeLessThan(existsProbeIndex);
      const inventoryCalls = invocations.filter((args) => args[0] === 'container' && args[1] === 'ls');
      expect(inventoryCalls.length).toBeGreaterThanOrEqual(4);
      for (const call of inventoryCalls) {
        expect(call).toEqual(['container', 'ls', '--all', '--no-trunc', '--quiet']);
      }

      // The supervisor exits after completing its duty.
      await pollUntil(
        5000,
        () => !processAlive(supervisorPid as number),
        () => 'watchdog supervisor did not exit after closing its lease',
      );
      expect(detectionLatencyMs).toBeLessThan(15_000);
      console.info(`watchdog SIGKILL cross-process detection-to-closed latency: ${detectionLatencyMs}ms`);
    } finally {
      if (supervisorPid !== undefined && processAlive(supervisorPid)) process.kill(supervisorPid, 'SIGKILL');
      if (coordinatorPid !== undefined && processAlive(coordinatorPid)) process.kill(coordinatorPid, 'SIGKILL');
    }
  }, 60_000);
});

function watchExit(child: ChildProcess): { exited: boolean } {
  const state = { exited: false };
  child.once('exit', () => {
    state.exited = true;
  });
  return state;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function pollUntil(timeoutMs: number, condition: () => boolean, describeFailure: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) throw new Error(describeFailure());
    await sleep(25);
  }
}
