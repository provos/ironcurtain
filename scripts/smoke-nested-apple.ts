#!/usr/bin/env tsx

/** Production-entrypoint smoke for the admitted Apple secure-nested-Docker slice. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadDockerWorkloadLease, type DockerWorkloadLease } from '../src/docker-workload/bundle-lease.js';
import { loadDockerWorkloadCatalogPair } from '../src/docker-workload/catalog-pair.js';
import { dockerWorkloadConfigHash, resolveDockerWorkloadConfig } from '../src/docker-workload/config.js';
import { getProcessStartIdentity } from '../src/docker-workload/process-lock.js';
import { APPLE_VM_DAEMON_DOCKER_HOST, APPLE_VM_DAEMON_TOOLCHAIN_DIR } from '../src/docker-workload/apple-vm-daemon.js';
import { loadResourceWatchdogSupervisorStatus } from '../src/docker-workload/resource-watchdog-supervisor.js';
import { createContainerRuntime } from '../src/docker/container-runtime.js';
import {
  getBundleControlSocketPath,
  getBundleMitmControlSocketPath,
  getBundleMitmProxySocketPath,
  getBundleProxySocketPath,
  getBundleRuntimeRoot,
} from '../src/config/paths.js';
import { verifyOciImageArchive } from '../src/docker/oci-image-archive.js';
import { preloadedCatalogFileName } from '../src/docker/preloaded-catalog-paths.js';
import { buildPreloadedImageLabels, loadPreloadedImageCatalog } from '../src/docker/preloaded-image-catalog.js';
import { createPtyBridge, type PtyBridge } from '../src/pty/pty-bridge.js';
import type { SessionMetadata } from '../src/session/types.js';
import type { BundleId } from '../src/session/types.js';
import { appendBoundedTuiOutput, hasClaudeTuiEvidence } from './smoke-nested-apple-tui.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const CLI_PATH = resolve(PACKAGE_ROOT, 'dist', 'cli.js');
const SELECTED_IMAGE = 'ironcurtain-claude-code:latest';
const DOCKER_CLIENT = `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`;
const DOCKER_HOST = APPLE_VM_DAEMON_DOCKER_HOST;
const TIMEOUT_MS = 60 * 60_000;
const PTY_ACTIVATION_TIMEOUT_MS = 15 * 60_000;
const PTY_TUI_TIMEOUT_MS = 60_000;
const PTY_GRACEFUL_EXIT_TIMEOUT_MS = 30_000;
const FAKE_API_KEY = 'sk-ant-api03-IRONCURTAIN-SMOKE-FAKE-ONLY';
const MACOS_SUN_PATH_BYTES = 104;
const SOCKET_PATH_PROBE_BUNDLE = 'ffffffff-ffff-4fff-8fff-ffffffffffff' as BundleId;

interface ActiveBundle {
  readonly sessionId: string;
  readonly metadata: SessionMetadata & { readonly dockerWorkload: NonNullable<SessionMetadata['dockerWorkload']> };
  readonly leasePath: string;
  readonly lease: DockerWorkloadLease;
}

interface SmokeEnvironment {
  readonly sourceCatalogDir: string;
  readonly frozenCatalogDir: string;
  readonly smokeRoot: string;
  readonly smokeHome: string;
  readonly workspace: string;
  readonly expectedConfigHash: string;
}

async function main(): Promise<void> {
  const { sourceCatalogDir, frozenCatalogDir, smokeRoot, smokeHome, workspace, expectedConfigHash } =
    prepareSmokeEnvironment();
  try {
    const argv = [CLI_PATH, 'start', '--agent', 'claude-code', '--workspace', workspace];
    const child = spawn(process.execPath, argv, {
      cwd: dirname(smokeRoot),
      env: smokeChildEnvironment(smokeHome),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    process.stderr.write(
      `nested Apple smoke argv=${JSON.stringify([process.execPath, ...argv])} cwd=${dirname(smokeRoot)}\n`,
    );

    let succeeded = false;
    let activeBundle: ActiveBundle | undefined;
    try {
      const active = await waitForActiveBundle(
        smokeHome,
        () => assertChildRunning(child, 'while waiting for activation'),
        expectedConfigHash,
      );
      activeBundle = active;
      const outerId = requireAgentOuterId(active.lease);
      const supervisorStatusPath = resolve(dirname(active.leasePath), 'status.json');
      const supervisor = loadResourceWatchdogSupervisorStatus(supervisorStatusPath);
      const supervisorIdentity = getProcessStartIdentity(supervisor.supervisorPid);
      if (supervisorIdentity === undefined) throw new Error('watchdog supervisor is not alive at smoke activation');
      assertChildRunning(child, 'before private-Docker operation');

      const runtime = createContainerRuntime('apple-container');
      const frozenDocker = loadPreloadedImageCatalog(resolve(frozenCatalogDir, preloadedCatalogFileName('docker')));
      const selected = frozenDocker.catalog.images.find((entry) => entry.logicalName === SELECTED_IMAGE);
      if (selected === undefined) throw new Error(`frozen Docker catalog is missing ${SELECTED_IMAGE}`);
      const helper = frozenDocker.catalog.images.find((entry) => entry.logicalName === 'ironcurtain-helper:latest');
      if (helper === undefined) throw new Error('frozen Docker catalog is missing ironcurtain-helper:latest');

      const info = await innerDocker(runtime, outerId, ['info', '--format', '{{json .}}']);
      const parsedInfo = JSON.parse(info.stdout) as { Driver?: string; SecurityOptions?: readonly string[] };
      if (parsedInfo.Driver !== 'vfs' || !parsedInfo.SecurityOptions?.some((item) => item.includes('rootless'))) {
        throw new Error(`private Docker is not rootless+vfs: ${info.stdout.trim()}`);
      }
      const inspected = await innerDocker(runtime, outerId, [
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        SELECTED_IMAGE,
      ]);
      if (inspected.stdout.trim() !== selected.runtimeImageId) {
        throw new Error('selected inner image immutable ID differs from frozen Docker catalog');
      }
      const before = await innerDocker(runtime, outerId, ['container', 'ls', '--all', '--quiet']);
      if (before.stdout.trim() !== '') throw new Error('private Docker inventory was not empty before smoke child');

      // Harness-only workload ingress: copy one catalog-owned tiny helper archive
      // into the already-mounted workspace, verify the exposed bytes with the
      // production OCI verifier, load it through the private daemon, then retire
      // the copy. This does not broaden production bootstrap or configuration.
      const helperArchive = resolve(workspace, helper.archive.fileName);
      copyFileSync(resolve(sourceCatalogDir, helper.archive.fileName), helperArchive);
      chmodSync(helperArchive, 0o400);
      const expectedHelperLabels = buildPreloadedImageLabels(helper, frozenDocker.catalog.generation);
      await verifyOciImageArchive({
        archivePath: helperArchive,
        expectedArchiveSha256: helper.archive.sha256,
        expectedSizeBytes: helper.archive.sizeBytes,
        manifestDigest: helper.manifestDigest,
        configDigest: helper.configDigest,
        logicalName: helper.logicalName,
        architecture: helper.architecture,
        expectedLabels: expectedHelperLabels,
      });
      await innerDocker(runtime, outerId, ['image', 'load', '--input', `/workspace/${helper.archive.fileName}`]);
      rmSync(helperArchive, { force: true });
      const helperInspect = await innerDocker(runtime, outerId, [
        'image',
        'inspect',
        '--format',
        '{{json .}}',
        helper.logicalName,
      ]);
      const helperInfo = JSON.parse(helperInspect.stdout) as {
        Id?: string;
        Config?: { Labels?: Readonly<Record<string, string>> };
      };
      if (helperInfo.Id !== helper.runtimeImageId) throw new Error('loaded helper immutable ID differs from catalog');
      for (const [name, value] of Object.entries(expectedHelperLabels)) {
        if (helperInfo.Config?.Labels?.[name] !== value) throw new Error(`loaded helper label differs: ${name}`);
      }
      await innerDocker(runtime, outerId, [
        'run',
        '--rm',
        '--pull',
        'never',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        helper.runtimeImageId,
        '--sleep=10ms',
      ]);
      const after = await innerDocker(runtime, outerId, ['container', 'ls', '--all', '--quiet']);
      if (after.stdout.trim() !== '') throw new Error('private Docker inventory was not empty after smoke child');
      assertChildRunning(child, 'after private-Docker operation');

      child.stdin.write('/quit\n');
      child.stdin.end();
      const exitCode = await waitForExit(child, 90_000);
      if (exitCode !== 0) throw new Error(`CLI exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);

      const closed = await waitForClosedLease(active.leasePath);
      assertClosedLeaseProof(closed, outerId);
      if (await runtime.containerExists(outerId)) throw new Error(`exact outer VM still exists: ${outerId}`);
      if (runtime.listContainers === undefined) throw new Error('Apple runtime cannot inventory containers');
      const outerResource = closed.resources.find((resource) => resource.observedId === outerId);
      if (outerResource === undefined) throw new Error('closed lease lost exact outer resource');
      const owned = await runtime.listContainers({
        labelFilter: `${outerResource.ownershipLabelKey}=${outerResource.ownershipLabelValue}`,
      });
      if (owned.length !== 0) throw new Error('generation-owned Apple VM inventory is not empty');
      if (existsSync(closed.paths.stateRoot)) throw new Error('revocable state root still exists');
      const runtimeRoot = withIronCurtainHome(smokeHome, () => getBundleRuntimeRoot(active.sessionId as BundleId));
      if (existsSync(runtimeRoot)) throw new Error('per-bundle runtime root still exists');
      const finalSupervisor = loadResourceWatchdogSupervisorStatus(supervisorStatusPath);
      if (finalSupervisor.state !== 'closed') throw new Error(`watchdog supervisor ended in ${finalSupervisor.state}`);
      await waitForProcessIdentityExit(supervisor.supervisorPid, supervisorIdentity, 10_000);
      assertNoProviderRequest(resolve(smokeHome, 'sessions', active.sessionId, 'audit.jsonl'));
      succeeded = true;
      process.stderr.write(`nested Apple smoke passed (session=${active.sessionId}, outer=${outerId})\n`);
    } finally {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.stdin.write('/quit\n');
          child.stdin.end();
          await waitForExit(child, 60_000).catch(() => {});
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
          }
          await waitForExit(child, 60_000).catch(() => {});
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await waitForExit(child, 10_000).catch(() => {});
          }
        }
        const cleanupLeasePath = activeBundle?.leasePath ?? discoverSoleLeasePath(smokeHome);
        if (!succeeded && cleanupLeasePath !== undefined) {
          // A detached watchdog must close an orphaned bundle after a forced CLI
          // death. Do not silently return from a failed smoke with live authority.
          await waitForClosedLeaseWithin(cleanupLeasePath, 180_000);
        }
      } finally {
        retireIsolatedSelectedArchive(smokeHome);
        if (succeeded) rmSync(smokeRoot, { recursive: true, force: true });
        else
          process.stderr.write(
            `nested Apple smoke retained diagnostics at ${smokeRoot}\nstdout:\n${redact(stdout)}\nstderr:\n${redact(stderr)}\n`,
          );
      }
    }
  } catch (error) {
    retireIsolatedSelectedArchive(smokeHome);
    process.stderr.write(`nested Apple smoke failed; diagnostics retained at ${smokeRoot}\n`);
    throw error;
  }
}

function prepareSmokeEnvironment(providerBaseUrl?: string): SmokeEnvironment {
  if (!existsSync(CLI_PATH)) throw new Error(`built CLI is missing: ${CLI_PATH}; run npm run build`);
  const operatorHome = process.env.IRONCURTAIN_HOME ?? resolve(homedir(), '.ironcurtain');
  const sourceCatalogDir = resolve(operatorHome, 'docker-workload', 'preloaded-catalog');
  const frozenCatalogDir = resolve(PACKAGE_ROOT, 'config', 'docker-workload');
  assertSourceCatalogMatchesFrozen(sourceCatalogDir, frozenCatalogDir);

  const smokeRoot = realpathSync(mkdtempSync('/private/tmp/ic-na-'));
  const smokeHome = resolve(smokeRoot, 'home');
  const workspace = resolve(smokeRoot, 'workspace');
  try {
    if (!smokeRoot.startsWith('/private/tmp/')) {
      throw new Error(`nested Apple smoke root is not canonical under /private/tmp: ${smokeRoot}`);
    }
    chmodSync(smokeRoot, 0o700);
    mkdirSync(smokeHome, { mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    assertSmokeSocketPathBudget(smokeHome);
    stageSelectedCatalog(sourceCatalogDir, smokeHome);
    const resolvedWorkload = resolveDockerWorkloadConfig({
      enabled: true,
      tier: 'developer-only',
      backend: 'apple-container',
      imageMode: 'preloaded-catalog',
      imageIngress: 'preloaded-only',
      daemonState: 'ephemeral',
      hostPortPublishing: false,
      buildEgress: 'disabled',
      acceptObservedDiskRisk: true,
      resources: { memoryMb: 4096, cpus: 2, pids: { desired: 512, required: false }, diskMb: null },
    });
    const expectedConfigHash = dockerWorkloadConfigHash(resolvedWorkload);
    writePrivateJson(resolve(smokeHome, 'config.json'), {
      anthropicApiKey: FAKE_API_KEY,
      preferredMode: 'container',
      preferredDockerAgent: 'claude-code',
      containerRuntime: 'apple-container',
      dockerResources: { memoryMb: 1024, cpus: 1 },
      dockerWorkload: resolvedWorkload,
      ...(providerBaseUrl === undefined ? {} : { anthropicBaseUrl: providerBaseUrl }),
    });
    return { sourceCatalogDir, frozenCatalogDir, smokeRoot, smokeHome, workspace, expectedConfigHash };
  } catch (error) {
    retireIsolatedSelectedArchive(smokeHome);
    process.stderr.write(`nested Apple smoke setup failed; diagnostics retained at ${smokeRoot}\n`);
    throw error;
  }
}

function smokeChildEnvironment(smokeHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    IRONCURTAIN_HOME: smokeHome,
    IRONCURTAIN_CONTAINER_RUNTIME: 'apple-container',
    IRONCURTAIN_DOCKER_AUTH: 'apikey',
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    NO_COLOR: '1',
  };
}

/**
 * Manual live gate for the actual mux child path: production createPtyBridge
 * spawns the built `start --pty` entrypoint through node-pty. This deliberately
 * does not connect to the agent socket itself; doing so would cause socat,fork
 * to launch another agent and would no longer test production startup.
 */
