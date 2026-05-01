/**
 * Tests for skill staging into a bundle directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { stageSkillsToBundle, createCachedStager, validateSkillName } from '../src/skills/staging.js';
import type { ResolvedSkill } from '../src/skills/types.js';

let tempDir: string;

function createTempDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'ironcurtain-skills-stage-test-'));
}

/**
 * Writes a fake skill source dir with a SKILL.md and some siblings.
 * Returns the absolute path.
 */
function writeSourceSkill(parent: string, dirName: string, files: Record<string, string> = {}): string {
  const dir = resolve(parent, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'SKILL.md'), `---\nname: ${dirName}\ndescription: x\n---\nbody\n`);
  for (const [name, content] of Object.entries(files)) {
    const target = resolve(dir, name);
    mkdirSync(resolve(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

beforeEach(() => {
  tempDir = createTempDir();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('stageSkillsToBundle', () => {
  it('creates the destination directory when missing', () => {
    const dest = resolve(tempDir, 'dest', 'skills');
    stageSkillsToBundle([], dest);
    expect(existsSync(dest)).toBe(true);
  });

  it('copies a single skill recursively, including helper files', () => {
    const sourceParent = resolve(tempDir, 'sources');
    const skillSrc = writeSourceSkill(sourceParent, 'fetcher', {
      'helper.sh': '#!/bin/sh\necho hi\n',
      'fixtures/data.json': '{"k": 1}',
    });
    const skill: ResolvedSkill = {
      name: 'fetcher',
      source: 'user',
      sourceDir: skillSrc,
      description: 'x',
    };

    const dest = resolve(tempDir, 'staged');
    stageSkillsToBundle([skill], dest);

    expect(existsSync(resolve(dest, 'fetcher', 'SKILL.md'))).toBe(true);
    expect(readFileSync(resolve(dest, 'fetcher', 'helper.sh'), 'utf-8')).toContain('echo hi');
    expect(readFileSync(resolve(dest, 'fetcher', 'fixtures', 'data.json'), 'utf-8')).toBe('{"k": 1}');
  });

  it('uses the resolved skill name (not the source dir name) as the staged dir', () => {
    // Discovery names entries by frontmatter; staging must mirror that
    // so the container sees the canonical names regardless of dir layout.
    const sourceParent = resolve(tempDir, 'sources');
    const skillSrc = writeSourceSkill(sourceParent, 'src-dir-name');
    const skill: ResolvedSkill = {
      name: 'canonical',
      source: 'user',
      sourceDir: skillSrc,
      description: 'x',
    };

    const dest = resolve(tempDir, 'staged');
    stageSkillsToBundle([skill], dest);
    expect(existsSync(resolve(dest, 'canonical', 'SKILL.md'))).toBe(true);
    expect(existsSync(resolve(dest, 'src-dir-name'))).toBe(false);
  });

  it('wipes stale entries before re-staging (idempotent)', () => {
    const sourceParent = resolve(tempDir, 'sources');
    const skillA = writeSourceSkill(sourceParent, 'a');
    const skillB = writeSourceSkill(sourceParent, 'b');

    const dest = resolve(tempDir, 'staged');
    stageSkillsToBundle(
      [
        { name: 'a', source: 'user', sourceDir: skillA, description: 'a' },
        { name: 'b', source: 'user', sourceDir: skillB, description: 'b' },
      ],
      dest,
    );
    expect(existsSync(resolve(dest, 'a'))).toBe(true);
    expect(existsSync(resolve(dest, 'b'))).toBe(true);

    // Re-stage with a smaller set: 'b' must be removed.
    stageSkillsToBundle([{ name: 'a', source: 'user', sourceDir: skillA, description: 'a' }], dest);
    expect(existsSync(resolve(dest, 'a'))).toBe(true);
    expect(existsSync(resolve(dest, 'b'))).toBe(false);
  });

  it('preserves the parent directory inode across re-stages (Docker bind-mount safety)', () => {
    // Workflow bundles bind-mount the staging dir into a long-lived
    // container. Linux bind mounts pin the source's inode at mount time,
    // so removing and recreating the parent leaves the container's mount
    // pointing at the freed inode. This test documents the invariant
    // that future implementations of stageSkillsToBundle must preserve.
    const sourceParent = resolve(tempDir, 'sources');
    const a = writeSourceSkill(sourceParent, 'a');
    const b = writeSourceSkill(sourceParent, 'b');

    const dest = resolve(tempDir, 'staged');
    stageSkillsToBundle([{ name: 'a', source: 'user', sourceDir: a, description: '' }], dest);
    const inode1 = statSync(dest).ino;

    stageSkillsToBundle([{ name: 'b', source: 'user', sourceDir: b, description: '' }], dest);
    const inode2 = statSync(dest).ino;
    expect(inode2).toBe(inode1);

    stageSkillsToBundle([], dest);
    const inode3 = statSync(dest).ino;
    expect(inode3).toBe(inode1);
  });

  it('rejects skill names that traverse out of the staging dir', () => {
    const sourceParent = resolve(tempDir, 'sources');
    const skillSrc = writeSourceSkill(sourceParent, 'evil');
    const skill: ResolvedSkill = {
      name: '../escaped',
      source: 'user',
      sourceDir: skillSrc,
      description: 'x',
    };
    const dest = resolve(tempDir, 'staged');
    // The embedded `/` trips validateSkillName's path-separator check.
    expect(() => stageSkillsToBundle([skill], dest)).toThrow(/path separator/);
  });

  it('rejects absolute skill names', () => {
    const sourceParent = resolve(tempDir, 'sources');
    const skillSrc = writeSourceSkill(sourceParent, 'evil');
    const skill: ResolvedSkill = {
      name: '/etc/passwd',
      source: 'user',
      sourceDir: skillSrc,
      description: 'x',
    };
    const dest = resolve(tempDir, 'staged');
    // Absolute paths trip the separator check in validateSkillName.
    expect(() => stageSkillsToBundle([skill], dest)).toThrow(/path separator/);
  });

  it('rejects an empty skill name (would overlay the staging root)', () => {
    const sourceParent = resolve(tempDir, 'sources');
    const skillSrc = writeSourceSkill(sourceParent, 'src');
    const skill: ResolvedSkill = { name: '', source: 'user', sourceDir: skillSrc, description: 'x' };
    const dest = resolve(tempDir, 'staged');
    expect(() => stageSkillsToBundle([skill], dest)).toThrow(/Invalid skill name.*empty/);
  });

  it('rejects "." (would overlay the staging root)', () => {
    const sourceParent = resolve(tempDir, 'sources');
    const skillSrc = writeSourceSkill(sourceParent, 'src');
    const skill: ResolvedSkill = { name: '.', source: 'user', sourceDir: skillSrc, description: 'x' };
    const dest = resolve(tempDir, 'staged');
    expect(() => stageSkillsToBundle([skill], dest)).toThrow(/Invalid skill name/);
  });

  it('rejects skill names containing a path separator (would nest inside destDir)', () => {
    const sourceParent = resolve(tempDir, 'sources');
    const skillSrc = writeSourceSkill(sourceParent, 'src');
    const skill: ResolvedSkill = {
      name: 'foo/bar',
      source: 'user',
      sourceDir: skillSrc,
      description: 'x',
    };
    const dest = resolve(tempDir, 'staged');
    expect(() => stageSkillsToBundle([skill], dest)).toThrow(/path separator/);
  });
});

// ---------------------------------------------------------------------------
// validateSkillName — shape-only check shared by staging + workflow validation
// ---------------------------------------------------------------------------

describe('validateSkillName', () => {
  it('accepts a single non-empty path segment', () => {
    expect(() => validateSkillName('fetcher')).not.toThrow();
    expect(() => validateSkillName('a-b_c.123')).not.toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => validateSkillName('')).toThrow(/empty/);
  });

  it('rejects "."', () => {
    expect(() => validateSkillName('.')).toThrow(/valid directory name/);
  });

  it('rejects ".."', () => {
    expect(() => validateSkillName('..')).toThrow(/valid directory name/);
  });

  it('rejects forward-slash separators', () => {
    expect(() => validateSkillName('foo/bar')).toThrow(/path separator/);
  });

  it('rejects backslash separators', () => {
    expect(() => validateSkillName('foo\\bar')).toThrow(/path separator/);
  });
});

describe('createCachedStager', () => {
  it('skips re-staging when the resolved set is unchanged', () => {
    const sourceParent = resolve(tempDir, 'sources');
    const skillSrc = writeSourceSkill(sourceParent, 's');
    const set: ResolvedSkill[] = [{ name: 's', source: 'user', sourceDir: skillSrc, description: 'd' }];

    const dest = resolve(tempDir, 'staged');
    const stage = createCachedStager(dest);
    expect(stage(set)).toBe(true);
    expect(existsSync(resolve(dest, 's'))).toBe(true);

    // External tampering: a deletion between calls should NOT be repaired
    // because the resolved-set signature is identical. This documents the
    // contract — the cache trusts that the staged dir has not been
    // mutated externally.
    rmSync(resolve(dest, 's'), { recursive: true, force: true });
    expect(stage(set)).toBe(false);
    expect(existsSync(resolve(dest, 's'))).toBe(false);
  });

  it('re-stages when the resolved set changes', () => {
    const sourceParent = resolve(tempDir, 'sources');
    const a = writeSourceSkill(sourceParent, 'a');
    const b = writeSourceSkill(sourceParent, 'b');

    const dest = resolve(tempDir, 'staged');
    const stage = createCachedStager(dest);

    expect(stage([{ name: 'a', source: 'user', sourceDir: a, description: '' }])).toBe(true);
    expect(stage([{ name: 'b', source: 'user', sourceDir: b, description: '' }])).toBe(true);
    expect(existsSync(resolve(dest, 'a'))).toBe(false);
    expect(existsSync(resolve(dest, 'b'))).toBe(true);
  });

  it('treats reordered identical sets as unchanged', () => {
    const sourceParent = resolve(tempDir, 'sources');
    const a = writeSourceSkill(sourceParent, 'a');
    const b = writeSourceSkill(sourceParent, 'b');

    const dest = resolve(tempDir, 'staged');
    const stage = createCachedStager(dest);

    expect(
      stage([
        { name: 'a', source: 'user', sourceDir: a, description: '' },
        { name: 'b', source: 'user', sourceDir: b, description: '' },
      ]),
    ).toBe(true);
    expect(
      stage([
        { name: 'b', source: 'user', sourceDir: b, description: '' },
        { name: 'a', source: 'user', sourceDir: a, description: '' },
      ]),
    ).toBe(false);
  });
});
