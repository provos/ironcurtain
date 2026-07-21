#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA_VERSION,
  appendLedger,
  assertOutsideWorkspace,
  assertRunId,
  captureEnvironment,
  ensurePrivateDirectory,
  parseArgs,
  writeJsonAtomic,
  writeManifest,
} from './evidence-lib.mjs';

class ProbeFailure extends Error {}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkspace = path.resolve(scriptDir, '../../..');
const parsed = parseOptionalArgs(process.argv.slice(2));
const workspaceRoot = path.resolve(parsed['workspace-root'] ?? defaultWorkspace);
const runId = parsed['run-id'] ?? `ac-h1-${utcStamp()}-${randomBytes(4).toString('hex')}`;
const evidenceDir = path.resolve(parsed['evidence-dir'] ?? path.join(os.tmpdir(), 'ic-secure-nested-phase0b', runId));
const image = parsed.image ?? 'alpine:latest';
const expectedImageDigest =
  parsed['image-digest'] ?? 'sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b';
const requestedName = `ic-nested-spike-${runId}`;
const generation = 1;
const ownershipLabel = 'com.ironcurtain.nested-spike.run-id';
const generationLabel = 'com.ironcurtain.nested-spike.generation';

assertRunId(runId);
assertOutsideWorkspace(evidenceDir, workspaceRoot);
ensurePrivateDirectory(evidenceDir, true);
ensurePrivateDirectory(path.join(evidenceDir, 'commands'));
ensurePrivateDirectory(path.join(evidenceDir, 'cleanup'));

writeJsonAtomic(path.join(evidenceDir, 'run.json'), {
  expectedImageDigest,
  generation,
  image,
  phase: '0B-AC-H1-GUEST-INVENTORY',
  requestedName,
  runId,
  schemaVersion: SCHEMA_VERSION,
  warning: 'Exploratory primitive evidence only; this cannot qualify Apple Container.',
});
writeJsonAtomic(path.join(evidenceDir, 'environment.json'), {
  environment: captureEnvironment(process.env),
  runId,
  schemaVersion: SCHEMA_VERSION,
});
appendLedger(evidenceDir, {
  event: 'probe-started',
  generation,
  requestedName,
  runId,
  time: new Date().toISOString(),
});

let sequence = 0;
let containerId;
let cleaning = false;
let probeExit = 1;

process.on('SIGINT', () => {
  void cleanup('SIGINT').finally(() => process.exit(130));
});
process.on('SIGTERM', () => {
  void cleanup('SIGTERM').finally(() => process.exit(143));
});

const createArgv = [
  'container',
  'create',
  '--name',
  requestedName,
  '--network',
  'none',
  '--no-dns',
  '--platform',
  'linux/arm64',
  '--cpus',
  '1',
  '--memory',
  '512M',
  '--cap-drop',
  'ALL',
  '--read-only',
  '--tmpfs',
  '/run',
  '--tmpfs',
  '/tmp',
  '--shm-size',
  '32M',
  '--init',
  '--label',
  `${ownershipLabel}=${runId}`,
  '--label',
  `${generationLabel}=${generation}`,
  '--entrypoint',
  '/bin/sh',
  image,
  '-c',
  'trap "exit 0" TERM INT; while :; do sleep 3600; done',
];

