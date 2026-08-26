#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
const runId = parsed['run-id'] ?? `dd-h2-${utcStamp()}-${randomBytes(4).toString('hex')}`;
const evidenceDir = path.resolve(parsed['evidence-dir'] ?? path.join(os.tmpdir(), 'ic-secure-nested-phase0b', runId));
const probe = (parsed.probe ?? 'private-api').toLowerCase();
if (!['functional', 'private-api'].includes(probe)) {
  throw new Error('--probe must be functional or private-api');
}
const systempathsUnconfined = parsed['systempaths-unconfined'] === 'true';
const daemonImage =
  parsed['daemon-image'] ?? 'docker@sha256:67c4114553192e9072969fc347426048cfe4192385dc762d8eb449c05e904255';
const helperImage =
  parsed['helper-image'] ?? 'alpine@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b';
const helperImageId = 'sha256:1991bd789d7184290c3cce84fd6af068b8b745e9bddf178661ce7f5ecf68135c';
const ceiling = JSON.parse(
  readFileSync(path.join(workspaceRoot, 'config/docker-workload/profile-ceiling.json'), 'utf8'),
);
const profileRelativePath = ceiling.categories?.seccomp?.artifact?.path;
const expectedProfileHash = ceiling.categories?.seccomp?.artifact?.sha256;
const profilePath = path.resolve(workspaceRoot, profileRelativePath);
const profileHash = sha256File(profilePath);

if (!/^[a-f0-9]{64}$/.test(expectedProfileHash ?? '') || profileHash !== expectedProfileHash) {
  throw new Error(
    `P2 seccomp artifact hash mismatch: expected ${expectedProfileHash}, received ${profileHash} at ${profilePath}`,
  );
}

const generation = 1;
const ownershipLabel = `com.ironcurtain.nested-spike.run-id=${runId}`;
const generationLabel = `com.ironcurtain.nested-spike.generation=${generation}`;
const apiVolumeName = `ic-nested-api-${runId}`;
const stageVolumeName = `ic-nested-stage-${runId}`;
const apiRoot = '/run/ironcurtain-docker';
const apiSocket = `${apiRoot}/docker.sock`;
const stageRoot = '/run/ironcurtain-staged';
const stagingDir = path.join(evidenceDir, 'staging');
const stagedArchiveHostPath = path.join(stagingDir, 'alpine.tar');
const stagedArchiveGuestPath = `${stageRoot}/alpine.tar`;
const runtimeShimSourcePath = path.join(workspaceRoot, 'docker/nested-daemon/runtime-shim/main.go');
const runtimeShimHostPath = path.join(stagingDir, 'runc');
const runtimeShimGuestPath = `${stageRoot}/runc`;
const requestedNames = {
  authorized: `ic-nested-spike-${runId}-authorized`,
  daemon: `ic-nested-spike-${runId}-daemon`,
  init: `ic-nested-spike-${runId}-init`,
  unauthorized: `ic-nested-spike-${runId}-unauthorized`,
};

assertRunId(runId);
assertOutsideWorkspace(evidenceDir, workspaceRoot);
ensurePrivateDirectory(evidenceDir, true);
ensurePrivateDirectory(path.join(evidenceDir, 'commands'));
ensurePrivateDirectory(path.join(evidenceDir, 'cleanup'));

writeJsonAtomic(path.join(evidenceDir, 'run.json'), {
  apiRoot,
  apiVolumeName,
  daemonImage,
  generation,
  helperImage,
  phase: probe === 'functional' ? '0B-DD-H3-FUNCTIONAL' : '0B-DD-H2-PRIVATE-API',
  probe,
  profileHash,
  requestedNames,
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
  runId,
  time: new Date().toISOString(),
});

let sequence = 0;
let cleaning = false;
let probeExit = 1;
let apiVolumeCreated = false;
let stageVolumeCreated = false;
const resources = [];
const deletedResourceIds = [];
const anonymousVolumes = new Set();

process.on('SIGINT', () => {
  void cleanup('SIGINT').finally(() => process.exit(130));
});
process.on('SIGTERM', () => {
  void cleanup('SIGTERM').finally(() => process.exit(143));
});

