#!/usr/bin/env node
/** Backend release-suite entrypoint. Qualification is release control, not session admission. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runVitestQualificationSuite } from '../src/docker-workload/qualification-runner.js';

const APPLE_TEST_FILES = [
  'test/docker-manager.test.ts',
  'test/apple-container-manager.test.ts',
  'test/apple-container.integration.test.ts',
] as const;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      backend: { type: 'string' },
      'report-dir': { type: 'string' },
      'repository-root': { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
  });
  if (values.backend !== 'apple') {
    process.stderr.write('usage: qualify-backend --backend apple [--report-dir <dir>] [--repository-root <path>]\n');
    process.exitCode = 2;
    return;
  }

  const repositoryRoot = resolve(values['repository-root'] ?? process.cwd());
  const timeoutMs = parseTimeout(values['timeout-ms']);
  const requestedReportDirectory = values['report-dir'];
  const temporary = requestedReportDirectory === undefined;
  const reportDirectory =
    requestedReportDirectory === undefined
      ? realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-qualification-')))
      : resolve(requestedReportDirectory);
  if (!temporary) mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });

  process.stdout.write(
    `running the Apple release suite from the current checkout\n` +
      `  repository: ${repositoryRoot}\n` +
      `  suites:     ${APPLE_TEST_FILES.length}\n` +
      (temporary ? '' : `  report:     ${reportDirectory}\n`),
  );
  try {
    const result = await runVitestQualificationSuite({
      suiteId: 'apple',
      testFiles: APPLE_TEST_FILES,
      repositoryRoot,
      reportDirectory,
      timeoutMs,
    });
    process.stdout.write(
      `\nAPPLE RELEASE SUITE PASSED: ${result.testCount} tests passed, zero reporter-visible skips.\n`,
    );
  } finally {
    if (temporary) rmSync(reportDirectory, { recursive: true, force: true });
  }
}

function parseTimeout(value: string | undefined): number {
  const timeoutMs = Number(value ?? 30 * 60_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 24 * 60 * 60_000) {
    throw new Error('qualification suite timeout is invalid');
  }
  return timeoutMs;
}

main().catch((error: unknown) => {
  process.stderr.write(`qualification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
