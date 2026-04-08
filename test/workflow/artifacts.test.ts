import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { FileArtifactManager, collectFilesRecursive, hasAnyFiles } from '../../src/workflow/artifacts.js';
import type { WorkflowId } from '../../src/workflow/types.js';
import { createWorkflowId } from '../../src/workflow/types.js';

describe('FileArtifactManager', () => {
  let baseDir: string;
  let manager: FileArtifactManager;
  let workflowId: WorkflowId;

  beforeEach(() => {
    baseDir = resolve('/tmp', `ironcurtain-artifact-test-${process.pid}-${Date.now()}`);
    mkdirSync(baseDir, { recursive: true });
    manager = new FileArtifactManager(baseDir);
    workflowId = createWorkflowId();
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // initialize
  // -------------------------------------------------------------------------

  describe('initialize', () => {
    it('creates the artifact directory structure', () => {
      const dir = manager.initialize(workflowId);
      expect(dir).toContain(workflowId);
      expect(dir).toMatch(/artifacts$/);
    });

    it('returns the artifact directory path', () => {
      const dir = manager.initialize(workflowId);
      expect(dir).toBe(resolve(baseDir, workflowId, 'artifacts'));
    });

    it('is idempotent', () => {
      const dir1 = manager.initialize(workflowId);
      const dir2 = manager.initialize(workflowId);
      expect(dir1).toBe(dir2);
    });
  });

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  describe('read', () => {
    it('returns file content by convention name', () => {
      const artifactDir = manager.initialize(workflowId);
      const specDir = resolve(artifactDir, 'spec');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(resolve(specDir, 'spec.md'), 'Architecture spec content');

      const content = manager.read(workflowId, 'spec');
      expect(content).toBe('Architecture spec content');
    });

    it('falls back to first file alphabetically when convention name is absent', () => {
      const artifactDir = manager.initialize(workflowId);
      const planDir = resolve(artifactDir, 'plan');
      mkdirSync(planDir, { recursive: true });
      writeFileSync(resolve(planDir, 'beta.txt'), 'beta content');
      writeFileSync(resolve(planDir, 'alpha.txt'), 'alpha content');

      const content = manager.read(workflowId, 'plan');
      expect(content).toBe('alpha content');
    });

    it('returns undefined for missing artifact directory', () => {
      manager.initialize(workflowId);
      expect(manager.read(workflowId, 'nonexistent')).toBeUndefined();
    });

    it('returns undefined for empty artifact directory', () => {
      const artifactDir = manager.initialize(workflowId);
      mkdirSync(resolve(artifactDir, 'empty'), { recursive: true });

      expect(manager.read(workflowId, 'empty')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // listArtifactFiles
  // -------------------------------------------------------------------------

  describe('listArtifactFiles', () => {
    it('lists files in an artifact subdirectory', () => {
      const artifactDir = manager.initialize(workflowId);
      const codeDir = resolve(artifactDir, 'code');
      mkdirSync(codeDir, { recursive: true });
      writeFileSync(resolve(codeDir, 'main.ts'), 'code');
      writeFileSync(resolve(codeDir, 'utils.ts'), 'utils');

      const files = manager.listArtifactFiles(workflowId, 'code');
      expect(files).toEqual(['main.ts', 'utils.ts']);
    });

    it('returns empty array for missing artifact', () => {
      manager.initialize(workflowId);
      expect(manager.listArtifactFiles(workflowId, 'missing')).toEqual([]);
    });

    it('returns sorted file names', () => {
      const artifactDir = manager.initialize(workflowId);
      const dir = resolve(artifactDir, 'docs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'z.md'), '');
      writeFileSync(resolve(dir, 'a.md'), '');
      writeFileSync(resolve(dir, 'm.md'), '');

      const files = manager.listArtifactFiles(workflowId, 'docs');
      expect(files).toEqual(['a.md', 'm.md', 'z.md']);
    });
  });

  // -------------------------------------------------------------------------
  // findMissing
  // -------------------------------------------------------------------------

  describe('findMissing', () => {
    it('identifies missing artifacts', () => {
      const artifactDir = manager.initialize(workflowId);
      const specDir = resolve(artifactDir, 'spec');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(resolve(specDir, 'spec.md'), 'content');

      const missing = manager.findMissing(workflowId, ['spec', 'code', 'tests']);
      expect(missing).toEqual(['code', 'tests']);
    });

    it('returns empty array when all artifacts are present', () => {
      const artifactDir = manager.initialize(workflowId);
      for (const name of ['spec', 'code']) {
        const dir = resolve(artifactDir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, `${name}.md`), 'content');
      }

      expect(manager.findMissing(workflowId, ['spec', 'code'])).toEqual([]);
    });

    it('treats empty directories as missing', () => {
      const artifactDir = manager.initialize(workflowId);
      mkdirSync(resolve(artifactDir, 'empty'), { recursive: true });

      expect(manager.findMissing(workflowId, ['empty'])).toEqual(['empty']);
    });

    it('returns all names when none exist', () => {
      manager.initialize(workflowId);
      expect(manager.findMissing(workflowId, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    });
  });

  // -------------------------------------------------------------------------
  // computeHash
  // -------------------------------------------------------------------------

  describe('computeHash', () => {
    it('produces a deterministic hash for the same content', () => {
      const artifactDir = manager.initialize(workflowId);
      const specDir = resolve(artifactDir, 'spec');
      mkdirSync(specDir, { recursive: true });
      writeFileSync(resolve(specDir, 'spec.md'), 'stable content');

      const hash1 = manager.computeHash(workflowId, ['spec']);
      const hash2 = manager.computeHash(workflowId, ['spec']);
      expect(hash1).toBe(hash2);
    });

    it('changes when file content changes', () => {
      const artifactDir = manager.initialize(workflowId);
      const specDir = resolve(artifactDir, 'spec');
      mkdirSync(specDir, { recursive: true });

      writeFileSync(resolve(specDir, 'spec.md'), 'version 1');
      const hash1 = manager.computeHash(workflowId, ['spec']);

      writeFileSync(resolve(specDir, 'spec.md'), 'version 2');
      const hash2 = manager.computeHash(workflowId, ['spec']);

      expect(hash1).not.toBe(hash2);
    });

    it('produces a valid hex string', () => {
      const artifactDir = manager.initialize(workflowId);
      const dir = resolve(artifactDir, 'data');
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, 'file.txt'), 'data');

      const hash = manager.computeHash(workflowId, ['data']);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('handles missing artifact directories gracefully', () => {
      manager.initialize(workflowId);
      const hash = manager.computeHash(workflowId, ['nonexistent']);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is order-independent on artifact names (sorted internally)', () => {
      const artifactDir = manager.initialize(workflowId);
      for (const name of ['alpha', 'beta']) {
        const dir = resolve(artifactDir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'file.md'), `${name} content`);
      }

      const hash1 = manager.computeHash(workflowId, ['alpha', 'beta']);
      const hash2 = manager.computeHash(workflowId, ['beta', 'alpha']);
      expect(hash1).toBe(hash2);
    });

    it('includes nested files in hash computation', () => {
      const artifactDir = manager.initialize(workflowId);
      const codeDir = resolve(artifactDir, 'code');
      mkdirSync(resolve(codeDir, 'src'), { recursive: true });
      writeFileSync(resolve(codeDir, 'index.ts'), 'root file');
      writeFileSync(resolve(codeDir, 'src', 'main.ts'), 'nested file');

      const hash1 = manager.computeHash(workflowId, ['code']);

      // Changing a nested file should change the hash
      writeFileSync(resolve(codeDir, 'src', 'main.ts'), 'modified nested file');
      const hash2 = manager.computeHash(workflowId, ['code']);

      expect(hash1).not.toBe(hash2);
    });
  });

  // -------------------------------------------------------------------------
  // Nested directory support
  // -------------------------------------------------------------------------

  describe('nested directory support', () => {
    it('findMissing detects files in subdirectories', () => {
      const artifactDir = manager.initialize(workflowId);
      const codeDir = resolve(artifactDir, 'code');
      mkdirSync(resolve(codeDir, 'src'), { recursive: true });
      writeFileSync(resolve(codeDir, 'src', 'main.ts'), 'code');

      expect(manager.findMissing(workflowId, ['code'])).toEqual([]);
    });

    it('findMissing treats directories with only empty subdirs as missing', () => {
      const artifactDir = manager.initialize(workflowId);
      const codeDir = resolve(artifactDir, 'code');
      mkdirSync(resolve(codeDir, 'src', 'empty'), { recursive: true });

      expect(manager.findMissing(workflowId, ['code'])).toEqual(['code']);
    });

    it('listArtifactFiles returns relative paths for nested files', () => {
      const artifactDir = manager.initialize(workflowId);
      const codeDir = resolve(artifactDir, 'code');
      mkdirSync(resolve(codeDir, 'src'), { recursive: true });
      mkdirSync(resolve(codeDir, 'tests'), { recursive: true });
      writeFileSync(resolve(codeDir, 'index.ts'), 'root');
      writeFileSync(resolve(codeDir, 'src', 'main.ts'), 'src');
      writeFileSync(resolve(codeDir, 'tests', 'main.test.ts'), 'test');

      const files = manager.listArtifactFiles(workflowId, 'code');
      expect(files).toEqual(['index.ts', 'src/main.ts', 'tests/main.test.ts']);
    });

    it('read falls back to first file by sorted relative path in nested dirs', () => {
      const artifactDir = manager.initialize(workflowId);
      const codeDir = resolve(artifactDir, 'code');
      mkdirSync(resolve(codeDir, 'src'), { recursive: true });
      writeFileSync(resolve(codeDir, 'src', 'alpha.ts'), 'alpha content');

      const content = manager.read(workflowId, 'code');
      expect(content).toBe('alpha content');
    });
  });
});

// ---------------------------------------------------------------------------
// Shared filesystem helpers
// ---------------------------------------------------------------------------

describe('collectFilesRecursive', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = resolve('/tmp', `ironcurtain-collect-test-${process.pid}-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array for nonexistent directory', () => {
    expect(collectFilesRecursive(resolve(testDir, 'nope'))).toEqual([]);
  });

  it('returns empty array for empty directory', () => {
    expect(collectFilesRecursive(testDir)).toEqual([]);
  });

  it('collects flat files', () => {
    writeFileSync(resolve(testDir, 'a.txt'), 'a');
    writeFileSync(resolve(testDir, 'b.txt'), 'b');

    const files = collectFilesRecursive(testDir);
    expect(files.map((f) => f.relativePath)).toEqual(['a.txt', 'b.txt']);
  });

  it('collects files from nested directories', () => {
    mkdirSync(resolve(testDir, 'src', 'utils'), { recursive: true });
    writeFileSync(resolve(testDir, 'index.ts'), 'root');
    writeFileSync(resolve(testDir, 'src', 'main.ts'), 'main');
    writeFileSync(resolve(testDir, 'src', 'utils', 'helper.ts'), 'helper');

    const files = collectFilesRecursive(testDir);
    expect(files.map((f) => f.relativePath)).toEqual(['index.ts', 'src/main.ts', 'src/utils/helper.ts']);
  });

  it('sorts results deterministically by relative path', () => {
    mkdirSync(resolve(testDir, 'z'), { recursive: true });
    mkdirSync(resolve(testDir, 'a'), { recursive: true });
    writeFileSync(resolve(testDir, 'z', 'file.ts'), 'z');
    writeFileSync(resolve(testDir, 'a', 'file.ts'), 'a');
    writeFileSync(resolve(testDir, 'middle.ts'), 'm');

    const paths = collectFilesRecursive(testDir).map((f) => f.relativePath);
    expect(paths).toEqual(['a/file.ts', 'middle.ts', 'z/file.ts']);
  });

  it('skips symlinks', () => {
    writeFileSync(resolve(testDir, 'real.txt'), 'real');
    symlinkSync(resolve(testDir, 'real.txt'), resolve(testDir, 'link.txt'));

    const files = collectFilesRecursive(testDir);
    expect(files.map((f) => f.relativePath)).toEqual(['real.txt']);
  });

  it('skips directories containing only empty subdirs', () => {
    mkdirSync(resolve(testDir, 'empty', 'nested'), { recursive: true });

    expect(collectFilesRecursive(testDir)).toEqual([]);
  });

  it('provides correct fullPath for each file', () => {
    mkdirSync(resolve(testDir, 'sub'), { recursive: true });
    writeFileSync(resolve(testDir, 'sub', 'file.txt'), 'content');

    const files = collectFilesRecursive(testDir);
    expect(files[0].fullPath).toBe(resolve(testDir, 'sub', 'file.txt'));
  });
});

describe('hasAnyFiles', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = resolve('/tmp', `ironcurtain-hasfiles-test-${process.pid}-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns false for nonexistent directory', () => {
    expect(hasAnyFiles(resolve(testDir, 'nope'))).toBe(false);
  });

  it('returns false for empty directory', () => {
    expect(hasAnyFiles(testDir)).toBe(false);
  });

  it('returns false for directory with only empty subdirs', () => {
    mkdirSync(resolve(testDir, 'a', 'b', 'c'), { recursive: true });
    expect(hasAnyFiles(testDir)).toBe(false);
  });

  it('returns true for directory with a flat file', () => {
    writeFileSync(resolve(testDir, 'file.txt'), 'content');
    expect(hasAnyFiles(testDir)).toBe(true);
  });

  it('returns true for deeply nested file', () => {
    mkdirSync(resolve(testDir, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(resolve(testDir, 'a', 'b', 'c', 'deep.txt'), 'deep');
    expect(hasAnyFiles(testDir)).toBe(true);
  });
});
