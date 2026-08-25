#!/usr/bin/env tsx

/** Production-entrypoint smoke for the admitted Apple secure-nested-Docker slice. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, get as httpGet, type Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadDockerWorkloadLease, type DockerWorkloadLease } from '../src/docker-workload/bundle-lease.js';
import { dockerWorkloadConfigHash, resolveDockerWorkloadConfig } from '../src/docker-workload/config.js';
import { getProcessStartIdentity } from '../src/docker-workload/process-lock.js';
import { APPLE_VM_DAEMON_DOCKER_HOST, APPLE_VM_DAEMON_TOOLCHAIN_DIR } from '../src/docker-workload/apple-vm-daemon.js';
import { APPLE_VM_DOCKER_WORKLOAD_NETWORK } from '../src/docker-workload/apple-private-docker.js';
import { loadResourceWatchdogSupervisorStatus } from '../src/docker-workload/resource-watchdog-supervisor.js';
import { createContainerRuntime } from '../src/docker/container-runtime.js';
import {
  getBundleControlSocketPath,
  getBundleMitmControlSocketPath,
  getBundleMitmProxySocketPath,
  getBundleProxySocketPath,
  getBundleRegistryEgressSocketPath,
  getBundleRuntimeRoot,
} from '../src/config/paths.js';
import { createPtyBridge, type PtyBridge } from '../src/pty/pty-bridge.js';
import type { SessionMetadata } from '../src/session/types.js';
import type { BundleId } from '../src/session/types.js';
import {
  appendBoundedOutput,
  hasClaudeTuiEvidence,
  renderCurrentTerminalScreen,
  resetTerminalEvidenceViewport,
} from './smoke-nested-apple-tui.js';
import {
  DENIED_REGISTRY_SMOKE_IMAGE,
  assertDefaultBridgeUnavailable,
  assertDefaultContainerHasNoUsableNetwork,
  assertEmptyInternalBridge,
  assertExactAgentDockerEnvironment,
  assertInternalBridge,
  assertEmbeddedDnsResolver,
  assertNoPublishedPortBindings,
  assertRequiredBusyboxApplets,
  bindPublicRegistryWorkloadNetwork,
  assertRegistryPolicyDenied,
  buildNestedAppleSmokeWorkloadConfig,
  buildPublicRegistryWorkloadPlan,
  isExactSmokeNonceResponse,
  parseNestedAppleSmokeMode,
  type NestedAppleSmokeMode,
} from './smoke-nested-apple-workload.js';

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
  readonly leasePath: string;
  readonly lease: DockerWorkloadLease;
}

interface SmokeEnvironment {
  readonly smokeRoot: string;
  readonly smokeHome: string;
  readonly workspace: string;
  readonly expectedConfigHash: string;
}

async function main(mode: 'batch' | 'public-registry'): Promise<void> {
  const { smokeRoot, smokeHome, workspace, expectedConfigHash } = prepareSmokeEnvironment(mode);
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
      const registryEgressSocketPath = withIronCurtainHome(smokeHome, () =>
        getBundleRegistryEgressSocketPath(active.sessionId as BundleId),
      );
      if (mode === 'public-registry') {
        if (!existsSync(registryEgressSocketPath) || !statSync(registryEgressSocketPath).isSocket()) {
          throw new Error('active public-registry bundle lacks its exact host registry-egress listener UDS');
        }
      } else if (existsSync(registryEgressSocketPath)) {
        throw new Error('active preloaded-only bundle unexpectedly provisioned a registry-egress listener UDS');
      }
      const supervisorStatusPath = resolve(dirname(active.leasePath), 'status.json');
      const supervisor = loadResourceWatchdogSupervisorStatus(supervisorStatusPath);
      const supervisorIdentity = getProcessStartIdentity(supervisor.supervisorPid);
      if (supervisorIdentity === undefined) throw new Error('watchdog supervisor is not alive at smoke activation');
      assertChildRunning(child, 'before private-Docker operation');

      const runtime = createContainerRuntime('apple-container');
      await verifyAgentDockerEnvironment(runtime, outerId);
      const selectedImageId = await verifyPrivateDockerBaseline(
        runtime,
        outerId,
        resolve(smokeHome, 'sessions', active.sessionId, 'audit.jsonl'),
      );
      const before = await innerDocker(runtime, outerId, ['container', 'ls', '--all', '--quiet']);
      if (before.stdout.trim() !== '') throw new Error('private Docker inventory was not empty before smoke child');

      if (mode === 'public-registry') {
        await verifyPublicRegistryWorkload(runtime, outerId);
      } else {
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
          '--entrypoint',
          '/bin/true',
          selectedImageId,
        ]);
      }
      const after = await innerDocker(runtime, outerId, ['container', 'ls', '--all', '--quiet']);
      if (after.stdout.trim() !== '') throw new Error('private Docker inventory was not empty after smoke child');
      assertChildRunning(child, 'after private-Docker operation');

      child.stdin.write('/quit\n');
      child.stdin.end();
      const exitCode = await waitForExit(child, 90_000);
      if (exitCode !== 0) throw new Error(`CLI exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);

      await verifyClosedBundle({
        runtime,
        active,
        outerId,
        smokeHome,
        supervisorStatusPath,
        supervisorPid: supervisor.supervisorPid,
        supervisorIdentity,
      });
      if (existsSync(registryEgressSocketPath)) {
        throw new Error('closed bundle retained a registry-egress listener UDS');
      }
      assertNoProviderRequest(resolve(smokeHome, 'sessions', active.sessionId, 'audit.jsonl'));
      succeeded = true;
      process.stderr.write(
        `nested Apple ${mode} infrastructure smoke passed (session=${active.sessionId}, outer=${outerId})\n`,
      );
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
        if (succeeded) rmSync(smokeRoot, { recursive: true, force: true });
        else
          process.stderr.write(
            `nested Apple smoke retained diagnostics at ${smokeRoot}\nstdout:\n${redact(stdout)}\nstderr:\n${redact(stderr)}\n`,
          );
      }
    }
  } catch (error) {
    process.stderr.write(`nested Apple smoke failed; diagnostics retained at ${smokeRoot}\n`);
    throw error;
  }
}

function prepareSmokeEnvironment(mode: NestedAppleSmokeMode, providerBaseUrl?: string): SmokeEnvironment {
  if (!existsSync(CLI_PATH)) throw new Error(`built CLI is missing: ${CLI_PATH}; run npm run build`);

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
    const requestedWorkload = buildNestedAppleSmokeWorkloadConfig(mode);
    const smokeDockerResources = { memoryMb: 4096, cpus: 2 } as const;
    const resolvedWorkload = resolveDockerWorkloadConfig(requestedWorkload, smokeDockerResources);
    const expectedConfigHash = dockerWorkloadConfigHash(resolvedWorkload);
    writePrivateJson(resolve(smokeHome, 'config.json'), {
      anthropicApiKey: FAKE_API_KEY,
      preferredMode: 'container',
      preferredDockerAgent: 'claude-code',
      containerRuntime: 'apple-container',
      dockerResources: smokeDockerResources,
      dockerWorkload: requestedWorkload,
      ...(providerBaseUrl === undefined ? {} : { anthropicBaseUrl: providerBaseUrl }),
    });
    return { smokeRoot, smokeHome, workspace, expectedConfigHash };
  } catch (error) {
    process.stderr.write(`nested Apple smoke setup failed; diagnostics retained at ${smokeRoot}\n`);
    throw error;
  }
}

function smokeChildEnvironment(smokeHome: string): NodeJS.ProcessEnv {
  return { ...process.env, ...smokeEnvironmentValues(smokeHome) };
}

function smokeEnvironmentValues(smokeHome: string): Readonly<Record<string, string>> {
  return {
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
    environment = prepareSmokeEnvironment('pty', providerSink.url);
  } catch (error) {
    await closeServer(providerSink.server);
    throw error;
  }
  const { smokeRoot, smokeHome, workspace, expectedConfigHash } = environment;
  const restoreEnvironment = installSmokeProcessEnvironment(smokeHome);
  let bridge: PtyBridge | undefined;
  let unsubscribeOutput: (() => void) | undefined;
  let activeBundle: ActiveBundle | undefined;
  let diagnosticOutput = '';
  let receivedPostActivationOutput = false;
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
      diagnosticOutput = appendBoundedOutput(diagnosticOutput, chunk);
      if (collectPostActivation && chunk.length > 0) receivedPostActivationOutput = true;
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
    const registryEgressSocketPath = withIronCurtainHome(smokeHome, () =>
      getBundleRegistryEgressSocketPath(active.sessionId as BundleId),
    );
    if (existsSync(registryEgressSocketPath)) {
      throw new Error('active preloaded-only PTY bundle unexpectedly provisioned a registry-egress listener UDS');
    }
    const supervisorStatusPath = resolve(dirname(active.leasePath), 'status.json');
    const supervisor = loadResourceWatchdogSupervisorStatus(supervisorStatusPath);
    const supervisorIdentity = getProcessStartIdentity(supervisor.supervisorPid);
    if (supervisorIdentity === undefined) throw new Error('watchdog supervisor is not alive at PTY activation');

    // Drain queued child writes, then clear only the observer terminal. Both
    // callbacks complete before the evidence window opens, so neither delayed
    // startup bytes nor pre-activation cells can satisfy the post-activation
    // screen check. The clear sequence is not sent to the child PTY.
    await new Promise<void>((resolvePromise) => bridge!.terminal.write('', resolvePromise));
    await resetTerminalEvidenceViewport(bridge.terminal);

    // Only child bytes received after this persisted `active` observation can
    // reconstruct the cleared viewport. A resize requests a normal TUI redraw.
    collectPostActivation = true;
    bridge.resize(121, 41);
    await poll(
      'post-activation Claude TUI output',
      () => {
        assertBridgeRunning(bridge!, 'while waiting for post-activation Claude TUI output');
        return hasClaudeTuiEvidence({
          renderedScreen: renderCurrentTerminalScreen(bridge!.terminal),
          receivedPostActivationOutput,
          childAlive: bridge!.alive,
        })
          ? true
          : undefined;
      },
      PTY_TUI_TIMEOUT_MS,
    );

    const runtime = createContainerRuntime('apple-container');
    await verifyAgentDockerEnvironment(runtime, outerId);
    await verifyPrivateDockerBaseline(
      runtime,
      outerId,
      resolve(smokeHome, 'sessions', active.sessionId, 'audit.jsonl'),
    );

    // `/exit` is Claude Code's graceful TUI command. Success requires the
    // node-pty child to exit on its own; forced termination is cleanup-only.
    bridge.write('/exit\r');
    const exitCode = await waitForBridgeExit(bridge, PTY_GRACEFUL_EXIT_TIMEOUT_MS);
    if (exitCode !== 0) throw new Error(`PTY child exited ${exitCode}`);

    await verifyClosedBundle({
      runtime,
      active,
      outerId,
      smokeHome,
      supervisorStatusPath,
      supervisorPid: supervisor.supervisorPid,
      supervisorIdentity,
      leaseTimeoutMs: 180_000,
    });
    if (existsSync(registryEgressSocketPath)) {
      throw new Error('closed preloaded-only PTY bundle retained a registry-egress listener UDS');
    }
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
  const values = smokeEnvironmentValues(smokeHome);
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

function assertSmokeSocketPathBudget(smokeHome: string): void {
  const socketPaths = withIronCurtainHome(smokeHome, () => [
    getBundleControlSocketPath(SOCKET_PATH_PROBE_BUNDLE),
    getBundleProxySocketPath(SOCKET_PATH_PROBE_BUNDLE),
    getBundleMitmProxySocketPath(SOCKET_PATH_PROBE_BUNDLE),
    getBundleMitmControlSocketPath(SOCKET_PATH_PROBE_BUNDLE),
    getBundleRegistryEgressSocketPath(SOCKET_PATH_PROBE_BUNDLE),
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
        return { sessionId, leasePath, lease };
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
  timeoutMs = 120_000,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await runtime.exec(outerId, [DOCKER_CLIENT, '--host', DOCKER_HOST, ...args], timeoutMs, 'codespace');
  if (result.exitCode !== 0) {
    throw new Error(
      `inner docker ${args[0] ?? '<empty>'} failed (exit ${result.exitCode}); ` +
        `stdout=${boundedDiagnostic(result.stdout)}; stderr=${boundedDiagnostic(result.stderr)}`,
    );
  }
  return result;
}

async function expectInnerDockerFailure(
  runtime: ReturnType<typeof createContainerRuntime>,
  outerId: string,
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await runtime.exec(outerId, [DOCKER_CLIENT, '--host', DOCKER_HOST, ...args], timeoutMs, 'codespace');
  if (result.exitCode === 0) throw new Error(`inner docker ${args[0]} unexpectedly succeeded`);
  return result;
}

/**
 * Production-entrypoint infrastructure acceptance only. This proves the
 * admitted daemon path can pull and run a private inner service; it does not
 * make a provider request and is not Claude-turn qualification.
 */
