import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QualificationEvidenceRecorder } from '../../scripts/qualification-evidence.js';

const reportDirectories: string[] = [];

afterEach(() => {
  for (const directory of reportDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('qualification evidence', () => {
  it('retains both output streams and exact live-gate execution metadata', async () => {
    const reportDirectory = createReportDirectory();
    const recorder = createRecorder(reportDirectory);

    await recorder.runScript({
      kind: 'live-gate',
      script: 'fixtures/qualification-evidence.ts',
      arguments: ['0'],
      timeoutMs: 5_000,
    });
    recorder.recordVitestPassed(12);
    recorder.complete();

    const manifest = loadManifest(reportDirectory);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      suiteId: 'wsl-desktop',
      backend: 'wsl-desktop',
      status: 'passed',
      failure: null,
      vitest: { report: 'wsl-desktop.vitest.json', status: 'passed', testCount: 12 },
      scripts: [
        {
          sequence: 1,
          kind: 'live-gate',
          script: 'fixtures/qualification-evidence.ts',
          arguments: ['0'],
          timeoutMs: 5_000,
          termGraceMs: null,
          status: 'passed',
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutLog: 'wsl-desktop.live-gate-01.stdout.log',
          stderrLog: 'wsl-desktop.live-gate-01.stderr.log',
          failure: null,
        },
      ],
    });
    expect(readFileSync(join(reportDirectory, manifest.scripts[0].stdoutLog), 'utf8')).toBe(
      'qualification fixture stdout 0\n',
    );
    expect(readFileSync(join(reportDirectory, manifest.scripts[0].stderrLog), 'utf8')).toBe(
      'qualification fixture stderr 0\n',
    );
  });

  it('records nonzero live-gate evidence before failing the qualification', async () => {
    const reportDirectory = createReportDirectory();
    const recorder = createRecorder(reportDirectory);
    let failure: unknown;
    try {
      await recorder.runScript({
        kind: 'preparation',
        script: 'fixtures/qualification-evidence.ts',
        arguments: ['7'],
        timeoutMs: 5_000,
      });
    } catch (error) {
      failure = error;
      recorder.fail(error);
    }

    expect(failure).toBeInstanceOf(Error);
    const manifest = loadManifest(reportDirectory);
    expect(manifest).toMatchObject({
      status: 'failed',
      failure: expect.stringContaining('qualification script failed (7)'),
      scripts: [
        {
          kind: 'preparation',
          status: 'failed',
          exitCode: 7,
          signal: null,
          timedOut: false,
          failure: expect.stringContaining('qualification script failed (7)'),
        },
      ],
    });
  });

  it('records a bounded timeout and the terminating signal', async () => {
    const reportDirectory = createReportDirectory();
    const recorder = createRecorder(reportDirectory);
    let failure: unknown;
    try {
      await recorder.runScript({
        kind: 'live-gate',
        script: 'fixtures/qualification-evidence.ts',
        arguments: ['hang'],
        timeoutMs: 100,
        termGraceMs: 100,
      });
    } catch (error) {
      failure = error;
      recorder.fail(error);
    }

    expect(failure).toBeInstanceOf(Error);
    expect(loadManifest(reportDirectory)).toMatchObject({
      status: 'failed',
      scripts: [
        {
          status: 'failed',
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: true,
          failure: expect.stringContaining('timed out after 100ms'),
        },
      ],
    });
  });

  it('does not replace an existing qualification manifest', () => {
    const reportDirectory = createReportDirectory();
    const manifestPath = join(reportDirectory, 'wsl-desktop.qualification.json');
    writeFileSync(manifestPath, 'existing evidence', { mode: 0o600 });

    expect(() => createRecorder(reportDirectory)).toThrow();
    expect(readFileSync(manifestPath, 'utf8')).toBe('existing evidence');
  });

  it('records a log-file collision without replacing the existing artifact', async () => {
    const reportDirectory = createReportDirectory();
    const recorder = createRecorder(reportDirectory);
    const logPath = join(reportDirectory, 'wsl-desktop.live-gate-01.stdout.log');
    writeFileSync(logPath, 'existing log', { mode: 0o600 });

    await expect(
      recorder.runScript({
        kind: 'live-gate',
        script: 'fixtures/qualification-evidence.ts',
        arguments: ['0'],
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow();

    expect(readFileSync(logPath, 'utf8')).toBe('existing log');
    expect(loadManifest(reportDirectory)).toMatchObject({
      scripts: [
        {
          status: 'failed',
          exitCode: null,
          signal: null,
          stdoutLog: 'wsl-desktop.live-gate-01.stdout.log',
        },
      ],
    });
  });
});

interface Manifest {
  readonly scripts: readonly { readonly stdoutLog: string; readonly stderrLog: string }[];
  readonly [key: string]: unknown;
}

function createRecorder(reportDirectory: string): QualificationEvidenceRecorder {
  return new QualificationEvidenceRecorder({
    reportDirectory,
    repositoryRoot: resolve('.'),
    suiteId: 'wsl-desktop',
    backend: 'wsl-desktop',
    label: 'WSL / Docker Desktop (amd64)',
  });
}

function createReportDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ic-qualification-evidence-'));
  reportDirectories.push(directory);
  return directory;
}

function loadManifest(reportDirectory: string): Manifest {
  return JSON.parse(readFileSync(join(reportDirectory, 'wsl-desktop.qualification.json'), 'utf8')) as Manifest;
}
