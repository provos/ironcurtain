/**
 * End-to-end test for the skills capability + per-state `skills:` filter
 * + workflow-mode persona-skills opt-out.
 *
 * Exercises:
 *   - real WorkflowOrchestrator (start, transitions, executeAgentState)
 *   - real `validateWorkflowSkillReferences` at workflow load
 *   - real `resolveSkillsForSession` (user → workflow layering with filter)
 *   - real `stageSkillsToBundle` (the host-side staging operation a
 *     container observes through its `CONTAINER_SKILLS_DIR` bind mount)
 *
 * Approach: option (3) from the design — skip Docker exec entirely and
 * inspect the host-side `bundle.skillsDir` directly between state
 * transitions. The bind mount is a host directory, so its contents ARE
 * what the container would see; testing the host side is sufficient for
 * staging correctness. This keeps the test deterministic, fast, and free
 * of Docker / container-image / OAuth dependencies.
 *
 * The fake `createSession` performs the same skill-resolution + restage
 * sequence that `buildSessionConfig`'s borrow-mode branch performs in
 * production, then snapshots the staged set + content hashes before
 * returning a MockSession that emits an approved status block. The unit
 * coverage that `buildSessionConfig` correctly threads the orchestrator's
 * `workflowSkillFilter` lives in `skills-borrow-restage.test.ts`; this
 * test focuses on the orchestrator-level wiring (per-state options
 * derived from `stateConfig.skills`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { REAL_TMP } from './fixtures/test-policy.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../src/workflow/orchestrator.js';
import type { WorkflowDefinition } from '../src/workflow/types.js';
import type { DockerInfrastructure } from '../src/docker/docker-infrastructure.js';
import type { BundleId, SessionOptions } from '../src/session/types.js';
import { stageSkillsToBundle } from '../src/skills/staging.js';
import { resolveSkillsForSession } from '../src/skills/discovery.js';
import type { ResolvedSkill } from '../src/skills/types.js';
import {
  approvedResponse,
  createDeps,
  findWorkflowDir,
  MockSession,
  simulateArtifacts,
  waitForCompletion,
  writeDefinitionFile,
} from './workflow/test-helpers.js';

const TEST_HOME = `${REAL_TMP}/ironcurtain-skills-e2e-${process.pid}`;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function writeSkill(
  root: string,
  dirName: string,
  frontmatter: { name: string; description: string; from: string },
): void {
  const skillDir = resolve(root, dirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    resolve(skillDir, 'SKILL.md'),
    `---\nname: ${frontmatter.name}\ndescription: "${frontmatter.description}"\nfrom: ${frontmatter.from}\n---\n` +
      `body for ${frontmatter.name} (${frontmatter.from})\n`,
  );
}

/** Hashes a SKILL.md file's contents — used to distinguish layer origins on collision. */
function hashSkillManifest(skillDir: string): string {
  const manifest = readFileSync(resolve(skillDir, 'SKILL.md'), 'utf-8');
  return createHash('sha256').update(manifest).digest('hex');
}

interface StagingSnapshot {
  readonly stateId: string;
  readonly names: readonly string[];
  /** name -> sha256 of the staged SKILL.md (for layer-origin verification on collision). */
  readonly hashes: Readonly<Record<string, string>>;
}

function snapshotStagedSet(stateId: string, skillsDir: string): StagingSnapshot {
  const names = readdirSync(skillsDir).sort();
  const hashes: Record<string, string> = {};
  for (const name of names) {
    hashes[name] = hashSkillManifest(resolve(skillsDir, name));
  }
  return { stateId, names, hashes };
}

/**
 * Builds a real-shape DockerInfrastructure stub backed by a real
 * on-disk `skillsDir`. `restageSkills` performs the actual host-side
 * staging operation a container would observe through its bind mount.
 */
