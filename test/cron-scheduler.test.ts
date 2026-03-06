/**
 * Tests for the cron expression parser and CronScheduler.
 * Tests parseCronExpression, cronMatchesTime, getNextFireTime,
 * and the scheduler's schedule/unschedule/getNextRun lifecycle.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  parseCronExpression,
  cronMatchesTime,
  getNextFireTime,
  createCronScheduler,
  InvalidCronExpressionError,
} from '../src/cron/cron-scheduler.js';
import { createJobId } from '../src/cron/types.js';
import type { JobDefinition } from '../src/cron/types.js';

function makeJob(id: string, schedule: string): JobDefinition {
  return {
    id: createJobId(id),
    name: `Test ${id}`,
    schedule,
    taskDescription: 'test task',
    taskConstitution: 'test constitution',
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
  };
}

describe('cron-scheduler', () => {
  describe('parseCronExpression', () => {
    it('parses a simple "every day at 9am" expression', () => {
      const fields = parseCronExpression('0 9 * * *');
      expect(fields.minutes).toEqual(new Set([0]));
      expect(fields.hours).toEqual(new Set([9]));
      expect(fields.daysOfMonth.size).toBe(31);
      expect(fields.months.size).toBe(12);
      expect(fields.daysOfWeek.size).toBe(7);
    });

    it('parses ranges', () => {
      const fields = parseCronExpression('0 9-11 * * *');
      expect(fields.hours).toEqual(new Set([9, 10, 11]));
    });

    it('parses comma-separated values', () => {
      const fields = parseCronExpression('0,15,30,45 * * * *');
      expect(fields.minutes).toEqual(new Set([0, 15, 30, 45]));
    });

    it('parses step values with wildcard', () => {
      const fields = parseCronExpression('*/15 * * * *');
      expect(fields.minutes).toEqual(new Set([0, 15, 30, 45]));
    });

    it('parses step values with ranges', () => {
      const fields = parseCronExpression('0 8-16/2 * * *');
      expect(fields.hours).toEqual(new Set([8, 10, 12, 14, 16]));
    });

    it('normalizes day-of-week 7 to 0 (both mean Sunday)', () => {
      const fields = parseCronExpression('0 0 * * 7');
      expect(fields.daysOfWeek).toEqual(new Set([0]));
    });

    it('handles day-of-week 0 as Sunday', () => {
      const fields = parseCronExpression('0 0 * * 0');
      expect(fields.daysOfWeek).toEqual(new Set([0]));
    });

    it('throws on wrong number of fields', () => {
      expect(() => parseCronExpression('0 9 *')).toThrow('Expected 5 fields');
      expect(() => parseCronExpression('0 9 * * * *')).toThrow('Expected 5 fields');
    });

    it('throws on out-of-range values', () => {
      expect(() => parseCronExpression('60 * * * *')).toThrow();
      expect(() => parseCronExpression('* 24 * * *')).toThrow();
      expect(() => parseCronExpression('* * 0 * *')).toThrow();
      expect(() => parseCronExpression('* * * 13 *')).toThrow();
      expect(() => parseCronExpression('* * * * 8')).toThrow();
    });

    it('throws on invalid range (start > end)', () => {
      expect(() => parseCronExpression('30-10 * * * *')).toThrow('Invalid range');
    });

    it('throws on step value of 0', () => {
      expect(() => parseCronExpression('*/0 * * * *')).toThrow();
    });

    it('throws on non-numeric values', () => {
      expect(() => parseCronExpression('abc * * * *')).toThrow();
    });
  });

  describe('cronMatchesTime', () => {
    it('matches a specific minute and hour', () => {
      const fields = parseCronExpression('30 14 * * *');
      // 2026-03-04 14:30 (Wednesday)
      const date = new Date(2026, 2, 4, 14, 30, 0);
      expect(cronMatchesTime(fields, date)).toBe(true);
    });

    it('does not match a different minute', () => {
      const fields = parseCronExpression('30 14 * * *');
      const date = new Date(2026, 2, 4, 14, 31, 0);
      expect(cronMatchesTime(fields, date)).toBe(false);
    });

    it('matches a specific day of week', () => {
      const fields = parseCronExpression('0 9 * * 1'); // Monday
      // 2026-03-02 is a Monday
      const monday = new Date(2026, 2, 2, 9, 0, 0);
      expect(cronMatchesTime(fields, monday)).toBe(true);

      // 2026-03-03 is a Tuesday
      const tuesday = new Date(2026, 2, 3, 9, 0, 0);
      expect(cronMatchesTime(fields, tuesday)).toBe(false);
    });

    it('matches a specific day of month', () => {
      const fields = parseCronExpression('0 9 15 * *');
      const on15th = new Date(2026, 2, 15, 9, 0, 0);
      expect(cronMatchesTime(fields, on15th)).toBe(true);

      const on16th = new Date(2026, 2, 16, 9, 0, 0);
      expect(cronMatchesTime(fields, on16th)).toBe(false);
    });

    it('uses OR logic when both dom and dow are restricted', () => {
      // 15th of month OR Mondays
      const fields = parseCronExpression('0 9 15 * 1');

      // 2026-03-02 is Monday (not 15th) -- should match via dow
      expect(cronMatchesTime(fields, new Date(2026, 2, 2, 9, 0, 0))).toBe(true);

      // 2026-03-15 is Sunday (not Monday) -- should match via dom
      expect(cronMatchesTime(fields, new Date(2026, 2, 15, 9, 0, 0))).toBe(true);

      // 2026-03-04 is Wednesday, not 15th -- should not match
      expect(cronMatchesTime(fields, new Date(2026, 2, 4, 9, 0, 0))).toBe(false);
    });

    it('matches a specific month', () => {
      const fields = parseCronExpression('0 9 * 6 *'); // June only
      const june = new Date(2026, 5, 1, 9, 0, 0);
      expect(cronMatchesTime(fields, june)).toBe(true);

      const march = new Date(2026, 2, 1, 9, 0, 0);
      expect(cronMatchesTime(fields, march)).toBe(false);
    });
  });

  describe('getNextFireTime', () => {
    it('returns the next matching minute', () => {
      const fields = parseCronExpression('30 * * * *'); // every hour at :30
      const now = new Date(2026, 2, 4, 14, 10, 0);
      const next = getNextFireTime(fields, now);
      expect(next.getHours()).toBe(14);
      expect(next.getMinutes()).toBe(30);
    });

    it('rolls to the next hour if past the target minute', () => {
      const fields = parseCronExpression('15 * * * *');
      const now = new Date(2026, 2, 4, 14, 20, 0);
      const next = getNextFireTime(fields, now);
      expect(next.getHours()).toBe(15);
      expect(next.getMinutes()).toBe(15);
    });

    it('rolls to the next day if no match remains today', () => {
      const fields = parseCronExpression('0 9 * * *'); // 9am daily
      const now = new Date(2026, 2, 4, 10, 0, 0);
      const next = getNextFireTime(fields, now);
      expect(next.getDate()).toBe(5);
      expect(next.getHours()).toBe(9);
    });

    it('handles every-5-minutes expression', () => {
      const fields = parseCronExpression('*/5 * * * *');
      const now = new Date(2026, 2, 4, 14, 12, 0);
      const next = getNextFireTime(fields, now);
      expect(next.getMinutes()).toBe(15);
    });

    it('never returns the same minute as "after"', () => {
      const fields = parseCronExpression('* * * * *'); // every minute
      const now = new Date(2026, 2, 4, 14, 30, 0);
      const next = getNextFireTime(fields, now);
      expect(next.getTime()).toBeGreaterThan(now.getTime());
    });
  });

  describe('CronScheduler lifecycle', () => {
    let scheduler: ReturnType<typeof createCronScheduler>;

    afterEach(() => {
      scheduler.unscheduleAll();
    });

    it('schedule adds a job and getNextRun returns a future date', () => {
      scheduler = createCronScheduler();
      const job = makeJob('sched-test', '0 9 * * *');
      scheduler.schedule(job, async () => {});

      const nextRun = scheduler.getNextRun(job.id);
      expect(nextRun).toBeInstanceOf(Date);
      expect(nextRun!.getTime()).toBeGreaterThan(Date.now());
    });

    it('getNextRun returns undefined for an unscheduled job', () => {
      scheduler = createCronScheduler();
      expect(scheduler.getNextRun(createJobId('nope'))).toBeUndefined();
    });

    it('unschedule removes a job', () => {
      scheduler = createCronScheduler();
      const job = makeJob('unsched', '0 9 * * *');
      scheduler.schedule(job, async () => {});
      expect(scheduler.getNextRun(job.id)).toBeDefined();

      scheduler.unschedule(job.id);
      expect(scheduler.getNextRun(job.id)).toBeUndefined();
    });

    it('unscheduleAll clears all jobs', () => {
      scheduler = createCronScheduler();
      scheduler.schedule(makeJob('a', '0 9 * * *'), async () => {});
      scheduler.schedule(makeJob('b', '0 10 * * *'), async () => {});

      scheduler.unscheduleAll();
      expect(scheduler.getNextRun(createJobId('a'))).toBeUndefined();
      expect(scheduler.getNextRun(createJobId('b'))).toBeUndefined();
    });

    it('re-scheduling a job replaces the previous schedule', () => {
      scheduler = createCronScheduler();
      const job1 = makeJob('replace', '0 9 * * *');
      scheduler.schedule(job1, async () => {});
      scheduler.getNextRun(job1.id);

      const job2 = makeJob('replace', '0 15 * * *');
      scheduler.schedule(job2, async () => {});
      const second = scheduler.getNextRun(job2.id);

      // The next run should now be at 15:00, not 09:00
      // (unless it's before 9am, in which case both would be today but at different hours)
      expect(second!.getHours()).toBe(15);
    });

    it('throws InvalidCronExpressionError for invalid expressions', () => {
      scheduler = createCronScheduler();
      const job = makeJob('bad-cron', 'not a cron');
      expect(() => scheduler.schedule(job, async () => {})).toThrow(InvalidCronExpressionError);
    });

    it('unschedule is a no-op for unknown jobs', () => {
      scheduler = createCronScheduler();
      expect(() => scheduler.unschedule(createJobId('unknown'))).not.toThrow();
    });
  });
});
