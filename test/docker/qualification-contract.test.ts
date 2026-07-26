import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNTIME_TRUST_SCHEMA } from '../../src/docker/runtime-trust.js';
import { verifyQualificationArtifactBindings } from '../../src/docker-workload/qualification-artifacts.js';
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
      testCount: 1,
    });
  });

  it('counts repeated parameterized test names individually rather than collapsing them', () => {
    const fixture = qualificationFixture();
    const duplicate = structuredClone(fixture.options.report.value.testResults[0].assertionResults[0]);
    fixture.options.report.value.testResults[0].assertionResults.push(duplicate);
    fixture.options.report.value.numTotalTests = 2;
    fixture.options.report.value.numPassedTests = 2;
    expect(() => verifyVitestQualificationRun(fixture.options)).toThrow(/test count drift.*expected 1, ran 2/u);
    fixture.options.contract.value.commands[0].expectedTestCount = 2;
    expect(verifyVitestQualificationRun(fixture.options).testCount).toBe(2);
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
      'a test count below the frozen count (a silently deleted test)',
      (fixture: ReturnType<typeof qualificationFixture>) => {
        fixture.options.contract.value.commands[0].expectedTestCount = 2;
      },
      /test count drift.*expected 2, ran 1/u,
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
      expectedTestCount: 0,
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
        expectedTestCount: 1,
        adaptedInvariant: 'Apple VM memory is host-authoritative.',
      },
      {
        id: 'inner-pids',
        kind: 'vitest',
        disposition: 'not-applicable-with-reviewed-rationale',
        argv: [],
        expectedTestFiles: [],
        expectedTestCount: 0,
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
        expectedTestCount: 1,
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

describe('frozen apple-container qualification contract', () => {
  const CONTRACT_PATH = join(
    process.cwd(),
    'config/docker-workload/qualification-contract.apple-rootless-vfs.arm64.json',
  );

  it('loads and validates the checked-in frozen contract', () => {
    const { value } = loadQualificationContract(CONTRACT_PATH);
    expect(value.contractId).toBe('apple-rootless-vfs-arm64-v1');
    expect(value.platform).toBe('apple-container');
    expect(value.architecture).toBe('arm64');
    expect(value.variant).toBe('apple-rootless-vfs');
    expect(value.commands).toHaveLength(12);
  });

  // The artifact->binding mapping lives in exactly one place (the verifier the release gate runs);
  // this test only asserts the committed contract still satisfies it. Drift cases are in
  // test/docker-workload/qualification-artifacts.test.ts.
  it('binds every committed frozen artifact by its exact content hash', () => {
    const { value } = loadQualificationContract(CONTRACT_PATH);
    expect(() => verifyQualificationArtifactBindings(value, process.cwd())).not.toThrow();
  });

  it('carries the runtime-trust schema binding and a clean-tree source binding', () => {
    const { bindings } = loadQualificationContract(CONTRACT_PATH).value;
    expect(bindings.runtimeTrustSchema).toBe(RUNTIME_TRUST_SCHEMA);
    expect(bindings.sourceCommit).toMatch(/^[a-f0-9]{40}$/u);
    expect(bindings.dirtyPatchSha256).toBeNull();
    expect(bindings.relaySha256).toBeNull();
    // publicCaSha256 tracks the freeze-host runtime-trust public-root store, which is Node-version
    // scoped, so assert only its shape here; a live cross-check would break across CI Node versions.
    expect(bindings.publicCaSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('gives every executable command a bound test count and every N/A command a reviewed rationale', () => {
    const { commands } = loadQualificationContract(CONTRACT_PATH).value;
    for (const command of commands) {
      const executable = command.disposition === 'required-pass' || command.disposition === 'backend-adapted-pass';
      if (executable) {
        expect(command.argv.length).toBeGreaterThanOrEqual(4);
        expect(command.expectedTestFiles.length).toBeGreaterThan(0);
        expect(command.expectedTestCount).toBeGreaterThan(0);
      } else {
        expect(command.disposition).toBe('not-applicable-with-reviewed-rationale');
        expect(command.argv).toEqual([]);
        expect(command.expectedTestFiles).toEqual([]);
        expect(command.expectedTestCount).toBe(0);
        expect(command.rationale).toBeTruthy();
        expect(command.adjudication).toBeTruthy();
      }
    }
    // The executable gates prove the apple-container topology invariants directly (backend-agnostic
    // manager logic plus the apple --network none / --publish-socket / workspace-cooperation coverage);
    // the Docker-oriented §9.6 inventory gates are N/A, each naming the apple gate that proves the
    // equivalent invariant rather than silently skipping an executed gate.
    const executableIds = commands
      .filter((command) => command.disposition === 'required-pass' || command.disposition === 'backend-adapted-pass')
      .map((command) => command.id);
    expect(executableIds).toEqual(['docker-manager', 'apple-container-manager', 'apple-container-integration']);
    // Each registered agent has an explicit disposition; Goose and Codex cannot vanish via auto-selection.
    const ids = commands.map((command) => command.id);
    expect(ids).toContain('uid-remap-goose');
    expect(ids).toContain('codex-agent');
  });
});

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