async function mainPty(): Promise<void> {
  const providerSink = await startRejectingProviderSink();
  let environment: SmokeEnvironment;
  try {
    environment = prepareSmokeEnvironment(providerSink.url);
  } catch (error) {
    await closeServer(providerSink.server);
    throw error;
  }
  const { frozenCatalogDir, smokeRoot, smokeHome, workspace, expectedConfigHash } = environment;
  const restoreEnvironment = installSmokeProcessEnvironment(smokeHome);
  let bridge: PtyBridge | undefined;
  let unsubscribeOutput: (() => void) | undefined;
  let activeBundle: ActiveBundle | undefined;
  let diagnosticOutput = '';
  let postActivationOutput = '';
  let collectPostActivation = false;
  let succeeded = false;

  try {
    bridge = await createPtyBridge({
      cols: 120,
      rows: 40,
      ironcurtainBin: process.execPath,
      prefixArgs: [CLI_PATH],
      agent: 'claude-code',
      workspacePath: workspace,
      muxId: `nested-apple-smoke-${process.pid}`,
      muxPid: process.pid,
    });
    unsubscribeOutput = bridge.onData((chunk) => {
      diagnosticOutput = appendBoundedTuiOutput(diagnosticOutput, chunk);
      if (collectPostActivation) postActivationOutput = appendBoundedTuiOutput(postActivationOutput, chunk);
    });
    process.stderr.write(
      `nested Apple PTY smoke argv=${JSON.stringify([
        process.execPath,
        CLI_PATH,
        'start',
        '--pty',
        '--agent',
        'claude-code',
        '--workspace',
        workspace,
      ])} cwd=${process.cwd()}\n`,
    );

    const active = await waitForActiveBundle(
      smokeHome,
      () => assertBridgeRunning(bridge!, 'while waiting for persisted lease activation'),
      expectedConfigHash,
      PTY_ACTIVATION_TIMEOUT_MS,
    );
    activeBundle = active;
    const outerId = requireAgentOuterId(active.lease);
    const supervisorStatusPath = resolve(dirname(active.leasePath), 'status.json');
    const supervisor = loadResourceWatchdogSupervisorStatus(supervisorStatusPath);
    const supervisorIdentity = getProcessStartIdentity(supervisor.supervisorPid);
    if (supervisorIdentity === undefined) throw new Error('watchdog supervisor is not alive at PTY activation');

    // Drain the headless terminal's queued write callbacks before opening the
    // evidence window. Without this barrier, a pre-activation raw chunk could
    // finish its asynchronous xterm write after `collectPostActivation=true`
    // and be misclassified as post-activation output.
    await new Promise<void>((resolvePromise) => bridge!.terminal.write('', resolvePromise));

    // Only bytes received after this persisted `active` observation count. A
    // resize requests a normal TUI redraw after the evidence boundary and
    // avoids accepting an earlier socket, directory, or startup-log artifact.
    collectPostActivation = true;
    bridge.resize(121, 41);
    await poll(
      'post-activation Claude TUI output',
      () => {
        assertBridgeRunning(bridge!, 'while waiting for post-activation Claude TUI output');
        return hasClaudeTuiEvidence(postActivationOutput) ? true : undefined;
      },
      PTY_TUI_TIMEOUT_MS,
    );

    const runtime = createContainerRuntime('apple-container');
    const info = await innerDocker(runtime, outerId, ['info', '--format', '{{json .}}']);
    const parsedInfo = JSON.parse(info.stdout) as { Driver?: string; SecurityOptions?: readonly string[] };
    if (parsedInfo.Driver !== 'vfs' || !parsedInfo.SecurityOptions?.some((item) => item.includes('rootless'))) {
      throw new Error(`private Docker is not rootless+vfs: ${info.stdout.trim()}`);
    }
    const frozenDocker = loadPreloadedImageCatalog(resolve(frozenCatalogDir, preloadedCatalogFileName('docker')));
    const selected = frozenDocker.catalog.images.find((entry) => entry.logicalName === SELECTED_IMAGE);
    if (selected === undefined) throw new Error(`frozen Docker catalog is missing ${SELECTED_IMAGE}`);
    const inspected = await innerDocker(runtime, outerId, ['image', 'inspect', '--format', '{{.Id}}', SELECTED_IMAGE]);
    if (inspected.stdout.trim() !== selected.runtimeImageId) {
      throw new Error('selected inner image immutable ID differs from frozen Docker catalog');
    }

    // `/exit` is Claude Code's graceful TUI command. Success requires the
    // node-pty child to exit on its own; forced termination is cleanup-only.
    bridge.write('/exit\r');
    const exitCode = await waitForBridgeExit(bridge, PTY_GRACEFUL_EXIT_TIMEOUT_MS);
    if (exitCode !== 0) throw new Error(`PTY child exited ${exitCode}`);

    const closed = await waitForClosedLease(active.leasePath, 180_000);
    assertClosedLeaseProof(closed, outerId);
    if (await runtime.containerExists(outerId)) throw new Error(`exact outer VM still exists: ${outerId}`);
    if (runtime.listContainers === undefined) throw new Error('Apple runtime cannot inventory containers');
    const outerResource = closed.resources.find((resource) => resource.observedId === outerId);
    if (outerResource === undefined) throw new Error('closed lease lost exact outer resource');
    const owned = await runtime.listContainers({
      labelFilter: `${outerResource.ownershipLabelKey}=${outerResource.ownershipLabelValue}`,
    });
    if (owned.length !== 0) throw new Error('generation-owned Apple VM inventory is not empty');
    if (existsSync(closed.paths.stateRoot)) throw new Error('revocable state root still exists');
    const runtimeRoot = withIronCurtainHome(smokeHome, () => getBundleRuntimeRoot(active.sessionId as BundleId));
    if (existsSync(runtimeRoot)) throw new Error('per-bundle runtime root still exists');
    const finalSupervisor = loadResourceWatchdogSupervisorStatus(supervisorStatusPath);
    if (finalSupervisor.state !== 'closed') throw new Error(`watchdog supervisor ended in ${finalSupervisor.state}`);
    await waitForProcessIdentityExit(supervisor.supervisorPid, supervisorIdentity, 10_000);
    assertNoProviderRequest(resolve(smokeHome, 'sessions', active.sessionId, 'audit.jsonl'));
    await closeServer(providerSink.server);
    if (providerSink.requestCount() !== 0) {
      throw new Error(`PTY smoke observed ${providerSink.requestCount()} unexpected provider request(s)`);
    }
    succeeded = true;
    process.stderr.write(`nested Apple PTY smoke passed (session=${active.sessionId}, outer=${outerId})\n`);
  } finally {
    unsubscribeOutput?.();
    try {
      if (bridge?.alive) {
        bridge.write('/exit\r');
        await waitForBridgeExit(bridge, PTY_GRACEFUL_EXIT_TIMEOUT_MS).catch(() => {});
      }
      if (bridge?.alive) {
        bridge.kill();
        await waitForBridgeExit(bridge, 10_000).catch(() => {});
      }
      if (bridge?.alive) {
        try {
          process.kill(bridge.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await waitForBridgeExit(bridge, 10_000).catch(() => {});
      }
      const cleanupLeasePath = activeBundle?.leasePath ?? discoverSoleLeasePath(smokeHome);
      if (!succeeded && cleanupLeasePath !== undefined) {
        await waitForClosedLeaseWithin(cleanupLeasePath, 180_000);
      }
    } finally {
      await closeServer(providerSink.server);
      restoreEnvironment();
      retireIsolatedSelectedArchive(smokeHome);
      if (succeeded) rmSync(smokeRoot, { recursive: true, force: true });
      else
        process.stderr.write(
          `nested Apple PTY smoke retained diagnostics at ${smokeRoot}\nPTY output tail:\n${redact(diagnosticOutput)}\n`,
        );
    }
  }
}

async function startRejectingProviderSink(): Promise<{
  readonly server: Server;
  readonly url: string;
  readonly requestCount: () => number;
}> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    response.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
    response.end('{"error":"provider access is forbidden during the nested PTY smoke"}\n');
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await closeServer(server);
    throw new Error('provider sink did not bind a loopback TCP address');
  }
  return { server, url: `http://127.0.0.1:${address.port}`, requestCount: () => requests };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
  });
}