try {
  recordHostBaseline();
  if (probe === 'functional') {
    prepareStagedImage();
    createStageVolume();
  }
  createApiVolume();
  initializeApiVolume();
  const daemon = createDaemon();
  startContainer(daemon);
  const daemonReady = waitForDaemon(daemon.id);
  if (!daemonReady) throw new ProbeFailure('rootless daemon did not become ready through the shared API root');
  if (probe === 'functional') {
    runCommand('runtime-shim-version', ['docker', 'exec', daemon.id, runtimeShimGuestPath, '--version']);
    const defaultRuntime = runCommand('daemon-default-runtime', [
      'docker',
      'exec',
      '--env',
      `DOCKER_HOST=unix://${apiSocket}`,
      daemon.id,
      'docker',
      'info',
      '--format',
      '{{.DefaultRuntime}}',
    ]);
    if (defaultRuntime.stdout.trim() !== 'ic-no-new-keyring') {
      throw new ProbeFailure('nested daemon did not select the trusted no-new-keyring runtime shim');
    }
  }

  const authorized = createClient('authorized', true);
  const unauthorized = createClient('unauthorized', false);
  startContainer(authorized);
  startContainer(unauthorized);
  waitForRunning(authorized.id, 'authorized');
  waitForRunning(unauthorized.id, 'unauthorized');

  const authorizedConnect = runCommand(
    'authorized-connect',
    ['docker', 'exec', authorized.id, '/bin/sh', '-c', `DOCKER_HOST=unix://${apiSocket} docker version`],
    true,
  );
  const authorizedReadOnly = runCommand(
    'authorized-read-only-root',
    ['docker', 'exec', authorized.id, '/bin/sh', '-c', `test -S ${apiSocket}; ! touch ${apiRoot}/write-must-fail`],
    true,
  );
  const unauthorizedAbsence = runCommand(
    'unauthorized-socket-absence',
    ['docker', 'exec', unauthorized.id, '/bin/sh', '-c', `test ! -e ${apiSocket}`],
    true,
  );
  const unauthorizedConnect = runCommand(
    'unauthorized-connect-must-fail',
    ['docker', 'exec', unauthorized.id, '/bin/sh', '-c', `DOCKER_HOST=unix://${apiSocket} docker version`],
    true,
  );

  if (
    authorizedConnect.exitCode !== 0 ||
    authorizedReadOnly.exitCode !== 0 ||
    unauthorizedAbsence.exitCode !== 0 ||
    unauthorizedConnect.exitCode === 0
  ) {
    throw new ProbeFailure('private API positive or negative assertion failed');
  }

  runCommand('daemon-socket-and-listeners', [
    'docker',
    'exec',
    daemon.id,
    '/bin/sh',
    '-c',
    `stat -c '%A %a %u %g %n' ${apiRoot} ${apiSocket}; (ss -lntup || true)`,
  ]);
  if (probe === 'functional') runFunctionalPrimitives(daemon);
  writeSummary('supported', undefined);
  probeExit = 0;
} catch (error) {
  const daemon = resources.find((resource) => resource.role === 'daemon' && !resource.removed);
  if (daemon) runCommand('failure-daemon-logs', ['docker', 'logs', daemon.id], true);
  const classification = error instanceof ProbeFailure ? 'falsified' : 'blocked-by-harness-or-runtime-error';
  writeSummary(classification, error.message);
} finally {
  await cleanup('normal-or-error');
}

