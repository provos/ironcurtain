/**
 * Stages a resolved skill set into a single host-side directory that
 * is then bind-mounted read-only into the agent container at
 * `/home/codespace/.agents/skills/`. Skills are copied recursively so
 * supporting files (helper scripts, fixtures, embedded markdown) travel
 * with their `SKILL.md`.
 *
 * Idempotent: the destination is wiped and rebuilt on every call, so
 * re-staging after a layer change always produces the exact resolved
 * set without leaving stale entries from a previous run.
 */

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ResolvedSkill } from './types.js';

/**
 * Wipes `destDir` and copies each resolved skill into
 * `<destDir>/<skill.name>/`. Each skill name must result in a
 * destination path that stays inside `destDir` — this rejects
 * traversal-style names like `../evil` or absolute paths. The same
 * containment check pattern is used at
 * `src/docker/docker-infrastructure.ts:917-923` for seeded conversation
 * state files.
 */
export function stageSkillsToBundle(skills: readonly ResolvedSkill[], destDir: string): void {
  const normalizedDestDir = resolve(destDir);

  // Wipe-and-rebuild keeps the staging dir in lockstep with the
  // resolved set without per-entry diffing. This is the same pattern
  // used by other bundle-relative staging in IronCurtain (e.g.,
  // orientation files written fresh on every prepare).
  rmSync(normalizedDestDir, { recursive: true, force: true });
  mkdirSync(normalizedDestDir, { recursive: true });

  for (const skill of skills) {
    const target = resolve(normalizedDestDir, skill.name);
    // Containment guard: reject any skill name that would escape the
    // staging dir. resolve() collapses `..` segments and absolute
    // paths, so the prefix check catches both forms.
    if (!target.startsWith(normalizedDestDir + '/') && target !== normalizedDestDir) {
      throw new Error(`Skill name escapes staging directory: ${skill.name}`);
    }
    cpSync(skill.sourceDir, target, { recursive: true });
  }
}
