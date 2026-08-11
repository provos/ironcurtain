import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APPLE_VM_DAEMON_READINESS_TEXT_BOUNDS } from '../../src/docker-workload/apple-vm-daemon.js';
import { admitDockerWorkloadBundle } from '../../src/docker-workload/infrastructure.js';
import {
  createJsonlDockerWorkloadAuditSink,
  createRecordingDockerWorkloadAuditSink,
  writeLifecycleEvidence,
  DAEMON_READY_ATTESTATION,
  type WriteLifecycleEvidenceOptions,
} from '../../src/docker-workload/lifecycle-evidence.js';
import {
  ADMISSION_BINDINGS,
  ADMISSION_CONFIG_HASH,
  WATCHDOG_ENTRYPOINT_PATH,
  WATCHDOG_TEMPLATE_PATH,
  createEventRuntime,
  createFakeClock,
  createFakeSupervisor,
  useDockerWorkloadHome,
} from './helpers/infrastructure-harness.js';

const getHome = useDockerWorkloadHome();
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function evidenceOptions(): WriteLifecycleEvidenceOptions {
  return {
    runId: 'docker-workload-lifecycle-001',
    variant: 'apple-rootless-vfs',
    platform: 'apple-container',
    architecture: 'arm64',
    startedAt: '2026-07-20T12:00:00.000Z',
    completedAt: '2026-07-20T12:01:00.000Z',
    contents: {
      lease: { leaseId: 'dw-evidence', status: 'closed', cleanupInventoryGapMs: 500 },
      renderedPolicy: { policyId: 'docker-workload-observed-state-v1' },
      supervisorStatusHistory: [{ state: 'ready' }, { state: 'closed' }],
      revocation: { removedResourceIds: ['owned-id'], finalOwnedResourceIds: [] },
      cleanup: {
        exactOuterResourcesAbsent: true,
        stateRootAbsent: true,
        inventories: [
          { capturedAt: '2026-07-20T12:00:00.000Z', ownedResourceIds: [] },
          { capturedAt: '2026-07-20T12:00:00.500Z', ownedResourceIds: [] },
        ],
      },
    },
  };
}

function evidenceDir(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'docker-workload-evidence-')));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

