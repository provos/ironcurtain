/**
 * Escalation listener CLI command.
 *
 * Polls the PTY session registry directory for active sessions, watches
 * each session's escalation directory for new requests, and presents
 * a terminal dashboard where the user can approve or deny escalations.
 *
 * Usage: ironcurtain escalation-listener
 */

import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, writeSync, readFileSync, unlinkSync, openSync, closeSync, constants } from 'node:fs';
import chalk from 'chalk';

import { getPtyRegistryDir, getListenerLockPath } from '../config/paths.js';
import { readActiveRegistrations } from './session-registry.js';
import { createEscalationWatcher } from './escalation-watcher.js';
import type { EscalationWatcher } from './escalation-watcher.js';
import type { PtySessionRegistration } from '../docker/pty-types.js';
import {
  createInitialState,
  addSession,
  removeSession,
  addEscalation,
  resolveEscalation,
  expireEscalation,
  type ListenerState,
} from './listener-state.js';

/** Poll interval for the session registry directory (ms). */
const REGISTRY_POLL_INTERVAL_MS = 1000;

export async function main(): Promise<void> {
  // Single-instance enforcement
  const lockPath = getListenerLockPath();
  if (!acquireLock(lockPath)) {
    process.stderr.write(chalk.red('Another escalation listener is already running.\n'));
    process.exit(1);
  }

  const registryDir = getPtyRegistryDir();
  mkdirSync(registryDir, { recursive: true, mode: 0o700 });

  let state = createInitialState();
  let running = true;

  // Set up readline for command input
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  const render = (): void => {
    renderDashboard(state);
  };

  // Poll for new/removed sessions
  const registryPollInterval = setInterval(() => {
    const registrations = readActiveRegistrations(registryDir);
    const currentIds = new Set(registrations.map((r) => r.sessionId));
    const stateIds = new Set(state.sessions.keys());

    // Add new sessions
    for (const reg of registrations) {
      if (!stateIds.has(reg.sessionId)) {
        const watcher = createWatcherForSession(
          reg,
          (newState) => {
            state = newState;
            render();
          },
          () => state,
        );
        state = addSession(state, reg, watcher);
        watcher.start();
      }
    }

    // Remove gone sessions
    for (const id of stateIds) {
      if (!currentIds.has(id)) {
        const session = state.sessions.get(id);
        session?.watcher.stop();
        state = removeSession(state, id);
      }
    }

    render();
  }, REGISTRY_POLL_INTERVAL_MS);

  // Initial render
  render();

  // Handle commands
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      render();
      return;
    }

    const result = handleCommand(trimmed, state);
    state = result.state;

    if (result.message) {
      process.stderr.write(result.message + '\n');
    }

    if (result.quit) {
      running = false;
      rl.close();
      return;
    }

    render();
  });

  rl.on('close', () => {
    running = false;
  });

  // Wait until quit
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      if (!running) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);
  });

  // Cleanup
  clearInterval(registryPollInterval);
  for (const session of state.sessions.values()) {
    session.watcher.stop();
  }
  releaseLock(lockPath);
}

// --- Lock management ---

/**
 * Acquires the listener lock file using O_EXCL for atomicity.
 * Returns true if the lock was acquired, false if another instance holds it.
 */
