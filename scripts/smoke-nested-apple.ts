#!/usr/bin/env tsx

/** Production-entrypoint smoke for the admitted macOS secure-nested-Docker backends. */

import { execFile as execFileCallback, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
import { promisify } from 'node:util';
import { loadDockerWorkloadLease, type DockerWorkloadLease } from '../src/docker-workload/bundle-lease.js';
import {
  dockerWorkloadConfigHash,
  resolveDockerWorkloadConfig,
  type DockerWorkloadNetworkAccess,
} from '../src/docker-workload/config.js';
import { getProcessStartIdentity } from '../src/docker-workload/process-lock.js';
import { APPLE_VM_DOCKER_WORKLOAD_NETWORK } from '../src/docker-workload/apple-private-docker.js';
import type { DockerWorkloadAuditEvent } from '../src/docker-workload/lifecycle-evidence.js';
import {
  createPrivateDockerClient,
  PRIVATE_DOCKER_CLIENT,
  PRIVATE_DOCKER_HOST,
} from '../src/docker-workload/private-docker.js';
import { loadResourceWatchdogSupervisorStatus } from '../src/docker-workload/resource-watchdog-supervisor.js';
import { createContainerRuntime, type ContainerRuntimeKind } from '../src/docker/container-runtime.js';
import { CONTAINER_WORKSPACE_DIR } from '../src/docker/container-workspace.js';
import { IRONCURTAIN_LABEL_BUNDLE } from '../src/docker/docker-manager.js';
import { DEFAULT_PTY_PORT } from '../src/docker/pty-types.js';
import {
  getBundleControlSocketPath,
  getBundleMitmControlSocketPath,
  getBundleMitmProxySocketPath,
  getBundleProxySocketPath,
  getBundleRegistryEgressSocketPath,
  getBundleRuntimeRoot,
} from '../src/config/paths.js';
import { createPtyBridge, type PtyBridge } from '../src/pty/pty-bridge.js';
import { getBundleShortId, type BundleId, type SessionMetadata } from '../src/session/types.js';
import { DOCKER_BUILDX_INSTANCES_DIRECTORY, DOCKER_BUILDX_STATE_DIRECTORY } from '../src/docker/docker-build-shim.js';
import {
  appendBoundedOutput,
  hasClaudeTuiEvidence,
  renderCurrentTerminalScreen,
  resetTerminalEvidenceViewport,
} from './smoke-nested-apple-tui.js';
import {
  DENIED_REGISTRY_SMOKE_IMAGE,
  DOCKER_DESKTOP_OFFLINE_ARCHIVE,
  DOCKER_DESKTOP_OFFLINE_MARKER,
  DOCKER_DESKTOP_WORKSPACE_INPUT,
  DOCKER_DESKTOP_WORKSPACE_OUTPUT,
  PUBLIC_REGISTRY_SMOKE_IMAGE,
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
  dockerDesktopSmokeNetworkAccess,
  isDockerDesktopSmokeMode,
  isExactSmokeNonceResponse,
  parseNestedAppleSmokeMode,
  type NestedAppleSmokeMode,
} from './smoke-nested-apple-workload.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const CLI_PATH = resolve(PACKAGE_ROOT, 'dist', 'cli.js');
const SELECTED_IMAGE = 'ironcurtain-claude-code:latest';
const TIMEOUT_MS = 60 * 60_000;
const PTY_ACTIVATION_TIMEOUT_MS = 15 * 60_000;
const PTY_TUI_TIMEOUT_MS = 60_000;
const PTY_GRACEFUL_EXIT_TIMEOUT_MS = 30_000;
const SMOKE_DOCKER_RESOURCES = { memoryMb: 4096, cpus: 2 } as const;
const SMOKE_DOCKER_PIDS = 512;
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
  readonly runtimeKind: ContainerRuntimeKind;
}

interface OfflineFixture {
  readonly image: string;
  readonly archivePath: string;
  readonly workspaceInputPath: string;
  readonly workspaceOutputPath: string;
  readonly hostWorkspaceOutputPath: string;
  readonly excludedHostPath: string;
}

interface SmokeCliProcess {
  readonly child: ChildProcessWithoutNullStreams;
  output(): { readonly stdout: string; readonly stderr: string };
}

