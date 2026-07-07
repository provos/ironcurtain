/**
 * PTY session module -- orchestrates a Docker session where the user's
 * terminal is attached directly to Claude Code's PTY inside the container.
 *
 * Instead of the batch-oriented DockerAgentSession (docker exec per turn),
 * this module provides a native interactive experience by bridging the
 * terminal via a Node.js PTY proxy to a socat-managed PTY inside the container.
 *
 * Architecture:
 *   User terminal -> Node.js PTY proxy -> UDS/TCP -> socat (container)
 *     -> Claude Code (interactive, with PTY)
 *     -> Code Mode Proxy (MCP)
 *     -> mcp-proxy-server (PolicyEngine + Audit)
 */

import { createConnection, createServer } from 'node:net';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';

import type { IronCurtainConfig } from '../config/types.js';
import { createSessionId, getBundleShortId, type BundleId, type SessionMode } from '../session/types.js';
import { buildSessionConfig } from '../session/index.js';
import { validateWorkspacePath } from '../session/workspace-validation.js';
import { CONTAINER_WORKSPACE_DIR } from './agent-adapter.js';
import { PTY_SOCK_NAME, DEFAULT_PTY_PORT, APPLE_PTY_GUEST_SOCK } from './pty-types.js';
import type { PtySessionRegistration, SessionSnapshot } from './pty-types.js';
import type { ContainerRuntime } from './types.js';
import { createEscalationWatcher, atomicWriteJsonSync } from '../escalation/escalation-watcher.js';
import type { EscalationWatcher } from '../escalation/escalation-watcher.js';
import { getSessionDir, getSessionCapturesDir, getPtyRegistryDir, SESSION_STATE_FILENAME } from '../config/paths.js';
import * as logger from '../logger.js';
import { buildDockerClaudeMd } from './claude-md-seed.js';
import { getInternalNetworkName } from './platform.js';
import { cleanupContainers } from './container-lifecycle.js';
import { clampDockerResources } from './resource-limits.js';
import { buildAgentUidRemap, buildUdsSocketMounts } from './docker-infrastructure.js';

export interface PtySessionOptions {
  readonly config: IronCurtainConfig;
  readonly mode: SessionMode & { kind: 'docker' };
  /** Validated workspace path. When provided, replaces the session sandbox. */
  readonly workspacePath?: string;
  /** Session ID to resume. When set, reuses the existing session directory. */
  readonly resumeSessionId?: string;
  /** Persona name. Used to build CLAUDE.md and system prompt augmentation. */
  readonly persona?: string;
  /**
   * Per-session provider-profile selection (OpenRouter integration §9.7).
   * Resolved to the active profile in infra prep. On resume, the persisted
   * snapshot name wins over this field (a conflicting flag is warn-ignored
   * upstream in src/index.ts).
   */
  readonly providerProfileName?: string;
  /**
   * Trajectory-capture override: CLI flag wins over `userConfig.capture.enabled`.
   * `true` forces capture on for this run, `undefined` falls through to config.
   * See docs/designs/mitm-token-trajectory-capture.md §10.
   */
  readonly captureTracesOverride?: boolean;
  /**
   * Override for the PTY attach step. Defaults to the production `attachPty`
   * which proxies the user's terminal into the container PTY socket.
   * Tests inject a stub that performs assertions against the live container
   * (via `docker exec`) and returns an exit code without taking over stdio.
   */
  readonly attach?: PtyAttachFn;
}

export type PtyAttachFn = (options: PtyProxyOptions) => Promise<number>;

/** UDS path (Linux) or { host, port } (macOS). */
export type PtyTarget = string | { readonly host: string; readonly port: number };

export interface PtyProxyOptions {
  readonly target: PtyTarget;
  /** Docker container ID (for SIGWINCH forwarding). */
  readonly containerId: string;
  /**
   * Active container runtime used for in-container PTY resize/verify execs.
   * Routing through the runtime (rather than a hardcoded `docker exec`) keeps
   * size management working on non-Docker backends (e.g. Apple `container`).
   * Optional so error-path tests can drive `attachPty` without a runtime;
   * when absent, PTY size management is skipped.
   */
  readonly runtime?: ContainerRuntime;
  /** Abort signal for graceful shutdown (e.g., SIGTERM). */
  readonly signal?: AbortSignal;
}

/** Maximum time to wait for the PTY socket to appear (ms). */
const PTY_READINESS_TIMEOUT_MS = 30_000;

/**
 * Extended PTY readiness timeout for the Linux UID-remap path. The
 * universal-image entrypoint does `usermod -u`, `groupmod -g`, and a
 * recursive `chown` of `/home/codespace` (Conda, NVM, Hugo, etc.) and
 * `/workspace` before exec'ing the agent, which is what eventually
 * runs socat and creates the UDS. On slower disks the chown alone can
 * take 25–30s; budget 90s so non-1000 hosts don't flap during startup.
 */
const PTY_READINESS_TIMEOUT_REMAP_MS = 90_000;

/** Poll interval when waiting for PTY socket (ms). */
const PTY_READINESS_POLL_MS = 200;

/**
 * Validates a session for resume and returns the loaded snapshot.
 * Throws descriptive errors for invalid resume attempts.
 */
