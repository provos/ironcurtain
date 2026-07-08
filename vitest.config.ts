import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    // Match CI's default pool explicitly so local and CI runs behave the same.
    pool: 'forks',
    // The macOS "Worker exited unexpectedly" / "prevents Vite server from
    // exiting" teardown flake (issue #363) is handled by a bounded retry in
    // scripts/test.sh, not here — attempts to neutralize it at the vitest layer
    // (closing/unref-ing leaked handles) did not fix it. Extra teardown slack is
    // kept as belt-and-suspenders.
    teardownTimeout: 30_000,
  },
});
