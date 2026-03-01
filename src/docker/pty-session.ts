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

import { createConnection } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import ora from 'ora';

import type { IronCurtainConfig } from '../config/types.js';
import type { SessionMode } from '../session/types.js';
import { createSessionId } from '../session/types.js';
import { PTY_SOCK_NAME, DEFAULT_PTY_PORT } from './pty-types.js';
import type { PtySessionRegistration } from './pty-types.js';
import { createEscalationWatcher, atomicWriteJsonSync } from '../escalation/escalation-watcher.js';
import type { EscalationWatcher } from '../escalation/escalation-watcher.js';
import {
  KeystrokeBuffer,
  reconstructUserInput,
  writeUserContext,
  DEFAULT_RECONSTRUCT_MODEL_ID,
} from './keystroke-reconstructor.js';
import {
  getSessionDir,
  getSessionSandboxDir,
  getSessionEscalationDir,
  getSessionAuditLogPath,
  getSessionSocketsDir,
  getSessionLogPath,
  getSessionLlmLogPath,
  getPtyRegistryDir,
} from '../config/paths.js';
import * as logger from '../logger.js';

export interface PtySessionOptions {
  readonly config: IronCurtainConfig;
  readonly mode: SessionMode & { kind: 'docker' };
}

/** Maximum time to wait for the PTY socket to appear (ms). */
const PTY_READINESS_TIMEOUT_MS = 30_000;

/** Poll interval when waiting for PTY socket (ms). */
const PTY_READINESS_POLL_MS = 200;

/**
 * Runs a PTY session: starts proxies, launches container with PTY-enabled
 * Claude Code, attaches the terminal, and blocks until the session ends.
 */
