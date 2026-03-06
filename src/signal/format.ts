/**
 * Formatting utilities for Signal messages.
 *
 * All functions produce plain text with Signal's styled markup
 * (**bold**, *italic*, `mono`, ~strike~). Output is intended
 * to be sent with `text_mode: "styled"`.
 */

import type { EscalationRequest, BudgetStatus } from '../session/types.js';
import { describeCronExpression, formatRelativeTime } from '../cron/format-utils.js';

/** Maximum length for a single Signal message. */
export const SIGNAL_MAX_MESSAGE_LENGTH = 2000;

/**
 * Formats an escalation request as a styled text banner.
 * Includes tool name, arguments, reason, and instructions
 * for the user to reply "approve" or "deny".
 *
 * When sessionLabel is provided, includes `[#N]` in the header
 * so the user knows which session is escalating.
 */
export function formatEscalationBanner(request: EscalationRequest, sessionLabel?: number): string {
  const separator = '\u2501'.repeat(30); // box drawing heavy horizontal
  const labelTag = sessionLabel != null ? ` [#${sessionLabel}]` : '';
  const header = `**ESCALATION${labelTag}: Human approval required**`;
  const toolLine = `Tool: \`${request.serverName}/${request.toolName}\``;
  const argsLine = `Arguments: \`${JSON.stringify(request.arguments)}\``;
  const contextLines = request.context ? Object.entries(request.context).map(([k, v]) => `${k}: \`${v}\``) : [];
  const reasonLine = `Reason: *${request.reason}*`;
  const instructions = '**Reply "approve" or "deny"**';

  return [
    separator,
    header,
    separator,
    toolLine,
    argsLine,
    ...contextLines,
    reasonLine,
    separator,
    instructions,
    separator,
  ].join('\n');
}

/**
 * Formats budget status for the /budget command.
 * Shows current turn consumption and session totals.
 */
export function formatBudgetMessage(status: BudgetStatus): string {
  const { limits, cumulative } = status;
  const lines: string[] = ['**Current turn budget:**'];

  if (status.tokenTrackingAvailable) {
    lines.push(formatBudgetLine('Tokens', status.totalTokens, limits.maxTotalTokens, (v) => v.toLocaleString()));
  } else {
    lines.push('  Tokens: N/A');
  }
  lines.push(formatBudgetLine('Steps', status.stepCount, limits.maxSteps, String));
  lines.push(formatBudgetLine('Time', status.elapsedSeconds, limits.maxSessionSeconds, (v) => `${Math.round(v)}s`));
  lines.push(
    formatBudgetLine('Est. cost', status.estimatedCostUsd, limits.maxEstimatedCostUsd, (v) => `$${v.toFixed(2)}`),
  );

  lines.push('');
  lines.push('**Session totals:**');
  if (status.tokenTrackingAvailable) {
    lines.push(`  Tokens: ${cumulative.totalTokens.toLocaleString()}`);
  } else {
    lines.push('  Tokens: N/A');
  }
  lines.push(`  Steps: ${cumulative.stepCount}`);
  lines.push(`  Active time: ${Math.round(cumulative.activeSeconds)}s`);
  lines.push(`  Est. cost: $${cumulative.estimatedCostUsd.toFixed(2)}`);

  return lines.join('\n');
}

/**
 * Formats a compact budget summary for session end messages.
 */
export function formatBudgetSummary(status: BudgetStatus): string {
  const { cumulative } = status;
  const tokensPart = status.tokenTrackingAvailable ? `${cumulative.totalTokens.toLocaleString()} tokens, ` : '';
  return (
    `Session: ${tokensPart}` +
    `${cumulative.stepCount} steps` +
    `, ${Math.round(cumulative.activeSeconds)}s` +
    `, ~$${cumulative.estimatedCostUsd.toFixed(2)}`
  );
}

/**
 * Splits a message into chunks respecting the max length.
 * Prefers splitting at double-newlines (paragraph breaks),
 * then single newlines, then at the hard limit.
 */
