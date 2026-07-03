import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    // Match CI's default pool explicitly so local and CI runs behave the same.
    pool: 'forks',
    // Mitigation (not a root-cause fix): the MCP SDK's StdioClientTransport.close()
    // does not await the child's 'close' after SIGKILL, so under a loaded runner a
    // spawned MCP server can still be exiting when teardown completes, briefly
    // holding its stdio pipe FDs open. That intermittently tripped the default 10s
    // teardown limit ("close timed out after 10000ms … Worker exited unexpectedly")
    // even though all tests passed. Give slow child-reaping more slack.
    teardownTimeout: 30_000,
  },
});
