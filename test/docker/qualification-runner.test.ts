import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runVitestQualificationCommand,
  type QualificationCommandExecutor,
} from '../../src/docker-workload/qualification-runner.js';
import type { QualificationContract, VitestQualificationReport } from '../../src/docker/qualification-contract.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('trusted Vitest qualification runner', () => {
  it('runs one frozen local selection, binds its report, and self-adjudicates the run record', async () => {
    const fixture = runnerFixture();
    const execute = reportExecutor(fixture, report());
    const result = await runVitestQualificationCommand({ ...fixture.options, execute });
    expect(result.verified).toEqual({
      commandId: 'scanner-fixture',
      testFiles: ['test/docker/scanner-fixture.test.ts'],
      testCount: 1,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: process.execPath,
        args: expect.arrayContaining([
          'node_modules/vitest/vitest.mjs',
          'run',
          '--reporter=json',
          expect.stringMatching(/^--outputFile=.*scanner-fixture\.vitest\.json$/u),
        ]),
      }),
    );
    expect(JSON.parse(readFileSync(result.runPath, 'utf8'))).toMatchObject({
      commandId: 'scanner-fixture',
      exitCode: 0,
      bindings: { runtimeImageId: `sha256:${'2'.repeat(64)}` },
    });
  });

  it.each(['--watch', '--passWithNoTests', '--reporter=json', '--outputFile=attacker.json'])(
    'rejects runner-owned or qualification-weakening flag %s before execution',
    async (flag) => {
      const fixture = runnerFixture();
      fixture.contract.commands[0].argv.push(flag);
      rewriteContract(fixture);
      const execute = vi.fn<QualificationCommandExecutor>();
      await expect(runVitestQualificationCommand({ ...fixture.options, execute })).rejects.toThrow(
        /runner-owned|non-hermetic/u,
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('persists a nonzero exit binding and then rejects the run', async () => {
    const fixture = runnerFixture();
    const execute = reportExecutor(fixture, { ...report(), success: false, numFailedTests: 1, numPassedTests: 0 }, 1);
    await expect(runVitestQualificationCommand({ ...fixture.options, execute })).rejects.toThrow(/exited nonzero/u);
    expect(JSON.parse(readFileSync(join(fixture.evidenceDirectory, 'scanner-fixture.run.json'), 'utf8'))).toMatchObject(
      {
        exitCode: 1,
      },
    );
  });

  it('rejects a zero/skip report even when the child exits zero', async () => {
    const fixture = runnerFixture();
    const skipped: VitestQualificationReport = {
      ...report(),
      success: false,
      numPassedTests: 0,
      numPendingTests: 1,
      testResults: [{ ...report().testResults[0], status: 'pending' }],
    };
    await expect(
      runVitestQualificationCommand({ ...fixture.options, execute: reportExecutor(fixture, skipped) }),
    ).rejects.toThrow(/skipped, pending, todo/u);
  });

  it('requires a fresh owner-only evidence directory', async () => {
    const fixture = runnerFixture();
    chmodSync(fixture.evidenceDirectory, 0o755);
    await expect(
      runVitestQualificationCommand({ ...fixture.options, execute: reportExecutor(fixture, report()) }),
    ).rejects.toThrow(/owner-only/u);
    chmodSync(fixture.evidenceDirectory, 0o700);
    writeFileSync(join(fixture.evidenceDirectory, 'scanner-fixture.vitest.json'), '{}');
    await expect(
      runVitestQualificationCommand({ ...fixture.options, execute: reportExecutor(fixture, report()) }),
    ).rejects.toThrow(/evidence already exists/u);
  });
});

function runnerFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'qualification-runner-'));
  temporaryDirectories.push(directory);
  const repositoryRoot = join(directory, 'repository');
  const evidenceDirectory = join(directory, 'evidence');
  mkdirSync(join(repositoryRoot, 'test', 'docker'), { recursive: true });
  mkdirSync(evidenceDirectory, { mode: 0o700 });
  chmodSync(evidenceDirectory, 0o700);
  const contract: QualificationContract = {
    schemaVersion: 1,
    contractId: 'apple-rootless-runner-v1',
    variant: 'apple-rootless-vfs',
    platform: 'apple-container',
    architecture: 'arm64',
    bindings: {
      sourceCommit: '1'.repeat(40),
      dirtyPatchSha256: null,
      runtimeImageId: `sha256:${'2'.repeat(64)}`,
      publicCaSha256: '3'.repeat(64),
      catalogSha256: '4'.repeat(64),
      profileSha256: '5'.repeat(64),
      toolchainDigest: '6'.repeat(64),
      runtimeTrustSchema: 'runtime-trust-v1',
      relaySha256: null,
      watchdogSha256: '8'.repeat(64),
      buildEgressSha256: null,
    },
    commands: [
      {
        id: 'scanner-fixture',
        kind: 'vitest',
        disposition: 'required-pass',
        argv: ['node', 'node_modules/vitest/vitest.mjs', 'run', 'test/docker/scanner-fixture.test.ts'],
        expectedTestFiles: ['test/docker/scanner-fixture.test.ts'],
        expectedTestCount: 1,
      },
    ],
  };
  const contractPath = join(directory, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contract), { mode: 0o400 });
  chmodSync(contractPath, 0o400);
  return {
    directory,
    repositoryRoot,
    evidenceDirectory,
    contractPath,
    contract,
    options: { contractPath, commandId: 'scanner-fixture', repositoryRoot, evidenceDirectory, timeoutMs: 5000 },
  };
}

function rewriteContract(fixture: ReturnType<typeof runnerFixture>): void {
  chmodSync(fixture.contractPath, 0o600);
  writeFileSync(fixture.contractPath, JSON.stringify(fixture.contract));
  chmodSync(fixture.contractPath, 0o400);
}

function reportExecutor(fixture: ReturnType<typeof runnerFixture>, value: VitestQualificationReport, exitCode = 0) {
  return vi.fn<QualificationCommandExecutor>(async (options) => {
    const outputArgument = options.args.find((argument) => argument.startsWith('--outputFile='));
    if (outputArgument === undefined) throw new Error('runner did not provide output file');
    const boundReport = structuredClone(value);
    boundReport.testResults[0].name = join(fixture.repositoryRoot, 'test/docker/scanner-fixture.test.ts');
    writeFileSync(outputArgument.slice('--outputFile='.length), JSON.stringify(boundReport), { mode: 0o600 });
    return { exitCode, stdout: '', stderr: '' };
  });
}

function report(): VitestQualificationReport {
  return {
    numTotalTests: 1,
    numPassedTests: 1,
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
        assertionResults: [{ fullName: 'vulnerability fixture exact verdict', status: 'passed', failureMessages: [] }],
      },
    ],
  };
}
