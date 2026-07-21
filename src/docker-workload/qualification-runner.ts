/** Trusted zero-skip Vitest runner for one frozen qualification command. */

import { execFile as execFileCallback } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { stableStringify } from '../hash.js';
import {
  loadQualificationContract,
  loadQualificationRun,
  loadVitestQualificationReport,
  verifyVitestQualificationRun,
  type QualificationCommand,
  type QualificationRun,
  type VerifiedQualificationRun,
} from '../docker/qualification-contract.js';

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

export interface RunVitestQualificationCommandOptions {
  readonly contractPath: string;
  readonly commandId: string;
  readonly repositoryRoot: string;
  readonly evidenceDirectory: string;
  readonly timeoutMs: number;
  readonly execute?: QualificationCommandExecutor;
}

export interface RunVitestQualificationCommandResult {
  readonly reportPath: string;
  readonly runPath: string;
  readonly verified: VerifiedQualificationRun;
}

/** Execute the exact selection, bind its stock JSON report, then self-adjudicate it. */
export async function runVitestQualificationCommand(
  options: RunVitestQualificationCommandOptions,
): Promise<RunVitestQualificationCommandResult> {
  const repositoryRoot = validateDirectory(options.repositoryRoot, 'qualification repository root', false);
  const evidenceDirectory = validateDirectory(options.evidenceDirectory, 'qualification evidence directory', true);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 24 * 60 * 60_000) {
    throw new Error('qualification command timeout is invalid');
  }
  const contract = loadQualificationContract(options.contractPath);
  const command = contract.value.commands.find((candidate) => candidate.id === options.commandId);
  if (command === undefined) throw new Error(`unknown qualification command: ${options.commandId}`);
  validateExecutableCommand(command);
  const reportFileName = `${command.id}.vitest.json`;
  const runFileName = `${command.id}.run.json`;
  const reportPath = join(evidenceDirectory, reportFileName);
  const runPath = join(evidenceDirectory, runFileName);
  if (existsSync(reportPath) || existsSync(runPath)) {
    throw new Error(`qualification evidence already exists for command: ${command.id}`);
  }

  const effectiveArgs = [...command.argv.slice(1), '--reporter=json', `--outputFile=${reportPath}`, '--no-color'];
  const execution = await (options.execute ?? defaultQualificationExecutor)({
    executable: process.execPath,
    args: effectiveArgs,
    cwd: repositoryRoot,
    timeoutMs: options.timeoutMs,
  });
  if (!Number.isInteger(execution.exitCode) || execution.exitCode < 0 || execution.exitCode > 255) {
    throw new Error('qualification executor returned an invalid exit code');
  }
  if (!existsSync(reportPath)) {
    throw new Error(`qualification command did not produce its bound Vitest report: ${command.id}`);
  }
  const report = loadVitestQualificationReport(reportPath);
  const runValue: QualificationRun = {
    schemaVersion: 1,
    contractId: contract.value.contractId,
    contractSha256: contract.sha256,
    commandId: command.id,
    argv: command.argv,
    exitCode: execution.exitCode,
    bindings: contract.value.bindings,
    vitestReport: {
      fileName: reportFileName,
      sha256: report.sha256,
      sizeBytes: report.sizeBytes,
    },
  };
  writeCanonicalJsonAtomic(runPath, runValue);
  const run = loadQualificationRun(runPath);
  const verified = verifyVitestQualificationRun({ contract, run, report, repositoryRoot });
  return { reportPath, runPath, verified };
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
      maxBuffer: 50 * 1024 * 1024,
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

function validateExecutableCommand(command: QualificationCommand): void {
  if (command.disposition !== 'required-pass' && command.disposition !== 'backend-adapted-pass') {
    throw new Error(`qualification command is not executable: ${command.id} (${command.disposition})`);
  }
  if (
    command.argv.length < 4 ||
    command.argv[0] !== 'node' ||
    command.argv[1] !== 'node_modules/vitest/vitest.mjs' ||
    command.argv[2] !== 'run'
  ) {
    throw new Error('qualification command must use the pinned local Vitest entrypoint in run mode');
  }
  const forbidden = [
    '--watch',
    '--ui',
    '--update',
    '-u',
    '--changed',
    '--related',
    '--passWithNoTests',
    '--reporter',
    '--outputFile',
  ];
  for (const argument of command.argv.slice(3)) {
    if (forbidden.some((flag) => argument === flag || argument.startsWith(`${flag}=`))) {
      throw new Error(`qualification command contains runner-owned or non-hermetic flag: ${argument}`);
    }
  }
}

function validateDirectory(path: string, label: string, ownerOnly: boolean): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be canonical and absolute`);
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  if (ownerOnly && (stats.mode & 0o077) !== 0) throw new Error(`${label} must be owner-only`);
  return path;
}

function writeCanonicalJsonAtomic(path: string, value: unknown): void {
  const directory = resolve(path, '..');
  const temporary = join(directory, `.${basename(path)}.${process.pid}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${stableStringify(value)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o400);
    renameSync(temporary, path);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}
