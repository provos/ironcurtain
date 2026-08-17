#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkspace = path.resolve(scriptDir, '../../..');
const parsed = parseOptionalArgs(process.argv.slice(2));
const workspaceRoot = path.resolve(parsed['workspace-root'] ?? defaultWorkspace);
const runId = parsed['run-id'] ?? `dd-p0-${utcStamp()}-${randomBytes(4).toString('hex')}`;
const evidenceDir = path.resolve(parsed['evidence-dir'] ?? path.join(os.tmpdir(), 'ic-secure-nested-phase0b', runId));
const image = parsed.image ?? 'docker@sha256:67c4114553192e9072969fc347426048cfe4192385dc762d8eb449c05e904255';
const probe = (parsed.probe ?? 'namespace').toLowerCase();
if (!['daemon', 'namespace'].includes(probe)) throw new Error('--probe must be daemon or namespace');
const idmapMode = (parsed['idmap-mode'] ?? 'disabled').toLowerCase();
if (!['cap-setid', 'disabled', 'setuid-helpers'].includes(idmapMode)) {
  throw new Error('--idmap-mode must be disabled, setuid-helpers, or cap-setid');
}
const profileLevel = (parsed['profile-level'] ?? 'p0').toLowerCase();
if (!['p0', 'p2'].includes(profileLevel)) throw new Error('--profile-level must be p0 or p2');
const profilePath =
  profileLevel === 'p2' ? path.join(workspaceRoot, 'config/docker-workload/seccomp/desktop-p2-userns.json') : undefined;
const profileHash = profilePath ? sha256File(profilePath) : 'docker-builtin';
const expectedProfileHash = 'e5be04f5d37728c4c863768deea26eae3e64c07437e11c7363cb6e5ee27f983f';
if (profilePath && profileHash !== expectedProfileHash) {
  throw new Error(
    `P2 seccomp artifact hash mismatch: expected ${expectedProfileHash}, received ${profileHash} at ${profilePath}`,
  );
}
const requestedName = `ic-nested-spike-${runId}`;
const generation = 1;
const ownershipLabel = `com.ironcurtain.nested-spike.run-id=${runId}`;
const generationLabel = `com.ironcurtain.nested-spike.generation=${generation}`;

assertRunId(runId);
assertOutsideWorkspace(evidenceDir, workspaceRoot);
ensurePrivateDirectory(evidenceDir, true);
ensurePrivateDirectory(path.join(evidenceDir, 'commands'));
ensurePrivateDirectory(path.join(evidenceDir, 'cleanup'));

