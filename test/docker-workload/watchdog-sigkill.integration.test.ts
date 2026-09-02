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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getBundleRuntimeRoot } from '../../src/config/paths.js';
import type { BundleId } from '../../src/session/types.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import {
  loadResourceWatchdogSupervisorStatus,
  type ResourceWatchdogSupervisorStatus,
} from '../../src/docker-workload/resource-watchdog-supervisor.js';
import { getProcessStartIdentity } from '../../src/docker-workload/process-lock.js';
import type { WatchdogPolicyTemplate } from '../../src/docker-workload/watchdog-policy.js';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const coordinatorPath = join(repoRoot, 'test', 'docker-workload', 'fixtures', 'watchdog-sigkill-coordinator.ts');
const dockerStubPath = join(repoRoot, 'test', 'docker-workload', 'fixtures', 'watchdog-sigkill-docker-stub.mjs');
const entrypointPath = join(repoRoot, 'src', 'docker-workload', 'resource-watchdog-supervisor-main.ts');

const GENERATION = 'generation-sigkill-cross-001';
const CONTAINER_ID = `cafe${'0123456789abcdef'.repeat(3)}baseddecafc0ffee`;
const CONTAINER_NAME = 'ironcurtain-sigkill-agent-001';
const PROXY_CONTAINER_ID = `face${'fedcba9876543210'.repeat(3)}cafe0123456789`;
const PROXY_CONTAINER_NAME = 'ironcurtain-sigkill-proxy-001';
const NETWORK_ID = `beef${'0011223344556677'.repeat(3)}feed89abcdef01`;
const NETWORK_NAME = 'ironcurtain-sigkill-network-001';
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
const spawnedChildren: ChildProcess[] = [];
const detachedProcesses: TrackedProcess[] = [];

