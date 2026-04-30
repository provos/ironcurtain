import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { getUserSkillsDir } from '../config/paths.js';
import * as logger from '../logger.js';
import { getPersonaSkillsDir } from '../persona/resolve.js';
import { createPersonaName } from '../persona/types.js';
import { errorMessage } from '../utils/error-message.js';
import type {
  ResolvedSkill,
  SkillDiscoveryError,
  SkillDiscoveryErrorReason,
  SkillFrontmatter,
  SkillSource,
} from './types.js';

/** Standard SKILL.md fence: `---\n…\n---\n`. Body after the second fence is ignored here. */
const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

/**
 * Parses SKILL.md frontmatter and returns either the typed value or a
 * structured reason for failure so callers can distinguish "no fence" /
 * "bad YAML" / "wrong shape" / "missing required fields" without
 * re-running the parse.
 */
type FrontmatterResult =
  | { ok: true; frontmatter: SkillFrontmatter }
  | { ok: false; reason: 'malformed-frontmatter' | 'missing-required-fields'; detail?: string };

function parseFrontmatter(content: string): FrontmatterResult {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { ok: false, reason: 'malformed-frontmatter', detail: 'missing or malformed `---` fence' };
  }

  let parsed: unknown;
  try {
    // maxAliasCount: 0 hardens against YAML alias-bomb DoS.
    parsed = YAML.parse(match[1], { maxAliasCount: 0 });
  } catch (err) {
    return { ok: false, reason: 'malformed-frontmatter', detail: `YAML parse error: ${errorMessage(err)}` };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed-frontmatter', detail: 'frontmatter is not a YAML mapping' };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== 'string' || typeof obj.description !== 'string') {
    return {
      ok: false,
      reason: 'missing-required-fields',
      detail: 'SKILL.md frontmatter must define string `name:` and `description:` fields',
    };
  }
  return { ok: true, frontmatter: obj as SkillFrontmatter };
}

/** Discovery outcome with error provenance for surfacing to authors. */
export interface DiscoverSkillsResult {
  readonly skills: ResolvedSkill[];
  readonly errors: SkillDiscoveryError[];
}

/**
 * Walks `<skillsRoot>/<dir>/SKILL.md` and returns one entry per valid
 * skill plus a structured error per offending directory. Always
 * tolerates I/O failures so one bad skill doesn't break the rest of
 * the layer; the `errors` array lets callers (runtime sessions, lint)
 * decide how loudly to complain.
 */
export function discoverSkillsWithErrors(skillsRoot: string, source: SkillSource): DiscoverSkillsResult {
  const skills: ResolvedSkill[] = [];
  const errors: SkillDiscoveryError[] = [];

  let entries: string[];
  try {
    entries = readdirSync(skillsRoot);
  } catch {
    // The root is missing or unreadable — treat as empty rather than throwing.
    // No per-entry detail to report; this is a coarse "skills layer
    // unavailable" signal that callers can detect via the empty result.
    return { skills, errors };
  }

  for (const entry of entries) {
    const skillDir = resolve(skillsRoot, entry);
    let stats;
    try {
      stats = statSync(skillDir);
    } catch (err) {
      errors.push({
        skillDir,
        reason: 'unreadable',
        detail: errorMessage(err),
      });
      continue;
    }
    if (!stats.isDirectory()) continue;

    const skillFile = resolve(skillDir, 'SKILL.md');
    let content: string;
    try {
      content = readFileSync(skillFile, 'utf-8');
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        errors.push({ skillDir, reason: 'missing-manifest' });
      } else {
        errors.push({ skillDir, reason: 'unreadable', detail: errorMessage(err) });
      }
      continue;
    }

    const result = parseFrontmatter(content);
    if (!result.ok) {
      errors.push({ skillDir, reason: result.reason, detail: result.detail });
      continue;
    }

    skills.push({
      name: result.frontmatter.name,
      source,
      sourceDir: skillDir,
      description: result.frontmatter.description,
    });
  }

  return { skills, errors };
}

/**
 * Discovery error reasons that warrant surfacing to humans (runtime
 * warnings + lint diagnostics). `missing-manifest` is intentionally
 * excluded: a skills root may legitimately contain helper subdirs
 * (`.git/`, `node_modules/`, READMEs) that have no SKILL.md, and
 * flagging each would drown the actionable signal in noise.
 */
export const ACTIONABLE_DISCOVERY_REASONS: ReadonlySet<SkillDiscoveryErrorReason> = new Set([
  'unreadable',
  'malformed-frontmatter',
  'missing-required-fields',
]);

/**
 * Logging wrapper around `discoverSkillsWithErrors` for runtime call
 * sites. Use the underlying function directly when structured access
 * to discovery errors is required (e.g., the lint surface).
 */
export function discoverSkills(skillsRoot: string, source: SkillSource): ResolvedSkill[] {
  const { skills, errors } = discoverSkillsWithErrors(skillsRoot, source);
  for (const err of errors) {
    if (!ACTIONABLE_DISCOVERY_REASONS.has(err.reason)) continue;
    const detail = err.detail ? `: ${err.detail}` : '';
    logger.warn(`[skills] Ignoring ${source} skill at ${err.skillDir} (${err.reason})${detail}`);
  }
  return skills;
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
