/**
 * Output formatting for `ironcurtain observe`.
 *
 * Pure functions that transform TokenStreamEvent batches into
 * terminal-friendly text. No I/O or side effects -- all output
 * is returned as strings.
 */

import chalk from 'chalk';
import type { TokenStreamEvent } from '../docker/token-stream-types.js';
import { truncate } from '../mux/mux-renderer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Show all event kinds, not just text. */
  readonly raw: boolean;
  /** Output events as newline-delimited JSON. */
  readonly json: boolean;
  /** When set, prefix output lines with a session label. */
  readonly showLabel: boolean;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Render a batch of events for a single session label. */
export function renderEventBatch(label: number, events: readonly TokenStreamEvent[], options: RenderOptions): string {
  const parts: string[] = [];
  for (const event of events) {
    const rendered = renderEvent(label, event, options);
    if (rendered !== null) {
      parts.push(rendered);
    }
  }
  return parts.join('');
}

/** Render a single event. Returns null if the event should be suppressed. */
export function renderEvent(label: number, event: TokenStreamEvent, options: RenderOptions): string | null {
  if (options.json) {
    return renderJson(label, event);
  }
  return renderText(label, event, options);
}

// ---------------------------------------------------------------------------
// JSON mode
// ---------------------------------------------------------------------------

function renderJson(label: number, event: TokenStreamEvent): string {
  return JSON.stringify({ label, ...event }) + '\n';
}

// ---------------------------------------------------------------------------
// Text mode
// ---------------------------------------------------------------------------

function renderText(label: number, event: TokenStreamEvent, options: RenderOptions): string | null {
  const prefix = options.showLabel ? chalk.dim(`[${label}] `) : '';

  switch (event.kind) {
    case 'text_delta':
      return `${prefix}${event.text}`;

    case 'tool_use':
      if (!options.raw) return null;
      return `${prefix}${chalk.cyan(`[tool: ${event.toolName}]`)} ${chalk.dim(truncate(event.inputDelta, 120))}\n`;

    case 'message_start':
      if (!options.raw) return null;
      return `${prefix}${chalk.green(`--- message start (${event.model}) ---`)}\n`;

    case 'message_end':
      if (!options.raw) return null;
      return `${prefix}${chalk.green(`--- message end (${event.stopReason}, ${event.inputTokens}+${event.outputTokens} tokens) ---`)}\n`;

    case 'error':
      return `${prefix}${chalk.red(`[error] ${event.message}`)}\n`;

    case 'raw':
      if (!options.raw) return null;
      return `${prefix}${chalk.dim(`[${event.eventType}] ${truncate(event.data, 120)}`)}\n`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render a connection header message. */
export function renderConnected(label?: number): string {
  if (label !== undefined) {
    return chalk.dim(`Observing session ${label}. Press Ctrl+C to stop.\n`);
  }
  return chalk.dim('Observing all sessions. Press Ctrl+C to stop.\n');
}

/** Render a session-ended notification. */
export function renderSessionEnded(label: number, reason: string): string {
  return chalk.dim(`\nSession ${label} ended: ${reason}\n`);
}
