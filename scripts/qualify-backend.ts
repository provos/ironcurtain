#!/usr/bin/env node
/** Backend release-suite entrypoint. Qualification is release control, not session admission. */

import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runVitestQualificationSuite } from '../src/docker-workload/qualification-runner.js';
import {
  getBackendQualificationPlan,
  qualificationTimeoutMs,
  qualificationTerminationGraceMs,
} from './qualify-backend-plan.js';
import { QualificationEvidenceRecorder } from './qualification-evidence.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      backend: { type: 'string' },
      'report-dir': { type: 'string' },
      'repository-root': { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
  });
  let plan;
  try {
    plan = getBackendQualificationPlan(values.backend);
  } catch {
    process.stderr.write(
      'usage: qualify-backend --backend <apple|docker-desktop|wsl-desktop> [--report-dir <dir>] ' +
        '[--repository-root <path>] [--timeout-ms <milliseconds>]\n',
    );
    process.exitCode = 2;
    return;
  }

  const repositoryRoot = resolve(values['repository-root'] ?? process.cwd());
  const timeoutMs = qualificationTimeoutMs(values['timeout-ms']);
  const requestedReportDirectory = values['report-dir'];
  const temporary = requestedReportDirectory === undefined;
  const reportDirectory =
    requestedReportDirectory === undefined
      ? realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-qualification-')))
      : resolve(requestedReportDirectory);
  if (!temporary) mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });

  const evidence = new QualificationEvidenceRecorder({
    reportDirectory,
    repositoryRoot,
    suiteId: plan.suiteId,
    backend: plan.backend,
    label: plan.label,
  });

  process.stdout.write(
    `running the ${plan.label} release suite from the current checkout\n` +
      `  repository: ${repositoryRoot}\n` +
      `  suites:     ${plan.testFiles.length}\n` +
      `  live gates: ${plan.liveGates.length}\n` +
      `  report:     ${reportDirectory}\n`,
  );
  try {
    if (plan.backend === 'wsl-desktop') {
      process.stdout.write('preparing required WSL images before no-skip qualification suites\n');
      await evidence.runScript({
        kind: 'preparation',
        script: 'prepare-wsl-qualification.ts',
        arguments: [],
        timeoutMs,
      });
    }
    const result = await runVitestQualificationSuite({
      suiteId: plan.suiteId,
      testFiles: plan.testFiles,
      environment: plan.testEnvironment,
      repositoryRoot,
      reportDirectory,
      timeoutMs,
    });
    evidence.recordVitestPassed(result.testCount);
    for (const gate of plan.liveGates) {
      process.stdout.write(`\nrunning ${plan.label} live gate: ${gate.script} ${gate.arguments.join(' ')}\n`);
      await evidence.runScript({
        kind: 'live-gate',
        ...gate,
        timeoutMs: qualificationTimeoutMs(values['timeout-ms'], gate.script),
        termGraceMs: qualificationTerminationGraceMs(gate),
      });
    }
    evidence.complete();
    process.stdout.write(
      `\n${plan.label.toUpperCase()} RELEASE SUITE PASSED: ${result.testCount} tests passed, ` +
        `${plan.liveGates.length} live gates passed, zero reporter-visible skips.\n`,
    );
  } catch (error) {
    evidence.fail(error);
    throw error;
  } finally {
    process.stdout.write(`qualification report retained at ${reportDirectory}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`qualification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
