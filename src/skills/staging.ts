import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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
 * Rejects skill names whose `resolve(destDir, name)` would either
 * overlay the staging root (`''`, `.`), escape it (`..`), or nest
 * beneath it (`/`, `\\`) — the container's one-level walk only sees
 * `<root>/<name>/SKILL.md`. Throws on rejection.
 */
export function validateSkillName(name: string): void {
  if (name === '') {
    throw new Error('Invalid skill name: name is empty');
  }
  if (name === '.' || name === '..') {
    throw new Error(`Invalid skill name: "${name}" is not a valid directory name`);
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid skill name: "${name}" contains a path separator`);
  }
}

/**
 * Replaces the contents of `destDir` with the resolved set: each skill
 * is copied to `<destDir>/<skill.name>/`. Skill names are validated by
 * {@link validateSkillName}.
 *
 * Wipes children individually rather than the parent itself. Workflow
 * bundles bind-mount this directory into a long-lived container; on
 * Linux a bind mount pins the source's inode at mount time, so removing
 * and recreating the parent dir leaves the container's mount pointing
 * at the freed (now-empty) inode. Per-child cleanup keeps the parent
 * inode stable across re-stages.
 */
export function stageSkillsToBundle(skills: readonly ResolvedSkill[], destDir: string): void {
  const normalizedDestDir = resolve(destDir);
  mkdirSync(normalizedDestDir, { recursive: true });
  for (const entry of readdirSync(normalizedDestDir)) {
    rmSync(resolve(normalizedDestDir, entry), { recursive: true, force: true });
  }

  for (const skill of skills) {
    validateSkillName(skill.name);
    const target = resolve(normalizedDestDir, skill.name);
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
