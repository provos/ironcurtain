/**
 * Coordinator-role stub for the watchdog SIGKILL cross-process test.
 *
 * Plays the production coordinator faithfully: renders the per-session
 * watchdog policy, creates the bundle lease (bound to its own PID), records
 * one observed outer container resource, activates the lease, launches the
 * detached watchdog supervisor via the production spawn path, then heartbeats
 * the lease until the test SIGKILLs it. It never exits on its own.
 *
 * argv: <sharedConfigPath> <entrypointPath> <resultPath>
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  activateDockerWorkloadLease,
  createDockerWorkloadLease,
  heartbeatDockerWorkloadLease,
  observeDockerWorkloadOuterResource,
  requestDockerWorkloadOuterResource,
} from '../../../src/docker-workload/bundle-lease.js';
import { renderWatchdogPolicy, type WatchdogPolicyTemplate } from '../../../src/docker-workload/watchdog-policy.js';
import { launchDetachedResourceWatchdogSupervisor } from '../../../src/docker-workload/resource-watchdog-supervisor.js';

interface SharedFixtureConfig {
  readonly controlDir: string;
  readonly leaseId: string;
  readonly bundleId: string;
  readonly generation: string;
  readonly containerId: string;
  readonly containerName: string;
  readonly labelKey: string;
  readonly labelValue: string;
  readonly template: WatchdogPolicyTemplate;
}

const sharedConfigPath = process.argv.at(2);
const entrypointPath = process.argv.at(3);
const resultPath = process.argv.at(4);
if (sharedConfigPath === undefined || entrypointPath === undefined || resultPath === undefined) {
  throw new Error('watchdog SIGKILL coordinator requires config, entrypoint, and result paths');
}

try {
  const config = JSON.parse(readFileSync(sharedConfigPath, 'utf8')) as SharedFixtureConfig;
  const stateRoot = join(config.controlDir, 'state');
  mkdirSync(join(stateRoot, 'daemon'), { recursive: true });
  const leasePath = join(config.controlDir, 'lease.json');
  const policyPath = join(config.controlDir, 'policy.json');
  const statusPath = join(config.controlDir, 'status.json');
  const stopRequestPath = join(config.controlDir, 'stop.json');

  const rendered = renderWatchdogPolicy(config.template, stateRoot, policyPath);
  createDockerWorkloadLease(leasePath, {
    leaseId: config.leaseId,
    bundleId: config.bundleId,
    generation: config.generation,
    runtimeKind: 'docker',
    paths: {
      workspaceRoot: join(config.controlDir, 'workspace'),
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
      watchdogPolicySha256: rendered.sha256,
      toolchainDigest: '6'.repeat(64),
    },
    cleanupInventoryGapMs: config.template.cleanupInventoryGapMs,
  });
  requestDockerWorkloadOuterResource(leasePath, config.generation, {
    requestId: 'agent-container-001',
    kind: 'container',
    role: 'agent',
    requestedName: config.containerName,
    ownershipLabelKey: config.labelKey,
  });
  observeDockerWorkloadOuterResource(leasePath, config.generation, 'agent-container-001', config.containerId);
  activateDockerWorkloadLease(leasePath, config.generation);

  const launched = await launchDetachedResourceWatchdogSupervisor({
    leasePath,
    policyPath,
    statusPath,
    stopRequestPath,
    entrypointPath,
    startupTimeoutMs: 30_000,
  });

  writeResultAtomically({ coordinatorPid: process.pid, supervisorPid: launched.pid });

  // Heartbeat forever; only the test's SIGKILL ends this process. A terminal
  // lease would make heartbeats throw, but by then this process is dead.
  setInterval(() => {
    try {
      heartbeatDockerWorkloadLease(leasePath, config.generation);
    } catch {
      // Transient lock contention; the next interval retries.
    }
  }, 100);
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  writeResultAtomically({ error: message });
  process.exit(1);
}

/** Write-then-rename so the test never observes a partially written result file. */
function writeResultAtomically(result: object): void {
  const tempPath = `${resultPath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  renameSync(tempPath, resultPath);
}
