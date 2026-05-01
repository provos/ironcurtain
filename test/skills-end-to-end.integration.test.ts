/**
 * End-to-end test for the skills capability + per-state `skills:` filter
 * + workflow-mode persona-skills opt-out.
 *
 * Exercises:
 *   - real WorkflowOrchestrator (start, transitions, executeAgentState)
 *   - real `validateWorkflowSkillReferences` at workflow load
 *   - real `resolveSkillsForSession` (user → workflow layering with filter)
 *   - real `stageSkillsToBundle` (the host-side staging operation a
 *     container observes through the adapter-specific read-only skills
 *     bind mount — for Claude Code, a dedicated sibling mount at
 *     `/home/codespace/skills/.claude/skills` paired with
 *     `--add-dir /home/codespace/skills`)
 *
 * Approach: option (3) from the design — skip Docker exec entirely and
 * inspect the host-side `bundle.skillsMount.hostDir` directly between state
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

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REAL_TMP, testCompiledPolicy, testToolAnnotations } from './fixtures/test-policy.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../src/workflow/orchestrator.js';
import type { WorkflowDefinition } from '../src/workflow/types.js';
import {
  createDockerInfrastructure,
  destroyDockerInfrastructure,
  type DockerInfrastructure,
} from '../src/docker/docker-infrastructure.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import { useTcpTransport } from '../src/docker/platform.js';
import { isDockerAvailable, isDockerImageAvailable } from './helpers/docker-available.js';
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
 * on-disk staging dir. `restageSkills` performs the actual host-side
 * staging operation a container would observe through its bind mount.
 */
