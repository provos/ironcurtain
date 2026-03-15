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
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';

import type { IronCurtainConfig } from '../config/types.js';
import type { SessionMode } from '../session/types.js';
import { createSessionId } from '../session/types.js';
import { buildSessionConfig } from '../session/index.js';
import { validateWorkspacePath } from '../session/workspace-validation.js';
import { CONTAINER_WORKSPACE_DIR } from './agent-adapter.js';
import { PTY_SOCK_NAME, DEFAULT_PTY_PORT } from './pty-types.js';
import type { PtySessionRegistration, SessionSnapshot } from './pty-types.js';
import { SESSION_STATE_FILENAME } from './pty-types.js';
import { createEscalationWatcher, atomicWriteJsonSync } from '../escalation/escalation-watcher.js';
import type { EscalationWatcher } from '../escalation/escalation-watcher.js';
import { getSessionDir, getPtyRegistryDir } from '../config/paths.js';
import * as logger from '../logger.js';
import { buildDockerClaudeMd } from './claude-md-seed.js';

export interface PtySessionOptions {
  readonly config: IronCurtainConfig;
  readonly mode: SessionMode & { kind: 'docker' };
  /** Validated workspace path. When provided, replaces the session sandbox. */
  readonly workspacePath?: string;
  /** Session ID to resume. When set, reuses the existing session directory. */
  readonly resumeSessionId?: string;
  /** Persona name. Used to build CLAUDE.md and system prompt augmentation. */
  readonly persona?: string;
}

