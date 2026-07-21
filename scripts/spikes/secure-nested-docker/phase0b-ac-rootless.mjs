#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
const runId = parsed['run-id'] ?? `ac-rootless-${utcStamp()}-${randomBytes(4).toString('hex')}`;
const evidenceDir = path.resolve(parsed['evidence-dir'] ?? path.join(os.tmpdir(), 'ic-secure-nested-phase0b', runId));
const probe = (parsed.probe ?? 'daemon').toLowerCase();
if (!['daemon', 'functional', 'boundary', 'resource', 'disk', 'fault', 'path', 'relay'].includes(probe)) {
  throw new Error('--probe must be daemon, functional, boundary, resource, disk, fault, path, or relay');
}
const faultMode = (parsed['fault-mode'] ?? 'workload').toLowerCase();
if (probe === 'fault' && !['workload', 'client-disconnect', 'daemon', 'vm-delete'].includes(faultMode)) {
  throw new Error('--fault-mode must be workload, client-disconnect, daemon, or vm-delete');
}
const needsStaging = probe !== 'daemon';
const image = parsed.image ?? 'untagged@sha256:cfa7f334cf89e627f577d82dcf6e42410f02b6f399df2db9f1587ec5f3857b79';
const expectedImageIndex =
  parsed['image-index'] ?? 'sha256:34f85aff4add6980dbbd3c5ac3e493f83b9a7a8b06e02110f509c334801f2550';
const expectedImageManifest =
  parsed['image-manifest'] ?? 'sha256:cfa7f334cf89e627f577d82dcf6e42410f02b6f399df2db9f1587ec5f3857b79';
const requestedName = `ic-nested-spike-${runId}`;
const peerName = `${requestedName}-peer`;
const generation = 1;
const ownershipLabel = 'com.ironcurtain.nested-spike.run-id';
const generationLabel = 'com.ironcurtain.nested-spike.generation';
const roleLabel = 'com.ironcurtain.nested-spike.role';
const runtimeRoot = '/tmp/ironcurtain-rootless';
const apiSocket = `${runtimeRoot}/docker.sock`;
const stagingDir = path.join(evidenceDir, 'staging');
const stageRoot = '/run/ironcurtain-staged';
const stagedArchiveHostPath = path.join(stagingDir, 'alpine.tar');
const stagedArchiveGuestPath = `${stageRoot}/alpine.tar`;
const stagedSocatArchiveHostPath = path.join(stagingDir, 'socat.tar');
const stagedSocatArchiveGuestPath = `${stageRoot}/socat.tar`;
const helperImage = 'alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b';
const helperImageId = 'sha256:1991bd789d7184290c3cce84fd6af068b8b745e9bddf178661ce7f5ecf68135c';
const socatImage = 'alpine/socat@sha256:9a44e2731464d8eeb1c1d36fb25c0335fb166ce1064534a2ac53556c4dcd8fb5';
const socatImageId = 'sha256:c7a8bb471d79181d6f9719cb3b29a39403e5b7d962264505053d1fa84d9cfa53';
const peerImage = 'alpine:latest';
const expectedPeerImageIndex = 'sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b';
const stagedTag = `ic-h3-staged:${runId}`;
const workspaceFixtureParent = path.join(os.tmpdir(), 'ic-secure-nested-path-fixtures');
const workspaceFixtureDir = path.join(workspaceFixtureParent, runId);
const nodeModulesVolume = `ic-nested-node-modules-${runId}`;
// Darwin limits sockaddr_un paths to 104 bytes. Keep this host endpoint short;
// the run ID still provides exact ownership and cleanup identity.
const relayFixtureParent = '/private/tmp/ic-nested-relay';
const relayFixtureDir = path.join(relayFixtureParent, runId);
const hostRelaySocket = path.join(relayFixtureDir, 'outer-mitm.sock');
const relayReadyFile = path.join(relayFixtureDir, 'ready');
const relayLogFile = path.join(relayFixtureDir, 'relay.jsonl');
const guestRelaySocket = '/run/ironcurtain-nested/outer-mitm.sock';
const containerAppRoot = path.resolve(
  parsed['container-app-root'] ?? path.join(os.homedir(), 'Library', 'Application Support', 'com.apple.container'),
);
const ownedAppleBundlePath = path.join(containerAppRoot, 'containers', requestedName);
const ownedAppleRootfsPath = path.join(ownedAppleBundlePath, 'rootfs.ext4');

assertRunId(runId);
assertOutsideWorkspace(evidenceDir, workspaceRoot);
assertOutsideWorkspace(workspaceFixtureDir, workspaceRoot);
assertOutsideWorkspace(relayFixtureDir, workspaceRoot);
ensurePrivateDirectory(evidenceDir, true);
ensurePrivateDirectory(path.join(evidenceDir, 'commands'));
ensurePrivateDirectory(path.join(evidenceDir, 'cleanup'));