async function main(mode: Exclude<NestedAppleSmokeMode, 'pty' | 'docker-desktop-pty'>): Promise<void> {
  const environment = prepareSmokeEnvironment(mode);
  if (mode === 'docker-desktop-disabled') {
    await mainDockerDesktopDisabled(environment);
    return;
  }
  const { smokeRoot, smokeHome, workspace, expectedConfigHash, runtimeKind } = environment;
  try {
    const offlineFixture =
      mode === 'docker-desktop-offline' ? await stageDockerDesktopOfflineFixture(smokeRoot, workspace) : undefined;
    const argv = [CLI_PATH, 'start', '--agent', 'claude-code', '--workspace', workspace];
    const smokeCli = startSmokeCli(environment);
    const child = smokeCli.child;
    process.stderr.write(
      `nested ${runtimeKind} smoke argv=${JSON.stringify([process.execPath, ...argv])} cwd=${dirname(smokeRoot)}\n`,
    );

    let succeeded = false;
    let activeBundle: ActiveBundle | undefined;
    try {
      const active = await waitForActiveBundle(
        smokeHome,
        () => assertChildRunning(child, 'while waiting for activation'),
        expectedConfigHash,
        runtimeKind,
      );
      activeBundle = active;
      const outerId = requireAgentOuterId(active.lease);
      const registryEgressSocketPath = withIronCurtainHome(smokeHome, () =>
        getBundleRegistryEgressSocketPath(active.sessionId as BundleId),
      );
      if (runtimeKind === 'apple-container' && mode === 'public-registry') {
        if (!existsSync(registryEgressSocketPath) || !statSync(registryEgressSocketPath).isSocket()) {
          throw new Error('active public-registry bundle lacks its exact host registry-egress listener UDS');
        }
      } else if (runtimeKind === 'apple-container' && existsSync(registryEgressSocketPath)) {
        throw new Error('active preloaded-only bundle unexpectedly provisioned a registry-egress listener UDS');
      }
      const supervisorStatusPath = resolve(dirname(active.leasePath), 'status.json');
      const supervisor = loadResourceWatchdogSupervisorStatus(supervisorStatusPath);
      const supervisorIdentity = getProcessStartIdentity(supervisor.supervisorPid);
      if (supervisorIdentity === undefined) throw new Error('watchdog supervisor is not alive at smoke activation');
      assertChildRunning(child, 'before private-Docker operation');

      const runtime = createContainerRuntime(runtimeKind);
      await verifyAgentDockerEnvironment(runtime, outerId);
      const selectedImageId = await verifyPrivateDockerBaseline(
        runtime,
        outerId,
        resolve(smokeHome, 'sessions', active.sessionId, 'audit.jsonl'),
        runtimeKind,
      );
      const before = await innerDocker(runtime, outerId, ['container', 'ls', '--all', '--quiet']);
      if (before.stdout.trim() !== '') throw new Error('private Docker inventory was not empty before smoke child');

      const desktopNetworkAccess = dockerDesktopSmokeNetworkAccess(mode);
      if (desktopNetworkAccess !== undefined) {
        await verifyDockerDesktopOuterTopology(
          runtime,
          outerId,
          active.lease,
          active.sessionId as BundleId,
          desktopNetworkAccess,
        );
      }
      if (mode === 'docker-desktop-recovery') {
        child.kill('SIGKILL');
        await waitForExit(child, 10_000);
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
        assertNoProviderRequest(resolve(smokeHome, 'sessions', active.sessionId, 'audit.jsonl'));
        await verifyPostCrashReadmission({
          smokeRoot,
          smokeHome,
          workspace,
          expectedConfigHash,
          previousLeaseId: active.lease.leaseId,
        });
        succeeded = true;
        process.stderr.write(`nested docker crash-recovery smoke passed (session=${active.sessionId})\n`);
        return;
      } else if (mode === 'docker-desktop-offline') {
        if (offlineFixture === undefined) throw new Error('Docker Desktop offline fixture was not staged');
        await verifyDockerDesktopOfflineWorkload(runtime, outerId, offlineFixture);
      } else if (mode === 'docker-desktop-packages') {
        await verifyDockerDesktopPackageBuild(runtime, outerId);
      } else if (mode === 'public-registry' || mode === 'docker-desktop-images') {
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
      if (exitCode !== 0) {
        const output = smokeCli.output();
        throw new Error(`CLI exited ${exitCode}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
      }

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
        `nested ${runtimeKind} ${mode} smoke passed (session=${active.sessionId}, outer=${outerId})\n`,
      );
    } finally {
      try {
        await terminateSmokeCli(child);
        const cleanupLeasePath = activeBundle?.leasePath ?? discoverSoleLeasePath(smokeHome);
        if (!succeeded && cleanupLeasePath !== undefined) {
          // A detached watchdog must close an orphaned bundle after a forced CLI
          // death. Do not silently return from a failed smoke with live authority.
          await waitForClosedLeaseWithin(cleanupLeasePath, 180_000);
        }
      } finally {
        if (succeeded) rmSync(smokeRoot, { recursive: true, force: true });
        else {
          const output = smokeCli.output();
          process.stderr.write(
            `nested Docker smoke retained diagnostics at ${smokeRoot}\nstdout:\n${redact(output.stdout)}\nstderr:\n${redact(output.stderr)}\n`,
          );
        }
      }
    }
  } catch (error) {
    process.stderr.write(`nested Docker smoke failed; diagnostics retained at ${smokeRoot}\n`);
    throw error;
  }
}

/** Prove the real product path creates no nested-Docker authority when disabled. */
async function mainDockerDesktopDisabled(environment: SmokeEnvironment): Promise<void> {
  const { smokeRoot, smokeHome } = environment;
  const runtime = createContainerRuntime('docker');
  const smokeCli = startSmokeCli(environment);
  const child = smokeCli.child;
  let sessionId: string | undefined;
  let succeeded = false;
  try {
    const disabled = await poll('feature-disabled Docker session', async () => {
      assertChildRunning(child, 'while waiting for the feature-disabled session');
      const sessionsRoot = resolve(smokeHome, 'sessions');
      if (!existsSync(sessionsRoot)) return undefined;
      for (const candidate of readdirSync(sessionsRoot)) {
        const metadataPath = resolve(sessionsRoot, candidate, 'session-metadata.json');
        if (!existsSync(metadataPath)) continue;
        const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as SessionMetadata;
        if (metadata.dockerWorkload !== undefined) {
          throw new Error('feature-disabled session persisted nested-Docker metadata');
        }
        if (runtime.listContainers === undefined) throw new Error('Docker runtime cannot inventory containers');
        const owned = await runtime.listContainers({ labelFilter: `${IRONCURTAIN_LABEL_BUNDLE}=${candidate}` });
        const agentName = `ironcurtain-${getBundleShortId(candidate as BundleId)}`;
        const agent = owned.find((container) => container.name === agentName && container.running);
        if (agent !== undefined) return { sessionId: candidate, outerId: agent.id };
      }
      return undefined;
    });
    sessionId = disabled.sessionId;
    const environmentResult = await runtime.exec(disabled.outerId, ['/usr/bin/env'], 10_000, 'codespace');
    if (environmentResult.exitCode !== 0) {
      throw new Error(`feature-disabled environment inspection failed: ${boundedDiagnostic(environmentResult.stderr)}`);
    }
    if (/^(?:DOCKER_HOST|IRONCURTAIN_DOCKER_NETWORK)=/mu.test(environmentResult.stdout)) {
      throw new Error('feature-disabled agent received nested-Docker environment authority');
    }
    if (discoverSoleLeasePath(smokeHome) !== undefined) {
      throw new Error('feature-disabled session created a Docker-workload lease');
    }

    child.stdin.end('/quit\n');
    const exitCode = await waitForExit(child, 90_000);
    if (exitCode !== 0) {
      const output = smokeCli.output();
      throw new Error(
        `feature-disabled CLI exited ${exitCode}; stdout=${redact(output.stdout)} stderr=${redact(output.stderr)}`,
      );
    }
    if (runtime.listContainers === undefined) throw new Error('Docker runtime cannot inventory containers');
    await poll(
      'feature-disabled outer cleanup',
      async () => {
        const owned = await runtime.listContainers!({
          labelFilter: `${IRONCURTAIN_LABEL_BUNDLE}=${disabled.sessionId}`,
        });
        return owned.length === 0 ? true : undefined;
      },
      180_000,
    );
    assertNoProviderRequest(resolve(smokeHome, 'sessions', disabled.sessionId, 'audit.jsonl'));
    succeeded = true;
    process.stderr.write(`nested docker feature-disabled smoke passed (session=${disabled.sessionId})\n`);
  } finally {
    await terminateSmokeCli(child);
    const cleanupLeasePath = discoverSoleLeasePath(smokeHome);
    if (!succeeded && cleanupLeasePath !== undefined) {
      await waitForClosedLeaseWithin(cleanupLeasePath, 180_000);
    }
    if (succeeded) rmSync(smokeRoot, { recursive: true, force: true });
    else {
      const output = smokeCli.output();
      process.stderr.write(
        `nested Docker feature-disabled smoke retained diagnostics at ${smokeRoot}` +
          `${sessionId === undefined ? '' : ` (session=${sessionId})`}\n` +
          `stdout:\n${redact(output.stdout)}\nstderr:\n${redact(output.stderr)}\n`,
      );
    }
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
    const runtimeKind: ContainerRuntimeKind = isDockerDesktopSmokeMode(mode) ? 'docker' : 'apple-container';
    const resolvedWorkload = resolveDockerWorkloadConfig(requestedWorkload, SMOKE_DOCKER_RESOURCES);
    const expectedConfigHash = dockerWorkloadConfigHash(resolvedWorkload);
    writePrivateJson(resolve(smokeHome, 'config.json'), {
      anthropicApiKey: FAKE_API_KEY,
      preferredMode: 'container',
      preferredDockerAgent: 'claude-code',
      containerRuntime: runtimeKind,
      dockerResources: SMOKE_DOCKER_RESOURCES,
      dockerWorkload: requestedWorkload,
      ...(providerBaseUrl === undefined ? {} : { anthropicBaseUrl: providerBaseUrl }),
    });
    return { smokeRoot, smokeHome, workspace, expectedConfigHash, runtimeKind };
  } catch (error) {
    process.stderr.write(`nested Apple smoke setup failed; diagnostics retained at ${smokeRoot}\n`);
    throw error;
  }
}

/**
 * Build one tiny, test-only Linux image without a registry and save it into the
 * ordinary workspace. This deliberately does not export the selected agent or
 * any other production image. The Offline gate later consumes only this file.
 */
async function stageDockerDesktopOfflineFixture(smokeRoot: string, workspace: string): Promise<OfflineFixture> {
  const goArchitecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : undefined;
  if (goArchitecture === undefined) throw new Error(`Docker Desktop offline fixture does not support ${process.arch}`);

  const contextDirectory = resolve(smokeRoot, 'offline-fixture-context');
  const sourcePath = resolve(contextDirectory, 'main.go');
  const binaryPath = resolve(contextDirectory, 'probe');
  const archivePath = resolve(workspace, DOCKER_DESKTOP_OFFLINE_ARCHIVE);
  const hostWorkspaceInputPath = resolve(workspace, DOCKER_DESKTOP_WORKSPACE_INPUT);
  const hostWorkspaceOutputPath = resolve(workspace, DOCKER_DESKTOP_WORKSPACE_OUTPUT);
  const excludedHostPath = resolve(smokeRoot, 'host-only-workspace-sentinel');
  const image = `localhost/ironcurtain-offline-smoke:${randomBytes(12).toString('hex')}`;
  let imageCreated = false;
  mkdirSync(contextDirectory, { mode: 0o700 });
  mkdirSync(dirname(archivePath), { mode: 0o700 });
  writeFileSync(
    sourcePath,
    [
      'package main',
      'import ("fmt"; "os")',
      'func main() {',
      `  if len(os.Args) == 4 && os.Args[1] == "workspace" {`,
      '    value, err := os.ReadFile(os.Args[2]); if err != nil { panic(err) }',
      `    if string(value) != ${JSON.stringify(`${DOCKER_DESKTOP_OFFLINE_MARKER}\n`)} { panic("workspace marker mismatch") }`,
      '    if err := os.WriteFile(os.Args[3], value, 0644); err != nil { panic(err) }',
      '    return',
      '  }',
      `  fmt.Println(${JSON.stringify(DOCKER_DESKTOP_OFFLINE_MARKER)})`,
      '}',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(
    resolve(contextDirectory, 'Dockerfile'),
    'FROM scratch\nCOPY --chmod=0555 probe /probe\nENTRYPOINT ["/probe"]\n',
    { mode: 0o600 },
  );

  try {
    await runHostCommand(
      'go',
      ['build', '-trimpath', '-ldflags=-s -w -buildid=', '-o', binaryPath, sourcePath],
      120_000,
      { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: goArchitecture },
    );
    await runHostCommand(
      'docker',
      ['build', '--pull=false', '--network=none', '--tag', image, contextDirectory],
      300_000,
    );
    imageCreated = true;
    await runHostCommand('docker', ['image', 'save', '--output', archivePath, image], 120_000);
    chmodSync(archivePath, 0o644);
    writeFileSync(hostWorkspaceInputPath, `${DOCKER_DESKTOP_OFFLINE_MARKER}\n`, { mode: 0o644 });
    writeFileSync(excludedHostPath, 'must-not-be-visible-to-the-nested-daemon\n', { mode: 0o600 });
    return {
      image,
      archivePath: `${CONTAINER_WORKSPACE_DIR}/${DOCKER_DESKTOP_OFFLINE_ARCHIVE}`,
      workspaceInputPath: `${CONTAINER_WORKSPACE_DIR}/${DOCKER_DESKTOP_WORKSPACE_INPUT}`,
      workspaceOutputPath: `${CONTAINER_WORKSPACE_DIR}/${DOCKER_DESKTOP_WORKSPACE_OUTPUT}`,
      hostWorkspaceOutputPath,
      excludedHostPath,
    };
  } finally {
    if (imageCreated) await runHostCommand('docker', ['image', 'rm', '--force', image], 60_000);
  }
}

async function runHostCommand(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  environment?: Readonly<Record<string, string>>,
): Promise<void> {
  const execFile = promisify(execFileCallback);
  try {
    await execFile(executable, [...args], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: environment === undefined ? process.env : { ...process.env, ...environment },
    });
  } catch (error) {
    const failure = error as Error & { readonly stdout?: unknown; readonly stderr?: unknown };
    const stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : '';
    throw new Error(
      `${executable} ${args[0] ?? '<empty>'} failed: stdout=${boundedDiagnostic(stdout)} stderr=${boundedDiagnostic(stderr)}`,
      { cause: error },
    );
  }
}

function smokeChildEnvironment(smokeHome: string, runtimeKind: ContainerRuntimeKind): NodeJS.ProcessEnv {
  return { ...process.env, ...smokeEnvironmentValues(smokeHome, runtimeKind) };
}

function startSmokeCli(environment: SmokeEnvironment): SmokeCliProcess {
  const argv = [CLI_PATH, 'start', '--agent', 'claude-code', '--workspace', environment.workspace];
  const child = spawn(process.execPath, argv, {
    cwd: dirname(environment.smokeRoot),
    env: smokeChildEnvironment(environment.smokeHome, environment.runtimeKind),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = appendBoundedOutput(stdout, chunk.toString('utf8'));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = appendBoundedOutput(stderr, chunk.toString('utf8'));
  });
  return { child, output: () => ({ stdout, stderr }) };
}

async function terminateSmokeCli(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.write('/quit\n');
  child.stdin.end();
  await waitForExit(child, 60_000).catch(() => {});
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await waitForExit(child, 60_000).catch(() => {});
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForExit(child, 10_000).catch(() => {});
  }
}

function smokeEnvironmentValues(
  smokeHome: string,
  runtimeKind: ContainerRuntimeKind = 'apple-container',
): Readonly<Record<string, string>> {
  return {
    IRONCURTAIN_HOME: smokeHome,
    IRONCURTAIN_CONTAINER_RUNTIME: runtimeKind,
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
async function mainPty(mode: 'pty' | 'docker-desktop-pty'): Promise<void> {
  const providerSink = await startRejectingProviderSink();
  let environment: SmokeEnvironment;
  try {
    environment = prepareSmokeEnvironment(mode, providerSink.url);
  } catch (error) {
    await closeServer(providerSink.server);
    throw error;
  }
  const { smokeRoot, smokeHome, workspace, expectedConfigHash, runtimeKind } = environment;
  const restoreEnvironment = installSmokeProcessEnvironment(smokeHome, runtimeKind);
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
      `nested ${runtimeKind} PTY smoke argv=${JSON.stringify([
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
      runtimeKind,
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

    const runtime = createContainerRuntime(runtimeKind);
    await verifyAgentDockerEnvironment(runtime, outerId);
    await verifyPrivateDockerBaseline(
      runtime,
      outerId,
      resolve(smokeHome, 'sessions', active.sessionId, 'audit.jsonl'),
      runtimeKind,
    );
    if (runtimeKind === 'docker') {
      await verifyDockerDesktopOuterTopology(
        runtime,
        outerId,
        active.lease,
        active.sessionId as BundleId,
        'offline',
        'pty',
      );
    }

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
    process.stderr.write(`nested ${runtimeKind} PTY smoke passed (session=${active.sessionId}, outer=${outerId})\n`);
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
          `nested ${runtimeKind} PTY smoke retained diagnostics at ${smokeRoot}\nPTY output tail:\n${redact(diagnosticOutput)}\n`,
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

function installSmokeProcessEnvironment(smokeHome: string, runtimeKind: ContainerRuntimeKind): () => void {
  const values = smokeEnvironmentValues(smokeHome, runtimeKind);
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
  runtimeKind: ContainerRuntimeKind,
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
        if (metadata.dockerWorkload.backend !== runtimeKind || metadata.dockerWorkload.configHash !== configHash) {
          throw new Error(`persisted Docker-workload metadata does not match the admitted ${runtimeKind} config`);
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
        if (lease.status !== 'active') continue;
        return { sessionId, leasePath, lease };
      }
      return undefined;
    },
    timeoutMs,
  );
}

/** A killed coordinator must not prevent a subsequent admission in the same isolated home. */
async function verifyPostCrashReadmission(options: {
  readonly smokeRoot: string;
  readonly smokeHome: string;
  readonly workspace: string;
  readonly expectedConfigHash: string;
  readonly previousLeaseId: string;
}): Promise<void> {
  const smokeCli = startSmokeCli({
    smokeRoot: options.smokeRoot,
    smokeHome: options.smokeHome,
    workspace: options.workspace,
    expectedConfigHash: options.expectedConfigHash,
    runtimeKind: 'docker',
  });
  const child = smokeCli.child;
  let active: ActiveBundle | undefined;
  try {
    active = await waitForActiveBundle(
      options.smokeHome,
      () => assertChildRunning(child, 'while waiting for post-crash readmission'),
      options.expectedConfigHash,
      'docker',
    );
    if (active.lease.leaseId === options.previousLeaseId) {
      throw new Error('post-crash admission reused the closed lease identity');
    }
    const outerId = requireAgentOuterId(active.lease);
    const supervisorStatusPath = resolve(dirname(active.leasePath), 'status.json');
    const supervisor = loadResourceWatchdogSupervisorStatus(supervisorStatusPath);
    const supervisorIdentity = getProcessStartIdentity(supervisor.supervisorPid);
    if (supervisorIdentity === undefined) throw new Error('post-crash watchdog supervisor is not alive');
    child.stdin.end('/quit\n');
    const exitCode = await waitForExit(child, 90_000);
    if (exitCode !== 0) {
      const output = smokeCli.output();
      throw new Error(
        `post-crash CLI exited ${exitCode}; stdout=${redact(output.stdout)} stderr=${redact(output.stderr)}`,
      );
    }
    await verifyClosedBundle({
      runtime: createContainerRuntime('docker'),
      active,
      outerId,
      smokeHome: options.smokeHome,
      supervisorStatusPath,
      supervisorPid: supervisor.supervisorPid,
      supervisorIdentity,
      leaseTimeoutMs: 180_000,
    });
  } finally {
    await terminateSmokeCli(child);
    if (active !== undefined) await waitForClosedLeaseWithin(active.leasePath, 180_000);
  }
}

function requireAgentOuterId(lease: DockerWorkloadLease): string {
  const resources = lease.resources.filter((resource) => resource.kind === 'container' && resource.role === 'agent');
  if (resources.length !== 1 || resources[0]?.observedId === null) {
    throw new Error('active lease does not record exactly one immutable agent VM ID');
  }
  return resources[0].observedId;
}

function inspectObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Docker Desktop topology inspect is missing ${label}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function inspectNetworkNames(raw: unknown, label: string): readonly string[] {
  const root = inspectObject(raw, `${label} root`);
  const networkSettings = inspectObject(root.NetworkSettings, `${label} NetworkSettings`);
  const networks = inspectObject(networkSettings.Networks, `${label} Networks`);
  return Object.keys(networks).sort();
}

function assertExactNetworkNames(actual: readonly string[], expected: readonly string[], label: string): void {
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} network drift: expected ${wanted.join(',')}, received ${actual.join(',')}`);
  }
}

async function verifyDockerDesktopOuterTopology(
  runtime: ReturnType<typeof createContainerRuntime>,
  outerId: string,
  lease: DockerWorkloadLease,
  bundleId: BundleId,
  networkAccess: DockerWorkloadNetworkAccess,
  transportMode: 'batch' | 'pty' = 'batch',
): Promise<void> {
  if (runtime.inspectContainerRaw === undefined) {
    throw new Error('Docker Desktop topology smoke requires raw container inspect');
  }
  const egressNetworks = lease.resources.filter(
    (resource) => resource.kind === 'network' && resource.role === 'network' && resource.observedId !== null,
  );
  const transportNetworks = lease.resources.filter(
    (resource) => resource.kind === 'network' && resource.role === 'transport-network' && resource.observedId !== null,
  );
  const daemons = lease.resources.filter(
    (resource) => resource.kind === 'container' && resource.role === 'nested-daemon' && resource.observedId !== null,
  );
  const relays = lease.resources.filter(
    (resource) => resource.kind === 'container' && resource.role === 'fixed-relay' && resource.observedId !== null,
  );
  const transportProxies = lease.resources.filter(
    (resource) => resource.kind === 'container' && resource.role === 'proxy' && resource.observedId !== null,
  );
  const expectedRelayCount = networkAccess === 'packages' ? 2 : networkAccess === 'images' ? 1 : 0;
  const expectedEgressNetworkCount = networkAccess === 'offline' ? 0 : 1;
  if (
    egressNetworks.length !== expectedEgressNetworkCount ||
    transportNetworks.length !== 1 ||
    daemons.length !== 1 ||
    relays.length !== expectedRelayCount ||
    transportProxies.length !== 1
  ) {
    throw new Error(`Docker Desktop ${networkAccess} lease has an incomplete or extra outer topology`);
  }
  const agentRaw = await runtime.inspectContainerRaw(outerId);
  const agentNetworks = inspectNetworkNames(agentRaw, 'agent');
  const egressName = egressNetworks[0]?.requestedName;
  const ordinaryName = transportNetworks[0]!.requestedName;
  assertExactNetworkNames(
    agentNetworks,
    egressName === undefined ? [ordinaryName] : [ordinaryName, egressName],
    'agent',
  );

  const transportName = `ironcurtain-sidecar-${getBundleShortId(bundleId)}`;
  if (transportProxies[0]!.requestedName !== transportName) {
    throw new Error('Docker Desktop lease recorded the wrong ordinary transport proxy');
  }
  const transportRaw = await runtime.inspectContainerRaw(transportProxies[0]!.observedId!);
  assertExactNetworkNames(inspectNetworkNames(transportRaw, 'transport'), ['bridge', ordinaryName], 'transport');
  const daemonId = daemons[0].observedId;
  if (daemonId === null) throw new Error('Docker Desktop private daemon is not observed');
  const daemonRaw = await runtime.inspectContainerRaw(daemonId);
  assertExactNetworkNames(
    inspectNetworkNames(daemonRaw, 'private daemon'),
    networkAccess === 'offline' ? ['none'] : [egressName!],
    'private daemon',
  );
  const effectiveProfiles = [
    inspectBoundedOuterProfile(agentRaw, 'agent'),
    inspectBoundedOuterProfile(transportRaw, 'transport', transportMode === 'pty' ? 'loopback-pty' : 'none'),
    inspectBoundedOuterProfile(daemonRaw, 'private daemon'),
  ];
  for (const relay of relays) {
    if (relay.observedId === null) throw new Error(`Docker Desktop relay ${relay.requestedName} is not observed`);
    const relayRaw = await runtime.inspectContainerRaw(relay.observedId);
    assertExactNetworkNames(
      inspectNetworkNames(relayRaw, `relay ${relay.requestedName}`),
      ['bridge', egressName],
      `relay ${relay.requestedName}`,
    );
    effectiveProfiles.push(inspectBoundedOuterProfile(relayRaw, `relay ${relay.requestedName}`));
  }
  assertAggregateOuterResources(effectiveProfiles);

  const directEgress = await runtime.exec(
    outerId,
    ['socat', '-u', '/dev/null', 'TCP:1.1.1.1:443,connect-timeout=3'],
    5_000,
    'codespace',
  );
  if (directEgress.exitCode === 0) {
    throw new Error('Docker Desktop agent unexpectedly reached the internet without a policy proxy');
  }
  const daemonProbeTool = await runtime.exec(daemonId, ['/bin/sh', '-c', 'command -v wget'], 5_000, 'rootless');
  if (daemonProbeTool.exitCode !== 0 || daemonProbeTool.stdout.trim() === '') {
    throw new Error('Docker Desktop private daemon lacks the fixed direct-egress probe tool');
  }
  const daemonDirectEgress = await runtime.exec(
    daemonId,
    [
      '/bin/sh',
      '-c',
      'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy; exec wget -Y off -T 3 -qO- http://1.1.1.1/',
    ],
    5_000,
    'rootless',
  );
  if (daemonDirectEgress.exitCode === 0) {
    throw new Error('Docker Desktop private daemon unexpectedly reached the internet without a policy proxy');
  }
}

interface BoundedOuterProfile {
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
}

function inspectBoundedOuterProfile(
  raw: unknown,
  label: string,
  portPolicy: 'none' | 'loopback-pty' = 'none',
): BoundedOuterProfile {
  const root = inspectObject(raw, `${label} root`);
  const hostConfig = inspectObject(root.HostConfig, `${label} HostConfig`);
  if (hostConfig.Privileged !== false) throw new Error(`${label} unexpectedly runs privileged`);
  assertOuterPortBindings(hostConfig.PortBindings, label, portPolicy);
  if (hostConfig.Binds !== null && !Array.isArray(hostConfig.Binds)) {
    throw new Error(`${label} bind evidence is missing`);
  }
  const binds = Array.isArray(hostConfig.Binds) ? hostConfig.Binds : [];
  if (
    binds.some(
      (bind) =>
        typeof bind !== 'string' ||
        bind.split(':', 1)[0] === '/' ||
        bind.startsWith('/var/run/docker.sock:') ||
        bind.startsWith('/run/docker.sock:'),
    )
  ) {
    throw new Error(`${label} exposes a prohibited host bind`);
  }
  for (const [field, admitted] of [
    ['PidMode', ['']],
    ['IpcMode', ['', 'private']],
    ['UTSMode', ['']],
    ['UsernsMode', ['']],
    ['CgroupnsMode', ['', 'private']],
  ] as const) {
    const mode = hostConfig[field];
    if (typeof mode !== 'string' || !(admitted as readonly string[]).includes(mode)) {
      throw new Error(`${label} has unsafe ${field}`);
    }
  }
  return {
    memoryBytes: positiveInteger(hostConfig.Memory, `${label} memory`),
    nanoCpus: positiveInteger(hostConfig.NanoCpus, `${label} CPU`),
    pidsLimit: positiveInteger(hostConfig.PidsLimit, `${label} PID limit`),
  };
}

function assertOuterPortBindings(value: unknown, label: string, policy: 'none' | 'loopback-pty'): void {
  const bindings = value === null ? {} : inspectObject(value, `${label} PortBindings`);
  const entries = Object.entries(bindings);
  if (policy === 'none') {
    if (entries.length !== 0) throw new Error(`${label} unexpectedly publishes a host port`);
    return;
  }
  if (entries.length !== 1 || entries[0]![0] !== `${DEFAULT_PTY_PORT}/tcp`) {
    throw new Error(`${label} must publish only the PTY transport port`);
  }
  const published = entries[0]![1];
  if (!Array.isArray(published) || published.length !== 1) {
    throw new Error(`${label} PTY port binding is malformed`);
  }
  const binding = inspectObject(published[0], `${label} PTY port binding`);
  const hostPort = typeof binding.HostPort === 'string' ? Number.parseInt(binding.HostPort, 10) : Number.NaN;
  if (
    binding.HostIp !== '127.0.0.1' ||
    !Number.isSafeInteger(hostPort) ||
    hostPort <= 0 ||
    hostPort > 65_535 ||
    String(hostPort) !== binding.HostPort
  ) {
    throw new Error(`${label} PTY port is not bound to one explicit loopback port`);
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} is not enforced`);
  return value as number;
}

function assertAggregateOuterResources(profiles: readonly BoundedOuterProfile[]): void {
  const totals = profiles.reduce(
    (sum, profile) => ({
      memoryBytes: sum.memoryBytes + profile.memoryBytes,
      nanoCpus: sum.nanoCpus + profile.nanoCpus,
      pidsLimit: sum.pidsLimit + profile.pidsLimit,
    }),
    { memoryBytes: 0, nanoCpus: 0, pidsLimit: 0 },
  );
  const expected = {
    memoryBytes: SMOKE_DOCKER_RESOURCES.memoryMb * 1024 * 1024,
    nanoCpus: SMOKE_DOCKER_RESOURCES.cpus * 1_000_000_000,
    pidsLimit: SMOKE_DOCKER_PIDS,
  };
  if (
    totals.memoryBytes !== expected.memoryBytes ||
    totals.nanoCpus !== expected.nanoCpus ||
    totals.pidsLimit !== expected.pidsLimit
  ) {
    throw new Error(
      `Docker Desktop aggregate resource drift: expected ${JSON.stringify(expected)}, got ${JSON.stringify(totals)}`,
    );
  }
}

async function innerDocker(
  runtime: ReturnType<typeof createContainerRuntime>,
  outerId: string,
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await smokePrivateDockerClient(runtime, outerId).execute(args, timeoutMs);
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
  const result = await smokePrivateDockerClient(runtime, outerId).execute(args, timeoutMs);
  if (result.exitCode === 0) throw new Error(`inner docker ${args[0]} unexpectedly succeeded`);
  return result;
}

function smokePrivateDockerClient(runtime: ReturnType<typeof createContainerRuntime>, outerId: string) {
  return createPrivateDockerClient({
    runtime,
    containerId: outerId,
    dockerCommand: PRIVATE_DOCKER_CLIENT,
    dockerHost: PRIVATE_DOCKER_HOST,
    execUser: 'codespace',
    defaultTimeoutMs: 120_000,
  });
}

async function agentDocker(
  runtime: ReturnType<typeof createContainerRuntime>,
  outerId: string,
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await runtime.exec(outerId, ['docker', ...args], timeoutMs, 'codespace');
  if (result.exitCode !== 0) {
    throw new Error(
      `agent docker ${args[0] ?? '<empty>'} failed (exit ${result.exitCode}); ` +
        `stdout=${boundedDiagnostic(result.stdout)}; stderr=${boundedDiagnostic(result.stderr)}`,
    );
  }
  return result;
}

/** Exercise the documented Offline workflow through the agent-visible client. */
async function verifyDockerDesktopOfflineWorkload(
  runtime: ReturnType<typeof createContainerRuntime>,
  outerId: string,
  fixture: OfflineFixture,
): Promise<void> {
  const deniedPull = await expectAgentDockerFailure(runtime, outerId, ['image', 'pull', PUBLIC_REGISTRY_SMOKE_IMAGE]);
  if (deniedPull.stdout.includes('Downloaded newer image')) {
    throw new Error('Docker Desktop Offline unexpectedly downloaded a public image');
  }
  const deniedInventory = await innerDocker(runtime, outerId, ['image', 'ls', '--quiet', PUBLIC_REGISTRY_SMOKE_IMAGE]);
  if (deniedInventory.stdout.trim() !== '') {
    throw new Error('Docker Desktop Offline denied pull left a public image behind');
  }

  await agentDocker(runtime, outerId, ['image', 'load', '--input', fixture.archivePath], 120_000);
  const loaded = await agentDocker(
    runtime,
    outerId,
    ['image', 'inspect', '--format', '{{.Id}}', fixture.image],
    30_000,
  );
  const imageId = loaded.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) {
    throw new Error(`Docker Desktop Offline loaded image has an invalid immutable ID: ${boundedDiagnostic(imageId)}`);
  }

  const suffix = randomBytes(12).toString('hex');
  const contextDirectory = `/tmp/ic-desktop-offline-smoke-${suffix}`;
  const derivedImage = `localhost/ironcurtain-offline-derived:${suffix}`;
  const dockerfile = `FROM ${fixture.image}\nLABEL org.opencontainers.image.title="ironcurtain-offline-derived"\n`;
  try {
    const output = await agentDocker(
      runtime,
      outerId,
      ['run', '--rm', '--pull=never', '--network=none', imageId],
      60_000,
    );
    if (output.stdout.trim() !== DOCKER_DESKTOP_OFFLINE_MARKER) {
      throw new Error(`offline loaded image returned unexpected output: ${boundedDiagnostic(output.stdout)}`);
    }
    await expectAgentDockerFailure(runtime, outerId, [
      'run',
      '--rm',
      '--pull=never',
      '--network=none',
      '--mount',
      `type=bind,src=${fixture.excludedHostPath},dst=/host-only`,
      imageId,
    ]);
    if (readFileSync(fixture.excludedHostPath, 'utf8') !== 'must-not-be-visible-to-the-nested-daemon\n') {
      throw new Error('nested Docker altered a host path outside the shared workspace');
    }
    await agentDocker(
      runtime,
      outerId,
      [
        'run',
        '--rm',
        '--pull=never',
        '--network=none',
        '--mount',
        `type=bind,src=${CONTAINER_WORKSPACE_DIR},dst=${CONTAINER_WORKSPACE_DIR}`,
        imageId,
        'workspace',
        fixture.workspaceInputPath,
        fixture.workspaceOutputPath,
      ],
      60_000,
    );
    if (
      !existsSync(fixture.hostWorkspaceOutputPath) ||
      readFileSync(fixture.hostWorkspaceOutputPath, 'utf8') !== `${DOCKER_DESKTOP_OFFLINE_MARKER}\n`
    ) {
      throw new Error('nested Docker /workspace bind did not round-trip its exact host marker');
    }
    const context = await runtime.exec(
      outerId,
      [
        '/bin/sh',
        '-eu',
        '-c',
        'umask 077; mkdir "$1"; printf %s "$2" > "$1/Dockerfile"',
        'sh',
        contextDirectory,
        dockerfile,
      ],
      10_000,
      'codespace',
    );
    if (context.exitCode !== 0) {
      throw new Error(`agent could not create the offline build context: ${boundedDiagnostic(context.stderr)}`);
    }
    await agentDocker(
      runtime,
      outerId,
      ['build', '--pull=false', '--network=none', '--tag', derivedImage, contextDirectory],
      120_000,
    );
    const derived = await agentDocker(
      runtime,
      outerId,
      ['run', '--rm', '--pull=never', '--network=none', derivedImage],
      60_000,
    );
    if (derived.stdout.trim() !== DOCKER_DESKTOP_OFFLINE_MARKER) {
      throw new Error(`offline derived image returned unexpected output: ${boundedDiagnostic(derived.stdout)}`);
    }
  } finally {
    await innerDocker(runtime, outerId, ['image', 'rm', '--force', derivedImage]).catch(() => {});
    await innerDocker(runtime, outerId, ['image', 'rm', '--force', fixture.image]).catch(() => {});
  }
}

async function expectAgentDockerFailure(
  runtime: ReturnType<typeof createContainerRuntime>,
  outerId: string,
  args: readonly string[],
  timeoutMs = 30_000,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await runtime.exec(outerId, ['docker', ...args], timeoutMs, 'codespace');
  if (result.exitCode === 0) throw new Error(`agent docker ${args[0]} unexpectedly succeeded`);
  return result;
}

/**
 * Docker Desktop Packages acceptance through the production outer-agent
 * composition. The private daemon is fresh for every bundle, so proving the
 * base is absent before `docker build` makes this a real uncached BuildKit FROM
 * request. The build uses the agent-visible `docker` shim and performs no
 * pre-pull or privilege/permission repair.
 */
async function verifyDockerDesktopPackageBuild(
  runtime: ReturnType<typeof createContainerRuntime>,
  outerId: string,
): Promise<void> {
  const suffix = randomBytes(12).toString('hex');
  const contextDirectory = `/tmp/ic-desktop-package-smoke-${suffix}`;
  const outputImage = `localhost/ironcurtain-package-smoke:${suffix}`;
  const baseImage = 'debian:bookworm-slim';
  const dockerfile = [
    `FROM ${baseImage}`,
    'RUN apt-get update && apt-get install -y --no-install-recommends hello && rm -rf /var/lib/apt/lists/*',
    'CMD ["hello"]',
    '',
  ].join('\n');

  const stateProbe = await runtime.exec(
    outerId,
    [
      '/bin/sh',
      '-eu',
      '-c',
      [
        'state=$1',
        'instances=$2',
        'test -d "$state"',
        'test -d "$instances"',
        'test "$(stat -c %u "$state")" = "$(id -u)"',
        'test "$(stat -c %g "$state")" = "$(id -g)"',
        'probe="$state/.ironcurtain-smoke-$$"',
        ': > "$probe"',
        'rm "$probe"',
      ].join('\n'),
      'sh',
      DOCKER_BUILDX_STATE_DIRECTORY,
      DOCKER_BUILDX_INSTANCES_DIRECTORY,
    ],
    10_000,
    'codespace',
  );
  if (stateProbe.exitCode !== 0) {
    throw new Error(
      `agent Buildx state was not initialized as writable by codespace; ` +
        `stdout=${boundedDiagnostic(stateProbe.stdout)} stderr=${boundedDiagnostic(stateProbe.stderr)}`,
    );
  }

  const context = await runtime.exec(
    outerId,
    [
      '/bin/sh',
      '-eu',
      '-c',
      'umask 077; mkdir "$1"; printf %s "$2" > "$1/Dockerfile"',
      'sh',
      contextDirectory,
      dockerfile,
    ],
    10_000,
    'codespace',
  );
  if (context.exitCode !== 0) {
    throw new Error(`agent could not create its ordinary build context: ${boundedDiagnostic(context.stderr)}`);
  }

  const absentBase = await runtime.exec(
    outerId,
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', baseImage],
    10_000,
    'codespace',
  );
  if (absentBase.exitCode === 0) {
    throw new Error(`fresh private Docker unexpectedly contained the package-build base image: ${baseImage}`);
  }

  await agentDocker(
    runtime,
    outerId,
    ['build', '--pull=false', '--network=host', '--tag', outputImage, contextDirectory],
    10 * 60_000,
  );
  const hello = await agentDocker(runtime, outerId, ['run', '--rm', '--network', 'none', outputImage], 60_000);
  if (!hello.stdout.includes('Hello, world!')) {
    throw new Error(`package-built image returned unexpected output: ${boundedDiagnostic(hello.stdout)}`);
  }
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
    const result = await smokePrivateDockerClient(runtime, outerId).execute(args, 10_000);
    return `exit=${result.exitCode} stdout=${boundedDiagnostic(result.stdout)} stderr=${boundedDiagnostic(result.stderr)}`;
  } catch (error) {
    return `capture-failed=${boundedDiagnostic(error instanceof Error ? error.message : String(error))}`;
  }
}

async function verifyPrivateDockerBaseline(
  runtime: ReturnType<typeof createContainerRuntime>,
  outerId: string,
  auditPath: string,
  runtimeKind: ContainerRuntimeKind,
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

  const expectedImageId = readPreparedInnerImageId(auditPath, runtimeKind);
  if (runtimeKind === 'docker') {
    const initialImages = await innerDocker(runtime, outerId, ['image', 'ls', '--quiet']);
    if (initialImages.stdout.trim() !== '') {
      throw new Error('fresh Docker Desktop private daemon unexpectedly contained an image');
    }
    return expectedImageId;
  }
  const inspected = await innerDocker(runtime, outerId, ['image', 'inspect', '--format', '{{.Id}}', SELECTED_IMAGE]);
  if (inspected.stdout.trim() !== expectedImageId) {
    throw new Error('selected inner image immutable ID differs from the prepared artifact observation');
  }
  return expectedImageId;
}

function readPreparedInnerImageId(auditPath: string, runtimeKind: ContainerRuntimeKind): string {
  if (!existsSync(auditPath)) throw new Error(`Docker-workload audit log is missing: ${auditPath}`);
  type BootstrapEvent = Extract<DockerWorkloadAuditEvent, { kind: 'private-docker-bootstrap' }>;
  const events = readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DockerWorkloadAuditEvent);
  const event = events.find((candidate): candidate is BootstrapEvent => candidate.kind === 'private-docker-bootstrap');
  if (event === undefined) throw new Error('Docker-workload audit lacks a prepared selected-agent observation');
  if (runtimeKind === 'apple-container' && event.image.transport !== 'apple-archive') {
    throw new Error('Apple smoke observed a Docker Desktop image transport');
  }
  if (runtimeKind === 'docker' && event.image.transport !== 'docker-desktop-direct') {
    throw new Error('Docker Desktop smoke observed an Apple image transport');
  }
  const imageId = event.image.transport === 'apple-archive' ? event.image.innerImageId : event.image.outerImageId;
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) {
    throw new Error('Docker-workload audit contains an invalid prepared selected-agent image ID');
  }
  return imageId;
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
  if (closed.runtimeKind === 'docker') {
    const bundleLabel = `${IRONCURTAIN_LABEL_BUNDLE}=${options.active.sessionId}`;
    const bundleContainers = await options.runtime.listContainers({ labelFilter: bundleLabel });
    if (bundleContainers.length !== 0) {
      throw new Error(
        `closed Docker Desktop bundle retained containers: ${bundleContainers.map(({ id }) => id).join(',')}`,
      );
    }
    if (options.runtime.listNetworks === undefined) {
      throw new Error('Docker Desktop runtime cannot inventory bundle networks');
    }
    const bundleNetworks = (await options.runtime.listNetworks()).filter(
      ({ labels }) => labels[IRONCURTAIN_LABEL_BUNDLE] === options.active.sessionId,
    );
    if (bundleNetworks.length !== 0) {
      throw new Error(
        `closed Docker Desktop bundle retained networks: ${bundleNetworks.map(({ id }) => id).join(',')}`,
      );
    }
  }
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
if (mode === 'pty' || mode === 'docker-desktop-pty') await mainPty(mode);
else await main(mode);