function makeBundleStub(workflowId: string, bundleId: BundleId, bundleDir: string): DockerInfrastructure {
  const skillsDir = resolve(bundleDir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  return {
    bundleId,
    workflowId,
    bundleDir,
    skillsDir,
    workspaceDir: resolve(bundleDir, 'workspace'),
    escalationDir: resolve(bundleDir, 'escalations'),
    auditLogPath: resolve(bundleDir, 'audit.jsonl'),
    setTokenSessionId: () => {},
    restageSkills: (skills: readonly ResolvedSkill[]) => {
      stageSkillsToBundle(skills, skillsDir);
    },
  } as unknown as DockerInfrastructure;
}

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

/**
 * Three sequential agent states a -> b -> c -> done. Persona is
 * `global` everywhere (workflow mode skips persona skills regardless,
 * but global avoids needing persona-on-disk stubs).
 *
 *   - a: no `skills` field        -> all workflow-package skills
 *   - b: `skills: [overload, b_specific]`  -> filtered to two
 *   - c: `skills: [c_specific]`            -> filtered to one
 */
const workflowDef: WorkflowDefinition = {
  name: 'skills-e2e',
  description: 'End-to-end skills staging test',
  initial: 'a',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    a: {
      type: 'agent',
      description: 'State A — no skills filter (default = all)',
      persona: 'global',
      prompt: 'Stage A.',
      inputs: [],
      outputs: ['a_out'],
      transitions: [{ to: 'b' }],
    },
    b: {
      type: 'agent',
      description: 'State B — filtered to overload + b_specific',
      persona: 'global',
      prompt: 'Stage B.',
      inputs: ['a_out'],
      outputs: ['b_out'],
      transitions: [{ to: 'c' }],
      skills: ['overload', 'b_specific'],
    },
    c: {
      type: 'agent',
      description: 'State C — filtered to c_specific only',
      persona: 'global',
      prompt: 'Stage C.',
      inputs: ['b_out'],
      outputs: ['c_out'],
      transitions: [{ to: 'done' }],
      skills: ['c_specific'],
    },
    done: { type: 'terminal', description: 'done' },
  },
};

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function setupHome(): void {
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  mkdirSync(TEST_HOME, { recursive: true });

  // User-global skills.
  const userSkills = resolve(TEST_HOME, 'skills');
  writeSkill(userSkills, 'generic', { name: 'generic', description: 'shared utility', from: 'user-global' });
  writeSkill(userSkills, 'overload', { name: 'overload', description: 'user version', from: 'user-global' });
}

function teardownHome(): void {
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
}

