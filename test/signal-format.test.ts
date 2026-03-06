/**
 * Tests for src/signal/format.ts and src/signal/markdown-to-signal.ts.
 *
 * These modules have no existing test coverage. Tests cover:
 * - formatEscalationBanner: with/without session label and context
 * - formatBudgetMessage: token tracking on/off, null limits
 * - formatBudgetSummary: token tracking on/off
 * - splitMessage: short messages, paragraph/line splits, hard splits
 * - formatSessionList: empty, single, multi-session, current marker
 * - prefixWithLabel: single vs multi-session labelling
 * - formatJobList: empty, running, disabled, various last-run outcomes
 * - markdownToSignal: all block and inline token types
 */

import { describe, it, expect } from 'vitest';
import {
  formatEscalationBanner,
  formatBudgetMessage,
  formatBudgetSummary,
  splitMessage,
  formatSessionList,
  prefixWithLabel,
  formatJobList,
  SIGNAL_MAX_MESSAGE_LENGTH,
} from '../src/signal/format.js';
import type { JobListEntry, SessionListEntry } from '../src/signal/format.js';
import { markdownToSignal } from '../src/signal/markdown-to-signal.js';
import type { BudgetStatus } from '../src/session/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBudgetStatus(overrides: Partial<BudgetStatus> = {}): BudgetStatus {
  return {
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalTokens: 1500,
    stepCount: 5,
    elapsedSeconds: 120,
    estimatedCostUsd: 0.05,
    tokenTrackingAvailable: true,
    limits: {
      maxTotalTokens: 10000,
      maxSteps: 100,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5.0,
      warnThresholdPercent: 80,
    },
    cumulative: {
      totalInputTokens: 5000,
      totalOutputTokens: 2000,
      totalTokens: 7000,
      stepCount: 25,
      activeSeconds: 600,
      estimatedCostUsd: 0.25,
    },
    ...overrides,
  };
}

