import { describe, it, expect } from 'vitest';
import { resolveSessionMode, PreflightError } from '../src/session/preflight.js';
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
    },
  };
}

const dockerAvailable = (): Promise<boolean> => Promise.resolve(true);
const dockerUnavailable = (): Promise<boolean> => Promise.resolve(false);

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
      expect(result.reason).toBe('Docker available, ANTHROPIC_API_KEY detected');
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
  });
});