function acquireLock(lockPath: string): boolean {
  if (existsSync(lockPath)) {
    // Check if the PID in the lock file is still alive
    try {
      const content = readFileSync(lockPath, 'utf-8');
      const pid = parseInt(content.trim(), 10);
      if (!isNaN(pid) && isPidAlive(pid)) {
        return false; // Another instance is running
      }
      // Stale lock -- remove and try again
      unlinkSync(lockPath);
    } catch {
      // If we can't read the lock, try to recreate it
      try {
        unlinkSync(lockPath);
      } catch {
        return false;
      }
    }
  }

  try {
    const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const content = Buffer.from(String(process.pid));
    writeSync(fd, content);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* best effort */
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- Watcher creation ---

function createWatcherForSession(
  registration: PtySessionRegistration,
  onStateChange: (state: ListenerState) => void,
  getState: () => ListenerState,
): EscalationWatcher {
  return createEscalationWatcher(
    registration.escalationDir,
    {
      onEscalation: (request) => {
        const newState = addEscalation(getState(), registration.sessionId, request);
        onStateChange(newState);
        // BEL character alerts the user
        process.stderr.write('\x07');
      },
      onEscalationExpired: (escalationId) => {
        const newState = expireEscalation(getState(), registration.sessionId, escalationId);
        onStateChange(newState);
      },
    },
    { pollIntervalMs: 300 },
  );
}

// --- Command handling ---

interface CommandResult {
  state: ListenerState;
  message?: string;
  quit?: boolean;
}

function handleCommand(input: string, state: ListenerState): CommandResult {
  const parts = input.split(/\s+/);
  const command = parts[0].toLowerCase();

  switch (command) {
    case '/approve': {
      const arg = parts[1];
      if (!arg) return { state, message: chalk.yellow('Usage: /approve <number> or /approve all') };

      if (arg === 'all') {
        return approveOrDenyAll(state, 'approved');
      }
      const num = parseInt(arg, 10);
      if (isNaN(num)) return { state, message: chalk.yellow('Invalid escalation number') };
      return approveOrDeny(state, num, 'approved');
    }

    case '/deny': {
      const arg = parts[1];
      if (!arg) return { state, message: chalk.yellow('Usage: /deny <number> or /deny all') };

      if (arg === 'all') {
        return approveOrDenyAll(state, 'denied');
      }
      const num = parseInt(arg, 10);
      if (isNaN(num)) return { state, message: chalk.yellow('Invalid escalation number') };
      return approveOrDeny(state, num, 'denied');
    }

    case '/sessions':
      return { state, message: formatSessionDetails(state) };

    case '/quit':
    case '/q':
      return { state, quit: true };

    default:
      return {
        state,
        message: chalk.yellow(
          'Unknown command. Available: /approve <N>, /deny <N>, /approve all, /deny all, /sessions, /quit',
        ),
      };
  }
}

function approveOrDeny(state: ListenerState, displayNumber: number, decision: 'approved' | 'denied'): CommandResult {
  const escalation = state.pendingEscalations.get(displayNumber);
  if (!escalation) {
    return { state, message: chalk.yellow(`No pending escalation #${displayNumber}`) };
  }

  const session = state.sessions.get(escalation.sessionId);
  if (!session) {
    return { state, message: chalk.yellow(`Session for escalation #${displayNumber} no longer active`) };
  }

  try {
    const accepted = session.watcher.resolve(escalation.request.escalationId, decision);
    const newState = resolveEscalation(state, displayNumber, decision);

    if (!accepted) {
      return {
        state: newState,
        message: chalk.yellow(`Escalation #${displayNumber} expired (response was too late)`),
      };
    }

    const label = decision === 'approved' ? chalk.green('APPROVED') : chalk.red('DENIED');
    return {
      state: newState,
      message: `Escalation #${displayNumber} ${label}`,
    };
  } catch (err) {
    return { state, message: chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`) };
  }
}

function approveOrDenyAll(state: ListenerState, decision: 'approved' | 'denied'): CommandResult {
  if (state.pendingEscalations.size === 0) {
    return { state, message: chalk.yellow('No pending escalations') };
  }

  let currentState = state;
  const messages: string[] = [];
  const nums = [...state.pendingEscalations.keys()].sort((a, b) => a - b);

  for (const num of nums) {
    const result = approveOrDeny(currentState, num, decision);
    currentState = result.state;
    if (result.message) messages.push(result.message);
  }

  return { state: currentState, message: messages.join('\n') };
}

function formatSessionDetails(state: ListenerState): string {
  if (state.sessions.size === 0) {
    return chalk.dim('No active sessions');
  }

  const lines: string[] = [];
  for (const session of state.sessions.values()) {
    const reg = session.registration;
    const ago = formatTimeAgo(new Date(reg.startedAt));
    lines.push(`  [${session.displayNumber}] ${reg.sessionId.substring(0, 8)}  ${reg.label}  ${chalk.dim(ago)}`);
  }
  return lines.join('\n');
}

// --- Rendering ---

/**
 * Renders the full dashboard to stderr.
 * Clears the screen and redraws everything.
 */
function renderDashboard(state: ListenerState): void {
  // Move cursor to top and clear screen
  process.stderr.write('\x1b[2J\x1b[H');

  const sessionCount = state.sessions.size;
  const pendingCount = state.pendingEscalations.size;

  // Header
  process.stderr.write(
    chalk.bold.cyan('  IronCurtain Escalation Listener') +
      chalk.dim(`              ${sessionCount} session${sessionCount !== 1 ? 's' : ''} active\n`),
  );
  process.stderr.write(chalk.dim('  ' + '\u2500'.repeat(60) + '\n'));

  // Active Sessions
  process.stderr.write('\n' + chalk.bold('  Active Sessions:\n'));
  if (sessionCount === 0) {
    process.stderr.write(chalk.dim('    Waiting for PTY sessions...\n'));
  } else {
    for (const session of state.sessions.values()) {
      const reg = session.registration;
      const ago = formatTimeAgo(new Date(reg.startedAt));
      const sessionPending = countPendingForSession(state, reg.sessionId);
      const pendingLabel = sessionPending > 0 ? chalk.yellow(` ${sessionPending} pending`) : chalk.dim(' 0 pending');
      process.stderr.write(
        `    [${chalk.bold(String(session.displayNumber))}] ` +
          `${reg.sessionId.substring(0, 8)}  ` +
          `${reg.label.substring(0, 40)}  ` +
          chalk.dim(ago) +
          pendingLabel +
          '\n',
      );
    }
  }

  // Pending Escalations
  process.stderr.write('\n' + chalk.dim('  ' + '\u2500'.repeat(60) + '\n'));
  process.stderr.write(
    '\n' + chalk.bold('  Pending Escalations:') + (pendingCount === 0 ? chalk.dim(' (none)') : '') + '\n',
  );

  if (pendingCount > 0) {
    const sorted = [...state.pendingEscalations.values()].sort((a, b) => a.displayNumber - b.displayNumber);
    for (const esc of sorted) {
      process.stderr.write('\n');
      process.stderr.write(
        `    [${chalk.bold.yellow(String(esc.displayNumber))}] ` +
          `Session #${esc.sessionDisplayNumber} (${esc.sessionId.substring(0, 8)})\n`,
      );
      process.stderr.write(`        Tool:    ${chalk.cyan(esc.request.serverName + '/' + esc.request.toolName)}\n`);

      // Show key arguments
      const argPreview = formatArgPreview(esc.request.arguments);
      if (argPreview) {
        process.stderr.write(`        Args:    ${argPreview}\n`);
      }
      process.stderr.write(`        Reason:  ${esc.request.reason}\n`);
    }
  }

  // History
  if (state.history.length > 0) {
    process.stderr.write('\n' + chalk.dim('  ' + '\u2500'.repeat(60) + '\n'));
    process.stderr.write('\n' + chalk.bold('  History (last 10):\n'));
    const recent = state.history.slice(0, 10);
    for (const entry of recent) {
      const time = entry.resolvedAt.toLocaleTimeString();
      const decisionLabel = entry.decision === 'approved' ? chalk.green('APPROVED') : chalk.red('DENIED');
      process.stderr.write(
        `    [${chalk.dim(time)}] ` + `${entry.serverName}/${entry.toolName}  ` + decisionLabel + '\n',
      );
    }
  }

  // Command prompt
  process.stderr.write('\n' + chalk.dim('  ' + '\u2500'.repeat(60) + '\n'));
  process.stderr.write(chalk.dim('  /approve N | /deny N | /approve all | /deny all | /quit\n'));
  process.stderr.write('  > ');
}

// --- Helpers ---

function countPendingForSession(state: ListenerState, sessionId: string): number {
  let count = 0;
  for (const esc of state.pendingEscalations.values()) {
    if (esc.sessionId === sessionId) count++;
  }
  return count;
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatArgPreview(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      const display = value.length > 60 ? value.substring(0, 57) + '...' : value;
      parts.push(`${key}: ${display}`);
    }
  }
  return parts.slice(0, 3).join(', ');
}
