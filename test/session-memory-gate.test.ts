/**
 * Integration tests for the session-level memory gate.
 *
 * Exercises `buildSessionConfig` (and `buildDockerClaudeMd` indirectly)
 * to verify that the per-persona / per-job opt-in produces the expected
 * `mcpServers` shape, system-prompt content, and CLAUDE.md output.
 *
 * Coverage matches §9.3 of docs/designs/per-persona-memory-optin.md:
 *   - Persona opt-out: no memory server, no memory prompt, no CLAUDE.md.
 *   - Default-shape persona: memory present + persona augmentation present.
 *   - Default-shape cron job: memory present + cron memory prompt prepended.
 *   - Default session (no scope): memory off regardless of global flag.
 *   - Global kill switch overrides per-persona "on".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as loggerModule from '../src/logger.js';
import { TEST_SANDBOX_DIR, REAL_TMP } from './fixtures/test-policy.js';

import { buildSessionConfig } from '../src/session/index.js';
import { buildDockerClaudeMd } from '../src/docker/claude-md-seed.js';
import { MEMORY_SERVER_NAME } from '../src/memory/memory-annotations.js';
import { createSessionId } from '../src/session/types.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { JobDefinition, JobId } from '../src/cron/types.js';
import type { PersonaDefinition } from '../src/persona/types.js';
import { isMemoryEnabledFor } from '../src/memory/memory-policy.js';

// Tests touch the user filesystem (persona dirs, job dirs) under a
// dedicated tmp home; pid suffix isolates parallel runs.
const TEST_HOME = `${REAL_TMP}/ironcurtain-session-memory-gate-test-${process.pid}`;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function createTestConfig(memoryEnabled: boolean): IronCurtainConfig {
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: TEST_SANDBOX_DIR,
    mcpServers: {
      filesystem: { command: 'echo', args: ['test'] },
    },
    protectedPaths: [],
    generatedDir: resolve(TEST_HOME, 'generated'),
    constitutionPath: `${REAL_TMP}/test-constitution.md`,
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
      memory: { enabled: memoryEnabled, autoSave: false, llmBaseUrl: undefined, llmApiKey: undefined },
    },
  } as unknown as IronCurtainConfig;
}

/**
 * Writes a persona directory tree on disk with a minimal compiled policy
 * (so `loadGeneratedPolicy` succeeds inside `buildSessionConfig`).
 * The optional `memoryOptOut` flag adds `memory: { enabled: false }` to
 * persona.json, exercising the per-persona opt-out branch.
 */
