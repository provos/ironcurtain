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
 * - `duplicate-name`: two or more skill directories under the same
 *   skills root resolve to the same frontmatter `name`. Composition is
 *   keyed on the frontmatter name, so duplicates are non-deterministic
 *   without a tiebreaker. Reported once per losing entry; the winner
 *   (lexicographically-first directory name) is yielded as a normal
 *   `ResolvedSkill`.
 */
export type SkillDiscoveryErrorReason =
  | 'missing-manifest'
  | 'unreadable'
  | 'malformed-frontmatter'
  | 'missing-required-fields'
  | 'duplicate-name';

export interface SkillDiscoveryError {
  /** Absolute path to the offending directory under the skills root. */
  readonly skillDir: string;
  readonly reason: SkillDiscoveryErrorReason;
  /** Optional extra context (e.g., the YAML parse error message). */
  readonly detail?: string;
}
