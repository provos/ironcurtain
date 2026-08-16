import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVitestQualificationSuite } from '../../src/docker-workload/qualification-runner.js';

const enabled = process.env.QUALIFICATION_RUNNER_INTEGRATION === '1';

describe.skipIf(!enabled)('real local Vitest qualification runner', () => {
  it('runs and verifies a current-checkout test suite with the stock JSON reporter', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'qualification-runner-integration-')));
    const reportDirectory = join(directory, 'report');
    mkdirSync(reportDirectory, { mode: 0o700 });
    try {
      const result = await runVitestQualificationSuite({
        suiteId: 'runner-integration',
        testFiles: ['test/docker/runtime-trust.test.ts'],
        repositoryRoot: resolve('.'),
        reportDirectory,
        timeoutMs: 30_000,
      });
      expect(result.testCount).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 40_000);
});
