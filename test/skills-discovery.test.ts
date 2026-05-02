/**
 * Tests for SKILL.md discovery and layered resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverSkills, discoverSkillsWithErrors, resolveSkillsForSession } from '../src/skills/discovery.js';

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
// discoverSkillsWithErrors
// ---------------------------------------------------------------------------

describe('discoverSkillsWithErrors', () => {
  it('returns empty skills and empty errors when the root is missing', () => {
    const missing = resolve(tempDir, 'does-not-exist');
    expect(discoverSkillsWithErrors(missing, 'user')).toEqual({ skills: [], errors: [] });
  });

  it('returns empty skills and empty errors for an empty skills root', () => {
    const skillsRoot = resolve(tempDir, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    expect(discoverSkillsWithErrors(skillsRoot, 'user')).toEqual({ skills: [], errors: [] });
  });

  it('returns valid skills alongside errors so one bad skill never hides the good ones', () => {
    const skillsRoot = resolve(tempDir, 'skills');
    writeSkill(skillsRoot, 'good', { name: 'good', description: 'd' });

    const broken = resolve(skillsRoot, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(resolve(broken, 'SKILL.md'), '---\n\t- not: : a: mapping\n---\n');

    const { skills, errors } = discoverSkillsWithErrors(skillsRoot, 'user');
    expect(skills.map((s) => s.name)).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0].skillDir).toBe(broken);
    expect(errors[0].reason).toBe('malformed-frontmatter');
  });

  it('reports missing-manifest for directories with no SKILL.md', () => {
    const skillsRoot = resolve(tempDir, 'skills');
    const noManifest = resolve(skillsRoot, 'no-manifest');
    mkdirSync(noManifest, { recursive: true });

    const { skills, errors } = discoverSkillsWithErrors(skillsRoot, 'user');
    expect(skills).toEqual([]);
    expect(errors).toEqual([{ skillDir: noManifest, reason: 'missing-manifest' }]);
  });

  it('reports malformed-frontmatter when YAML fails to parse', () => {
    const skillsRoot = resolve(tempDir, 'skills');
    const broken = resolve(skillsRoot, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(resolve(broken, 'SKILL.md'), '---\nname: "unterminated\n---\n');

    const { skills, errors } = discoverSkillsWithErrors(skillsRoot, 'user');
    expect(skills).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe('malformed-frontmatter');
    expect(errors[0].detail).toContain('YAML parse error');
  });

  it('reports malformed-frontmatter when there is no `---` fence at all', () => {
    const skillsRoot = resolve(tempDir, 'skills');
    const noFence = resolve(skillsRoot, 'no-fence');
    mkdirSync(noFence, { recursive: true });
    writeFileSync(resolve(noFence, 'SKILL.md'), '# Just a markdown body, no frontmatter\n');

    const { errors } = discoverSkillsWithErrors(skillsRoot, 'user');
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe('malformed-frontmatter');
  });

  it('reports missing-required-fields when name or description is absent', () => {
    const skillsRoot = resolve(tempDir, 'skills');
    writeSkill(skillsRoot, 'no-name', { description: 'orphan' });
    writeSkill(skillsRoot, 'no-desc', { name: 'orphan' });

    const { skills, errors } = discoverSkillsWithErrors(skillsRoot, 'user');
    expect(skills).toEqual([]);
    expect(errors).toHaveLength(2);
    for (const err of errors) {
      expect(err.reason).toBe('missing-required-fields');
    }
  });

  it('reports missing-required-fields when the frontmatter is not an object', () => {
    const skillsRoot = resolve(tempDir, 'skills');
    const arrayFm = resolve(skillsRoot, 'array-fm');
    mkdirSync(arrayFm, { recursive: true });
    // Yaml fence containing an array, not a mapping.
    writeFileSync(resolve(arrayFm, 'SKILL.md'), '---\n- one\n- two\n---\n');

    const { errors } = discoverSkillsWithErrors(skillsRoot, 'user');
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toBe('malformed-frontmatter');
  });

  it('does not produce errors for non-directory entries at the skills root', () => {
    // Loose files at the root are ignored entirely (neither skills nor
    // errors). Treating them as malformed would over-report on harmless
    // sibling files like `README.md`.
    const skillsRoot = resolve(tempDir, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
    writeFileSync(resolve(skillsRoot, 'README.md'), '# top-level readme\n');
    writeSkill(skillsRoot, 'valid', { name: 'valid', description: 'd' });

    const { skills, errors } = discoverSkillsWithErrors(skillsRoot, 'user');
    expect(skills.map((s) => s.name)).toEqual(['valid']);
    expect(errors).toEqual([]);
  });

  it('iterates entries in lexicographic order regardless of filesystem order', () => {
    // Without sorting, `readdirSync` order is filesystem-dependent and
    // can vary across runs. Two directories declaring the same
    // frontmatter `name:` would then non-deterministically pick a
    // winner during layer composition. Lexicographic sort makes the
    // resolution stable: the lex-first directory wins.
    const skillsRoot = resolve(tempDir, 'skills');
    // Names chosen so a hash-bucketed FS order would not coincide with
    // lex order; in particular, "z-first" sorts after "a-second" but
    // is created first on disk.
    writeSkill(skillsRoot, 'z-first', { name: 'shared', description: 'z-first wins?' });
    writeSkill(skillsRoot, 'a-second', { name: 'shared', description: 'a-second wins?' });
    writeSkill(skillsRoot, 'm-middle', { name: 'm', description: 'middle' });

    const { skills, errors } = discoverSkillsWithErrors(skillsRoot, 'user');

    // Both runs must produce the same answer: `a-second` (lex-first)
    // wins the duplicate `shared` collision; `z-first` is the
    // duplicate.
    const winner = skills.find((s) => s.name === 'shared');
    expect(winner?.sourceDir).toBe(resolve(skillsRoot, 'a-second'));
    expect(winner?.description).toBe('a-second wins?');

    // The non-`shared` entry survives unchanged.
    expect(skills.find((s) => s.name === 'm')?.sourceDir).toBe(resolve(skillsRoot, 'm-middle'));

    // The losing duplicate is reported, not silently dropped.
    const dup = errors.find((e) => e.reason === 'duplicate-name');
    expect(dup?.skillDir).toBe(resolve(skillsRoot, 'z-first'));
    expect(dup?.detail).toContain('"shared"');
  });

  it('reports duplicate-name once per losing entry when more than two collide', () => {
    // Three entries claim the same name; the first (`a`) wins, `b` and
    // `c` are both reported as duplicates.
    const skillsRoot = resolve(tempDir, 'skills');
    writeSkill(skillsRoot, 'a', { name: 'shared', description: 'a wins' });
    writeSkill(skillsRoot, 'b', { name: 'shared', description: 'b loses' });
    writeSkill(skillsRoot, 'c', { name: 'shared', description: 'c loses' });

    const { skills, errors } = discoverSkillsWithErrors(skillsRoot, 'user');
    expect(skills).toHaveLength(1);
    expect(skills[0].sourceDir).toBe(resolve(skillsRoot, 'a'));

    const dups = errors.filter((e) => e.reason === 'duplicate-name');
    expect(dups.map((e) => e.skillDir).sort()).toEqual([resolve(skillsRoot, 'b'), resolve(skillsRoot, 'c')]);
  });
});

// ---------------------------------------------------------------------------
// discoverSkills (wrapper) — happy path unchanged
// ---------------------------------------------------------------------------

describe('discoverSkills (wrapper around discoverSkillsWithErrors)', () => {
  it('returns the same ResolvedSkill[] shape as before for a well-formed root', () => {
    // Regression for the wrapper refactor: callers that don't care
    // about errors must continue to receive a plain ResolvedSkill[]
    // with no behavior change for the happy path.
    const skillsRoot = resolve(tempDir, 'skills');
    writeSkill(skillsRoot, 'fetcher', { name: 'fetcher', description: 'fetches stuff' });
    writeSkill(skillsRoot, 'parser', { name: 'parser', description: 'parses stuff' });

    const result = discoverSkills(skillsRoot, 'user');
    const names = result.map((r) => r.name).sort();
    expect(names).toEqual(['fetcher', 'parser']);
    for (const skill of result) {
      expect(skill.source).toBe('user');
    }
  });

  it('still drops malformed skills silently from the returned array', () => {
    // The wrapper logs warnings but must not throw or pollute the
    // returned skills with malformed entries.
    const skillsRoot = resolve(tempDir, 'skills');
    writeSkill(skillsRoot, 'good', { name: 'good', description: 'd' });
    const broken = resolve(skillsRoot, 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(resolve(broken, 'SKILL.md'), '---\n\t- bad: : :\n---\n');

    expect(() => discoverSkills(skillsRoot, 'user')).not.toThrow();
    expect(discoverSkills(skillsRoot, 'user').map((r) => r.name)).toEqual(['good']);
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