describe('Docker-workload lifecycle evidence', () => {
  it('records the admit → activate → teardown audit event sequence', async () => {
    const clock = createFakeClock();
    const runtime = createEventRuntime();
    const supervisor = createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true });
    const sink = createRecordingDockerWorkloadAuditSink();
    const handle = await admitDockerWorkloadBundle({
      runtime: runtime.runtime,
      runtimeKind: 'docker',
      bundleId: 'bundle-evidence-001',
      workspaceRoot: join(getHome(), 'workspace'),
      bindings: ADMISSION_BINDINGS,
      configHash: ADMISSION_CONFIG_HASH,
      watchdogPolicyTemplatePath: WATCHDOG_TEMPLATE_PATH,
      watchdogSupervisorEntrypointPath: WATCHDOG_ENTRYPOINT_PATH,
      auditSink: sink,
      clock: clock.clock,
      sleep: clock.sleep,
      pidAlive: () => true,
      supervisor,
      startHeartbeat: false,
    });
    runtime.setLeasePath(handle.leasePath);
    await handle.attestWatchdog();
    const grant = handle.requestOuterResource('container', 'nested-daemon');
    const containerId = await runtime.runtime.create({
      name: grant.requestedName,
      image: 'ironcurtain-nested-daemon',
      mounts: [],
      network: 'none',
      env: {},
      command: [],
      labels: grant.labels,
    });
    grant.observed(containerId);
    handle.activate();
    await handle.teardown();

    expect(sink.events.map((event) => event.kind)).toEqual([
      'admission-decision',
      'watchdog-attested',
      'outer-create',
      'lease-transition',
      'lease-transition',
      'revocation-result',
      'cleanup-proof',
    ]);
  });

  it('creates a not-yet-existing evidence directory before the first write', () => {
    const directory = join(evidenceDir(), 'nested', 'evidence');
    const summary = writeLifecycleEvidence(directory, evidenceOptions());
    expect(JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'))).toEqual(summary);
  });

  it('writes a simple summary and the actual two-inventory cleanup proof', () => {
    const directory = evidenceDir();
    const summary = writeLifecycleEvidence(directory, evidenceOptions());
    expect(summary).toEqual({
      schemaVersion: 1,
      runId: 'docker-workload-lifecycle-001',
      backend: 'apple-rootless-vfs',
      platform: 'apple-container',
      architecture: 'arm64',
      startedAt: '2026-07-20T12:00:00.000Z',
      completedAt: '2026-07-20T12:01:00.000Z',
      files: [
        'lease.json',
        'policy.json',
        'supervisor-status-history.json',
        'revocation-result.json',
        'cleanup/inventory-1.json',
        'cleanup/inventory-2.json',
      ],
      cleanup: evidenceOptions().contents.cleanup,
    });
    expect(JSON.parse(readFileSync(join(directory, 'cleanup', 'inventory-1.json'), 'utf8'))).toEqual(
      summary.cleanup.inventories[0],
    );
    expect(JSON.parse(readFileSync(join(directory, 'cleanup', 'inventory-2.json'), 'utf8'))).toEqual(
      summary.cleanup.inventories[1],
    );
    expect(statSync(directory).mode & 0o077).toBe(0);
    for (const path of [...summary.files, 'summary.json']) {
      expect(statSync(join(directory, path)).mode & 0o077).toBe(0);
    }
  });

  it('rejects lifecycle evidence unless both cleanup inventories are empty', () => {
    const directory = evidenceDir();
    const options = evidenceOptions();
    options.contents.cleanup.inventories[1].ownedResourceIds.push('leaked-container');
    expect(() => writeLifecycleEvidence(directory, options)).toThrow(/two empty cleanup inventories/u);
    expect(() => statSync(join(directory, 'summary.json'))).toThrow();
  });

  it('requires a canonical absolute owner-only evidence root', () => {
    const directory = evidenceDir();
    expect(() => writeLifecycleEvidence('relative-evidence', evidenceOptions())).toThrow(/canonical and absolute/u);
    chmodSync(directory, 0o755);
    expect(() => writeLifecycleEvidence(directory, evidenceOptions())).toThrow(/owner-only/u);
    expect(existsSync(join(directory, 'summary.json'))).toBe(false);
  });

  it('rejects an evidence or cleanup root that is itself a symlink', () => {
    const parent = evidenceDir();
    const target = join(parent, 'target');
    mkdirSync(target, { mode: 0o700 });
    const alias = join(parent, 'alias');
    symlinkSync(target, alias);
    expect(() => writeLifecycleEvidence(alias, evidenceOptions())).toThrow(/symlink|canonical/u);
    expect(existsSync(join(target, 'summary.json'))).toBe(false);

    const root = join(parent, 'root');
    mkdirSync(root, { mode: 0o700 });
    const cleanupTarget = join(parent, 'cleanup-target');
    mkdirSync(cleanupTarget, { mode: 0o700 });
    symlinkSync(cleanupTarget, join(root, 'cleanup'));
    expect(() => writeLifecycleEvidence(root, evidenceOptions())).toThrow(/cleanup root.*real canonical/u);
    expect(existsSync(join(root, 'summary.json'))).toBe(false);
    expect(existsSync(join(cleanupTarget, 'inventory-1.json'))).toBe(false);
  });

  it('rejects every preexisting output leaf, including a broken symlink', () => {
    const root = evidenceDir();
    writeFileSync(join(root, 'policy.json'), '{}\n');
    expect(() => writeLifecycleEvidence(root, evidenceOptions())).toThrow(/output already exists: policy\.json/u);
    expect(existsSync(join(root, 'summary.json'))).toBe(false);

    const secondRoot = evidenceDir();
    symlinkSync(join(secondRoot, 'missing-target'), join(secondRoot, 'summary.json'));
    expect(() => writeLifecycleEvidence(secondRoot, evidenceOptions())).toThrow(
      /output already exists: summary\.json/u,
    );
    expect(existsSync(join(secondRoot, 'missing-target'))).toBe(false);
  });

  it('validates the lease cleanup gap before creating any output', () => {
    const parent = evidenceDir();
    const root = join(parent, 'not-created');
    const base = evidenceOptions();
    const options = { ...base, contents: { ...base.contents, lease: { cleanupInventoryGapMs: 1_000 } } };
    expect(() => writeLifecycleEvidence(root, options)).toThrow(/not sufficiently separated/u);
    expect(existsSync(root)).toBe(false);
  });

  it('serializes every payload before creating any output', () => {
    // The ordering is the point: an unserializable payload must not leave a
    // partial evidence set behind. `JSON.stringify` owns the rejection.
    const parent = evidenceDir();
    const root = join(parent, 'not-created');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const base = evidenceOptions();
    const options = { ...base, contents: { ...base.contents, renderedPolicy: cyclic } };
    expect(() => writeLifecycleEvidence(root, options)).toThrow();
    expect(existsSync(root)).toBe(false);
  });

  it('round-trips a daemon-ready event and rejects an unadjudicated one', () => {
    const sink = createRecordingDockerWorkloadAuditSink();
    sink.emit({
      at: '2026-07-29T12:00:00.000Z',
      leaseId: 'dw-daemon-ready',
      generation: 'gen-dw-daemon-ready',
      kind: 'daemon-ready',
      attestation: DAEMON_READY_ATTESTATION,
      driver: 'vfs',
      securityOptions: ['name=seccomp,profile=builtin', 'name=rootless'],
      serverVersion: '29.2.1',
      readinessMs: 4_200,
    });
    expect(sink.events).toEqual([
      {
        at: '2026-07-29T12:00:00.000Z',
        leaseId: 'dw-daemon-ready',
        generation: 'gen-dw-daemon-ready',
        kind: 'daemon-ready',
        attestation: DAEMON_READY_ATTESTATION,
        driver: 'vfs',
        securityOptions: ['name=seccomp,profile=builtin', 'name=rootless'],
        serverVersion: '29.2.1',
        readinessMs: 4_200,
      },
    ]);
    expect(() =>
      sink.emit({
        at: '2026-07-29T12:00:00.000Z',
        leaseId: 'dw-daemon-ready',
        generation: 'gen-dw-daemon-ready',
        kind: 'daemon-ready',
        attestation: DAEMON_READY_ATTESTATION,
        driver: '',
        securityOptions: ['name=rootless'],
        serverVersion: '29.2.1',
        readinessMs: 4_200,
      } as never),
    ).toThrow();
  });

  it('rejects a daemon-ready event that omits the bundle-local provenance marker', () => {
    // These values reach the host over a socket an in-VM party can answer
    // (plan §4.2), so the record sits beside genuinely host-observed events
    // (watchdog-attested, cleanup-proof) and must declare that it is advisory.
    const sink = createRecordingDockerWorkloadAuditSink();
    const base = {
      at: '2026-07-29T12:00:00.000Z',
      leaseId: 'dw-daemon-ready',
      generation: 'gen-dw-daemon-ready',
      kind: 'daemon-ready',
      driver: 'vfs',
      securityOptions: ['name=rootless'],
      serverVersion: '29.2.1',
      readinessMs: 4_200,
    };
    expect(DAEMON_READY_ATTESTATION).toBe('bundle-local-advisory');
    expect(() => sink.emit(base as never)).toThrow();
    expect(() => sink.emit({ ...base, attestation: 'host-observed' } as never)).toThrow();
  });

  it('bounds daemon-ready text at exactly the values the readiness probe enforces', () => {
    // Same numbers on both sides. If they drifted, a value the probe accepted
    // would fail here — turning a successful readiness into what reads as a
    // host bug rather than the fail-closed decision it should have been.
    const sink = createRecordingDockerWorkloadAuditSink();
    const bounds = APPLE_VM_DAEMON_READINESS_TEXT_BOUNDS;
    const atBound = {
      at: '2026-07-29T12:00:00.000Z',
      leaseId: 'dw-daemon-ready',
      generation: 'gen-dw-daemon-ready',
      kind: 'daemon-ready' as const,
      attestation: DAEMON_READY_ATTESTATION,
      driver: 'v'.repeat(bounds.driverLength),
      securityOptions: ['o'.repeat(bounds.securityOptionLength)],
      serverVersion: 's'.repeat(bounds.serverVersionLength),
      readinessMs: 4_200,
    };
    expect(() => sink.emit(atBound)).not.toThrow();
    expect(() => sink.emit({ ...atBound, driver: 'v'.repeat(bounds.driverLength + 1) })).toThrow();
    expect(() => sink.emit({ ...atBound, serverVersion: 's'.repeat(bounds.serverVersionLength + 1) })).toThrow();
    expect(() => sink.emit({ ...atBound, securityOptions: ['o'.repeat(bounds.securityOptionLength + 1)] })).toThrow();
    expect(() =>
      sink.emit({
        ...atBound,
        securityOptions: Array.from({ length: bounds.securityOptionCount + 1 }, () => 'name=rootless'),
      }),
    ).toThrow();
  });

  it('appends valid JSONL and rejects a malformed lifecycle event fail-closed', () => {
    const directory = evidenceDir();
    const path = join(directory, 'lifecycle.jsonl');
    const sink = createJsonlDockerWorkloadAuditSink(path);
    sink.emit({
      at: '2026-07-20T12:00:00.000Z',
      leaseId: 'dw-jsonl',
      generation: 'gen-dw-jsonl',
      kind: 'lease-transition',
      from: 'admitting',
      to: 'active',
    });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ kind: 'lease-transition', from: 'admitting', to: 'active' });
    expect(() =>
      sink.emit({
        at: 'not-a-timestamp',
        leaseId: 'dw-jsonl',
        generation: 'gen',
        kind: 'incident',
        code: 'x',
        detail: 'y',
      } as never),
    ).toThrow();
  });
});
