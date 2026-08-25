/** Pure evidence helpers for the manual Apple nested-PTY smoke gate. */

import type { Terminal } from '@xterm/headless';

const CLAUDE_TITLE = /\bClaude Code\b/iu;
const CLAUDE_INTERACTIVE_ANCHORS = [
  /(?:^|\s)[❯›>]\s/u,
  /(?:^|\s)(?:\/help\b|\? for shortcuts\b)/iu,
  /\b(?:low|medium|high|max)\s*·\s*\/effort\b/iu,
  /\bfor agents\b/iu,
] as const;

export const MAX_TUI_EVIDENCE_BYTES = 2 * 1024 * 1024;

/** Keep only a bounded UTF-8 tail so a broken TUI cannot grow the harness indefinitely. */
export function appendBoundedOutput(previous: string, chunk: string, maxBytes = MAX_TUI_EVIDENCE_BYTES): string {
  const combined = Buffer.from(previous + chunk);
  if (combined.length <= maxBytes) return combined.toString('utf8');
  let start = combined.length - maxBytes;
  // Do not decode from the middle of a UTF-8 continuation sequence: replacing
  // an incomplete codepoint could make the returned string exceed the cap.
  while (start < combined.length && (combined[start]! & 0xc0) === 0x80) start += 1;
  return combined.subarray(start).toString('utf8');
}

/** Read only the live xterm viewport, excluding stale scrollback. */
export function renderCurrentTerminalScreen(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}

/** Clear observer-owned evidence cells without sending input to the child PTY. */
export function resetTerminalEvidenceViewport(terminal: Terminal): Promise<void> {
  return new Promise((resolvePromise) => terminal.write('\x1b[2J\x1b[3J\x1b[H', resolvePromise));
}

export interface ClaudeTuiEvidence {
  /** Visible cells from the headless xterm after the activation boundary. */
  readonly renderedScreen: string;
  /** At least one child-output chunk completed after that boundary. */
  readonly receivedPostActivationOutput: boolean;
  /** The production PTY child is still alive while its screen is inspected. */
  readonly childAlive: boolean;
}

/**
 * Require a live post-activation child plus Claude's title and multiple
 * interactive-screen anchors. Claude has used both framed and ASCII-logo
 * layouts, so xterm's current cell grid is the authority rather than one raw
 * ANSI title shape. IronCurtain startup diagnostics that merely name Claude
 * Code do not qualify.
 */
export function hasClaudeTuiEvidence(evidence: ClaudeTuiEvidence): boolean {
  if (!evidence.childAlive || !evidence.receivedPostActivationOutput) return false;
  if (!CLAUDE_TITLE.test(evidence.renderedScreen)) return false;
  const anchorCount = CLAUDE_INTERACTIVE_ANCHORS.filter((anchor) => anchor.test(evidence.renderedScreen)).length;
  return anchorCount >= 2;
}
