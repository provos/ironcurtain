import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getBundleRuntimeRoot, getDockerWorkloadLeaseDir, getDockerWorkloadStateRoot } from '../../src/config/paths.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import {
  admitDockerWorkloadBundle,
  DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY,
  reconcileDockerWorkloadLeases,
  type DockerWorkloadBundleHandle,
} from '../../src/docker-workload/infrastructure.js';
import { DOCKER_WORKLOAD_STALE_HEARTBEAT_MS } from '../../src/docker-workload/watchdog-policy.js';
import type { DockerContainerInfo } from '../../src/docker/types.js';
import type { BundleId } from '../../src/session/types.js';
import {
  ADMISSION_CONFIGURATION,
  WATCHDOG_ENTRYPOINT_PATH,
  WATCHDOG_TEMPLATE_PATH,
  createEventRuntime,
  createFakeClock,
  createFakeSupervisor,
  useDockerWorkloadHome,
  type EventRuntime,
} from './helpers/infrastructure-harness.js';

const getHome = useDockerWorkloadHome();
const bundleId = 'bundle-recovery-model' as BundleId;
const oldLeaseId = 'dw-old';
const newLeaseId = 'dw-new';
const requestedName = 'ironcurtain-model-agent';
const unrelated = foreignContainer('unrelated', 'other-agent');
const replacement = foreignContainer('replacement', requestedName);

const crashPoints = ['before precommit', 'after precommit', 'after create', 'after observation'] as const;
type CrashPoint = (typeof crashPoints)[number];
const recoveryConditions = ['healthy runtime', 'name reused', 'proof inventory fails', 'remove reply lost'] as const;

// A lost removal reply requires a container to have existed at the crash point.
const traces = crashPoints.flatMap((crashPoint) =>
  recoveryConditions
    .filter((condition) => condition !== 'remove reply lost' || hasContainer(crashPoint))
    .map((condition) => ({ crashPoint, condition })),
);

function hasContainer(crashPoint: CrashPoint): boolean {
  return crashPoint === 'after create' || crashPoint === 'after observation';
}

function foreignContainer(id: string, name: string): DockerContainerInfo {
  return {
    id,
    name,
    created: '2026-07-20T12:00:00.000Z',
    running: true,
    labels: {
      [DOCKER_WORKLOAD_OWNERSHIP_LABEL_KEY]: 'foreign-generation',
    },
  };
}

async function runUntilCrashPoint(
  crashPoint: CrashPoint,
  handle: DockerWorkloadBundleHandle,
  runtime: EventRuntime,
): Promise<string | undefined> {
  if (crashPoint === 'before precommit') return;
  const registration = handle.precommitOuterResource({ kind: 'container', role: 'agent', requestedName });
  if (!hasContainer(crashPoint)) return;
  const id = await runtime.runtime.create({
    name: requestedName,
    image: 'model-agent',
    mounts: [],
    network: 'none',
    env: {},
    command: [],
    labels: { ...registration.labels },
  });
  if (crashPoint === 'after observation') registration.observed(id);
  return id;
}

