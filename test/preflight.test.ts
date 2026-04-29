import { describe, it, expect, vi } from 'vitest';
import {
  resolveSessionMode,
  checkDockerAvailable,
  PreflightError,
  type DockerAvailability,
  type ProbeExecFileFn,
} from '../src/session/preflight.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { AgentId } from '../src/docker/agent-adapter.js';
import type { CredentialSources } from '../src/docker/oauth-credentials.js';

import { TEST_SANDBOX_DIR, REAL_TMP } from './fixtures/test-policy.js';

/** No OAuth credentials — forces API key path. */
const noOAuthSources: CredentialSources = {
  loadFromFile: () => null,
  loadFromKeychain: () => null,
};

function createTestConfig(
  overrides: { anthropicApiKey?: string; preferredMode?: 'docker' | 'builtin' } = {},
): IronCurtainConfig {
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: TEST_SANDBOX_DIR,
    mcpServers: {
      filesystem: { command: 'echo', args: ['test'] },
    },
    protectedPaths: [],
    generatedDir: `${REAL_TMP}/test-generated`,
    constitutionPath: `${REAL_TMP}/test-constitution.md`,
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: overrides.anthropicApiKey ?? 'test-api-key',
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
      serverCredentials: {},
      gooseProvider: 'anthropic',
      gooseModel: 'claude-sonnet-4-20250514',
      preferredDockerAgent: 'claude-code',
      preferredMode: overrides.preferredMode ?? 'docker',
    },
  };
}

const dockerAvailable = (): Promise<DockerAvailability> => Promise.resolve({ available: true });
const dockerUnavailable = (): Promise<DockerAvailability> =>
  Promise.resolve({
    available: false,
    reason: 'Docker not available',
    detailedMessage: 'docker daemon not running (test fixture)',
  });

