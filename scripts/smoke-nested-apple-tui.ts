/** Pure evidence helpers for the manual Apple nested-PTY smoke gate. */

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/gu;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu;
const TERMINAL_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const CLAUDE_FRAMED_TITLE = /[╭┌](?:(?:─|━|-)+)[^\r\n]{0,160}\bClaude Code\b[^\r\n]{0,160}[╮┐]/iu;

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

/**
 * Require both Claude's title and its rendered terminal frame. This excludes
 * IronCurtain startup diagnostics that merely mention the selected agent.
 */
export function hasClaudeTuiEvidence(raw: string): boolean {
  if (raw.length === 0) return false;
  const visible = raw.replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(TERMINAL_CONTROL, '');
  return CLAUDE_FRAMED_TITLE.test(visible);
}
