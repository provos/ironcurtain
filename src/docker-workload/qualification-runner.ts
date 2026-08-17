/** Trusted zero-skip Vitest runner for a backend release suite. */

import { execFile as execFileCallback } from 'node:child_process';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { assertCanonicalHostPath } from '../hardened-fs.js';

export interface QualificationCommandExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type QualificationCommandExecutor = (options: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}) => Promise<QualificationCommandExecution>;

export interface RunVitestQualificationSuiteOptions {
  readonly suiteId: string;
  readonly testFiles: readonly string[];
  readonly repositoryRoot: string;
  readonly reportDirectory: string;
  readonly timeoutMs: number;
  readonly execute?: QualificationCommandExecutor;
}

export interface RunVitestQualificationSuiteResult {
  readonly reportPath: string;
  readonly testCount: number;
}

interface VitestAssertionResult {
  readonly status?: unknown;
}

interface VitestTestResult {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly assertionResults?: unknown;
}

interface VitestQualificationReport {
  readonly numTotalTests?: unknown;
  readonly numPassedTests?: unknown;
  readonly numFailedTests?: unknown;
  readonly numPendingTests?: unknown;
  readonly numTodoTests?: unknown;
  readonly numFailedTestSuites?: unknown;
  readonly numPendingTestSuites?: unknown;
  readonly success?: unknown;
  readonly snapshot?: unknown;
  readonly testResults?: unknown;
}

const MAX_REPORT_BYTES = 50 * 1024 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 50 * 1024 * 1024;

/**
 * Run a source-controlled backend suite from the current checkout and reject weak results.
 *
 * This is deliberately not an admission credential. The caller chooses a stable set of test
 * files in code; the runner owns the Vitest entrypoint and reporter flags, then verifies what
 * actually ran without binding the result to a commit, contract hash, exact count, or test-name
 * inventory.
 */
export async function runVitestQualificationSuite(
  options: RunVitestQualificationSuiteOptions,
): Promise<RunVitestQualificationSuiteResult> {
  const repositoryRoot = validateDirectory(options.repositoryRoot, 'qualification repository root');
  const reportDirectory = validateDirectory(options.reportDirectory, 'qualification report directory');
  validateSuiteId(options.suiteId);
  validateTimeout(options.timeoutMs);
  const testFiles = validateTestFiles(repositoryRoot, options.testFiles);
  const reportPath = join(reportDirectory, `${options.suiteId}.vitest.json`);
  assertPathAbsent(reportPath, `qualification report already exists for suite: ${options.suiteId}`);

  const args = [
    'node_modules/vitest/vitest.mjs',
    'run',
    ...testFiles,
    '--reporter=json',
    `--outputFile=${reportPath}`,
    '--no-color',
  ];
  const execution = await (options.execute ?? defaultQualificationExecutor)({
    executable: process.execPath,
    args,
    cwd: repositoryRoot,
    timeoutMs: options.timeoutMs,
  });
  validateExitCode(execution.exitCode);
  if (execution.exitCode !== 0) {
    const detail = execution.stderr.trim() || execution.stdout.trim();
    throw new Error(`qualification suite exited nonzero (${execution.exitCode})${detail === '' ? '' : `: ${detail}`}`);
  }
  // The report is a diagnostic artifact this runner asked our own Vitest to
  // write; everything that matters is adjudicated from its contents below.
  const report = loadReport(reportPath, options.suiteId);
  const testCount = verifyReport(report, repositoryRoot, testFiles);
  return { reportPath, testCount };
}

async function defaultQualificationExecutor(options: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
}): Promise<QualificationCommandExecution> {
  const execFile = promisify(execFileCallback);
  try {
    const result = await execFile(options.executable, [...options.args], {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: MAX_CHILD_OUTPUT_BYTES,
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { readonly code?: unknown; readonly stdout?: unknown; readonly stderr?: unknown };
    if (typeof failure.code !== 'number') throw error;
    return {
      exitCode: Math.min(255, Math.max(1, failure.code)),
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
    };
  }
}

function validateSuiteId(suiteId: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(suiteId)) throw new Error('qualification suite id is invalid');
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 24 * 60 * 60_000) {
    throw new Error('qualification suite timeout is invalid');
  }
}

/**
 * Resolve the source-controlled suite list. A file that does not exist must fail
 * here, before the child is spawned, so a typo cannot silently qualify nothing.
 */
function validateTestFiles(repositoryRoot: string, requested: readonly string[]): readonly string[] {
  if (requested.length === 0) throw new Error('qualification suite must select at least one test file');
  const unique = new Set<string>();
  for (const file of requested) {
    if (unique.has(file)) throw new Error(`qualification test file is duplicated: ${file}`);
    if (!isRegularFile(resolve(repositoryRoot, file))) {
      throw new Error(`qualification test file must be an existing file: ${file}`);
    }
    unique.add(file);
  }
  return [...unique];
}

