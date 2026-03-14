/**
 * Integration tests for buildSessionConfig persona behavior.
 *
 * Tests the observable effects of persona resolution during session creation:
 * - Persona's policyDir overrides global generatedDir
 * - Server allowlist filtering is applied to mcpServers
 * - Persona + explicit policyDir conflict logs a warning
 * - Persona workspace is used unless explicit workspacePath is provided
 * - System prompt augmentation includes persona content
 *
 * Since buildSessionConfig is private, we test through createSession()
 * and observe the config via the sandboxFactory callback and the
 * generateText mock's captured arguments.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as loggerModule from '../src/logger.js';
import { TEST_SANDBOX_DIR, REAL_TMP } from './fixtures/test-policy.js';

// Mock external dependencies before importing session modules -- same
// pattern as test/session.test.ts.
vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: vi.fn(() => 'mock-model'),
  createAnthropic: vi.fn(() => vi.fn(() => 'mock-model')),
}));

vi.mock('@utcp/code-mode', () => ({
  CodeModeUtcpClient: {
    AGENT_PROMPT_TEMPLATE: 'mock code mode prompt template',
  },
}));

import { generateText } from 'ai';
import { createSession } from '../src/session/index.js';
import { loadSessionMetadata } from '../src/session/session-metadata.js';
import { getSessionMetadataPath } from '../src/config/paths.js';
import type { Sandbox } from '../src/sandbox/index.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { SessionOptions } from '../src/session/types.js';

const mockGenerateText = generateText as unknown as MockInstance;

// --- Test helpers ---

const TEST_HOME = `/tmp/ironcurtain-persona-session-test-${process.pid}`;

function createTestConfig(): IronCurtainConfig {
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: TEST_SANDBOX_DIR,
    mcpServers: {
      filesystem: { command: 'echo', args: ['test'] },
      github: { command: 'echo', args: ['gh'] },
      gmail: { command: 'echo', args: ['gmail'] },
    },
    protectedPaths: [],
    generatedDir: `${REAL_TMP}/test-generated`,
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
      memory: { enabled: false, llmBaseUrl: undefined, llmApiKey: undefined },
    },
  };
}

function createMockSandbox(): Sandbox {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getToolInterfaces: vi.fn().mockReturnValue('mock tool interfaces'),
    getHelpData: vi.fn().mockReturnValue({
      serverDescriptions: { filesystem: 'File operations' },
      toolsByServer: {
        filesystem: [{ callableName: 'filesystem.read_file', params: '{ path }' }],
      },
    }),
    executeCode: vi.fn().mockResolvedValue({ result: 'mock result', logs: [] }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as Sandbox;
}

function createMockSandboxFactory(sandbox?: Sandbox) {
  const mock = sandbox ?? createMockSandbox();
  return vi.fn().mockResolvedValue(mock);
}

function createMockGenerateResult(text = 'mock response') {
  return {
    text,
    response: {
      messages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
    },
    totalUsage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  };
}

/**
 * Creates a persona directory structure on disk with a compiled policy.
 * Returns the expected policyDir (generated/) path.
 */
function createTestPersonaOnDisk(name: string, opts: { servers?: string[]; description?: string } = {}): string {
  const personaDir = resolve(TEST_HOME, 'personas', name);
  const generatedDir = resolve(personaDir, 'generated');
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(resolve(personaDir, 'workspace'), { recursive: true });

  const definition = {
    name,
    description: opts.description ?? `Test persona: ${name}`,
    createdAt: '2026-03-07T12:00:00.000Z',
    ...(opts.servers ? { servers: opts.servers } : {}),
  };
  writeFileSync(resolve(personaDir, 'persona.json'), JSON.stringify(definition));
  writeFileSync(resolve(generatedDir, 'compiled-policy.json'), '{}');

  return generatedDir;
}

/** Creates a session with sensible test defaults and the given overrides. */
async function createTestSession(overrides: Partial<SessionOptions> = {}) {
  return createSession({
    config: createTestConfig(),
    sandboxFactory: createMockSandboxFactory(),
    ...overrides,
  });
}

// --- Setup / Teardown ---

beforeEach(() => {
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  mkdirSync(resolve(TEST_HOME, 'generated'), { recursive: true });

  mockGenerateText.mockReset();
  mockGenerateText.mockResolvedValue(createMockGenerateResult());
});

