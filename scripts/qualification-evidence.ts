/** Retained, bounded evidence for preparation and live qualification scripts. */

import { spawn } from 'node:child_process';
import { closeSync, openSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  QualificationTimeoutError,
  waitForQualificationProcess,
  type SmokeChildExit,
} from '../src/docker-workload/qualification-process.js';
import { errorMessage } from '../src/utils/error-message.js';

const MAX_SCRIPT_OUTPUT_BYTES = 50 * 1024 * 1024;

export type QualificationEvidenceStepKind = 'preparation' | 'live-gate';

export interface QualificationEvidenceRecorderOptions {
  readonly reportDirectory: string;
  readonly repositoryRoot: string;
  readonly suiteId: string;
  readonly backend: string;
  readonly label: string;
}

export interface QualificationEvidenceScriptOptions {
  readonly kind: QualificationEvidenceStepKind;
  readonly script: string;
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
  readonly termGraceMs?: number;
}

interface QualificationScriptEvidence {
  readonly sequence: number;
  readonly kind: QualificationEvidenceStepKind;
  readonly script: string;
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
  readonly termGraceMs: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: 'passed' | 'failed';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdoutLog: string;
  readonly stderrLog: string;
  readonly failure: string | null;
}

interface QualificationEvidenceManifest {
  readonly schemaVersion: 1;
  readonly suiteId: string;
  readonly backend: string;
  readonly label: string;
  readonly repositoryRoot: string;
  readonly startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'passed' | 'failed';
  failure: string | null;
  readonly vitest: {
    readonly report: string;
    status: 'pending' | 'passed';
    testCount: number | null;
  };
  readonly scripts: QualificationScriptEvidence[];
}

/** Own one qualification run's manifest and live-script log files. */
export class QualificationEvidenceRecorder {
  readonly #manifestPath: string;
  readonly #manifestTemporaryPath: string;
  readonly #options: QualificationEvidenceRecorderOptions;
  readonly #manifest: QualificationEvidenceManifest;

  constructor(options: QualificationEvidenceRecorderOptions) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(options.suiteId)) {
      throw new Error('qualification evidence suite id is invalid');
    }
    this.#options = options;
    this.#manifestPath = join(options.reportDirectory, `${options.suiteId}.qualification.json`);
    this.#manifestTemporaryPath = `${this.#manifestPath}.${process.pid}.tmp`;
    this.#manifest = {
      schemaVersion: 1,
      suiteId: options.suiteId,
      backend: options.backend,
      label: options.label,
      repositoryRoot: options.repositoryRoot,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      failure: null,
      vitest: {
        report: `${options.suiteId}.vitest.json`,
        status: 'pending',
        testCount: null,
      },
      scripts: [],
    };
    writeFileSync(this.#manifestPath, serializeManifest(this.#manifest), { flag: 'wx', mode: 0o600 });
  }

  recordVitestPassed(testCount: number): void {
    this.#manifest.vitest.status = 'passed';
    this.#manifest.vitest.testCount = testCount;
    this.#persist();
  }

  async runScript(options: QualificationEvidenceScriptOptions): Promise<void> {
    const sequence = this.#manifest.scripts.length + 1;
    const stem = `${this.#options.suiteId}.${options.kind}-${String(sequence).padStart(2, '0')}`;
    const stdoutLog = `${stem}.stdout.log`;
    const stderrLog = `${stem}.stderr.log`;
    const startedAt = new Date().toISOString();
    let result: Awaited<ReturnType<typeof runQualificationScript>>;
    try {
      result = await runQualificationScript({
        ...options,
        repositoryRoot: this.#options.repositoryRoot,
        stdoutPath: join(this.#options.reportDirectory, stdoutLog),
        stderrPath: join(this.#options.reportDirectory, stderrLog),
      });
    } catch (error) {
      result = {
        exit: { code: null, signal: null, timedOut: false },
        timedOut: false,
        error: errorMessage(error),
      };
    }
    const failure =
      result.error ??
      (result.exit.code === 0
        ? null
        : `qualification script failed (${result.exit.code ?? result.exit.signal}): ${options.script} ${options.arguments.join(' ')}`);
    this.#manifest.scripts.push({
      sequence,
      kind: options.kind,
      script: options.script,
      arguments: [...options.arguments],
      timeoutMs: options.timeoutMs,
      termGraceMs: options.termGraceMs ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: failure === null ? 'passed' : 'failed',
      exitCode: result.exit.code,
      signal: result.exit.signal,
      timedOut: result.timedOut,
      stdoutLog,
      stderrLog,
      failure,
    });
    this.#persist();
    if (failure !== null) throw new Error(failure);
  }

  complete(): void {
    this.#manifest.status = 'passed';
    this.#manifest.finishedAt = new Date().toISOString();
    this.#persist();
  }

  fail(error: unknown): void {
    this.#manifest.status = 'failed';
    this.#manifest.failure = errorMessage(error);
    this.#manifest.finishedAt = new Date().toISOString();
    this.#persist();
  }

  #persist(): void {
    writeFileSync(this.#manifestTemporaryPath, serializeManifest(this.#manifest), { flag: 'wx', mode: 0o600 });
    renameSync(this.#manifestTemporaryPath, this.#manifestPath);
  }
}

