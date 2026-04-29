/**
 * Skill discovery and layered resolution.
 *
 * Scans a skills root for `<name>/SKILL.md` files, parses YAML
 * frontmatter, and merges across the three layers (user-global,
 * persona, workflow) with last-wins semantics.
 *
 * Path conventions:
 *   user-global: ~/.ironcurtain/skills/<name>/
 *   persona:     ~/.ironcurtain/personas/<persona>/skills/<name>/
 *   workflow:    <workflow-pkg>/skills/<name>/
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { getUserSkillsDir } from '../config/paths.js';
import { getPersonaSkillsDir } from '../persona/resolve.js';
import { createPersonaName } from '../persona/types.js';
import type { ResolvedSkill, SkillFrontmatter, SkillSource } from './types.js';

/**
 * Frontmatter delimiter used by the SKILL.md format. We accept the
 * standard `---` fences with optional trailing whitespace; everything
 * outside the first `---`...`---` block is the markdown body and not
 * relevant here.
 */
const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

/**
 * Parses the YAML frontmatter from a SKILL.md body. Returns `undefined`
 * when the file has no fenced frontmatter, when the YAML fails to parse,
 * when the parsed value is not an object, or when `name`/`description`
 * are missing or non-string. We swallow errors silently rather than
 * throwing because a malformed skill should not break the rest of the
 * skill set; downstream callers see only the well-formed entries.
 */
function parseFrontmatter(content: string): SkillFrontmatter | undefined {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return undefined;

  let parsed: unknown;
  try {
    // maxAliasCount: 0 mirrors the alias-bomb hardening in
    // src/workflow/discovery.ts:50 — skills are admin-supplied content
    // but the same defense is cheap and uniform across the project.
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
 * Scans a skills root directory for valid skills and returns them tagged
 * with `source`. Each entry must be a subdirectory containing a
 * `SKILL.md` with parseable frontmatter; subdirectories without a
 * SKILL.md, with an unparseable SKILL.md, or with frontmatter missing
 * the required `name`/`description` fields are skipped silently.
 *
 * Returns `[]` for missing roots so callers can compose layers without
 * pre-checking each layer's existence.
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

/**
 * Inputs for `resolveSkillsForSession`. All fields are optional; the
 * resolver returns whichever layers are present.
 */
export interface ResolveSkillsOptions {
  /** Persona slug. When set, the persona's skills/ subdir is layered in. */
  readonly personaName?: string;
  /** Absolute path to the workflow package's skills dir, when present. */
  readonly workflowSkillsDir?: string;
}

/**
 * Composes the three skill layers into a single deduplicated list,
 * applying last-wins semantics on `name` collisions. The order
 * (user → persona → workflow) is intentional: workflow-bundled skills
 * are the most specific, persona skills override user defaults for that
 * persona, and user-global skills are the broadest fallback.
 *
 * Persona resolution is deliberately tolerant: an invalid persona name
 * produces an empty persona layer rather than throwing, mirroring
 * `personaExists()` in `persona/resolve.ts`. The persona layer is also
 * skipped when `personaName === 'global'` — that sentinel string is
 * used by workflow definitions to mean "no persona" (see
 * `vuln-discovery.yaml` `persona: global`).
 */
export function resolveSkillsForSession(opts: ResolveSkillsOptions): ResolvedSkill[] {
  const userSkills = discoverSkills(getUserSkillsDir(), 'user');

  let personaSkills: ResolvedSkill[] = [];
  if (opts.personaName !== undefined && opts.personaName !== 'global') {
    try {
      const branded = createPersonaName(opts.personaName);
      personaSkills = discoverSkills(getPersonaSkillsDir(branded), 'persona');
    } catch {
      // Invalid persona slug: silently skip. The orchestrator
      // independently validates persona existence; a bad name here is
      // not a fatal error for skill resolution.
    }
  }

  const workflowSkills = opts.workflowSkillsDir ? discoverSkills(opts.workflowSkillsDir, 'workflow') : [];

  const merged = new Map<string, ResolvedSkill>();
  for (const skill of userSkills) merged.set(skill.name, skill);
  for (const skill of personaSkills) merged.set(skill.name, skill);
  for (const skill of workflowSkills) merged.set(skill.name, skill);
  return [...merged.values()];
}
