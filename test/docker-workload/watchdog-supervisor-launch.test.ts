/**
 * Startup failure reporting for the detached watchdog supervisor: a missing
 * built entrypoint or a supervisor that exits before attesting must fail
 * fast with a clear message instead of a silent startup-deadline timeout.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchDetachedResourceWatchdogSupervisor } from '../../src/docker-workload/resource-watchdog-supervisor.js';

describe('launchDetachedResourceWatchdogSupervisor startup failures', () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ic-watchdog-launch-')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function launch(entrypointPath: string) {
    return launchDetachedResourceWatchdogSupervisor({
      entrypointPath,
      leasePath: join(dir, 'lease.json'),
      policyPath: join(dir, 'policy.json'),
      statusPath: join(dir, 'status.json'),
      stopRequestPath: join(dir, 'stop.json'),
      startupTimeoutMs: 20_000,
    });
  }

  it('refuses a missing entrypoint with a build hint', async () => {
    await expect(launch(join(dir, 'dist', 'resource-watchdog-supervisor-main.js'))).rejects.toThrow(
      /entrypoint not found.*npm run build/,
    );
  });

  it('reports a supervisor that exits before attesting without waiting for the deadline', async () => {
    const entrypoint = join(dir, 'crashing-supervisor.mjs');
    writeFileSync(entrypoint, 'process.exit(3);\n');

    const startedAt = Date.now();
    await expect(launch(entrypoint)).rejects.toThrow(/exited before attesting \(exit code 3\)/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