describe('nested Docker lease recovery model', () => {
  it.each(traces)(
    'preserves ownership across a crash $crashPoint when $condition',
    async ({ crashPoint, condition }) => {
      const clock = createFakeClock();
      const workspaceRoot = join(getHome(), 'workspace');
      const workspaceMarker = join(workspaceRoot, 'keep');
      const runtimeRoot = getBundleRuntimeRoot(bundleId);
      const stateRoot = getDockerWorkloadStateRoot(oldLeaseId);
      const inventory = createEventRuntime({ containers: [unrelated] });
      const inventoriesAfterHostCleanup = new Map<string, string[]>();
      let coordinatorAlive = true;
      let faultEnabled = false;
      let faultObserved = false;

      const options = {
        runtime: {
          ...inventory.runtime,
          async listContainers() {
            if (faultEnabled && condition === 'proof inventory fails' && !existsSync(stateRoot)) {
              faultObserved = true;
              throw new Error('model fault: inventory unavailable after deleting host state');
            }
            const containers = inventory.containers.slice();
            if (!existsSync(stateRoot) && !existsSync(runtimeRoot)) {
              inventoriesAfterHostCleanup.set(
                clock.clock().toISOString(),
                containers.map(({ id }) => id),
              );
            }
            return containers;
          },
          async remove(id: string) {
            await inventory.runtime.remove(id);
            if (faultEnabled && condition === 'remove reply lost') {
              faultObserved = true;
              throw new Error('model fault: Docker removed the container but the reply was lost');
            }
          },
        },
        runtimeKind: 'docker' as const,
        clock: clock.clock,
        sleep: clock.sleep,
        pidAlive: () => coordinatorAlive,
        supervisor: createFakeSupervisor({ clock: clock.clock, statusMode: 'absent' }),
      };
      const admit = (leaseId: string) =>
        admitDockerWorkloadBundle({
          ...options,
          bundleId,
          leaseId,
          generation: `gen-${leaseId}`,
          workspaceRoot,
          configuration: ADMISSION_CONFIGURATION,
          watchdogPolicyTemplatePath: WATCHDOG_TEMPLATE_PATH,
          watchdogSupervisorEntrypointPath: WATCHDOG_ENTRYPOINT_PATH,
          startHeartbeat: false,
        });

      mkdirSync(workspaceRoot);
      writeFileSync(workspaceMarker, 'workspace data');
      const original = await admit(oldLeaseId);
      inventory.setLeasePath(original.leasePath);
      mkdirSync(runtimeRoot, { recursive: true });
      const ownedId = await runUntilCrashPoint(crashPoint, original, inventory);
      const protectedIds = [unrelated.id];

      function assertSafeEffects(): void {
        for (const effect of inventory.events.filter((event) => /^(stop|remove):/u.test(event))) {
          expect([`stop:${ownedId}`, `remove:${ownedId}`]).toContain(effect);
        }
        expect(inventory.containers.map(({ id }) => id)).toEqual(expect.arrayContaining(protectedIds));
        expect(readFileSync(workspaceMarker, 'utf-8')).toBe('workspace data');
      }

      async function reconcile() {
        const result = await reconcileDockerWorkloadLeases(options);
        assertSafeEffects();
        return result;
      }

      const beforeCrash = { events: [...inventory.events], lease: loadDockerWorkloadLease(original.leasePath) };
      expect((await reconcile()).preserved).toEqual([oldLeaseId]);
      coordinatorAlive = false;
      expect((await reconcile()).fenced).toEqual([oldLeaseId]);
      expect(inventory.events).toEqual(beforeCrash.events);
      expect(loadDockerWorkloadLease(original.leasePath)).toEqual(beforeCrash.lease);
      expect(existsSync(runtimeRoot)).toBe(true);
      clock.advance(DOCKER_WORKLOAD_STALE_HEARTBEAT_MS);

      if (condition === 'name reused') {
        // An external actor occupies the name after the original container has gone.
        if (ownedId !== undefined) await inventory.runtime.remove(ownedId);
        inventory.containers.push({ ...replacement });
        protectedIds.push(replacement.id);
      }

      const ambiguousName =
        condition === 'name reused' && (crashPoint === 'after precommit' || crashPoint === 'after create');
      faultEnabled = condition === 'proof inventory fails' || condition === 'remove reply lost';
      const firstRecovery = await reconcile();
      if (ambiguousName || faultEnabled) {
        expect(firstRecovery.fenced).toEqual([oldLeaseId]);
        const unresolved = loadDockerWorkloadLease(original.leasePath);
        expect(unresolved.status).not.toBe('closed');
        expect(unresolved.cleanup).toBeNull();
        if (faultEnabled) expect(faultObserved).toBe(true);
        if (ambiguousName || condition === 'proof inventory fails') {
          await expect(admit(newLeaseId)).rejects.toThrow('unresolved leases block it');
          expect(existsSync(getDockerWorkloadLeaseDir(newLeaseId))).toBe(false);
          assertSafeEffects();
        }

        // Restore the environment so a fresh coordinator can prove cleanup.
        faultEnabled = false;
        if (ambiguousName) {
          const index = inventory.containers.findIndex((container) => container.id === replacement.id);
          expect(index).toBeGreaterThanOrEqual(0);
          inventory.containers[index] = { ...replacement, name: 'relocated-agent' };
        }
        expect((await reconcile()).reconciled).toEqual([oldLeaseId]);
      } else {
        expect(firstRecovery.reconciled).toEqual([oldLeaseId]);
      }

      const closed = loadDockerWorkloadLease(original.leasePath);
      expect(closed.status).toBe('closed');
      expect(closed.cleanup?.inventories).toHaveLength(2);
      for (const { capturedAt, ownedResourceIds } of closed.cleanup?.inventories ?? []) {
        expect(ownedResourceIds).toEqual([]);
        const observedIds = inventoriesAfterHostCleanup.get(capturedAt);
        expect(observedIds).toBeDefined();
        expect(observedIds).not.toContain(ownedId);
      }
      expect(existsSync(stateRoot)).toBe(false);
      expect(existsSync(runtimeRoot)).toBe(false);
      expect(inventory.containers.map(({ id }) => id).sort()).toEqual([...protectedIds].sort());

      coordinatorAlive = true;
      const resumed = await admit(newLeaseId);
      mkdirSync(runtimeRoot, { recursive: true });
      expect((await reconcile()).preserved).toEqual([resumed.leaseId]);
      expect(existsSync(runtimeRoot)).toBe(true);
      expect(loadDockerWorkloadLease(original.leasePath)).toEqual(closed);
    },
  );
});