writeJsonAtomic(path.join(evidenceDir, 'run.json'), {
  generation,
  image,
  idmapMode,
  phase: `0B-DD-${profileLevel.toUpperCase()}-${probe}`,
  probe,
  profileHash,
  profileLevel: profileLevel.toUpperCase(),
  requestedName,
  runId,
  schemaVersion: SCHEMA_VERSION,
  warning: 'Exploratory primitive evidence only; this cannot qualify Docker Desktop.',
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
let anonymousVolumes = [];
let cleaning = false;
let probeExit = 1;

process.on('SIGINT', () => {
  void cleanup('SIGINT').finally(() => process.exit(130));
});
process.on('SIGTERM', () => {
  void cleanup('SIGTERM').finally(() => process.exit(143));
});

const commonCreateArgv = [
  'docker',
  'create',
  '--name',
  requestedName,
  '--label',
  ownershipLabel,
  '--label',
  generationLabel,
  '--network',
  'none',
  '--cap-drop',
  'ALL',
  ...(idmapMode === 'cap-setid' ? ['--cap-add', 'SETUID', '--cap-add', 'SETGID'] : []),
  ...(idmapMode === 'disabled' ? ['--security-opt', 'no-new-privileges=true'] : []),
  ...(profilePath ? ['--security-opt', `seccomp=${profilePath}`] : []),
  '--read-only',
  '--pids-limit',
  '128',
  '--memory',
  '512m',
  '--cpus',
  '1',
  '--tmpfs',
  '/run:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000',
  '--tmpfs',
  '/tmp:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000',
];
const createArgv =
  probe === 'namespace'
    ? [
        ...commonCreateArgv,
        '--entrypoint',
        '/bin/sh',
        image,
        '-c',
        'trap "exit 0" TERM INT; while :; do sleep 3600; done',
      ]
    : [
        ...commonCreateArgv,
        '--env',
        'DOCKER_TLS_CERTDIR=',
        '--env',
        'DOCKERD_ROOTLESS_ROOTLESSKIT_NET=none',
        '--env',
        'XDG_RUNTIME_DIR=/run/user/1000',
        image,
        'dockerd',
        '--host=unix:///run/user/1000/docker.sock',
        '--storage-driver=vfs',
        '--data-root=/home/rootless/.local/share/docker',
        '--exec-root=/run/user/1000/docker',
        '--pidfile=/run/user/1000/docker.pid',
        '--iptables=false',
        '--bridge=none',
        '--ip-forward=false',
        '--ip-masq=false',
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
      capabilities: idmapMode === 'cap-setid' ? ['SETGID', 'SETUID'] : [],
      cpus: 1,
      memoryBytes: 512 * 1024 * 1024,
      network: 'none',
      noNewPrivileges: idmapMode === 'disabled',
      idmapMode,
      pids: 128,
      probe,
      profileHash,
      profileLevel: profileLevel.toUpperCase(),
      readOnlyRoot: true,
    },
    time: new Date().toISOString(),
  });
  const created = runCommand('create', createArgv);
  if (created.exitCode !== 0) throw new Error(`docker create failed: ${created.stderr.trim()}`);
  containerId = created.stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('docker returned an invalid container ID');
  appendLedger(evidenceDir, {
    event: 'created',
    generation,
    requestedName,
    resourceId: containerId,
    runId,
    time: new Date().toISOString(),
  });

  const inspected = runCommand('inspect-created', ['docker', 'inspect', containerId]);
  if (inspected.exitCode !== 0) throw new Error('cannot inspect created P0 container');
  const inspectValue = JSON.parse(inspected.stdout)[0];
  assertOwnedInspect(inspectValue);
  anonymousVolumes = (inspectValue.Mounts ?? [])
    .filter((mount) => mount.Type === 'volume')
    .map((mount) => mount.Name)
    .sort();

  const started = runCommand('start', ['docker', 'start', containerId]);
  if (started.exitCode !== 0) throw new Error(`docker start failed: ${started.stderr.trim()}`);
  const probeResult = probe === 'namespace' ? await runNamespaceProbe() : await runDaemonProbe();
  probeExit = probeResult.exitCode;
  writeJsonAtomic(path.join(evidenceDir, 'summary.json'), {
    classification: probeResult.exitCode === 0 ? `supported-at-${profileLevel}` : `falsified-at-${profileLevel}`,
    generation,
    hypothesis:
      probe === 'namespace'
        ? `DD-H1 namespace prerequisite under ${profileLevel.toUpperCase()}`
        : `DD-H1 rootless daemon boot under ${profileLevel.toUpperCase()}`,
    p1Disposition:
      'subordinate ID files and ID-map helpers present; daemon boot requires SETUID/SETGID in the outer bounding set',
    idmapMode,
    probe,
    profileHash,
    probeExitCode: probeResult.exitCode,
    requestedName,
    runId,
    schemaVersion: SCHEMA_VERSION,
  });
} catch (error) {
  writeJsonAtomic(path.join(evidenceDir, 'summary.json'), {
    classification: 'blocked-by-harness-or-runtime-error',
    error: error.message,
    generation,
    hypothesis:
      probe === 'namespace'
        ? `DD-H1 namespace prerequisite under ${profileLevel.toUpperCase()}`
        : `DD-H1 rootless daemon boot under ${profileLevel.toUpperCase()}`,
    probe,
    idmapMode,
    profileHash,
    probeExitCode: null,
    requestedName,
    runId,
    schemaVersion: SCHEMA_VERSION,
  });
} finally {
  await cleanup('normal-or-error');
}

async function cleanup(reason) {
  if (cleaning) return;
  cleaning = true;
  const deleted = [];
  try {
    if (containerId) {
      const inspect = runCommand('cleanup-inspect', ['docker', 'inspect', containerId], true);
      if (inspect.exitCode === 0) {
        assertOwnedInspect(JSON.parse(inspect.stdout)[0]);
        const removed = runCommand('cleanup-remove', ['docker', 'rm', '-f', '-v', containerId], true);
        if (removed.exitCode !== 0) throw new Error(`exact cleanup failed: ${removed.stderr.trim()}`);
        deleted.push(containerId);
      }
    }
    for (const ordinal of [1, 2]) {
      const inventory = collectCleanupInventory(ordinal);
      writeJsonAtomic(path.join(evidenceDir, 'cleanup', `inventory-${ordinal}.json`), inventory);
      if (inventory.containers.length !== 0 || inventory.volumes.length !== 0) {
        throw new Error(`cleanup inventory ${ordinal} is not empty`);
      }
    }
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

function recordHostBaseline() {
  runCommand('host-sw-vers', ['sw_vers']);
  runCommand('host-uname', ['uname', '-a']);
  runCommand('docker-version', ['docker', 'version']);
  runCommand('docker-info', ['docker', 'info']);
  runCommand('image-inspect', ['docker', 'image', 'inspect', image]);
}

function runCommand(label, argv, allowFailure = false) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
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
    throw new Error(`${argv[0]} ${argv[1] ?? ''} exited ${result.status}`);
  }
  return record;
}

