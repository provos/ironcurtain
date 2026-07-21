import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadQualificationContract,
  verifyQualificationRunSet,
  verifyVitestQualificationRun,
  type LoadedQualificationJson,
  type QualificationBindings,
  type QualificationContract,
  type QualificationRun,
  type VerifiedQualificationRun,
  type VitestQualificationReport,
} from '../../src/docker/qualification-contract.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('qualification contract adjudication', () => {
  it('accepts an exact bound, zero-skip Vitest run', () => {
    const fixture = qualificationFixture();
    expect(verifyVitestQualificationRun(fixture.options)).toEqual({
      commandId: 'docker-manager',
      testFiles: ['test/docker-manager.test.ts'],
      tests: ['test/docker-manager.test.ts::DockerManager rejects unsafe nested input#1'],
      testCount: 1,
    });
  });

  it('assigns stable file/name/occurrence IDs to repeated parameterized test names', () => {
    const fixture = qualificationFixture();
    const duplicate = structuredClone(fixture.options.report.value.testResults[0].assertionResults[0]);
    fixture.options.report.value.testResults[0].assertionResults.push(duplicate);
    fixture.options.report.value.numTotalTests = 2;
    fixture.options.report.value.numPassedTests = 2;
    fixture.options.contract.value.commands[0].expectedTests = [
      'test/docker-manager.test.ts::DockerManager rejects unsafe nested input#1',
      'test/docker-manager.test.ts::DockerManager rejects unsafe nested input#2',
    ];
    expect(verifyVitestQualificationRun(fixture.options).tests).toEqual(
      fixture.options.contract.value.commands[0].expectedTests,
    );
  });

  it.each([
    [
      'zero tests',
      (fixture: ReturnType<typeof qualificationFixture>) =>
        setReport(fixture, { numTotalTests: 0, numPassedTests: 0, testResults: [] }),
      /zero tests/u,
    ],
    [
      'pending test',
      (fixture: ReturnType<typeof qualificationFixture>) =>
        setReport(fixture, { numPassedTests: 0, numPendingTests: 1, success: false }),
      /skipped, pending, todo/u,
    ],
    [
      'todo test',
      (fixture: ReturnType<typeof qualificationFixture>) =>
        setReport(fixture, { numPassedTests: 0, numTodoTests: 1, success: false }),
      /skipped, pending, todo/u,
    ],
    [
      'failed test',
      (fixture: ReturnType<typeof qualificationFixture>) =>
        setReport(fixture, { numPassedTests: 0, numFailedTests: 1, success: false }),
      /skipped, pending, todo/u,
    ],
    [
      'missing test name',
      (fixture: ReturnType<typeof qualificationFixture>) => {
        fixture.options.contract.value.commands[0].expectedTests = ['A different frozen test'];
      },
      /test names.*frozen contract/u,
    ],
    [
      'wrong test file',
      (fixture: ReturnType<typeof qualificationFixture>) => {
        fixture.options.report.value.testResults[0].name = '/repo/test/different.test.ts';
      },
      /test files.*frozen contract/u,
    ],
    [
      'wrong image',
      (fixture: ReturnType<typeof qualificationFixture>) => {
        fixture.options.run.value.bindings.runtimeImageId = `sha256:${'9'.repeat(64)}`;
      },
      /bindings mismatch/u,
    ],
    [
      'wrong CA',
      (fixture: ReturnType<typeof qualificationFixture>) => {
        fixture.options.run.value.bindings.publicCaSha256 = '9'.repeat(64);
      },
      /bindings mismatch/u,
    ],
    [
      'wrong contract hash',
      (fixture: ReturnType<typeof qualificationFixture>) => {
        fixture.options.run.value.contractSha256 = '9'.repeat(64);
      },
      /contract identity\/hash/u,
    ],
    [
      'wrong report hash',
      (fixture: ReturnType<typeof qualificationFixture>) => {
        fixture.options.run.value.vitestReport.sha256 = '9'.repeat(64);
      },
      /report identity\/hash\/size/u,
    ],
    [
      'nonzero command',
      (fixture: ReturnType<typeof qualificationFixture>) => {
        fixture.options.run.value.exitCode = 1;
      },
      /exited nonzero/u,
    ],
  ])('rejects %s', (_label, mutate, message) => {
    const fixture = qualificationFixture();
    mutate(fixture);
    expect(() => verifyVitestQualificationRun(fixture.options)).toThrow(message);
  });

  it('requires exactly one verified run per executable disposition and rejects blockers', () => {
    const contract = qualificationFixture().options.contract.value;
    const run: VerifiedQualificationRun = {
      commandId: 'docker-manager',
      testFiles: ['test/docker-manager.test.ts'],
      tests: ['test/docker-manager.test.ts::DockerManager rejects unsafe nested input#1'],
      testCount: 1,
    };
    expect(() => verifyQualificationRunSet(contract, [run])).not.toThrow();
    expect(() => verifyQualificationRunSet(contract, [])).toThrow(/exactly one verified run/u);

    contract.commands.push({
      id: 'unsupported-goose',
      kind: 'vitest',
      disposition: 'compatibility-blocker',
      argv: [],
      expectedTestFiles: [],
      expectedTests: [],
      blockerReason: 'Goose contract is unresolved',
    });
    expect(() => verifyQualificationRunSet(contract, [run])).toThrow(/compatibility blocker unsupported-goose/u);
  });

  it('validates reviewed N/A and adapted dispositions structurally', () => {
    const directory = tempDirectory();
    const contract = qualificationFixture().options.contract.value;
    contract.commands.push(
      {
        id: 'adapted-resource-limit',
        kind: 'vitest',
        disposition: 'backend-adapted-pass',
        argv: ['npx', 'vitest', 'run', 'test/adapted.test.ts'],
        expectedTestFiles: ['test/adapted.test.ts'],
        expectedTests: ['test/adapted.test.ts::adapted invariant#1'],
        adaptedInvariant: 'Apple VM memory is host-authoritative.',
      },
      {
        id: 'inner-pids',
        kind: 'vitest',
        disposition: 'not-applicable-with-reviewed-rationale',
        argv: [],
        expectedTestFiles: [],
        expectedTests: [],
        rationale: 'Apple guest PIDs are advisory by threat-model decision.',
        adjudication: 'review-apple-pids-v1',
      },
    );
    const path = join(directory, 'contract.json');
    writeFileSync(path, JSON.stringify(contract), { mode: 0o444 });
    expect(loadQualificationContract(path).value.commands).toHaveLength(3);

    const invalid = structuredClone(contract);
    delete invalid.commands[1].adaptedInvariant;
    chmodSync(path, 0o644);
    writeFileSync(path, JSON.stringify(invalid));
    chmodSync(path, 0o444);
    expect(() => loadQualificationContract(path)).toThrow(/adaptedInvariant/u);
  });

  it('loads contracts only from non-writable non-symlink files', () => {
    const directory = tempDirectory();
    const path = join(directory, 'contract.json');
    writeFileSync(path, JSON.stringify(qualificationFixture().options.contract.value), { mode: 0o444 });
    expect(loadQualificationContract(path).value.contractId).toBe('apple-rootless-v1');

    chmodSync(path, 0o666);
    expect(() => loadQualificationContract(path)).toThrow(/group\/world writable/u);
    chmodSync(path, 0o444);
    const link = join(directory, 'contract-link.json');
    symlinkSync(path, link);
    expect(() => loadQualificationContract(link)).toThrow(/non-symlink/u);
  });
});