function recordHostBaseline() {
  runCommand('host-sw-vers', ['sw_vers']);
  runCommand('host-uname', ['uname', '-a']);
  runCommand('docker-version', ['docker', 'version']);
  runCommand('docker-info', ['docker', 'info']);
  runCommand('daemon-image-inspect', ['docker', 'image', 'inspect', daemonImage]);
  const helperInspect = runCommand('helper-image-inspect', ['docker', 'image', 'inspect', helperImage]);
  if (JSON.parse(helperInspect.stdout)[0]?.Id !== helperImageId) {
    throw new Error('staged helper image ID does not match the pinned arm64 image ID');
  }
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
  runCommand('save-staged-image', ['docker', 'image', 'save', '--output', stagedArchiveHostPath, helperImage]);
  chmodSync(stagedArchiveHostPath, 0o600);
  appendLedger(evidenceDir, {
    event: 'artifact-intent',
    generation,
    path: 'staging/runc',
    runId,
    source: path.relative(workspaceRoot, runtimeShimSourcePath),
    time: new Date().toISOString(),
  });
  const goVersion = runCommand('runtime-shim-go-version', ['go', 'version']);
  runCommand('build-runtime-shim', [
    'env',
    'CGO_ENABLED=0',
    'GOOS=linux',
    'GOARCH=arm64',
    'go',
    'build',
    '-trimpath',
    '-ldflags=-s -w',
    '-o',
    runtimeShimHostPath,
    runtimeShimSourcePath,
  ]);
  chmodSync(runtimeShimHostPath, 0o500);
  const dockerfile = [
    'FROM alpine:latest',
    'COPY payload.txt /ironcurtain-offline-payload.txt',
    'RUN test "$(cat /ironcurtain-offline-payload.txt)" = "offline-build-ok"',
    'CMD ["cat", "/ironcurtain-offline-payload.txt"]',
    '',
  ].join('\n');
  writeFileSync(path.join(stagingDir, 'Dockerfile'), dockerfile, { mode: 0o600, flag: 'wx' });
  writeFileSync(path.join(stagingDir, 'payload.txt'), 'offline-build-ok\n', { mode: 0o600, flag: 'wx' });
  writeFileSync(path.join(stagingDir, '.dockerignore'), 'alpine.tar\nrunc\n', {
    mode: 0o600,
    flag: 'wx',
  });
  const archiveStat = statSync(stagedArchiveHostPath);
  writeJsonAtomic(path.join(evidenceDir, 'staged-image.json'), {
    archivePath: 'staging/alpine.tar',
    archiveSha256: sha256File(stagedArchiveHostPath),
    archiveSize: archiveStat.size,
    buildContext: ['staging/.dockerignore', 'staging/Dockerfile', 'staging/payload.txt'],
    runId,
    schemaVersion: SCHEMA_VERSION,
    source: helperImage,
  });
  writeJsonAtomic(path.join(evidenceDir, 'runtime-shim.json'), {
    binaryPath: 'staging/runc',
    binarySha256: sha256File(runtimeShimHostPath),
    build: {
      cgoEnabled: false,
      goarch: 'arm64',
      goos: 'linux',
      version: goVersion.stdout.trim(),
    },
    injectedCreateArgument: '--no-new-keyring',
    realRunc: '/usr/local/bin/runc',
    runId,
    schemaVersion: SCHEMA_VERSION,
    sourcePath: path.relative(workspaceRoot, runtimeShimSourcePath),
    sourceSha256: sha256File(runtimeShimSourcePath),
  });
}

function createStageVolume() {
  const argv = ['docker', 'volume', 'create', '--label', ownershipLabel, '--label', generationLabel, stageVolumeName];
  appendIntent('stage-volume', stageVolumeName, argv, { access: 'daemon-ro', path: stageRoot });
  const created = runCommand('create-stage-volume', argv);
  if (created.stdout.trim() !== stageVolumeName) throw new Error('Docker returned an unexpected stage volume identity');
  stageVolumeCreated = true;
  appendCreated('stage-volume', stageVolumeName, stageVolumeName);
  const inspected = runCommand('inspect-stage-volume', ['docker', 'volume', 'inspect', stageVolumeName]);
  assertOwnedVolume(JSON.parse(inspected.stdout)[0], stageVolumeName);
}

function createApiVolume() {
  const argv = ['docker', 'volume', 'create', '--label', ownershipLabel, '--label', generationLabel, apiVolumeName];
  appendIntent('api-volume', apiVolumeName, argv, { access: 'daemon-rw-agent-ro', path: apiRoot });
  const created = runCommand('create-api-volume', argv);
  if (created.stdout.trim() !== apiVolumeName) throw new Error('Docker returned an unexpected API volume identity');
  apiVolumeCreated = true;
  appendCreated('api-volume', apiVolumeName, apiVolumeName);
  const inspected = runCommand('inspect-api-volume', ['docker', 'volume', 'inspect', apiVolumeName]);
  assertOwnedVolume(JSON.parse(inspected.stdout)[0], apiVolumeName);
}

