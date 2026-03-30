/**
 * Parallel compilation progress display.
 *
 * Provides a multi-line status table for TTY output and a line-based
 * fallback for non-TTY (CI, piped output). Each server gets a fixed
 * line showing its current phase, elapsed time, and detail.
 *
 * Warnings and errors are buffered per-server and flushed after the
 * table is torn down, so the multi-line display is never corrupted.
 */

import chalk from 'chalk';
import type { CompilationPhase, ServerProgressReporter } from './pipeline-shared.js';

// ---------------------------------------------------------------------------
// Server state tracking
// ---------------------------------------------------------------------------

interface ServerState {
  phase: CompilationPhase | 'pending' | 'FAILED';
  detail?: string;
  startTime: number;
  phaseStartTime: number;
  warnings: string[];
  error?: Error;
  summary?: string;
}

// ---------------------------------------------------------------------------
// ParallelProgressDisplay
// ---------------------------------------------------------------------------

/**
 * Multi-line TTY progress display for parallel server compilation.
 * Allocates one line per server and updates in place using ANSI escapes.
 * Falls back to line-based logging on non-TTY stderr.
 */
export class ParallelProgressDisplay {
  private readonly serverNames: string[];
  private readonly states: Map<string, ServerState>;
  private readonly isTTY: boolean;
  private readonly maxNameLength: number;
  private linesWritten = 0;
  private finished = false;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  constructor(serverNames: string[]) {
    this.serverNames = serverNames;
    this.isTTY = process.stderr.isTTY;
    this.maxNameLength = serverNames.length > 0 ? Math.max(...serverNames.map((n) => n.length)) : 0;
    this.states = new Map();

    const now = Date.now();
    for (const name of serverNames) {
      this.states.set(name, {
        phase: 'pending',
        startTime: now,
        phaseStartTime: now,
        warnings: [],
      });
    }

    if (this.isTTY && serverNames.length > 0) {
      this.drawInitialTable();
      this.refreshTimer = setInterval(() => this.redrawAllActive(), 1000);
    }
  }

  updateServer(name: string, phase: CompilationPhase | 'FAILED', detail?: string): void {
    const state = this.states.get(name);
    if (!state || this.finished) return;

    const phaseChanged = state.phase !== phase;
    state.phase = phase;
    state.detail = detail;
    if (phaseChanged) {
      state.phaseStartTime = Date.now();
    }

    if (this.isTTY) {
      this.redrawServer(name);
    } else if (phaseChanged) {
      this.logLineBasedUpdate(name, state);
    }
  }

  bufferWarning(name: string, message: string): void {
    const state = this.states.get(name);
    if (state) {
      state.warnings.push(message);
    }
  }

  captureError(name: string, error: Error): void {
    const state = this.states.get(name);
    if (state) {
      state.error = error;
      state.phase = 'FAILED';
    }
    if (this.isTTY) {
      this.redrawServer(name);
    } else {
      process.stderr.write(`  ${name.padEnd(this.maxNameLength)}  [FAILED]  ${error.message}\n`);
    }
  }

  setDone(name: string, summary: string): void {
    const state = this.states.get(name);
    if (!state) return;
    state.phase = 'done';
    state.summary = summary;
    if (this.isTTY) {
      this.redrawServer(name);
    } else {
      process.stderr.write(`  ${name.padEnd(this.maxNameLength)}  [done]  ${summary}\n`);
    }
  }

  /**
   * Tears down the multi-line table, prints the summary table,
   * and flushes per-server warnings/errors.
   */
  finish(): void {
    this.finished = true;
    this.stopRefreshTimer();

    if (this.isTTY) {
      // Do a final redraw so elapsed times are current in the table
      this.redrawAllActive();
    }

    // Print summary table
    process.stderr.write('\n');
    for (const name of this.serverNames) {
      const state = this.getState(name);
      const totalElapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);

      if (state.phase === 'FAILED') {
        process.stderr.write(`  ${chalk.red(name.padEnd(this.maxNameLength))}  FAILED  (${totalElapsed}s)\n`);
      } else if (state.phase === 'done') {
        process.stderr.write(
          `  ${chalk.green(name.padEnd(this.maxNameLength))}  ${state.summary ?? 'done'}  (${totalElapsed}s)\n`,
        );
      } else {
        process.stderr.write(
          `  ${chalk.yellow(name.padEnd(this.maxNameLength))}  ${state.phase}  (${totalElapsed}s)\n`,
        );
      }
    }