function makeEscalationRequest(overrides: Partial<Parameters<typeof formatEscalationBanner>[0]> = {}) {
  return {
    escalationId: 'esc-1',
    toolName: 'delete_file',
    serverName: 'filesystem',
    arguments: { path: '/tmp/test.txt' },
    reason: 'Deletes a file outside sandbox',
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobListEntry['job']> = {}): JobListEntry['job'] {
  return {
    id: 'job-abc',
    name: 'Daily backup',
    schedule: '0 2 * * *',
    enabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatEscalationBanner
// ---------------------------------------------------------------------------

describe('formatEscalationBanner', () => {
  it('includes tool name, arguments, and reason', () => {
    const banner = formatEscalationBanner(makeEscalationRequest());
    expect(banner).toContain('filesystem/delete_file');
    expect(banner).toContain('/tmp/test.txt');
    expect(banner).toContain('Deletes a file outside sandbox');
  });

  it('does not include session label when omitted', () => {
    const banner = formatEscalationBanner(makeEscalationRequest());
    expect(banner).not.toContain('[#');
    expect(banner).toContain('ESCALATION:');
  });

  it('includes session label when provided', () => {
    const banner = formatEscalationBanner(makeEscalationRequest(), 3);
    expect(banner).toContain('[#3]');
    expect(banner).toContain('ESCALATION [#3]:');
  });

  it('includes session label 0 (falsy but valid)', () => {
    const banner = formatEscalationBanner(makeEscalationRequest(), 0);
    expect(banner).toContain('[#0]');
  });

  it('includes context key-value pairs when present', () => {
    const request = makeEscalationRequest({ context: { branch: 'main', repo: 'provos/ironcurtain' } });
    const banner = formatEscalationBanner(request);
    expect(banner).toContain('branch: `main`');
    expect(banner).toContain('repo: `provos/ironcurtain`');
  });

  it('omits context section when context is undefined', () => {
    const request = makeEscalationRequest({ context: undefined });
    const banner = formatEscalationBanner(request);
    // Only tool, args, reason lines between separators
    expect(banner).not.toMatch(/\w+: `\w+`.*\n.*\w+: `\w+`/);
  });

  it('includes approve/deny instructions', () => {
    const banner = formatEscalationBanner(makeEscalationRequest());
    expect(banner).toContain('approve');
    expect(banner).toContain('deny');
  });

  it('formats arguments as JSON', () => {
    const request = makeEscalationRequest({ arguments: { path: '/foo', force: true } });
    const banner = formatEscalationBanner(request);
    expect(banner).toContain(JSON.stringify({ path: '/foo', force: true }));
  });
});

// ---------------------------------------------------------------------------
// formatBudgetMessage
// ---------------------------------------------------------------------------

describe('formatBudgetMessage', () => {
  it('shows current and total values with token tracking available', () => {
    const msg = formatBudgetMessage(makeBudgetStatus());
    expect(msg).toContain('Tokens:');
    expect(msg).toContain('Steps:');
    expect(msg).toContain('Time:');
    expect(msg).toContain('Est. cost:');
    expect(msg).toContain('Session totals:');
  });

  it('shows percentage when limits are set', () => {
    const msg = formatBudgetMessage(makeBudgetStatus());
    // 1500/10000 = 15%, 5/100 = 5%
    expect(msg).toContain('15%');
    expect(msg).toContain('5%');
  });

  it('shows N/A for tokens when tokenTrackingAvailable is false', () => {
    const msg = formatBudgetMessage(makeBudgetStatus({ tokenTrackingAvailable: false }));
    expect(msg).toContain('Tokens: N/A');
    // Session totals also shows N/A
    const lines = msg.split('\n');
    const tokenNaLines = lines.filter((l) => l.includes('Tokens: N/A'));
    expect(tokenNaLines.length).toBe(2); // once in current, once in session totals
  });

  it('shows "no limit" when a limit is null', () => {
    const status = makeBudgetStatus({
      limits: {
        maxTotalTokens: null,
        maxSteps: null,
        maxSessionSeconds: null,
        maxEstimatedCostUsd: null,
        warnThresholdPercent: 80,
      },
    });
    const msg = formatBudgetMessage(status);
    expect(msg).toContain('no limit');
  });

  it('shows cumulative active seconds and cost in session totals', () => {
    const msg = formatBudgetMessage(makeBudgetStatus());
    expect(msg).toContain('Active time: 600s');
    expect(msg).toContain('Est. cost: $0.25');
  });

  it('formats elapsed seconds as rounded value', () => {
    const msg = formatBudgetMessage(makeBudgetStatus({ elapsedSeconds: 73.7 }));
    expect(msg).toContain('74s');
  });

  it('shows 0% when limit is zero (avoids division by zero)', () => {
    const status = makeBudgetStatus({
      limits: {
        maxTotalTokens: 0,
        maxSteps: 0,
        maxSessionSeconds: 0,
        maxEstimatedCostUsd: 0,
        warnThresholdPercent: 80,
      },
    });
    const msg = formatBudgetMessage(status);
    expect(msg).toContain('0%');
  });
});

// ---------------------------------------------------------------------------
// formatBudgetSummary
// ---------------------------------------------------------------------------

describe('formatBudgetSummary', () => {
  it('includes tokens, steps, time, and cost when tracking is available', () => {
    const summary = formatBudgetSummary(makeBudgetStatus());
    // Use toLocaleString() to match the implementation's locale-aware formatting
    expect(summary).toContain(`${(7000).toLocaleString()} tokens`);
    expect(summary).toContain('25 steps');
    expect(summary).toContain('600s');
    expect(summary).toContain('$0.25');
  });

  it('omits token count when tracking is unavailable', () => {
    const summary = formatBudgetSummary(makeBudgetStatus({ tokenTrackingAvailable: false }));
    expect(summary).not.toContain('tokens');
    expect(summary).toContain('25 steps');
    expect(summary).toContain('$0.25');
  });

  it('rounds active seconds', () => {
    const summary = formatBudgetSummary(
      makeBudgetStatus({
        cumulative: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          stepCount: 1,
          activeSeconds: 45.6,
          estimatedCostUsd: 0.01,
        },
      }),
    );
    expect(summary).toContain('46s');
  });
});

// ---------------------------------------------------------------------------
// splitMessage
// ---------------------------------------------------------------------------

describe('splitMessage', () => {
  it('returns a single chunk when text fits within maxLength', () => {
    const chunks = splitMessage('hello world', 100);
    expect(chunks).toEqual(['hello world']);
  });

  it('returns single chunk for exact-length text', () => {
    const text = 'a'.repeat(50);
    expect(splitMessage(text, 50)).toEqual([text]);
  });

  it('splits at double-newline when available', () => {
    const para1 = 'First paragraph';
    const para2 = 'Second paragraph';
    const text = `${para1}\n\n${para2}`;
    const chunks = splitMessage(text, para1.length + 2); // just enough for para1 + \n\n
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it('falls back to single-newline split when no double-newline fits', () => {
    const line1 = 'Line one';
    const line2 = 'Line two';
    const text = `${line1}\n${line2}`;
    const chunks = splitMessage(text, line1.length + 1);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });

  it('hard-splits at maxLength when no newline is available', () => {
    const text = 'a'.repeat(10);
    const chunks = splitMessage(text, 4);
    expect(chunks[0]).toHaveLength(4);
    expect(chunks.join('')).toBe(text);
  });

  it('handles text that splits into multiple chunks', () => {
    const text = 'aaaa\n\nbbbb\n\ncccc';
    const chunks = splitMessage(text, 6);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('').replace(/\s+/g, '')).toBe('aaaabbbbcccc');
  });

  it('returns a single empty-string chunk for empty string input', () => {
    const chunks = splitMessage('', 100);
    // Empty string fits within any maxLength, so it's returned as a single chunk
    expect(chunks).toEqual(['']);
  });

  it('SIGNAL_MAX_MESSAGE_LENGTH constant is exported and positive', () => {
    expect(SIGNAL_MAX_MESSAGE_LENGTH).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatSessionList
// ---------------------------------------------------------------------------

describe('formatSessionList', () => {
  it('returns "No active sessions." for empty list', () => {
    expect(formatSessionList([], null)).toBe('No active sessions.');
  });

  it('marks the current session with ">"', () => {
    const sessions: SessionListEntry[] = [
      { label: 1, turnCount: 3, budgetPercent: 20 },
      { label: 2, turnCount: 7, budgetPercent: 50 },
    ];
    const output = formatSessionList(sessions, 2);
    const lines = output.split('\n');
    expect(lines.some((l) => l.startsWith('>') && l.includes('#2'))).toBe(true);
    expect(lines.some((l) => l.startsWith(' ') && l.includes('#1'))).toBe(true);
  });

  it('shows no ">" marker when currentLabel is null', () => {
    const sessions: SessionListEntry[] = [{ label: 1, turnCount: 2, budgetPercent: 10 }];
    const output = formatSessionList(sessions, null);
    expect(output).not.toContain('>');
  });

  it('displays turn count and budget percent for each session', () => {
    const sessions: SessionListEntry[] = [{ label: 5, turnCount: 12, budgetPercent: 75 }];
    const output = formatSessionList(sessions, 5);
    expect(output).toContain('turns: 12');
    expect(output).toContain('budget: 75%');
  });

  it('includes "Active sessions:" header', () => {
    const sessions: SessionListEntry[] = [{ label: 1, turnCount: 1, budgetPercent: 5 }];
    expect(formatSessionList(sessions, 1)).toContain('Active sessions:');
  });
});

// ---------------------------------------------------------------------------
// prefixWithLabel
// ---------------------------------------------------------------------------

describe('prefixWithLabel', () => {
  it('returns text unchanged when sessionCount is 1', () => {
    expect(prefixWithLabel('hello', 3, 1)).toBe('hello');
  });

  it('returns text unchanged when sessionCount is 0', () => {
    expect(prefixWithLabel('hello', 3, 0)).toBe('hello');
  });

  it('prepends [#N] label when multiple sessions are active', () => {
    expect(prefixWithLabel('hello', 3, 2)).toBe('[#3] hello');
  });

  it('uses the correct label number in the prefix', () => {
    expect(prefixWithLabel('msg', 7, 5)).toBe('[#7] msg');
  });
});

// ---------------------------------------------------------------------------
// formatJobList
// ---------------------------------------------------------------------------

describe('formatJobList', () => {
  it('returns "No scheduled jobs." for empty list', () => {
    expect(formatJobList([])).toBe('No scheduled jobs.');
  });

  it('includes "Scheduled jobs:" header', () => {
    const entry: JobListEntry = {
      job: makeJob(),
      nextRun: null,
      lastRun: undefined,
      isRunning: false,
    };
    expect(formatJobList([entry])).toContain('Scheduled jobs:');
  });

  it('shows job name and id', () => {
    const entry: JobListEntry = {
      job: makeJob({ name: 'Nightly sync', id: 'nightly-1' }),
      nextRun: null,
      lastRun: undefined,
      isRunning: false,
    };
    const output = formatJobList([entry]);
    expect(output).toContain('Nightly sync');
    expect(output).toContain('nightly-1');
  });

  it('shows [RUNNING] tag when job is running', () => {
    const entry: JobListEntry = {
      job: makeJob(),
      nextRun: null,
      lastRun: undefined,
      isRunning: true,
    };
    expect(formatJobList([entry])).toContain('[RUNNING]');
  });

  it('shows [DISABLED] tag when job is disabled', () => {
    const entry: JobListEntry = {
      job: makeJob({ enabled: false }),
      nextRun: null,
      lastRun: undefined,
      isRunning: false,
    };
    expect(formatJobList([entry])).toContain('[DISABLED]');
  });

  it('shows both [RUNNING] and [DISABLED] when both apply', () => {
    const entry: JobListEntry = {
      job: makeJob({ enabled: false }),
      nextRun: null,
      lastRun: undefined,
      isRunning: true,
    };
    const output = formatJobList([entry]);
    expect(output).toContain('[RUNNING]');
    expect(output).toContain('[DISABLED]');
  });

  it('shows "Next run: disabled" when disabled and no nextRun', () => {
    const entry: JobListEntry = {
      job: makeJob({ enabled: false }),
      nextRun: null,
      lastRun: undefined,
      isRunning: false,
    };
    expect(formatJobList([entry])).toContain('Next run: disabled');
  });

  it('shows "Next run: --" when enabled but no nextRun', () => {
    const entry: JobListEntry = {
      job: makeJob(),
      nextRun: null,
      lastRun: undefined,
      isRunning: false,
    };
    expect(formatJobList([entry])).toContain('Next run: --');
  });

  it('shows relative next run time when nextRun is provided', () => {
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours from now
    const entry: JobListEntry = {
      job: makeJob(),
      nextRun: future.toISOString(),
      lastRun: undefined,
      isRunning: false,
    };
    const output = formatJobList([entry]);
    expect(output).toContain('Next run:');
    // Should show relative time like "in 2h ..." or "in 1h ..."
    expect(output).toMatch(/Next run:.*h/);
  });

  it('shows "success" for successful last run', () => {
    const past = new Date(Date.now() - 60 * 1000); // 1 minute ago
    const entry: JobListEntry = {
      job: makeJob(),
      nextRun: null,
      lastRun: { outcome: { kind: 'success' }, startedAt: past.toISOString() },
      isRunning: false,
    };
    expect(formatJobList([entry])).toContain('success');
  });

  it('shows budget_exhausted with dimension for budget last run', () => {
    const past = new Date(Date.now() - 60 * 1000);
    const entry: JobListEntry = {
      job: makeJob(),
      nextRun: null,
      lastRun: {
        outcome: { kind: 'budget_exhausted', dimension: 'tokens' },
        startedAt: past.toISOString(),
      },
      isRunning: false,
    };
    const output = formatJobList([entry]);
    expect(output).toContain('budget exhausted (tokens)');
  });

  it('shows "unknown" for budget_exhausted without dimension', () => {
    const past = new Date(Date.now() - 60 * 1000);
    const entry: JobListEntry = {
      job: makeJob(),
      nextRun: null,
      lastRun: { outcome: { kind: 'budget_exhausted' }, startedAt: past.toISOString() },
      isRunning: false,
    };
    expect(formatJobList([entry])).toContain('budget exhausted (unknown)');
  });

  it('shows error message for error last run', () => {
    const past = new Date(Date.now() - 60 * 1000);
    const entry: JobListEntry = {
      job: makeJob(),
      nextRun: null,
      lastRun: {
        outcome: { kind: 'error', message: 'Connection refused' },
        startedAt: past.toISOString(),
      },
      isRunning: false,
    };
    expect(formatJobList([entry])).toContain('error: Connection refused');
  });

  it('shows "unknown" for error without message', () => {
    const past = new Date(Date.now() - 60 * 1000);
    const entry: JobListEntry = {
      job: makeJob(),
      nextRun: null,
      lastRun: { outcome: { kind: 'error' }, startedAt: past.toISOString() },
      isRunning: false,
    };
    expect(formatJobList([entry])).toContain('error: unknown');
  });

  it('shows raw kind for unknown outcome types', () => {
    const past = new Date(Date.now() - 60 * 1000);
    const entry: JobListEntry = {
      job: makeJob(),
      nextRun: null,
      lastRun: { outcome: { kind: 'cancelled' }, startedAt: past.toISOString() },
      isRunning: false,
    };
    expect(formatJobList([entry])).toContain('cancelled');
  });

  it('formats multiple jobs', () => {
    const entries: JobListEntry[] = [
      { job: makeJob({ id: 'job-1', name: 'Job One' }), nextRun: null, lastRun: undefined, isRunning: false },
      { job: makeJob({ id: 'job-2', name: 'Job Two' }), nextRun: null, lastRun: undefined, isRunning: true },
    ];
    const output = formatJobList(entries);
    expect(output).toContain('Job One');
    expect(output).toContain('Job Two');
  });
});

// ---------------------------------------------------------------------------
// markdownToSignal
// ---------------------------------------------------------------------------

describe('markdownToSignal', () => {
  describe('inline formatting', () => {
    it('converts bold to Signal **bold**', () => {
      const result = markdownToSignal('**hello world**');
      expect(result).toContain('**hello world**');
    });

    it('converts italic to Signal *italic*', () => {
      const result = markdownToSignal('*emphasis*');
      expect(result).toContain('*emphasis*');
    });

    it('converts inline code to Signal backtick', () => {
      const result = markdownToSignal('Use `npm install` to install');
      expect(result).toContain('`npm install`');
    });

    it('converts strikethrough to single ~ tilde (Signal syntax)', () => {
      const result = markdownToSignal('~~deleted~~');
      expect(result).toContain('~deleted~');
      // Should use single tilde, not double
      expect(result).not.toContain('~~deleted~~');
    });

    it('converts link to text + href', () => {
      const result = markdownToSignal('[example](https://example.com)');
      expect(result).toContain('example');
      expect(result).toContain('(https://example.com)');
    });

    it('replaces image with placeholder', () => {
      const result = markdownToSignal('![alt text](https://example.com/img.png)');
      expect(result).toContain('[Image: alt text]');
    });

    it('replaces image with no description placeholder when alt is empty', () => {
      const result = markdownToSignal('![](https://example.com/img.png)');
      expect(result).toContain('[Image: no description]');
    });
  });

  describe('block elements', () => {
    it('wraps heading text in **bold** and adds newlines', () => {
      const result = markdownToSignal('# My Heading');
      expect(result).toContain('**My Heading**');
    });

    it('adds paragraph separator after paragraph text', () => {
      const result = markdownToSignal('First paragraph\n\nSecond paragraph');
      // Both paragraphs should appear in the output
      expect(result).toContain('First paragraph');
      expect(result).toContain('Second paragraph');
    });

    it('wraps code block in backticks and adds newlines', () => {
      const result = markdownToSignal('```\nconst x = 1;\n```');
      expect(result).toContain('`');
      expect(result).toContain('const x = 1;');
    });

    it('prefixes blockquote with "| "', () => {
      const result = markdownToSignal('> quoted text');
      expect(result).toContain('| ');
    });

    it('formats unordered list items with "- " prefix', () => {
      const result = markdownToSignal('- item one\n- item two');
      expect(result).toContain('- item one');
      expect(result).toContain('- item two');
    });

    it('formats ordered list items with number prefix', () => {
      const result = markdownToSignal('1. first\n2. second\n3. third');
      expect(result).toContain('1. ');
      expect(result).toContain('2. ');
      expect(result).toContain('3. ');
    });

    it('renders horizontal rule as "---"', () => {
      const result = markdownToSignal('---');
      expect(result).toContain('---');
    });
  });

  describe('edge cases', () => {
    it('returns empty string for empty input', () => {
      expect(markdownToSignal('')).toBe('');
    });

    it('trims trailing whitespace from output', () => {
      const result = markdownToSignal('hello');
      expect(result).not.toMatch(/\s+$/);
    });

    it('handles nested inline formatting (bold inside)', () => {
      const result = markdownToSignal('**bold and *italic* inside**');
      expect(result).toContain('**');
      expect(result).toContain('*');
    });

    it('handles plain text with no markdown', () => {
      const result = markdownToSignal('just plain text here');
      expect(result).toBe('just plain text here');
    });

    it('processes multiple block-level elements', () => {
      const md = '# Title\n\nSome paragraph.\n\n- item one\n- item two';
      const result = markdownToSignal(md);
      expect(result).toContain('**Title**');
      expect(result).toContain('Some paragraph');
      expect(result).toContain('- item one');
    });
  });
});