export async function runPtySession(options: PtySessionOptions): Promise<void> {
  const { prepareDockerInfrastructure } = await import('./docker-infrastructure.js');

  const sessionId = createSessionId();
  const sessionDir = getSessionDir(sessionId);
  const sandboxDir = getSessionSandboxDir(sessionId);
  const escalationDir = getSessionEscalationDir(sessionId);
  const auditLogPath = getSessionAuditLogPath(sessionId);
  const socketsDir = getSessionSocketsDir(sessionId);

  mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
  mkdirSync(escalationDir, { recursive: true, mode: 0o700 });
  mkdirSync(socketsDir, { recursive: true, mode: 0o700 });

  // Set up session logging
  const sessionLogPath = getSessionLogPath(sessionId);
  const llmLogPath = getSessionLlmLogPath(sessionId);
  logger.setup({ logFilePath: sessionLogPath });
  logger.info(`PTY session ${sessionId} starting`);
  logger.info(`Sandbox: ${sandboxDir}`);
  logger.info(`Escalation dir: ${escalationDir}`);
  logger.info(`LLM log: ${llmLogPath}`);

  // Patch config for this session
  const sessionConfig = {
    ...options.config,
    allowedDirectory: sandboxDir,
    auditLogPath,
    escalationDir,
    sessionLogPath,
    llmLogPath,
    mcpServers: JSON.parse(JSON.stringify(options.config.mcpServers)) as typeof options.config.mcpServers,
  };

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

  const handleSigterm = (): void => {
    restoreTerminal();
    process.exit(128 + 15);
  };
  process.on('SIGTERM', handleSigterm);

  // Infra variables set inside try, used in finally for cleanup
  let proxy: Awaited<ReturnType<typeof prepareDockerInfrastructure>>['proxy'] | null = null;
  let mitmProxy: Awaited<ReturnType<typeof prepareDockerInfrastructure>>['mitmProxy'] | null = null;
  let docker: Awaited<ReturnType<typeof prepareDockerInfrastructure>>['docker'] | null = null;
  let useTcp = false;

  try {
    const infra = await prepareDockerInfrastructure(
      sessionConfig,
      options.mode,
      sessionDir,
      sandboxDir,
      escalationDir,
      auditLogPath,
      sessionId,
    );

    ({ docker, proxy, mitmProxy, useTcp } = infra);
    const { adapter, fakeKeys, orientationDir, systemPrompt, image, mitmAddr } = infra;

    // Validate adapter supports PTY mode
    if (!adapter.buildPtyCommand) {
      throw new Error(`Agent ${adapter.id} does not support PTY mode.`);
    }

    // Write system prompt to file for shell-injection-safe PTY command
    writeFileSync(resolve(orientationDir, 'system-prompt.txt'), systemPrompt);

    // Determine PTY connection target
    const ptySockPath = useTcp ? undefined : `/run/ironcurtain/${PTY_SOCK_NAME}`;
    const ptyPort = useTcp ? DEFAULT_PTY_PORT : undefined;

    // Build the PTY command
    const ptyCommand = adapter.buildPtyCommand(systemPrompt, ptySockPath, ptyPort);

    // Build container configuration
    const shortId = sessionId.substring(0, 12);
    const { INTERNAL_NETWORK_NAME, INTERNAL_NETWORK_SUBNET, INTERNAL_NETWORK_GATEWAY } = await import('./platform.js');
    const { quote } = await import('shell-quote');
    let env: Record<string, string>;
    let network: string;
    let mounts: { source: string; target: string; readonly: boolean }[];
    let extraHosts: string[] | undefined;

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

      // Create socat sidecar with PTY port forwarding
      const sidecarName = `ironcurtain-sidecar-${shortId}`;
      const ptyPortNum = ptyPort ?? DEFAULT_PTY_PORT;
      sidecarContainerId = await docker.create({
        image: socatImage,
        name: sidecarName,
        network: 'bridge',
        mounts: [],
        env: {},
        entrypoint: '/bin/sh',
        command: [
          '-c',
          quote(['socat', `TCP-LISTEN:${mcpPort},fork,reuseaddr`, `TCP:host.docker.internal:${mcpPort}`]) +
            ' & ' +
            quote(['socat', `TCP-LISTEN:${mitmPort},fork,reuseaddr`, `TCP:host.docker.internal:${mitmPort}`]) +
            ' & ' +
            quote(['socat', `TCP-LISTEN:${ptyPortNum},fork,reuseaddr`, `TCP:host.docker.internal:${ptyPortNum}`]) +
            ' & wait',
        ],
      });
      await docker.start(sidecarContainerId);
      await docker.connectNetwork(INTERNAL_NETWORK_NAME, sidecarContainerId);
      const sidecarIp = await docker.getContainerIp(sidecarContainerId, INTERNAL_NETWORK_NAME);
      extraHosts = [`host.docker.internal:${sidecarIp}`];

      mounts = [
        { source: sandboxDir, target: '/workspace', readonly: false },
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
        { source: sandboxDir, target: '/workspace', readonly: false },
        { source: socketsDir, target: '/run/ironcurtain', readonly: false },
        { source: orientationDir, target: '/etc/ironcurtain', readonly: true },
      ];
    }

    // Create and start container with PTY command and TTY
    containerId = await docker.create({
      image,
      name: `ironcurtain-pty-${shortId}`,
      network,
      mounts,
      env,
      command: ptyCommand,
      sessionLabel: sessionId,
      resources: { memoryMb: 4096, cpus: 2 },
      extraHosts,
      tty: true,
    });

    await docker.start(containerId);
    logger.info(`PTY container started: ${containerId.substring(0, 12)}`);

    // Write session registration for the escalation listener
    registrationPath = writeRegistration(sessionId, escalationDir, adapter.displayName);

    // Keystroke buffer for LLM-based user context reconstruction.
    // Captures trusted host->container input for auto-approver support.
    const keystrokeBuffer = new KeystrokeBuffer();

    // Start escalation file watcher (reconstructs user context + emits BEL)
    escalationFileWatcher = createEscalationWatcher(escalationDir, {
      onEscalation: () => {
        // Lazily reconstruct the user's most recent message from keystrokes
        // and write it to user-context.json for the auto-approver.
        reconstructAndWriteContext(keystrokeBuffer, escalationDir, options.config).catch((err: unknown) => {
          logger.warn(`User context reconstruction failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        // Alert user to check the escalation listener
        process.stderr.write('\x07'); // BEL character
      },
      onEscalationExpired: () => {},
    });
    escalationFileWatcher.start();

    // Wait for PTY socket readiness
    const ptyTarget = useTcp
      ? { host: 'localhost', port: ptyPort ?? DEFAULT_PTY_PORT }
      : resolve(socketsDir, PTY_SOCK_NAME);

    await waitForPtyReady(ptyTarget);

    initSpinner.succeed(chalk.dim('PTY session ready'));
    process.stderr.write('\n');

    // Attach terminal via Node.js PTY proxy
    const exitCode = await attachPty({
      target: ptyTarget,
      containerId,
      onInput: (data) => keystrokeBuffer.append(data),
    });

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
    process.off('SIGTERM', handleSigterm);

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

    logger.info(`PTY session ${sessionId} ended`);
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
  /** Callback for recording host->container bytes (trusted input). */
  readonly onInput?: (data: Buffer) => void;
}

/**
 * Attaches the user's terminal to the container PTY via a Node.js socket.
 * Returns a promise that resolves with the exit code when the connection closes.
 */
function attachPty(options: PtyProxyOptions): Promise<number> {
  const conn = connectToTarget(options.target);

  const { stdin, stdout } = process;

  return new Promise((resolvePromise) => {
    conn.on('connect', () => {
      // Put terminal in raw mode
      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }
      stdin.resume();

      // SIGWINCH: forward terminal resize to container PTY
      const onResize = (): void => {
        const { columns, rows } = stdout;
        if (columns && rows) {
          execFile(
            'docker',
            ['exec', options.containerId, '/etc/ironcurtain/resize-pty.sh', String(columns), String(rows)],
            { timeout: 5000 },
            () => {
              /* best effort */
            },
          );
        }
      };
      stdout.on('resize', onResize);
      // Send initial size
      onResize();

      // Host -> Container (trusted input, tapped for keystroke recording)
      // Ctrl-\ (0x1c) is intercepted as an emergency exit since raw mode
      // disables normal signal generation for SIGQUIT.
      const CTRL_BACKSLASH = 0x1c;
      const onData = (data: Buffer): void => {
        if (data.length === 1 && data[0] === CTRL_BACKSLASH) {
          cleanup();
          conn.destroy();
          resolvePromise(0);
          return;
        }
        conn.write(data);
        options.onInput?.(data);
      };
      stdin.on('data', onData);

      // Container -> Host (untrusted output, displayed directly)
      conn.pipe(stdout);

      const cleanup = (): void => {
        stdout.removeListener('resize', onResize);
        stdin.removeListener('data', onData);
        conn.unpipe(stdout);
        stdin.pause();
      };

      conn.on('close', () => {
        cleanup();
        resolvePromise(0);
      });
      conn.on('error', () => {
        cleanup();
        resolvePromise(1);
      });
    });

    conn.on('error', () => {
      resolvePromise(1);
    });
  });
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
 * Tries to connect to a target. Returns true if the connection succeeds.
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

// --- Keystroke reconstruction ---

/**
 * Reconstructs user input from the keystroke buffer and writes user-context.json.
 * Called lazily when an escalation is detected.
 */
async function reconstructAndWriteContext(
  buffer: KeystrokeBuffer,
  escalationDir: string,
  config: IronCurtainConfig,
): Promise<void> {
  const contents = buffer.getContents();
  if (contents.length === 0) return;

  const { createLanguageModel } = await import('../config/model-provider.js');
  const modelId = config.userConfig.autoApprove.modelId || DEFAULT_RECONSTRUCT_MODEL_ID;
  const model = await createLanguageModel(modelId, config.userConfig);
  const reconstructed = await reconstructUserInput(contents, model);

  if (reconstructed) {
    writeUserContext(escalationDir, reconstructed);
  }
}
