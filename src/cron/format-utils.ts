/**
 * Formatting utilities for cron job CLI output.
 */

import { parseCronExpression, type CronFields } from './cron-scheduler.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------------------------------------------------------------------------
// Duration and relative time display
// ---------------------------------------------------------------------------

/**
 * Formats a duration in seconds as a compact string like "1d 2h 30m".
 * Shows up to two units for brevity (e.g., "2h 15m" not "2h 15m 30s").
 */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours % 24 > 0) parts.push(`${hours % 24}h`);
  if (minutes % 60 > 0 && days === 0) parts.push(`${minutes % 60}m`);
  if (parts.length === 0) parts.push('0m');
  return parts.join(' ');
}

/**
 * Formats a date as a relative time string with an absolute time suffix.
 * Examples: "in 2h 15m (Mar 5, 09:00)", "3h ago (Mar 5, 06:00)", "just now (Mar 5, 09:00)"
 */
export function formatRelativeTime(date: Date, now = new Date()): string {
  const diffMs = date.getTime() - now.getTime();
  const absDiffSec = Math.floor(Math.abs(diffMs) / 1000);
  const absolute = formatAbsoluteTime(date);

  if (absDiffSec < 60) return `just now (${absolute})`;

  const dur = formatDuration(absDiffSec);
  const relative = diffMs >= 0 ? `in ${dur}` : `${dur} ago`;
  return `${relative} (${absolute})`;
}

function formatAbsoluteTime(date: Date): string {
  const month = MONTH_NAMES[date.getMonth()];
  const day = date.getDate();
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${month} ${day}, ${hours}:${minutes}`;
}

// ---------------------------------------------------------------------------
// Cron expression description
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Converts a 5-field cron expression into a human-readable English description.
 * Covers common patterns well; exotic expressions get a best-effort description.
 */
export function describeCronExpression(expr: string): string {
  let fields: CronFields;
  try {
    fields = parseCronExpression(expr);
  } catch {
    return expr; // fallback to raw expression if unparseable
  }

  const parts: string[] = [];

  // Time part
  parts.push(describeTimePart(expr, fields));

  // Day-of-week part
  const dowPart = describeDaysOfWeek(fields);
  if (dowPart) parts.push(dowPart);

  // Day-of-month part
  const domPart = describeDaysOfMonth(fields);
  if (domPart) parts.push(domPart);

  // Month part
  const monthPart = describeMonths(fields);
  if (monthPart) parts.push(monthPart);

  return parts.join(', ');
}

function describeTimePart(expr: string, fields: CronFields): string {
  const rawParts = expr.trim().split(/\s+/);
  const minField = rawParts[0];
  const hourField = rawParts[1];

  // Every N minutes
  const minStep = minField.match(/^\*\/(\d+)$/);
  if (minStep && hourField === '*') {
    return `Every ${minStep[1]} minutes`;
  }

  // Every hour at specific minute
  if (fields.minutes.size === 1 && hourField === '*') {
    const min = [...fields.minutes][0];
    return min === 0 ? 'Every hour' : `Every hour at :${min.toString().padStart(2, '0')}`;
  }

  // Every N hours
  const hourStep = hourField.match(/^\*\/(\d+)$/);
  if (hourStep && fields.minutes.size === 1) {
    const min = [...fields.minutes][0];
    return `Every ${hourStep[1]} hours at :${min.toString().padStart(2, '0')}`;
  }

  // Specific time(s)
  if (fields.hours.size <= 3 && fields.minutes.size === 1) {
    const min = [...fields.minutes][0];
    const times = [...fields.hours]
      .sort((a, b) => a - b)
      .map((h) => `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`);
    return `At ${times.join(', ')}`;
  }

  // Fallback: describe minutes and hours separately
  return `At minute ${[...fields.minutes].sort((a, b) => a - b).join(',')} of hour ${[...fields.hours].sort((a, b) => a - b).join(',')}`;
}

function describeDaysOfWeek(fields: CronFields): string | null {
  if (fields.daysOfWeek.size === 7) return null; // wildcard

  const days = [...fields.daysOfWeek].sort((a, b) => a - b);

  // Check for contiguous range
  if (days.length >= 2 && isContiguous(days)) {
    return `${DAY_NAMES[days[0]]}--${DAY_NAMES[days[days.length - 1]]}`;
  }

  return days.map((d) => DAY_NAMES[d]).join(', ');
}

function describeDaysOfMonth(fields: CronFields): string | null {
  if (fields.daysOfMonth.size === 31) return null; // wildcard

  const days = [...fields.daysOfMonth].sort((a, b) => a - b);
  return `on day ${days.join(', ')} of the month`;
}

function describeMonths(fields: CronFields): string | null {
  if (fields.months.size === 12) return null; // wildcard

  const months = [...fields.months].sort((a, b) => a - b);
  return `in ${months.map((m) => MONTH_NAMES[m - 1]).join(', ')}`;
}

function isContiguous(sorted: number[]): boolean {
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) return false;
  }
  return true;
}
