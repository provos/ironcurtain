import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    // Match CI's default pool explicitly so local and CI runs behave the same.
    pool: 'forks',
    // Teardown safety net for the macOS "Worker exited unexpectedly" /
    // "prevents Vite server from exiting" flake. Root cause: some test files
    // leave a listening TCP server open after their own cleanup; the forks pool
    // reuses workers, so those handles accumulate and keep a worker's event loop
    // alive, which the slow macOS runners can't drain within the teardown
    // budget. handle-leak-guard runs LAST in each file's teardown and
    // force-closes any leaked server. See project-vitest-worker-exit-flake.
    setupFiles: ['./test/setup/handle-leak-guard.ts'],
    // Keep extra teardown slack as belt-and-suspenders (the leak fix above is
    // the real mitigation, not this timeout).
    teardownTimeout: 30_000,
  },
});