export function validateResumeSession(resumeSessionId: string, protectedPaths: string[] = []): SessionSnapshot {
  const sessionDir = getSessionDir(resumeSessionId);
  if (!existsSync(sessionDir)) {
    throw new Error(`Cannot resume session "${resumeSessionId}": session directory not found`);
  }

  const snapshotPath = resolve(sessionDir, SESSION_STATE_FILENAME);
  if (!existsSync(snapshotPath)) {
    throw new Error(`Cannot resume session "${resumeSessionId}": no session state snapshot found`);
  }

  let snapshot: SessionSnapshot;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as SessionSnapshot;
  } catch {
    throw new Error(`Cannot resume session "${resumeSessionId}": session state snapshot is corrupted or invalid`);
  }

  if (!snapshot.sessionId || snapshot.sessionId !== resumeSessionId) {
    throw new Error(`Cannot resume session "${resumeSessionId}": snapshot sessionId mismatch`);
  }
  if (!snapshot.resumable) {
    throw new Error(
      `Cannot resume session "${resumeSessionId}": session is not resumable (status: ${snapshot.status})`,
    );
  }
  if (!snapshot.agent) {
    throw new Error(`Cannot resume session "${resumeSessionId}": agent configuration is missing`);
  }

  // Validate workspace path using the same checks as --workspace to prevent
  // a tampered snapshot from expanding the sandbox to a sensitive directory.
  if (!snapshot.workspacePath || typeof snapshot.workspacePath !== 'string') {
    throw new Error(`Cannot resume session "${resumeSessionId}": workspace path is missing or invalid`);
  }
  try {
    validateWorkspacePath(snapshot.workspacePath, protectedPaths);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot resume session "${resumeSessionId}": workspace path is unsafe: ${detail}`, {
      cause: err,
    });
  }

  return snapshot;
}

/**
 * Loads a session snapshot from disk.
 * Returns undefined if the snapshot file does not exist or is invalid.
 */
export function loadSessionSnapshot(sessionId: string): SessionSnapshot | undefined {
  const snapshotPath = resolve(getSessionDir(sessionId), SESSION_STATE_FILENAME);
  if (!existsSync(snapshotPath)) return undefined;
  try {
    return JSON.parse(readFileSync(snapshotPath, 'utf-8')) as SessionSnapshot;
  } catch {
    return undefined;
  }
}

/**
 * Classifies the PTY session exit reason from the container exit code.
 */
function classifyExitStatus(exitCode: number | null): SessionSnapshot['status'] {
  if (exitCode === null) return 'crashed';
  if (exitCode === 0) return 'completed';
  // Exit code 2 is commonly used by agents for auth failures
  if (exitCode === 2) return 'auth-failure';
  return 'crashed';
}

/**
 * Checks whether a conversation state directory contains files,
 * indicating the agent wrote conversation data that can be resumed.
 */
function hasConversationState(stateDir: string): boolean {
  if (!existsSync(stateDir)) return false;
  try {
    const entries = readdirSync(stateDir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * Writes a session state snapshot to the session directory.
 */
function writeSessionSnapshot(sessionDir: string, snapshot: SessionSnapshot): void {
  atomicWriteJsonSync(resolve(sessionDir, SESSION_STATE_FILENAME), snapshot);
}

/**
 * Runs a PTY session: starts proxies, launches container with PTY-enabled
 * Claude Code, attaches the terminal, and blocks until the session ends.
 */
export async function runPtySession(options: PtySessionOptions): Promise<void> {
  const { prepareDockerInfrastructure, writeAptProxyConfigViaExec, checkHostOnlyConnectivity } =
    await import('./docker-infrastructure.js');

  // When resuming, validate the snapshot and reuse the existing session directory
  const resumeSnapshot = options.resumeSessionId
    ? validateResumeSession(options.resumeSessionId, options.config.protectedPaths)
    : undefined;
  const isResume = !!resumeSnapshot;

  // Use the original session ID when resuming, otherwise create a new one
  const sessionId = createSessionId();
  const effectiveSessionId = options.resumeSessionId ?? sessionId;
  const sessionDir = getSessionDir(effectiveSessionId);

  // On resume, restore the profile the same way workspacePath is restored:
  // the persisted snapshot name wins over any passed flag (which is
  // warn-ignored upstream). Fresh sessions use the passed flag.
  const providerProfileName = isResume ? resumeSnapshot.providerProfileName : options.providerProfileName;

  // Delegate to shared buildSessionConfig() so PTY sessions get the same
  // config patching as standard Docker sessions (persona, memory MCP server
  // injection, server allowlist, policy dir, etc.).
  const dirConfig = buildSessionConfig(options.config, effectiveSessionId, sessionId, {
    resumeSessionId: options.resumeSessionId,
    workspacePath: isResume ? resumeSnapshot.workspacePath : options.workspacePath,
    persona: options.persona,
    providerProfileName,
    mode: options.mode,
  });

  // Resolve the active-profile name to persist in the snapshot for resume.
  // Docker mode always: PTY sessions are Docker-only. Mirrors the batch
  // path's metadata write (§9.7 F3).
  const resolvedProviderProfileName = providerProfileName ?? options.config.userConfig.modelProviders.default;

  // Layer PTY-specific fields on top of the shared config.
  const sessionConfig = { ...dirConfig.config, isPtySession: true };
  const { sandboxDir, escalationDir, systemPromptAugmentation } = dirConfig;

  logger.info(`PTY session ${effectiveSessionId} ${isResume ? 'resuming' : 'starting'}`);

  const initSpinner = ora({
    text: `Initializing PTY session (${options.mode.agent})...`,
    stream: process.stderr,
    discardStdin: false,
  }).start();

  let containerId: string | null = null;
  let sidecarContainerId: string | null = null;
  let escalationFileWatcher: EscalationWatcher | null = null;
  let registrationPath: string | null = null;
  let shutdownSpinner: ReturnType<typeof ora> | null = null;

  // Terminal safety: ensure raw mode is restored on any exit
  const restoreTerminal = (): void => {
    try {
      if (process.stdin.isTTY && process.stdin.isRaw) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    } catch {
      /* best effort */
    }
  };

  process.on('exit', restoreTerminal);

  // SIGTERM/SIGHUP trigger graceful shutdown by aborting the PTY connection.
  // This causes attachPty() to resolve, which then falls through to the
  // finally block for full async cleanup (containers, proxies, files).
  // SIGHUP is included because node-pty's kill() sends SIGHUP by default.
  const shutdownController = new AbortController();
  const handleShutdownSignal = (): void => {
    shutdownController.abort();
  };
  process.on('SIGTERM', handleShutdownSignal);
  process.on('SIGHUP', handleShutdownSignal);

  // Infra variables set inside try, used in finally for cleanup and snapshot
  let proxy: Awaited<ReturnType<typeof prepareDockerInfrastructure>>['proxy'] | null = null;
  let mitmProxy: Awaited<ReturnType<typeof prepareDockerInfrastructure>>['mitmProxy'] | null = null;
  let docker: Awaited<ReturnType<typeof prepareDockerInfrastructure>>['docker'] | null = null;
  let useTcp: boolean;
  let networkName: string | null = null;
  // Flushes the trajectory-capture session (clean, non-poisoned session-end)
  // before infra teardown. Assigned inside the try once the bundle exists;
  // invoked in finally. Undefined when capture is disabled. PTY mode tears
  // down proxies manually (it does not call destroyDockerInfrastructure), so
  // this explicit flush is required for a clean capture — the destroy-time
  // safety net does not run here.
  let flushCapture: (() => Promise<void>) | undefined;
  let ptyExitCode: number | null = null;
  let adapterIdForSnapshot: string | null = null;
  let adapterDisplayNameForSnapshot: string | null = null;
  let conversationStateDirForSnapshot: string | undefined;
  let userExited = false;

  const claudeMdContent = buildDockerClaudeMd({
    personaName: options.persona,
    memoryEnabled: dirConfig.memoryEnabled,
  });

  try {
    // Single-session CLI invariant: bundleId === sessionId (§2.1 of the
    // workflow-session-identity design). The PTY mode mints one UUID via
    // createSessionId() and reuses the same string as the BundleId here;
    // this keeps the deterministic `ironcurtain-pty-<id[0:12]>` container
    // name that prior-crash recovery depends on.
    const bundleId = effectiveSessionId as BundleId;
    // Trajectory-capture: pass the RAW override; the infra layer is the
    // single place that resolves it against userConfig. The writer is
    // constructed only when enabled — zero cost when disabled.
    const infra = await prepareDockerInfrastructure(
      sessionConfig,
      options.mode,
      sessionDir,
      sandboxDir,
      escalationDir,
      bundleId,
      undefined,
      undefined,
      dirConfig.resolvedSkills,
      {
        override: options.captureTracesOverride,
        capturesDir: getSessionCapturesDir(effectiveSessionId),
        recordedAgentName: options.mode.agent,
      },
      undefined, // scriptsDir
      providerProfileName,
    );
    // PTY sessions are standalone: pin the MITM proxy's token-stream
    // routing ID to this session's ID for the session's lifetime.
    const captureSessionId = effectiveSessionId as import('../session/types.js').SessionId;
    infra.setTokenSessionId(captureSessionId);

    // Begin trajectory capture (no-op when disabled). Standalone PTY runs
    // exactly one session through the bundle. The matching flush is in the
    // finally block, awaited BEFORE proxy teardown (§11 ordering) so the
    // session-end manifest entry is durable. PTY mode does not call
    // destroyDockerInfrastructure, so we both end the session (clean,
    // non-poisoned end) and close the writer here.
    infra.beginCaptureSession({ sessionId: captureSessionId });
    if (infra.captureWriter) {
      flushCapture = async () => {
        await infra
          .endCaptureSession(captureSessionId)
          .catch((err: unknown) =>
            logger.warn(`PTY capture endSession failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        await infra.captureWriter
          ?.close()
          .catch((err: unknown) =>
            logger.warn(`PTY capture writer close failed: ${err instanceof Error ? err.message : String(err)}`),
          );
      };
    }

    ({ docker, proxy, mitmProxy, useTcp } = infra);
    const {
      adapter,
      fakeKeys,
      orientationDir,
      socketsDir,
      systemPrompt: baseSystemPrompt,
      image,
      mitmAddr,
      conversationStateDir,
      conversationStateConfig,
      skillsMount,
    } = infra;

    // Write CLAUDE.md into conversation state dir (unconditionally, even on
    // resume, since persona/memory config may change between sessions).
    // Clean up stale CLAUDE.md when memory is disabled to avoid leftover rules.
    if (conversationStateDir) {
      const claudeMdPath = resolve(conversationStateDir, 'CLAUDE.md');
      if (claudeMdContent) {
        writeFileSync(claudeMdPath, claudeMdContent);
      } else {
        try {
          unlinkSync(claudeMdPath);
        } catch {
          /* not present */
        }
      }
    }

    // Compose final system prompt with persona/memory augmentation
    const systemPrompt = systemPromptAugmentation
      ? `${baseSystemPrompt}\n\n${systemPromptAugmentation}`
      : baseSystemPrompt;

    adapterIdForSnapshot = adapter.id;
    adapterDisplayNameForSnapshot = adapter.displayName;
    conversationStateDirForSnapshot = conversationStateDir;

    // Validate adapter supports PTY mode
    if (!adapter.buildPtyCommand) {
      throw new Error(`Agent ${adapter.id} does not support PTY mode.`);
    }

    // Write system prompt to file for shell-injection-safe PTY command
    writeFileSync(resolve(orientationDir, 'system-prompt.txt'), systemPrompt);

    // Write the effective system prompt to the session directory for debugging
    writeFileSync(resolve(sessionDir, 'system-prompt.txt'), systemPrompt);

    // Determine PTY connection target. On apple-container the guest
    // listens under /tmp (see APPLE_PTY_GUEST_SOCK) and the runtime's
    // --publish-socket bridges it to <socketsDir>/pty.sock on the host,
    // so the host-side ptyTarget below is identical to Linux.
    const ptySockPath = useTcp
      ? undefined
      : infra.runtimeKind === 'apple-container'
        ? APPLE_PTY_GUEST_SOCK
        : `/run/ironcurtain/${PTY_SOCK_NAME}`;
    const ptyPort = useTcp ? DEFAULT_PTY_PORT : undefined;

    // Build the PTY command
    const ptyCommand = adapter.buildPtyCommand(systemPrompt, ptySockPath, ptyPort);

    // Build container configuration
    const shortId = getBundleShortId(bundleId);
    const { quote } = await import('shell-quote');
    const internalNetworkName = getInternalNetworkName(shortId);
    let env: Record<string, string>;
    let network: string | null;
    let mounts: { source: string; target: string; readonly: boolean }[];
    let extraHosts: string[] | undefined;
    let publishSockets: { hostPath: string; containerPath: string }[] | undefined;
    let hostPtyPort: number | undefined;
    // apple-container only (both `uds` and the retained `tcp-hostonly`):
    // apt proxy config written into the container via exec after start
    // instead of bind-mounted — see writeAptProxyConfigViaExec.
    let execAptProxyUrl: string | undefined;
    const mainContainerName = `ironcurtain-pty-${shortId}`;

    // Remove stale main container from a crashed previous session (same session
    // ID means same deterministic name, which would conflict on docker create).
    // Done before the TCP/UDS branch since the main container name is
    // deterministic in both modes.
    await docker.removeStaleContainer(mainContainerName);

    if (infra.topology === 'tcp-hostonly') {
      // Apple container host-only mode: the agent VM reaches the host
      // proxies directly at the vmnet gateway, and the host connects
      // straight to the container's IP for the PTY — no sidecar, no
      // port publishing. Mirrors the batch branch in
      // docker-infrastructure.ts::createSessionContainers.
      if (infra.hostOnlyNetwork === undefined || proxy.port === undefined || mitmAddr.port === undefined) {
        throw new Error('tcp-hostonly bundle is missing its host-only network or proxy ports');
      }
      const proxyUrl = `http://${infra.hostOnlyNetwork.gateway}:${mitmAddr.port}`;
      env = {
        ...adapter.buildEnv(sessionConfig, fakeKeys),
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
      };
      execAptProxyUrl = proxyUrl;

      network = infra.hostOnlyNetwork.name;
      // Report the prepare-phase network as networkName so the finally
      // block's cleanupContainers removes it with the container.
      networkName = infra.hostOnlyNetwork.name;

      mounts = [
        { source: sandboxDir, target: CONTAINER_WORKSPACE_DIR, readonly: false },
        { source: orientationDir, target: '/etc/ironcurtain', readonly: true },
      ];
    } else if (useTcp && proxy.port !== undefined && mitmAddr.port !== undefined) {
      // macOS TCP mode
      const mcpPort = proxy.port;
      const mitmPort = mitmAddr.port;

      const proxyUrl = `http://host.docker.internal:${mitmPort}`;
      env = {
        ...adapter.buildEnv(sessionConfig, fakeKeys),
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
      };

      // Write apt proxy config so sudo apt-get routes through the MITM proxy
      const aptProxyPath = resolve(orientationDir, 'apt-proxy.conf');
      writeFileSync(aptProxyPath, `Acquire::http::Proxy "${proxyUrl}";\nAcquire::https::Proxy "${proxyUrl}";\n`);

      await docker.createNetwork(internalNetworkName, {
        internal: true,
      });
      network = internalNetworkName;
      networkName = internalNetworkName;

      const socatImage = 'alpine/socat';
      if (!(await docker.imageExists(socatImage))) {
        logger.info(`Pulling ${socatImage}...`);
        await docker.pullImage(socatImage);
      }

      // Create socat sidecar: forwards MCP/MITM container→host and PTY host→container.
      // The PTY socat is reversed because the host connects TO the container's PTY socket.
      // Docker DNS resolves the main container name on the internal network, and socat
      // with `fork` only resolves at connection time (so it's fine that main starts later).
      const sidecarName = `ironcurtain-sidecar-${shortId}`;

      // Remove stale sidecar from a crashed previous session (TCP mode only).
      await docker.removeStaleContainer(sidecarName);

      // Container-internal PTY port is fixed; host-side port is dynamic to
      // avoid conflicts when multiple PTY sessions run concurrently.
      const containerPtyPort = ptyPort ?? DEFAULT_PTY_PORT;
      hostPtyPort = await findFreePort();
      sidecarContainerId = await docker.create({
        image: socatImage,
        name: sidecarName,
        network: 'bridge',
        mounts: [],
        env: {},
        entrypoint: '/bin/sh',
        // PTY sessions are standalone (no workflow/scope), so only the
        // bundle label is emitted. See docs/designs/workflow-session-identity.md §7.
        bundleLabel: bundleId,
        ports: [`127.0.0.1:${hostPtyPort}:${containerPtyPort}`],
        command: [
          '-c',
          quote(['socat', `TCP-LISTEN:${mcpPort},fork,reuseaddr`, `TCP:host.docker.internal:${mcpPort}`]) +
            ' & ' +
            quote(['socat', `TCP-LISTEN:${mitmPort},fork,reuseaddr`, `TCP:host.docker.internal:${mitmPort}`]) +
            ' & ' +
            quote([
              'socat',
              `TCP-LISTEN:${containerPtyPort},fork,reuseaddr`,
              `TCP:${mainContainerName}:${containerPtyPort}`,
            ]) +
            ' & wait',
        ],
      });
      await docker.start(sidecarContainerId);
      await docker.connectNetwork(internalNetworkName, sidecarContainerId);
      const sidecarIp = await docker.getContainerIp(sidecarContainerId, internalNetworkName);
      extraHosts = [`host.docker.internal:${sidecarIp}`];

      mounts = [
        { source: sandboxDir, target: CONTAINER_WORKSPACE_DIR, readonly: false },
        { source: orientationDir, target: '/etc/ironcurtain', readonly: true },
        { source: aptProxyPath, target: '/etc/apt/apt.conf.d/90-ironcurtain-proxy', readonly: true },
      ];
    } else {
      // UDS mode (Linux Docker AND apple-container >= 1.1.0)
      const udsProxyUrl = 'http://127.0.0.1:18080';
      env = {
        ...adapter.buildEnv(sessionConfig, fakeKeys),
        HTTPS_PROXY: udsProxyUrl,
        HTTP_PROXY: udsProxyUrl,
      };
      network = null;

      mounts = [
        { source: sandboxDir, target: CONTAINER_WORKSPACE_DIR, readonly: false },
        ...buildUdsSocketMounts(infra.runtimeKind, socketsDir),
        { source: orientationDir, target: '/etc/ironcurtain', readonly: true },
      ];

      if (infra.runtimeKind === 'apple-container') {
        // apple-container: 1.1.0's virtiofs silently drops a directory
        // share when a file inside that directory is ALSO -v-mounted, so
        // the apt config (which lives under orientationDir) is written
        // via exec after start instead of bind-mounted. Bridge the
        // guest's PTY listener back to the host via a vsock relay; the
        // host-side socket materializes when the guest bind()s, so
        // waitForPtyReady's existence poll below is a valid readiness
        // signal on both runtimes.
        execAptProxyUrl = udsProxyUrl;
        if (ptySockPath !== undefined) {
          publishSockets = [{ hostPath: resolve(socketsDir, PTY_SOCK_NAME), containerPath: ptySockPath }];
        }
      } else {
        // Linux Docker: single-file bind mount for the apt proxy config.
        const aptProxyPathUds = resolve(orientationDir, 'apt-proxy.conf');
        writeFileSync(
          aptProxyPathUds,
          `Acquire::http::Proxy "${udsProxyUrl}";\nAcquire::https::Proxy "${udsProxyUrl}";\n`,
        );
        mounts.push({ source: aptProxyPathUds, target: '/etc/apt/apt.conf.d/90-ironcurtain-proxy', readonly: true });
      }
    }

    // Mount conversation state directory if the adapter supports resume
    if (conversationStateDir && conversationStateConfig) {
      mounts.push({
        source: conversationStateDir,
        target: conversationStateConfig.containerMountPath,
        readonly: false,
      });
    }

    // Read-only so the agent cannot mutate skills mid-session — keeps
    // the cached-stager assumption sound and prevents per-state filter
    // contamination.
    if (skillsMount) {
      mounts.push({ source: skillsMount.hostDir, target: skillsMount.target, readonly: true });
    }

    // Pass initial terminal size so start-claude.sh can set PTY dimensions
    // before Claude starts, eliminating the resize race condition.
    const { columns, rows } = process.stdout;
    if (columns) env.IRONCURTAIN_INITIAL_COLS = String(columns);
    if (rows) env.IRONCURTAIN_INITIAL_ROWS = String(rows);

    if (skillsMount && adapter.skills?.ptyEnv) {
      Object.assign(env, adapter.skills.ptyEnv);
    }

    // Pass resume flags when resuming a session.
    // Validate each flag to prevent shell injection via adapter misconfiguration.
    if (isResume && conversationStateConfig && conversationStateConfig.resumeFlags.length > 0) {
      const SAFE_FLAG = /^--[a-z0-9-]+$/;
      for (const flag of conversationStateConfig.resumeFlags) {
        if (!SAFE_FLAG.test(flag)) {
          throw new Error(`Invalid resume flag: ${flag}`);
        }
      }
      env.IRONCURTAIN_RESUME_FLAGS = conversationStateConfig.resumeFlags.join(' ');
    }

    // Linux-only UID-remap wiring (issue #232). Matches the parallel
    // setup in `docker-infrastructure.ts::createSessionContainers`;
    // when adding fields here, mirror the change there. macOS skips
    // the remap because VirtioFS translates UIDs transparently.
    const uidRemap = buildAgentUidRemap(infra.runtimeKind === 'apple-container' || useTcp);

    // Resource ceilings come from userConfig (defaults: 8 GB / 4 cpus) and
    // are clamped to fit the host. `null` in either field is preserved as
    // "no flag emitted" (see clampDockerResources docs).
    const { effective: ptyResources } = clampDockerResources(options.config.userConfig.dockerResources);

    containerId = await docker.create({
      image,
      name: mainContainerName,
      network: network ?? 'none',
      mounts,
      env: { ...env, ...uidRemap.env },
      user: uidRemap.user,
      command: ptyCommand,
      // PTY sessions are standalone (no workflow/scope), so only the
      // bundle label is emitted. See docs/designs/workflow-session-identity.md §7.
      bundleLabel: bundleId,
      resources: { memoryMb: ptyResources.memoryMb, cpus: ptyResources.cpus },
      extraHosts,
      publishSockets,
      capAdd: [
        'SETUID', // sudo setuid
        'SETGID', // sudo setgid
        'CHOWN', // apt-get chown on installed files
        'FOWNER', // apt-get set permissions on files it doesn't own
        'DAC_OVERRIDE', // apt-get read/write files regardless of permissions during install
        'AUDIT_WRITE', // sudo audit logging
      ],
      tty: true,
    });

    await docker.start(containerId);
    logger.info(`PTY container started: ${containerId.substring(0, 12)}`);

    // apple-container (uds and the retained tcp-hostonly): write the apt
    // proxy config inside the container via exec instead of a bind mount.
    if (execAptProxyUrl !== undefined) {
      await writeAptProxyConfigViaExec(docker, containerId, execAptProxyUrl);
    }
    // tcp-hostonly only: fail-closed connectivity gate (gateway proxies
    // reachable, internet egress blocked) before attaching.
    if (infra.topology === 'tcp-hostonly' && infra.hostOnlyNetwork !== undefined && proxy.port !== undefined) {
      await checkHostOnlyConnectivity(docker, containerId, infra.hostOnlyNetwork.gateway, proxy.port);
    }

    // Write session registration for the escalation listener
    registrationPath = writeRegistration(effectiveSessionId, escalationDir, adapter.displayName);

    // Start escalation file watcher (emits BEL to alert user)
    escalationFileWatcher = createEscalationWatcher(escalationDir, {
      onEscalation: () => {
        process.stderr.write('\x07'); // BEL character
      },
      onEscalationExpired: () => {},
    });
    escalationFileWatcher.start();

    // Wait for PTY socket readiness.
    // On macOS TCP mode, skip the readiness probe — the main container's socat
    // does NOT use `fork`, so it only accepts one connection. A readiness probe
    // would consume that slot and cause the real attachPty connection to fail.
    // Instead, attachPty retries internally for TCP targets.
    let ptyTarget: PtyTarget;
    if (infra.topology === 'tcp-hostonly') {
      // The host-only network routes host→container traffic natively:
      // connect straight to the container's IP at the fixed PTY port.
      // attachPty retries TCP targets, covering the window before the
      // container-side socat is listening.
      if (infra.hostOnlyNetwork === undefined) {
        throw new Error('PTY session misconfiguration: tcp-hostonly without a host-only network');
      }
      const containerIp = await docker.getContainerIp(containerId, infra.hostOnlyNetwork.name);
      ptyTarget = { host: containerIp, port: DEFAULT_PTY_PORT };
    } else if (useTcp) {
      if (hostPtyPort === undefined) {
        throw new Error('PTY session misconfiguration: useTcp is true but hostPtyPort was not assigned');
      }
      ptyTarget = { host: 'localhost', port: hostPtyPort };
    } else {
      ptyTarget = resolve(socketsDir, PTY_SOCK_NAME);
    }

    if (!useTcp) {
      // When `uidRemap.user` is set (Linux non-1000 host, issue #232) the
      // entrypoint runs usermod/groupmod and a recursive chown before
      // exec'ing the agent, so socat — and therefore the UDS — appears
      // 25–30s later than the no-remap case. Stretch the readiness
      // budget so PTY sessions on non-1000 hosts don't flap.
      const readinessTimeoutMs = uidRemap.user ? PTY_READINESS_TIMEOUT_REMAP_MS : PTY_READINESS_TIMEOUT_MS;
      await waitForPtyReady(ptyTarget, readinessTimeoutMs);
      logger.info('PTY readiness check passed');
    }

    initSpinner.succeed(chalk.dim('PTY session ready'));
    process.stderr.write('\n');

    // Attach terminal via Node.js PTY proxy. Tests inject a stub via
    // `options.attach` to drive assertions against the live container.
    const attachFn = options.attach ?? attachPty;
    const exitCode = await attachFn({
      target: ptyTarget,
      containerId,
      runtime: docker,
      signal: shutdownController.signal,
    });
    ptyExitCode = exitCode;
    userExited = exitCode === 0;
    logger.info(`PTY attach returned with exit code ${exitCode}`);

    // PTY disconnected -- restore terminal and show shutdown progress
    restoreTerminal();
    process.stderr.write('\n');

    shutdownSpinner = ora({
      text: 'Shutting down PTY session...',
      stream: process.stderr,
      discardStdin: false,
    }).start();

    if (exitCode !== 0) {
      process.stderr.write(chalk.yellow(`PTY session exited with code ${exitCode}\n`));
    }
  } finally {
    // Stop spinner if still running (e.g. error during setup)
    if (initSpinner.isSpinning) {
      initSpinner.fail(chalk.red('PTY session failed'));
    }

    restoreTerminal();
    process.off('exit', restoreTerminal);
    process.off('SIGTERM', handleShutdownSignal);
    process.off('SIGHUP', handleShutdownSignal);

    // Stop escalation watcher
    escalationFileWatcher?.stop();

    // Delete registration file
    if (registrationPath) {
      try {
        unlinkSync(registrationPath);
      } catch {
        /* best effort */
      }
    }

    // Flush trajectory capture before proxy teardown so the session-end
    // manifest entry is durable (§11). No-op when capture is disabled.
    if (flushCapture) {
      await flushCapture();
    }

    if (docker) {
      await cleanupContainers(docker, {
        containerId,
        sidecarContainerId,
        networkName,
      });
    }

    // Stop proxies
    await mitmProxy?.stop().catch(() => {});
    await proxy?.stop().catch(() => {});

    // Write session snapshot for resume support
    if (adapterIdForSnapshot) {
      try {
        const status: SessionSnapshot['status'] = userExited ? 'user-exit' : classifyExitStatus(ptyExitCode);

        const canResume = !!conversationStateDirForSnapshot && hasConversationState(conversationStateDirForSnapshot);

        const snapshot: SessionSnapshot = {
          sessionId: effectiveSessionId,
          status,
          exitCode: ptyExitCode,
          lastActivity: new Date().toISOString(),
          workspacePath: sandboxDir,
          providerProfileName: resolvedProviderProfileName,
          agent: adapterIdForSnapshot,
          label: `${adapterDisplayNameForSnapshot ?? adapterIdForSnapshot} (interactive)`,
          resumable: canResume,
        };

        writeSessionSnapshot(sessionDir, snapshot);
        logger.info(`Session snapshot written (status: ${status}, resumable: ${canResume})`);
      } catch (snapshotErr) {
        logger.warn(
          `Failed to write session snapshot: ${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}`,
        );
      }
    }

    logger.info(`PTY session ${effectiveSessionId} ended`);
    logger.teardown();

    // shutdownSpinner is declared inside try but accessible here via closure
    shutdownSpinner?.succeed(chalk.dim('PTY session ended'));
  }
}

