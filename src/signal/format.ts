/**
 * Formatting utilities for Signal messages.
 *
 * All functions produce plain text with Signal's styled markup
 * (**bold**, *italic*, `mono`, ~strike~). Output is intended
 * to be sent with `text_mode: "styled"`.
 */

import type { EscalationRequest, BudgetStatus } from '../session/types.js';

/** Maximum length for a single Signal message. */
export const SIGNAL_MAX_MESSAGE_LENGTH = 2000;

/**
 * Formats an escalation request as a styled text banner.
 * Includes tool name, arguments, reason, and instructions
 * for the user to reply "approve" or "deny".
 */
export function formatEscalationBanner(request: EscalationRequest): string {
  const separator = '\u2501'.repeat(30); // box drawing heavy horizontal
  const header = '**ESCALATION: Human approval required**';
  const toolLine = `Tool: \`${request.serverName}/${request.toolName}\``;
  const argsLine = `Arguments: \`${JSON.stringify(request.arguments)}\``;
  const reasonLine = `Reason: *${request.reason}*`;
  const instructions = '**Reply "approve" or "deny"**';

  return [separator, header, separator, toolLine, argsLine, reasonLine, separator, instructions, separator].join('\n');
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

// --- Private helpers ---

function formatBudgetLine(label: string, current: number, limit: number | null, format: (v: number) => string): string {
  const currentStr = format(current);
  if (limit === null) return `  ${label}: ${currentStr} (no limit)`;
  const pct = limit > 0 ? Math.round((current / limit) * 100) : 0;
  return `  ${label}: ${currentStr} / ${format(limit)} (${pct}%)`;
}
