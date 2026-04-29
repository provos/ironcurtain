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
  /**
   * When set, only workflow-package skills whose `name` is in this set
   * are layered in. User-global and persona layers are unaffected. Used
   * by per-state `skills:` filtering in workflow definitions.
   *
   * Distinguishes two cases at the resolver level: undefined means "no
   * filter, take everything"; an empty set means "exclude all
   * workflow-package skills". Both are valid; the orchestrator builds
   * the set from `AgentStateDefinition.skills` and only passes it when
   * that field is present.
   */
  readonly workflowSkillFilter?: ReadonlySet<string>;
}

/**
 * Composes user → persona → workflow with last-wins on `name` collision.
 *
 * Persona layer is skipped in two cases: `personaName === 'global'` (the
 * workflow-definition sentinel for "no persona"), and whenever
 * `workflowSkillsDir` is set — workflow sessions opt out of persona-as-
 * skill-source entirely, since persona-as-mode-of-user does not fit a
 * machine-driven workflow context. An invalid slug is also skipped (the
 * orchestrator validates persona existence independently).
 *
 * `workflowSkillFilter`, when provided, restricts the workflow layer to
 * entries whose `name` is in the set; an undefined filter means take
 * every workflow-package skill.
 */
export function resolveSkillsForSession(opts: ResolveSkillsOptions): ResolvedSkill[] {
  const userSkills = discoverSkills(getUserSkillsDir(), 'user');

  // Workflow mode: persona-as-skill-source is intentionally inert.
  const inWorkflow = opts.workflowSkillsDir !== undefined;
  let personaSkills: ResolvedSkill[] = [];
  if (!inWorkflow && opts.personaName !== undefined && opts.personaName !== 'global') {
    try {
      const branded = createPersonaName(opts.personaName);
      personaSkills = discoverSkills(getPersonaSkillsDir(branded), 'persona');
    } catch {
      /* invalid slug; skip persona layer */
    }
  }

  let workflowSkills = opts.workflowSkillsDir ? discoverSkills(opts.workflowSkillsDir, 'workflow') : [];
  const filter = opts.workflowSkillFilter;
  if (filter !== undefined) {
    workflowSkills = workflowSkills.filter((s) => filter.has(s.name));
  }

  const merged = new Map<string, ResolvedSkill>();
  for (const skill of userSkills) merged.set(skill.name, skill);
  for (const skill of personaSkills) merged.set(skill.name, skill);
  for (const skill of workflowSkills) merged.set(skill.name, skill);
  return [...merged.values()];
}
