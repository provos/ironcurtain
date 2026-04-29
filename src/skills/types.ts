/**
 * Types shared across the skills capability.
 *
 * A "skill" is a directory containing a `SKILL.md` file with YAML
 * frontmatter (`name`, `description`) and a markdown body, plus any
 * supporting files. The format is the open standard adopted by Claude
 * Code, Goose, Codex, and others; see docs/designs/skills-capability.md
 * for the layering and discovery convention used here.
 */

/**
 * Parsed `SKILL.md` frontmatter. The two required fields are `name` and
 * `description`. Extra keys are preserved for forward compatibility with
 * adapter-specific extensions (e.g., a future Codex `agents/openai.yaml`
 * mirror) but ignored at this layer.
 */
export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly [extra: string]: unknown;
}

/**
 * Origin of a resolved skill. Determines layering precedence in
 * `resolveSkillsForSession`: workflow-bundled skills win over persona
 * skills, which win over user-global skills.
 */
export type SkillSource = 'user' | 'persona' | 'workflow';

/**
 * A single skill resolved against a layer. The `name` is taken from the
 * frontmatter — not from the directory name — and serves as the
 * collision key during layered resolution. `sourceDir` is the absolute
 * host path to the skill's directory; `stageSkillsToBundle` copies
 * everything under it into the merged staging tree.
 */
export interface ResolvedSkill {
  readonly name: string;
  readonly source: SkillSource;
  readonly sourceDir: string;
  readonly description: string;
}
