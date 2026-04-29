import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { getUserSkillsDir } from '../config/paths.js';
import { getPersonaSkillsDir } from '../persona/resolve.js';
import { createPersonaName } from '../persona/types.js';
import type { ResolvedSkill, SkillFrontmatter, SkillSource } from './types.js';

/** Standard SKILL.md fence: `---\n…\n---\n`. Body after the second fence is ignored here. */
const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

function parseFrontmatter(content: string): SkillFrontmatter | undefined {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return undefined;

  let parsed: unknown;
  try {
    // maxAliasCount: 0 hardens against YAML alias-bomb DoS.
    parsed = YAML.parse(match[1], { maxAliasCount: 0 });
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== 'string' || typeof obj.description !== 'string') {
    return undefined;
  }
  return obj as SkillFrontmatter;
}

/**
 * Returns one entry per `<skillsRoot>/<dir>/SKILL.md` with valid
 * frontmatter. Malformed or missing manifests are skipped silently so
 * one bad skill doesn't break the rest of the layer.
 */
export function discoverSkills(skillsRoot: string, source: SkillSource): ResolvedSkill[] {
  if (!existsSync(skillsRoot)) return [];

  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    return [];
  }

  const out: ResolvedSkill[] = [];
  for (const entry of entries) {
    const skillDir = resolve(skillsRoot, entry);
    let stats;
    try {
      stats = statSync(skillDir);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;

    const skillFile = resolve(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;

    let content: string;
    try {
      content = readFileSync(skillFile, 'utf-8');
    } catch {
      continue;
    }

    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) continue;

    out.push({
      name: frontmatter.name,
      source,
      sourceDir: skillDir,
      description: frontmatter.description,
    });
  }

  return out;
}

export interface ResolveSkillsOptions {
  readonly personaName?: string;
  readonly workflowSkillsDir?: string;
}

/**
 * Composes user → persona → workflow with last-wins on `name` collision.
 * `personaName === 'global'` is the workflow-definition sentinel for
 * "no persona" and skips the persona layer; an invalid slug is also
 * skipped (the orchestrator validates persona existence independently).
 */
export function resolveSkillsForSession(opts: ResolveSkillsOptions): ResolvedSkill[] {
  const userSkills = discoverSkills(getUserSkillsDir(), 'user');

  let personaSkills: ResolvedSkill[] = [];
  if (opts.personaName !== undefined && opts.personaName !== 'global') {
    try {
      const branded = createPersonaName(opts.personaName);
      personaSkills = discoverSkills(getPersonaSkillsDir(branded), 'persona');
    } catch {
      /* invalid slug; skip persona layer */
    }
  }

  const workflowSkills = opts.workflowSkillsDir ? discoverSkills(opts.workflowSkillsDir, 'workflow') : [];

  const merged = new Map<string, ResolvedSkill>();
  for (const skill of userSkills) merged.set(skill.name, skill);
  for (const skill of personaSkills) merged.set(skill.name, skill);
  for (const skill of workflowSkills) merged.set(skill.name, skill);
  return [...merged.values()];
}
