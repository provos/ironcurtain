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

function createTestConfig(overrides: { anthropicApiKey?: string } = {}): IronCurtainConfig {
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
  });

  describe('auto-detect (no --agent)', () => {
    it('selects Docker when both Docker and API key are available', async () => {
      const result = await resolveSessionMode({
        config: createTestConfig(),
        isDockerAvailable: dockerAvailable,
        credentialSources: noOAuthSources,
      });

      expect(result.mode).toEqual({ kind: 'docker', agent: 'claude-code', authKind: 'apikey' });
      expect(result.reason).toBe('Docker available, API key detected');
    });

    it('selects Docker with OAuth when available', async () => {
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
        isDockerAvailable: dockerAvailable,
        credentialSources: oauthSources,
      });

      expect(result.mode).toEqual({ kind: 'docker', agent: 'claude-code', authKind: 'oauth' });
      expect(result.reason).toBe('Docker available, OAuth detected');
    });

    it('falls back to builtin when Docker is unavailable', async () => {
      const result = await resolveSessionMode({
        config: createTestConfig(),
        isDockerAvailable: dockerUnavailable,
        credentialSources: noOAuthSources,
      });

      expect(result.mode).toEqual({ kind: 'builtin' });
      expect(result.reason).toBe('Docker not available');
    });

    it('falls back to builtin when no credentials are available', async () => {
      const result = await resolveSessionMode({
        config: createTestConfig({ anthropicApiKey: '' }),
        isDockerAvailable: dockerAvailable,
        credentialSources: noOAuthSources,
      });

      expect(result.mode).toEqual({ kind: 'builtin' });
      expect(result.reason).toBe('No credentials (OAuth or API key)');
    });

    it('falls back to builtin when both Docker and credentials are missing', async () => {
      const result = await resolveSessionMode({
        config: createTestConfig({ anthropicApiKey: '' }),
        isDockerAvailable: dockerUnavailable,
        credentialSources: noOAuthSources,
      });

      expect(result.mode).toEqual({ kind: 'builtin' });
    });

    describe('OAuth-only without Docker', () => {
      const oauthOnlySources: CredentialSources = {
        loadFromFile: () => ({
          accessToken: 'sk-ant-oat01-test',
          refreshToken: 'sk-ant-ort01-test',
          expiresAt: Date.now() + 3_600_000,
        }),
        loadFromKeychain: () => null,
      };

      it('throws PreflightError when Docker is unavailable and only OAuth is configured', async () => {
        const promise = resolveSessionMode({
          config: createTestConfig({ anthropicApiKey: '' }),
          isDockerAvailable: dockerUnavailable,
          credentialSources: oauthOnlySources,
        });

        await expect(promise).rejects.toThrow(PreflightError);
        await expect(promise).rejects.toThrow(/Docker/);
      });

      it('falls back to builtin when Docker is unavailable but an API key is also configured', async () => {
        const result = await resolveSessionMode({
          config: createTestConfig({ anthropicApiKey: 'sk-ant-test-fallback' }),
          isDockerAvailable: dockerUnavailable,
          credentialSources: oauthOnlySources,
        });

        expect(result.mode).toEqual({ kind: 'builtin' });
        expect(result.reason).toBe('Docker not available');
      });

      it('throws PreflightError when preferredDockerAgent is goose but Anthropic OAuth is the only credential', async () => {
        // Regression: previously, detectCredentials on the goose path only probed the
        // goose provider's API key and never looked at Anthropic OAuth, so OAuth-only
        // users with preferredDockerAgent=goose silently fell back to builtin (which
        // then failed without an API key). authMethod must be checked directly.
        const config = createTestConfig({ anthropicApiKey: '' });
        config.userConfig.preferredDockerAgent = 'goose';
        config.userConfig.gooseProvider = 'anthropic';

        const promise = resolveSessionMode({
          config,
          isDockerAvailable: dockerUnavailable,
          credentialSources: oauthOnlySources,
        });

        await expect(promise).rejects.toThrow(PreflightError);
        await expect(promise).rejects.toThrow(/Docker/);
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