async function runQualificationScript(
  options: QualificationEvidenceScriptOptions & {
    readonly repositoryRoot: string;
    readonly stdoutPath: string;
    readonly stderrPath: string;
  },
): Promise<{
  readonly exit: SmokeChildExit;
  readonly timedOut: boolean;
  readonly error: string | null;
}> {
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  try {
    stdoutFd = openSync(options.stdoutPath, 'wx', 0o600);
    stderrFd = openSync(options.stderrPath, 'wx', 0o600);
  } catch (error) {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
    throw error;
  }

  const scriptPath = resolve(options.repositoryRoot, 'scripts', options.script);
  const cancellation = new AbortController();
  let capturedBytes = 0;
  let captureFailure: Error | undefined;
  let observedExit: SmokeChildExit = { code: null, signal: null, timedOut: false };
  let child;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', scriptPath, ...options.arguments], {
      cwd: options.repositoryRoot,
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // A live smoke launches the product CLI. Give the gate its own process
      // group so timeout teardown reaches both processes while the detached
      // watchdog remains alive long enough to revoke the abandoned bundle.
      detached: true,
    });
  } catch (error) {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    return {
      exit: observedExit,
      timedOut: false,
      error: errorMessage(error),
    };
  }
  child.once('exit', (code, signal) => {
    observedExit = { code, signal, timedOut: false };
  });
  const capture = (destination: number, output: NodeJS.WriteStream, chunk: Buffer): void => {
    if (captureFailure !== undefined) return;
    const remaining = MAX_SCRIPT_OUTPUT_BYTES - capturedBytes;
    try {
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        writeSync(destination, retained);
        output.write(retained);
      }
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_SCRIPT_OUTPUT_BYTES) {
        captureFailure = new Error('qualification script exceeded its retained output bound');
        cancellation.abort(captureFailure);
      }
    } catch (error) {
      captureFailure = error instanceof Error ? error : new Error(String(error));
      cancellation.abort(captureFailure);
    }
  };
  child.stdout.on('data', (chunk: Buffer) => capture(stdoutFd, process.stdout, chunk));
  child.stderr.on('data', (chunk: Buffer) => capture(stderrFd, process.stderr, chunk));

  let exit = observedExit;
  let failure: Error | undefined;
  try {
    exit = await waitForQualificationProcess(child, options.timeoutMs, {
      signal: cancellation.signal,
      termGraceMs: options.termGraceMs,
    });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  return {
    exit: failure === undefined ? exit : observedExit,
    timedOut: failure instanceof QualificationTimeoutError,
    error: failure === undefined ? null : failure.message,
  };
}

function serializeManifest(manifest: QualificationEvidenceManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