function initializeApiVolume() {
  const initCommand =
    probe === 'functional'
      ? 'chmod 0700 /api && chown 1000:1000 /api && chown 0:0 /staged/.dockerignore /staged/alpine.tar /staged/Dockerfile /staged/payload.txt /staged/runc && chmod 0444 /staged/.dockerignore /staged/alpine.tar /staged/Dockerfile /staged/payload.txt && chmod 0555 /staged/runc'
      : 'chmod 0700 /api && chown 1000:1000 /api';
  const init = createTrackedContainer('init', [
    'docker',
    'create',
    '--name',
    requestedNames.init,
    '--label',
    ownershipLabel,
    '--label',
    generationLabel,
    '--network',
    'none',
    '--user',
    '0:0',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'CHOWN',
    '--security-opt',
    'no-new-privileges=true',
    '--read-only',
    '--pids-limit',
    '32',
    '--memory',
    '64m',
    '--cpus',
    '0.25',
    '--mount',
    `type=volume,src=${apiVolumeName},dst=/api,volume-nocopy`,
    ...(probe === 'functional' ? ['--mount', `type=volume,src=${stageVolumeName},dst=/staged,volume-nocopy`] : []),
    '--entrypoint',
    '/bin/sh',
    helperImage,
    '-c',
    initCommand,
  ]);
  if (probe === 'functional') {
    runCommand('copy-staged-artifacts', ['docker', 'cp', `${stagingDir}/.`, `${init.id}:/staged`]);
  }
  startContainer(init);
  const waited = runCommand('wait-init', ['docker', 'wait', init.id]);
  if (waited.stdout.trim() !== '0') {
    runCommand('init-logs', ['docker', 'logs', init.id], true);
    throw new Error(`API volume initializer failed with ${waited.stdout.trim()}`);
  }
  removeTrackedContainer(init, 'remove-init');
}

function createDaemon() {
  return createTrackedContainer('daemon', [
    'docker',
    'create',
    '--name',
    requestedNames.daemon,
    '--label',
    ownershipLabel,
    '--label',
    generationLabel,
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'SETUID',
    '--cap-add',
    'SETGID',
    '--security-opt',
    `seccomp=${profilePath}`,
    ...(systempathsUnconfined ? ['--security-opt', 'systempaths=unconfined'] : []),
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
    '--tmpfs',
    '/home/rootless/.docker:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000',
    '--mount',
    `type=volume,src=${apiVolumeName},dst=${apiRoot},volume-nocopy`,
    ...(probe === 'functional'
      ? ['--mount', `type=volume,src=${stageVolumeName},dst=${stageRoot},readonly,volume-nocopy`]
      : []),
    '--env',
    'DOCKER_TLS_CERTDIR=',
    '--env',
    'DOCKERD_ROOTLESS_ROOTLESSKIT_NET=none',
    '--env',
    `XDG_RUNTIME_DIR=${apiRoot}`,
    '--env',
    `PATH=${stageRoot}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    daemonImage,
    'dockerd',
    ...(probe === 'functional' ? ['--debug'] : []),
    ...(probe === 'functional'
      ? [`--add-runtime=ic-no-new-keyring=${runtimeShimGuestPath}`, '--default-runtime=ic-no-new-keyring']
      : []),
    `--host=unix://${apiSocket}`,
    '--storage-driver=vfs',
    '--data-root=/home/rootless/.local/share/docker',
    `--exec-root=${apiRoot}/exec`,
    `--pidfile=${apiRoot}/docker.pid`,
    '--iptables=false',
    '--bridge=none',
    '--ip-forward=false',
    '--ip-masq=false',
  ]);
}

