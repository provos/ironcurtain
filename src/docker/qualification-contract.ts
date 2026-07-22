/** Frozen Phase 0F qualification contracts and Vitest result adjudication. */

import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { sha256HexSchema as sha256Schema, stableStringify } from '../hash.js';
import { loadImmutableHostJson } from '../hardened-fs.js';
import { addDuplicateIssues } from '../zod-helpers.js';

export const QUALIFICATION_CONTRACT_SCHEMA_VERSION = 1;
export const QUALIFICATION_RUN_SCHEMA_VERSION = 1;
export const MAX_QUALIFICATION_JSON_BYTES = 4 * 1024 * 1024;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u);
const nonEmptySchema = z.string().min(1).max(2048);

const qualificationBindingsSchema = z
  .object({
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    dirtyPatchSha256: sha256Schema.nullable(),
    runtimeImageId: digestSchema,
    publicCaSha256: sha256Schema,
    catalogSha256: sha256Schema,
    profileSha256: sha256Schema,
    toolchainDigest: sha256Schema,
    performanceBudgetSha256: sha256Schema,
    runtimeTrustSchema: identifierSchema,
    relaySha256: sha256Schema.nullable(),
    watchdogSha256: sha256Schema.nullable(),
    buildEgressSha256: sha256Schema.nullable(),
  })
  .strict();

const executableDispositionSchema = z.enum(['required-pass', 'backend-adapted-pass']);
const qualificationCommandSchema = z
  .object({
    id: identifierSchema,
    kind: z.literal('vitest'),
    disposition: z.enum([
      'required-pass',
      'backend-adapted-pass',
      'not-applicable-with-reviewed-rationale',
      'compatibility-blocker',
    ]),
    argv: z.array(nonEmptySchema).max(256),
    expectedTestFiles: z.array(nonEmptySchema).max(512),
    expectedTests: z.array(nonEmptySchema).max(20_000),
    adaptedInvariant: nonEmptySchema.optional(),
    rationale: nonEmptySchema.optional(),
    adjudication: identifierSchema.optional(),
    blockerReason: nonEmptySchema.optional(),
  })
  .strict()
  .superRefine((command, context) => {
    const executable = executableDispositionSchema.safeParse(command.disposition).success;
    if (
      executable &&
      (command.argv.length === 0 || command.expectedTestFiles.length === 0 || command.expectedTests.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'executable qualification command requires argv, expectedTestFiles, and expectedTests',
      });
    }
    if (
      !executable &&
      (command.argv.length !== 0 || command.expectedTestFiles.length !== 0 || command.expectedTests.length !== 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'non-executable qualification disposition must not contain test selection',
      });
    }
    if (command.disposition === 'backend-adapted-pass' && command.adaptedInvariant === undefined) {
      context.addIssue({ code: 'custom', message: 'backend-adapted-pass requires adaptedInvariant' });
    }
    if (
      command.disposition === 'not-applicable-with-reviewed-rationale' &&
      (command.rationale === undefined || command.adjudication === undefined)
    ) {
      context.addIssue({ code: 'custom', message: 'not-applicable disposition requires rationale and adjudication' });
    }
    if (command.disposition === 'compatibility-blocker' && command.blockerReason === undefined) {
      context.addIssue({ code: 'custom', message: 'compatibility-blocker requires blockerReason' });
    }
  });

const qualificationContractSchema = z
  .object({
    schemaVersion: z.literal(QUALIFICATION_CONTRACT_SCHEMA_VERSION),
    contractId: identifierSchema,
    variant: identifierSchema,
    platform: z.enum(['docker-desktop', 'apple-container', 'linux-docker']),
    architecture: z.enum(['amd64', 'arm64']),
    bindings: qualificationBindingsSchema,
    commands: z.array(qualificationCommandSchema).min(1).max(512),
  })
  .strict()
  .superRefine((contract, context) => {
    addDuplicateIssues(
      contract.commands.map((command) => command.id),
      'command ID',
      context,
    );
    for (const command of contract.commands) {
      addDuplicateIssues(command.expectedTestFiles, `test file in ${command.id}`, context);
      addDuplicateIssues(command.expectedTests, `test name in ${command.id}`, context);
    }
  });

