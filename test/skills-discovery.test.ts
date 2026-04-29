/**
 * Tests for SKILL.md discovery and layered resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverSkills, resolveSkillsForSession } from '../src/skills/discovery.js';

let tempDir: string;

function createTempDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'ironcurtain-skills-test-'));
}

/**
 * Writes a `<root>/<dirName>/SKILL.md` with the given frontmatter and a
 * trivial body. Returns the absolute path to the skill directory.
 */
function writeSkill(root: string, dirName: string, frontmatter: Record<string, unknown>, body = 'Body text\n'): string {
  const skillDir = resolve(root, dirName);
  mkdirSync(skillDir, { recursive: true });
  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : String(v)}`)
    .join('\n');
  writeFileSync(resolve(skillDir, 'SKILL.md'), `---\n${fmLines}\n---\n${body}`);
  return skillDir;
}

/** Helper to run a test with `IRONCURTAIN_HOME` pointed at tempDir. */
function withTempHome<T>(fn: () => T): T {
  const original = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = tempDir;
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = original;
    }
  }
}

beforeEach(() => {
  tempDir = createTempDir();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------

describe('discoverSkills', () => {
  it('returns [] for a missing root', () => {
    const missing = resolve(tempDir, 'does-not-exist');
    expect(discoverSkills(missing, 'user')).toEqual([]);
  });

  it('parses a single skill', () => {
    const skillsRoot = resolve(tempDir, 'skills');
    writeSkill(skillsRoot, 'fetcher', { name: 'fetcher', description: 'fetches stuff' });

    const result = discoverSkills(skillsRoot, 'user');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('fetcher');
    expect(result[0].description).toBe('fetches stuff');
    expect(result[0].source).toBe('user');
    expect(result[0].sourceDir).toBe(resolve(skillsRoot, 'fetcher'));
  });

  it('uses frontmatter name as the entry name (not the directory name)', () => {
    // Layer collisions are keyed on the frontmatter name; the directory
    // name is incidental and may differ (e.g., dashes vs underscores).
    const skillsRoot = resolve(tempDir, 'skills');
    writeSkill(skillsRoot, 'dir-alpha', { name: 'canonical', description: 'd' });

    const result = discoverSkills(skillsRoot, 'user');
    expect(result[0].name).toBe('canonical');
  });

  it('skips entries without a SKILL.md', () => {
    const skillsRoot = resolve(tempDir, 'skills');
    mkdirSync(resolve(skillsRoot, 'no-manifest'), { recursive: true });
    writeFileSync(resolve(skillsRoot, 'no-manifest', 'README.md'), '# nope');
    writeSkill(skillsRoot, 'valid', { name: 'valid', description: 'd' });

    const result = discoverSkills(skillsRoot, 'user');
    expect(result.map((r) => r.name)).toEqual(['valid']);
  });

  it('skips loose files at the skills root', () => {
    const skillsRoot = resolve(tempDir, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(resolve(skillsRoot, 'orphan.md'), '---\nname: nope\ndescription: x\n---\n');
    writeSkill(skillsRoot, 'valid', { name: 'valid', description: 'd' });

    const result = discoverSkills(skillsRoot, 'user');
    expect(result.map((r) => r.name)).toEqual(['valid']);
  });

  it('skips skills with malformed frontmatter', () => {
    const skillsRoot = resolve(tempDir, 'skills');
    const broken = resolve(skillsRoot, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(resolve(broken, 'SKILL.md'), '---\n\t- this: : :\n---\nbody\n');

    writeSkill(skillsRoot, 'good', { name: 'good', description: 'd' });

    const result = discoverSkills(skillsRoot, 'user');
    expect(result.map((r) => r.name)).toEqual(['good']);
  });

  it('skips skills missing required name or description', () => {
    const skillsRoot = resolve(tempDir, 'skills');
    writeSkill(skillsRoot, 'no-name', { description: 'orphan' });
    writeSkill(skillsRoot, 'no-desc', { name: 'orphan' });
    writeSkill(skillsRoot, 'good', { name: 'good', description: 'd' });

    const result = discoverSkills(skillsRoot, 'user');
    expect(result.map((r) => r.name)).toEqual(['good']);
  });

  it('skips files without YAML frontmatter fences', () => {
    const skillsRoot = resolve(tempDir, 'skills');
    const noFm = resolve(skillsRoot, 'no-fm');
    mkdirSync(noFm, { recursive: true });
    writeFileSync(resolve(noFm, 'SKILL.md'), '# Just markdown, no frontmatter\n');

    expect(discoverSkills(skillsRoot, 'user')).toEqual([]);
  });

  it('tags entries with the supplied source', () => {
    const skillsRoot = resolve(tempDir, 'skills');
    writeSkill(skillsRoot, 's', { name: 's', description: 'd' });

    expect(discoverSkills(skillsRoot, 'persona')[0].source).toBe('persona');
    expect(discoverSkills(skillsRoot, 'workflow')[0].source).toBe('workflow');
  });
});

// ---------------------------------------------------------------------------
// resolveSkillsForSession
// ---------------------------------------------------------------------------

describe('resolveSkillsForSession', () => {
  it('returns [] when no layers have skills', () => {
    withTempHome(() => {
      expect(resolveSkillsForSession({})).toEqual([]);
    });
  });

  it('returns user-global skills when only the user layer has them', () => {
    const userSkills = resolve(tempDir, 'skills');
    writeSkill(userSkills, 'global', { name: 'global', description: 'u' });

    withTempHome(() => {
      const result = resolveSkillsForSession({});
      expect(result.map((r) => r.name)).toEqual(['global']);
      expect(result[0].source).toBe('user');
    });
  });

  it('layers in workflow skills when workflowSkillsDir is set', () => {
    const workflowSkills = resolve(tempDir, 'workflow-skills');
    writeSkill(workflowSkills, 'wf-only', { name: 'wf-only', description: 'w' });

    withTempHome(() => {
      const result = resolveSkillsForSession({ workflowSkillsDir: workflowSkills });
      expect(result.map((r) => r.name)).toEqual(['wf-only']);
      expect(result[0].source).toBe('workflow');
    });
  });

  it('workflow skills override user-global skills on name collision', () => {
    const userSkills = resolve(tempDir, 'skills');
    writeSkill(userSkills, 'shared', { name: 'shared', description: 'user version' });

    const workflowSkills = resolve(tempDir, 'workflow-skills');
    writeSkill(workflowSkills, 'shared-dir', { name: 'shared', description: 'workflow version' });

    withTempHome(() => {
      const result = resolveSkillsForSession({ workflowSkillsDir: workflowSkills });
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe('workflow');
      expect(result[0].description).toBe('workflow version');
    });
  });

  it('skips persona layer when personaName is "global"', () => {
    // The "global" sentinel is used by workflow definitions to mean
    // "no persona"; resolution must not attempt to read a persona dir.
    withTempHome(() => {
      const result = resolveSkillsForSession({ personaName: 'global' });
      expect(result).toEqual([]);
    });
  });

  it('silently ignores invalid persona names rather than throwing', () => {
    // An invalid slug here should produce an empty persona layer, not
    // crash the session — the orchestrator validates personas
    // independently.
    withTempHome(() => {
      expect(() => resolveSkillsForSession({ personaName: 'NOT A VALID SLUG!' })).not.toThrow();
    });
  });

  it('skips persona layer in workflow mode (workflowSkillsDir set)', () => {
    // Persona-as-skill-source is intentionally inert in workflow mode.
    // User + workflow still compose with last-wins; persona is dropped.
    const userSkills = resolve(tempDir, 'skills');
    writeSkill(userSkills, 'a', { name: 'a', description: 'user-a' });
    writeSkill(userSkills, 'shared', { name: 'shared', description: 'user-shared' });

    const personaDir = resolve(tempDir, 'personas', 'reviewer', 'skills');
    writeSkill(personaDir, 'b', { name: 'b', description: 'persona-b' });
    writeSkill(personaDir, 'shared', { name: 'shared', description: 'persona-shared' });
    writeFileSync(resolve(tempDir, 'personas', 'reviewer', 'persona.json'), JSON.stringify({ name: 'reviewer' }));

    const workflowSkills = resolve(tempDir, 'wf-skills');
    writeSkill(workflowSkills, 'c', { name: 'c', description: 'wf-c' });
    writeSkill(workflowSkills, 'shared', { name: 'shared', description: 'wf-shared' });

    withTempHome(() => {
      const result = resolveSkillsForSession({
        personaName: 'reviewer',
        workflowSkillsDir: workflowSkills,
      });

      const byName = new Map(result.map((r) => [r.name, r]));
      expect(byName.get('a')?.source).toBe('user');
      expect(byName.has('b')).toBe(false);
      expect(byName.get('c')?.source).toBe('workflow');
      // Workflow beats user on `shared`; persona's entry never participates.
      expect(byName.get('shared')?.source).toBe('workflow');
      expect(byName.get('shared')?.description).toBe('wf-shared');
    });
  });

  it('layers user → persona with last-wins when workflowSkillsDir is unset', () => {
    // Standalone (non-workflow) sessions: persona-as-mode-of-user still
    // composes on top of user-global.
    const userSkills = resolve(tempDir, 'skills');
    writeSkill(userSkills, 'a', { name: 'a', description: 'user-a' });
    writeSkill(userSkills, 'shared', { name: 'shared', description: 'user-shared' });

    const personaDir = resolve(tempDir, 'personas', 'reviewer', 'skills');
    writeSkill(personaDir, 'b', { name: 'b', description: 'persona-b' });
    writeSkill(personaDir, 'shared', { name: 'shared', description: 'persona-shared' });
    writeFileSync(resolve(tempDir, 'personas', 'reviewer', 'persona.json'), JSON.stringify({ name: 'reviewer' }));

    withTempHome(() => {
      const result = resolveSkillsForSession({ personaName: 'reviewer' });

      const byName = new Map(result.map((r) => [r.name, r]));
      expect(byName.get('a')?.source).toBe('user');
      expect(byName.get('b')?.source).toBe('persona');
      expect(byName.get('shared')?.source).toBe('persona');
      expect(byName.get('shared')?.description).toBe('persona-shared');
    });
  });

  it('filters workflow layer through workflowSkillFilter', () => {
    const userSkills = resolve(tempDir, 'skills');
    writeSkill(userSkills, 'u-keep', { name: 'u-keep', description: 'u' });

    const workflowSkills = resolve(tempDir, 'wf-skills');
    writeSkill(workflowSkills, 'wf-keep', { name: 'wf-keep', description: 'k' });
    writeSkill(workflowSkills, 'wf-drop', { name: 'wf-drop', description: 'd' });

    withTempHome(() => {
      const result = resolveSkillsForSession({
        workflowSkillsDir: workflowSkills,
        workflowSkillFilter: new Set(['wf-keep']),
      });
      const names = result.map((r) => r.name).sort();
      expect(names).toEqual(['u-keep', 'wf-keep']);
    });
  });

  it('treats undefined and empty filter differently (empty drops every workflow skill)', () => {
    const workflowSkills = resolve(tempDir, 'wf-skills');
    writeSkill(workflowSkills, 'wf-only', { name: 'wf-only', description: 'w' });

    withTempHome(() => {
      const all = resolveSkillsForSession({ workflowSkillsDir: workflowSkills });
      expect(all.map((r) => r.name)).toEqual(['wf-only']);

      const filtered = resolveSkillsForSession({
        workflowSkillsDir: workflowSkills,
        workflowSkillFilter: new Set<string>(),
      });
      expect(filtered).toEqual([]);
    });
  });
});