function createClient(role, mountApi) {
  const argv = [
    'docker',
    'create',
    '--name',
    requestedNames[role],
    '--label',
    ownershipLabel,
    '--label',
    generationLabel,
    '--network',
    'none',
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--read-only',
    '--pids-limit',
    '32',
    '--memory',
    '128m',
    '--cpus',
    '0.25',
    '--tmpfs',
    '/run:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000',
    ...(mountApi ? ['--mount', `type=volume,src=${apiVolumeName},dst=${apiRoot},readonly,volume-nocopy`] : []),
    '--entrypoint',
    '/bin/sh',
    daemonImage,
    '-c',
    'trap "exit 0" TERM INT; while :; do sleep 3600; done',
  ];
  return createTrackedContainer(role, argv);
}

function runFunctionalPrimitives(daemon) {
  const innerLabel = `com.ironcurtain.nested-spike.inner-run-id=${runId}`;
  const mainName = `ic-h3-main-${runId}`;
  const volumeName = `ic-h3-volume-${runId}`;
  const networkName = `ic-h3-network-${runId}`;
  const serverName = `ic-h3-target-${runId}`;
  const scannerName = `ic-h3-scanner-${runId}`;
  const builtTag = `ic-h3-offline:${runId}`;

  assertInnerSucceeded(
    innerDocker(daemon, 'inner-load-staged-image', ['load', '--input', stagedArchiveGuestPath]),
    'nested docker load failed',
  );
  const loadedInspect = innerDocker(daemon, 'inner-inspect-loaded-image', ['image', 'inspect', helperImageId]);
  assertInnerSucceeded(loadedInspect, 'loaded image ID is absent');
  if (JSON.parse(loadedInspect.stdout)[0]?.Id !== helperImageId) {
    throw new ProbeFailure('loaded image immutable ID differs from the staged image');
  }
  assertInnerSucceeded(
    innerDocker(daemon, 'inner-tag-loaded-image', ['image', 'tag', helperImageId, 'alpine:latest']),
    'loaded image could not be tagged for the offline build',
  );

  const main = innerDocker(daemon, 'inner-run-main', [
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
  if (!/^[a-f0-9]{64}$/.test(mainId)) throw new ProbeFailure('nested docker run returned an invalid ID');
  assertInnerSucceeded(
    innerDocker(daemon, 'inner-exec-main', [
      'exec',
      mainId,
      '/bin/sh',
      '-c',
      'printf functional-ok > /tmp/marker && test "$(cat /tmp/marker)" = functional-ok',
    ]),
    'nested docker exec failed',
  );

  const bind = innerDocker(daemon, 'inner-bind-read-only', [
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
  ]);
  assertInnerSucceeded(bind, 'nested read-only bind mount failed');

  assertInnerSucceeded(
    innerDocker(daemon, 'inner-create-volume', ['volume', 'create', '--label', innerLabel, volumeName]),
    'nested volume create failed',
  );
  assertInnerSucceeded(
    innerDocker(daemon, 'inner-use-volume', [
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
    innerDocker(daemon, 'inner-offline-build', [
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
  const builtRun = innerDocker(daemon, 'inner-run-built-image', ['run', '--rm', '--network', 'none', builtTag]);
  assertInnerSucceeded(builtRun, 'nested offline-built image failed to run');
  if (builtRun.stdout.trim() !== 'offline-build-ok') {
    throw new ProbeFailure('nested offline-built image returned the wrong payload');
  }

  const network = innerDocker(daemon, 'inner-create-network', [
    'network',
    'create',
    '--internal',
    '--label',
    innerLabel,
    networkName,
  ]);
  assertInnerSucceeded(network, 'nested internal network create failed');
  const networkId = network.stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(networkId)) throw new ProbeFailure('nested network create returned an invalid ID');

  const server = innerDocker(daemon, 'inner-start-target', [
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
    '--tmpfs',
    '/www:rw,nosuid,nodev,noexec,size=8m',
    helperImageId,
    '/bin/sh',
    '-c',
    "while :; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 17\\r\\nConnection: close\\r\\n\\r\\nvulnerable-marker' | nc -l -p 8080; done",
  ]);
  assertInnerSucceeded(server, 'nested target start failed');
  const serverId = server.stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(serverId)) throw new ProbeFailure('nested target returned an invalid ID');

  const serverRunning = innerDocker(daemon, 'inner-target-readiness', [
    'inspect',
    '--format',
    '{{.State.Running}}',
    serverId,
  ]);
  assertInnerSucceeded(serverRunning, 'nested target readiness inspect failed');
  if (serverRunning.stdout.trim() !== 'true') {
    const serverLogs = innerDocker(daemon, 'inner-target-failed-logs', ['logs', serverId]);
    throw new ProbeFailure(`nested target exited before readiness: ${serverLogs.stderr || serverLogs.stdout}`);
  }

  assertInnerSucceeded(
    innerDocker(daemon, 'inner-run-scanner', [
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
      'for i in 1 2 3 4 5; do body="$(wget -qO- http://target:8080 2>/dev/null || true)"; [ "$body" = vulnerable-marker ] && exit 0; sleep 1; done; exit 1',
    ]),
    'nested target/scanner exchange failed',
  );

  const pull = innerDocker(daemon, 'inner-pull-must-fail', ['pull', 'alpine:3.19']);
  if (pull.exitCode === 0) throw new ProbeFailure('nested registry pull unexpectedly succeeded');
  const registryDns = innerDocker(daemon, 'inner-registry-dns-must-fail', [
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
  const registryIp = innerDocker(daemon, 'inner-registry-ip-must-fail', [
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

  assertInnerSucceeded(
    innerDocker(daemon, 'inner-remove-target', ['rm', '-f', serverId]),
    'nested target cleanup failed',
  );
  assertInnerSucceeded(innerDocker(daemon, 'inner-remove-main', ['rm', '-f', mainId]), 'nested main cleanup failed');
  assertInnerSucceeded(
    innerDocker(daemon, 'inner-remove-network', ['network', 'rm', networkId]),
    'nested network cleanup failed',
  );
  assertInnerSucceeded(
    innerDocker(daemon, 'inner-remove-volume', ['volume', 'rm', volumeName]),
    'nested volume cleanup failed',
  );
  assertInnerSucceeded(
    innerDocker(daemon, 'inner-remove-built-image', ['image', 'rm', builtTag]),
    'built image cleanup failed',
  );

  const innerInventory = innerDocker(daemon, 'inner-owned-inventory', ['system', 'df', '--format', '{{json .}}']);
  assertInnerSucceeded(innerInventory, 'nested final inventory failed');
  for (const [label, args] of [
    ['inner-owned-containers', ['ps', '-a', '--filter', `label=${innerLabel}`, '--quiet']],
    ['inner-owned-volumes', ['volume', 'ls', '--filter', `label=${innerLabel}`, '--quiet']],
    ['inner-owned-networks', ['network', 'ls', '--filter', `label=${innerLabel}`, '--quiet']],
    ['inner-owned-images', ['image', 'ls', '--filter', `label=${innerLabel}`, '--quiet']],
  ]) {
    const inventory = innerDocker(daemon, label, args);
    assertInnerSucceeded(inventory, `${label} failed`);
    if (inventory.stdout.trim() !== '') throw new ProbeFailure(`${label} is not empty after nested cleanup`);
  }
  runCommand('functional-daemon-logs', ['docker', 'logs', daemon.id], true);
}

function innerDocker(daemon, label, args) {
  const argv = ['docker', 'exec', '--env', `DOCKER_HOST=unix://${apiSocket}`, daemon.id, 'docker', ...args];
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
    stdoutIdentity: /^[a-f0-9]{64}$/.test(result.stdout.trim()) ? result.stdout.trim() : null,
    time: new Date().toISOString(),
  });
  return result;
}

function assertInnerSucceeded(result, message) {
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 500);
    throw new ProbeFailure(`${message}: ${detail}`);
  }
}

function createTrackedContainer(role, argv) {
  const requestedName = requestedNames[role];
  appendIntent(role, requestedName, argv, { profileHash, role });
  const created = runCommand(`create-${role}`, argv);
  const id = created.stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`Docker returned an invalid ${role} container ID`);
  const resource = { anonymousVolumes: [], id, removed: false, requestedName, role };
  resources.push(resource);
  appendCreated(role, requestedName, id);
  const inspected = runCommand(`inspect-${role}`, ['docker', 'inspect', id]);
  const inspectValue = JSON.parse(inspected.stdout)[0];
  assertOwnedContainer(inspectValue, resource);
  resource.anonymousVolumes = (inspectValue.Mounts ?? [])
    .filter((mount) => mount.Type === 'volume' && mount.Name !== apiVolumeName)
    .map((mount) => mount.Name)
    .sort();
  for (const volume of resource.anonymousVolumes) anonymousVolumes.add(volume);
  return resource;
}

function startContainer(resource) {
  const started = runCommand(`start-${resource.role}`, ['docker', 'start', resource.id]);
  if (started.exitCode !== 0) throw new Error(`cannot start ${resource.role}`);
}

function waitForRunning(id, role) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = runCommand(`${role}-running`, ['docker', 'inspect', '--format', '{{.State.Running}}', id], true);
    if (state.exitCode === 0 && state.stdout.trim() === 'true') return;
    sleep(100);
  }
  throw new Error(`${role} did not become running`);
}

function waitForDaemon(id) {
  const deadline = Date.now() + 20_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const state = runCommand(`daemon-state-${attempt}`, ['docker', 'inspect', '--format', '{{json .State}}', id], true);
    if (state.exitCode !== 0) break;
    const stateValue = JSON.parse(state.stdout);
    if (!stateValue.Running) break;
    const readiness = runCommand(
      `daemon-readiness-${attempt}`,
      ['docker', 'exec', id, '/bin/sh', '-c', `DOCKER_HOST=unix://${apiSocket} docker info`],
      true,
    );
    if (readiness.exitCode === 0) {
      runCommand('daemon-version', [
        'docker',
        'exec',
        id,
        '/bin/sh',
        '-c',
        `DOCKER_HOST=unix://${apiSocket} docker version`,
      ]);
      runCommand('daemon-outer-inspect', ['docker', 'inspect', id]);
      return true;
    }
    sleep(250);
  }
  runCommand('daemon-logs', ['docker', 'logs', id], true);
  return false;
}

function appendIntent(role, requestedName, argv, specification) {
  appendLedger(evidenceDir, {
    argv,
    event: 'intent',
    generation,
    requestedName,
    resourceType: role.endsWith('-volume') ? 'volume' : 'container',
    role,
    runId,
    specification,
    time: new Date().toISOString(),
  });
}

function appendCreated(role, requestedName, resourceId) {
  appendLedger(evidenceDir, {
    event: 'created',
    generation,
    requestedName,
    resourceId,
    resourceType: role.endsWith('-volume') ? 'volume' : 'container',
    role,
    runId,
    time: new Date().toISOString(),
  });
}

function writeSummary(classification, error) {
  writeJsonAtomic(path.join(evidenceDir, 'summary.json'), {
    apiRoot,
    apiVolumeName,
    classification,
    ...(error ? { error } : {}),
    generation,
    hypothesis:
      probe === 'functional'
        ? 'DD-H3 staged load, run, exec, offline build, bind, volume, internal network, scanner exchange, and negative pull primitives'
        : 'DD-H2 private named-volume UDS is usable only by an explicitly mounted sibling',
    probe,
    profileHash,
    requestedNames,
    runId,
    schemaVersion: SCHEMA_VERSION,
    ...(probe === 'functional' ? { stageRoot, stageVolumeName } : {}),
  });
}

async function cleanup(reason) {
  if (cleaning) return;
  cleaning = true;
  let cleanupError;
  try {
    for (const resource of [...resources].reverse()) {
      if (!resource.removed) removeTrackedContainer(resource, `cleanup-remove-${resource.role}`, true);
    }
    if (stageVolumeCreated) removeOwnedVolume(stageVolumeName, 'stage');
    if (apiVolumeCreated) removeOwnedVolume(apiVolumeName, 'api');
    for (const ordinal of [1, 2]) {
      const inventory = collectCleanupInventory(ordinal);
      writeJsonAtomic(path.join(evidenceDir, 'cleanup', `inventory-${ordinal}.json`), inventory);
      if (inventory.containers.length !== 0 || inventory.volumes.length !== 0) {
        throw new Error(`cleanup inventory ${ordinal} is not empty`);
      }
    }
  } catch (error) {
    cleanupError = error;
    probeExit = 1;
  }
  writeJsonAtomic(path.join(evidenceDir, 'cleanup-result.json'), {
    deletedResourceIds: [...new Set(deletedResourceIds)].sort(),
    ...(cleanupError ? { error: cleanupError.message } : {}),
    reason,
    runId,
    schemaVersion: SCHEMA_VERSION,
    status: cleanupError ? 'failed' : 'complete',
  });
  writeManifest(evidenceDir, runId);
}

function removeTrackedContainer(resource, label, allowFailure = false) {
  const inspected = runCommand(`${label}-inspect`, ['docker', 'inspect', resource.id], true);
  if (inspected.exitCode === 0) {
    assertOwnedContainer(JSON.parse(inspected.stdout)[0], resource);
    const removed = runCommand(label, ['docker', 'rm', '-f', '-v', resource.id], true);
    if (removed.exitCode !== 0 && !allowFailure) throw new Error(`exact ${resource.role} cleanup failed`);
    if (removed.exitCode === 0) {
      resource.removed = true;
      deletedResourceIds.push(resource.id);
    }
  } else {
    resource.removed = true;
  }
}

function removeOwnedVolume(volumeName, role) {
  const inspected = runCommand(`cleanup-inspect-${role}-volume`, ['docker', 'volume', 'inspect', volumeName], true);
  if (inspected.exitCode !== 0) return;
  assertOwnedVolume(JSON.parse(inspected.stdout)[0], volumeName);
  const removed = runCommand(`cleanup-remove-${role}-volume`, ['docker', 'volume', 'rm', volumeName], true);
  if (removed.exitCode !== 0) throw new Error(`exact ${role} volume cleanup failed: ${removed.stderr.trim()}`);
  deletedResourceIds.push(volumeName);
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
  const labeledVolumes = runCommand(`cleanup-inventory-${ordinal}-labeled-volumes`, [
    'docker',
    'volume',
    'ls',
    '--filter',
    `label=${ownershipLabel}`,
    '--format',
    '{{.Name}}',
  ])
    .stdout.split('\n')
    .filter(Boolean);
  const lingeringAnonymous = [];
  for (const volume of [...anonymousVolumes].sort()) {
    const inspected = runCommand(
      `cleanup-inventory-${ordinal}-anonymous-volume`,
      ['docker', 'volume', 'inspect', volume],
      true,
    );
    if (inspected.exitCode === 0) lingeringAnonymous.push(volume);
  }
  return {
    containers,
    ordinal,
    runId,
    schemaVersion: SCHEMA_VERSION,
    volumes: [...new Set([...labeledVolumes, ...lingeringAnonymous])].sort(),
  };
}

function assertOwnedContainer(inspect, resource) {
  const labels = inspect.Config?.Labels ?? {};
  if (
    inspect.Id !== resource.id ||
    inspect.Name !== `/${resource.requestedName}` ||
    labels['com.ironcurtain.nested-spike.run-id'] !== runId ||
    labels['com.ironcurtain.nested-spike.generation'] !== String(generation)
  ) {
    throw new Error(`refusing operation: ${resource.role} ownership/generation/name mismatch`);
  }
}

function assertOwnedVolume(inspect, expectedName) {
  const labels = inspect.Labels ?? {};
  if (
    inspect.Name !== expectedName ||
    labels['com.ironcurtain.nested-spike.run-id'] !== runId ||
    labels['com.ironcurtain.nested-spike.generation'] !== String(generation)
  ) {
    throw new Error(`refusing operation: ${expectedName} volume ownership/generation/name mismatch`);
  }
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
  if (!allowFailure && result.status !== 0) throw new Error(`${argv[0]} ${argv[1] ?? ''} exited ${result.status}`);
  return record;
}

function parseOptionalArgs(argv) {
  if (argv.length === 0) return {};
  return parseArgs(argv, []);
}

function sha256File(filename) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', 't').toLowerCase();
}

process.exitCode = probeExit;
