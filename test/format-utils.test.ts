/**
 * Tests for src/cron/format-utils.ts
 * Covers formatDuration, formatRelativeTime, and describeCronExpression.
 */

import { describe, it, expect } from 'vitest';
import { formatDuration, formatRelativeTime, describeCronExpression } from '../src/cron/format-utils.js';

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it('returns "0m" for zero seconds', () => {
    expect(formatDuration(0)).toBe('0m');
  });

  it('returns "0m" for sub-minute durations (< 60s)', () => {
    expect(formatDuration(59)).toBe('0m');
  });

  it('formats minutes only', () => {
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(3540)).toBe('59m');
  });

  it('formats hours and minutes (no days)', () => {
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(3660)).toBe('1h 1m');
    expect(formatDuration(5400)).toBe('1h 30m');
    expect(formatDuration(7200)).toBe('2h');
    expect(formatDuration(7260)).toBe('2h 1m');
  });

  it('formats days and hours (suppresses minutes when days present)', () => {
    expect(formatDuration(86400)).toBe('1d');
    expect(formatDuration(90000)).toBe('1d 1h');
    expect(formatDuration(93600)).toBe('1d 2h');
    // 1d 0h 30m — minutes suppressed because days > 0
    expect(formatDuration(86400 + 1800)).toBe('1d');
  });

  it('formats multiple days', () => {
    expect(formatDuration(2 * 86400)).toBe('2d');
    expect(formatDuration(2 * 86400 + 3600)).toBe('2d 1h');
    expect(formatDuration(7 * 86400 + 2 * 3600)).toBe('7d 2h');
  });

  it('handles exactly 1 hour', () => {
    expect(formatDuration(3600)).toBe('1h');
  });
});

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------

describe('formatRelativeTime', () => {
  const BASE = new Date('2026-03-06T09:00:00');

  it('returns "just now" for differences < 60 seconds', () => {
    const future = new Date(BASE.getTime() + 30_000); // 30s ahead
    expect(formatRelativeTime(future, BASE)).toMatch(/^just now/);

    const past = new Date(BASE.getTime() - 30_000); // 30s behind
    expect(formatRelativeTime(past, BASE)).toMatch(/^just now/);
  });

  it('returns "just now" for exactly 0 difference', () => {
    expect(formatRelativeTime(BASE, BASE)).toMatch(/^just now/);
  });

  it('uses "in <dur>" for a future time', () => {
    const future = new Date(BASE.getTime() + 2 * 3600_000 + 15 * 60_000); // +2h15m
    const result = formatRelativeTime(future, BASE);
    expect(result).toMatch(/^in 2h 15m/);
  });

  it('uses "<dur> ago" for a past time', () => {
    const past = new Date(BASE.getTime() - 3 * 3600_000); // -3h
    const result = formatRelativeTime(past, BASE);
    expect(result).toMatch(/^3h ago/);
  });

  it('appends absolute time in parentheses', () => {
    // 2026-03-06T09:00:00 → "Mar 6, 09:00"
    const future = new Date(BASE.getTime() + 2 * 3600_000);
    const result = formatRelativeTime(future, BASE);
    expect(result).toContain('(Mar 6, 11:00)');
  });

  it('uses the current time as default for "now"', () => {
    // Just verify it runs without error and returns a string
    const date = new Date(Date.now() + 5 * 60_000);
    const result = formatRelativeTime(date);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles 1-minute boundary exactly', () => {
    const oneMinute = new Date(BASE.getTime() + 60_000);
    const result = formatRelativeTime(oneMinute, BASE);
    // 60s exactly is NOT "just now" (absDiffSec < 60 is false)
    expect(result).toMatch(/^in 1m/);
  });
});

// ---------------------------------------------------------------------------
// describeCronExpression
// ---------------------------------------------------------------------------

