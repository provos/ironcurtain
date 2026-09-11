#!/usr/bin/env tsx

/** No-LLM, production-workflow acceptance for an admitted nested-Docker runtime. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  assertCleanupInventoryGap,
  loadDockerWorkloadLease,
  type DockerWorkloadLease,
} from '../src/docker-workload/bundle-lease.js';
import { createContainerRuntime } from '../src/docker/container-runtime.js';
import { defaultExecFile } from '../src/docker/docker-manager.js';
import {
  dockerEndpointEnvironment,
  resolveDockerEndpoint,
  type DockerEndpoint,
} from '../src/docker/docker-endpoint.js';
import { DOCKER_BUILD_PROXY_CONFIG_DIRECTORY } from '../src/docker/docker-build-shim.js';
import {
  PACKAGE_EGRESS_AUDIT_FILENAME,
  PACKAGE_EGRESS_AUDIT_HOSTS,
  PACKAGE_EGRESS_AUDIT_REASON_CODES,
  PACKAGE_EGRESS_AUDIT_SCHEMA_VERSION,
  type PackageEgressAuditRecord,
} from '../src/docker/package-egress-proxy.js';
import { isSelectedAgentCaptureAlias } from '../src/docker/selected-agent-artifact.js';
import {
  getBundlePackageEgressSocketPath,
  getBundleRegistryEgressSocketPath,
  getBundleRuntimeRoot,
} from '../src/config/paths.js';
import type { BundleId } from '../src/session/types.js';
import { appendBoundedOutput } from './smoke-nested-apple-tui.js';
import { waitForSmokeChild } from './smoke-child-process.js';
import { WorkflowSmokeHostObserver } from './workflow-smoke-host-observer.js';
import { WORKFLOW_CHILD_TIMEOUT_MS, WORKFLOW_CLEANUP_TIMEOUT_MS } from './workflow-smoke-timeouts.js';

import {
  createSmokeRoot,
  parseSmokeTarget,
  withIronCurtainHome,
  workflowSmokePlacement,
  type SmokeTarget,
} from './smoke-environment.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const CLI_PATH = resolve(PACKAGE_ROOT, 'dist', 'cli.js');
const FAKE_API_KEY = 'sk-ant-api03-IRONCURTAIN-WORKFLOW-SMOKE-FAKE-ONLY';
const WORKFLOW_NAME = 'nested-docker-live-smoke';
const MAX_CAPTURED_OUTPUT_BYTES = 512 * 1024;
const MAX_PERSISTED_MOUNT_PATH_BYTES = 4096;
const PACKAGE_EGRESS_REASON_CODE_SET = new Set<string>(PACKAGE_EGRESS_AUDIT_REASON_CODES);
const PACKAGE_EGRESS_HOST_SET = new Set<string>(PACKAGE_EGRESS_AUDIT_HOSTS);
const WORKFLOW_FIXTURE_SOURCE = 'python:3.12-slim-bookworm';
const WORKFLOW_FIXTURE_ARCHIVE = '.workflow-fixtures/python.tar';

interface WorkflowSmokeFixture {
  readonly archivePath: string;
  readonly image: string;
}

/** Test task data travels through the existing workflow task interface, not production environment passthrough. */
export function buildWorkflowSmokeTask(mode: SmokeMode, target: SmokeTarget, fixture?: WorkflowSmokeFixture): string {
  if (target === 'apple') return mode;
  if (fixture === undefined) throw new Error('sidecar workflow smoke requires its test-only fixture archive');
  const uid = target === 'wsl-desktop' ? process.getuid?.() : 1000;
  const gid = target === 'wsl-desktop' ? process.getgid?.() : 1000;
  if (uid === undefined || gid === undefined || uid < 1)
    throw new Error('sidecar workflow smoke needs a non-root host identity');
  return JSON.stringify({
    schemaVersion: 1,
    mode,
    placement: 'sidecar',
    fixtureArchive: WORKFLOW_FIXTURE_ARCHIVE,
    fixtureImage: fixture.image,
    uid,
    gid,
  });
}

async function stageWorkflowSmokeFixture(
  root: string,
  runtime: ReturnType<typeof createContainerRuntime>,
): Promise<WorkflowSmokeFixture> {
  if (runtime.tagImage === undefined || runtime.saveImageArchive === undefined) {
    throw new Error('Docker workflow fixture requires image tagging and archive export');
  }
  if (!(await runtime.imageExists(WORKFLOW_FIXTURE_SOURCE))) await runtime.pullImage(WORKFLOW_FIXTURE_SOURCE);
  const source = await runtime.inspectImage(WORKFLOW_FIXTURE_SOURCE);
  if (source === undefined) throw new Error('workflow fixture image is unavailable');
  const image = `localhost/ironcurtain-workflow-fixture:${randomUUID()}`;
  const archivePath = resolve(root, 'workflow-fixture.tar');
  await runtime.tagImage(source.id, image);
  try {
    await runtime.saveImageArchive(image, archivePath);
    return { image, archivePath };
  } finally {
    await runtime.removeImage(image);
  }
}

type NetworkSmokeMode = 'packages' | 'images' | 'offline';
export type SmokeMode = NetworkSmokeMode | 'admission';