const qualificationRunSchema = z
  .object({
    schemaVersion: z.literal(QUALIFICATION_RUN_SCHEMA_VERSION),
    contractId: identifierSchema,
    contractSha256: sha256Schema,
    commandId: identifierSchema,
    argv: z.array(nonEmptySchema).min(1).max(256),
    exitCode: z.number().int().min(0).max(255),
    bindings: qualificationBindingsSchema,
    vitestReport: z
      .object({
        fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.json$/u),
        sha256: sha256Schema,
        sizeBytes: z.number().int().positive().max(MAX_QUALIFICATION_JSON_BYTES),
      })
      .strict(),
  })
  .strict();

const vitestAssertionSchema = z
  .object({
    fullName: nonEmptySchema,
    status: z.string(),
    failureMessages: z.array(z.string()),
  })
  .loose();
const vitestFileSchema = z
  .object({
    name: nonEmptySchema,
    status: z.string(),
    assertionResults: z.array(vitestAssertionSchema),
  })
  .loose();
const vitestReportSchema = z
  .object({
    numTotalTests: z.number().int().min(0),
    numPassedTests: z.number().int().min(0),
    numFailedTests: z.number().int().min(0),
    numPendingTests: z.number().int().min(0),
    numTodoTests: z.number().int().min(0),
    numFailedTestSuites: z.number().int().min(0),
    numPendingTestSuites: z.number().int().min(0),
    success: z.boolean(),
    snapshot: z
      .object({ failure: z.boolean(), unchecked: z.number().int().min(0), unmatched: z.number().int().min(0) })
      .loose(),
    testResults: z.array(vitestFileSchema),
  })
  .loose();

export type QualificationBindings = z.infer<typeof qualificationBindingsSchema>;
export type QualificationCommand = z.infer<typeof qualificationCommandSchema>;
export type QualificationContract = z.infer<typeof qualificationContractSchema>;
export type QualificationRun = z.infer<typeof qualificationRunSchema>;
export type VitestQualificationReport = z.infer<typeof vitestReportSchema>;

export interface LoadedQualificationJson<T> {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly value: T;
}

export interface VerifiedQualificationRun {
  readonly commandId: string;
  readonly testFiles: readonly string[];
  readonly tests: readonly string[];
  readonly testCount: number;
}

export function loadQualificationContract(path: string): LoadedQualificationJson<QualificationContract> {
  return loadStrictJson(path, 'qualification contract', qualificationContractSchema);
}

export function loadQualificationRun(path: string): LoadedQualificationJson<QualificationRun> {
  return loadStrictJson(path, 'qualification run', qualificationRunSchema);
}

export function loadVitestQualificationReport(path: string): LoadedQualificationJson<VitestQualificationReport> {
  return loadStrictJson(path, 'Vitest qualification report', vitestReportSchema);
}

