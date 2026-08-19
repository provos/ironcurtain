import { defaultExclude, defineConfig } from 'vitest/config';

/**
 * Test files that instantiate a V8 isolate (isolated-vm), i.e. every file
 * gated on `isIsolatedVmAvailable()`. Kept in sync by
 * test/isolated-vm-test-inventory.test.ts, which fails if a new one appears.
 *
 * These are serialized against each other. Measured on macOS CI (issue #363),
 * 120 attempts per condition:
 *
 *   4 of these files, in parallel  -> 15.8% of runs wedge a worker at teardown
 *   2 of these files, in parallel  ->  5.0%
 *   4 of these files, serialized   ->  0.8%
 *   any one of them, alone         ->  0.2%
 *
 * Two or more live isolates in separate forked children is the trigger; the
 * files are individually and sequentially fine (serialized vs alone: p = 0.36).
 * Serializing only these four removes the trigger while the other ~344 files
 * keep running in parallel.
 */
const ISOLATED_VM_TESTS = [
  'test/docker-code-mode.integration.test.ts',
  'test/help-integration.test.ts',
  'test/sandbox-tool-errors.integration.test.ts',
  'test/workflow-policy-cycling.integration.test.ts',
];

/** Options that must apply to every project (they are project-level in vitest). */
const shared = {
  testTimeout: 30_000,
  // Match CI's default pool explicitly so local and CI runs behave the same.
  pool: 'forks',
  teardownTimeout: 30_000,
} as const;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: 'isolated-vm',
          include: ISOLATED_VM_TESTS,
          // The whole point: never two of these in flight at once.
          fileParallelism: false,
        },
      },
      {
        test: {
          ...shared,
          name: 'main',
          include: ['test/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
          exclude: [...defaultExclude, ...ISOLATED_VM_TESTS],
        },
      },
    ],
  },
});

export { ISOLATED_VM_TESTS };