async function verifyPublicRegistryWorkload(
  runtime: ReturnType<typeof createContainerRuntime>,
  outerId: string,
): Promise<void> {
  const nonce = randomBytes(24).toString('hex');
  const plan = buildPublicRegistryWorkloadPlan(nonce);
  let serverCreated = false;
  let publishedServerCreated = false;
  let hostServerCreated = false;
  let defaultContainerCreated = false;
  let imagePulled = false;
  let managedNetworkId: string | undefined;
  try {
    const existingImage = await innerDocker(runtime, outerId, ['image', 'ls', '--quiet', plan.image]);
    if (existingImage.stdout.trim() !== '') {
      throw new Error(`public-registry smoke image was already present before its allowed pull: ${plan.image}`);
    }

    const denied = await expectInnerDockerFailure(
      runtime,
      outerId,
      ['image', 'pull', DENIED_REGISTRY_SMOKE_IMAGE],
      60_000,
    );
    assertRegistryPolicyDenied(denied.stdout, denied.stderr);
    const deniedInventory = await innerDocker(runtime, outerId, [
      'image',
      'ls',
      '--quiet',
      DENIED_REGISTRY_SMOKE_IMAGE,
    ]);
    if (deniedInventory.stdout.trim() !== '') throw new Error('denied registry pull left a local image behind');

    await innerDocker(runtime, outerId, plan.pull, 300_000);
    imagePulled = true;
    const applets = await innerDocker(runtime, outerId, plan.inspectApplets);
    assertRequiredBusyboxApplets(applets.stdout);
    const networkProfile = await innerDocker(runtime, outerId, plan.inspectNetwork);
    const { networkId } = assertEmptyInternalBridge(networkProfile.stdout);
    managedNetworkId = networkId;
    const defaultBridge = await expectInnerDockerFailure(runtime, outerId, plan.inspectDefaultBridge);
    assertDefaultBridgeUnavailable(defaultBridge.stdout, defaultBridge.stderr);
    await innerDocker(runtime, outerId, plan.startDefaultNetworkContainer);
    defaultContainerCreated = true;
    const defaultNetwork = await innerDocker(runtime, outerId, plan.inspectDefaultNetworkContainer);
    assertDefaultContainerHasNoUsableNetwork(defaultNetwork.stdout);
    const networkAfterDefaultProbe = await innerDocker(runtime, outerId, plan.inspectNetwork);
    const afterDefaultProbe = assertEmptyInternalBridge(networkAfterDefaultProbe.stdout);
    if (afterDefaultProbe.networkId !== networkId) {
      throw new Error('default-network negative changed the managed bridge identity');
    }
    await innerDocker(runtime, outerId, plan.removeDefaultNetworkContainer);
    defaultContainerCreated = false;
    const defaultProbeInventory = await innerDocker(runtime, outerId, [
      'container',
      'ls',
      '--all',
      '--quiet',
      '--filter',
      `name=^${plan.defaultProbeName}$`,
    ]);
    if (defaultProbeInventory.stdout.trim() !== '') {
      throw new Error('failed default-network probe retained a container or endpoint');
    }
    const embeddedDns = await innerDocker(
      runtime,
      outerId,
      bindPublicRegistryWorkloadNetwork(plan.inspectEmbeddedDns, networkId),
    );
    assertEmbeddedDnsResolver(embeddedDns.stdout);
    const publicDns = await expectInnerDockerFailure(
      runtime,
      outerId,
      bindPublicRegistryWorkloadNetwork(plan.probePublicDnsEgress, networkId),
      15_000,
    );
    if (!publicDns.stderr.includes('IC_PUBLIC_DNS_PROBE_STARTED')) {
      throw new Error(
        `public-DNS egress negative did not prove child execution: ` +
          `stdout=${boundedDiagnostic(publicDns.stdout)} stderr=${boundedDiagnostic(publicDns.stderr)}`,
      );
    }
    const directIp = await expectInnerDockerFailure(runtime, outerId, plan.probeDirectIpEgress, 15_000);
    if (!directIp.stderr.includes('IC_DIRECT_EGRESS_PROBE_STARTED')) {
      throw new Error(
        `direct-IP egress negative did not prove child execution: ` +
          `stdout=${boundedDiagnostic(directIp.stdout)} stderr=${boundedDiagnostic(directIp.stderr)}`,
      );
    }
    await innerDocker(runtime, outerId, bindPublicRegistryWorkloadNetwork(plan.startServer, networkId));
    serverCreated = true;

    const ports = await innerDocker(runtime, outerId, plan.inspectServerPorts);
    assertNoPublishedPortBindings(ports.stdout);
    const network = await innerDocker(runtime, outerId, plan.inspectServerNetwork);
    if (network.stdout.trim() !== networkId) {
      throw new Error(`inner server is not attached only to its private bridge: ${network.stdout.trim()}`);
    }
    const networkWithServer = await innerDocker(runtime, outerId, plan.inspectNetwork);
    const serverEndpoint = assertInternalBridge(networkWithServer.stdout, plan.serverName);
    if (serverEndpoint.networkId !== networkId || serverEndpoint.serverIpv4 === undefined) {
      throw new Error('inner server endpoint inspection changed network identity or omitted IPv4');
    }
    try {
      const loopback = await innerDocker(runtime, outerId, plan.probeServerLoopback, 60_000);
      assertExactProbeNonce('server loopback', loopback.stdout, nonce);
      const ipv4 = await innerDocker(
        runtime,
        outerId,
        bindPublicRegistryWorkloadNetwork(plan.probeServerIpv4, networkId, serverEndpoint.serverIpv4),
        60_000,
      );
      assertExactProbeNonce('sibling inspected IPv4', ipv4.stdout, nonce);
      const alias = await innerDocker(
        runtime,
        outerId,
        bindPublicRegistryWorkloadNetwork(plan.probeServerAlias, networkId),
        60_000,
      );
      assertExactProbeNonce('sibling target alias', alias.stdout, nonce);
      await innerDocker(runtime, outerId, plan.startHostNetworkServer);
      hostServerCreated = true;
      const hostNetworkMode = await innerDocker(runtime, outerId, plan.inspectHostNetworkServer);
      if (hostNetworkMode.stdout.trim() !== 'host') {
        throw new Error(`dedicated host-network service resolved to ${hostNetworkMode.stdout.trim()}`);
      }
      const hostLoopback = await innerDocker(runtime, outerId, plan.probeHostNetworkServerLoopback, 60_000);
      assertExactProbeNonce('host-network server loopback', hostLoopback.stdout, nonce);
      await assertAgentShellDoesNotReturnNonce(
        runtime,
        outerId,
        plan.hostServerPort,
        nonce,
        'nested host-network service',
      );
      if (await localhostReturnsExactNonce(plan.hostServerPort, nonce)) {
        throw new Error(
          `smoke host unexpectedly reached nested host-network nonce on localhost:${plan.hostServerPort}`,
        );
      }
      await assertAgentShellDoesNotReturnNonce(runtime, outerId, 8080, nonce, 'unpublished managed-bridge service');

      await innerDocker(runtime, outerId, bindPublicRegistryWorkloadNetwork(plan.startPublishedServer, networkId));
      publishedServerCreated = true;
      const publishedLoopback = await innerDocker(runtime, outerId, plan.probePublishedServerLoopback, 60_000);
      assertExactProbeNonce('published server loopback', publishedLoopback.stdout, nonce);
      const publishedPorts = await innerDocker(runtime, outerId, plan.inspectPublishedServerPorts);
      assertNoPublishedPortBindings(publishedPorts.stdout);
      await assertAgentShellDoesNotReturnNonce(runtime, outerId, plan.publishedHostPort, nonce, 'nested -p service');
      if (await localhostReturnsExactNonce(plan.publishedHostPort, nonce)) {
        throw new Error(`smoke host unexpectedly reached nested -p nonce on localhost:${plan.publishedHostPort}`);
      }
    } catch (error) {
      const state = await captureInnerDockerDiagnostic(runtime, outerId, [
        'container',
        'inspect',
        '--format',
        '{{json .State}}',
        plan.serverName,
      ]);
      const logs = await captureInnerDockerDiagnostic(runtime, outerId, ['container', 'logs', plan.serverName]);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; ` + `serverState=${state}; serverLogs=${logs}`,
        { cause: error },
      );
    }
  } finally {
    if (defaultContainerCreated) {
      await innerDocker(runtime, outerId, plan.removeDefaultNetworkContainer).catch(() => {});
    }
    if (publishedServerCreated) await innerDocker(runtime, outerId, plan.removePublishedServer).catch(() => {});
    if (hostServerCreated) await innerDocker(runtime, outerId, plan.removeHostNetworkServer).catch(() => {});
    if (serverCreated) await innerDocker(runtime, outerId, plan.removeServer).catch(() => {});
    if (imagePulled) await innerDocker(runtime, outerId, plan.removeImage).catch(() => {});
  }

  const containers = await innerDocker(runtime, outerId, ['container', 'ls', '--all', '--quiet']);
  if (containers.stdout.trim() !== '') throw new Error('private Docker inventory retained a smoke container');
  if (managedNetworkId === undefined) {
    throw new Error('private Docker never established the bundle-managed internal bridge identity');
  }
  const finalNetworkProfile = await innerDocker(runtime, outerId, plan.inspectNetwork);
  const finalNetwork = assertEmptyInternalBridge(finalNetworkProfile.stdout);
  if (finalNetwork.networkId !== managedNetworkId) {
    throw new Error('private Docker lost or replaced the bundle-managed internal bridge');
  }
  const image = await innerDocker(runtime, outerId, ['image', 'ls', '--quiet', plan.image]);
  if (image.stdout.trim() !== '') throw new Error('private Docker inventory retained the pulled smoke image');
}

async function verifyAgentDockerEnvironment(
  runtime: ReturnType<typeof createContainerRuntime>,
  outerId: string,
): Promise<void> {
  const result = await runtime.exec(outerId, ['/usr/bin/env'], 10_000, 'codespace');
  if (result.exitCode !== 0) {
    throw new Error(`agent environment inspection failed: ${boundedDiagnostic(result.stderr)}`);
  }
  assertExactAgentDockerEnvironment(result.stdout);
}

async function assertAgentShellDoesNotReturnNonce(
  runtime: ReturnType<typeof createContainerRuntime>,
  outerId: string,
  port: number,
  nonce: string,
  stage: string,
): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('agent-shell probe port is invalid');
  if (!/^[a-f0-9]{32,128}$/u.test(nonce)) throw new Error('agent-shell probe nonce is invalid');
  const result = await runtime.exec(
    outerId,
    [
      '/usr/bin/curl',
      '--noproxy',
      '*',
      '--connect-timeout',
      '2',
      '--max-time',
      '3',
      '--max-filesize',
      '4096',
      '--silent',
      '--show-error',
      `http://127.0.0.1:${port}/`,
    ],
    10_000,
    'codespace',
  );
  if (isExactSmokeNonceResponse(result.stdout, nonce)) {
    throw new Error(`agent shell unexpectedly received the exact ${stage} nonce on localhost:${port}`);
  }
}