function createTestPersonaOnDisk(name: string, opts: { memoryOptOut?: boolean } = {}): void {
  const personaDir = resolve(TEST_HOME, 'personas', name);
  const generatedDir = resolve(personaDir, 'generated');
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(resolve(personaDir, 'workspace'), { recursive: true });

  const definition: Record<string, unknown> = {
    name,
    description: `Test persona ${name}`,
    createdAt: '2026-04-27T00:00:00.000Z',
    ...(opts.memoryOptOut ? { memory: { enabled: false } } : {}),
  };
  writeFileSync(resolve(personaDir, 'persona.json'), JSON.stringify(definition));

  // Minimal compiled-policy.json that references `filesystem` so
  // `filterMcpServersByPolicy` keeps it. Memory is bolted on after the
  // filter, so it doesn't need to appear here.
  writeFileSync(
    resolve(generatedDir, 'compiled-policy.json'),
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

/**
 * Writes a minimal job directory + job.json so `loadJob(jobId)` returns a
 * definition matching `buildSessionConfig`'s expectations.
 */
function createTestJobOnDisk(id: string, opts: { memoryOptOut?: boolean } = {}): JobDefinition {
  const jobDir = resolve(TEST_HOME, 'jobs', id);
  mkdirSync(jobDir, { recursive: true });

  const job: JobDefinition = {
    id: id as JobId,
    name: `Test ${id}`,
    schedule: '0 * * * *',
    taskDescription: 'test',
    taskConstitution: 'test',
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
    ...(opts.memoryOptOut ? { memory: { enabled: false } } : {}),
  };
  writeFileSync(resolve(jobDir, 'job.json'), JSON.stringify(job, null, 2));
  return job;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  mkdirSync(resolve(TEST_HOME, 'generated'), { recursive: true });
});

afterEach(() => {
  loggerModule.teardown();
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSessionConfig memory gate', () => {
  it('omits the memory server and memory prompt when persona opts out', () => {
    createTestPersonaOnDisk('opt-out', { memoryOptOut: true });
    const config = createTestConfig(true);
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, { persona: 'opt-out' });

    expect(result.config.mcpServers[MEMORY_SERVER_NAME]).toBeUndefined();
    // Persona augmentation is still emitted (header + description), but
    // the memory protocol fragment is gone — assert on the latter only.
    expect(result.systemPromptAugmentation).toBeDefined();
    expect(result.systemPromptAugmentation).not.toContain('memory.context');
    expect(result.systemPromptAugmentation).not.toContain('memory_context');

    // CLAUDE.md path: the seeder must return undefined when memory is off.
    const claudeMd = buildDockerClaudeMd({ personaName: 'opt-out', memoryEnabled: false });
    expect(claudeMd).toBeUndefined();
  });

  it('includes memory server and memory prompt for a default-shape persona', () => {
    createTestPersonaOnDisk('default-persona');
    const config = createTestConfig(true);
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, { persona: 'default-persona' });

    expect(result.config.mcpServers[MEMORY_SERVER_NAME]).toBeDefined();
    expect(result.systemPromptAugmentation).toBeDefined();
    // The MCP-namespaced memory tool names are spliced into the prompt.
    expect(result.systemPromptAugmentation).toContain('memory.context');

    // The Docker CLAUDE.md surface mirrors the same gate decision.
    const claudeMd = buildDockerClaudeMd({ personaName: 'default-persona', memoryEnabled: true });
    expect(claudeMd).toBeDefined();
    expect(claudeMd).toContain('memory.context');
  });

  it('includes memory server and prepended cron prompt for a default-shape job', () => {
    const job = createTestJobOnDisk('default-job');
    const config = createTestConfig(true);
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, { jobId: job.id });

    expect(result.config.mcpServers[MEMORY_SERVER_NAME]).toBeDefined();
    // Non-persona cron sessions get the standalone memory prompt prepended,
    // so the augmentation must mention the memory tools.
    expect(result.systemPromptAugmentation).toBeDefined();
    expect(result.systemPromptAugmentation).toContain('memory.context');
  });

  it('omits memory in default sessions (no persona, no job) regardless of global flag', () => {
    const config = createTestConfig(true);
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, {});

    expect(result.config.mcpServers[MEMORY_SERVER_NAME]).toBeUndefined();
    // No persona augmentation either — `systemPromptAugmentation` is whatever
    // the caller passed in (undefined here).
    expect(result.systemPromptAugmentation).toBeUndefined();
  });

  it('global kill switch overrides per-persona "on"', () => {
    createTestPersonaOnDisk('default-persona');
    // Global kill switch flipped off; persona has no `memory` field.
    const config = createTestConfig(false);
    const sessionId = createSessionId();

    const result = buildSessionConfig(config, sessionId, sessionId, { persona: 'default-persona' });

    expect(result.config.mcpServers[MEMORY_SERVER_NAME]).toBeUndefined();
    // The persona augmentation is still produced (header + description),
    // but the memory protocol fragment is suppressed.
    expect(result.systemPromptAugmentation).toBeDefined();
    expect(result.systemPromptAugmentation).not.toContain('memory.context');
  });
});

// ---------------------------------------------------------------------------
// Sanity checks: the gate helper agrees with the integration paths above.
// ---------------------------------------------------------------------------

describe('isMemoryEnabledFor — integration sanity', () => {
  it('agrees with buildSessionConfig for the persona-opt-out case', () => {
    const persona: PersonaDefinition = {
      name: 'opt-out' as PersonaDefinition['name'],
      description: 'test',
      createdAt: '2026-04-27T00:00:00.000Z',
      memory: { enabled: false },
    };
    const config = createTestConfig(true);
    expect(isMemoryEnabledFor({ persona, userConfig: config.userConfig })).toBe(false);
  });

  it('agrees with buildSessionConfig for the default-shape persona case', () => {
    const persona: PersonaDefinition = {
      name: 'default-persona' as PersonaDefinition['name'],
      description: 'test',
      createdAt: '2026-04-27T00:00:00.000Z',
    };
    const config = createTestConfig(true);
    expect(isMemoryEnabledFor({ persona, userConfig: config.userConfig })).toBe(true);
  });
});