afterEach(() => {
  for (const child of spawnedChildren.splice(0)) killChildIfRunning(child);
  for (const tracked of detachedProcesses.splice(0)) killTrackedProcessIfSameInstance(tracked);
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface TrackedProcess {
  readonly pid: number;
  readonly processIdentity: string;
}

describe('resource watchdog supervisor across a coordinator SIGKILL', () => {
  it('outlives the coordinator and revokes a post-mortem hard-threshold breach', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchdog-sigkill-'));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o700);
    const binDir = join(directory, 'bin');
    const stubDir = join(directory, 'stub');
    mkdirSync(binDir);
    mkdirSync(stubDir);
    const ironCurtainHome = join(directory, 'home');
    const stateRoot = join(ironCurtainHome, 'docker-workload', 'state', 'lease-sigkill-cross-001');
    const leasePath = join(directory, 'lease.json');
    const statusPath = join(directory, 'status.json');
    const resultPath = join(directory, 'coordinator-result.json');
    const configPath = join(stubDir, 'config.json');
    const logPath = join(stubDir, 'invocations.log');
    const bundleId = 'bundle-sigkill-cross-001';
    const bundleRuntimeRoot = withIronCurtainHome(ironCurtainHome, () => getBundleRuntimeRoot(bundleId as BundleId));
    const neighboringRuntimeRoot = withIronCurtainHome(ironCurtainHome, () =>
      getBundleRuntimeRoot('neighbor-sigkill-cross-001' as BundleId),
    );
    const workspaceRoot = join(directory, 'workspace');
    mkdirSync(bundleRuntimeRoot, { recursive: true });
    mkdirSync(neighboringRuntimeRoot, { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(join(bundleRuntimeRoot, 'runtime-marker'), 'owned by the crashed bundle\n');
    const neighboringMarker = join(neighboringRuntimeRoot, 'unrelated-marker');
    const workspaceMarker = join(workspaceRoot, 'workspace-marker');
    writeFileSync(neighboringMarker, 'owned by another bundle\n');
    writeFileSync(workspaceMarker, 'workspace data\n');

    writeFileSync(
      configPath,
      `${JSON.stringify({
        controlDir: directory,
        leaseId: 'lease-sigkill-cross-001',
        bundleId,
        generation: GENERATION,
        containerId: CONTAINER_ID,
        containerName: CONTAINER_NAME,
        proxyContainerId: PROXY_CONTAINER_ID,
        proxyContainerName: PROXY_CONTAINER_NAME,
        networkId: NETWORK_ID,
        networkName: NETWORK_NAME,
        labelKey: LABEL_KEY,
        labelValue: GENERATION,
        template,
        logPath,
        removedMarkerPath: join(stubDir, 'agent-removed.marker'),
        proxyRemovedMarkerPath: join(stubDir, 'proxy-removed.marker'),
        networkRemovedMarkerPath: join(stubDir, 'network-removed.marker'),
      })}\n`,
      { mode: 0o600 },
    );
    const dockerShim = join(binDir, 'docker');
    // Execute the plain-JavaScript stub through the native `env` shim in its
    // shebang. It clears NODE_OPTIONS before Node starts, while the coordinator
    // and detached supervisor retain the tsx loader they need.
    symlinkSync(dockerStubPath, dockerShim);

    // IDE auto-attach instrumentation can delay each short-lived Docker stub
    // while it contends for a debugger port, eventually tripping DockerManager's
    // command timeout and violating this test's hermetic process boundary.
    const childEnv = { ...process.env };
    delete childEnv.VSCODE_INSPECTOR_OPTIONS;
    delete childEnv.VSCODE_INJECTION;
    childEnv.NODE_OPTIONS = '--import tsx';
    childEnv.IRONCURTAIN_HOME = ironCurtainHome;
    childEnv.IRONCURTAIN_WATCHDOG_DOCKER_STUB_CONFIG = configPath;
    childEnv.PATH = `${binDir}:${process.env.PATH ?? ''}`;

    const coordinator = spawn(process.execPath, [coordinatorPath, configPath, entrypointPath, resultPath], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawnedChildren.push(coordinator);
    const coordinatorPid = coordinator.pid;
    expect(coordinatorPid).toBeDefined();
    let coordinatorStderr = '';
    coordinator.stderr.on('data', (chunk: Buffer) => {
      coordinatorStderr += chunk.toString('utf8');
    });
    coordinator.stdout.resume();
    const coordinatorExit = watchExit(coordinator);

    let supervisorPid: number | undefined;
    let supervisorProcess: TrackedProcess | undefined;
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
      supervisorProcess = trackDetachedProcess(supervisorPid);
      detachedProcesses.push(supervisorProcess);
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
      expect(coordinatorExit.exited).toBe(false);

      // SIGKILL the coordinator (no graceful exit) and prove the detached
      // supervisor survives and still does not revoke without a trip.
      coordinator.kill('SIGKILL');
      await pollUntil(
        5000,
        () => coordinatorExit.exited,
        () => 'coordinator did not die from SIGKILL',
      );
      expect(processIsSameInstance(supervisorProcess)).toBe(true);
      const survivalDeadline = Date.now() + 500;
      while (Date.now() < survivalDeadline) {
        expect(processIsSameInstance(supervisorProcess)).toBe(true);
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
      expect(lease.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestId: 'agent-container-001',
            observedId: CONTAINER_ID,
            removal: expect.objectContaining({ proof: 'immutable-id-absent', identity: CONTAINER_ID }),
          }),
          expect.objectContaining({
            requestId: 'transport-proxy-001',
            observedId: PROXY_CONTAINER_ID,
            removal: expect.objectContaining({ proof: 'immutable-id-absent', identity: PROXY_CONTAINER_ID }),
          }),
          expect.objectContaining({
            requestId: 'transport-network-001',
            observedId: NETWORK_ID,
            removal: expect.objectContaining({ proof: 'immutable-id-absent', identity: NETWORK_ID }),
          }),
        ]),
      );
      expect(existsSync(stateRoot)).toBe(false);
      expect(existsSync(bundleRuntimeRoot)).toBe(false);
      expect(existsSync(neighboringMarker)).toBe(true);
      expect(existsSync(workspaceMarker)).toBe(true);
      expect(existsSync(leasePath)).toBe(true);

      // The docker stub proves the runtime side of revocation was exercised
      // with the exact leased identity.
      const invocations = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(
        invocations.some((args) => args[0] === 'container' && args[1] === 'inspect' && args.includes(CONTAINER_ID)),
      ).toBe(true);
      expect(
        invocations.some(
          (args) => args[0] === 'container' && args[1] === 'inspect' && args.includes(PROXY_CONTAINER_ID),
        ),
      ).toBe(true);
      expect(invocations).toContainEqual(['stop', '-t', '10', CONTAINER_ID]);
      expect(invocations).toContainEqual(['stop', '-t', '10', PROXY_CONTAINER_ID]);
      expect(invocations).toContainEqual(['rm', '-f', CONTAINER_ID]);
      expect(invocations).toContainEqual(['rm', '-f', PROXY_CONTAINER_ID]);
      expect(invocations).toContainEqual(['network', 'rm', NETWORK_ID]);
      const stopIndex = invocations.findIndex((args) => args[0] === 'stop');
      const removeIndex = invocations.findIndex((args) => args[0] === 'rm');
      const networkRemoveIndex = invocations.findIndex((args) => args[0] === 'network' && args[1] === 'rm');
      const postRemoveInventoryIndex = invocations.findIndex(
        (args, index) => index > networkRemoveIndex && args[0] === 'container' && args[1] === 'ls',
      );
      expect(stopIndex).toBeLessThan(removeIndex);
      expect(removeIndex).toBeLessThan(networkRemoveIndex);
      expect(networkRemoveIndex).toBeLessThan(postRemoveInventoryIndex);
      expect(invocations[postRemoveInventoryIndex]).toEqual(['container', 'ls', '--all', '--no-trunc', '--quiet']);
      expect(invocations.slice(removeIndex + 1)).not.toContainEqual(['inspect', CONTAINER_ID]);
      const inventoryCalls = invocations.filter((args) => args[0] === 'container' && args[1] === 'ls');
      expect(inventoryCalls.length).toBeGreaterThanOrEqual(5);
      for (const call of inventoryCalls) {
        expect(call).toEqual(['container', 'ls', '--all', '--no-trunc', '--quiet']);
      }

      // The supervisor exits after completing its duty.
      await pollUntil(
        5000,
        () => !processIsSameInstance(supervisorProcess as TrackedProcess),
        () => 'watchdog supervisor did not exit after closing its lease',
      );
      // Cleanup is identity-fenced: an absent process or a future process that
      // reuses this PID cannot be mistaken for the detached supervisor.
      expect(processIsSameInstance(supervisorProcess)).toBe(false);
      expect(detectionLatencyMs).toBeLessThan(15_000);
      console.info(`watchdog SIGKILL cross-process detection-to-closed latency: ${detectionLatencyMs}ms`);
    } finally {
      if (supervisorProcess !== undefined) killTrackedProcessIfSameInstance(supervisorProcess);
      killChildIfRunning(coordinator);
    }
  }, 60_000);
});

function withIronCurtainHome<T>(home: string, operation: () => T): T {
  const previous = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = home;
  try {
    return operation();
  } finally {
    if (previous === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previous;
  }
}

function watchExit(child: ChildProcess): { exited: boolean } {
  const state = { exited: false };
  child.once('exit', () => {
    state.exited = true;
  });
  return state;
}

function trackDetachedProcess(pid: number): TrackedProcess {
  const processIdentity = getProcessStartIdentity(pid);
  if (processIdentity === undefined) throw new Error(`detached process ${pid} exited before its identity was captured`);
  return { pid, processIdentity };
}

function processIsSameInstance(tracked: TrackedProcess): boolean {
  try {
    return getProcessStartIdentity(tracked.pid) === tracked.processIdentity;
  } catch {
    return false;
  }
}

function killTrackedProcessIfSameInstance(tracked: TrackedProcess): void {
  if (!processIsSameInstance(tracked)) return;
  try {
    process.kill(tracked.pid, 'SIGKILL');
  } catch {
    // The exact process exited after the identity check.
  }
}

function killChildIfRunning(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // The child exited after the handle state check.
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
