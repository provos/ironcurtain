/**
 * Container path for the read-only skills bind mount. Cross-vendor
 * common path used by Claude Code, Goose, and Codex for SKILL.md
 * discovery.
 */
export const CONTAINER_SKILLS_DIR = '/home/codespace/.agents/skills';

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly [extra: string]: unknown;
}

/** Layer of origin; determines precedence in `resolveSkillsForSession` (workflow > persona > user). */
export type SkillSource = 'user' | 'persona' | 'workflow';

export interface ResolvedSkill {
  /** From the frontmatter — not the directory name; collision key during layering. */
  readonly name: string;
  readonly source: SkillSource;
  /** Absolute host path; copied recursively by `stageSkillsToBundle`. */
  readonly sourceDir: string;
  readonly description: string;
}

/**
 * Why a candidate skill directory could not be resolved into a
 * `ResolvedSkill`. Surfaced through `discoverSkillsWithErrors` so
 * runtime sessions and the workflow lint surface can give authors
 * actionable feedback instead of a silently-empty skills set.
 *
 * - `missing-manifest`: directory has no `SKILL.md`. Often legitimate
 *   (e.g., a `node_modules/` or `.git/` subdir under the skills root),
 *   so the runtime wrapper does NOT log this — only consumers that
 *   walked a known skills tree (e.g., a workflow package) should
 *   surface it as a warning.
 * - `unreadable`: `readFileSync` failed (permission error, etc.).
 * - `malformed-frontmatter`: the `---` fence is missing, or the YAML
 *   between fences failed to parse, or the parsed value isn't an object.
 * - `missing-required-fields`: frontmatter parsed but `name` or
 *   `description` is missing or non-string.
 */
export type SkillDiscoveryErrorReason =
  | 'missing-manifest'
  | 'unreadable'
  | 'malformed-frontmatter'
  | 'missing-required-fields';

export interface SkillDiscoveryError {
  /** Absolute path to the offending directory under the skills root. */
  readonly skillDir: string;
  readonly reason: SkillDiscoveryErrorReason;
  /** Optional extra context (e.g., the YAML parse error message). */
  readonly detail?: string;
}