/** Direct smoke-process probe; connection failure or unrelated bounded content is acceptable. */
async function localhostReturnsExactNonce(port: number, nonce: string): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('host probe port is invalid');
  if (!/^[a-f0-9]{32,128}$/u.test(nonce)) throw new Error('host probe nonce is invalid');
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const request = httpGet({ hostname: '127.0.0.1', port, path: '/', agent: false }, (response) => {
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4096) {
          response.destroy();
          settle(false);
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => settle(isExactSmokeNonceResponse(Buffer.concat(chunks).toString('utf8'), nonce)));
      response.once('error', () => settle(false));
    });
    request.setTimeout(3_000, () => {
      request.destroy();
      settle(false);
    });
    request.once('error', () => settle(false));
  });
}

function assertExactProbeNonce(stage: string, value: string, nonce: string): void {
  if (!isExactSmokeNonceResponse(value, nonce)) {
    throw new Error(`${stage} probe did not return the exact random nonce: ${boundedDiagnostic(value)}`);
  }
}

const DIAGNOSTIC_TEXT_LIMIT = 4096;

function boundedDiagnostic(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= DIAGNOSTIC_TEXT_LIMIT) return JSON.stringify(normalized);
  return JSON.stringify(`${normalized.slice(0, DIAGNOSTIC_TEXT_LIMIT)}...[truncated]`);
}