try {
  recordHostBaseline();
  appendLedger(evidenceDir, {
    argv: createArgv,
    event: 'intent',
    generation,
    requestedName,
    runId,
    specification: {
      capabilities: [],
      cpus: 1,
      memoryBytes: 512 * 1024 * 1024,
      network: 'none',
      pids: 'unsupported-by-apple-container',
      readOnlyRoot: true,
    },
    time: new Date().toISOString(),
  });
  const created = runCommand('create', createArgv);
  containerId = created.stdout.trim();
  if (containerId !== requestedName) {
    throw new Error(`Apple Container returned unexpected identity: ${containerId}`);
  }
  appendLedger(evidenceDir, {
    event: 'created',
    generation,
    requestedName,
    resourceId: containerId,
    runId,
    time: new Date().toISOString(),
  });

  const createdInspect = inspectOwned('inspect-created');
  assertEffectiveEnvelope(createdInspect);
  runCommand('start', ['container', 'start', containerId]);
  await waitForRunning();
  const runningInspect = inspectOwned('inspect-running');
  assertEffectiveEnvelope(runningInspect);

  runCommand('guest-inventory', [
    'container',
    'exec',
    containerId,
    '/bin/sh',
    '-c',
    [
      'uname -a',
      'cat /etc/os-release',
      'id',
      'cat /proc/self/status',
      'cat /proc/self/uid_map',
      'cat /proc/self/gid_map',
      'cat /proc/self/cgroup',
      'cat /proc/self/mountinfo',
      'cat /proc/filesystems',
      'cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || true',
      'cat /proc/sys/user/max_user_namespaces 2>/dev/null || true',
      'cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null || true',
      'cat /sys/fs/cgroup/cgroup.type 2>/dev/null || true',
      'ls -la /dev',
      'ls -la /dev/vsock 2>/dev/null || true',
      'find /sys/bus/virtio/devices -maxdepth 2 -type f -name modalias -print -exec cat {} \\; 2>/dev/null || true',
      'ip -details link show',
      'ip route show table all',
      'cat /etc/resolv.conf 2>/dev/null || true',
    ].join('; '),
  ]);

  const userNamespace = runCommand(
    'unprivileged-user-namespace',
    [
      'container',
      'exec',
      '--user',
      '1000:1000',
      containerId,
      '/bin/sh',
      '-c',
      'unshare -Ur /bin/sh -c "id; cat /proc/self/uid_map; cat /proc/self/gid_map; cat /proc/self/status"',
    ],
    true,
  );
  const mountNamespace = runCommand(
    'unprivileged-user-mount-pid-proc-namespace',
    [
      'container',
      'exec',
      '--user',
      '1000:1000',
      containerId,
      '/bin/sh',
      '-c',
      'unshare -Urmpf --mount-proc /bin/sh -c "id; mount | grep -E \' on /proc \'"',
    ],
    true,
  );
  const dns = runCommand(
    'dns-egress-must-fail',
    ['container', 'exec', containerId, '/bin/sh', '-c', 'timeout 4 nslookup registry-1.docker.io'],
    true,
  );
  const ip = runCommand(
    'direct-ip-egress-must-fail',
    ['container', 'exec', containerId, '/bin/sh', '-c', 'timeout 4 wget -T 2 -qO- http://1.1.1.1'],
    true,
  );
  if (userNamespace.exitCode !== 0) throw new ProbeFailure('unprivileged user namespace creation failed');
  if (mountNamespace.exitCode !== 0) {
    throw new ProbeFailure('unprivileged user/mount/PID namespace with a fresh procfs failed');
  }
  if (dns.exitCode === 0 || ip.exitCode === 0) throw new ProbeFailure('network=none allowed direct DNS or IP egress');

  writeSummary('supported-guest-prerequisites');
  probeExit = 0;
} catch (error) {
  const classification = error instanceof ProbeFailure ? 'falsified' : 'blocked-by-harness-or-runtime-error';
  writeSummary(classification, error.message);
} finally {
  await cleanup('normal-or-error');
}

function recordHostBaseline() {
  runCommand('host-sw-vers', ['sw_vers']);
  runCommand('host-uname', ['uname', '-a']);
  runCommand('container-version', ['container', '--version']);
  runCommand('container-system-status', ['container', 'system', 'status']);
  const imageInspect = runCommand('image-inspect', ['container', 'image', 'inspect', image]);
  const imageValue = JSON.parse(imageInspect.stdout)[0];
  if (imageValue?.configuration?.descriptor?.digest !== expectedImageDigest) {
    throw new Error('local Apple helper image does not match the pinned index digest');
  }
  runCommand('apple-container-canaries-before', ['container', 'list', '--all', '--quiet']);
  runCommand('docker-canaries-before', ['docker', 'ps', '-a', '--format', '{{.ID}}']);
}

async function waitForRunning() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = runCommand('readiness-inspect', ['container', 'inspect', containerId], true);
    if (result.exitCode === 0 && JSON.parse(result.stdout)[0]?.status?.state === 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Apple guest did not become running');
}

function inspectOwned(label) {
  const result = runCommand(label, ['container', 'inspect', containerId]);
  const value = JSON.parse(result.stdout)[0];
  if (value?.id !== containerId || value?.configuration?.id !== requestedName) {
    throw new Error('Apple container immutable identity mismatch');
  }
  const labels = value.configuration?.labels ?? {};
  if (labels[ownershipLabel] !== runId || labels[generationLabel] !== String(generation)) {
    throw new Error('refusing operation: Apple container ownership/generation mismatch');
  }
  return value;
}