function validateDirectory(path: string, label: string): string {
  assertCanonicalHostPath(path, label);
  if (!statSyncOrUndefined(path)?.isDirectory()) throw new Error(`${label} must be an existing directory`);
  return path;
}

function validateExitCode(exitCode: number): void {
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new Error('qualification executor returned an invalid exit code');
  }
}

function loadReport(path: string, suiteId: string): VitestQualificationReport {
  const stats = statSyncOrUndefined(path);
  if (stats === undefined) {
    throw new Error(`qualification suite did not produce a readable regular report: ${suiteId}`);
  }
  if (!stats.isFile()) throw new Error('qualification report must be a regular file');
  if (stats.size < 2 || stats.size > MAX_REPORT_BYTES) {
    throw new Error(`qualification report size is outside the allowed range: ${stats.size}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `qualification report is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('qualification report must be a JSON object');
  }
  return value;
}

function verifyReport(
  report: VitestQualificationReport,
  repositoryRoot: string,
  expectedFiles: readonly string[],
): number {
  const total = integerField(report.numTotalTests, 'numTotalTests');
  const passed = integerField(report.numPassedTests, 'numPassedTests');
  const failed = integerField(report.numFailedTests, 'numFailedTests');
  const pending = integerField(report.numPendingTests, 'numPendingTests');
  const todo = integerField(report.numTodoTests, 'numTodoTests');
  const failedSuites = integerField(report.numFailedTestSuites, 'numFailedTestSuites');
  const pendingSuites = integerField(report.numPendingTestSuites, 'numPendingTestSuites');
  if (total === 0) throw new Error('qualification report contains zero tests');
  if (pending !== 0 || todo !== 0 || pendingSuites !== 0) {
    throw new Error('qualification report contains skipped, pending, or todo tests');
  }
  if (report.success !== true || failed !== 0 || failedSuites !== 0)
    throw new Error('qualification report contains failures');
  if (passed !== total) throw new Error('qualification report did not pass every test');
  verifySnapshotSummary(report.snapshot);

  if (!Array.isArray(report.testResults)) throw new Error('qualification report testResults must be an array');
  const reportedFiles = new Map<string, VitestTestResult>();
  let assertionCount = 0;
  for (const value of report.testResults) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('qualification report contains an invalid suite result');
    }
    const result = value as VitestTestResult;
    if (typeof result.name !== 'string' || result.name === '') {
      throw new Error('qualification report suite result has no file name');
    }
    const file = normalizeReportedFile(repositoryRoot, result.name);
    if (reportedFiles.has(file)) throw new Error(`qualification report contains duplicate suite result: ${file}`);
    if (result.status !== 'passed') throw new Error(`qualification suite did not pass: ${file}`);
    if (!Array.isArray(result.assertionResults) || result.assertionResults.length === 0) {
      throw new Error(`qualification suite contains zero tests: ${file}`);
    }
    if (result.assertionResults.some((assertion) => !isPassedAssertion(assertion))) {
      throw new Error(`qualification suite contains a skipped, pending, todo, or failed test: ${file}`);
    }
    assertionCount += result.assertionResults.length;
    reportedFiles.set(file, result);
  }

  const expected = new Set(expectedFiles);
  for (const file of expected) {
    if (!reportedFiles.has(file)) throw new Error(`qualification report is missing required suite: ${file}`);
  }
  for (const file of reportedFiles.keys()) {
    if (!expected.has(file)) throw new Error(`qualification report contains an unselected suite: ${file}`);
  }
  if (assertionCount !== total || assertionCount !== passed) {
    throw new Error('qualification report aggregate counts do not match assertion results');
  }
  return total;
}

function assertPathAbsent(path: string, message: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(message);
}

function isRegularFile(path: string): boolean {
  return statSyncOrUndefined(path)?.isFile() === true;
}

function statSyncOrUndefined(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function normalizeReportedFile(repositoryRoot: string, name: string): string {
  const absolute = resolve(repositoryRoot, name);
  const repositoryRelative = relative(repositoryRoot, absolute);
  if (repositoryRelative.startsWith(`..${sep}`) || repositoryRelative === '..' || isAbsolute(repositoryRelative)) {
    throw new Error(`qualification report suite escapes the repository root: ${name}`);
  }
  return repositoryRelative.split(sep).join('/');
}

function isPassedAssertion(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (value as VitestAssertionResult).status === 'passed';
}

function integerField(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`qualification report ${name} is invalid`);
  return value as number;
}

function verifySnapshotSummary(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('qualification report snapshot summary is invalid');
  }
  const snapshot = value as { readonly failure?: unknown; readonly unchecked?: unknown; readonly unmatched?: unknown };
  if (snapshot.failure !== false || snapshot.unchecked !== 0 || snapshot.unmatched !== 0) {
    throw new Error('qualification report contains snapshot failures');
  }
}