afterEach(async () => {
  loggerModule.teardown();
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// --- Tests ---

describe('buildSessionConfig with persona', () => {
  it('uses persona policyDir as generatedDir instead of global', async () => {
    const personaPolicyDir = createTestPersonaOnDisk('coder');

    const sandboxFactory = vi.fn().mockImplementation(async (config: IronCurtainConfig) => {
      // The generatedDir should point to the persona's generated/ directory
      expect(config.generatedDir).toBe(personaPolicyDir);
      return createMockSandbox();
    });

    const session = await createTestSession({
      persona: 'coder',
      sandboxFactory,
    });
    try {
      expect(sandboxFactory).toHaveBeenCalledOnce();
    } finally {
      await session.close();
    }
  });

  it('preserves global toolAnnotationsDir when persona policyDir is set', async () => {
    createTestPersonaOnDisk('coder');
    const globalGeneratedDir = `${REAL_TMP}/test-generated`;

    const sandboxFactory = vi.fn().mockImplementation(async (config: IronCurtainConfig) => {
      // toolAnnotationsDir should fall back to the original global generatedDir
      expect(config.toolAnnotationsDir).toBe(globalGeneratedDir);
      return createMockSandbox();
    });

    const session = await createTestSession({
      persona: 'coder',
      sandboxFactory,
    });
    try {
      expect(sandboxFactory).toHaveBeenCalledOnce();
    } finally {
      await session.close();
    }
  });

  it('filters mcpServers when persona has a server allowlist', async () => {
    createTestPersonaOnDisk('email-only', { servers: ['gmail'] });

    const sandboxFactory = vi.fn().mockImplementation(async (config: IronCurtainConfig) => {
      const serverNames = Object.keys(config.mcpServers).sort();
      // Only gmail + filesystem (always included) should survive
      expect(serverNames).toEqual(['filesystem', 'gmail']);
      // github should be filtered out
      expect(config.mcpServers['github']).toBeUndefined();
      return createMockSandbox();
    });

    const session = await createTestSession({
      persona: 'email-only',
      sandboxFactory,
    });
    try {
      expect(sandboxFactory).toHaveBeenCalledOnce();
    } finally {
      await session.close();
    }
  });

  it('keeps all servers when persona has no server allowlist', async () => {
    createTestPersonaOnDisk('general');

    const sandboxFactory = vi.fn().mockImplementation(async (config: IronCurtainConfig) => {
      const serverNames = Object.keys(config.mcpServers).sort();
      // All three servers from the base config should be present
      expect(serverNames).toEqual(['filesystem', 'github', 'gmail']);
      return createMockSandbox();
    });

    const session = await createTestSession({
      persona: 'general',
      sandboxFactory,
    });
    try {
      expect(sandboxFactory).toHaveBeenCalledOnce();
    } finally {
      await session.close();
    }
  });

  it('logs a warning when both persona and policyDir are specified', async () => {
    createTestPersonaOnDisk('coder');

    // Create an alternative policyDir under the trusted home to pass validation
    const altPolicyDir = resolve(TEST_HOME, 'alt-generated');
    mkdirSync(altPolicyDir, { recursive: true });

    // The warning is emitted via logger.warn before logger.setup() runs,
    // so it goes to the module-level warn function (not the log file).
    // Spy on the imported logger module to capture it.
    const warnSpy = vi.spyOn(loggerModule, 'warn');

    const session = await createTestSession({
      persona: 'coder',
      policyDir: altPolicyDir,
    });
    try {
      expect(warnSpy).toHaveBeenCalledWith('Both persona and policyDir specified; using persona.');
    } finally {
      await session.close();
    }
  });

  it('uses persona policyDir when both persona and policyDir are specified', async () => {
    const personaPolicyDir = createTestPersonaOnDisk('coder');

    // Create an alternative policyDir under the trusted home
    const altPolicyDir = resolve(TEST_HOME, 'alt-generated');
    mkdirSync(altPolicyDir, { recursive: true });

    const sandboxFactory = vi.fn().mockImplementation(async (config: IronCurtainConfig) => {
      // Persona should win: generatedDir should be the persona's, not the explicit policyDir
      expect(config.generatedDir).toBe(personaPolicyDir);
      expect(config.generatedDir).not.toBe(altPolicyDir);
      return createMockSandbox();
    });

    const session = await createTestSession({
      persona: 'coder',
      policyDir: altPolicyDir,
      sandboxFactory,
    });
    try {
      expect(sandboxFactory).toHaveBeenCalledOnce();
    } finally {
      await session.close();
    }
  });

  it('uses persona workspace as allowedDirectory', async () => {
    createTestPersonaOnDisk('coder');
    const expectedWorkspace = resolve(TEST_HOME, 'personas', 'coder', 'workspace');

    const sandboxFactory = vi.fn().mockImplementation(async (config: IronCurtainConfig) => {
      expect(config.allowedDirectory).toBe(expectedWorkspace);
      return createMockSandbox();
    });

    const session = await createTestSession({
      persona: 'coder',
      sandboxFactory,
    });
    try {
      expect(sandboxFactory).toHaveBeenCalledOnce();
    } finally {
      await session.close();
    }
  });

  it('uses explicit workspacePath over persona workspace when both are provided', async () => {
    createTestPersonaOnDisk('coder');
    const explicitWorkspace = resolve(TEST_HOME, 'my-workspace');
    mkdirSync(explicitWorkspace, { recursive: true });

    const sandboxFactory = vi.fn().mockImplementation(async (config: IronCurtainConfig) => {
      expect(config.allowedDirectory).toBe(explicitWorkspace);
      // Should NOT be the persona workspace
      expect(config.allowedDirectory).not.toContain('personas/coder/workspace');
      return createMockSandbox();
    });

    const session = await createTestSession({
      persona: 'coder',
      workspacePath: explicitWorkspace,
      sandboxFactory,
    });
    try {
      expect(sandboxFactory).toHaveBeenCalledOnce();
    } finally {
      await session.close();
    }
  });

  it('includes persona augmentation in the system prompt', async () => {
    createTestPersonaOnDisk('exec-assistant', {
      description: 'Email triage and calendar management',
    });

    // Capture the system prompt passed to generateText.
    // With Anthropic model IDs, the cache strategy wraps it as a
    // SystemModelMessage { role: 'system', content: string, ... }.
    let capturedSystem: string | undefined;
    mockGenerateText.mockImplementation(async (opts: { system?: string | { content: string } }) => {
      if (opts.system) {
        capturedSystem = typeof opts.system === 'string' ? opts.system : opts.system.content;
      }
      return createMockGenerateResult();
    });

    const session = await createTestSession({ persona: 'exec-assistant' });
    try {
      await session.sendMessage('hello');
      expect(capturedSystem).toBeDefined();
      expect(capturedSystem).toContain('Persona: exec-assistant');
      expect(capturedSystem).toContain('Email triage and calendar management');
    } finally {
      await session.close();
    }
  });

  it('prepends persona augmentation to existing systemPromptAugmentation', async () => {
    createTestPersonaOnDisk('coder', { description: 'Software dev' });

    let capturedSystem: string | undefined;
    mockGenerateText.mockImplementation(async (opts: { system?: string | { content: string } }) => {
      if (opts.system) {
        capturedSystem = typeof opts.system === 'string' ? opts.system : opts.system.content;
      }
      return createMockGenerateResult();
    });

    const session = await createTestSession({
      persona: 'coder',
      systemPromptAugmentation: 'Custom task context here.',
    });
    try {
      await session.sendMessage('hello');
      expect(capturedSystem).toBeDefined();
      // Both persona augmentation and custom augmentation should be present
      expect(capturedSystem).toContain('Persona: coder');
      expect(capturedSystem).toContain('Custom task context here.');
      // Persona augmentation should come before the custom augmentation
      const personaIdx = capturedSystem!.indexOf('Persona: coder');
      const customIdx = capturedSystem!.indexOf('Custom task context here.');
      expect(personaIdx).toBeLessThan(customIdx);
    } finally {
      await session.close();
    }
  });

  it('patches filesystem server args to use persona workspace', async () => {
    createTestPersonaOnDisk('coder');
    const expectedWorkspace = resolve(TEST_HOME, 'personas', 'coder', 'workspace');

    const sandboxFactory = vi.fn().mockImplementation(async (config: IronCurtainConfig) => {
      // The filesystem server's last arg should be patched to the persona workspace
      const fsServer = config.mcpServers['filesystem'];
      expect(fsServer).toBeDefined();
      const fsArgs = fsServer.args;
      expect(fsArgs[fsArgs.length - 1]).toBe(expectedWorkspace);
      return createMockSandbox();
    });

    const session = await createTestSession({
      persona: 'coder',
      sandboxFactory,
    });
    try {
      expect(sandboxFactory).toHaveBeenCalledOnce();
    } finally {
      await session.close();
    }
  });
});

describe('session metadata persistence', () => {
  it('saves metadata file when creating a session with a persona', async () => {
    createTestPersonaOnDisk('coder');

    const session = await createTestSession({ persona: 'coder' });
    try {
      const sessionId = session.getInfo().id;
      const metadataPath = getSessionMetadataPath(sessionId);
      expect(existsSync(metadataPath)).toBe(true);

      const metadata = loadSessionMetadata(sessionId);
      expect(metadata).toBeDefined();
      expect(metadata!.persona).toBe('coder');
      expect(metadata!.createdAt).toBeDefined();
    } finally {
      await session.close();
    }
  });

  it('does not store policyDir when persona is set', async () => {
    createTestPersonaOnDisk('coder');

    const session = await createTestSession({ persona: 'coder' });
    try {
      const metadata = loadSessionMetadata(session.getInfo().id);
      expect(metadata).toBeDefined();
      expect(metadata!.persona).toBe('coder');
      // policyDir should NOT be stored because persona derives it
      expect(metadata!.policyDir).toBeUndefined();
    } finally {
      await session.close();
    }
  });

  it('restores persona settings on resume', async () => {
    createTestPersonaOnDisk('coder');
    const expectedPolicyDir = resolve(TEST_HOME, 'personas', 'coder', 'generated');

    // Create the initial session with persona
    const firstSession = await createTestSession({ persona: 'coder' });
    const firstSessionId = firstSession.getInfo().id;
    await firstSession.close();

    // Resume the session — persona should be restored from metadata
    const sandboxFactory = vi.fn().mockImplementation(async (config: IronCurtainConfig) => {
      // generatedDir should be the persona's policy dir (restored from metadata)
      expect(config.generatedDir).toBe(expectedPolicyDir);
      return createMockSandbox();
    });

    const resumedSession = await createTestSession({
      resumeSessionId: firstSessionId,
      sandboxFactory,
    });
    try {
      expect(sandboxFactory).toHaveBeenCalledOnce();
    } finally {
      await resumedSession.close();
    }
  });

  it('restores persona workspace on resume', async () => {
    createTestPersonaOnDisk('coder');
    const expectedWorkspace = resolve(TEST_HOME, 'personas', 'coder', 'workspace');

    const firstSession = await createTestSession({ persona: 'coder' });
    const firstSessionId = firstSession.getInfo().id;
    await firstSession.close();

    const sandboxFactory = vi.fn().mockImplementation(async (config: IronCurtainConfig) => {
      expect(config.allowedDirectory).toBe(expectedWorkspace);
      return createMockSandbox();
    });

    const resumedSession = await createTestSession({
      resumeSessionId: firstSessionId,
      sandboxFactory,
    });
    try {
      expect(sandboxFactory).toHaveBeenCalledOnce();
    } finally {
      await resumedSession.close();
    }
  });

  it('resumes gracefully when no metadata file exists (old session)', async () => {
    // Create a session directory manually without metadata
    const fakeSessionId = 'legacy-session-no-metadata';
    const sessionDir = resolve(TEST_HOME, 'sessions', fakeSessionId);
    mkdirSync(resolve(sessionDir, 'sandbox'), { recursive: true });

    // Should not throw — just proceeds without persona/workspace
    const session = await createTestSession({
      resumeSessionId: fakeSessionId,
    });
    try {
      const info = session.getInfo();
      expect(info.status).toBe('ready');
    } finally {
      await session.close();
    }
  });

  it('stores disableAutoApprove when set', async () => {
    const session = await createTestSession({ disableAutoApprove: true });
    try {
      const metadata = loadSessionMetadata(session.getInfo().id);
      expect(metadata).toBeDefined();
      expect(metadata!.disableAutoApprove).toBe(true);
    } finally {
      await session.close();
    }
  });
});