    // Flush per-server warnings and errors
    this.flushDiagnostics();
  }

  /** Gets the state for a server. All names were set in the constructor. */
  private getState(name: string): ServerState {
    const state = this.states.get(name);
    if (!state) throw new Error(`Unknown server: ${name}`);
    return state;
  }

  // -------------------------------------------------------------------------
  // TTY rendering
  // -------------------------------------------------------------------------

  private drawInitialTable(): void {
    process.stderr.write('\n');
    for (const name of this.serverNames) {
      process.stderr.write(this.formatServerLine(name) + '\n');
    }
    this.linesWritten = this.serverNames.length;
  }

  private redrawServer(name: string): void {
    const index = this.serverNames.indexOf(name);
    if (index === -1) return;

    // Calculate how many lines up from the current cursor position
    const linesUp = this.linesWritten - index;
    // Move cursor up, clear line, write, then move back down
    process.stderr.write(`\x1B[${linesUp}A\x1B[2K${this.formatServerLine(name)}\x1B[${linesUp}B\x1B[0G`);
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  /** Redraws all servers that are still in an active (non-terminal) phase. */
  private redrawAllActive(): void {
    for (const name of this.serverNames) {
      const state = this.states.get(name);
      if (state && state.phase !== 'done' && state.phase !== 'FAILED' && state.phase !== 'cached') {
        this.redrawServer(name);
      }
    }
  }

  private formatServerLine(name: string): string {
    const state = this.getState(name);
    const paddedName = name.padEnd(this.maxNameLength);
    const elapsed = ((Date.now() - state.phaseStartTime) / 1000).toFixed(0);
    const phaseText = formatPhaseTag(state.phase);
    const detail = state.detail ? `  ${chalk.dim(state.detail)}` : '';

    if (state.phase === 'done') {
      return `  ${chalk.green(paddedName)}  ${phaseText}  ${chalk.dim(state.summary ?? '')}`;
    }
    if (state.phase === 'FAILED') {
      return `  ${chalk.red(paddedName)}  ${phaseText}  ${chalk.dim(state.error?.message ?? '')}`;
    }
    if (state.phase === 'cached') {
      return `  ${chalk.green(paddedName)}  ${phaseText}`;
    }

    return `  ${paddedName}  ${phaseText}  ${chalk.dim(`(${elapsed}s)`)}${detail}`;
  }

  // -------------------------------------------------------------------------
  // Non-TTY fallback
  // -------------------------------------------------------------------------

  private logLineBasedUpdate(name: string, state: ServerState): void {
    const elapsed = ((Date.now() - state.startTime) / 1000).toFixed(1);
    process.stderr.write(`  ${name.padEnd(this.maxNameLength)}  [${state.phase}]  (${elapsed}s)\n`);
  }

  // -------------------------------------------------------------------------
  // Diagnostics flush
  // -------------------------------------------------------------------------

  private flushDiagnostics(): void {
    for (const name of this.serverNames) {
      const state = this.getState(name);
      const hasOutput = state.warnings.length > 0 || state.error;
      if (!hasOutput) continue;

      const statusLabel = state.phase === 'FAILED' ? 'FAILED' : `${state.warnings.length} warning(s)`;
      process.stderr.write(`\n--- ${name} (${statusLabel}) ---\n`);

      for (const warning of state.warnings) {
        process.stderr.write(`${warning}\n`);
      }

      if (state.error) {
        process.stderr.write(`  ${chalk.red(state.error.message)}\n`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ParallelProgressReporter
// ---------------------------------------------------------------------------

/**
 * Progress reporter for a single server, backed by ParallelProgressDisplay.
 * Buffers warnings and routes phase transitions to the display.
 */
export class ParallelProgressReporter implements ServerProgressReporter {
  private readonly display: ParallelProgressDisplay;
  private readonly serverName: string;

  constructor(display: ParallelProgressDisplay, serverName: string) {
    this.display = display;
    this.serverName = serverName;
  }

  update(phase: CompilationPhase, detail?: string): void {
    this.display.updateServer(this.serverName, phase, detail);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface conformance
  complete(phase: CompilationPhase, summary: string, elapsed: number): void {
    // For parallel mode, we update the phase display rather than
    // printing a completion message. The summary is shown in finish().
    this.display.updateServer(this.serverName, phase);
  }

  warn(message: string): void {
    this.display.bufferWarning(this.serverName, message);
  }

  fail(phase: CompilationPhase, error: Error): void {
    this.display.captureError(this.serverName, error);
  }

  done(summary: string): void {
    this.display.setDone(this.serverName, summary);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPhaseTag(phase: string): string {
  switch (phase) {
    case 'cached':
      return chalk.green('[cached]');
    case 'done':
      return chalk.green('[done]');
    case 'FAILED':
      return chalk.red('[FAILED]');
    case 'pending':
      return chalk.dim('[pending]');
    default:
      return chalk.cyan(`[${phase}]`);
  }
}