// --- PTY proxy ---

/** Creates a net.Socket connection to the PTY target (UDS or TCP). */
function connectToTarget(target: PtyTarget): ReturnType<typeof createConnection> {
  if (typeof target === 'string') {
    return createConnection({ path: target });
  }
  return createConnection({ host: target.host, port: target.port });
}

/**
 * `attachPtyOnce` return codes that signal a non-attached outcome.
 * Distinguishing the two lets the caller decide whether to retry, exit
 * silently, or surface a hard failure.
 */
/** Connected, but the remote closed before sending any data. */
const ATTACH_INSTANT_CLOSE = -1;
/** The socket connect itself failed (e.g. ECONNREFUSED, ENOENT). */
const ATTACH_PRE_CONNECT_ERROR = -2;

/**
 * Attaches the user's terminal to the container PTY via a Node.js socket.
 * Returns a promise that resolves with 0 on normal close, 1 on error.
 *
 * For TCP targets (macOS), retries the connection with polling since
 * the container's socat may not be listening yet when this is called.
 * The socat inside the container does NOT use `fork`, so only one
 * connection is accepted — no separate readiness probe is used.
 */
export async function attachPty(options: PtyProxyOptions): Promise<number> {
  const isTcp = typeof options.target !== 'string';
  if (isTcp) {
    // TCP: poll until the connection succeeds and stays open, then attach.
    // Both pre-connect errors and instant-close indicate "not ready yet".
    const deadline = Date.now() + PTY_READINESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const code = await attachPtyOnce(options);
      if (options.signal?.aborted) return 0;
      if (code !== ATTACH_INSTANT_CLOSE && code !== ATTACH_PRE_CONNECT_ERROR) return code;
      logger.info('PTY TCP connection not ready, retrying...');
      await new Promise((r) => setTimeout(r, PTY_READINESS_POLL_MS));
    }
    throw new Error(`PTY TCP connection did not stabilize within ${PTY_READINESS_TIMEOUT_MS / 1000}s`);
  }
  // UDS (Linux): readiness was already verified by waitForPtyReady. A
  // pre-connect failure here means the socket file existed but nothing
  // was actually listening — typically a stale file or a socat that
  // crashed between probe and attach. Surface it instead of silently
  // mapping to 0. Instant-close (connected then closed before data) is
  // still treated as a normal close: the container started and exited
  // before sending output.
  const code = await attachPtyOnce(options);
  if (code === ATTACH_PRE_CONNECT_ERROR) {
    throw new Error(
      'PTY socket exists but no listener accepted the connection. ' +
        'The container may have crashed between readiness check and attach.',
    );
  }
  return code === ATTACH_INSTANT_CLOSE ? 0 : code;
}