async function waitForRunning() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = runCommand('readiness-inspect', [
      'docker',
      'inspect',
      '--format',
      '{{.State.Running}}',
      containerId,
    ]);
    if (result.stdout.trim() === 'true') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('P0 container did not become running');
}

async function runNamespaceProbe() {
  await waitForRunning();
  return runCommand(
    'namespace-inventory',
    [
      'docker',
      'exec',
      containerId,
      '/bin/sh',
      '-c',
      [
        'id',
        'cat /proc/self/uid_map',
        'cat /proc/self/gid_map',
        'cat /proc/self/status',
        'cat /proc/self/cgroup',
        'cat /etc/subuid 2>/dev/null || true',
        'cat /etc/subgid 2>/dev/null || true',
        'command -v newuidmap || true',
        'command -v newgidmap || true',
        'find / -xdev -perm -4000 -type f -print 2>/dev/null | sort',
        'getcap -r / 2>/dev/null || true',
        'rootlesskit --version',
        'command -v strace || true',
        'cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || true',
        'cat /proc/sys/user/max_user_namespaces 2>/dev/null || true',
        'unshare -Ur /bin/sh -c "id; cat /proc/self/uid_map; cat /proc/self/gid_map"',
      ].join('; '),
    ],
    true,
  );
}

async function runDaemonProbe() {
  const deadline = Date.now() + 15_000;
  let lastResult;
  while (Date.now() < deadline) {
    const state = runCommand('daemon-state', ['docker', 'inspect', '--format', '{{json .State}}', containerId], true);
    if (state.exitCode !== 0) break;
    const stateValue = JSON.parse(state.stdout);
    if (!stateValue.Running) break;
    lastResult = runCommand(
      'daemon-readiness',
      ['docker', 'exec', containerId, '/bin/sh', '-c', 'DOCKER_HOST=unix:///run/user/1000/docker.sock docker info'],
      true,
    );
    if (lastResult.exitCode === 0) {
      runCommand('daemon-version', [
        'docker',
        'exec',
        containerId,
        '/bin/sh',
        '-c',
        'DOCKER_HOST=unix:///run/user/1000/docker.sock docker version',
      ]);
      runCommand('daemon-outer-inventory', [
        'docker',
        'exec',
        containerId,
        '/bin/sh',
        '-c',
        'id; cat /proc/self/status; cat /proc/self/uid_map; cat /proc/self/gid_map; cat /proc/self/cgroup; cat /proc/self/mountinfo',
      ]);
      return lastResult;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  runCommand('daemon-logs', ['docker', 'logs', containerId], true);
  return lastResult ?? { exitCode: 1 };
}

function assertOwnedInspect(inspect) {
  if (inspect.Id !== containerId) throw new Error('container immutable ID mismatch');
  const labels = inspect.Config?.Labels ?? {};
  if (
    labels['com.ironcurtain.nested-spike.run-id'] !== runId ||
    labels['com.ironcurtain.nested-spike.generation'] !== String(generation) ||
    inspect.Name !== `/${requestedName}`
  ) {
    throw new Error('refusing operation: container ownership/generation/name mismatch');
  }
}

function collectCleanupInventory(ordinal) {
  const containers = runCommand(`cleanup-inventory-${ordinal}-containers`, [
    'docker',
    'ps',
    '-a',
    '--filter',
    `label=${ownershipLabel}`,
    '--format',
    '{{.ID}}',
  ])
    .stdout.split('\n')
    .filter(Boolean)
    .sort();
  const volumes = [];
  for (const volume of anonymousVolumes) {
    const inspected = runCommand(`cleanup-inventory-${ordinal}-volume`, ['docker', 'volume', 'inspect', volume], true);
    if (inspected.exitCode === 0) volumes.push(volume);
  }
  return { containers, ordinal, runId, schemaVersion: SCHEMA_VERSION, volumes };
}

function parseOptionalArgs(argv) {
  if (argv.length === 0) return {};
  return parseArgs(argv, []);
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', 't').toLowerCase();
}

function sha256File(filename) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

process.exitCode = probeExit;