function makeBundleStub(workflowId: string, bundleId: BundleId, bundleDir: string): DockerInfrastructure {
  const skillsDir = resolve(bundleDir, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  return {
    bundleId,
    workflowId,
    bundleDir,
    skillsMount: { hostDir: skillsDir, target: '/home/codespace/skills/.claude/skills' },
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
      if (bundle?.skillsMount) {
        const skills = resolveSkillsForSession({
          ...(options.persona ? { personaName: options.persona } : {}),
          ...(options.workflowSkillsDir ? { workflowSkillsDir: options.workflowSkillsDir } : {}),
          ...(options.workflowSkillFilter ? { workflowSkillFilter: options.workflowSkillFilter } : {}),
        });
        bundle.restageSkills(skills);
        snapshots.push(snapshotStagedSet(stateId, bundle.skillsMount.hostDir));
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

// ---------------------------------------------------------------------------
// Real-Docker variant: same workflow + per-state filter, but the bundle is a
// real `DockerInfrastructure` produced by `createDockerInfrastructure`. Skill
// staging is asserted from INSIDE the running container via `docker exec` so
// the bind mount, image, and container-level visibility of the staged tree
// are all exercised.
//
// Linux/UDS-only by design (matches `pty-entrypoint.integration.test.ts`):
// macOS PTY mode reaches MITM via a socat sidecar through TCP transport,
// which is irrelevant to skills staging but adds ~30s of sidecar bring-up
// per state and a different mount path. We skip there to keep the test
// focused on the bind-mount contract that's identical across modes.
// ---------------------------------------------------------------------------

const IMAGE = 'ironcurtain-claude-code:latest';

/**
 * Locates the CA dir the running `ironcurtain-claude-code:latest` image
 * was built from. The image's content-hash label includes the CA cert,
 * so reusing the developer's CA avoids a multi-minute rebuild on first
 * run. Read BEFORE any test overrides `IRONCURTAIN_HOME` so we point at
 * the real CA, not the temp sandbox.
 */
function findHostCaDir(): string | null {
  const home = process.env.IRONCURTAIN_HOME ?? join(homedir(), '.ironcurtain');
  const ca = join(home, 'ca');
  return existsSync(ca) ? ca : null;
}

const hostCaDir = findHostCaDir();
const dockerReady = !useTcpTransport() && isDockerAvailable() && isDockerImageAvailable(IMAGE) && hostCaDir !== null;

interface ContainerStagingSnapshot {
  readonly stateId: string;
  /** name -> sha256 of `SKILL.md` as observed inside the container. */
  readonly hashes: Readonly<Record<string, string>>;
}

/**
 * Enumerates `<adapter.skillsContainerPath>/<name>/SKILL.md` files
 * inside the container and computes their sha256 hashes via
 * `sha256sum`. Output of `sha256sum` is `<hash>  ./<name>/SKILL.md` per
 * line, sorted for determinism. Returns a `{ name → hash }` map keyed
 * on the basename of the skill directory.
 */
async function snapshotContainerSkills(
  bundle: DockerInfrastructure,
  stateId: string,
): Promise<ContainerStagingSnapshot> {
  const skillsPath = bundle.adapter.skillsContainerPath;
  if (!skillsPath) {
    throw new Error(`adapter ${bundle.adapter.id} declares no skillsContainerPath; cannot snapshot skills`);
  }
  const result = await bundle.docker.exec(
    bundle.containerId,
    [
      'sh',
      '-c',
      // `ls -la` prefix is purely diagnostic — when the bind mount
      // appears stale (kernel held an old inode after rmSync+mkdirSync
      // on the host source) the listing routes to stderr so a post-
      // mortem can see the empty directory rather than guessing at a
      // possible sha256sum / xargs misuse. The pipeline after `&&` is
      // what produces the snapshot output we parse.
      `ls -la ${skillsPath}/ 1>&2; ` +
        `cd ${skillsPath} && find . -mindepth 2 -maxdepth 2 -name SKILL.md -print0 | xargs -0 sha256sum 2>/dev/null | sort`,
    ],
    15_000,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `docker exec for snapshot (state=${stateId}) failed (exit=${result.exitCode}, stderr=${result.stderr.slice(0, 500)})`,
    );
  }
  const hashes: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    // Format: "<hash>  ./<name>/SKILL.md" (two spaces from sha256sum).
    const match = line.match(/^([0-9a-f]+)\s+\.\/([^/]+)\/SKILL\.md$/);
    if (!match) continue;
    hashes[match[2]] = match[1];
  }
  return { stateId, hashes };
}

/**
 * Synthesizes a minimal `IronCurtainConfig` for a real-Docker bundle.
 * Mirrors `pty-entrypoint.integration.test.ts`'s inline config: empty
 * `mcpServers` (no policy-driven server spawn happens because the test
 * never makes a tool call), policy/annotations from the test fixtures
 * dropped under `<TEST_HOME>/generated/` so `loadConfig()` finds them.
 */
function buildDockerSessionConfig(workspaceDir: string, generatedDir: string): IronCurtainConfig {
  return {
    auditLogPath: join(workspaceDir, 'audit.jsonl'),
    allowedDirectory: workspaceDir,
    mcpServers: {},
    protectedPaths: [],
    generatedDir,
    constitutionPath: join(generatedDir, 'constitution.md'),
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: 'test-fake-key-no-network',
      googleApiKey: '',
      openaiApiKey: '',
      escalationTimeoutSeconds: 300,
      resourceBudget: {
        maxTotalTokens: 1_000_000,
        maxSteps: 200,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      autoCompact: {
        enabled: false,
        thresholdTokens: 80_000,
        keepRecentMessages: 10,
        summaryModelId: 'anthropic:claude-haiku-4-5',
      },
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: false },
      memory: { enabled: false, llmBaseUrl: undefined, llmApiKey: undefined },
      packageInstall: {
        enabled: false,
        quarantineDays: 2,
        allowedPackages: [],
        deniedPackages: [],
      },
      serverCredentials: {},
    },
  } as unknown as IronCurtainConfig;
}

describe.skipIf(!dockerReady)('skills end-to-end with real Docker container', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalAuth: string | undefined;
  let originalApiKey: string | undefined;
  // Bundles minted during the test, tracked so afterAll can guarantee
  // teardown even if the workflow errored mid-flight before its normal
  // destroy path ran.
  const liveBundles = new Set<DockerInfrastructure>();

  beforeAll(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    originalAuth = process.env.IRONCURTAIN_DOCKER_AUTH;
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    // Force API-key auth so detectAuthMethod doesn't read host OAuth state.
    process.env.IRONCURTAIN_DOCKER_AUTH = 'apikey';
    // Fake key is fine: the test never runs an agent CLI, so MITM never
    // attempts an upstream forward and never reads the real key.
    process.env.ANTHROPIC_API_KEY = 'test-fake-key-no-network';

    process.env.IRONCURTAIN_HOME = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });

    // Reuse the host CA so the prebuilt image's content-hash matches and
    // we skip the rebuild. `hostCaDir` is non-null here because we gated
    // `dockerReady` on it.
    cpSync(hostCaDir as string, join(TEST_HOME, 'ca'), { recursive: true });
  });

  afterAll(async () => {
    // Defensive teardown: any bundle whose workflow errored before
    // reaching the orchestrator's normal destroy path is cleaned up here.
    for (const bundle of liveBundles) {
      await destroyDockerInfrastructure(bundle).catch(() => {});
    }
    liveBundles.clear();

    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    if (originalAuth === undefined) delete process.env.IRONCURTAIN_DOCKER_AUTH;
    else process.env.IRONCURTAIN_DOCKER_AUTH = originalAuth;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;

    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skills-docker-e2e-'));
    // User-global skills under TEST_HOME (set in beforeAll). Re-create
    // each test so per-test state is independent.
    const userSkills = resolve(TEST_HOME, 'skills');
    rmSync(userSkills, { recursive: true, force: true });
    writeSkill(userSkills, 'generic', { name: 'generic', description: 'shared utility', from: 'user-global' });
    writeSkill(userSkills, 'overload', { name: 'overload', description: 'user version', from: 'user-global' });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stages user-global + per-state-filtered workflow skills inside a real container', async () => {
    const packageDir = resolve(tmpDir, 'wf-pkg');
    const runDir = resolve(tmpDir, 'run');
    const workspaceDir = resolve(tmpDir, 'workspace');
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    const manifestPath = setupWorkflowPackage(packageDir);

    // Drop policy + tool annotations under TEST_HOME/generated/ so
    // loadConfig() (called by the orchestrator's getRequiredServersForScope
    // → resolvePersonaPolicyDir) finds them in the user-local layer.
    const userGeneratedDir = resolve(TEST_HOME, 'generated');
    mkdirSync(userGeneratedDir, { recursive: true });
    writeFileSync(resolve(userGeneratedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(userGeneratedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));

    const snapshots: ContainerStagingSnapshot[] = [];

    // The real factory: builds a synthetic config and hands it to
    // `createDockerInfrastructure`, which spawns the actual container
    // with the skills bind mount attached. Tracking the produced bundle
    // in `liveBundles` lets afterAll clean up if the workflow errors
    // before the orchestrator's normal destroy path runs.
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      const config = buildDockerSessionConfig(input.workspacePath, userGeneratedDir);
      const bundleDir = resolve(TEST_HOME, 'bundles', input.bundleId);
      const escalationDir = resolve(bundleDir, 'escalations');
      mkdirSync(bundleDir, { recursive: true });
      mkdirSync(escalationDir, { recursive: true });
      const bundle = await createDockerInfrastructure(
        config,
        { kind: 'docker', agent: 'claude-code' },
        bundleDir,
        input.workspacePath,
        escalationDir,
        input.bundleId,
        input.workflowId,
        input.scope,
        input.resolvedSkills,
      );
      liveBundles.add(bundle);
      return bundle;
    });

    const destroyInfra = vi.fn(async (bundle: DockerInfrastructure) => {
      liveBundles.delete(bundle);
      await destroyDockerInfrastructure(bundle);
    });

    const stateOutputs: Record<string, string> = { a: 'a_out', b: 'b_out', c: 'c_out' };

    // Mock `createSession`: replicates the borrow-mode skill-restage
    // side effect of `buildSessionConfig`, then snapshots the container's
    // view of the staged tree via `docker exec`. Returns a MockSession
    // that emits an approved status and writes the state's declared
    // output artifact so the orchestrator can transition to the next
    // state without invoking the real agent CLI.
    const createSessionFake = async (options: SessionOptions): Promise<MockSession> => {
      const bundle = options.workflowInfrastructure;
      const stateId = options.stateSlug?.split('.')[0] ?? 'unknown';
      if (bundle?.skillsMount) {
        const skills = resolveSkillsForSession({
          ...(options.persona ? { personaName: options.persona } : {}),
          ...(options.workflowSkillsDir ? { workflowSkillsDir: options.workflowSkillsDir } : {}),
          ...(options.workflowSkillFilter ? { workflowSkillFilter: options.workflowSkillFilter } : {}),
        });
        bundle.restageSkills(skills);
        // Bind mount is live; snapshot from the container side now.
        snapshots.push(await snapshotContainerSkills(bundle, stateId));
      }
      return new MockSession({
        responses: () => {
          const outName = stateOutputs[stateId];
          if (outName) {
            // Artifact path: `<workspacePath>/.workflow/<name>/<name>.md`.
            // This is exactly the layout the orchestrator's
            // `findMissingArtifacts` looks at after the agent returns
            // (instance.artifactDir = workspaceDir/.workflow). Bypass
            // `simulateArtifacts` here because that helper assumes
            // workspacePath defaults to `<runDir>/<workflowId>/workspace/`
            // and we override workspacePath out of `runDir` entirely.
            const artDir = resolve(workspaceDir, '.workflow', outName);
            mkdirSync(artDir, { recursive: true });
            writeFileSync(resolve(artDir, `${outName}.md`), `content for ${outName}`);
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

    const workflowId = await orchestrator.start(manifestPath, 'task', workspaceDir);
    // Real Docker plus three state transitions: 60s budget. The actual
    // observed time is dominated by the initial container start (~5s)
    // plus one `docker exec` per state for the snapshot (~1s each).
    await waitForCompletion(orchestrator, workflowId, 60_000);

    // Three agent invocations: one per state, in order.
    expect(snapshots.map((s) => s.stateId)).toEqual(['a', 'b', 'c']);

    const a = snapshots[0];
    const b = snapshots[1];
    const c = snapshots[2];

    // ---- Skill-set assertions (presence inside the container).
    expect(Object.keys(a.hashes).sort()).toEqual(['b_specific', 'c_specific', 'generic', 'overload']);
    expect(Object.keys(b.hashes).sort()).toEqual(['b_specific', 'generic', 'overload']);
    expect(Object.keys(c.hashes).sort()).toEqual(['c_specific', 'generic', 'overload']);

    // ---- Layer-origin assertions via SKILL.md content hash.
    // bind-mount is byte-identical to the host skills dir (cpSync copies
    // file contents verbatim), so the in-container sha256sum output
    // must match a host-side hash of the source SKILL.md.
    const userOverloadHash = hashSkillManifest(resolve(TEST_HOME, 'skills', 'overload'));
    const workflowOverloadHash = hashSkillManifest(resolve(packageDir, 'skills', 'overload'));
    expect(userOverloadHash).not.toEqual(workflowOverloadHash);

    // States A and B see the workflow's overload (workflow > user precedence).
    expect(a.hashes['overload']).toBe(workflowOverloadHash);
    expect(b.hashes['overload']).toBe(workflowOverloadHash);

    // State C's `skills: [c_specific]` filter excludes the workflow's
    // overload, so the user-global one wins by default.
    expect(c.hashes['overload']).toBe(userOverloadHash);
  }, 180_000);
});
