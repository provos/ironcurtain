/**
 * Outside-in coverage for the no-backend exit path in mcp-proxy-server.ts.
 *
 * Spawns the proxy subprocess with a single configured backend whose
 * `-e VAR_NAME` arg references an env var that is not set. The proxy's
 * backend-connect loop should skip the backend, the post-loop
 * `hasAtLeastOneConnectedBackend` guard should fire, and the subprocess
 * should exit non-zero before the MCP transport is brought up. The unit
 * tests in `mcp-proxy-server.test.ts` cover the predicate in isolation;
 * this test exercises the wiring (condition direction, diagnostic emit,
 * cleanup, exit code) so a regression in any of those is caught.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const MISSING_VAR = 'IRONCURTAIN_TEST_DEFINITELY_NOT_SET_VAR';

describe('mcp-proxy-server no-backend exit', { timeout: 30_000 }, () => {
  it('exits non-zero with an ERROR diagnostic when the only configured backend is skipped', async () => {
    const generatedDir = resolve(__dirname, '..', 'src', 'config', 'generated');

    const mcpServersConfig = {
      testserver: {
        command: 'true',
        args: ['-e', MISSING_VAR],
      },
    };

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      MCP_SERVERS_CONFIG: JSON.stringify(mcpServersConfig),
      SERVER_FILTER: 'testserver',
      GENERATED_DIR: generatedDir,
      PROTECTED_PATHS: '[]',
      SANDBOX_POLICY: 'warn',
    };
    delete env[MISSING_VAR];

    const child = spawn('npx', ['tsx', 'src/trusted-process/mcp-proxy-server.ts'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    const exitCode: number = await new Promise((resolveExit, rejectExit) => {
      child.once('exit', (code) => resolveExit(code ?? -1));
      child.once('error', rejectExit);
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`WARNING: Skipping MCP server "testserver"`);
    expect(stderr).toContain(MISSING_VAR);
    expect(stderr).toContain('ERROR: proxy subprocess for SERVER_FILTER="testserver" has no connected backend');
  });
});
