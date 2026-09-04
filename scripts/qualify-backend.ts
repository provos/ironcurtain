#!/usr/bin/env node
/** Backend release-suite entrypoint. Qualification is release control, not session admission. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runVitestQualificationSuite } from '../src/docker-workload/qualification-runner.js';
import { getBackendQualificationPlan, type QualificationLiveGate } from './qualify-backend-plan.js';
import { reapSmokeProcessGroup, waitForSmokeChild } from './smoke-child-process.js';

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
      'usage: qualify-backend --backend <apple|docker-desktop> [--report-dir <dir>] ' +
        '[--repository-root <path>] [--timeout-ms <milliseconds>]\n',
    );
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
    `running the ${plan.label} release suite from the current checkout\n` +
      `  repository: ${repositoryRoot}\n` +
      `  suites:     ${plan.testFiles.length}\n` +
      `  live gates: ${plan.liveGates.length}\n` +
      (temporary ? '' : `  report:     ${reportDirectory}\n`),
  );
  try {
    const result = await runVitestQualificationSuite({
      suiteId: plan.suiteId,
      testFiles: plan.testFiles,
      repositoryRoot,
      reportDirectory,
      timeoutMs,
    });
    for (const gate of plan.liveGates) {
      process.stdout.write(`\nrunning ${plan.label} live gate: ${gate.script} ${gate.arguments.join(' ')}\n`);
      await runLiveSmoke(repositoryRoot, gate, timeoutMs);
    }
    process.stdout.write(
      `\n${plan.label.toUpperCase()} RELEASE SUITE PASSED: ${result.testCount} tests passed, ` +
        `${plan.liveGates.length} live gates passed, zero reporter-visible skips.\n`,
    );
  } finally {
    if (temporary) rmSync(reportDirectory, { recursive: true, force: true });
  }
}

async function runLiveSmoke(repositoryRoot: string, gate: QualificationLiveGate, timeoutMs: number): Promise<void> {
  const tsxPath = resolve(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const smokePath = resolve(repositoryRoot, 'scripts', gate.script);
  const child = spawn(process.execPath, [tsxPath, smokePath, ...gate.arguments], {
    cwd: repositoryRoot,
    env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: 'inherit',
    // A live smoke launches the product CLI. Give the gate its own process
    // group so timeout teardown reaches both processes while the detached
    // watchdog remains alive long enough to revoke the abandoned bundle.
    detached: true,
  });
  const terminateGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  if (child.pid === undefined) {
    // A failed spawn reports through an asynchronous `error` event. Retain a
    // listener after this synchronous guard throws so that failure cannot
    // surface later as an uncaught event in the qualification runner.
    child.once('error', () => undefined);
    throw new Error('live qualification gate has no process group ID');
  }
  let exit: Awaited<ReturnType<typeof waitForSmokeChild>> | undefined;
  let waitFailure: unknown;
  try {
    exit = await waitForSmokeChild(child, timeoutMs, { terminate: terminateGroup });
  } catch (error) {
    waitFailure = error;
  }
  let group: Awaited<ReturnType<typeof reapSmokeProcessGroup>>;
  try {
    group = await reapSmokeProcessGroup(child.pid, { terminate: terminateGroup });
  } catch (error) {
    if (waitFailure !== undefined) {
      throw new AggregateError([waitFailure, error], 'live qualification gate wait and process-group cleanup failed');
    }
    throw error;
  }
  if (waitFailure !== undefined) throw waitFailure;
  if (exit === undefined) throw new Error('live qualification gate ended without an exit result');
  if (group.leaked) {
    throw new Error(`live qualification gate leaked a child process: ${gate.script} ${gate.arguments.join(' ')}`);
  }
  if (exit.timedOut) {
    throw new Error(`live qualification gate timed out: ${gate.script} ${gate.arguments.join(' ')}`);
  }
  if (exit.code !== 0) {
    throw new Error(
      `live qualification gate failed (${exit.code ?? exit.signal}): ${gate.script} ${gate.arguments.join(' ')}`,
    );
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
