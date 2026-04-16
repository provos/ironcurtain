/**
 * Tests for artifact versioning via snapshotArtifacts().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Passthrough mock so individual tests can override cpSync via mockImplementationOnce.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, cpSync: vi.fn(actual.cpSync) };
});

import { snapshotArtifacts } from '../src/workflow/artifacts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let artifactDir: string;

function createTempDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'ironcurtain-artifact-version-'));
}

function writeArtifactFile(outputName: string, fileName: string, content: string): void {
  const dir = resolve(artifactDir, outputName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, fileName), content);
}

function readVersionedFile(outputName: string, version: number, fileName: string): string {
  return readFileSync(resolve(artifactDir, `${outputName}.v${version}`, fileName), 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  artifactDir = createTempDir();
});

afterEach(() => {
  rmSync(artifactDir, { recursive: true, force: true });
});

describe('snapshotArtifacts', () => {
  it('creates .v1 backup on second visit', () => {
    writeArtifactFile('analysis', 'analysis.md', 'original analysis');

    snapshotArtifacts(artifactDir, ['analysis'], 2, new Set());

    expect(readVersionedFile('analysis', 1, 'analysis.md')).toBe('original analysis');
  });

  it('creates .v2 backup on third visit', () => {
    writeArtifactFile('analysis', 'analysis.md', 'round-two analysis');

    snapshotArtifacts(artifactDir, ['analysis'], 3, new Set());

    expect(readVersionedFile('analysis', 2, 'analysis.md')).toBe('round-two analysis');
  });

  it('skips artifacts in the unversionedArtifacts set', () => {
    writeArtifactFile('journal', 'journal.md', 'append-only log');

    snapshotArtifacts(artifactDir, ['journal'], 2, new Set(['journal']));

    expect(existsSync(resolve(artifactDir, 'journal.v1'))).toBe(false);
  });

  it('does not overwrite an existing versioned directory (idempotency)', () => {
    writeArtifactFile('analysis', 'analysis.md', 'original content');

    // Simulate a previous snapshot that already created .v1
    const existingVersionDir = resolve(artifactDir, 'analysis.v1');
    mkdirSync(existingVersionDir, { recursive: true });
    writeFileSync(resolve(existingVersionDir, 'analysis.md'), 'preserved content');

    // Now overwrite the source with new content
    writeArtifactFile('analysis', 'analysis.md', 'corrupted content');

    snapshotArtifacts(artifactDir, ['analysis'], 2, new Set());

    // The .v1 should still have the preserved content, NOT the corrupted content
    expect(readVersionedFile('analysis', 1, 'analysis.md')).toBe('preserved content');
  });

  it('does nothing when source directory does not exist', () => {
    // No artifact directory created — the agent failed before writing output
    snapshotArtifacts(artifactDir, ['nonexistent'], 2, new Set());

    expect(existsSync(resolve(artifactDir, 'nonexistent.v1'))).toBe(false);
  });

  it('recursively copies nested subdirectories', () => {
    const subDir = resolve(artifactDir, 'harness_build', 'src', 'tests');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(resolve(artifactDir, 'harness_build', 'README.md'), 'top-level');
    writeFileSync(resolve(subDir, 'test_main.c'), 'int main() {}');

    snapshotArtifacts(artifactDir, ['harness_build'], 2, new Set());

    expect(readVersionedFile('harness_build', 1, 'README.md')).toBe('top-level');
    expect(readFileSync(resolve(artifactDir, 'harness_build.v1', 'src', 'tests', 'test_main.c'), 'utf-8')).toBe(
      'int main() {}',
    );
  });

  it('does nothing on first visit (visitNumber === 1)', () => {
    writeArtifactFile('analysis', 'analysis.md', 'first visit');

    snapshotArtifacts(artifactDir, ['analysis'], 1, new Set());

    expect(existsSync(resolve(artifactDir, 'analysis.v0'))).toBe(false);
    expect(existsSync(resolve(artifactDir, 'analysis.v1'))).toBe(false);
  });

  it('snapshots multiple outputs in a single call', () => {
    writeArtifactFile('analysis', 'analysis.md', 'analysis content');
    writeArtifactFile('harness_design', 'design.md', 'design content');

    snapshotArtifacts(artifactDir, ['analysis', 'harness_design'], 2, new Set());

    expect(readVersionedFile('analysis', 1, 'analysis.md')).toBe('analysis content');
    expect(readVersionedFile('harness_design', 1, 'design.md')).toBe('design content');
  });

  it('snapshots some outputs while skipping unversioned ones', () => {
    writeArtifactFile('analysis', 'analysis.md', 'analysis content');
    writeArtifactFile('journal', 'journal.md', 'journal content');

    snapshotArtifacts(artifactDir, ['analysis', 'journal'], 2, new Set(['journal']));

    expect(readVersionedFile('analysis', 1, 'analysis.md')).toBe('analysis content');
    expect(existsSync(resolve(artifactDir, 'journal.v1'))).toBe(false);
  });

  it('logs a warning and continues when a single copy fails', () => {
    writeArtifactFile('broken', 'broken.md', 'triggers copy error');
    writeArtifactFile('analysis', 'analysis.md', 'analysis content');

    // Fail the first cpSync call only; the second call proceeds normally.
    const mockedCpSync = vi.mocked(cpSync);
    mockedCpSync.mockImplementationOnce(() => {
      throw new Error('simulated copy failure');
    });

    const stderrWrites: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });

    try {
      expect(() => snapshotArtifacts(artifactDir, ['broken', 'analysis'], 2, new Set())).not.toThrow();
    } finally {
      stderrSpy.mockRestore();
    }

    // The failed artifact was not snapshotted.
    expect(existsSync(resolve(artifactDir, 'broken.v1'))).toBe(false);
    // The subsequent artifact in the same call still got snapshotted.
    expect(readVersionedFile('analysis', 1, 'analysis.md')).toBe('analysis content');

    // A warning was written to stderr mentioning src, dest, and the error message.
    const combined = stderrWrites.join('');
    expect(combined).toMatch(/snapshotArtifacts/);
    expect(combined).toContain(resolve(artifactDir, 'broken'));
    expect(combined).toContain(resolve(artifactDir, 'broken.v1'));
    expect(combined).toContain('simulated copy failure');
  });
});
