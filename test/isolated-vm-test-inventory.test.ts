import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ISOLATED_VM_TESTS } from '../vitest.config.js';

/**
 * Guard for the serialized isolated-vm project in vitest.config.ts.
 *
 * Running two or more isolate-creating test files concurrently wedges a worker
 * at teardown on macOS (issue #363). The config serializes them by explicit
 * list, which is fast and obvious but goes stale silently — a newly added
 * isolate test would rejoin the parallel pool and reintroduce the flake with
 * no signal. This test is that signal.
 */
describe('isolated-vm test inventory', () => {
  it('matches every test file gated on isIsolatedVmAvailable', () => {
    const testDir = join(import.meta.dirname, '.');
    const discovered = readdirSync(testDir, { recursive: true, encoding: 'utf-8' })
      .filter((entry) => entry.endsWith('.test.ts'))
      .filter((entry) =>
        /from '.*helpers\/isolated-vm-available\.js'/.test(readFileSync(join(testDir, entry), 'utf-8')),
      )
      .map((entry) => `test/${entry.split('\\').join('/')}`)
      .sort();

    expect(discovered).toEqual([...ISOLATED_VM_TESTS].sort());
  });
});