/** Maximum time to wait for the PTY socket to appear (ms). */
const PTY_READINESS_TIMEOUT_MS = 30_000;

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
  const { prepareDockerInfrastructure } = await import('./docker-infrastructure.js');

  // When resuming, validate the snapshot and reuse the existing session directory
  const resumeSnapshot = options.resumeSessionId
    ? validateResumeSession(options.resumeSessionId, options.config.protectedPaths)
    : undefined;
  const isResume = !!resumeSnapshot;

  // Use the original session ID when resuming, otherwise create a new one
  const sessionId = createSessionId();
  const effectiveSessionId = options.resumeSessionId ?? sessionId;
  const sessionDir = getSessionDir(effectiveSessionId);

  // Delegate to shared buildSessionConfig() so PTY sessions get the same
  // config patching as standard Docker sessions (persona, memory MCP server
  // injection, server allowlist, policy dir, etc.).
  const dirConfig = buildSessionConfig(options.config, effectiveSessionId, sessionId, {
    resumeSessionId: options.resumeSessionId,
    workspacePath: isResume ? resumeSnapshot.workspacePath : options.workspacePath,
    persona: options.persona,
  });

  // Layer PTY-specific fields on top of the shared config.
  const sessionConfig = { ...dirConfig.config, isPtySession: true };
  const { sandboxDir, escalationDir, auditLogPath, systemPromptAugmentation } = dirConfig;

  const socketsDir = resolve(sessionDir, 'sockets');
  mkdirSync(socketsDir, { recursive: true, mode: 0o700 });

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
  let useTcp = false;
  let ptyExitCode: number | null = null;
  let adapterIdForSnapshot: string | null = null;
  let adapterDisplayNameForSnapshot: string | null = null;
  let conversationStateDirForSnapshot: string | undefined;
  let userExited = false;

  const claudeMdContent = buildDockerClaudeMd({
    personaName: options.persona,
    memoryEnabled: options.config.userConfig.memory.enabled,
  });

  try {
    const infra = await prepareDockerInfrastructure(
      sessionConfig,
      options.mode,
      sessionDir,
      sandboxDir,
      escalationDir,
      auditLogPath,
      effectiveSessionId,
    );

    ({ docker, proxy, mitmProxy, useTcp } = infra);
    const {
      adapter,
      fakeKeys,
      orientationDir,
      systemPrompt: baseSystemPrompt,
      image,
      mitmAddr,
      conversationStateDir,
      conversationStateConfig,
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

    // Determine PTY connection target
    const ptySockPath = useTcp ? undefined : `/run/ironcurtain/${PTY_SOCK_NAME}`;
    const ptyPort = useTcp ? DEFAULT_PTY_PORT : undefined;

    // Build the PTY command
    const ptyCommand = adapter.buildPtyCommand(systemPrompt, ptySockPath, ptyPort);

    // Build container configuration
    const shortId = effectiveSessionId.substring(0, 12);
    const { INTERNAL_NETWORK_NAME, INTERNAL_NETWORK_SUBNET, INTERNAL_NETWORK_GATEWAY } = await import('./platform.js');
    const { quote } = await import('shell-quote');
    let env: Record<string, string>;
    let network: string;
    let mounts: { source: string; target: string; readonly: boolean }[];
    let extraHosts: string[] | undefined;
    let hostPtyPort: number | undefined;
    const mainContainerName = `ironcurtain-pty-${shortId}`;

    if (useTcp && proxy.port !== undefined && mitmAddr.port !== undefined) {
      // macOS TCP mode
      const mcpPort = proxy.port;
      const mitmPort = mitmAddr.port;

      env = {
        ...adapter.buildEnv(sessionConfig, fakeKeys),
        HTTPS_PROXY: `http://host.docker.internal:${mitmPort}`,
        HTTP_PROXY: `http://host.docker.internal:${mitmPort}`,
      };

      await docker.createNetwork(INTERNAL_NETWORK_NAME, {
        internal: true,
        subnet: INTERNAL_NETWORK_SUBNET,
        gateway: INTERNAL_NETWORK_GATEWAY,
      });
      network = INTERNAL_NETWORK_NAME;

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
      await docker.connectNetwork(INTERNAL_NETWORK_NAME, sidecarContainerId);
      const sidecarIp = await docker.getContainerIp(sidecarContainerId, INTERNAL_NETWORK_NAME);
      extraHosts = [`host.docker.internal:${sidecarIp}`];

      mounts = [
        { source: sandboxDir, target: CONTAINER_WORKSPACE_DIR, readonly: false },
        { source: orientationDir, target: '/etc/ironcurtain', readonly: true },
      ];
    } else {
      // Linux UDS mode
      env = {
        ...adapter.buildEnv(sessionConfig, fakeKeys),
        HTTPS_PROXY: 'http://127.0.0.1:18080',
        HTTP_PROXY: 'http://127.0.0.1:18080',
      };
      network = 'none';
      mounts = [
        { source: sandboxDir, target: CONTAINER_WORKSPACE_DIR, readonly: false },
        { source: socketsDir, target: '/run/ironcurtain', readonly: false },
        { source: orientationDir, target: '/etc/ironcurtain', readonly: true },
      ];
    }

    // Mount conversation state directory if the adapter supports resume
    if (conversationStateDir && conversationStateConfig) {
      mounts.push({
        source: conversationStateDir,
        target: conversationStateConfig.containerMountPath,
        readonly: false,
      });
    }

    // Pass initial terminal size so start-claude.sh can set PTY dimensions
    // before Claude starts, eliminating the resize race condition.
    const { columns, rows } = process.stdout;
    if (columns) env.IRONCURTAIN_INITIAL_COLS = String(columns);
    if (rows) env.IRONCURTAIN_INITIAL_ROWS = String(rows);

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

    // Create and start container with PTY command and TTY
    containerId = await docker.create({
      image,
      name: mainContainerName,
      network,
      mounts,
      env,
      command: ptyCommand,
      sessionLabel: effectiveSessionId,
      resources: { memoryMb: 4096, cpus: 2 },
      extraHosts,
      tty: true,
    });

    await docker.start(containerId);
    logger.info(`PTY container started: ${containerId.substring(0, 12)}`);

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
    if (useTcp) {
      if (hostPtyPort === undefined) {
        throw new Error('PTY session misconfiguration: useTcp is true but hostPtyPort was not assigned');
      }
      ptyTarget = { host: 'localhost', port: hostPtyPort };
    } else {
      ptyTarget = resolve(socketsDir, PTY_SOCK_NAME);
    }

    if (!useTcp) {
      await waitForPtyReady(ptyTarget);
      logger.info('PTY readiness check passed');
    }

    initSpinner.succeed(chalk.dim('PTY session ready'));
    process.stderr.write('\n');

    // Attach terminal via Node.js PTY proxy
    const exitCode = await attachPty({
      target: ptyTarget,
      containerId,
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

    // Stop and remove containers
    if (docker && containerId) {
      await docker.stop(containerId).catch(() => {});
      await docker.remove(containerId).catch(() => {});
    }
    if (docker && sidecarContainerId) {
      await docker.stop(sidecarContainerId).catch(() => {});
      await docker.remove(sidecarContainerId).catch(() => {});
    }

    // Remove internal network if used
    if (docker && useTcp) {
      const { INTERNAL_NETWORK_NAME } = await import('./platform.js');
      await docker.removeNetwork(INTERNAL_NETWORK_NAME).catch(() => {});
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

/** UDS path (Linux) or { host, port } (macOS). */
type PtyTarget = string | { host: string; port: number };

/** Creates a net.Socket connection to the PTY target (UDS or TCP). */
function connectToTarget(target: PtyTarget): ReturnType<typeof createConnection> {
  if (typeof target === 'string') {
    return createConnection({ path: target });
  }
  return createConnection({ host: target.host, port: target.port });
}

interface PtyProxyOptions {
  readonly target: PtyTarget;
  /** Docker container ID (for SIGWINCH forwarding). */
  readonly containerId: string;
  /** Abort signal for graceful shutdown (e.g., SIGTERM). */
  readonly signal?: AbortSignal;
}

/**
 * Attaches the user's terminal to the container PTY via a Node.js socket.
 * Returns a promise that resolves with 0 on normal close, 1 on error.
 *
 * For TCP targets (macOS), retries the connection with polling since
 * the container's socat may not be listening yet when this is called.
 * The socat inside the container does NOT use `fork`, so only one
 * connection is accepted — no separate readiness probe is used.
 */
async function attachPty(options: PtyProxyOptions): Promise<number> {
  const isTcp = typeof options.target !== 'string';
  if (isTcp) {
    // TCP: poll until the connection succeeds and stays open, then attach.
    const deadline = Date.now() + PTY_READINESS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const code = await attachPtyOnce(options);
      // code 0 with very short duration means the connection was closed immediately
      // (socat not ready or backend refused). Retry unless signal aborted.
      if (options.signal?.aborted) return 0;
      // If we got a real session (not an instant close), return the exit code.
      // We detect "instant close" by checking if the connection lasted meaningfully.
      // attachPtyOnce sets a flag when data was received from the remote.
      if (code !== -1) return code;
      logger.info('PTY TCP connection closed immediately, retrying...');
      await new Promise((r) => setTimeout(r, PTY_READINESS_POLL_MS));
    }
    throw new Error(`PTY TCP connection did not stabilize within ${PTY_READINESS_TIMEOUT_MS / 1000}s`);
  }
  // UDS (Linux): readiness was already verified, so -1 (no data before close)
  // is treated as a normal close — the container exited before sending output.
  const code = await attachPtyOnce(options);
  return code === -1 ? 0 : code;
}

/**
 * Single attempt to attach to the PTY. Returns -1 if the connection
 * was closed before any data was received (signals retry for TCP).
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

    conn.once('connect', () => {
      // Defer raw mode, stdin forwarding, and resize handling until the first
      // data arrives from the remote. For TCP retries, an instant close (no
      // data) returns -1 without touching the terminal, so the user is never
      // left stuck in raw mode between retry attempts.
      let receivedData = false;
      const verifyAbort = new AbortController();
      let isFirstResize = true;

      const onResize = (): void => {
        const { columns, rows } = stdout;
        if (columns && rows) {
          if (!isFirstResize) {
            verifyAbort.abort();
          }
          isFirstResize = false;
          execFile(
            'docker',
            ['exec', options.containerId, '/etc/ironcurtain/resize-pty.sh', String(columns), String(rows)],
            { timeout: 5000 },
            (err, _stdout, stderr) => {
              if (err) {
                logger.warn(`resize-pty.sh failed: ${err.message}`);
                if (stderr) {
                  logger.warn(`resize-pty.sh stderr: ${stderr.trim()}`);
                }
              }
            },
          );
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
        if (stdout.columns && stdout.rows) {
          void verifyInitialPtySize(options.containerId, stdout.columns, stdout.rows, verifyAbort.signal);
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
        settle(receivedData ? 0 : -1);
      });
      conn.once('error', () => {
        cleanup();
        settle(receivedData ? 1 : -1);
      });
    });

    conn.once('error', () => {
      settle(-1); // connection failed, signal retry for TCP
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
 * Runs check-pty-size.sh and returns { rows, cols } or null on failure.
 */
function checkPtySize(containerId: string): Promise<{ rows: number; cols: number } | null> {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['exec', containerId, '/etc/ironcurtain/check-pty-size.sh'],
      { timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const parts = stdout.trim().split(/\s+/);
        if (parts.length >= 2) {
          const rows = parseInt(parts[0], 10);
          const cols = parseInt(parts[1], 10);
          if (!isNaN(rows) && !isNaN(cols) && rows > 0 && cols > 0) {
            resolve({ rows, cols });
            return;
          }
        }
        resolve(null);
      },
    );
  });
}

/**
 * Background verify+retry loop for initial PTY resize.
 * Non-blocking (fire-and-forget). Aborted when a user resize occurs so it
 * does not fight with legitimate SIGWINCH-driven resizes.
 */
async function verifyInitialPtySize(
  containerId: string,
  expectedCols: number,
  expectedRows: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise((r) => setTimeout(r, PTY_SIZE_VERIFY_INITIAL_DELAY_MS));

  for (let attempt = 0; attempt < PTY_SIZE_VERIFY_RETRIES; attempt++) {
    if (signal?.aborted) return;

    const size = await checkPtySize(containerId);
    if (size && size.cols === expectedCols && size.rows === expectedRows) {
      return; // PTY size matches
    }

    if (signal?.aborted) return;

    // Mismatch or check failed -- try resizing
    await new Promise<void>((resolve) => {
      execFile(
        'docker',
        ['exec', containerId, '/etc/ironcurtain/resize-pty.sh', String(expectedCols), String(expectedRows)],
        { timeout: 5000 },
        () => resolve(),
      );
    });

    // Wait before rechecking
    await new Promise((r) => setTimeout(r, PTY_SIZE_VERIFY_INTERVAL_MS));
  }

  if (signal?.aborted) return;

  // Final check
  const finalSize = await checkPtySize(containerId);
  if (!finalSize || finalSize.cols !== expectedCols || finalSize.rows !== expectedRows) {
    logger.warn(
      `PTY size verification failed after ${PTY_SIZE_VERIFY_RETRIES} retries ` +
        `(expected ${expectedCols}x${expectedRows}, got ${finalSize ? `${finalSize.cols}x${finalSize.rows}` : 'unknown'})`,
    );
  }
}

// --- Readiness polling ---

/**
 * Waits for the PTY socket/port to become connectable.
 */
async function waitForPtyReady(target: PtyTarget): Promise<void> {
  const deadline = Date.now() + PTY_READINESS_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const connected = await tryConnect(target);
    if (connected) return;

    await new Promise((r) => setTimeout(r, PTY_READINESS_POLL_MS));
  }

  throw new Error(`PTY socket did not become ready within ${PTY_READINESS_TIMEOUT_MS / 1000}s`);
}

/**
 * Tries to connect to a UDS target. Returns true if the connection succeeds.
 * Used only for Linux readiness polling (macOS TCP skips the readiness probe).
 */
function tryConnect(target: PtyTarget): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = connectToTarget(target);

    const timer = setTimeout(() => {
      conn.destroy();
      resolve(false);
    }, 1000);

    conn.on('connect', () => {
      clearTimeout(timer);
      conn.destroy();
      resolve(true);
    });

    conn.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
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
function writeRegistration(sessionId: string, escalationDir: string, adapterDisplayName: string): string {
  const registryDir = getPtyRegistryDir();
  mkdirSync(registryDir, { recursive: true, mode: 0o700 });

  const registration: PtySessionRegistration = {
    sessionId,
    escalationDir,
    label: `${adapterDisplayName} (interactive)`,
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };

  const registrationPath = resolve(registryDir, `session-${sessionId}.json`);
  atomicWriteJsonSync(registrationPath, registration);
  return registrationPath;
}