function qualificationFixture() {
  const bindings: QualificationBindings = {
    sourceCommit: '1'.repeat(40),
    dirtyPatchSha256: null,
    runtimeImageId: `sha256:${'2'.repeat(64)}`,
    publicCaSha256: '3'.repeat(64),
    catalogSha256: '4'.repeat(64),
    profileSha256: '5'.repeat(64),
    toolchainDigest: '6'.repeat(64),
    performanceBudgetSha256: '7'.repeat(64),
    runtimeTrustSchema: 'runtime-trust-v1',
    relaySha256: null,
    watchdogSha256: null,
    buildEgressSha256: null,
  };
  const contractValue: QualificationContract = {
    schemaVersion: 1,
    contractId: 'apple-rootless-v1',
    variant: 'apple-rootless-vfs',
    platform: 'apple-container',
    architecture: 'arm64',
    bindings: structuredClone(bindings),
    commands: [
      {
        id: 'docker-manager',
        kind: 'vitest',
        disposition: 'required-pass',
        argv: ['npx', 'vitest', 'run', 'test/docker-manager.test.ts'],
        expectedTestFiles: ['test/docker-manager.test.ts'],
        expectedTests: ['test/docker-manager.test.ts::DockerManager rejects unsafe nested input#1'],
      },
    ],
  };
  const contract = loaded('/contracts/apple.json', 'a'.repeat(64), contractValue);
  const reportValue: VitestQualificationReport = {
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
        name: '/repo/test/docker-manager.test.ts',
        status: 'passed',
        assertionResults: [
          {
            fullName: 'DockerManager rejects unsafe nested input',
            status: 'passed',
            failureMessages: [],
          },
        ],
      },
    ],
  };
  const report = loaded('/evidence/vitest.json', 'b'.repeat(64), reportValue);
  const runValue: QualificationRun = {
    schemaVersion: 1,
    contractId: contractValue.contractId,
    contractSha256: contract.sha256,
    commandId: 'docker-manager',
    argv: [...contractValue.commands[0].argv],
    exitCode: 0,
    bindings: structuredClone(bindings),
    vitestReport: { fileName: 'vitest.json', sha256: report.sha256, sizeBytes: report.sizeBytes },
  };
  const run = loaded('/evidence/run.json', 'c'.repeat(64), runValue);
  return { options: { contract, run, report, repositoryRoot: '/repo' } };
}

function loaded<T>(path: string, sha256: string, value: T): LoadedQualificationJson<T> {
  return { path, sha256, sizeBytes: 1234, value };
}

function setReport(fixture: ReturnType<typeof qualificationFixture>, value: Partial<VitestQualificationReport>): void {
  Object.assign(fixture.options.report.value, value);
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qualification-contract-'));
  temporaryDirectories.push(directory);
  return directory;
}