function installSmokeProcessEnvironment(smokeHome: string): () => void {
  const values: Readonly<Record<string, string>> = {
    IRONCURTAIN_HOME: smokeHome,
    IRONCURTAIN_CONTAINER_RUNTIME: 'apple-container',
    IRONCURTAIN_DOCKER_AUTH: 'apikey',
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    NO_COLOR: '1',
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function assertSourceCatalogMatchesFrozen(sourceDir: string, frozenDir: string): void {
  const sourceStats = statSync(sourceDir);
  if (!sourceStats.isDirectory() || (sourceStats.mode & 0o077) !== 0) {
    throw new Error(`staged catalog directory must be private and owner-only: ${sourceDir}`);
  }
  const source = loadDockerWorkloadCatalogPair({
    appleCatalogPath: resolve(sourceDir, preloadedCatalogFileName('apple-container')),
    dockerCatalogPath: resolve(sourceDir, preloadedCatalogFileName('docker')),
  });
  const frozen = loadDockerWorkloadCatalogPair({
    appleCatalogPath: resolve(frozenDir, preloadedCatalogFileName('apple-container')),
    dockerCatalogPath: resolve(frozenDir, preloadedCatalogFileName('docker')),
  });
  if (source.apple.sha256 !== frozen.apple.sha256 || source.docker.sha256 !== frozen.docker.sha256) {
    throw new Error(`staged catalogs in ${sourceDir} do not match the current frozen catalog pair`);
  }
  const selected = source.apple.catalog.images.find((entry) => entry.logicalName === SELECTED_IMAGE);
  if (selected === undefined) throw new Error(`staged catalog is missing ${SELECTED_IMAGE}`);
  const archive = resolve(sourceDir, selected.archive.fileName);
  if (!existsSync(archive) || statSync(archive).size !== selected.archive.sizeBytes) {
    throw new Error(`selected staged archive is absent or wrong-sized: ${archive}`);
  }
  for (const path of [source.apple.path, source.docker.path, archive]) {
    if ((statSync(path).mode & 0o222) !== 0) throw new Error(`staged catalog input must have no write bits: ${path}`);
  }
}

function assertSmokeSocketPathBudget(smokeHome: string): void {
  const socketPaths = withIronCurtainHome(smokeHome, () => [
    getBundleControlSocketPath(SOCKET_PATH_PROBE_BUNDLE),
    getBundleProxySocketPath(SOCKET_PATH_PROBE_BUNDLE),
    getBundleMitmProxySocketPath(SOCKET_PATH_PROBE_BUNDLE),
    getBundleMitmControlSocketPath(SOCKET_PATH_PROBE_BUNDLE),
  ]);
  for (const socketPath of socketPaths) {
    const length = Buffer.byteLength(socketPath);
    if (length >= MACOS_SUN_PATH_BYTES) {
      throw new Error(
        `nested Apple smoke UDS path exceeds the macOS sockaddr_un budget ` +
          `(${length} >= ${MACOS_SUN_PATH_BYTES} bytes): ${socketPath}`,
      );
    }
  }
}

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

function stageSelectedCatalog(sourceDir: string, smokeHome: string): void {
  const target = resolve(smokeHome, 'docker-workload', 'preloaded-catalog');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const kind of ['apple-container', 'docker'] as const) {
    const name = preloadedCatalogFileName(kind);
    copyFileSync(resolve(sourceDir, name), resolve(target, name));
    chmodSync(resolve(target, name), 0o400);
  }
  const apple = loadPreloadedImageCatalog(resolve(sourceDir, preloadedCatalogFileName('apple-container')));
  const selected = apple.catalog.images.find((entry) => entry.logicalName === SELECTED_IMAGE);
  if (selected === undefined) throw new Error(`staged Apple catalog is missing ${SELECTED_IMAGE}`);
  try {
    linkSync(resolve(sourceDir, selected.archive.fileName), resolve(target, selected.archive.fileName));
  } catch (error) {
    throw new Error('cannot hard-link the selected catalog archive into the isolated smoke home', { cause: error });
  }
}

function writePrivateJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function waitForActiveBundle(
  home: string,
  assertRunning: () => void,
  configHash: string,
  timeoutMs = TIMEOUT_MS,
): Promise<ActiveBundle> {
  return poll(
    'active Docker-workload lease',
    async () => {
      assertRunning();
      const sessionsRoot = resolve(home, 'sessions');
      if (!existsSync(sessionsRoot)) return undefined;
      for (const sessionId of readdirSync(sessionsRoot)) {
        const metadataPath = resolve(sessionsRoot, sessionId, 'session-metadata.json');
        if (!existsSync(metadataPath)) continue;
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as SessionMetadata;
        if (metadata.dockerWorkload === undefined) continue;
        if (
          metadata.dockerWorkload.backend !== 'apple-container' ||
          metadata.dockerWorkload.configHash !== configHash
        ) {
          throw new Error('persisted Docker-workload metadata does not match the admitted Apple config');
        }
        const leasePath = resolve(home, 'docker-workload', 'leases', metadata.dockerWorkload.leaseId, 'lease.json');
        const lease = loadDockerWorkloadLease(leasePath);
        if (
          lease.leaseId !== metadata.dockerWorkload.leaseId ||
          lease.generation !== metadata.dockerWorkload.generation ||
          lease.bindings.watchdogPolicySha256 !== metadata.dockerWorkload.watchdogPolicySha256
        ) {
          throw new Error('persisted Docker-workload metadata does not match the exact lease bindings');
        }
        if (lease.status === 'incident')
          throw new Error(`Docker-workload activation entered incident: ${lease.incident?.detail}`);
        if (lease.status !== 'active') return undefined;
        return { sessionId, metadata: metadata as ActiveBundle['metadata'], leasePath, lease };
      }
      return undefined;
    },
    timeoutMs,
  );
}

function requireAgentOuterId(lease: DockerWorkloadLease): string {
  const resources = lease.resources.filter((resource) => resource.kind === 'container' && resource.role === 'agent');
  if (resources.length !== 1 || resources[0]?.observedId === null) {
    throw new Error('active lease does not record exactly one immutable agent VM ID');
  }
  return resources[0].observedId;
}

async function innerDocker(
  runtime: ReturnType<typeof createContainerRuntime>,
  outerId: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await runtime.exec(outerId, [DOCKER_CLIENT, '--host', DOCKER_HOST, ...args], 120_000, 'codespace');
  if (result.exitCode !== 0) throw new Error(`inner docker ${args[0]} failed: ${result.stderr}`);
  return result;
}

async function waitForClosedLease(path: string, timeoutMs = TIMEOUT_MS): Promise<DockerWorkloadLease> {
  return poll(
    'closed Docker-workload lease',
    () => {
      const lease = loadDockerWorkloadLease(path);
      if (lease.status === 'incident')
        throw new Error(`Docker-workload lease entered incident: ${lease.incident?.detail}`);
      return lease.status === 'closed' ? lease : undefined;
    },
    timeoutMs,
  );
}

function assertClosedLeaseProof(lease: DockerWorkloadLease, outerId: string): void {
  if (lease.cleanup === null) throw new Error('closed lease is missing its cleanup proof');
  const resource = lease.resources.find((candidate) => candidate.observedId === outerId);
  if (resource?.removal?.proof !== 'immutable-id-absent')
    throw new Error('exact outer VM lacks immutable-ID absence proof');
  if (lease.cleanup.inventories.some((inventory) => inventory.ownedResourceIds.length !== 0)) {
    throw new Error('closed lease inventory proof is not empty');
  }
  if (lease.cleanup.inventories.length !== 2) throw new Error('closed lease lacks two cleanup inventories');
  const gap =
    Date.parse(lease.cleanup.inventories[1]!.capturedAt) - Date.parse(lease.cleanup.inventories[0]!.capturedAt);
  if (gap < lease.cleanupInventoryGapMs) throw new Error('cleanup inventory observations are too close together');
  if (!lease.cleanup.stateRootAbsent) throw new Error('closed lease did not prove state-root absence');
}

function assertNoProviderRequest(auditPath: string): void {
  if (!existsSync(auditPath)) return;
  const audit = readFileSync(auditPath, 'utf8');
  if (/api\.anthropic\.com|\/v1\/messages/u.test(audit) || audit.includes(FAKE_API_KEY)) {
    throw new Error('no-task smoke observed provider request or real-key material in audit output');
  }
}

function assertChildRunning(child: ChildProcessWithoutNullStreams, phase: string): void {
  if (child.exitCode !== null || child.signalCode !== null) throw new Error(`CLI exited unexpectedly ${phase}`);
}

function assertBridgeRunning(bridge: PtyBridge, phase: string): void {
  if (!bridge.alive) throw new Error(`PTY child exited unexpectedly ${phase} (code=${bridge.exitCode ?? 'unknown'})`);
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise<number | null>((resolvePromise, reject) => {
    const onExit = (code: number | null): void => {
      clearTimeout(timer);
      resolvePromise(code);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`timed out waiting ${timeoutMs}ms for built CLI exit`));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function waitForBridgeExit(bridge: PtyBridge, timeoutMs: number): Promise<number> {
  if (!bridge.alive && bridge.exitCode !== undefined) return bridge.exitCode;
  return new Promise<number>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting ${timeoutMs}ms for PTY child exit`)), timeoutMs);
    bridge.onExit((exitCode) => {
      clearTimeout(timer);
      resolvePromise(exitCode);
    });
  });
}

async function poll<T>(
  label: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForClosedLeaseWithin(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lease = loadDockerWorkloadLease(path);
    if (lease.status === 'closed') return;
    if (lease.status === 'incident')
      throw new Error(`failed smoke cleanup entered incident: ${lease.incident?.detail}`);
    await delay(500);
  }
  throw new Error(`failed smoke left a nonterminal lease after ${timeoutMs}ms: ${path}`);
}

async function waitForProcessIdentityExit(pid: number, identity: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getProcessStartIdentity(pid) !== identity) return;
    await delay(100);
  }
  throw new Error(`exact watchdog supervisor process identity is still alive after ${timeoutMs}ms`);
}

function discoverSoleLeasePath(home: string): string | undefined {
  const leasesRoot = resolve(home, 'docker-workload', 'leases');
  if (!existsSync(leasesRoot)) return undefined;
  const paths = readdirSync(leasesRoot)
    .map((leaseId) => resolve(leasesRoot, leaseId, 'lease.json'))
    .filter(existsSync);
  if (paths.length > 1) throw new Error(`isolated smoke home contains multiple leases: ${paths.join(', ')}`);
  return paths[0];
}

function retireIsolatedSelectedArchive(smokeHome: string): void {
  const staging = resolve(smokeHome, 'docker-workload', 'preloaded-catalog');
  if (!existsSync(staging)) return;
  const catalogPath = resolve(staging, preloadedCatalogFileName('apple-container'));
  if (!existsSync(catalogPath)) return;
  const catalog = loadPreloadedImageCatalog(catalogPath);
  const selected = catalog.catalog.images.find((entry) => entry.logicalName === SELECTED_IMAGE);
  if (selected !== undefined) rmSync(resolve(staging, selected.archive.fileName), { force: true });
}

function redact(value: string): string {
  return value.replaceAll(FAKE_API_KEY, '[REDACTED_FAKE_KEY]');
}

if (process.argv.includes('--pty')) await mainPty();
else await main();