describe('describeCronExpression', () => {
  describe('fallback for invalid expressions', () => {
    it('returns the raw expression when it cannot be parsed', () => {
      expect(describeCronExpression('not-valid')).toBe('not-valid');
      expect(describeCronExpression('a b c d e')).toBe('a b c d e');
    });
  });

  describe('time part — every N minutes', () => {
    it('describes */N with wildcard hour as "Every N minutes"', () => {
      expect(describeCronExpression('*/5 * * * *')).toBe('Every 5 minutes');
      expect(describeCronExpression('*/15 * * * *')).toBe('Every 15 minutes');
      expect(describeCronExpression('*/30 * * * *')).toBe('Every 30 minutes');
    });
  });

  describe('time part — every hour', () => {
    it('describes "0 * * * *" as "Every hour"', () => {
      expect(describeCronExpression('0 * * * *')).toBe('Every hour');
    });

    it('describes a single minute with wildcard hour as "Every hour at :MM"', () => {
      expect(describeCronExpression('15 * * * *')).toBe('Every hour at :15');
      expect(describeCronExpression('30 * * * *')).toBe('Every hour at :30');
    });
  });

  describe('time part — every N hours', () => {
    it('describes */N hour step as "Every N hours at :MM"', () => {
      expect(describeCronExpression('0 */2 * * *')).toBe('Every 2 hours at :00');
      expect(describeCronExpression('30 */6 * * *')).toBe('Every 6 hours at :30');
    });
  });

  describe('time part — specific times', () => {
    it('describes a single fixed time as "At HH:MM"', () => {
      expect(describeCronExpression('0 9 * * *')).toBe('At 09:00');
      expect(describeCronExpression('30 14 * * *')).toBe('At 14:30');
    });

    it('describes multiple fixed hours (≤3) as "At HH:MM, HH:MM"', () => {
      const result = describeCronExpression('0 9,17 * * *');
      expect(result).toBe('At 09:00, 17:00');
    });

    it('falls back to verbose form when more than 3 hours', () => {
      // 4 hours: 8,10,12,14 — should fall through to the fallback
      const result = describeCronExpression('0 8,10,12,14 * * *');
      expect(result).toContain('minute');
    });
  });

  describe('day-of-week part', () => {
    it('omits DOW for wildcards (all days)', () => {
      expect(describeCronExpression('0 9 * * *')).toBe('At 09:00');
    });

    it('lists individual days when non-contiguous', () => {
      const result = describeCronExpression('0 9 * * 1,3,5'); // Mon, Wed, Fri
      expect(result).toContain('Mon');
      expect(result).toContain('Wed');
      expect(result).toContain('Fri');
    });

    it('uses range notation for contiguous days', () => {
      const result = describeCronExpression('0 9 * * 1-5'); // Mon--Fri
      expect(result).toContain('Mon--Fri');
    });

    it('handles a single day of week', () => {
      const result = describeCronExpression('0 9 * * 0'); // Sunday only
      expect(result).toContain('Sun');
    });
  });

  describe('day-of-month part', () => {
    it('omits DOM for wildcards', () => {
      expect(describeCronExpression('0 9 * * *')).toBe('At 09:00');
    });

    it('includes "on day N of the month" for specific days', () => {
      const result = describeCronExpression('0 9 15 * *');
      expect(result).toContain('on day 15 of the month');
    });

    it('includes multiple days', () => {
      const result = describeCronExpression('0 9 1,15 * *');
      expect(result).toContain('on day 1, 15 of the month');
    });
  });

  describe('month part', () => {
    it('omits months for wildcards', () => {
      expect(describeCronExpression('0 9 * * *')).toBe('At 09:00');
    });

    it('includes "in <MonthName>" for specific months', () => {
      const result = describeCronExpression('0 9 * 3 *'); // March
      expect(result).toContain('in Mar');
    });

    it('lists multiple months by name', () => {
      const result = describeCronExpression('0 9 * 1,7 *'); // Jan and Jul
      expect(result).toContain('in Jan, Jul');
    });
  });

  describe('combined expressions', () => {
    it('describes a weekday-only daily job', () => {
      const result = describeCronExpression('0 9 * * 1-5');
      expect(result).toContain('At 09:00');
      expect(result).toContain('Mon--Fri');
    });

    it('describes a monthly first-of-month job', () => {
      const result = describeCronExpression('0 0 1 * *');
      expect(result).toContain('At 00:00');
      expect(result).toContain('on day 1 of the month');
    });

    it('describes a quarterly job (specific months)', () => {
      const result = describeCronExpression('0 9 1 1,4,7,10 *');
      expect(result).toContain('on day 1 of the month');
      expect(result).toContain('in Jan, Apr, Jul, Oct');
    });

    it('describes a complex expression with all parts', () => {
      // Every Mon at 8:30 in June
      const result = describeCronExpression('30 8 * 6 1');
      expect(result).toContain('At 08:30');
      expect(result).toContain('Mon');
      expect(result).toContain('in Jun');
    });
  });
});
