import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { admitDockerWorkloadBundle } from '../../src/docker-workload/infrastructure.js';
import {
  createJsonlDockerWorkloadAuditSink,
  createRecordingDockerWorkloadAuditSink,
  sealLifecycleEvidence,
  type SealLifecycleEvidenceOptions,
} from '../../src/docker-workload/lifecycle-evidence.js';
import {
  verifyQualificationEvidence,
  type QualificationEvidencePlan,
} from '../../src/docker-workload/qualification-evidence.js';
import {
  ADMISSION_BINDINGS,
  ADMISSION_CONFIG_HASH,
  EVIDENCE_BINDINGS,
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

const EVIDENCE_PLAN_FILES: QualificationEvidencePlan['files'] = [
  { id: 'lifecycle-lease', path: 'lease.json' },
  { id: 'lifecycle-rendered-policy', path: 'policy.json' },
  { id: 'lifecycle-supervisor-status-history', path: 'supervisor-status-history.json' },
  { id: 'lifecycle-revocation-result', path: 'revocation-result.json' },
  { id: 'lifecycle-cleanup-inventory-1', path: 'cleanup/inventory-1.json' },
  { id: 'lifecycle-cleanup-inventory-2', path: 'cleanup/inventory-2.json' },
];

function sealOptions(): SealLifecycleEvidenceOptions {
  return {
    runId: 'docker-workload-lifecycle-001',
    variant: 'apple-rootless-vfs',
    platform: 'apple-container',
    architecture: 'arm64',
    startedAt: '2026-07-20T12:00:00.000Z',
    completedAt: '2026-07-20T12:01:00.000Z',
    bindings: EVIDENCE_BINDINGS,
    contents: {
      lease: { leaseId: 'dw-evidence', status: 'closed' },
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
  const directory = mkdtempSync(join(tmpdir(), 'docker-workload-evidence-'));
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
    const manifest = sealLifecycleEvidence(directory, sealOptions());
    const plan: QualificationEvidencePlan = {
      runId: 'docker-workload-lifecycle-001',
      variant: 'apple-rootless-vfs',
      platform: 'apple-container',
      architecture: 'arm64',
      bindings: EVIDENCE_BINDINGS,
      files: EVIDENCE_PLAN_FILES,
    };
    expect(verifyQualificationEvidence(directory, plan).sha256).toBe(manifest.sha256);
  });

  it('seals lifecycle evidence into a verifiable manifest', () => {
    const directory = evidenceDir();
    const manifest = sealLifecycleEvidence(directory, sealOptions());
    const plan: QualificationEvidencePlan = {
      runId: 'docker-workload-lifecycle-001',
      variant: 'apple-rootless-vfs',
      platform: 'apple-container',
      architecture: 'arm64',
      bindings: EVIDENCE_BINDINGS,
      files: EVIDENCE_PLAN_FILES,
    };
    expect(verifyQualificationEvidence(directory, plan).sha256).toBe(manifest.sha256);
  });

  it('rejects a missing cleanup inventory file on verification', () => {
    const directory = evidenceDir();
    sealLifecycleEvidence(directory, sealOptions());
    rmSync(join(directory, 'cleanup', 'inventory-2.json'));
    const plan: QualificationEvidencePlan = {
      runId: 'docker-workload-lifecycle-001',
      variant: 'apple-rootless-vfs',
      platform: 'apple-container',
      architecture: 'arm64',
      bindings: EVIDENCE_BINDINGS,
      files: EVIDENCE_PLAN_FILES,
    };
    expect(() => verifyQualificationEvidence(directory, plan)).toThrow();
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
