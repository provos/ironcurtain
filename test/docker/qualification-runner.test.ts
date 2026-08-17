import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runVitestQualificationSuite,
  type QualificationCommandExecutor,
} from '../../src/docker-workload/qualification-runner.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('trusted Vitest release-suite runner', () => {
  it.each([1, 2, 17])('accepts any positive passing assertion count (%i)', async (testCount) => {
    const fixture = runnerFixture();
    const execute = reportExecutor(fixture, report(testCount));
    const result = await runVitestQualificationSuite({ ...fixture.options, execute });
    expect(result).toMatchObject({
      testCount,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: process.execPath,
        args: [
          'node_modules/vitest/vitest.mjs',
          'run',
          'test/docker/scanner-fixture.test.ts',
          '--reporter=json',
          expect.stringMatching(/^--outputFile=.*apple\.vitest\.json$/u),
          '--no-color',
        ],
      }),
    );
  });

  it('does not inspect assertion names', async () => {
    const fixture = runnerFixture();
    const value = report(2);
    value.testResults[0].assertionResults = [
      { status: 'passed', title: 'renamed test one' },
      { status: 'passed', title: 'entirely new test two' },
    ];
    await expect(
      runVitestQualificationSuite({ ...fixture.options, execute: reportExecutor(fixture, value) }),
    ).resolves.toMatchObject({ testCount: 2 });
  });

  it('rejects a nonzero child exit without treating its report as a pass', async () => {
    const fixture = runnerFixture();
    await expect(
      runVitestQualificationSuite({ ...fixture.options, execute: reportExecutor(fixture, report(), 1) }),
    ).rejects.toThrow(/exited nonzero/u);
  });

  it.each([
    ['zero tests', report(0), /zero tests/u],
    ['missing aggregate field', { ...report(), numTotalTests: undefined }, /numTotalTests is invalid/u],
    ['todo aggregate', { ...report(), numTodoTests: 1 }, /skipped, pending, or todo/u],
    ['failed suite aggregate', { ...report(), success: false, numFailedTestSuites: 1 }, /contains failures/u],
    ['failed assertion aggregate', { ...report(), success: false, numFailedTests: 1 }, /contains failures/u],
    ['snapshot failure', { ...report(), snapshot: { failure: true, unchecked: 0, unmatched: 0 } }, /snapshot/u],
    ['unchecked snapshot', { ...report(), snapshot: { failure: false, unchecked: 1, unmatched: 0 } }, /snapshot/u],
    ['unmatched snapshot', { ...report(), snapshot: { failure: false, unchecked: 0, unmatched: 1 } }, /snapshot/u],
  ])('rejects %s even when the child exits zero', async (_label, value, expected) => {
    const fixture = runnerFixture();
    await expect(
      runVitestQualificationSuite({ ...fixture.options, execute: reportExecutor(fixture, value) }),
    ).rejects.toThrow(expected);
  });

  it('rejects an assertion-level nonpass even when aggregate fields claim success', async () => {
    const fixture = runnerFixture();
    const value = report();
    value.testResults[0].assertionResults[0].status = 'todo';
    await expect(
      runVitestQualificationSuite({ ...fixture.options, execute: reportExecutor(fixture, value) }),
    ).rejects.toThrow(/skipped, pending, todo, or failed test/u);
  });

  it('rejects aggregate counts that disagree with the assertion results', async () => {
    const fixture = runnerFixture();
    const value = report(2);
    value.testResults[0].assertionResults.pop();
    await expect(
      runVitestQualificationSuite({ ...fixture.options, execute: reportExecutor(fixture, value) }),
    ).rejects.toThrow(/aggregate counts/u);
  });

  it('rejects a failed suite or failed assertion result even with clean aggregates', async () => {
    const fixture = runnerFixture();
    const failedSuite = report();
    failedSuite.testResults[0].status = 'failed';
    await expect(
      runVitestQualificationSuite({ ...fixture.options, execute: reportExecutor(fixture, failedSuite) }),
    ).rejects.toThrow(/suite did not pass/u);

    const assertionFixture = runnerFixture();
    const failedAssertion = report();
    failedAssertion.testResults[0].assertionResults[0].status = 'failed';
    await expect(
      runVitestQualificationSuite({
        ...assertionFixture.options,
        execute: reportExecutor(assertionFixture, failedAssertion),
      }),
    ).rejects.toThrow(/failed test/u);
  });

  it('rejects missing, extra, and duplicate suites', async () => {
    const fixture = runnerFixture();
    const second = 'test/docker/second-fixture.test.ts';
    writeFileSync(join(fixture.repositoryRoot, second), 'export {};\n');
    await expect(
      runVitestQualificationSuite({
        ...fixture.options,
        testFiles: [...fixture.options.testFiles, second],
        execute: reportExecutor(fixture, report()),
      }),
    ).rejects.toThrow(/missing required suite/u);

    const extraFixture = runnerFixture();
    const extra = report(2);
    extra.testResults.push({ name: second, status: 'passed', assertionResults: [{ status: 'passed' }] });
    await expect(
      runVitestQualificationSuite({ ...extraFixture.options, execute: reportExecutor(extraFixture, extra) }),
    ).rejects.toThrow(/unselected suite/u);

    const duplicateFixture = runnerFixture();
    const duplicate = report(2);
    duplicate.testResults.push({ name: '', status: 'passed', assertionResults: [{ status: 'passed' }] });
    await expect(
      runVitestQualificationSuite({
        ...duplicateFixture.options,
        execute: reportExecutor(duplicateFixture, duplicate),
      }),
    ).rejects.toThrow(/duplicate suite/u);
  });

  it('rejects a missing, malformed, or non-regular report', async () => {
    const fixture = runnerFixture();
    await expect(runVitestQualificationSuite({ ...fixture.options, execute: successfulExecutor() })).rejects.toThrow(
      /did not produce a readable regular report/u,
    );
    await expect(runVitestQualificationSuite({ ...fixture.options, execute: rawReportExecutor('{{') })).rejects.toThrow(
      /not valid JSON/u,
    );

    const nonregularFixture = runnerFixture();
    await expect(
      runVitestQualificationSuite({
        ...nonregularFixture.options,
        execute: outputExecutor((path) => mkdirSync(path)),
      }),
    ).rejects.toThrow(/regular file/u);
  });

  it('rejects a preexisting broken report symlink before execution without creating its target', async () => {
    const fixture = runnerFixture();
    const outside = join(fixture.repositoryRoot, 'outside.json');
    symlinkSync(outside, join(fixture.reportDirectory, 'apple.vitest.json'));
    const execute = vi.fn<QualificationCommandExecutor>();
    await expect(runVitestQualificationSuite({ ...fixture.options, execute })).rejects.toThrow(/already exists/u);
    expect(execute).not.toHaveBeenCalled();
    expect(existsSync(outside)).toBe(false);
  });

  it('requires an absolute, canonical, existing report directory', async () => {
    const fixture = runnerFixture();
    await expect(
      runVitestQualificationSuite({
        ...fixture.options,
        reportDirectory: 'relative-report',
        execute: reportExecutor(fixture, report()),
      }),
    ).rejects.toThrow(/canonical and absolute/u);
    await expect(
      runVitestQualificationSuite({
        ...fixture.options,
        reportDirectory: join(fixture.repositoryRoot, 'absent-report'),
        execute: reportExecutor(fixture, report()),
      }),
    ).rejects.toThrow(/existing directory/u);
  });

  it('rejects a missing required source file before execution', async () => {
    const fixture = runnerFixture();
    const execute = vi.fn<QualificationCommandExecutor>();
    await expect(
      runVitestQualificationSuite({ ...fixture.options, testFiles: ['test/docker/missing.test.ts'], execute }),
    ).rejects.toThrow(/must be an existing file/u);
    expect(execute).not.toHaveBeenCalled();
  });
});

function runnerFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'qualification-runner-')));
  temporaryDirectories.push(directory);
  const repositoryRoot = join(directory, 'repository');
  const reportDirectory = join(directory, 'report');
  const testFile = 'test/docker/scanner-fixture.test.ts';
  mkdirSync(join(repositoryRoot, 'test', 'docker'), { recursive: true });
  writeFileSync(join(repositoryRoot, testFile), 'export {};\n');
  mkdirSync(reportDirectory, { mode: 0o700 });
  return {
    repositoryRoot,
    reportDirectory,
    options: {
      suiteId: 'apple',
      testFiles: [testFile],
      repositoryRoot,
      reportDirectory,
      timeoutMs: 5000,
    },
  };
}

function reportExecutor(fixture: ReturnType<typeof runnerFixture>, value: ReturnType<typeof report>, exitCode = 0) {
  return outputExecutor((path) => {
    const boundReport = structuredClone(value);
    for (const result of boundReport.testResults) {
      if (result.name === '') result.name = join(fixture.repositoryRoot, 'test/docker/scanner-fixture.test.ts');
    }
    writeFileSync(path, JSON.stringify(boundReport), { mode: 0o600 });
  }, exitCode);
}

function rawReportExecutor(contents: string): QualificationCommandExecutor {
  return outputExecutor((path) => writeFileSync(path, contents, { mode: 0o600 }));
}

function successfulExecutor(): QualificationCommandExecutor {
  return vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
}

function outputExecutor(write: (path: string) => void, exitCode = 0): QualificationCommandExecutor {
  const executor: QualificationCommandExecutor = async (options) => {
    const outputArgument = options.args.find((argument) => argument.startsWith('--outputFile='));
    if (outputArgument === undefined) throw new Error('runner did not provide output file');
    write(outputArgument.slice('--outputFile='.length));
    return { exitCode, stdout: '', stderr: '' };
  };
  return vi.fn(executor);
}

function report(testCount = 1) {
  return {
    numTotalTests: testCount,
    numPassedTests: testCount,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    success: true,
    snapshot: { failure: false, unchecked: 0, unmatched: 0 },
    testResults: [
      {
        name: '',
        status: 'passed',
        assertionResults: Array.from({ length: testCount }, () => ({ status: 'passed', title: '' })),
      },
    ],
  };
}