/** Adjudicate one required/adapted Vitest command. Any ambiguity fails closed. */
export function verifyVitestQualificationRun(options: {
  readonly contract: LoadedQualificationJson<QualificationContract>;
  readonly run: LoadedQualificationJson<QualificationRun>;
  readonly report: LoadedQualificationJson<VitestQualificationReport>;
  readonly repositoryRoot: string;
}): VerifiedQualificationRun {
  const { contract, run, report } = options;
  const command = contract.value.commands.find((candidate) => candidate.id === run.value.commandId);
  if (command === undefined) throw new Error(`qualification run references unknown command: ${run.value.commandId}`);
  if (!executableDispositionSchema.safeParse(command.disposition).success) {
    throw new Error(`qualification command is not executable: ${command.id} (${command.disposition})`);
  }
  if (run.value.contractId !== contract.value.contractId || run.value.contractSha256 !== contract.sha256) {
    throw new Error('qualification run contract identity/hash mismatch');
  }
  if (stableStringify(run.value.argv) !== stableStringify(command.argv)) {
    throw new Error(`qualification command argv mismatch: ${command.id}`);
  }
  if (stableStringify(run.value.bindings) !== stableStringify(contract.value.bindings)) {
    throw new Error(`qualification bindings mismatch (image, CA, catalog, profile, or toolchain): ${command.id}`);
  }
  if (run.value.exitCode !== 0) throw new Error(`qualification command exited nonzero: ${command.id}`);
  if (
    run.value.vitestReport.fileName !== report.path.split('/').at(-1) ||
    run.value.vitestReport.sha256 !== report.sha256 ||
    run.value.vitestReport.sizeBytes !== report.sizeBytes
  ) {
    throw new Error(`qualification Vitest report identity/hash/size mismatch: ${command.id}`);
  }

  const value = report.value;
  const assertions = value.testResults.flatMap((file) => file.assertionResults);
  if (value.numTotalTests === 0 || assertions.length === 0) {
    throw new Error(`qualification command selected zero tests: ${command.id}`);
  }
  if (
    !value.success ||
    value.numFailedTests !== 0 ||
    value.numPendingTests !== 0 ||
    value.numTodoTests !== 0 ||
    value.numFailedTestSuites !== 0 ||
    value.numPendingTestSuites !== 0 ||
    value.snapshot.failure ||
    value.snapshot.unchecked !== 0 ||
    value.snapshot.unmatched !== 0
  ) {
    throw new Error(`qualification report contains failed, skipped, pending, todo, or snapshot work: ${command.id}`);
  }
  if (value.numTotalTests !== assertions.length || value.numPassedTests !== assertions.length) {
    throw new Error(`qualification report counts are internally inconsistent: ${command.id}`);
  }
  for (const file of value.testResults) {
    if (file.status !== 'passed') throw new Error(`qualification test file did not pass: ${file.name}`);
  }
  for (const assertion of assertions) {
    if (assertion.status !== 'passed' || assertion.failureMessages.length !== 0) {
      throw new Error(`qualification test did not pass cleanly: ${assertion.fullName}`);
    }
  }

  const repositoryRoot = resolve(options.repositoryRoot);
  const actualFiles = value.testResults.map((file) => {
    if (!isAbsolute(file.name)) throw new Error(`qualification report test path is not absolute: ${file.name}`);
    const resolved = resolve(file.name);
    const path = relative(repositoryRoot, resolved).split('\\').join('/');
    if (path === '' || path.startsWith('../') || isAbsolute(path)) {
      throw new Error(`qualification report test path escapes repository: ${file.name}`);
    }
    return path;
  });
  const actualTests = value.testResults.flatMap((file, fileIndex) => {
    const occurrences = new Map<string, number>();
    return file.assertionResults.map((assertion) => {
      const occurrence = (occurrences.get(assertion.fullName) ?? 0) + 1;
      occurrences.set(assertion.fullName, occurrence);
      return `${actualFiles[fileIndex]}::${assertion.fullName}#${occurrence}`;
    });
  });
  assertExactSet(actualFiles, command.expectedTestFiles, `test files for ${command.id}`);
  assertExactSet(actualTests, command.expectedTests, `test names for ${command.id}`);

  return {
    commandId: command.id,
    testFiles: [...actualFiles].sort(),
    tests: [...actualTests].sort(),
    testCount: assertions.length,
  };
}

/** Every executable command must have exactly one verified run; blockers prevent qualification. */
export function verifyQualificationRunSet(
  contract: QualificationContract,
  verifiedRuns: readonly VerifiedQualificationRun[],
): void {
  const validated = qualificationContractSchema.parse(contract);
  const runIds = verifiedRuns.map((run) => run.commandId);
  assertUnique(runIds, 'verified qualification command');
  for (const command of validated.commands) {
    const count = runIds.filter((id) => id === command.id).length;
    if (command.disposition === 'compatibility-blocker') {
      throw new Error(`qualification contract contains compatibility blocker ${command.id}: ${command.blockerReason}`);
    }
    if (executableDispositionSchema.safeParse(command.disposition).success && count !== 1) {
      throw new Error(`qualification command requires exactly one verified run: ${command.id}`);
    }
    if (command.disposition === 'not-applicable-with-reviewed-rationale' && count !== 0) {
      throw new Error(`not-applicable qualification command unexpectedly has a run: ${command.id}`);
    }
  }
  for (const runId of runIds) {
    if (!validated.commands.some((command) => command.id === runId)) {
      throw new Error(`unexpected verified qualification run: ${runId}`);
    }
  }
}

function loadStrictJson<T>(path: string, label: string, schema: z.ZodType<T>): LoadedQualificationJson<T> {
  return loadImmutableHostJson(path, { label, schema, maxBytes: MAX_QUALIFICATION_JSON_BYTES });
}

function assertExactSet(actual: readonly string[], expected: readonly string[], label: string): void {
  assertUnique(actual, label);
  assertUnique(expected, `expected ${label}`);
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (stableStringify(actualSorted) !== stableStringify(expectedSorted)) {
    throw new Error(`${label} do not exactly match the frozen contract`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
}
