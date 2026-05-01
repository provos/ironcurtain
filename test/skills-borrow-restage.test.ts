/**
 * Tests for borrow-mode skill re-staging in `buildSessionConfig`.
 *
 * Workflow shared-container mode reuses one Docker container across
 * multiple agent states. The skills are exposed inside the container
 * via a dedicated read-only bind mount per adapter (Claude Code:
 * `/home/codespace/skills/.claude/skills` with `--add-dir
 * /home/codespace/skills`; Goose: `/home/codespace/.config/goose/skills/`).
 * The mount is established once at container start. Different states
 * may use different personas — and therefore different skill sets.
 *
 * The orchestrator handles this by calling `buildSessionConfig` for
 * each state with a borrow-mode `workflowInfrastructure`. That branch
 * re-resolves user + persona + workflow skills and re-stages them into
 * the bundle's `skillsDir`. Because the bind mount is live, the
 * container picks up the new contents without remounting.
 *
 * These tests verify the re-staging happens, in lockstep with the
 * resolved set, and that single-session/standalone mode is unaffected.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as loggerModule from '../src/logger.js';
import { TEST_SANDBOX_DIR, REAL_TMP } from './fixtures/test-policy.js';

import { buildSessionConfig } from '../src/session/index.js';
import { createSessionId, type BundleId } from '../src/session/types.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { DockerInfrastructure } from '../src/docker/docker-infrastructure.js';
import { stageSkillsToBundle } from '../src/skills/staging.js';
import type { ResolvedSkill } from '../src/skills/types.js';
import type { AgentId } from '../src/docker/agent-adapter.js';

const TEST_HOME = `${REAL_TMP}/ironcurtain-skills-borrow-test-${process.pid}`;

function createTestConfig(): IronCurtainConfig {
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: TEST_SANDBOX_DIR,
    mcpServers: { filesystem: { command: 'echo', args: ['test'] } },
    protectedPaths: [],
    generatedDir: resolve(TEST_HOME, 'generated'),
    constitutionPath: `${REAL_TMP}/skills-borrow-test-constitution.md`,
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: 'test-api-key',
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
      auditRedaction: { enabled: true },
      memory: { enabled: false, autoSave: false, llmBaseUrl: undefined, llmApiKey: undefined },
    },
  } as unknown as IronCurtainConfig;
}

/** Writes a minimal compiled-policy.json so `loadGeneratedPolicy` succeeds. */
function writeMinimalPolicy(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, 'compiled-policy.json'),
    JSON.stringify({
      rules: [
        {
          name: 'allow-fs',
          description: 'test',
          principle: 'test',
          if: { server: ['filesystem'] },
          then: 'allow',
          reason: 'test',
        },
      ],
    }),
  );
}

/** Writes a SKILL.md package under <root>/<dirName>/. */
function writeSkill(root: string, dirName: string, frontmatter: { name: string; description: string }): void {
  const skillDir = resolve(root, dirName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    resolve(skillDir, 'SKILL.md'),
    `---\nname: ${frontmatter.name}\ndescription: "${frontmatter.description}"\n---\nbody\n`,
  );
}

/** Persona-on-disk helper (no memory opt-out). */
function createTestPersona(name: string): void {
  const personaDir = resolve(TEST_HOME, 'personas', name);
  const generatedDir = resolve(personaDir, 'generated');
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(resolve(personaDir, 'workspace'), { recursive: true });
  writeFileSync(
    resolve(personaDir, 'persona.json'),
    JSON.stringify({ name, description: `Test persona ${name}`, createdAt: '2026-04-27T00:00:00.000Z' }),
  );
  writeMinimalPolicy(generatedDir);
}

function makeFakeBundle(skillsDir: string | undefined, bundleDir: string): DockerInfrastructure {
  return {
    bundleId: 'fake-bundle-id' as BundleId,
    bundleDir,
    workspaceDir: resolve(bundleDir, 'workspace'),
    escalationDir: resolve(bundleDir, 'escalations'),
    auditLogPath: resolve(bundleDir, 'audit.jsonl'),
    ...(skillsDir ? { skillsMount: { hostDir: skillsDir, target: '/home/codespace/skills/.claude/skills' } } : {}),
    setTokenSessionId: () => {},
    restageSkills: (skills: readonly ResolvedSkill[]) => {
      if (skillsDir) stageSkillsToBundle(skills, skillsDir);
    },
  } as unknown as DockerInfrastructure;
}

beforeEach(() => {
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  mkdirSync(resolve(TEST_HOME, 'generated'), { recursive: true });
  writeMinimalPolicy(resolve(TEST_HOME, 'generated'));
});