export function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to find a paragraph break within the limit
    let splitIdx = remaining.lastIndexOf('\n\n', maxLength);
    if (splitIdx <= 0) {
      // Fall back to line break
      splitIdx = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitIdx <= 0) {
      // Hard split at max length
      splitIdx = maxLength;
    }

    chunks.push(remaining.substring(0, splitIdx).trimEnd());
    remaining = remaining.substring(splitIdx).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Information about a managed session for display purposes.
 */
export interface SessionListEntry {
  readonly label: number;
  readonly turnCount: number;
  readonly budgetPercent: number;
}

/**
 * Formats the /sessions command output.
 * Marks the current session with `>`.
 */
export function formatSessionList(sessions: SessionListEntry[], currentLabel: number | null): string {
  if (sessions.length === 0) return 'No active sessions.';

  const lines = ['**Active sessions:**'];
  for (const s of sessions) {
    const marker = s.label === currentLabel ? '>' : ' ';
    lines.push(`${marker} #${s.label}  turns: ${s.turnCount}  budget: ${s.budgetPercent}%`);
  }
  return lines.join('\n');
}

/**
 * Prefixes a message with `[#N]` when multiple sessions are active.
 */
export function prefixWithLabel(text: string, label: number, sessionCount: number): string {
  if (sessionCount <= 1) return text;
  return `[#${label}] ${text}`;
}

// --- Job list formatting ---

/**
 * Information about a scheduled job for display in Signal.
 * Dates are ISO strings (serialized by the control socket).
 */
export interface JobListEntry {
  readonly job: {
    readonly id: string;
    readonly name: string;
    readonly schedule: string;
    readonly enabled: boolean;
  };
  readonly nextRun: string | null;
  readonly lastRun:
    | {
        readonly outcome: { readonly kind: string; readonly message?: string; readonly dimension?: string };
        readonly startedAt: string;
      }
    | undefined;
  readonly isRunning: boolean;
}

/**
 * Formats the /jobs command output.
 * Shows each job with schedule, status, next run, and last run outcome.
 */
export function formatJobList(jobs: JobListEntry[]): string {
  if (jobs.length === 0) return 'No scheduled jobs.';

  const lines = ['**Scheduled jobs:**'];
  for (const entry of jobs) {
    lines.push('');
    lines.push(formatJobEntry(entry));
  }
  return lines.join('\n');
}

function formatJobEntry(entry: JobListEntry): string {
  const { job, nextRun, lastRun, isRunning } = entry;
  const lines: string[] = [];

  // Header: name + status tags
  const tags: string[] = [];
  if (isRunning) tags.push('[RUNNING]');
  if (!job.enabled) tags.push('[DISABLED]');
  const tagSuffix = tags.length > 0 ? ' ' + tags.join(' ') : '';
  lines.push(`**${job.name}** (\`${job.id}\`)${tagSuffix}`);

  // Schedule
  const scheduleDesc = describeCronExpression(job.schedule);
  lines.push(`  Schedule: ${scheduleDesc}`);

  // Next run
  if (nextRun) {
    lines.push(`  Next run: ${formatRelativeTime(new Date(nextRun))}`);
  } else if (!job.enabled) {
    lines.push('  Next run: disabled');
  } else {
    lines.push('  Next run: --');
  }

  // Last run
  if (lastRun) {
    const outcomeStr = formatRunOutcome(lastRun.outcome);
    const timeStr = formatRelativeTime(new Date(lastRun.startedAt));
    lines.push(`  Last run: ${outcomeStr}, ${timeStr}`);
  }

  return lines.join('\n');
}

function formatRunOutcome(outcome: { kind: string; message?: string; dimension?: string }): string {
  switch (outcome.kind) {
    case 'success':
      return 'success';
    case 'budget_exhausted':
      return `budget exhausted (${outcome.dimension ?? 'unknown'})`;
    case 'error':
      return `error: ${outcome.message ?? 'unknown'}`;
    default:
      return outcome.kind;
  }
}

// --- Private helpers ---

function formatBudgetLine(label: string, current: number, limit: number | null, format: (v: number) => string): string {
  const currentStr = format(current);
  if (limit === null) return `  ${label}: ${currentStr} (no limit)`;
  const pct = limit > 0 ? Math.round((current / limit) * 100) : 0;
  return `  ${label}: ${currentStr} / ${format(limit)} (${pct}%)`;
}