describe('resolveSessionMode', () => {
  describe('explicit --agent', () => {
    it('succeeds when Docker and API key are available', async () => {
      const result = await resolveSessionMode({
        config: createTestConfig(),
        requestedAgent: 'claude-code' as AgentId,
        isDockerAvailable: dockerAvailable,
        credentialSources: noOAuthSources,
      });

      expect(result.mode).toEqual({ kind: 'docker', agent: 'claude-code', authKind: 'apikey' });
      expect(result.reason).toBe('Explicit --agent selection (API key)');
    });

    it('throws PreflightError when Docker is unavailable', async () => {
      const promise = resolveSessionMode({
        config: createTestConfig(),
        requestedAgent: 'claude-code' as AgentId,
        isDockerAvailable: dockerUnavailable,
        credentialSources: noOAuthSources,
      });

      await expect(promise).rejects.toThrow(PreflightError);
      await expect(promise).rejects.toThrow(/Docker/);
    });

    it('throws PreflightError when no credentials are available', async () => {
      const promise = resolveSessionMode({
        config: createTestConfig({ anthropicApiKey: '' }),
        requestedAgent: 'claude-code' as AgentId,
        isDockerAvailable: dockerAvailable,
        credentialSources: noOAuthSources,
      });

      await expect(promise).rejects.toThrow(PreflightError);
      await expect(promise).rejects.toThrow(/authentication/);
    });

    it('selects builtin mode when --agent builtin is specified', async () => {
      const result = await resolveSessionMode({
        config: createTestConfig(),
        requestedAgent: 'builtin' as AgentId,
        isDockerAvailable: dockerUnavailable,
        credentialSources: noOAuthSources,
      });

      expect(result.mode).toEqual({ kind: 'builtin' });
      expect(result.reason).toBe('Explicit --agent builtin');
    });

    it('checks Docker before credentials (Docker error shown first)', async () => {
      await expect(
        resolveSessionMode({
          config: createTestConfig({ anthropicApiKey: '' }),
          requestedAgent: 'claude-code' as AgentId,
          isDockerAvailable: dockerUnavailable,
          credentialSources: noOAuthSources,
        }),
      ).rejects.toThrow(/Docker/);
    });

    it('succeeds with OAuth credentials and no API key', async () => {
      const oauthSources: CredentialSources = {
        loadFromFile: () => ({
          accessToken: 'sk-ant-oat01-test',
          refreshToken: 'sk-ant-ort01-test',
          expiresAt: Date.now() + 3_600_000,
        }),
        loadFromKeychain: () => null,
      };

      const result = await resolveSessionMode({
        config: createTestConfig({ anthropicApiKey: '' }),
        requestedAgent: 'claude-code' as AgentId,
        isDockerAvailable: dockerAvailable,
        credentialSources: oauthSources,
      });

      expect(result.mode).toEqual({ kind: 'docker', agent: 'claude-code', authKind: 'oauth' });
      expect(result.reason).toBe('Explicit --agent selection (OAuth)');
    });

    it('--agent goose surfaces the OAuth-not-usable-with-goose addendum on OAuth-only', async () => {
      const oauthOnlySources: CredentialSources = {
        loadFromFile: () => ({
          accessToken: 'sk-ant-oat01-test',
          refreshToken: 'sk-ant-ort01-test',
          expiresAt: Date.now() + 3_600_000,
        }),
        loadFromKeychain: () => null,
      };

      const config = createTestConfig({ anthropicApiKey: '' });
      config.userConfig.preferredDockerAgent = 'goose';
      config.userConfig.gooseProvider = 'anthropic';

      const promise = resolveSessionMode({
        config,
        requestedAgent: 'goose' as AgentId,
        isDockerAvailable: dockerAvailable,
        credentialSources: oauthOnlySources,
      });

      await expect(promise).rejects.toThrow(/OAuth credentials are not usable with goose/);
    });
  });

  describe('default mode (no --agent)', () => {
    const oauthOnlySources: CredentialSources = {
      loadFromFile: () => ({
        accessToken: 'sk-ant-oat01-test',
        refreshToken: 'sk-ant-ort01-test',
        expiresAt: Date.now() + 3_600_000,
      }),
      loadFromKeychain: () => null,
    };

    describe('preferredMode = docker', () => {
      it('selects Docker (claude-code, API key) when both Docker and API key are available', async () => {
        const result = await resolveSessionMode({
          config: createTestConfig(),
          isDockerAvailable: dockerAvailable,
          credentialSources: noOAuthSources,
        });

        expect(result.mode).toEqual({ kind: 'docker', agent: 'claude-code', authKind: 'apikey' });
        expect(result.reason).toBe('claude-code (API key)');
      });

      it('selects Docker (claude-code, OAuth) when only OAuth is configured', async () => {
        const result = await resolveSessionMode({
          config: createTestConfig({ anthropicApiKey: '' }),
          isDockerAvailable: dockerAvailable,
          credentialSources: oauthOnlySources,
        });

        expect(result.mode).toEqual({ kind: 'docker', agent: 'claude-code', authKind: 'oauth' });
        expect(result.reason).toBe('claude-code (OAuth)');
      });

      it('selects Docker (goose) when preferredDockerAgent=goose and goose provider key is set', async () => {
        const config = createTestConfig();
        config.userConfig.preferredDockerAgent = 'goose';
        config.userConfig.gooseProvider = 'anthropic';

        const result = await resolveSessionMode({
          config,
          isDockerAvailable: dockerAvailable,
          credentialSources: noOAuthSources,
        });

        expect(result.mode).toEqual({ kind: 'docker', agent: 'goose', authKind: 'apikey' });
        expect(result.reason).toBe('goose (API key)');
      });

      it('throws with goose+OAuth-only and includes the goose-OAuth-not-usable addendum', async () => {
        const config = createTestConfig({ anthropicApiKey: '' });
        config.userConfig.preferredDockerAgent = 'goose';
        config.userConfig.gooseProvider = 'anthropic';

        const promise = resolveSessionMode({
          config,
          isDockerAvailable: dockerAvailable,
          credentialSources: oauthOnlySources,
        });

        await expect(promise).rejects.toThrow(PreflightError);
        await expect(promise).rejects.toThrow(/goose/);
        await expect(promise).rejects.toThrow(/OAuth credentials are not usable with goose/);
      });

      it('throws when Docker is unavailable, with --agent builtin and ironcurtain config hints', async () => {
        const promise = resolveSessionMode({
          config: createTestConfig(),
          isDockerAvailable: dockerUnavailable,
          credentialSources: noOAuthSources,
        });

        await expect(promise).rejects.toThrow(PreflightError);
        await expect(promise).rejects.toThrow(/Docker is not available/);
        await expect(promise).rejects.toThrow(/--agent builtin/);
        await expect(promise).rejects.toThrow(/ironcurtain config/);
      });

      it('throws via the preferred-mode helper (not the explicit-mode helper) when no credentials are configured', async () => {
        const promise = resolveSessionMode({
          config: createTestConfig({ anthropicApiKey: '' }),
          isDockerAvailable: dockerAvailable,
          credentialSources: noOAuthSources,
        });

        await expect(promise).rejects.toThrow(PreflightError);
        // The preferred-mode helper leads with "preferredMode is" and offers
        // both the one-shot and permanent escapes. The explicit-mode helper
        // would say "--agent claude-code requires authentication" instead.
        await expect(promise).rejects.toThrow(/preferredMode is "docker"/);
        await expect(promise).rejects.not.toThrow(/--agent claude-code requires authentication/);
      });
    });

    describe('preferredMode = builtin', () => {
      it('selects builtin when an Anthropic API key is configured', async () => {
        const isDockerAvailable = vi.fn(dockerAvailable);
        const result = await resolveSessionMode({
          config: createTestConfig({ preferredMode: 'builtin' }),
          isDockerAvailable,
          credentialSources: noOAuthSources,
        });

        expect(result.mode).toEqual({ kind: 'builtin' });
        expect(result.reason).toBe('preferredMode = builtin');
        // Builtin path must not probe Docker — fast feedback for missing keys.
        expect(isDockerAvailable).not.toHaveBeenCalled();
      });

      it('throws when only OAuth is configured (no ANTHROPIC_API_KEY)', async () => {
        const promise = resolveSessionMode({
          config: createTestConfig({ anthropicApiKey: '', preferredMode: 'builtin' }),
          isDockerAvailable: dockerAvailable,
          credentialSources: oauthOnlySources,
        });

        await expect(promise).rejects.toThrow(PreflightError);
        await expect(promise).rejects.toThrow(/no ANTHROPIC_API_KEY/);
      });

      it('throws when nothing is configured (same message as OAuth-only)', async () => {
        const promise = resolveSessionMode({
          config: createTestConfig({ anthropicApiKey: '', preferredMode: 'builtin' }),
          isDockerAvailable: dockerAvailable,
          credentialSources: noOAuthSources,
        });

        await expect(promise).rejects.toThrow(PreflightError);
        await expect(promise).rejects.toThrow(/no ANTHROPIC_API_KEY/);
      });
    });

    describe('--agent overrides preferredMode', () => {
      it('--agent builtin wins when preferredMode = docker', async () => {
        const result = await resolveSessionMode({
          config: createTestConfig({ preferredMode: 'docker' }),
          requestedAgent: 'builtin' as AgentId,
          isDockerAvailable: dockerAvailable,
          credentialSources: noOAuthSources,
        });

        expect(result.mode).toEqual({ kind: 'builtin' });
        expect(result.reason).toBe('Explicit --agent builtin');
      });

      it('--agent builtin succeeds even with preferredMode = builtin and no API key', async () => {
        // Lock-in: resolveExplicit('builtin', ...) intentionally does NOT
        // check the API key. The agent loop fails later on the actual API
        // call. If a future "symmetry" refactor tightens this path, it
        // should have to delete this test on purpose — see the design's
        // out-of-scope notes.
        const result = await resolveSessionMode({
          config: createTestConfig({ anthropicApiKey: '', preferredMode: 'builtin' }),
          requestedAgent: 'builtin' as AgentId,
          isDockerAvailable: dockerAvailable,
          credentialSources: noOAuthSources,
        });

        expect(result.mode).toEqual({ kind: 'builtin' });
      });

      it('--agent claude-code with Docker unavailable throws the explicit-mode message', async () => {
        const promise = resolveSessionMode({
          config: createTestConfig({ preferredMode: 'builtin' }),
          requestedAgent: 'claude-code' as AgentId,
          isDockerAvailable: dockerUnavailable,
          credentialSources: noOAuthSources,
        });

        await expect(promise).rejects.toThrow(PreflightError);
        // The explicit-mode message preserves its existing wording so the
        // error is attributed to the flag the user typed.
        await expect(promise).rejects.toThrow(/--agent claude-code requires Docker/);
      });
    });
  });
});