async function captureInnerDockerDiagnostic(
  runtime: ReturnType<typeof createContainerRuntime>,
  outerId: string,
  args: readonly string[],
): Promise<string> {
  try {
    const result = await runtime.exec(outerId, [DOCKER_CLIENT, '--host', DOCKER_HOST, ...args], 10_000, 'codespace');
    return `exit=${result.exitCode} stdout=${boundedDiagnostic(result.stdout)} stderr=${boundedDiagnostic(result.stderr)}`;
  } catch (error) {
    return `capture-failed=${boundedDiagnostic(error instanceof Error ? error.message : String(error))}`;
  }
}

async function verifyPrivateDockerBaseline(
  runtime: ReturnType<typeof createContainerRuntime>,
  outerId: string,
  auditPath: string,
): Promise<string> {
  const info = await innerDocker(runtime, outerId, ['info', '--format', '{{json .}}']);
  const parsedInfo = JSON.parse(info.stdout) as { Driver?: string; SecurityOptions?: readonly string[] };
  if (parsedInfo.Driver !== 'vfs' || !parsedInfo.SecurityOptions?.some((item) => item.includes('rootless'))) {
    throw new Error(`private Docker is not rootless+vfs: ${info.stdout.trim()}`);
  }
  const managedNetwork = await innerDocker(runtime, outerId, [
    'network',
    'inspect',
    '--format',
    '{{json .}}',
    APPLE_VM_DOCKER_WORKLOAD_NETWORK,
  ]);
  assertInternalBridge(managedNetwork.stdout);

  const expectedImageId = readPreparedInnerImageId(auditPath);
  const inspected = await innerDocker(runtime, outerId, ['image', 'inspect', '--format', '{{.Id}}', SELECTED_IMAGE]);
  if (inspected.stdout.trim() !== expectedImageId) {
    throw new Error('selected inner image immutable ID differs from the prepared artifact observation');
  }
  return expectedImageId;
}