interface CacheAuditSentinels {
  readonly beforePath: string;
  readonly afterPath: string;
}

export interface WorkflowProbeResult {
  readonly schemaVersion: number;
  readonly verdict: string;
  readonly passed: boolean;
  readonly payload: {
    readonly mode: string;
    readonly checkCount: number;
    readonly checkIds: readonly string[];
    readonly cacheAuditSentinels: CacheAuditSentinels | null;
  };
  readonly error?: string;
}

const COMMON_CHECK_IDS = [
  'common.endpoint',
  'common.daemon-profile',
  'common.managed-network',
  'common.fresh-inventory',
] as const;
const FINAL_CHECK_IDS = [
  'cleanup.tracked-ids',
  'cleanup.initial-image-inventory',
  'cleanup.empty-container-network',
] as const;
const MODE_CHECK_IDS: Readonly<Record<SmokeMode, readonly string[]>> = {
  packages: [
    'packages.outer-tcp-absent',
    'packages.host-relay-matrix',
    'packages.relay-probe-inventory',
    'packages.artifacts',
    'packages.registry-pulls',
    'packages.registry-denial',
    'packages.authoritative-build',
    'packages.exact-results',
    'packages.sibling-network',
    'packages.compose-denial',
    'packages.selector-denials',
    'packages.direct-route-denial',
    'packages.outer-package-request',
    'packages.policy-denials',
    'packages.host-child-scope',
    'packages.supported-build-forms',
    'packages.cached-repeat',
    'packages.image-residue',
    'packages.snapshot-preflight',
    'packages.snapshot-residue',
  ],
  images: [
    'images.outer-tcp-absent',
    'images.host-relay-matrix',
    'images.relay-probe-inventory',
    'images.artifacts',
    'images.registry-pull',
    'images.registry-denial',
    'images.package-build-denied',
  ],
  offline: [
    'offline.outer-tcp-absent',
    'offline.host-relay-matrix',
    'offline.relay-probe-inventory',
    'offline.artifacts',
    'offline.registry-pull-denied',
    'offline.package-build-denied',
    'offline.hermetic-build',
  ],
  admission: [
    'admission.outer-tcp-absent',
    'admission.host-relay-matrix',
    'admission.relay-probe-inventory',
    'admission.artifacts',
    'admission.fresh-state',
  ],
};

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function withSecondaryErrors(primary: Error, secondary: readonly Error[]): Error {
  return secondary.length === 0
    ? primary
    : new AggregateError([primary, ...secondary], primary.message, { cause: primary });
}

export function assertExactWorkflowCheckInventory(mode: SmokeMode, payload: WorkflowProbeResult['payload']): void {
  const expectedIds = [...COMMON_CHECK_IDS, ...MODE_CHECK_IDS[mode], ...FINAL_CHECK_IDS];
  const observedIds = payload.checkIds;
  if (
    payload.checkCount !== observedIds.length ||
    new Set(observedIds).size !== observedIds.length ||
    observedIds.length !== expectedIds.length ||
    expectedIds.some((id) => !observedIds.includes(id))
  ) {
    throw new Error(`[${mode}] workflow probe returned an invalid check inventory: ${JSON.stringify(payload)}`);
  }
}

export interface PersistedOuterMount {
  readonly source: string;
  readonly target: string;
  readonly readonly: boolean;
}

async function main(): Promise<void> {
  if (!existsSync(CLI_PATH)) throw new Error(`built CLI is missing: ${CLI_PATH}; run npm run build`);
  const invocation = parseSmokeTarget(process.argv.slice(2));
  const target = invocation.target ?? 'apple';
  const modes = parseModes(invocation.arguments);
  const smokeRoot = createSmokeRoot('ic-naw-');
  const smokeHome = resolve(smokeRoot, 'home');
  let succeeded = false;

  try {
    chmodSync(smokeRoot, 0o700);
    mkdirSync(smokeHome, { mode: 0o700 });
    const endpoint = target === 'apple' ? undefined : await resolveDockerEndpoint(defaultExecFile);
    const runtime = createContainerRuntime(workflowSmokePlacement(target).runtimeKind, endpoint);
    const fixture = target === 'apple' ? undefined : await stageWorkflowSmokeFixture(smokeRoot, runtime);
    const captureTagsBefore = await listCaptureTags(runtime);

    for (const mode of modes) {
      await runMode({ mode, smokeRoot, smokeHome, runtime, target, fixture, endpoint });
    }
    await runMode({ mode: 'admission', smokeRoot, smokeHome, runtime, target, fixture, endpoint });

    const captureTagsAfter = await listCaptureTags(runtime);
    const addedCaptureTags = [...captureTagsAfter].filter((tag) => !captureTagsBefore.has(tag));
    if (addedCaptureTags.length > 0) {
      throw new Error(`workflow smoke left selected-image capture aliases: ${addedCaptureTags.join(', ')}`);
    }
    assertNoProviderRequest(smokeHome);
    succeeded = true;
    process.stderr.write(`nested ${target} workflow smoke passed (${modes.join(' + ')} + next admission, no LLM)\n`);
  } finally {
    if (succeeded) rmSync(smokeRoot, { recursive: true, force: true });
    else process.stderr.write(`nested ${target} workflow smoke retained diagnostics at ${smokeRoot}\n`);
  }
}

