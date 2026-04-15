/**
 * Tests for artifact versioning via snapshotArtifacts().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
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
});
