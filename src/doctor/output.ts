/**
 * Output formatting for `ironcurtain doctor`.
 *
 * Uses process.stdout.write directly because src/logger.ts may hijack
 * console.* on the host process. Each helper writes a single line.
 */

import chalk from 'chalk';
import type { CheckResult } from './checks.js';

/** Width of the name column in the doctor output table. */
const NAME_COLUMN_WIDTH = 24;

/** Status -> glyph mapping. The glyphs are ASCII-friendly fallbacks. */
const STATUS_GLYPH: Record<CheckResult['status'], string> = {
  ok: chalk.green('✓'), // ✓
  warn: chalk.yellow('⚠'), // ⚠
  fail: chalk.red('✗'), // ✗
  skip: chalk.dim('↷'), // ↷
};

/** Pads `text` with spaces on the right to reach at least `width` characters. */
function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * Prints a section heading to stdout (e.g. "Environment", "MCP servers").
 * A blank line is emitted before the heading except for the first section.
 */
export function printSection(title: string, opts: { first?: boolean } = {}): void {
  if (!opts.first) {
    process.stdout.write('\n');
  }
  process.stdout.write(chalk.bold(title) + '\n');
}

/**
 * Prints a single check result as one (or two) lines:
 *   <glyph> <name padded><message>
 *     └─ <hint>
 *
 * The hint is only emitted when present.
 */
export function printCheck(check: CheckResult): void {
  const glyph = STATUS_GLYPH[check.status];
  const name = padRight(check.name, NAME_COLUMN_WIDTH);
  process.stdout.write(`  ${glyph} ${name}${check.message}\n`);
  if (check.hint) {
    process.stdout.write(`    ${chalk.dim('└─')} ${check.hint}\n`);
  }
}

/**
 * Prints the summary footer counting checks by status.
 */
export function printSummary(checks: readonly CheckResult[]): void {
  let ok = 0;
  let warn = 0;
  let fail = 0;
  let skip = 0;
  for (const c of checks) {
    switch (c.status) {
      case 'ok':
        ok++;
        break;
      case 'warn':
        warn++;
        break;
      case 'fail':
        fail++;
        break;
      case 'skip':
        skip++;
        break;
    }
  }
  process.stdout.write('\n');
  const okPart = chalk.green(`${ok} ok`);
  const warnPart = chalk.yellow(`${warn} warn`);
  const failPart = chalk.red(`${fail} fail`);
  const skipPart = chalk.dim(`${skip} skipped`);
  process.stdout.write(`Summary: ${okPart}, ${warnPart}, ${failPart}, ${skipPart}\n`);
}
