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