afterEach(() => {
  loggerModule.teardown();
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('buildSessionConfig — borrow-mode skill re-staging', () => {
  it('re-stages the resolved set into the bundle skillsDir', () => {
    // User-global skill is always layered in.
    const userSkillsRoot = resolve(TEST_HOME, 'skills');
    writeSkill(userSkillsRoot, 'global-tool', { name: 'global-tool', description: 'u' });

    // Workflow-bundled skill: the orchestrator passes the dir in opts.
    const workflowPkg = resolve(TEST_HOME, 'workflow-pkg');
    const workflowSkills = resolve(workflowPkg, 'skills');
    writeSkill(workflowSkills, 'wf-tool', { name: 'wf-tool', description: 'w' });

    // Bundle exists with the bind-mount target already created.
    const bundleDir = resolve(TEST_HOME, 'bundle');
    const skillsDir = resolve(bundleDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bundle = makeFakeBundle(skillsDir, bundleDir);

    const config = createTestConfig();
    const sessionId = createSessionId();

    buildSessionConfig(config, sessionId, sessionId, {
      workflowInfrastructure: bundle,
      workflowSkillsDir: workflowSkills,
    });

    // The merged set was staged into the bundle's skillsDir.
    expect(existsSync(resolve(skillsDir, 'global-tool', 'SKILL.md'))).toBe(true);
    expect(existsSync(resolve(skillsDir, 'wf-tool', 'SKILL.md'))).toBe(true);
  });

  it('skips persona skills in workflow mode (workflowSkillsDir set)', () => {
    // Persona-as-skill-source is intentionally inert in workflow mode —
    // persona-as-mode-of-user does not fit a machine-driven workflow.
    // User and workflow layers still apply.
    const userSkillsRoot = resolve(TEST_HOME, 'skills');
    writeSkill(userSkillsRoot, 'global-tool', { name: 'global-tool', description: 'u' });

    createTestPersona('reviewer');
    const personaSkills = resolve(TEST_HOME, 'personas', 'reviewer', 'skills');
    writeSkill(personaSkills, 'review-tool', { name: 'review-tool', description: 'p' });

    const workflowSkills = resolve(TEST_HOME, 'workflow-pkg', 'skills');
    writeSkill(workflowSkills, 'wf-tool', { name: 'wf-tool', description: 'w' });

    const bundleDir = resolve(TEST_HOME, 'bundle');
    const skillsDir = resolve(bundleDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bundle = makeFakeBundle(skillsDir, bundleDir);

    const config = createTestConfig();
    const sessionId = createSessionId();

    buildSessionConfig(config, sessionId, sessionId, {
      persona: 'reviewer',
      workflowInfrastructure: bundle,
      workflowSkillsDir: workflowSkills,
    });

    // review-tool is absent — persona layer is suppressed in workflow mode.
    const staged = readdirSync(skillsDir).sort();
    expect(staged).toEqual(['global-tool', 'wf-tool']);
  });

  it('layers persona skills on top of user when not in workflow mode', () => {
    // Standalone (non-workflow) borrow: persona skills still apply.
    // workflowSkillsDir is unset, so the workflow-mode opt-out does not
    // engage and the persona layer participates as before.
    const userSkillsRoot = resolve(TEST_HOME, 'skills');
    writeSkill(userSkillsRoot, 'global-tool', { name: 'global-tool', description: 'u' });

    createTestPersona('reviewer');
    const personaSkills = resolve(TEST_HOME, 'personas', 'reviewer', 'skills');
    writeSkill(personaSkills, 'review-tool', { name: 'review-tool', description: 'p' });

    const bundleDir = resolve(TEST_HOME, 'bundle');
    const skillsDir = resolve(bundleDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bundle = makeFakeBundle(skillsDir, bundleDir);

    const config = createTestConfig();
    const sessionId = createSessionId();

    buildSessionConfig(config, sessionId, sessionId, {
      persona: 'reviewer',
      workflowInfrastructure: bundle,
    });

    const staged = readdirSync(skillsDir).sort();
    expect(staged).toEqual(['global-tool', 'review-tool']);
  });

  it('filters workflow skills to the per-state allowlist', () => {
    // workflowSkillFilter is the per-state `skills:` set, plumbed by the
    // orchestrator. User-global skills are unaffected.
    const userSkillsRoot = resolve(TEST_HOME, 'skills');
    writeSkill(userSkillsRoot, 'global-tool', { name: 'global-tool', description: 'u' });

    const workflowSkills = resolve(TEST_HOME, 'workflow-pkg', 'skills');
    writeSkill(workflowSkills, 'wf-keep', { name: 'wf-keep', description: 'k' });
    writeSkill(workflowSkills, 'wf-drop', { name: 'wf-drop', description: 'd' });

    const bundleDir = resolve(TEST_HOME, 'bundle');
    const skillsDir = resolve(bundleDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bundle = makeFakeBundle(skillsDir, bundleDir);

    const config = createTestConfig();
    const sessionId = createSessionId();

    buildSessionConfig(config, sessionId, sessionId, {
      workflowInfrastructure: bundle,
      workflowSkillsDir: workflowSkills,
      workflowSkillFilter: new Set(['wf-keep']),
    });

    expect(readdirSync(skillsDir).sort()).toEqual(['global-tool', 'wf-keep']);
  });

  it('wipes stale entries when re-staged for a state with a smaller skill set', () => {
    // Pre-stage a leftover skill from a previous state's re-stage.
    const bundleDir = resolve(TEST_HOME, 'bundle');
    const skillsDir = resolve(bundleDir, 'skills');
    mkdirSync(resolve(skillsDir, 'leftover-from-prior-state'), { recursive: true });
    writeFileSync(resolve(skillsDir, 'leftover-from-prior-state', 'SKILL.md'), '---\nname: x\ndescription: y\n---\n');

    const userSkillsRoot = resolve(TEST_HOME, 'skills');
    writeSkill(userSkillsRoot, 'global-tool', { name: 'global-tool', description: 'u' });

    const bundle = makeFakeBundle(skillsDir, bundleDir);
    const config = createTestConfig();
    const sessionId = createSessionId();

    buildSessionConfig(config, sessionId, sessionId, {
      workflowInfrastructure: bundle,
      // No workflow skills, no persona — only the user-global layer.
    });

    // Leftover gone, only the new resolved set remains.
    expect(readdirSync(skillsDir).sort()).toEqual(['global-tool']);
  });

  it('returns sessionSkills=[] in borrow mode (staging happens as a side effect)', () => {
    // Borrow-mode callers never plumb resolvedSkills back through to
    // docker-infrastructure (the bundle already exists). The contract
    // is that `SessionDirConfig.resolvedSkills` is empty in borrow mode
    // — the staging side-effect is the visible behavior instead.
    const userSkillsRoot = resolve(TEST_HOME, 'skills');
    writeSkill(userSkillsRoot, 'global-tool', { name: 'global-tool', description: 'u' });

    const bundleDir = resolve(TEST_HOME, 'bundle');
    const skillsDir = resolve(bundleDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bundle = makeFakeBundle(skillsDir, bundleDir);

    const config = createTestConfig();
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, {
      workflowInfrastructure: bundle,
    });
    expect(result.resolvedSkills).toEqual([]);
  });

  it('skips re-staging when the bundle has no skillsDir', () => {
    // A bundle without skillsDir means the mount was never established
    // (standalone bundle reused via some hypothetical caller); we must
    // not silently create a host directory the container cannot see.
    const userSkillsRoot = resolve(TEST_HOME, 'skills');
    writeSkill(userSkillsRoot, 'global-tool', { name: 'global-tool', description: 'u' });

    const bundleDir = resolve(TEST_HOME, 'bundle');
    mkdirSync(bundleDir, { recursive: true });
    const bundle = makeFakeBundle(undefined, bundleDir);

    const config = createTestConfig();
    const sessionId = createSessionId();

    buildSessionConfig(config, sessionId, sessionId, {
      workflowInfrastructure: bundle,
    });

    // No skills dir was created at the bundle.
    expect(existsSync(resolve(bundleDir, 'skills'))).toBe(false);
  });

  it('returns the resolved set in standalone Docker mode (no side-effect staging)', () => {
    // Standalone Docker path: the resolved set rides through
    // SessionDirConfig and gets staged later by docker-infrastructure
    // on initial bundle creation. `buildSessionConfig` itself does no
    // staging here.
    const userSkillsRoot = resolve(TEST_HOME, 'skills');
    writeSkill(userSkillsRoot, 'global-tool', { name: 'global-tool', description: 'u' });

    const config = createTestConfig();
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, {
      mode: { kind: 'docker', agent: 'claude-code' as AgentId },
    });
    const names = result.resolvedSkills?.map((s) => s.name) ?? [];
    expect(names).toContain('global-tool');
  });

  it('skips skill resolution entirely for builtin (non-Docker) sessions', () => {
    // Builtin sessions never mount skills, so `buildSessionConfig`
    // must not perform the discovery walk: no filesystem reads, no
    // `[skills] Ignoring …` warnings, and `resolvedSkills` left
    // undefined to signal that no resolution happened.
    const userSkillsRoot = resolve(TEST_HOME, 'skills');
    writeSkill(userSkillsRoot, 'global-tool', { name: 'global-tool', description: 'u' });

    const config = createTestConfig();
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, {});
    expect(result.resolvedSkills).toBeUndefined();
  });
});

describe('readFileSync sanity check on staged files', () => {
  it('preserves frontmatter content under bundle skillsDir', () => {
    const userSkillsRoot = resolve(TEST_HOME, 'skills');
    writeSkill(userSkillsRoot, 'detail', { name: 'detail', description: 'preserved' });

    const bundleDir = resolve(TEST_HOME, 'bundle');
    const skillsDir = resolve(bundleDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const bundle = makeFakeBundle(skillsDir, bundleDir);

    const config = createTestConfig();
    const sessionId = createSessionId();

    buildSessionConfig(config, sessionId, sessionId, {
      workflowInfrastructure: bundle,
    });

    const staged = readFileSync(resolve(skillsDir, 'detail', 'SKILL.md'), 'utf-8');
    expect(staged).toContain('name: detail');
    expect(staged).toContain('description: "preserved"');
  });
});
