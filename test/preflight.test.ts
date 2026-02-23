import { describe, it, expect } from 'vitest';
import { resolveSessionMode, PreflightError } from '../src/session/preflight.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { AgentId } from '../src/docker/agent-adapter.js';

function createTestConfig(overrides: { anthropicApiKey?: string } = {}): IronCurtainConfig {
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: '/tmp/ironcurtain-sandbox',
    mcpServers: {
      filesystem: { command: 'echo', args: ['test'] },
    },
    protectedPaths: [],
    generatedDir: '/tmp/test-generated',
    constitutionPath: '/tmp/test-constitution.md',
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
      });

      expect(result.mode).toEqual({ kind: 'docker', agent: 'claude-code' });
      expect(result.reason).toBe('Explicit --agent selection');
    });

    it('throws PreflightError when Docker is unavailable', async () => {
      const promise = resolveSessionMode({
        config: createTestConfig(),
        requestedAgent: 'claude-code' as AgentId,
        isDockerAvailable: dockerUnavailable,
      });

      await expect(promise).rejects.toThrow(PreflightError);
      await expect(promise).rejects.toThrow(/Docker/);
    });

    it('throws PreflightError when API key is missing', async () => {
      const promise = resolveSessionMode({
        config: createTestConfig({ anthropicApiKey: '' }),
        requestedAgent: 'claude-code' as AgentId,
        isDockerAvailable: dockerAvailable,
      });

      await expect(promise).rejects.toThrow(PreflightError);
      await expect(promise).rejects.toThrow(/ANTHROPIC_API_KEY/);
    });

    it('checks Docker before API key (Docker error shown first)', async () => {
      await expect(
        resolveSessionMode({
          config: createTestConfig({ anthropicApiKey: '' }),
          requestedAgent: 'claude-code' as AgentId,
          isDockerAvailable: dockerUnavailable,
        }),
      ).rejects.toThrow(/Docker/);
    });
  });

  describe('auto-detect (no --agent)', () => {
    it('selects Docker when both Docker and API key are available', async () => {
      const result = await resolveSessionMode({
        config: createTestConfig(),
        isDockerAvailable: dockerAvailable,
      });

      expect(result.mode).toEqual({ kind: 'docker', agent: 'claude-code' });
      expect(result.reason).toBe('Docker available, ANTHROPIC_API_KEY set');
    });

    it('falls back to builtin when Docker is unavailable', async () => {
      const result = await resolveSessionMode({
        config: createTestConfig(),
        isDockerAvailable: dockerUnavailable,
      });

      expect(result.mode).toEqual({ kind: 'builtin' });
      expect(result.reason).toBe('Docker not available');
    });

    it('falls back to builtin when API key is missing', async () => {
      const result = await resolveSessionMode({
        config: createTestConfig({ anthropicApiKey: '' }),
        isDockerAvailable: dockerAvailable,
      });

      expect(result.mode).toEqual({ kind: 'builtin' });
      expect(result.reason).toBe('ANTHROPIC_API_KEY not set');
    });

    it('falls back to builtin when both Docker and API key are missing', async () => {
      const result = await resolveSessionMode({
        config: createTestConfig({ anthropicApiKey: '' }),
        isDockerAvailable: dockerUnavailable,
      });

      expect(result.mode).toEqual({ kind: 'builtin' });
    });
  });
});
