import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ResolvedSkill } from './types.js';

/** Stable signature for change-detection in `createCachedStager`. */
function computeSignature(skills: readonly ResolvedSkill[]): string {
  return skills
    .map((s) => `${s.name}\0${s.sourceDir}`)
    .sort()
    .join('\n');
}

/**
 * Wipes `destDir` and copies each resolved skill into
 * `<destDir>/<skill.name>/`. Skill names that resolve outside `destDir`
 * (`..` or absolute paths) are rejected.
 */
export function stageSkillsToBundle(skills: readonly ResolvedSkill[], destDir: string): void {
  const normalizedDestDir = resolve(destDir);
  rmSync(normalizedDestDir, { recursive: true, force: true });
  mkdirSync(normalizedDestDir, { recursive: true });

  for (const skill of skills) {
    const target = resolve(normalizedDestDir, skill.name);
    if (!target.startsWith(normalizedDestDir + '/') && target !== normalizedDestDir) {
      throw new Error(`Skill name escapes staging directory: ${skill.name}`);
    }
    cpSync(skill.sourceDir, target, { recursive: true });
  }
}

/**
 * Builds a `stage(skills)` closure pinned to `destDir` that skips the
 * wipe-and-rebuild when the resolved set is byte-identical to the
 * previous call. Used by workflow bundles to keep state-transition
 * latency near-zero when consecutive states resolve to the same skills.
 */
export function createCachedStager(destDir: string): (skills: readonly ResolvedSkill[]) => boolean {
  let lastSignature: string | undefined;
  return (skills) => {
    const signature = computeSignature(skills);
    if (signature === lastSignature) return false;
    stageSkillsToBundle(skills, destDir);
    lastSignature = signature;
    return true;
  };
}