function readPreparedInnerImageId(auditPath: string): string {
  if (!existsSync(auditPath)) throw new Error(`Docker-workload audit log is missing: ${auditPath}`);
  const events = readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  const event = events.find(
    (candidate): candidate is { kind: 'private-docker-bootstrap'; artifact: { innerDockerImageId: string } } => {
      if (candidate === null || typeof candidate !== 'object') return false;
      const record = candidate as { kind?: unknown; artifact?: unknown };
      if (
        record.kind !== 'private-docker-bootstrap' ||
        record.artifact === null ||
        typeof record.artifact !== 'object'
      ) {
        return false;
      }
      return /^sha256:[a-f0-9]{64}$/u.test(
        String((record.artifact as { innerDockerImageId?: unknown }).innerDockerImageId),
      );
    },
  );
  if (event === undefined) throw new Error('Docker-workload audit lacks a prepared selected-agent observation');
  return event.artifact.innerDockerImageId;
}

async function verifyClosedBundle(options: {
  readonly runtime: ReturnType<typeof createContainerRuntime>;
  readonly active: ActiveBundle;
  readonly outerId: string;
  readonly smokeHome: string;
  readonly supervisorStatusPath: string;
  readonly supervisorPid: number;
  readonly supervisorIdentity: string;
  readonly leaseTimeoutMs?: number;
}): Promise<void> {
  const closed = await waitForClosedLease(options.active.leasePath, options.leaseTimeoutMs);
  assertClosedLeaseProof(closed, options.outerId);
  if (await options.runtime.containerExists(options.outerId)) {
    throw new Error(`exact outer VM still exists: ${options.outerId}`);
  }
  if (options.runtime.listContainers === undefined) throw new Error('Apple runtime cannot inventory containers');
  const outerResource = closed.resources.find((resource) => resource.observedId === options.outerId);
  if (outerResource === undefined) throw new Error('closed lease lost exact outer resource');
  const owned = await options.runtime.listContainers({
    labelFilter: `${outerResource.ownershipLabelKey}=${outerResource.ownershipLabelValue}`,
  });
  if (owned.length !== 0) throw new Error('generation-owned Apple VM inventory is not empty');
  if (existsSync(closed.paths.stateRoot)) throw new Error('revocable state root still exists');
  const runtimeRoot = withIronCurtainHome(options.smokeHome, () =>
    getBundleRuntimeRoot(options.active.sessionId as BundleId),
  );
  if (existsSync(runtimeRoot)) throw new Error('per-bundle runtime root still exists');
  const finalSupervisor = loadResourceWatchdogSupervisorStatus(options.supervisorStatusPath);
  if (finalSupervisor.state !== 'closed') throw new Error(`watchdog supervisor ended in ${finalSupervisor.state}`);
  await waitForProcessIdentityExit(options.supervisorPid, options.supervisorIdentity, 10_000);
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

function redact(value: string): string {
  return value.replaceAll(FAKE_API_KEY, '[REDACTED_FAKE_KEY]');
}

const mode = parseNestedAppleSmokeMode(process.argv.slice(2));
if (mode === 'pty') await mainPty();
else await main(mode);
