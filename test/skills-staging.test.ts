/**
 * Tests for skill staging into a bundle directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { stageSkillsToBundle } from '../src/skills/staging.js';
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
    expect(() => stageSkillsToBundle([skill], dest)).toThrow(/escapes staging directory/);
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
    expect(() => stageSkillsToBundle([skill], dest)).toThrow(/escapes staging directory/);
  });
});