/**
 * Single attempt to attach to the PTY. Returns one of:
 *   ≥0                       — terminal exit code from a real session
 *   ATTACH_INSTANT_CLOSE     — connected, remote closed before data
 *   ATTACH_PRE_CONNECT_ERROR — socket connect itself failed
 */
function attachPtyOnce(options: PtyProxyOptions): Promise<number> {
  const conn = connectToTarget(options.target);

  const { stdin, stdout } = process;

  return new Promise((resolvePromise) => {
    let resolved = false;
    const settle = (code: number): void => {
      if (resolved) return;
      resolved = true;
      resolvePromise(code);
    };

    const onPreConnectError = (): void => {
      // Pre-connect failure (no `connect` event ever fired). Distinct from
      // a post-connect close so the UDS caller can surface a hard failure
      // instead of treating a stale-socket false positive as success.
      settle(ATTACH_PRE_CONNECT_ERROR);
    };
    conn.once('error', onPreConnectError);

    conn.once('connect', () => {
      // Once connected, the pre-connect classifier no longer applies; remove
      // it so a post-connect 'error' (e.g. ECONNRESET mid-session) is handled
      // only by the post-connect handler below — otherwise both fire and the
      // earlier-registered pre-connect listener wins, mis-reporting the
      // outcome as ATTACH_PRE_CONNECT_ERROR.
      conn.removeListener('error', onPreConnectError);

      // Defer raw mode, stdin forwarding, and resize handling until the first
      // data arrives from the remote. For TCP retries, an instant close (no
      // data) returns -1 without touching the terminal, so the user is never
      // left stuck in raw mode between retry attempts.
      let receivedData = false;
      const verifyAbort = new AbortController();
      let isFirstResize = true;

      const runtime = options.runtime;
      const onResize = (): void => {
        const { columns, rows } = stdout;
        if (columns && rows && runtime) {
          if (!isFirstResize) {
            verifyAbort.abort();
          }
          isFirstResize = false;
          // Route through the active runtime (docker or Apple `container`).
          // `exec` defaults `--user` to codespace, which is correct whether
          // the container runs as root (Linux UID-remap path, issue #232) or
          // as codespace (macOS); re-asserting codespace there is a no-op.
          void runtime
            .exec(options.containerId, ['/etc/ironcurtain/resize-pty.sh', String(columns), String(rows)], 5000)
            .then((res) => {
              if (res.exitCode !== 0) {
                logger.warn(`resize-pty.sh failed (exit ${res.exitCode})`);
                if (res.stderr) {
                  logger.warn(`resize-pty.sh stderr: ${res.stderr.trim()}`);
                }
              }
            })
            .catch((err: unknown) => {
              logger.warn(`resize-pty.sh failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
      };

      // Host -> Container
      // Ctrl-\ (0x1c) is intercepted as an emergency exit since raw mode
      // disables normal signal generation for SIGQUIT.
      const CTRL_BACKSLASH = 0x1c;
      const onData = (data: Buffer): void => {
        if (data.length === 1 && data[0] === CTRL_BACKSLASH) {
          cleanup();
          conn.destroy();
          settle(0);
          return;
        }
        conn.write(data);
      };

      // Container -> Host (untrusted output, displayed directly).
      // Piped immediately so no data is lost; raw mode and stdin forwarding
      // are deferred until we confirm the connection is real (first data).
      conn.pipe(stdout);

      conn.once('data', () => {
        receivedData = true;
        // Now that the connection is confirmed, enter raw mode and start
        // forwarding user input to the container.
        if (stdin.isTTY) {
          stdin.setRawMode(true);
        }
        stdin.resume();
        stdin.on('data', onData);

        // Start resize forwarding and send initial size
        stdout.on('resize', onResize);
        onResize();

        // Background verify+retry to ensure the initial resize took effect.
        // Fire-and-forget -- does not block the PTY proxy.
        // Canceled via verifyAbort when the user resizes the terminal.
        if (runtime && stdout.columns && stdout.rows) {
          void verifyInitialPtySize(runtime, options.containerId, stdout.columns, stdout.rows, verifyAbort.signal);
        }
      });

      // Use function declarations (hoisted) so cleanup and onAbort can
      // reference each other without temporal dead zone issues.
      function cleanup(): void {
        stdout.removeListener('resize', onResize);
        stdin.removeListener('data', onData);
        conn.unpipe(stdout);
        if (receivedData) {
          stdin.pause();
        }
        verifyAbort.abort();
        options.signal?.removeEventListener('abort', onAbort);
      }
      function onAbort(): void {
        cleanup();
        conn.destroy();
        settle(0);
      }
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });

      conn.once('close', () => {
        cleanup();
        settle(receivedData ? 0 : ATTACH_INSTANT_CLOSE);
      });
      conn.once('error', () => {
        cleanup();
        settle(receivedData ? 1 : ATTACH_INSTANT_CLOSE);
      });
    });
  });
}

// --- PTY size verification ---

/** Maximum retries for initial PTY size verification. */
const PTY_SIZE_VERIFY_RETRIES = 5;

/** Interval between PTY size verification attempts (ms). */
const PTY_SIZE_VERIFY_INTERVAL_MS = 1_000;

/** Initial delay before first verification attempt (ms). */
const PTY_SIZE_VERIFY_INITIAL_DELAY_MS = 500;

/**
 * Runs check-pty-size.sh via the active runtime and returns { rows, cols }
 * or null on failure.
 */
async function checkPtySize(
  runtime: ContainerRuntime,
  containerId: string,
): Promise<{ rows: number; cols: number } | null> {
  try {
    // `exec` defaults `--user` to codespace; see the resize callsite for the
    // issue #232 rationale.
    const res = await runtime.exec(containerId, ['/etc/ironcurtain/check-pty-size.sh'], 5000);
    if (res.exitCode !== 0) return null;
    const parts = res.stdout.trim().split(/\s+/);
    if (parts.length >= 2) {
      const rows = parseInt(parts[0], 10);
      const cols = parseInt(parts[1], 10);
      if (!isNaN(rows) && !isNaN(cols) && rows > 0 && cols > 0) {
        return { rows, cols };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Background verify+retry loop for initial PTY resize.
 * Non-blocking (fire-and-forget). Aborted when a user resize occurs so it
 * does not fight with legitimate SIGWINCH-driven resizes.
 */
async function verifyInitialPtySize(
  runtime: ContainerRuntime,
  containerId: string,
  expectedCols: number,
  expectedRows: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise((r) => setTimeout(r, PTY_SIZE_VERIFY_INITIAL_DELAY_MS));

  for (let attempt = 0; attempt < PTY_SIZE_VERIFY_RETRIES; attempt++) {
    if (signal?.aborted) return;

    const size = await checkPtySize(runtime, containerId);
    if (size && size.cols === expectedCols && size.rows === expectedRows) {
      return; // PTY size matches
    }

    if (signal?.aborted) return;

    // Mismatch or check failed -- try resizing via the active runtime.
    // `exec` defaults `--user` to codespace; see issue #232.
    await runtime
      .exec(containerId, ['/etc/ironcurtain/resize-pty.sh', String(expectedCols), String(expectedRows)], 5000)
      .catch(() => undefined);

    // Wait before rechecking
    await new Promise((r) => setTimeout(r, PTY_SIZE_VERIFY_INTERVAL_MS));
  }

  if (signal?.aborted) return;

  // Final check
  const finalSize = await checkPtySize(runtime, containerId);
  if (!finalSize || finalSize.cols !== expectedCols || finalSize.rows !== expectedRows) {
    logger.warn(
      `PTY size verification failed after ${PTY_SIZE_VERIFY_RETRIES} retries ` +
        `(expected ${expectedCols}x${expectedRows}, got ${finalSize ? `${finalSize.cols}x${finalSize.rows}` : 'unknown'})`,
    );
  }
}

// --- Readiness polling ---

/**
 * Waits for the PTY socket file to appear (Linux UDS only). macOS TCP
 * skips this probe because the container's socat does not use `fork`.
 *
 * We poll for a UDS *inode* rather than opening a connection. socat's
 * `UNIX-LISTEN` creates the socket file at `bind()`, so file existence
 * is a sufficient readiness signal — and avoids the connect-and-close
 * that would trigger socat's `,fork` semantics, spawning a doomed child
 * before the real `attachPty` connection arrives. That doomed child can
 * race the real one for shared per-agent state (e.g. Goose's SQLite
 * session DB at `~/.local/share/goose/sessions/sessions.db`), producing
 * "table schema_version already exists" migration errors.
 *
 * We require the inode to be a socket — a stale regular file or
 * directory at the path is not "ready", since the Linux/UDS attach path
 * does not retry on connect failure.
 */
export async function waitForPtyReady(target: PtyTarget, timeoutMs: number = PTY_READINESS_TIMEOUT_MS): Promise<void> {
  if (typeof target !== 'string') {
    // macOS TCP path is guarded out at the call site (pty-session.ts ~534);
    // this branch exists only as a defensive no-op so the helper stays total.
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isSocketPath(target)) return;
    await new Promise((r) => setTimeout(r, PTY_READINESS_POLL_MS));
  }

  throw new Error(`PTY socket did not become ready within ${timeoutMs / 1000}s`);
}

/**
 * Returns true when `path` exists and is a UNIX domain socket. ENOENT is
 * treated as "not ready yet"; other lstat errors propagate, since they
 * indicate a setup problem (permissions, missing parent directory) that
 * silent polling would only mask.
 */
function isSocketPath(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

// --- Port allocation ---

/**
 * Finds a free TCP port on localhost by binding to port 0 and immediately
 * closing the server. Used on macOS to allocate the PTY host port dynamically
 * so multiple PTY sessions can run concurrently.
 *
 * Note: inherent TOCTOU window between discovering the port and Docker
 * binding it. In practice this is extremely unlikely for ephemeral ports.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('Failed to get ephemeral port'));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// --- Registration ---

/**
 * Writes a PTY session registration file to the registry directory.
 * Returns the absolute path of the registration file.
 */
interface MuxContext {
  readonly muxId: string;
  readonly muxPid: number;
}

/** Reads mux ownership context from environment variables, if set. */
function getMuxContext(): MuxContext | undefined {
  const muxId = process.env.IRONCURTAIN_MUX_ID;
  const muxPidStr = process.env.IRONCURTAIN_MUX_PID;
  if (!muxId) return undefined;
  const muxPid = muxPidStr ? parseInt(muxPidStr, 10) : undefined;
  if (muxPid === undefined || isNaN(muxPid)) return undefined;
  return { muxId, muxPid };
}

function writeRegistration(sessionId: string, escalationDir: string, adapterDisplayName: string): string {
  const registryDir = getPtyRegistryDir();
  mkdirSync(registryDir, { recursive: true, mode: 0o700 });

  const mux = getMuxContext();

  const registration: PtySessionRegistration = {
    sessionId,
    escalationDir,
    label: `${adapterDisplayName} (interactive)`,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    ...(mux && { muxId: mux.muxId, muxPid: mux.muxPid }),
  };

  const registrationPath = resolve(registryDir, `session-${sessionId}.json`);
  atomicWriteJsonSync(registrationPath, registration);
  return registrationPath;
}