// ---- Helpers for checkDockerAvailable tests --------------------------

/**
 * Builds the error shape Node's `execFile` produces on `timeout`. We don't
 * call the real `child_process.execFile` from these tests so we have to
 * synthesize the expected shape.
 */
function makeTimeoutError(): Error {
  return Object.assign(new Error('Command timed out'), {
    code: null,
    killed: true,
    signal: 'SIGTERM',
    stdout: '',
    stderr: '',
  });
}

function makeEnoentError(): Error {
  return Object.assign(new Error('spawn docker ENOENT'), {
    code: 'ENOENT',
    stdout: '',
    stderr: '',
  });
}

function makePermissionDeniedError(): Error {
  return Object.assign(new Error('Command failed'), {
    code: 1,
    stdout: '',
    stderr: 'Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
  });
}

describe('checkDockerAvailable', () => {
  it('returns available:true on the first attempt when docker info succeeds', async () => {
    const execFileFn: ProbeExecFileFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

    const result = await checkDockerAvailable(execFileFn);

    expect(result).toEqual({ available: true });
    expect(execFileFn).toHaveBeenCalledTimes(1);
  });

  it('recovers on the second attempt after a single timeout', async () => {
    const execFileFn = vi
      .fn<ProbeExecFileFn>()
      .mockRejectedValueOnce(makeTimeoutError())
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const result = await checkDockerAvailable(execFileFn);

    expect(result).toEqual({ available: true });
    expect(execFileFn).toHaveBeenCalledTimes(2);
  });

  it('exhausts all attempts on persistent timeouts and reports a timeout-flavored error', async () => {
    const execFileFn = vi.fn<ProbeExecFileFn>().mockRejectedValue(makeTimeoutError());

    const result = await checkDockerAvailable(execFileFn);

    // 1 initial attempt + 2 retries = 3 total attempts
    expect(execFileFn).toHaveBeenCalledTimes(3);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('Docker not available');
      expect(result.detailedMessage).toMatch(/did not respond/);
      expect(result.detailedMessage).toMatch(/3 attempts/);
    }
  });

  it('does not retry when docker binary is missing (ENOENT)', async () => {
    const execFileFn = vi.fn<ProbeExecFileFn>().mockRejectedValue(makeEnoentError());

    const result = await checkDockerAvailable(execFileFn);

    expect(execFileFn).toHaveBeenCalledTimes(1);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.detailedMessage).toMatch(/not found in your PATH/);
    }
  });

  it('does not retry on permission denied', async () => {
    const execFileFn = vi.fn<ProbeExecFileFn>().mockRejectedValue(makePermissionDeniedError());

    const result = await checkDockerAvailable(execFileFn);

    expect(execFileFn).toHaveBeenCalledTimes(1);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.detailedMessage).toMatch(/Permission denied/);
    }
  });

  it('does not retry when daemon is unreachable (deterministic stderr)', async () => {
    const execFileFn = vi.fn<ProbeExecFileFn>().mockRejectedValue(
      Object.assign(new Error('Command failed'), {
        code: 1,
        stdout: '',
        stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
      }),
    );

    const result = await checkDockerAvailable(execFileFn);

    expect(execFileFn).toHaveBeenCalledTimes(1);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.detailedMessage).toMatch(/Cannot connect to the Docker daemon/);
    }
  });

  it('uses a 10 second per-attempt timeout', async () => {
    const execFileFn = vi.fn<ProbeExecFileFn>().mockResolvedValue({ stdout: '', stderr: '' });

    await checkDockerAvailable(execFileFn);

    expect(execFileFn).toHaveBeenCalledWith('docker', ['info'], { timeout: 10_000 });
  });
});