function setupWorkflowPackage(packageDir: string): string {
  // Workflow-package skills.
  const wfSkills = resolve(packageDir, 'skills');
  writeSkill(wfSkills, 'overload', { name: 'overload', description: 'workflow version', from: 'workflow' });
  writeSkill(wfSkills, 'b_specific', { name: 'b_specific', description: 'B only', from: 'workflow b_specific' });
  writeSkill(wfSkills, 'c_specific', { name: 'c_specific', description: 'C only', from: 'workflow c_specific' });

  // Manifest (JSON; orchestrator routes by file extension).
  const manifestPath = resolve(packageDir, 'workflow.json');
  writeFileSync(manifestPath, JSON.stringify(workflowDef, null, 2));
  return manifestPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('skills end-to-end (workflow + per-state filter + persona opt-out)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skills-e2e-'));
    setupHome();
  });

  afterEach(() => {
    teardownHome();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stages user-global + per-state-filtered workflow skills across three states', async () => {
    // Workflow package and orchestrator baseDir live in sibling subdirs
    // so `findWorkflowDir` is unambiguous (only the orchestrator's
    // workflow-instance dir lands under `runDir`).
    const packageDir = resolve(tmpDir, 'wf-pkg');
    const runDir = resolve(tmpDir, 'run');
    const bundlesDir = resolve(tmpDir, 'bundles');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    mkdirSync(bundlesDir, { recursive: true });
    const manifestPath = setupWorkflowPackage(packageDir);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      const bundleDir = resolve(bundlesDir, input.bundleId);
      mkdirSync(bundleDir, { recursive: true });
      const bundle = makeBundleStub(input.workflowId, input.bundleId, bundleDir);
      // Initial mint: stage whatever the orchestrator computed (user +
      // workflow, no filter). Mirrors `createDockerInfrastructure`.
      bundle.restageSkills(input.resolvedSkills ?? []);
      return bundle;
    });

    const destroyInfra = vi.fn(async () => {});

    const snapshots: StagingSnapshot[] = [];

    // Per-state expected artifact (must match `outputs:` in the workflow def).
    const stateOutputs: Record<string, string> = { a: 'a_out', b: 'b_out', c: 'c_out' };

    // Models the borrow-mode side effect of `buildSessionConfig`:
    // re-resolve skills for this state's options and stage them onto
    // the live bundle. The orchestrator-level contract this test
    // verifies is that `workflowSkillsDir` and `workflowSkillFilter`
    // arrive on `options` per-state (derived from `stateConfig.skills`).
    const createSessionFake = async (options: SessionOptions): Promise<MockSession> => {
      const bundle = options.workflowInfrastructure;
      const stateId = options.stateSlug?.split('.')[0] ?? 'unknown';
      if (bundle?.skillsDir) {
        const skills = resolveSkillsForSession({
          ...(options.persona ? { personaName: options.persona } : {}),
          ...(options.workflowSkillsDir ? { workflowSkillsDir: options.workflowSkillsDir } : {}),
          ...(options.workflowSkillFilter ? { workflowSkillFilter: options.workflowSkillFilter } : {}),
        });
        bundle.restageSkills(skills);
        snapshots.push(snapshotStagedSet(stateId, bundle.skillsDir));
      }
      return new MockSession({
        responses: () => {
          // Produce the state's declared output so the orchestrator's
          // post-invocation artifact check passes and the workflow can
          // transition to the next state. `findWorkflowDir(runDir)` is
          // unambiguous because `runDir` only ever contains the
          // orchestrator's `<workflowId>/` instance directory.
          const outName = stateOutputs[stateId];
          if (outName) {
            simulateArtifacts(findWorkflowDir(runDir), [outName]);
          }
          return approvedResponse(`${stateId} done`);
        },
      });
    };

    const orchestrator = new WorkflowOrchestrator(
      createDeps(runDir, {
        createSession: createSessionFake,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );

    const workflowId = await orchestrator.start(manifestPath, 'task');
    await waitForCompletion(orchestrator, workflowId, 15_000);

    // Three agent invocations: one per state.
    expect(snapshots.map((s) => s.stateId)).toEqual(['a', 'b', 'c']);

    // ---- State A: no `skills` filter -> all workflow-package skills + user-global generic.
    const a = snapshots[0];
    expect(a.names.slice().sort()).toEqual(['b_specific', 'c_specific', 'generic', 'overload']);

    // ---- State B: filtered to overload + b_specific (+ user-global generic).
    const b = snapshots[1];
    expect(b.names.slice().sort()).toEqual(['b_specific', 'generic', 'overload']);

    // ---- State C: filtered to c_specific (workflow's overload is filtered
    //      out; user-global's overload survives uncontested).
    const c = snapshots[2];
    expect(c.names.slice().sort()).toEqual(['c_specific', 'generic', 'overload']);

    // ---- Layer-origin assertions via SKILL.md content hash.
    const userOverloadHash = hashSkillManifest(resolve(TEST_HOME, 'skills', 'overload'));
    const workflowOverloadHash = hashSkillManifest(resolve(packageDir, 'skills', 'overload'));
    expect(userOverloadHash).not.toEqual(workflowOverloadHash);

    // States A and B see the workflow's overload (workflow > user).
    expect(a.hashes['overload']).toBe(workflowOverloadHash);
    expect(b.hashes['overload']).toBe(workflowOverloadHash);

    // State C's `skills: [c_specific]` filter excludes the workflow's
    // overload, so the user-global one wins by default.
    expect(c.hashes['overload']).toBe(userOverloadHash);
  });

  it('rejects a workflow whose skills[] entry has no SKILL.md package', async () => {
    const packageDir = resolve(tmpDir, 'wf-pkg-bad');
    mkdirSync(resolve(packageDir, 'skills'), { recursive: true });
    // Note: no `mystery` skill is created on disk.

    const badDef: WorkflowDefinition = {
      name: 'bad-skills',
      description: 'references a skill that does not exist',
      initial: 'a',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
      states: {
        a: {
          type: 'agent',
          description: 'a',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['x'],
          transitions: [{ to: 'done' }],
          skills: ['mystery'],
        },
        done: { type: 'terminal', description: 'done' },
      },
    };
    const manifestPath = writeDefinitionFile(packageDir, badDef);

    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

    // start() runs validation synchronously before the workflow actor
    // is spun up; the WorkflowValidationError should propagate.
    await expect(orchestrator.start(manifestPath, 'task')).rejects.toThrow(/mystery/);
  });
});