function assertEffectiveEnvelope(value) {
  const configuration = value.configuration ?? {};
  if (
    JSON.stringify(configuration.capDrop ?? []) !== JSON.stringify(['ALL']) ||
    (configuration.capAdd ?? []).length !== 0 ||
    configuration.networks?.length !== 0 ||
    configuration.readOnly !== true ||
    configuration.resources?.cpus !== 1 ||
    configuration.resources?.memoryInBytes !== 512 * 1024 * 1024 ||
    (configuration.mounts ?? []).some((mount) => mount.type?.virtiofs !== undefined)
  ) {
    throw new Error('Apple guest effective envelope differs from the requested isolated VM');
  }
}

async function cleanup(reason) {
  if (cleaning) return;
  cleaning = true;
  const deleted = [];
  try {
    if (containerId) {
      const inspected = runCommand('cleanup-inspect', ['container', 'inspect', containerId], true);
      if (inspected.exitCode === 0) {
        inspectValueOwned(JSON.parse(inspected.stdout)[0]);
        const removed = runCommand('cleanup-delete', ['container', 'delete', '--force', containerId], true);
        if (removed.exitCode !== 0) throw new Error(`exact cleanup failed: ${removed.stderr.trim()}`);
        deleted.push(containerId);
      }
    }
    for (const ordinal of [1, 2]) {
      const inventory = collectCleanupInventory(ordinal);
      writeJsonAtomic(path.join(evidenceDir, 'cleanup', `inventory-${ordinal}.json`), inventory);
      if (inventory.containers.length !== 0) throw new Error(`cleanup inventory ${ordinal} is not empty`);
    }
    runCommand('apple-container-canaries-after', ['container', 'list', '--all', '--quiet']);
    runCommand('docker-canaries-after', ['docker', 'ps', '-a', '--format', '{{.ID}}']);
    writeJsonAtomic(path.join(evidenceDir, 'cleanup-result.json'), {
      deletedResourceIds: deleted,
      reason,
      runId,
      schemaVersion: SCHEMA_VERSION,
      status: 'complete',
    });
  } catch (error) {
    writeJsonAtomic(path.join(evidenceDir, 'cleanup-result.json'), {
      deletedResourceIds: deleted,
      error: error.message,
      reason,
      runId,
      schemaVersion: SCHEMA_VERSION,
      status: 'failed',
    });
    probeExit = 1;
  }
  writeManifest(evidenceDir, runId);
}

function inspectValueOwned(value) {
  if (value?.id !== containerId || value?.configuration?.id !== requestedName) {
    throw new Error('refusing cleanup: Apple container identity mismatch');
  }
  const labels = value.configuration?.labels ?? {};
  if (labels[ownershipLabel] !== runId || labels[generationLabel] !== String(generation)) {
    throw new Error('refusing cleanup: Apple container ownership/generation mismatch');
  }
}

function collectCleanupInventory(ordinal) {
  const list = runCommand(`cleanup-inventory-${ordinal}-containers`, ['container', 'list', '--all', '--quiet']);
  const containers = list.stdout
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value === requestedName);
  return { containers, ordinal, runId, schemaVersion: SCHEMA_VERSION, volumes: [] };
}

function runCommand(label, argv, allowFailure = false) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  const record = {
    argv,
    durationMs: Date.now() - started,
    endedAt: new Date().toISOString(),
    exitCode: result.status,
    runId,
    schemaVersion: SCHEMA_VERSION,
    signal: result.signal,
    startedAt,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
  sequence += 1;
  writeJsonAtomic(path.join(evidenceDir, 'commands', `${String(sequence).padStart(2, '0')}-${label}.json`), record);
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${argv[0]} ${argv[1] ?? ''} exited ${result.status}: ${(result.stderr ?? '').trim()}`);
  }
  return record;
}

function writeSummary(classification, error) {
  writeJsonAtomic(path.join(evidenceDir, 'summary.json'), {
    classification,
    error: error ?? null,
    generation,
    hypothesis: 'AC-H1 stock Apple guest kernel and OCI prerequisite inventory',
    requestedName,
    runId,
    schemaVersion: SCHEMA_VERSION,
  });
}

function parseOptionalArgs(argv) {
  if (argv.length === 0) return {};
  return parseArgs(argv, []);
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', 't').toLowerCase();
}

process.exitCode = probeExit;