writeJsonAtomic(path.join(evidenceDir, 'run.json'), {
  apiSocket,
  expectedImageIndex,
  expectedImageManifest,
  generation,
  image,
  phase:
    probe === 'relay'
      ? '0B-AC-H3-ROOTLESS-FIXED-RELAY'
      : probe === 'path'
        ? '0B-AC-H4-ROOTLESS-PATH'
        : probe === 'fault'
          ? `0B-AC-FAULT-${faultMode.toUpperCase()}`
          : probe === 'disk'
            ? '0B-AC-H6-ROOTLESS-DISK'
            : probe === 'resource'
              ? '0B-AC-H5-ROOTLESS-RESOURCE'
              : probe === 'boundary'
                ? '0B-AC-H3-ROOTLESS-BOUNDARY'
                : probe === 'functional'
                  ? '0B-AC-H1-ROOTLESS-FUNCTIONAL'
                  : '0B-AC-H1-ROOTLESS-DAEMON',
  probe,
  faultMode: probe === 'fault' ? faultMode : null,
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
let peerId;
let cleaning = false;
let probeExit = 1;
const diskSnapshots = [];
let terminalFaultApplied = false;
const predeletedResourceIds = [];
let nodeModulesVolumeCreated = false;
let workspaceFixtureDeleted = false;
let relayProcess;
let relayProcessStopped = false;
let relayFixtureDeleted = false;

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
  '2',
  '--memory',
  '1G',
  '--cap-drop',
  'ALL',
  '--cap-add',
  'CAP_SETUID',
  '--cap-add',
  'CAP_SETGID',
  '--tmpfs',
  '/tmp',
  ...(needsStaging ? ['--volume', `${stagingDir}:${stageRoot}:ro`] : []),
  ...(probe === 'path'
    ? ['--volume', `${workspaceFixtureDir}:/workspace`, '--volume', `${nodeModulesVolume}:/workspace/node_modules`]
    : []),
  ...(probe === 'relay' ? ['--volume', `${hostRelaySocket}:${guestRelaySocket}:ro`] : []),
  '--shm-size',
  '64M',
  '--init',
  '--label',
  `${ownershipLabel}=${runId}`,
  '--label',
  `${generationLabel}=${generation}`,
  '--label',
  `${roleLabel}=daemon`,
  '--env',
  'DOCKER_TLS_CERTDIR=',
  '--env',
  'DOCKERD_ROOTLESS_ROOTLESSKIT_NET=none',
  '--env',
  `XDG_RUNTIME_DIR=${runtimeRoot}`,
  image,
  'dockerd',
  `--host=unix://${apiSocket}`,
  '--storage-driver=vfs',
  '--data-root=/home/rootless/.local/share/docker',
  `--exec-root=${runtimeRoot}/exec`,
  `--pidfile=${runtimeRoot}/docker.pid`,
  '--iptables=false',
  '--bridge=none',
  '--ip-masq=false',
];

try {
  recordHostBaseline();
  if (needsStaging) prepareStagedImage();
  if (probe === 'path') prepareWorkspaceAndVolume();
  if (probe === 'relay') prepareFixedRelay();
  appendLedger(evidenceDir, {
    argv: createArgv,
    event: 'intent',
    generation,
    requestedName,
    runId,
    specification: {
      capabilities: ['CAP_SETGID', 'CAP_SETUID'],
      cpus: 2,
      memoryBytes: 1024 * 1024 * 1024,
      network: 'none',
      pids: 'unsupported-by-apple-container',
      rootlessKitNetwork: 'none',
      storageDriver: 'vfs',
      staging: needsStaging ? { access: 'read-only', path: stageRoot } : null,
      workspace: probe === 'path' ? { source: workspaceFixtureDir, target: '/workspace' } : null,
      nodeModulesVolume: probe === 'path' ? nodeModulesVolume : null,
      fixedRelay: probe === 'relay' ? { guest: guestRelaySocket, host: hostRelaySocket } : null,
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
  assertEffectiveEnvelope(inspectOwned('inspect-created'));
  if (probe === 'disk') captureAppleDisk('after-create-before-materialization', false);
  runCommand('start', ['container', 'start', containerId]);
  await waitForDaemon();
  assertEffectiveEnvelope(inspectOwned('inspect-running'));

  runCommand('daemon-version', rootlessDocker(['version']));
  const info = runCommand('daemon-info', rootlessDocker(['info', '--format', '{{json .}}']));
  const infoValue = JSON.parse(info.stdout);
  if (
    infoValue.Driver !== 'vfs' ||
    infoValue.SecurityOptions?.some((value) => String(value).includes('rootless')) !== true
  ) {
    throw new ProbeFailure('daemon info does not prove rootless vfs operation');
  }
  if (probe === 'disk') captureAppleDisk('after-daemon-ready');
  if (needsStaging) runFunctionalPrimitives();
  if (probe === 'disk') captureAppleDisk('after-functional-matrix');
  if (probe === 'boundary') runBoundaryPrimitives();
  if (probe === 'resource') runResourcePrimitives();
  if (probe === 'disk') runDiskPrimitives();
  if (probe === 'fault') runFaultPrimitives();
  if (probe === 'path') runPathPrimitives();
  if (probe === 'relay') await runRelayPrimitives();
  if (!terminalFaultApplied) runPostProbeDaemonChecks();
  writeSummary(
    probe === 'relay'
      ? 'supported-fixed-relay-primitives'
      : probe === 'path'
        ? 'supported-workspace-path-primitives'
        : probe === 'fault'
          ? `supported-fault-${faultMode}-cleanup-primitives`
          : probe === 'disk'
            ? 'supported-vm-disk-observation-primitives'
            : probe === 'resource'
              ? 'supported-vm-resource-primitives'
              : probe === 'boundary'
                ? 'supported-vm-boundary-primitives'
                : probe === 'functional'
                  ? 'supported-functional-primitives'
                  : 'supported-rootless-daemon-boot',
  );
  probeExit = 0;
} catch (error) {
  if (containerId) runCommand('failure-daemon-logs', ['container', 'logs', containerId], true);
  const classification = error instanceof ProbeFailure ? 'falsified' : 'blocked-by-harness-or-runtime-error';
  writeSummary(classification, error.message);
} finally {
  await cleanup('normal-or-error');
}

function runPostProbeDaemonChecks() {
  runCommand('daemon-process-inventory', [
    'container',
    'exec',
    '--user',
    '1000:1000',
    containerId,
    '/bin/sh',
    '-c',
    [
      'id',
      'ps -ef',
      'cat /proc/1/status',
      'cat /proc/1/uid_map',
      'cat /proc/1/gid_map',
      'cat /proc/1/cgroup',
      'cat /proc/1/mountinfo',
      `stat -c '%A %a %u %g %n' ${runtimeRoot} ${apiSocket}`,
      'ip link show',
      'ip route show table all',
    ].join('; '),
  ]);
  const dns = runCommand(
    'daemon-dns-egress-must-fail',
    [
      'container',
      'exec',
      '--user',
      '1000:1000',
      containerId,
      '/bin/sh',
      '-c',
      'timeout 4 nslookup registry-1.docker.io',
    ],
    true,
  );
  const ip = runCommand(
    'daemon-direct-ip-egress-must-fail',
    [
      'container',
      'exec',
      '--user',
      '1000:1000',
      containerId,
      '/bin/sh',
      '-c',
      'timeout 4 wget -T 2 -qO- http://1.1.1.1',
    ],
    true,
  );
  if (dns.exitCode === 0 || ip.exitCode === 0) {
    throw new ProbeFailure('network=none allowed direct DNS or IP egress');
  }
  runCommand('daemon-logs', ['container', 'logs', containerId], true);
}

function recordHostBaseline() {
  runCommand('host-sw-vers', ['sw_vers']);
  runCommand('host-uname', ['uname', '-a']);
  runCommand('container-version', ['container', '--version']);
  runCommand('container-system-status', ['container', 'system', 'status']);
  const imageInspect = runCommand('image-inspect', ['container', 'image', 'inspect', image]);
  const imageValue = JSON.parse(imageInspect.stdout)[0];
  const arm64Variant = imageValue?.variants?.find(
    (variant) => variant.platform?.os === 'linux' && variant.platform?.architecture === 'arm64',
  );
  if (
    imageValue?.configuration?.descriptor?.digest !== expectedImageIndex ||
    arm64Variant?.digest !== expectedImageManifest ||
    arm64Variant?.config?.config?.User !== 'rootless'
  ) {
    throw new Error('staged Apple rootless Docker image identity or configured user mismatch');
  }
  if (probe === 'boundary' || probe === 'resource' || probe === 'fault') {
    const peerInspect = runCommand('peer-image-inspect', ['container', 'image', 'inspect', peerImage]);
    if (JSON.parse(peerInspect.stdout)[0]?.configuration?.descriptor?.digest !== expectedPeerImageIndex) {
      throw new Error('local Apple peer image does not match the pinned index digest');
    }
  }
  runCommand('apple-container-canaries-before', ['container', 'list', '--all', '--quiet']);
  runCommand('docker-canaries-before', ['docker', 'ps', '-a', '--format', '{{.ID}}']);
}

function prepareWorkspaceAndVolume() {
  ensurePrivateDirectory(workspaceFixtureDir, true);
  ensurePrivateDirectory(path.join(workspaceFixtureDir, 'node_modules'));
  writeFileSync(path.join(workspaceFixtureDir, 'seed.txt'), 'workspace-seed\n', { mode: 0o600, flag: 'wx' });
  writeFileSync(path.join(workspaceFixtureDir, 'node_modules', 'mac-host-marker'), 'must-be-hidden\n', {
    mode: 0o600,
    flag: 'wx',
  });
  symlinkSync(workspaceRoot, path.join(workspaceFixtureDir, 'mac-host-escape'));

  const argv = [
    'container',
    'volume',
    'create',
    '--label',
    `${ownershipLabel}=${runId}`,
    '--label',
    `${generationLabel}=${generation}`,
    '--label',
    `${roleLabel}=node-modules`,
    '-s',
    '256M',
    nodeModulesVolume,
  ];
  appendLedger(evidenceDir, {
    argv,
    event: 'volume-intent',
    generation,
    requestedName: nodeModulesVolume,
    runId,
    time: new Date().toISOString(),
  });
  const created = runCommand('path-create-node-modules-volume', argv);
  nodeModulesVolumeCreated = true;
  appendLedger(evidenceDir, {
    event: 'volume-created',
    generation,
    requestedName: nodeModulesVolume,
    resourceId: nodeModulesVolume,
    runId,
    time: new Date().toISOString(),
  });
  if (created.stdout.trim() !== '' && created.stdout.trim() !== nodeModulesVolume) {
    throw new Error(`Apple Container returned unexpected volume identity: ${created.stdout.trim()}`);
  }
  inspectOwnedVolume('path-inspect-node-modules-volume-created');
  writeJsonAtomic(path.join(evidenceDir, 'workspace-fixture.json'), {
    hostMacMarker: path.join(workspaceFixtureDir, 'node_modules', 'mac-host-marker'),
    nodeModulesVolume,
    runId,
    schemaVersion: SCHEMA_VERSION,
    seed: path.join(workspaceFixtureDir, 'seed.txt'),
    symlinkTarget: workspaceRoot,
    workspaceHostPath: workspaceFixtureDir,
    workspaceGuestPath: '/workspace',
  });
}

function prepareFixedRelay() {
  ensurePrivateDirectory(relayFixtureDir, true);
  writeFileSync(relayLogFile, '', { mode: 0o600, flag: 'wx' });
  relayProcess = spawn(
    process.execPath,
    [
      path.join(scriptDir, 'fixed-relay-server.mjs'),
      '--socket',
      hostRelaySocket,
      '--ready-file',
      relayReadyFile,
      '--log-file',
      relayLogFile,
    ],
    { stdio: 'ignore' },
  );
  const deadline = Date.now() + 5_000;
  while (!existsSync(relayReadyFile) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (!existsSync(relayReadyFile) || !existsSync(hostRelaySocket)) {
    throw new Error('fixed relay did not become ready');
  }
  const readyPid = Number.parseInt(readFileSync(relayReadyFile, 'utf8').trim(), 10);
  const socketStat = statSync(hostRelaySocket);
  if (readyPid !== relayProcess.pid || !socketStat.isSocket() || (socketStat.mode & 0o777) !== 0o666) {
    throw new Error('fixed relay ready identity or socket mode mismatch');
  }
  appendLedger(evidenceDir, {
    event: 'fixed-relay-started',
    guestSocket: guestRelaySocket,
    hostSocket: hostRelaySocket,
    pid: readyPid,
    runId,
    time: new Date().toISOString(),
  });
}

function prepareStagedImage() {
  mkdirSync(stagingDir, { mode: 0o700 });
  appendLedger(evidenceDir, {
    event: 'artifact-intent',
    generation,
    path: 'staging/alpine.tar',
    runId,
    source: helperImage,
    time: new Date().toISOString(),
  });
  const helperInspect = runCommand('helper-image-inspect', ['docker', 'image', 'inspect', helperImage]);
  if (JSON.parse(helperInspect.stdout)[0]?.Id !== helperImageId) {
    throw new Error('staged helper image ID does not match the pinned arm64 image ID');
  }
  runCommand('save-staged-image', ['docker', 'image', 'save', '--output', stagedArchiveHostPath, helperImage]);
  chmodSync(stagedArchiveHostPath, 0o600);
  if (probe === 'boundary' || probe === 'relay') {
    const socatInspect = runCommand('socat-image-inspect', ['docker', 'image', 'inspect', socatImage]);
    if (JSON.parse(socatInspect.stdout)[0]?.Id !== socatImageId) {
      throw new Error('staged socat image ID does not match the pinned arm64 image ID');
    }
    runCommand('save-staged-socat-image', [
      'docker',
      'image',
      'save',
      '--output',
      stagedSocatArchiveHostPath,
      socatImage,
    ]);
    chmodSync(stagedSocatArchiveHostPath, 0o600);
  }
  const dockerfile = [
    `FROM ${stagedTag}`,
    'COPY payload.txt /ironcurtain-offline-payload.txt',
    'RUN test "$(cat /ironcurtain-offline-payload.txt)" = "offline-build-ok"',
    'CMD ["cat", "/ironcurtain-offline-payload.txt"]',
    '',
  ].join('\n');
  writeFileSync(path.join(stagingDir, 'Dockerfile'), dockerfile, { mode: 0o600, flag: 'wx' });
  writeFileSync(path.join(stagingDir, 'payload.txt'), 'offline-build-ok\n', { mode: 0o600, flag: 'wx' });
  writeFileSync(path.join(stagingDir, '.dockerignore'), 'alpine.tar\nsocat.tar\n', { mode: 0o600, flag: 'wx' });
  const archiveStat = statSync(stagedArchiveHostPath);
  writeJsonAtomic(path.join(evidenceDir, 'staged-image.json'), {
    archivePath: 'staging/alpine.tar',
    archiveSha256: sha256File(stagedArchiveHostPath),
    archiveSize: archiveStat.size,
    socketProbeArtifact:
      probe === 'boundary' || probe === 'relay'
        ? {
            archivePath: 'staging/socat.tar',
            archiveSha256: sha256File(stagedSocatArchiveHostPath),
            archiveSize: statSync(stagedSocatArchiveHostPath).size,
            source: socatImage,
            sourceImageId: socatImageId,
          }
        : null,
    buildContext: ['staging/.dockerignore', 'staging/Dockerfile', 'staging/payload.txt'],
    runId,
    schemaVersion: SCHEMA_VERSION,
    source: helperImage,
    sourceImageId: helperImageId,
    stagedTag,
  });
}

function runFunctionalPrimitives() {
  const innerLabel = `com.ironcurtain.nested-spike.inner-run-id=${runId}`;
  const mainName = `ic-h3-main-${runId}`;
  const volumeName = `ic-h3-volume-${runId}`;
  const networkName = `ic-h3-network-${runId}`;
  const serverName = `ic-h3-target-${runId}`;
  const scannerName = `ic-h3-scanner-${runId}`;
  const builtTag = `ic-h3-offline:${runId}`;

  assertInnerSucceeded(
    innerDocker('inner-load-staged-image', ['load', '--input', stagedArchiveGuestPath]),
    'nested docker load failed',
  );
  const loadedInspect = innerDocker('inner-inspect-loaded-image', ['image', 'inspect', helperImageId]);
  assertInnerSucceeded(loadedInspect, 'loaded image ID is absent');
  if (JSON.parse(loadedInspect.stdout)[0]?.Id !== helperImageId) {
    throw new ProbeFailure('loaded image immutable ID differs from the staged image');
  }
  assertInnerSucceeded(
    innerDocker('inner-tag-staged-image', ['image', 'tag', helperImageId, stagedTag]),
    'nested staged image tag failed',
  );

  const main = innerDocker('inner-run-main', [
    'run',
    '-d',
    '--name',
    mainName,
    '--label',
    innerLabel,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,noexec,size=8m',
    helperImageId,
    '/bin/sh',
    '-c',
    'trap "exit 0" TERM INT; while :; do sleep 3600; done',
  ]);
  assertInnerSucceeded(main, 'nested docker run failed');
  const mainId = main.stdout.trim();
  assertDockerId(mainId, 'nested docker run');
  assertInnerSucceeded(
    innerDocker('inner-exec-main', [
      'exec',
      mainId,
      '/bin/sh',
      '-c',
      'printf functional-ok > /tmp/marker && test "$(cat /tmp/marker)" = functional-ok',
    ]),
    'nested docker exec failed',
  );

  assertInnerSucceeded(
    innerDocker('inner-bind-read-only', [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges=true',
      '--mount',
      `type=bind,src=${stageRoot},dst=/input,readonly`,
      helperImageId,
      '/bin/sh',
      '-c',
      'test -r /input/alpine.tar && ! touch /input/write-must-fail',
    ]),
    'nested read-only bind mount failed',
  );

  assertInnerSucceeded(
    innerDocker('inner-create-volume', ['volume', 'create', '--label', innerLabel, volumeName]),
    'nested volume create failed',
  );
  assertInnerSucceeded(
    innerDocker('inner-use-volume', [
      'run',
      '--rm',
      '--network',
      'none',
      '--mount',
      `type=volume,src=${volumeName},dst=/data`,
      helperImageId,
      '/bin/sh',
      '-c',
      'printf volume-ok > /data/marker && test "$(cat /data/marker)" = volume-ok',
    ]),
    'nested volume use failed',
  );

  assertInnerSucceeded(
    innerDocker('inner-offline-build', [
      'build',
      '--network',
      'none',
      '--pull=false',
      '--no-cache',
      '--label',
      innerLabel,
      '--tag',
      builtTag,
      stageRoot,
    ]),
    'nested offline build failed',
  );
  const builtRun = innerDocker('inner-run-built-image', ['run', '--rm', '--network', 'none', builtTag]);
  assertInnerSucceeded(builtRun, 'nested offline-built image failed to run');
  if (builtRun.stdout.trim() !== 'offline-build-ok') {
    throw new ProbeFailure('nested offline-built image returned the wrong payload');
  }

  const network = innerDocker('inner-create-network', [
    'network',
    'create',
    '--internal',
    '--label',
    innerLabel,
    networkName,
  ]);
  assertInnerSucceeded(network, 'nested internal network create failed');
  const networkId = network.stdout.trim();
  assertDockerId(networkId, 'nested network create');

  const server = innerDocker('inner-start-target', [
    'run',
    '-d',
    '--name',
    serverName,
    '--label',
    innerLabel,
    '--network',
    networkId,
    '--network-alias',
    'target',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    helperImageId,
    '/bin/sh',
    '-c',
    [
      "response='HTTP/1.1 200 OK\\r\\nContent-Length: 17\\r\\nConnection: close\\r\\n\\r\\nvulnerable-marker'",
      'while :; do printf \'%b\' "$response" | nc -l -p 8080; done',
    ].join('; '),
  ]);
  assertInnerSucceeded(server, 'nested target start failed');
  const serverId = server.stdout.trim();
  assertDockerId(serverId, 'nested target');

  const targetState = innerDocker('inner-inspect-target-state', ['inspect', '--format', '{{json .State}}', serverId]);
  assertInnerSucceeded(targetState, 'nested target state inspection failed');
  if (JSON.parse(targetState.stdout)?.Running !== true) {
    const targetLogs = innerDocker('inner-target-logs-after-start-failure', ['logs', serverId]);
    throw new ProbeFailure(
      `nested target exited before scanner: state=${targetState.stdout.trim()} logs=${targetLogs.stdout.trim() || targetLogs.stderr.trim()}`,
    );
  }

  const scanner = innerDocker('inner-run-scanner', [
    'run',
    '--rm',
    '--name',
    scannerName,
    '--label',
    innerLabel,
    '--network',
    networkId,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    helperImageId,
    '/bin/sh',
    '-c',
    'for i in 1 2 3 4 5; do body="$(wget -T 1 -qO- http://target:8080 2>/dev/null || true)"; [ "$body" = vulnerable-marker ] && exit 0; sleep 1; done; exit 1',
  ]);
  if (scanner.exitCode !== 0) {
    const failedState = innerDocker('inner-inspect-target-after-scanner-failure', [
      'inspect',
      '--format',
      '{{json .State}}',
      serverId,
    ]);
    const targetLogs = innerDocker('inner-target-logs-after-scanner-failure', ['logs', serverId]);
    throw new ProbeFailure(
      `nested target/scanner exchange failed: scanner=${scanner.stderr.trim() || scanner.stdout.trim()} targetState=${failedState.stdout.trim()} targetLogs=${targetLogs.stdout.trim() || targetLogs.stderr.trim()}`,
    );
  }

  const pull = innerDocker('inner-pull-must-fail', ['pull', 'alpine:3.19']);
  if (pull.exitCode === 0) throw new ProbeFailure('nested registry pull unexpectedly succeeded');
  const registryDns = innerDocker('inner-registry-dns-must-fail', [
    'run',
    '--rm',
    '--network',
    'host',
    helperImageId,
    '/bin/sh',
    '-c',
    'nslookup registry-1.docker.io',
  ]);
  if (registryDns.exitCode === 0) throw new ProbeFailure('nested registry DNS unexpectedly succeeded');
  const registryIp = innerDocker('inner-registry-ip-must-fail', [
    'run',
    '--rm',
    '--network',
    'host',
    helperImageId,
    '/bin/sh',
    '-c',
    'timeout 4 wget -T 2 -qO- http://1.1.1.1',
  ]);
  if (registryIp.exitCode === 0) throw new ProbeFailure('nested direct IP request unexpectedly succeeded');

  assertInnerSucceeded(innerDocker('inner-remove-target', ['rm', '-f', serverId]), 'nested target cleanup failed');
  assertInnerSucceeded(innerDocker('inner-remove-main', ['rm', '-f', mainId]), 'nested main cleanup failed');
  assertInnerSucceeded(
    innerDocker('inner-remove-network', ['network', 'rm', networkId]),
    'nested network cleanup failed',
  );
  assertInnerSucceeded(
    innerDocker('inner-remove-volume', ['volume', 'rm', volumeName]),
    'nested volume cleanup failed',
  );
  assertInnerSucceeded(
    innerDocker('inner-remove-built-image', ['image', 'rm', builtTag]),
    'built image cleanup failed',
  );
  assertInnerSucceeded(
    innerDocker('inner-remove-staged-tag', ['image', 'rm', stagedTag]),
    'staged image tag cleanup failed',
  );

  for (const [label, args] of [
    ['inner-owned-containers', ['ps', '-a', '--filter', `label=${innerLabel}`, '--quiet']],
    ['inner-owned-volumes', ['volume', 'ls', '--filter', `label=${innerLabel}`, '--quiet']],
    ['inner-owned-networks', ['network', 'ls', '--filter', `label=${innerLabel}`, '--quiet']],
    ['inner-owned-images', ['image', 'ls', '--filter', `label=${innerLabel}`, '--quiet']],
  ]) {
    const inventory = innerDocker(label, args);
    assertInnerSucceeded(inventory, `${label} failed`);
    if (inventory.stdout.trim() !== '') throw new ProbeFailure(`${label} is not empty after nested cleanup`);
  }
}

function runBoundaryPrimitives() {
  const innerLabel = `com.ironcurtain.nested-spike.boundary-run-id=${runId}`;
  const networkName = `ic-boundary-network-${runId}`;
  const targetName = `ic-boundary-target-${runId}`;
  const publicationPort = 40000 + (createHash('sha256').update(runId).digest().readUInt16BE(0) % 10000);

  assertInnerSucceeded(
    innerDocker('boundary-reload-helper-image', ['load', '--input', stagedArchiveGuestPath]),
    'nested helper image reload failed',
  );
  const helperInspect = innerDocker('boundary-reinspect-helper-image', ['image', 'inspect', helperImageId]);
  assertInnerSucceeded(helperInspect, 'nested helper image is absent after boundary reload');
  if (JSON.parse(helperInspect.stdout)[0]?.Id !== helperImageId) {
    throw new ProbeFailure('nested helper image immutable ID differs after boundary reload');
  }
  assertInnerSucceeded(
    innerDocker('boundary-load-socat-image', ['load', '--input', stagedSocatArchiveGuestPath]),
    'nested socat image load failed',
  );
  const socatInspect = innerDocker('boundary-inspect-socat-image', ['image', 'inspect', socatImageId]);
  assertInnerSucceeded(socatInspect, 'nested socat image is absent');
  if (JSON.parse(socatInspect.stdout)[0]?.Id !== socatImageId) {
    throw new ProbeFailure('nested socat image immutable ID differs from the staged image');
  }

  createBoundaryPeer();
  const outerUntrusted = runCommand('boundary-outer-untrusted-inventory', [
    'container',
    'exec',
    '--user',
    '1000:1000',
    containerId,
    '/bin/sh',
    '-c',
    [
      'id',
      'cat /proc/self/status',
      'readlink /proc/self/ns/user /proc/self/ns/net /proc/self/ns/pid /proc/self/ns/mnt',
      'ip -details link show',
      'ip route show table all',
      'ls -la /dev/vsock /dev/vport* /dev/vd* 2>/dev/null || true',
      'test ! -r /dev/vsock',
      'test ! -w /dev/vsock',
      'test ! -S /var/run/docker.sock',
      `test ! -e ${shellQuote(workspaceRoot)}`,
    ].join('; '),
  ]);
  if (outerUntrusted.exitCode !== 0) {
    throw new ProbeFailure('untrusted outer UID gained an unexpected VM device, runtime socket, or host path');
  }

  const privileged = innerDocker('boundary-inner-privileged-host-namespaces', [
    'run',
    '--rm',
    '--privileged',
    '--network',
    'host',
    '--pid',
    'host',
    '--ipc',
    'host',
    '--uts',
    'host',
    '--mount',
    `type=bind,src=${stageRoot},dst=/allowed-stage,readonly`,
    helperImageId,
    '/bin/sh',
    '-c',
    [
      'id',
      'cat /proc/self/status',
      'cat /proc/self/uid_map',
      'cat /proc/self/gid_map',
      'readlink /proc/self/ns/user /proc/self/ns/net /proc/self/ns/pid /proc/self/ns/mnt',
      'ps -ef',
      'cat /proc/self/mountinfo',
      'ip -details link show',
      'ip route show table all',
      'ls -la /dev',
      'test -r /allowed-stage/alpine.tar',
      'test ! -w /allowed-stage/alpine.tar',
      'test ! -S /var/run/docker.sock',
      `test ! -e ${shellQuote(workspaceRoot)}`,
      'if [ -e /dev/vsock ]; then test ! -r /dev/vsock && test ! -w /dev/vsock; fi',
      'timeout 3 nslookup registry-1.docker.io >/dev/null 2>&1; test $? -ne 0',
      'timeout 3 wget -T 1 -qO- http://1.1.1.1 >/dev/null 2>&1; test $? -ne 0',
    ].join('; '),
  ]);
  assertInnerSucceeded(privileged, 'inner privileged/host-namespace boundary inventory failed');

  const hostVsockResults = [];
  for (const port of [22, 53, 80, 443, 1024, 2375, 2376]) {
    const attempt = innerDocker(`boundary-host-vsock-${port}-must-fail`, [
      'run',
      '--rm',
      '--privileged',
      '--network',
      'host',
      '--entrypoint',
      'socat',
      socatImageId,
      '-T',
      '0.25',
      '-u',
      'OPEN:/dev/null',
      `VSOCK-CONNECT:2:${port}`,
    ]);
    hostVsockResults.push({ exitCode: attempt.exitCode, port });
    if (attempt.exitCode === 0) {
      throw new ProbeFailure(`untrusted nested workload connected to unexpected macOS host vsock port ${port}`);
    }
  }
  const localControl = innerDocker('boundary-local-vminitd-vsock-observation', [
    'run',
    '--rm',
    '--privileged',
    '--network',
    'host',
    '--entrypoint',
    'socat',
    socatImageId,
    '-T',
    '0.25',
    '-u',
    'OPEN:/dev/null',
    'VSOCK-CONNECT:1:1024',
  ]);

  const hostPortBefore = runCommand(
    'boundary-host-publication-preflight-must-fail',
    ['nc', '-z', '-G', '1', '127.0.0.1', String(publicationPort)],
    true,
  );
  if (hostPortBefore.exitCode === 0) {
    throw new ProbeFailure(`host publication test port ${publicationPort} was already in use`);
  }
  const network = innerDocker('boundary-create-internal-network', [
    'network',
    'create',
    '--internal',
    '--label',
    innerLabel,
    networkName,
  ]);
  assertInnerSucceeded(network, 'boundary internal network creation failed');
  const networkId = network.stdout.trim();
  assertDockerId(networkId, 'boundary internal network');

  const published = innerDocker('boundary-start-published-target', [
    'run',
    '-d',
    '--name',
    targetName,
    '--label',
    innerLabel,
    '--network',
    networkId,
    '--publish',
    `${publicationPort}:8080`,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    helperImageId,
    '/bin/sh',
    '-c',
    "while :; do printf 'boundary-ok\\n' | nc -l -p 8080; done",
  ]);
  const publishedId = published.exitCode === 0 ? published.stdout.trim() : null;
  if (publishedId !== null) {
    assertDockerId(publishedId, 'boundary published target');
    assertInnerSucceeded(
      innerDocker('boundary-inspect-published-target', ['inspect', publishedId]),
      'boundary published target inspection failed',
    );
  }

  const hostPortAfter = runCommand(
    'boundary-host-publication-after-must-fail',
    ['nc', '-z', '-G', '1', '127.0.0.1', String(publicationPort)],
    true,
  );
  if (hostPortAfter.exitCode === 0) {
    throw new ProbeFailure(`nested publication reached macOS loopback port ${publicationPort}`);
  }
  const peerPort = runCommand(
    'boundary-peer-publication-must-fail',
    ['container', 'exec', peerId, '/bin/sh', '-c', `nc -z -w 1 127.0.0.1 ${publicationPort}`],
    true,
  );
  if (peerPort.exitCode === 0) {
    throw new ProbeFailure(`nested publication reached unrelated Apple VM loopback port ${publicationPort}`);
  }
  runCommand('boundary-peer-still-responsive', ['container', 'exec', peerId, '/bin/sh', '-c', 'printf peer-ok']);

  if (publishedId !== null) {
    assertInnerSucceeded(
      innerDocker('boundary-remove-published-target', ['rm', '-f', publishedId]),
      'boundary published target cleanup failed',
    );
  }
  assertInnerSucceeded(
    innerDocker('boundary-remove-internal-network', ['network', 'rm', networkId]),
    'boundary internal network cleanup failed',
  );
  assertInnerSucceeded(
    innerDocker('boundary-remove-socat-image', ['image', 'rm', socatImageId]),
    'boundary socat image cleanup failed',
  );

  for (const [label, args] of [
    ['boundary-owned-containers', ['ps', '-a', '--filter', `label=${innerLabel}`, '--quiet']],
    ['boundary-owned-networks', ['network', 'ls', '--filter', `label=${innerLabel}`, '--quiet']],
  ]) {
    const inventory = innerDocker(label, args);
    assertInnerSucceeded(inventory, `${label} failed`);
    if (inventory.stdout.trim() !== '') throw new ProbeFailure(`${label} is not empty after boundary cleanup`);
  }

  writeJsonAtomic(path.join(evidenceDir, 'boundary-findings.json'), {
    hostPublication: {
      nestedCreateExitCode: published.exitCode,
      port: publicationPort,
      reachedMacOS: false,
      reachedPeerVM: false,
    },
    hostVsockResults,
    localVminitdPort1024Connected: localControl.exitCode === 0,
    note: 'A local vminitd connection, if observed, is VM-local authority only. Source-bound review is still required before qualification.',
    runId,
    schemaVersion: SCHEMA_VERSION,
  });
}

function runResourcePrimitives() {
  const innerLabel = `com.ironcurtain.nested-spike.resource-run-id=${runId}`;
  const cpuName = `ic-resource-cpu-${runId}`;
  const memoryName = `ic-resource-memory-${runId}`;
  const forkName = `ic-resource-fork-${runId}`;

  assertInnerSucceeded(
    innerDocker('resource-reload-helper-image', ['load', '--input', stagedArchiveGuestPath]),
    'resource helper image reload failed',
  );
  const helperInspect = innerDocker('resource-reinspect-helper-image', ['image', 'inspect', helperImageId]);
  assertInnerSucceeded(helperInspect, 'resource helper image is absent after reload');
  if (JSON.parse(helperInspect.stdout)[0]?.Id !== helperImageId) {
    throw new ProbeFailure('resource helper image immutable ID differs after reload');
  }

  createBoundaryPeer();
  const effective = inspectOwned('resource-inspect-effective-envelope');
  if (effective.configuration?.resources?.cpuOverhead !== 1) {
    throw new ProbeFailure('Apple resource evidence did not expose the expected one-vCPU runtime overhead');
  }
  runCommand('resource-guest-limits-before', [
    'container',
    'exec',
    '--user',
    '1000:1000',
    containerId,
    '/bin/sh',
    '-c',
    [
      'nproc',
      'grep -E "^(Cpus_allowed|Cpus_allowed_list|Mems_allowed|Mems_allowed_list)" /proc/self/status',
      'cat /proc/meminfo',
      'cat /sys/fs/cgroup/cpu.max 2>/dev/null || true',
      'cat /sys/fs/cgroup/memory.max 2>/dev/null || true',
      'cat /sys/fs/cgroup/memory.current 2>/dev/null || true',
      'cat /sys/fs/cgroup/pids.max 2>/dev/null || true',
      'cat /sys/fs/cgroup/pids.current 2>/dev/null || true',
    ].join('; '),
  ]);

  const baselineStats = collectAppleStats('resource-stats-baseline');
  assertAppleMemoryLimit(baselineStats, 1024 * 1024 * 1024, 'baseline');

  const cpu = innerDocker('resource-start-cpu-pressure', [
    'run',
    '-d',
    '--name',
    cpuName,
    '--label',
    innerLabel,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    helperImageId,
    '/bin/sh',
    '-c',
    'pids=\'\'; for i in 1 2 3 4 5 6 7 8; do yes >/dev/null & pids="$pids $!"; done; sleep 6; kill $pids; wait || true',
  ]);
  assertInnerSucceeded(cpu, 'bounded CPU pressure container failed to start');
  const cpuId = cpu.stdout.trim();
  assertDockerId(cpuId, 'bounded CPU pressure container');
  const cpuStats = collectAppleStats('resource-stats-during-cpu');
  assertAppleMemoryLimit(cpuStats, 1024 * 1024 * 1024, 'CPU pressure');
  assertPeerResponsive('resource-peer-during-cpu');
  assertInnerSucceeded(innerDocker('resource-wait-cpu', ['wait', cpuId]), 'CPU pressure wait failed');
  assertInnerSucceeded(innerDocker('resource-remove-cpu', ['rm', cpuId]), 'CPU pressure cleanup failed');

  const memory = innerDocker('resource-start-memory-pressure', [
    'run',
    '-d',
    '--name',
    memoryName,
    '--label',
    innerLabel,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--tmpfs',
    '/pressure:rw,nosuid,nodev,noexec,size=640m',
    helperImageId,
    '/bin/sh',
    '-c',
    'dd if=/dev/zero of=/pressure/blob bs=1M count=512 status=none; sleep 6',
  ]);
  assertInnerSucceeded(memory, 'bounded memory pressure container failed to start');
  const memoryId = memory.stdout.trim();
  assertDockerId(memoryId, 'bounded memory pressure container');
  const memoryStats = collectAppleStats('resource-stats-during-memory');
  assertAppleMemoryLimit(memoryStats, 1024 * 1024 * 1024, 'memory pressure');
  if (
    memoryStats.memoryUsageBytes === null ||
    memoryStats.memoryUsageBytes < 384 * 1024 * 1024 ||
    memoryStats.memoryUsageBytes > memoryStats.memoryLimitBytes
  ) {
    throw new ProbeFailure('Apple stats did not account bounded memory pressure inside the configured limit');
  }
  assertPeerResponsive('resource-peer-during-memory');
  assertInnerSucceeded(innerDocker('resource-wait-memory', ['wait', memoryId]), 'memory pressure wait failed');
  assertInnerSucceeded(innerDocker('resource-remove-memory', ['rm', memoryId]), 'memory pressure cleanup failed');

  const fork = innerDocker('resource-start-fork-pressure', [
    'run',
    '-d',
    '--name',
    forkName,
    '--label',
    innerLabel,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    helperImageId,
    '/bin/sh',
    '-c',
    'pids=\'\'; i=0; while [ "$i" -lt 128 ]; do sleep 6 & pids="$pids $!"; i=$((i + 1)); done; wait',
  ]);
  assertInnerSucceeded(fork, 'bounded fork pressure container failed to start');
  const forkId = fork.stdout.trim();
  assertDockerId(forkId, 'bounded fork pressure container');
  const forkStats = collectAppleStats('resource-stats-during-fork');
  assertAppleMemoryLimit(forkStats, 1024 * 1024 * 1024, 'fork pressure');
  if (forkStats.numProcesses === null || forkStats.numProcesses < 100) {
    throw new ProbeFailure('Apple stats did not account the bounded fork-pressure process set');
  }
  assertPeerResponsive('resource-peer-during-fork');
  assertInnerSucceeded(innerDocker('resource-wait-fork', ['wait', forkId]), 'fork pressure wait failed');
  assertInnerSucceeded(innerDocker('resource-remove-fork', ['rm', forkId]), 'fork pressure cleanup failed');

  const afterStats = collectAppleStats('resource-stats-after');
  assertAppleMemoryLimit(afterStats, 1024 * 1024 * 1024, 'post-pressure');
  runCommand('resource-host-responsive-after', ['sw_vers']);
  assertPeerResponsive('resource-peer-after');

  const inventory = innerDocker('resource-owned-containers', [
    'ps',
    '-a',
    '--filter',
    `label=${innerLabel}`,
    '--quiet',
  ]);
  assertInnerSucceeded(inventory, 'resource-owned container inventory failed');
  if (inventory.stdout.trim() !== '') throw new ProbeFailure('resource-owned containers remain after cleanup');
  assertInnerSucceeded(
    innerDocker('resource-remove-helper-image', ['image', 'rm', helperImageId]),
    'resource helper image cleanup failed',
  );

  writeJsonAtomic(path.join(evidenceDir, 'resource-findings.json'), {
    authoritativeEnvelope: {
      cpuOverhead: effective.configuration.resources.cpuOverhead,
      requestedCPUs: effective.configuration.resources.cpus,
      requestedMemoryBytes: effective.configuration.resources.memoryInBytes,
    },
    baselineStats,
    cpuStats,
    forkStats,
    guestPids: 'advisory-no-product-limit',
    memoryStats,
    postPressureStats: afterStats,
    runId,
    schemaVersion: SCHEMA_VERSION,
  });
}

function runDiskPrimitives() {
  const innerLabel = `com.ironcurtain.nested-spike.disk-run-id=${runId}`;
  const diskName = `ic-disk-layer-${runId}`;

  assertInnerSucceeded(
    innerDocker('disk-reload-helper-image', ['load', '--input', stagedArchiveGuestPath]),
    'disk helper image reload failed',
  );
  const helperInspect = innerDocker('disk-reinspect-helper-image', ['image', 'inspect', helperImageId]);
  assertInnerSucceeded(helperInspect, 'disk helper image is absent after reload');
  if (JSON.parse(helperInspect.stdout)[0]?.Id !== helperImageId) {
    throw new ProbeFailure('disk helper image immutable ID differs after reload');
  }

  const disk = innerDocker('disk-start-layer-pressure', [
    'run',
    '-d',
    '--name',
    diskName,
    '--label',
    innerLabel,
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    helperImageId,
    '/bin/sh',
    '-c',
    'dd if=/dev/zero of=/disk-pressure.bin bs=1M count=256 status=none; sync; touch /disk-pressure.ready; sleep 8',
  ]);
  assertInnerSucceeded(disk, 'disk pressure container failed to start');
  const diskId = disk.stdout.trim();
  assertDockerId(diskId, 'disk pressure container');
  assertInnerSucceeded(
    innerDocker('disk-wait-for-layer', [
      'exec',
      diskId,
      '/bin/sh',
      '-c',
      'i=0; until test -f /disk-pressure.ready; do i=$((i + 1)); test "$i" -lt 100 || exit 1; sleep 0.1; done',
    ]),
    'disk pressure layer did not become ready',
  );
  captureAppleDisk('during-256m-inner-layer');
  assertInnerSucceeded(innerDocker('disk-wait-layer', ['wait', diskId]), 'disk pressure wait failed');
  assertInnerSucceeded(innerDocker('disk-remove-layer', ['rm', diskId]), 'disk pressure cleanup failed');
  captureAppleDisk('after-inner-layer-removal');

  const inventory = innerDocker('disk-owned-containers', ['ps', '-a', '--filter', `label=${innerLabel}`, '--quiet']);
  assertInnerSucceeded(inventory, 'disk-owned container inventory failed');
  if (inventory.stdout.trim() !== '') throw new ProbeFailure('disk-owned containers remain after cleanup');
  assertInnerSucceeded(
    innerDocker('disk-remove-helper-image', ['image', 'rm', helperImageId]),
    'disk helper image cleanup failed',
  );
  captureAppleDisk('after-disk-image-removal');
}

function captureAppleDisk(phase, rootfsRequired = true) {
  const rootfsExists = existsSync(ownedAppleRootfsPath);
  if (rootfsRequired && !rootfsExists) {
    throw new ProbeFailure(`owned Apple sparse rootfs is absent at ${phase}`);
  }
  const filesystem = statfsSync(containerAppRoot);
  const rootfs = rootfsExists ? statSync(ownedAppleRootfsPath) : null;
  const snapshot = {
    appFilesystem: {
      availableBytes: filesystem.bavail * filesystem.bsize,
      blockSize: filesystem.bsize,
      freeBytes: filesystem.bfree * filesystem.bsize,
      totalBytes: filesystem.blocks * filesystem.bsize,
    },
    bundleExists: existsSync(ownedAppleBundlePath),
    phase,
    rootfs: rootfs
      ? {
          allocatedBytes: rootfs.blocks * 512,
          blockSize: rootfs.blksize,
          logicalBytes: rootfs.size,
        }
      : null,
    rootfsExists,
    time: new Date().toISOString(),
  };
  diskSnapshots.push(snapshot);
  runCommand(`disk-host-df-${phase}`, ['df', '-k', containerAppRoot]);
  if (snapshot.bundleExists) runCommand(`disk-host-du-${phase}`, ['du', '-sk', ownedAppleBundlePath]);
  writeJsonAtomic(path.join(evidenceDir, 'disk-findings.json'), {
    enforcement: 'observed-only-no-apple-cli-per-vm-disk-limit',
    residualRequirement: 'Phase 0F pre-daemon host watchdog and frozen state/performance budget',
    rootfsPath: ownedAppleRootfsPath,
    runId,
    schemaVersion: SCHEMA_VERSION,
    snapshots: diskSnapshots,
  });
}

function runFaultPrimitives() {
  const innerLabel = `com.ironcurtain.nested-spike.fault-run-id=${runId}`;
  const faultName = `ic-fault-workload-${runId}`;
  createBoundaryPeer();
  const findings = {
    faultMode,
    peerSurvived: false,
    runId,
    schemaVersion: SCHEMA_VERSION,
    terminalFault: false,
  };

  if (faultMode === 'workload') {
    assertInnerSucceeded(
      innerDocker('fault-reload-helper-image', ['load', '--input', stagedArchiveGuestPath]),
      'fault helper image reload failed',
    );
    const workload = innerDocker('fault-start-workload', [
      'run',
      '-d',
      '--name',
      faultName,
      '--label',
      innerLabel,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges=true',
      helperImageId,
      '/bin/sh',
      '-c',
      'while :; do sleep 3600; done',
    ]);
    assertInnerSucceeded(workload, 'fault workload failed to start');
    const workloadId = workload.stdout.trim();
    assertDockerId(workloadId, 'fault workload');
    assertInnerSucceeded(
      innerDocker('fault-kill-workload', ['kill', '--signal', 'KILL', workloadId]),
      'fault workload kill failed',
    );
    const state = innerDocker('fault-inspect-killed-workload', ['inspect', '--format', '{{json .State}}', workloadId]);
    assertInnerSucceeded(state, 'killed workload inspection failed');
    const decoded = JSON.parse(state.stdout);
    if (decoded.Running !== false || decoded.ExitCode !== 137) {
      throw new ProbeFailure(`killed workload state is not terminal SIGKILL: ${state.stdout.trim()}`);
    }
    assertInnerSucceeded(
      innerDocker('fault-remove-killed-workload', ['rm', workloadId]),
      'killed workload cleanup failed',
    );
    assertInnerSucceeded(
      innerDocker('fault-remove-helper-image', ['image', 'rm', helperImageId]),
      'fault helper image cleanup failed',
    );
    const inventory = innerDocker('fault-owned-containers', ['ps', '-a', '--filter', `label=${innerLabel}`, '--quiet']);
    assertInnerSucceeded(inventory, 'fault workload inventory failed');
    if (inventory.stdout.trim() !== '') throw new ProbeFailure('fault workload remains after cleanup');
    assertInnerSucceeded(innerDocker('fault-daemon-after-workload', ['info']), 'daemon failed after workload kill');
    findings.workloadState = decoded;
  } else if (faultMode === 'client-disconnect') {
    const disconnect = runCommand(
      'fault-client-disconnect',
      [
        'container',
        'exec',
        '--user',
        '1000:1000',
        containerId,
        '/bin/sh',
        '-c',
        `timeout 1 env DOCKER_HOST=unix://${apiSocket} docker events`,
      ],
      true,
    );
    if (disconnect.exitCode === 0) {
      throw new ProbeFailure('fault client event stream did not disconnect at the injected timeout');
    }
    assertInnerSucceeded(
      innerDocker('fault-daemon-after-client-disconnect', ['info']),
      'daemon failed after client disconnect',
    );
    findings.clientExitCode = disconnect.exitCode;
  } else if (faultMode === 'daemon') {
    const injection = runCommand(
      'fault-kill-daemon',
      [
        'container',
        'exec',
        '--user',
        '1000:1000',
        containerId,
        '/bin/sh',
        '-c',
        `pid="$(cat ${runtimeRoot}/docker.pid)"; test -n "$pid"; kill -KILL "$pid"; sleep 0.5`,
      ],
      true,
    );
    if (injection.exitCode !== 0 && injection.exitCode !== 137) {
      throw new ProbeFailure(`daemon fault injection returned unexpected exit ${injection.exitCode}`);
    }
    const api = runCommand('fault-daemon-api-must-fail', rootlessDocker(['info']), true);
    if (api.exitCode === 0) throw new ProbeFailure('Docker API remained available after daemon SIGKILL');
    const outerState = runCommand('fault-outer-state-after-daemon-kill', ['container', 'inspect', containerId], true);
    findings.apiExitCode = api.exitCode;
    findings.injectionExitCode = injection.exitCode;
    findings.outerState = outerState.exitCode === 0 ? JSON.parse(outerState.stdout)[0]?.status?.state : 'absent';
    findings.terminalFault = true;
    terminalFaultApplied = true;
  } else {
    const inspected = inspectOwned('fault-inspect-before-exact-vm-delete');
    inspectValueOwned(inspected);
    const removed = runCommand('fault-exact-vm-delete', ['container', 'delete', '--force', containerId]);
    if (removed.exitCode !== 0) throw new ProbeFailure('exact VM deletion fault failed');
    predeletedResourceIds.push(containerId);
    const absent = runCommand('fault-vm-inspect-must-fail', ['container', 'inspect', containerId], true);
    if (absent.exitCode === 0) throw new ProbeFailure('Apple VM remained after exact deletion fault');
    findings.terminalFault = true;
    findings.vmInspectExitCode = absent.exitCode;
    terminalFaultApplied = true;
  }

  assertPeerResponsive(`fault-peer-after-${faultMode}`);
  findings.peerSurvived = true;
  writeJsonAtomic(path.join(evidenceDir, 'fault-findings.json'), findings);
}

function runPathPrimitives() {
  runCommand('path-initialize-linux-node-modules', [
    'container',
    'exec',
    '--user',
    '0:0',
    containerId,
    '/bin/sh',
    '-c',
    [
      'test -d /workspace/node_modules',
      'chmod 0777 /workspace/node_modules',
      'printf linux-native-volume > /workspace/node_modules/linux-volume-marker',
      'chmod 0666 /workspace/node_modules/linux-volume-marker',
    ].join('; '),
  ]);
  runCommand('path-agent-round-trip', [
    'container',
    'exec',
    '--user',
    '1000:1000',
    containerId,
    '/bin/sh',
    '-c',
    [
      'id',
      "stat -c '%A %a %u %g %n' /workspace /workspace/seed.txt /workspace/node_modules /workspace/node_modules/linux-volume-marker",
      'cat /proc/self/mountinfo',
      'test "$(cat /workspace/seed.txt)" = workspace-seed',
      'test "$(cat /workspace/node_modules/linux-volume-marker)" = linux-native-volume',
      'test ! -e /workspace/node_modules/mac-host-marker',
      'test ! -e /workspace/mac-host-escape',
      'printf agent-round-trip > /workspace/agent-write.txt',
    ].join('; '),
  ]);
  if (readFileSync(path.join(workspaceFixtureDir, 'agent-write.txt'), 'utf8') !== 'agent-round-trip') {
    throw new ProbeFailure('agent write did not round-trip through the exact workspace mount');
  }

  assertInnerSucceeded(
    innerDocker('path-reload-helper-image', ['load', '--input', stagedArchiveGuestPath]),
    'path helper image reload failed',
  );
  const helperInspect = innerDocker('path-reinspect-helper-image', ['image', 'inspect', helperImageId]);
  assertInnerSucceeded(helperInspect, 'path helper image is absent after reload');
  if (JSON.parse(helperInspect.stdout)[0]?.Id !== helperImageId) {
    throw new ProbeFailure('path helper image immutable ID differs after reload');
  }

  assertInnerSucceeded(
    innerDocker('path-inner-recursive-workspace-bind', [
      'run',
      '--rm',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges=true',
      '--mount',
      'type=bind,src=/workspace,dst=/workspace',
      helperImageId,
      '/bin/sh',
      '-c',
      [
        'id',
        "stat -c '%A %a %u %g %n' /workspace /workspace/seed.txt /workspace/node_modules /workspace/node_modules/linux-volume-marker",
        'cat /proc/self/mountinfo',
        'test "$(cat /workspace/seed.txt)" = workspace-seed',
        'test "$(cat /workspace/agent-write.txt)" = agent-round-trip',
        'test "$(cat /workspace/node_modules/linux-volume-marker)" = linux-native-volume',
        'test ! -e /workspace/node_modules/mac-host-marker',
        'test ! -e /workspace/mac-host-escape',
        'printf inner-round-trip > /workspace/inner-write.txt',
        'printf dependency-write > /workspace/node_modules/inner-dependency.txt',
      ].join('; '),
    ]),
    'inner recursive workspace bind/path-equivalence test failed',
  );
  if (readFileSync(path.join(workspaceFixtureDir, 'inner-write.txt'), 'utf8') !== 'inner-round-trip') {
    throw new ProbeFailure('inner write did not round-trip through the exact workspace mount');
  }
  if (readFileSync(path.join(workspaceFixtureDir, 'node_modules', 'mac-host-marker'), 'utf8') !== 'must-be-hidden\n') {
    throw new ProbeFailure('Linux node_modules overlay mutated the hidden macOS marker');
  }
  runCommand('path-agent-observe-inner-writes', [
    'container',
    'exec',
    '--user',
    '1000:1000',
    containerId,
    '/bin/sh',
    '-c',
    [
      'test "$(cat /workspace/inner-write.txt)" = inner-round-trip',
      'test "$(cat /workspace/node_modules/inner-dependency.txt)" = dependency-write',
      'test ! -e /workspace/node_modules/mac-host-marker',
    ].join('; '),
  ]);
  assertInnerSucceeded(
    innerDocker('path-remove-helper-image', ['image', 'rm', helperImageId]),
    'path helper image cleanup failed',
  );

  writeJsonAtomic(path.join(evidenceDir, 'path-findings.json'), {
    innerDependencyVisibleToAgent: true,
    innerWriteRoundTrip: true,
    linuxNodeModulesVolume: nodeModulesVolume,
    macNodeModulesMarkerHidden: true,
    macSymlinkTargetAbsentInGuest: true,
    runId,
    schemaVersion: SCHEMA_VERSION,
    workspaceGuestPath: '/workspace',
    workspaceHostPath: workspaceFixtureDir,
  });
}

async function runRelayPrimitives() {
  const nestedRelaySocket = '/run/ironcurtain-relay/outer-mitm.sock';
  const request =
    "response=\"$(printf 'GET /probe HTTP/1.1\\r\\nHost: fixed.invalid\\r\\nConnection: close\\r\\n\\r\\n' | " +
    `socat -T 2 - UNIX-CONNECT:${nestedRelaySocket})\"; ` +
    'status=$?; printf \'%s\' "$response"; [ "$status" -eq 0 ] || exit "$status"; ' +
    'case "$response" in *outer-relay-ok*) exit 0;; *) exit 1;; esac';

  const guestSocket = runCommand('relay-inspect-guest-socket', [
    'container',
    'exec',
    '--user',
    '1000:1000',
    containerId,
    '/bin/sh',
    '-c',
    `test -S ${shellQuote(guestRelaySocket)} && stat -c '%F %a %u %g %n' ${shellQuote(guestRelaySocket)}`,
  ]);
  if (!guestSocket.stdout.includes(guestRelaySocket)) {
    throw new ProbeFailure('Apple fixed relay guest socket identity was not observable by the daemon user');
  }

  assertInnerSucceeded(
    innerDocker('relay-load-socat-image', ['load', '--input', stagedSocatArchiveGuestPath]),
    'nested relay socat image load failed',
  );
  const socatInspect = innerDocker('relay-inspect-socat-image', ['image', 'inspect', socatImageId]);
  assertInnerSucceeded(socatInspect, 'nested relay socat image is absent');
  if (JSON.parse(socatInspect.stdout)[0]?.Id !== socatImageId) {
    throw new ProbeFailure('nested relay socat image immutable ID differs from the staged image');
  }

  const relayRequestArgs = [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--mount',
    `type=bind,src=${guestRelaySocket},dst=${nestedRelaySocket},readonly`,
    '--entrypoint',
    '/bin/sh',
    socatImageId,
    '-c',
    request,
  ];
  const success = innerDocker('relay-child-request', relayRequestArgs);
  assertInnerSucceeded(success, 'nested child could not use the fixed relay');
  if (!success.stdout.includes('outer-relay-ok')) {
    throw new ProbeFailure('fixed relay returned the wrong response to the nested child');
  }

  await stopFixedRelay('relay-loss-test');
  const afterLoss = innerDocker('relay-child-request-after-loss-must-fail', relayRequestArgs);
  if (afterLoss.exitCode === 0) {
    throw new ProbeFailure('nested child request unexpectedly succeeded after fixed relay loss');
  }

  const relayEvents = readFileSync(relayLogFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (
    relayEvents.length !== 1 ||
    relayEvents[0]?.connection !== 1 ||
    !Number.isInteger(relayEvents[0]?.requestBytes) ||
    relayEvents[0].requestBytes <= 0
  ) {
    throw new ProbeFailure('fixed relay metadata does not prove exactly one successful request');
  }

  assertInnerSucceeded(
    innerDocker('relay-remove-socat-image', ['image', 'rm', socatImageId]),
    'relay socat image cleanup failed',
  );
  writeJsonAtomic(path.join(evidenceDir, 'relay-findings.json'), {
    afterLossExitCode: afterLoss.exitCode,
    guestSocket: guestRelaySocket,
    guestSocketIdentity: guestSocket.stdout.trim(),
    hostSocket: hostRelaySocket,
    relayEvents,
    responseMatched: true,
    runId,
    schemaVersion: SCHEMA_VERSION,
  });
}

async function stopFixedRelay(reason) {
  if (!relayProcess || relayProcessStopped) return;
  const pid = relayProcess.pid;
  let forced = false;
  if (relayProcess.exitCode === null && relayProcess.signalCode === null) {
    const gracefulExit = waitForChildExit(relayProcess, 5_000);
    if (!relayProcess.kill('SIGTERM')) throw new Error(`failed to signal exact fixed relay PID ${pid}`);
    if (!(await gracefulExit)) {
      forced = true;
      const forcedExit = waitForChildExit(relayProcess, 5_000);
      if (!relayProcess.kill('SIGKILL') || !(await forcedExit)) {
        throw new Error(`exact fixed relay PID ${pid} did not exit`);
      }
    }
  }
  relayProcessStopped = true;
  appendLedger(evidenceDir, {
    event: 'fixed-relay-stopped',
    forced,
    pid,
    reason,
    runId,
    time: new Date().toISOString(),
  });
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
    timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
  });
}

function collectAppleStats(label) {
  const record = runCommand(label, ['container', 'stats', containerId, '--format', 'json', '--no-stream']);
  const decoded = JSON.parse(record.stdout);
  const entries = Array.isArray(decoded) ? decoded : [decoded];
  const value = entries.find((entry) => entry.id === containerId);
  if (!value) throw new ProbeFailure(`${label} omitted the owned Apple VM`);
  return {
    blockReadBytes: value.blockReadBytes ?? null,
    blockWriteBytes: value.blockWriteBytes ?? null,
    cpuUsageUsec: value.cpuUsageUsec ?? null,
    id: value.id,
    memoryLimitBytes: value.memoryLimitBytes ?? null,
    memoryUsageBytes: value.memoryUsageBytes ?? null,
    numProcesses: value.numProcesses ?? null,
  };
}

function assertAppleMemoryLimit(stats, expected, phase) {
  if (stats.memoryLimitBytes !== expected) {
    throw new ProbeFailure(
      `Apple ${phase} stats memory limit ${stats.memoryLimitBytes ?? 'missing'} differs from requested ${expected}`,
    );
  }
  if (stats.memoryUsageBytes !== null && stats.memoryUsageBytes > stats.memoryLimitBytes) {
    throw new ProbeFailure(`Apple ${phase} memory usage exceeded the reported limit`);
  }
}

function assertPeerResponsive(label) {
  runCommand(label, ['container', 'exec', peerId, '/bin/sh', '-c', 'printf peer-ok']);
}

function createBoundaryPeer() {
  const argv = [
    'container',
    'create',
    '--name',
    peerName,
    '--network',
    'none',
    '--no-dns',
    '--platform',
    'linux/arm64',
    '--cpus',
    '1',
    '--memory',
    '256M',
    '--cap-drop',
    'ALL',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--init',
    '--label',
    `${ownershipLabel}=${runId}`,
    '--label',
    `${generationLabel}=${generation}`,
    '--label',
    `${roleLabel}=peer`,
    '--entrypoint',
    '/bin/sh',
    peerImage,
    '-c',
    'trap "exit 0" TERM INT; while :; do sleep 3600; done',
  ];
  appendLedger(evidenceDir, {
    argv,
    event: 'peer-intent',
    generation,
    requestedName: peerName,
    runId,
    time: new Date().toISOString(),
  });
  const created = runCommand('boundary-create-peer', argv);
  peerId = created.stdout.trim();
  if (peerId !== peerName) throw new Error(`Apple Container returned unexpected peer identity: ${peerId}`);
  appendLedger(evidenceDir, {
    event: 'peer-created',
    generation,
    requestedName: peerName,
    resourceId: peerId,
    runId,
    time: new Date().toISOString(),
  });
  assertPeerEnvelope(inspectPeerOwned('boundary-inspect-peer-created'));
  runCommand('boundary-start-peer', ['container', 'start', peerId]);
  const peer = inspectPeerOwned('boundary-inspect-peer-running');
  if (peer.status?.state !== 'running') throw new Error('unrelated Apple peer VM did not become running');
  assertPeerEnvelope(peer);
  runCommand('boundary-peer-isolation', [
    'container',
    'exec',
    peerId,
    '/bin/sh',
    '-c',
    [
      'id',
      'cat /proc/self/status',
      'ip -details link show',
      'ip route show table all',
      `test ! -e ${shellQuote(apiSocket)}`,
      `test ! -e ${shellQuote(stageRoot)}`,
      `test ! -e ${shellQuote(workspaceRoot)}`,
      'test ! -S /var/run/docker.sock',
    ].join('; '),
  ]);
}

function innerDocker(label, args) {
  const argv = rootlessDocker(args);
  appendLedger(evidenceDir, {
    argv,
    event: 'inner-command-intent',
    generation,
    label,
    runId,
    time: new Date().toISOString(),
  });
  const result = runCommand(label, argv, true);
  appendLedger(evidenceDir, {
    event: 'inner-command-result',
    exitCode: result.exitCode,
    generation,
    label,
    runId,
    time: new Date().toISOString(),
  });
  return result;
}

function assertInnerSucceeded(result, message) {
  if (result.exitCode !== 0) {
    throw new ProbeFailure(`${message}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function assertDockerId(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new ProbeFailure(`${label} returned an invalid immutable ID`);
}

async function waitForDaemon() {
  const deadline = Date.now() + 45_000;
  let lastReadiness;
  while (Date.now() < deadline) {
    const state = runCommand('readiness-inspect', ['container', 'inspect', containerId], true);
    if (state.exitCode !== 0 || JSON.parse(state.stdout)[0]?.status?.state !== 'running') break;
    lastReadiness = runCommand('daemon-readiness', rootlessDocker(['info']), true);
    if (lastReadiness.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new ProbeFailure(`rootless daemon did not become ready: ${lastReadiness?.stderr?.trim() ?? 'no response'}`);
}

function rootlessDocker(arguments_) {
  return [
    'container',
    'exec',
    '--user',
    '1000:1000',
    containerId,
    '/bin/sh',
    '-c',
    `DOCKER_HOST=unix://${apiSocket} docker ${arguments_.map(shellQuote).join(' ')}`,
  ];
}

function inspectOwned(label) {
  const result = runCommand(label, ['container', 'inspect', containerId]);
  const value = JSON.parse(result.stdout)[0];
  inspectValueOwned(value);
  return value;
}

function inspectPeerOwned(label) {
  const result = runCommand(label, ['container', 'inspect', peerId]);
  const value = JSON.parse(result.stdout)[0];
  inspectPeerValueOwned(value);
  return value;
}

function inspectOwnedVolume(label, allowFailure = false) {
  const result = runCommand(label, ['container', 'volume', 'inspect', nodeModulesVolume], allowFailure);
  if (result.exitCode !== 0) return null;
  const decoded = JSON.parse(result.stdout);
  const value = (Array.isArray(decoded) ? decoded : [decoded])[0];
  const configuration = value?.configuration ?? {};
  const labels = configuration.labels ?? {};
  if (
    value?.id !== nodeModulesVolume ||
    configuration.name !== nodeModulesVolume ||
    configuration.driver !== 'local' ||
    configuration.format !== 'ext4' ||
    configuration.sizeInBytes !== 256 * 1024 * 1024 ||
    labels[ownershipLabel] !== runId ||
    labels[generationLabel] !== String(generation) ||
    labels[roleLabel] !== 'node-modules'
  ) {
    throw new Error('refusing operation: Apple node_modules volume identity/envelope mismatch');
  }
  return value;
}

function inspectValueOwned(value) {
  if (value?.id !== containerId || value?.configuration?.id !== requestedName) {
    throw new Error('Apple container immutable identity mismatch');
  }
  const labels = value.configuration?.labels ?? {};
  if (labels[ownershipLabel] !== runId || labels[generationLabel] !== String(generation)) {
    throw new Error('refusing operation: Apple container ownership/generation mismatch');
  }
  if (labels[roleLabel] !== 'daemon') throw new Error('Apple daemon role label mismatch');
}

function inspectPeerValueOwned(value) {
  if (value?.id !== peerId || value?.configuration?.id !== peerName) {
    throw new Error('Apple peer immutable identity mismatch');
  }
  const labels = value.configuration?.labels ?? {};
  if (
    labels[ownershipLabel] !== runId ||
    labels[generationLabel] !== String(generation) ||
    labels[roleLabel] !== 'peer'
  ) {
    throw new Error('refusing operation: Apple peer ownership/generation/role mismatch');
  }
}

function assertEffectiveEnvelope(value) {
  const configuration = value.configuration ?? {};
  const caps = [...(configuration.capAdd ?? [])].sort();
  const virtiofsMounts = (configuration.mounts ?? []).filter((mount) => mount.type?.virtiofs !== undefined);
  const stagingMount = virtiofsMounts.find(
    (mount) => mount.source === stagingDir && mount.destination === stageRoot && mount.options?.includes('ro'),
  );
  const workspaceMount = virtiofsMounts.find(
    (mount) => mount.source === workspaceFixtureDir && mount.destination === '/workspace',
  );
  const nodeModulesMount = (configuration.mounts ?? []).find(
    (mount) =>
      mount.destination === '/workspace/node_modules' && JSON.stringify(mount.type ?? {}).includes(nodeModulesVolume),
  );
  const fixedRelayMount = virtiofsMounts.find(
    (mount) =>
      mount.source === hostRelaySocket && mount.destination === guestRelaySocket && mount.options?.includes('ro'),
  );
  const expectedVirtiofs =
    needsStaging &&
    stagingMount !== undefined &&
    (probe === 'path'
      ? virtiofsMounts.length === 2 && workspaceMount !== undefined && nodeModulesMount !== undefined
      : probe === 'relay'
        ? virtiofsMounts.length === 2 && fixedRelayMount !== undefined
        : virtiofsMounts.length === 1);
  const publishedSockets = configuration.publishedSockets ?? [];
  if (
    JSON.stringify(configuration.capDrop ?? []) !== JSON.stringify(['ALL']) ||
    JSON.stringify(caps) !== JSON.stringify(['CAP_SETGID', 'CAP_SETUID']) ||
    configuration.networks?.length !== 0 ||
    configuration.resources?.cpus !== 2 ||
    configuration.resources?.memoryInBytes !== 1024 * 1024 * 1024 ||
    (needsStaging ? !expectedVirtiofs : virtiofsMounts.length !== 0) ||
    publishedSockets.length !== 0 ||
    (configuration.publishedPorts ?? []).length !== 0 ||
    configuration.ssh !== false
  ) {
    throw new Error('Apple rootless daemon effective envelope differs from the requested isolated VM');
  }
}

function assertPeerEnvelope(value) {
  const configuration = value.configuration ?? {};
  const virtiofsMounts = (configuration.mounts ?? []).filter((mount) => mount.type?.virtiofs !== undefined);
  if (
    JSON.stringify(configuration.capDrop ?? []) !== JSON.stringify(['ALL']) ||
    (configuration.capAdd ?? []).length !== 0 ||
    configuration.networks?.length !== 0 ||
    configuration.resources?.cpus !== 1 ||
    configuration.resources?.memoryInBytes !== 256 * 1024 * 1024 ||
    virtiofsMounts.length !== 0 ||
    (configuration.publishedPorts ?? []).length !== 0 ||
    (configuration.publishedSockets ?? []).length !== 0 ||
    configuration.ssh !== false
  ) {
    throw new Error('Apple peer effective envelope differs from the requested isolated VM');
  }
}

async function cleanup(reason) {
  if (cleaning) return;
  cleaning = true;
  const deleted = [...predeletedResourceIds];
  const deletedVolumes = [];
  try {
    for (const [resourceId, role] of [
      [peerId, 'peer'],
      [containerId, 'daemon'],
    ]) {
      if (!resourceId) continue;
      const inspected = runCommand(`cleanup-inspect-${role}`, ['container', 'inspect', resourceId], true);
      if (inspected.exitCode === 0) {
        const value = JSON.parse(inspected.stdout)[0];
        if (role === 'peer') inspectPeerValueOwned(value);
        else inspectValueOwned(value);
        const removed = runCommand(`cleanup-delete-${role}`, ['container', 'delete', '--force', resourceId], true);
        if (removed.exitCode !== 0) throw new Error(`exact cleanup failed: ${removed.stderr.trim()}`);
        deleted.push(resourceId);
      }
    }
    if (nodeModulesVolumeCreated) {
      const volume = inspectOwnedVolume('cleanup-inspect-node-modules-volume', true);
      if (volume !== null) {
        const removed = runCommand(
          'cleanup-delete-node-modules-volume',
          ['container', 'volume', 'delete', nodeModulesVolume],
          true,
        );
        if (removed.exitCode !== 0) throw new Error(`exact volume cleanup failed: ${removed.stderr.trim()}`);
        deletedVolumes.push(nodeModulesVolume);
      }
    }
    await stopFixedRelay('probe-cleanup');
    if (probe === 'disk') captureAppleDisk('after-exact-vm-delete', false);
    for (const ordinal of [1, 2]) {
      const inventory = collectCleanupInventory(ordinal);
      writeJsonAtomic(path.join(evidenceDir, 'cleanup', `inventory-${ordinal}.json`), inventory);
      if (inventory.containers.length !== 0 || inventory.volumes.length !== 0) {
        throw new Error(`cleanup inventory ${ordinal} is not empty`);
      }
    }
    if (probe === 'path' && existsSync(workspaceFixtureDir)) {
      if (
        path.dirname(workspaceFixtureDir) !== workspaceFixtureParent ||
        path.basename(workspaceFixtureDir) !== runId
      ) {
        throw new Error('refusing to delete unresolved workspace fixture path');
      }
      rmSync(workspaceFixtureDir, { recursive: true });
      workspaceFixtureDeleted = true;
    }
    if (probe === 'relay' && existsSync(relayFixtureDir)) {
      if (path.dirname(relayFixtureDir) !== relayFixtureParent || path.basename(relayFixtureDir) !== runId) {
        throw new Error('refusing to delete unresolved relay fixture path');
      }
      rmSync(relayFixtureDir, { recursive: true });
      relayFixtureDeleted = true;
    }
    runCommand('apple-container-canaries-after', ['container', 'list', '--all', '--quiet']);
    runCommand('docker-canaries-after', ['docker', 'ps', '-a', '--format', '{{.ID}}']);
    writeJsonAtomic(path.join(evidenceDir, 'cleanup-result.json'), {
      deletedResourceIds: deleted,
      deletedVolumeNames: deletedVolumes,
      relayFixtureDeleted,
      relayProcessStopped,
      workspaceFixtureDeleted,
      reason,
      runId,
      schemaVersion: SCHEMA_VERSION,
      status: 'complete',
    });
  } catch (error) {
    writeJsonAtomic(path.join(evidenceDir, 'cleanup-result.json'), {
      deletedResourceIds: deleted,
      deletedVolumeNames: deletedVolumes,
      relayFixtureDeleted,
      relayProcessStopped,
      workspaceFixtureDeleted,
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

function collectCleanupInventory(ordinal) {
  const list = runCommand(`cleanup-inventory-${ordinal}-containers`, ['container', 'list', '--all', '--quiet']);
  const containers = list.stdout
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value === requestedName || value === peerName);
  const volumeList = runCommand(`cleanup-inventory-${ordinal}-volumes`, ['container', 'volume', 'list', '--quiet']);
  const volumes = volumeList.stdout
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value === nodeModulesVolume);
  return { containers, ordinal, runId, schemaVersion: SCHEMA_VERSION, volumes };
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
    hypothesis:
      probe === 'relay'
        ? 'AC-H3 fixed per-file Apple UDS/vsock relay and fail-closed loss primitives'
        : probe === 'path'
          ? 'AC-H4 exact workspace path, recursive inner bind, and Linux node_modules overlay primitives'
          : probe === 'fault'
            ? `Apple ${faultMode} fault containment and exact-cleanup primitives`
            : probe === 'disk'
              ? 'AC-H6 Apple sparse-rootfs growth observation and exact-deletion primitives'
              : probe === 'resource'
                ? 'AC-H5 Apple VM CPU, memory, advisory-PID, peer-survival, and accounting primitives'
                : probe === 'boundary'
                  ? 'AC-H3 Apple VM boundary, host-vsock, and nested-publication primitives'
                  : probe === 'functional'
                    ? 'AC-H1 rootless Docker functional primitives with vfs and a VM-private UDS'
                    : 'AC-H1 rootless Docker daemon boot with vfs and a VM-private UDS',
    requestedName,
    runId,
    schemaVersion: SCHEMA_VERSION,
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
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