async function runMode(options: {
  readonly mode: SmokeMode;
  readonly target: SmokeTarget;
  readonly fixture?: WorkflowSmokeFixture;
  readonly endpoint?: DockerEndpoint;
  readonly smokeRoot: string;
  readonly smokeHome: string;
  readonly runtime: ReturnType<typeof createContainerRuntime>;
}): Promise<void> {
  const { mode, smokeRoot, smokeHome, runtime, target, fixture, endpoint } = options;
  const workspace = resolve(smokeRoot, `workspace-${mode}`);
  mkdirSync(workspace, { mode: 0o700 });
  if (fixture !== undefined) {
    mkdirSync(resolve(workspace, '.workflow-fixtures'), { mode: 0o700 });
    linkSync(fixture.archivePath, resolve(workspace, WORKFLOW_FIXTURE_ARCHIVE));
  }
  writeConfig(smokeHome, mode, target);
  const leasesBefore = new Set(listLeasePaths(smokeHome));
  const packageAuditsBefore = new Set(listFilesNamed(smokeHome, PACKAGE_EGRESS_AUDIT_FILENAME));
  const argv = [
    CLI_PATH,
    'workflow',
    'start',
    WORKFLOW_NAME,
    buildWorkflowSmokeTask(mode, target, fixture),
    '--workspace',
    workspace,
    '--strict-lint',
  ];
  process.stderr.write(`\n[${mode}] ${JSON.stringify([process.execPath, ...argv])}\n`);

  const child = spawn(process.execPath, argv, {
    cwd: smokeRoot,
    env:
      endpoint === undefined
        ? childEnvironment(smokeHome, target)
        : dockerEndpointEnvironment(endpoint, childEnvironment(smokeHome, target)),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = appendBoundedOutput(stdout, chunk.toString('utf8'), MAX_CAPTURED_OUTPUT_BYTES);
    process.stderr.write(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = appendBoundedOutput(stderr, chunk.toString('utf8'), MAX_CAPTURED_OUTPUT_BYTES);
    process.stderr.write(chunk);
  });
  child.stdin.end();

  const hostObserver =
    target !== 'apple' && mode === 'packages'
      ? new WorkflowSmokeHostObserver({
          runtime,
          workspace,
          probeSource: resolve(
            PACKAGE_ROOT,
            'src/workflow/workflows/nested-docker-live-smoke/scripts/nested_docker_probe.py',
          ),
          daemonExecUser: target === 'wsl-desktop' ? `${process.getuid!()}:${process.getgid!()}` : '1000:1000',
          getLeasePath: () => {
            const paths = listLeasePaths(smokeHome).filter((path) => !leasesBefore.has(path));
            if (paths.length !== 1) throw new Error('host observation requires exactly one new lease');
            return paths[0]!;
          },
          getStagingRoot: (lease) =>
            withIronCurtainHome(smokeHome, () =>
              resolve(getBundleRuntimeRoot(lease.bundleId as BundleId), 'package-build-runtime'),
            ),
          onFailure: () => {
            child.kill('SIGTERM');
          },
        })
      : undefined;
  let hostObservationFailure: Error | undefined;
  const exit = await waitForSmokeChild(child, WORKFLOW_CHILD_TIMEOUT_MS).finally(async () => {
    try {
      await hostObserver?.stop();
    } catch (error) {
      hostObservationFailure = toError(error);
    }
  });
  if (hostObserver !== undefined && hostObservationFailure === undefined) {
    try {
      hostObserver.assertComplete();
    } catch (error) {
      hostObservationFailure = toError(error);
    }
  }
  const resultPath = resolve(workspace, '.workflow', 'nested-docker-result.json');
  let result: WorkflowProbeResult | undefined;
  let resultReadFailure: Error | undefined;
  try {
    result = existsSync(resultPath) ? readProbeResult(resultPath) : undefined;
  } catch (error) {
    resultReadFailure = toError(error);
  }
  let workflowFailure = resultReadFailure;
  if (workflowFailure === undefined && (exit.timedOut || exit.code !== 0 || exit.signal !== null)) {
    workflowFailure = new Error(
      `[${mode}] workflow CLI exited code=${String(exit.code)} signal=${String(exit.signal)} ` +
        `timedOut=${String(exit.timedOut)}\n` +
        `probe=${result === undefined ? 'missing' : JSON.stringify(result)}\n` +
        `stdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  } else if (workflowFailure === undefined && result === undefined) {
    workflowFailure = new Error(`[${mode}] workflow result is missing: ${resultPath}`);
  } else if (
    workflowFailure === undefined &&
    result !== undefined &&
    (result.schemaVersion !== 1 || result.verdict !== 'pass' || !result.passed || result.payload.mode !== mode)
  ) {
    workflowFailure = new Error(`[${mode}] workflow probe did not pass: ${JSON.stringify(result)}`);
  }
  if (workflowFailure === undefined && result !== undefined) {
    try {
      assertExactWorkflowCheckInventory(mode, result.payload);
    } catch (error) {
      workflowFailure = toError(error);
    }
  }

  const evidenceFailures: Error[] = hostObservationFailure === undefined ? [] : [hostObservationFailure];
  let newLeasePaths: readonly string[] | undefined;
  try {
    newLeasePaths = listLeasePaths(smokeHome).filter((path) => !leasesBefore.has(path));
  } catch (error) {
    evidenceFailures.push(new Error(`[${mode}] failed to enumerate post-run Docker-workload leases`, { cause: error }));
  }
  if (newLeasePaths !== undefined && newLeasePaths.length !== 1) {
    evidenceFailures.push(
      new Error(
        `[${mode}] expected one new Docker-workload lease, found ${newLeasePaths.length}\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`,
      ),
    );
  } else if (newLeasePaths !== undefined) {
    let closedLease: DockerWorkloadLease | undefined;
    try {
      closedLease = await waitForClosedLease(newLeasePaths[0]!, WORKFLOW_CLEANUP_TIMEOUT_MS);
    } catch (error) {
      evidenceFailures.push(toError(error));
    }
    if (closedLease !== undefined) {
      try {
        validatePersistedPackageBuildMountEvidence(mode, smokeHome, closedLease, target);
      } catch (error) {
        evidenceFailures.push(toError(error));
      }
      try {
        await assertClosedLease(closedLease, runtime, smokeHome);
      } catch (error) {
        evidenceFailures.push(toError(error));
      }
    }
  }
  if (workflowFailure !== undefined) {
    throw withSecondaryErrors(workflowFailure, evidenceFailures);
  }
  if (evidenceFailures.length > 0) {
    throw withSecondaryErrors(evidenceFailures[0]!, evidenceFailures.slice(1));
  }

  if (result === undefined) throw new Error(`[${mode}] workflow result vanished after validation`);
  const newPackageAudits = listFilesNamed(smokeHome, PACKAGE_EGRESS_AUDIT_FILENAME).filter(
    (path) => !packageAuditsBefore.has(path),
  );
  validatePackageEgressAudit(mode, newPackageAudits, result.payload.cacheAuditSentinels);
  process.stderr.write(
    `[${mode}] workflow passed ${result.payload.checkCount} deterministic checks and exact teardown proof\n`,
  );
}

function parseModes(args: readonly string[]): readonly NetworkSmokeMode[] {
  if (args.length === 0) return ['packages', 'images', 'offline'];
  if (args.length === 1 && args[0] === '--packages') return ['packages'];
  if (args.length === 1 && args[0] === '--images') return ['images'];
  if (args.length === 1 && args[0] === '--offline') return ['offline'];
  throw new Error('usage: smoke-nested-apple-workflow.ts [--packages|--images|--offline]');
}

function writeConfig(home: string, mode: SmokeMode, target: SmokeTarget): void {
  const networkAccess = mode === 'admission' ? 'offline' : mode;
  const dockerWorkload = { enabled: true, networkAccess };
  const config = {
    anthropicApiKey: FAKE_API_KEY,
    preferredMode: 'container',
    preferredDockerAgent: 'claude-code',
    containerRuntime: workflowSmokePlacement(target).runtimeKind,
    dockerResources: { memoryMb: 4096, cpus: 2 },
    dockerWorkload,
    packageInstall: {
      enabled: true,
      quarantineDays: 0,
      allowedPackages: [],
      deniedPackages: ['is-odd'],
    },
  };
  const path = resolve(home, 'config.json');
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function childEnvironment(home: string, target: SmokeTarget): NodeJS.ProcessEnv {
  return {
    ...process.env,
    IRONCURTAIN_HOME: home,
    IRONCURTAIN_CONTAINER_RUNTIME: workflowSmokePlacement(target).runtimeKind,
    IRONCURTAIN_DOCKER_AUTH: 'apikey',
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    NO_COLOR: '1',
  };
}

function listLeasePaths(home: string): readonly string[] {
  const root = resolve(home, 'docker-workload', 'leases');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((leaseId) => resolve(root, leaseId, 'lease.json'))
    .filter((path) => existsSync(path) && statSync(path).isFile())
    .sort();
}

async function waitForClosedLease(path: string, timeoutMs: number): Promise<DockerWorkloadLease> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lease = loadDockerWorkloadLease(path);
    if (lease.status === 'closed') return lease;
    if (lease.status === 'incident') {
      throw new Error(`Docker-workload cleanup entered incident: ${lease.incident?.detail}`);
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for closed Docker-workload lease: ${path}`);
}

async function assertClosedLease(
  lease: DockerWorkloadLease,
  runtime: ReturnType<typeof createContainerRuntime>,
  home: string,
): Promise<void> {
  if (lease.cleanup === null) throw new Error('closed lease lacks cleanup proof');
  if (!lease.cleanup.exactOuterResourcesAbsent || !lease.cleanup.stateRootAbsent) {
    throw new Error('closed lease lacks exact outer-resource/state-root absence proof');
  }
  if (lease.cleanup.inventories.length !== 2) throw new Error('closed lease lacks two cleanup inventories');
  if (lease.cleanup.inventories.some((inventory) => inventory.ownedResourceIds.length !== 0)) {
    throw new Error('closed lease retained generation-owned outer resources');
  }
  assertCleanupInventoryGap(lease.cleanup.inventories, lease.cleanupInventoryGapMs, 'workflow smoke');
  if (existsSync(lease.paths.stateRoot) || existsSync(lease.paths.runtimeRoot)) {
    throw new Error('closed lease retained a host-only state or runtime root');
  }

  for (const resource of lease.resources) {
    if (resource.observedId === null || resource.removal?.proof !== 'immutable-id-absent') {
      throw new Error(`closed lease lacks immutable-ID absence proof for ${resource.requestedName}`);
    }
    if (resource.removal.identity !== resource.observedId) {
      throw new Error(`closed lease removal identity changed for ${resource.requestedName}`);
    }
    if (resource.kind === 'container' && (await runtime.containerExists(resource.observedId))) {
      throw new Error(`exact outer container still exists: ${resource.observedId}`);
    }
  }

  if (runtime.listContainers === undefined)
    throw new Error('container runtime cannot inventory generation-owned containers');
  const representative = lease.resources[0];
  if (representative === undefined) throw new Error('closed lease recorded no outer resources');
  const owned = await runtime.listContainers({
    labelFilter: `${representative.ownershipLabelKey}=${representative.ownershipLabelValue}`,
  });
  if (owned.length !== 0) throw new Error('generation-owned outer-container inventory is not empty');

  const bundleId = lease.bundleId as BundleId;
  const bundlePaths = withIronCurtainHome(home, () => [
    getBundleRegistryEgressSocketPath(bundleId),
    getBundlePackageEgressSocketPath(bundleId),
    getBundleRuntimeRoot(bundleId),
  ]);
  if (bundlePaths.some((path) => existsSync(path))) {
    throw new Error(`closed lease retained a host bundle runtime path: ${bundlePaths.join(', ')}`);
  }
}

function validatePersistedPackageBuildMountEvidence(
  mode: SmokeMode,
  home: string,
  lease: DockerWorkloadLease,
  target: SmokeTarget,
): void {
  const matches: PersistedOuterMount[][] = [];
  for (const auditPath of listFilesNamed(home, 'audit.jsonl')) {
    const stats = lstatSync(auditPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 8 * 1024 * 1024) {
      throw new Error(`lifecycle audit is not one bounded regular file: ${auditPath}`);
    }
    for (const line of readFileSync(auditPath, 'utf8').split('\n').filter(Boolean)) {
      if (Buffer.byteLength(line) > 256 * 1024) throw new Error('lifecycle audit line exceeds its bound');
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      if (
        record.kind !== 'outer-create' ||
        record.leaseId !== lease.leaseId ||
        record.generation !== lease.generation ||
        record.resourceKind !== 'container' ||
        record.role !== 'agent'
      ) {
        continue;
      }
      const expanded = record.expanded;
      if (expanded === null || typeof expanded !== 'object' || Array.isArray(expanded)) {
        throw new Error('agent outer-create evidence lacks an expanded mount record');
      }
      const mounts = (expanded as Record<string, unknown>).mounts;
      if (!Array.isArray(mounts) || !mounts.every(isPersistedOuterMount)) {
        throw new Error('agent outer-create evidence has invalid mounts');
      }
      matches.push(mounts);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`expected one persisted agent outer-create mount record, found ${matches.length}`);
  }
  const bundleRuntimeRoot = withIronCurtainHome(home, () => getBundleRuntimeRoot(lease.bundleId as BundleId));
  let bindMounts = matches[0]!;
  if (target !== 'apple') {
    const volumes = lease.resources.filter((resource) => resource.kind === 'volume' && resource.role === 'daemon-api');
    if (volumes.length !== 1 || volumes[0]!.observedId === null)
      throw new Error('workflow lacks one observed daemon API volume');
    bindMounts = validateWorkflowAgentApiMount(bindMounts, volumes[0]!.observedId);
  }
  validatePackageBuildMounts(mode, home, bundleRuntimeRoot, bindMounts, target);
}

/** Named volumes have a distinct authority check before ordinary host bind-path validation. */
export function validateWorkflowAgentApiMount(
  mounts: readonly PersistedOuterMount[],
  volumeId: string,
): PersistedOuterMount[] {
  const candidates = mounts.filter((mount) => mount.source === volumeId || mount.target === '/run/ironcurtain-docker');
  if (
    candidates.length !== 1 ||
    candidates[0]!.source !== volumeId ||
    candidates[0]!.target !== '/run/ironcurtain-docker' ||
    !candidates[0]!.readonly
  ) {
    throw new Error('workflow agent API mount is not exactly the leased read-only volume');
  }
  return mounts.filter((mount) => mount !== candidates[0]);
}

function isPersistedOuterMount(value: unknown): value is PersistedOuterMount {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const mount = value as Record<string, unknown>;
  return (
    Object.keys(mount).sort().join('\0') === 'readonly\0source\0target' &&
    typeof mount.source === 'string' &&
    typeof mount.target === 'string' &&
    typeof mount.readonly === 'boolean'
  );
}

export function validatePackageBuildMounts(
  mode: SmokeMode,
  home: string,
  bundleRuntimeRoot: string,
  mounts: readonly PersistedOuterMount[],
  target: SmokeTarget = 'apple',
): void {
  const packageRuntimeRoot = resolve(bundleRuntimeRoot, 'package-build-runtime');
  const caRoot = resolve(home, 'ca');
  const normalizeMountPath = (path: string): string => {
    if (
      !isAbsolute(path) ||
      path.includes('\0') ||
      Buffer.byteLength(path, 'utf8') > MAX_PERSISTED_MOUNT_PATH_BYTES ||
      path.endsWith('//')
    ) {
      throw new Error('outer-create mount evidence contains an invalid absolute path');
    }
    const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    if (
      normalized.includes('//') ||
      normalized
        .split('/')
        .slice(1)
        .some((component) => component === '.' || component === '..')
    ) {
      throw new Error('outer-create mount evidence contains a noncanonical path alias');
    }
    return normalized;
  };
  const isWithin = (candidate: string, root: string): boolean => {
    const relation = relative(root, candidate);
    return relation === '' || (relation !== '..' && !relation.startsWith('../') && !isAbsolute(relation));
  };
  const overlaps = (left: string, right: string): boolean => isWithin(left, right) || isWithin(right, left);
  const hasPrivateArtifactName = (path: string, source: boolean): boolean => {
    const components = path.split('/').filter(Boolean);
    const relevant =
      source && components[0] === 'private' && components[1] === 'tmp' ? components.slice(2) : components;
    return relevant.some((component) => /(?:^|[-_.])(private|key)(?:$|[-_.])/iu.test(component));
  };
  const normalizedMounts = mounts.map((mount) => ({
    raw: mount,
    source: normalizeMountPath(mount.source),
    target: normalizeMountPath(mount.target),
  }));
  for (const mount of normalizedMounts) {
    if (overlaps(mount.source, caRoot)) {
      throw new Error('outer-create mount evidence exposes the host CA directory');
    }
    if (isWithin(packageRuntimeRoot, mount.source) && mount.source !== packageRuntimeRoot) {
      throw new Error('outer-create mount evidence exposes an ancestor of the package runtime root');
    }
    if (hasPrivateArtifactName(mount.source, true) || hasPrivateArtifactName(mount.target, false)) {
      throw new Error('outer-create mount evidence names a private/key artifact');
    }
  }

  const protectedTargets = [
    '/usr/local/sbin/docker',
    '/ironcurtain-real-runc',
    '/ironcurtain-build-trust',
    DOCKER_BUILD_PROXY_CONFIG_DIRECTORY,
  ] as const;
  const reservedTarget = (target: string): boolean =>
    protectedTargets.some((protectedTarget) => overlaps(target, protectedTarget));
  const observed = normalizedMounts.filter((mount) => reservedTarget(mount.target)).map((mount) => mount.raw);
  if (mode !== 'packages') {
    if (observed.length !== 0 || normalizedMounts.some((mount) => overlaps(mount.source, packageRuntimeRoot))) {
      throw new Error(`[${mode}] package-build mounts must be absent`);
    }
    return;
  }

  const expected: readonly PersistedOuterMount[] = [
    { source: resolve(packageRuntimeRoot, 'docker'), target: '/usr/local/sbin/docker', readonly: true },
    {
      source: resolve(packageRuntimeRoot, 'package-build-client'),
      target: DOCKER_BUILD_PROXY_CONFIG_DIRECTORY,
      readonly: true,
    },
    { source: packageRuntimeRoot, target: '/ironcurtain-build-trust', readonly: true },
    { source: resolve(packageRuntimeRoot, 'real-runc'), target: '/ironcurtain-real-runc', readonly: true },
  ];
  const expectedAgentMounts = target === 'apple' ? expected : expected.slice(0, 2);
  const canonical = (values: readonly PersistedOuterMount[]): string =>
    JSON.stringify([...values].sort((left, right) => left.target.localeCompare(right.target)));
  if (canonical(observed) !== canonical(expectedAgentMounts)) {
    throw new Error('[packages] persisted package-build mount allowlist is not exact');
  }
  const packageSources = normalizedMounts
    .filter((mount) => isWithin(mount.source, packageRuntimeRoot))
    .map((mount) => mount.raw);
  if (canonical(packageSources) !== canonical(expectedAgentMounts)) {
    throw new Error('[packages] package-build runtime root contains an extra exposed source');
  }
  const orientation = normalizedMounts.filter((mount) => mount.target === '/etc/ironcurtain');
  if (orientation.length !== 1 || !orientation[0].raw.readonly || isWithin(orientation[0].source, packageRuntimeRoot)) {
    throw new Error('[packages] orientation mount is not separate and read-only');
  }
}

function readProbeResult(path: string): WorkflowProbeResult {
  if (!existsSync(path)) throw new Error(`workflow result is missing: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('workflow result is not a JSON object');
  }
  return parsed as WorkflowProbeResult;
}

export function validatePackageEgressAudit(
  mode: SmokeMode,
  paths: readonly string[],
  cacheAuditSentinels: WorkflowProbeResult['payload']['cacheAuditSentinels'],
): void {
  if (mode !== 'packages') {
    if (paths.length !== 0 || cacheAuditSentinels !== null) {
      throw new Error(
        `[${mode}] package audit/cache evidence must be absent: ${JSON.stringify({ paths, cacheAuditSentinels })}`,
      );
    }
    return;
  }
  if (paths.length !== 1 || cacheAuditSentinels === null) {
    throw new Error(
      `[packages] expected one package-egress audit and ordered cache sentinels: ${JSON.stringify({ paths })}`,
    );
  }

  const records = readPackageEgressAudit(paths[0]!);
  if (records.length === 0) throw new Error('[packages] package-egress audit is empty');
  const allowedEcosystems = new Set(
    records
      .filter((record) => record.decision === 'allow' && record.source === 'client')
      .map((record) => record.ecosystem),
  );
  for (const ecosystem of ['npm', 'pypi', 'debian', 'cargo'] as const) {
    if (!allowedEcosystems.has(ecosystem)) {
      throw new Error(`[packages] package-egress audit lacks an allowed ${ecosystem} client request`);
    }
  }
  const requiredArtifacts = [
    { ecosystem: 'npm', name: 'is-number', version: '7.0.0' },
    { ecosystem: 'pypi', name: 'idna', version: '3.15' },
    { ecosystem: 'debian', name: 'curl', version: '7.88.1-10+deb12u15' },
    { ecosystem: 'cargo', name: 'itoa', version: '1.0.15' },
  ] as const;
  for (const expected of requiredArtifacts) {
    const observed = records.some(
      (record) =>
        record.decision === 'allow' &&
        record.source === 'client' &&
        record.routeKind === 'artifact' &&
        record.ecosystem === expected.ecosystem &&
        record.package?.name === expected.name &&
        record.package.version !== undefined &&
        (!('version' in expected) || record.package.version === expected.version),
    );
    if (!observed) throw new Error(`[packages] package-egress audit lacks exact artifact: ${JSON.stringify(expected)}`);
  }
  const securityInRelease = records.some(
    (record) =>
      record.decision === 'allow' &&
      record.reasonCode === 'client-metadata-unfiltered' &&
      record.source === 'client' &&
      record.method === 'GET' &&
      record.routeKind === 'metadata' &&
      record.ecosystem === 'debian' &&
      record.host === 'deb.debian.org' &&
      record.path === '/debian-security/dists/bookworm-security/InRelease' &&
      record.package === undefined,
  );
  if (!securityInRelease) {
    throw new Error('[packages] package-egress audit lacks exact Debian security InRelease');
  }
  const requiredDerivedMetadata = [
    {
      ecosystem: 'npm',
      host: 'registry.npmjs.org',
      path: '/is-number',
      name: 'is-number',
      version: '7.0.0',
    },
    {
      ecosystem: 'pypi',
      host: 'pypi.org',
      path: '/pypi/idna/json',
      name: 'idna',
      version: '3.15',
    },
    {
      ecosystem: 'cargo',
      host: 'index.crates.io',
      path: '/it/oa/itoa',
      name: 'itoa',
      version: '1.0.15',
    },
  ] as const;
  for (const expected of requiredDerivedMetadata) {
    const observed = records.some(
      (record) =>
        record.decision === 'allow' &&
        record.reasonCode === 'derived-metadata-fetched' &&
        record.source === 'derived' &&
        record.method === 'GET' &&
        record.routeKind === 'metadata' &&
        record.ecosystem === expected.ecosystem &&
        record.host === expected.host &&
        record.path === expected.path &&
        record.package?.name === expected.name &&
        record.package.version === expected.version,
    );
    if (!observed) {
      throw new Error(`[packages] package-egress audit lacks exact derived metadata: ${JSON.stringify(expected)}`);
    }
  }
  const denied = records.some(
    (record) =>
      record.decision === 'deny' &&
      record.reasonCode === 'policy-deny' &&
      record.ecosystem === 'npm' &&
      record.package?.name === 'is-odd' &&
      record.package.version === '3.0.1',
  );
  if (!denied) {
    throw new Error('[packages] package-egress audit lacks the exact fixed-package policy denial');
  }
  for (const record of records) {
    const timestamp = Date.parse(record.timestamp);
    if (!Number.isFinite(timestamp)) throw new Error('[packages] package-egress audit has an invalid timestamp');
  }
  assertSilentCacheBetweenAuditSentinels(records, cacheAuditSentinels);
}

function assertSilentCacheBetweenAuditSentinels(
  records: readonly PackageEgressAuditRecord[],
  sentinels: CacheAuditSentinels,
): void {
  const beforePattern = /^\/ironcurtain-cache-before-[a-f0-9]{32}$/u;
  const afterPattern = /^\/ironcurtain-cache-after-[a-f0-9]{32}$/u;
  if (
    !beforePattern.test(sentinels.beforePath) ||
    !afterPattern.test(sentinels.afterPath) ||
    sentinels.beforePath.slice('/ironcurtain-cache-before-'.length) !==
      sentinels.afterPath.slice('/ironcurtain-cache-after-'.length)
  ) {
    throw new Error(`[packages] invalid cache audit sentinels: ${JSON.stringify(sentinels)}`);
  }
  const indices = (path: string): number[] =>
    records.flatMap((record, index) => (isCacheAuditSentinel(record, path) ? [index] : []));
  const before = indices(sentinels.beforePath);
  const after = indices(sentinels.afterPath);
  if (before.length !== 1 || after.length !== 1 || after[0] !== before[0]! + 1) {
    throw new Error(
      `[packages] cached repeat emitted package-egress audit between ordered sentinels: ${JSON.stringify({
        sentinels,
        before,
        after,
      })}`,
    );
  }
}

function isCacheAuditSentinel(record: PackageEgressAuditRecord, path: string): boolean {
  return (
    record.decision === 'allow' &&
    record.reasonCode === 'client-metadata-unfiltered' &&
    record.source === 'client' &&
    record.method === 'HEAD' &&
    record.ecosystem === 'npm' &&
    record.host === 'registry.npmjs.org' &&
    record.path === path &&
    record.routeKind === 'metadata' &&
    record.package?.name === path.slice(1) &&
    record.package.version === undefined
  );
}

function readPackageEgressAudit(path: string): readonly PackageEgressAuditRecord[] {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`package-egress audit is not a regular file: ${path}`);
  const text = readFileSync(path, 'utf8');
  if (text.includes(FAKE_API_KEY) || /Bearer forbidden|Proxy-Authorization/u.test(text)) {
    throw new Error(`package-egress audit contains credential material: ${path}`);
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      if (Buffer.byteLength(line) > 12 * 1024) {
        throw new Error(`package-egress audit line exceeds its 12 KiB acceptance bound: ${path}`);
      }
      const parsed = JSON.parse(line) as unknown;
      if (
        !isPackageEgressAuditRecord(parsed) ||
        parsed.schemaVersion !== PACKAGE_EGRESS_AUDIT_SCHEMA_VERSION ||
        (parsed.decision !== 'allow' && parsed.decision !== 'deny') ||
        (parsed.source !== 'client' && parsed.source !== 'derived')
      ) {
        throw new Error(`package-egress audit record has an invalid versioned envelope: ${line}`);
      }
      if (parsed.decision === 'allow' && parsed.method !== 'GET' && parsed.method !== 'HEAD') {
        throw new Error(`package-egress audit records a non-read allow: ${line}`);
      }
      return parsed;
    });
}

function isPackageEgressAuditRecord(value: unknown): value is PackageEgressAuditRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const exactKeys = [
    'schemaVersion',
    'timestamp',
    'decision',
    'reasonCode',
    'reason',
    'method',
    'ecosystem',
    'host',
    'path',
    'routeKind',
    ...(record.package === undefined ? [] : ['package']),
    'source',
  ];
  if (Object.keys(record).sort().join('\0') !== exactKeys.sort().join('\0')) return false;
  if (
    record.schemaVersion !== PACKAGE_EGRESS_AUDIT_SCHEMA_VERSION ||
    typeof record.timestamp !== 'string' ||
    (record.decision !== 'allow' && record.decision !== 'deny') ||
    typeof record.reasonCode !== 'string' ||
    !PACKAGE_EGRESS_REASON_CODE_SET.has(record.reasonCode) ||
    typeof record.reason !== 'string' ||
    record.reason.length > 256 ||
    (record.method !== 'GET' && record.method !== 'HEAD') ||
    (record.ecosystem !== 'npm' &&
      record.ecosystem !== 'pypi' &&
      record.ecosystem !== 'debian' &&
      record.ecosystem !== 'cargo') ||
    typeof record.host !== 'string' ||
    !PACKAGE_EGRESS_HOST_SET.has(record.host) ||
    typeof record.path !== 'string' ||
    !record.path.startsWith('/') ||
    record.path.includes('?') ||
    (record.routeKind !== 'metadata' && record.routeKind !== 'artifact' && record.routeKind !== 'bootstrap') ||
    (record.source !== 'client' && record.source !== 'derived')
  ) {
    return false;
  }
  if (record.package === undefined) return true;
  if (record.package === null || typeof record.package !== 'object' || Array.isArray(record.package)) return false;
  const packageRecord = record.package as Record<string, unknown>;
  return (
    typeof packageRecord.name === 'string' &&
    (packageRecord.scope === undefined || typeof packageRecord.scope === 'string') &&
    (packageRecord.version === undefined || typeof packageRecord.version === 'string') &&
    Object.keys(packageRecord).every((key) => key === 'name' || key === 'scope' || key === 'version')
  );
}

function listFilesNamed(root: string, filename: string): readonly string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === filename) results.push(path);
    }
  }
  return results.sort();
}

async function listCaptureTags(runtime: ReturnType<typeof createContainerRuntime>): Promise<ReadonlySet<string>> {
  const images = await runtime.listImages();
  return new Set(images.flatMap((image) => image.repoTags).filter(isSelectedAgentCaptureAlias));
}

function assertNoProviderRequest(home: string): void {
  const sessionsRoot = resolve(home, 'sessions');
  if (!existsSync(sessionsRoot)) return;
  for (const sessionId of readdirSync(sessionsRoot)) {
    const auditPath = resolve(sessionsRoot, sessionId, 'audit.jsonl');
    if (!existsSync(auditPath)) continue;
    const audit = readFileSync(auditPath, 'utf8');
    if (/api\.anthropic\.com|\/v1\/messages/u.test(audit) || audit.includes(FAKE_API_KEY)) {
      throw new Error(`no-LLM workflow observed provider request or key material in ${auditPath}`);
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && realpathSync(resolve(invokedPath)) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
