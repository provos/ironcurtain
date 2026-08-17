import { describe, expect, it } from 'vitest';
import { appendBoundedTuiOutput, hasClaudeTuiEvidence } from '../scripts/smoke-nested-apple-tui.js';

describe('nested Apple PTY smoke evidence', () => {
  it('accepts a framed Claude Code screen emitted after activation', () => {
    const output = '\x1b[2J╭── Claude Code v2.1.0 ──╮\r\n│ Welcome                 │\r\n╰─────────────────────────╯';
    expect(hasClaudeTuiEvidence(output)).toBe(true);
  });

  it.each(['', 'Docker-workload lease active', 'selected agent: Claude Code', '\x1b[2J╭── loading ──╮'])(
    'rejects zero-byte and non-agent startup evidence: %j',
    (output) => {
      expect(hasClaudeTuiEvidence(output)).toBe(false);
    },
  );

  it('bounds retained output to a tail without losing the newest TUI evidence', () => {
    const output = appendBoundedTuiOutput('x'.repeat(100), '╭── Claude Code ──╮\n╰─────────────────╯', 96);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(96);
    expect(hasClaudeTuiEvidence(output)).toBe(true);
  });
});
