import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseModelId, createLanguageModel } from '../src/config/model-provider.js';
import type { ResolvedUserConfig } from '../src/config/user-config.js';

// Mock all provider packages so tests don't need real API keys
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn((modelId: string) => ({
    modelId,
    provider: 'anthropic',
    specificationVersion: 'v2',
  }))),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn((modelId: string) => ({
    modelId,
    provider: 'google',
    specificationVersion: 'v2',
  }))),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn((modelId: string) => ({
    modelId,
    provider: 'openai',
    specificationVersion: 'v2',
  }))),
}));

function createTestUserConfig(overrides: Partial<ResolvedUserConfig> = {}): ResolvedUserConfig {
  return {
    agentModelId: 'anthropic:claude-sonnet-4-6',
    policyModelId: 'anthropic:claude-sonnet-4-6',
    anthropicApiKey: 'test-anthropic-key',
    googleApiKey: 'test-google-key',
    openaiApiKey: 'test-openai-key',
    escalationTimeoutSeconds: 300,
    resourceBudget: {
      maxTotalTokens: 1_000_000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5.00,
      warnThresholdPercent: 80,
    },
    ...overrides,
  };
}

describe('parseModelId', () => {
  it('parses anthropic:model-id', () => {
    const result = parseModelId('anthropic:claude-sonnet-4-6');
    expect(result).toEqual({ provider: 'anthropic', modelId: 'claude-sonnet-4-6' });
  });

  it('parses google:model-id', () => {
    const result = parseModelId('google:gemini-2.0-flash');
    expect(result).toEqual({ provider: 'google', modelId: 'gemini-2.0-flash' });
  });

  it('parses openai:model-id', () => {
    const result = parseModelId('openai:gpt-4o');
    expect(result).toEqual({ provider: 'openai', modelId: 'gpt-4o' });
  });

  it('defaults bare model IDs to anthropic (backward compat)', () => {
    const result = parseModelId('claude-sonnet-4-6');
    expect(result).toEqual({ provider: 'anthropic', modelId: 'claude-sonnet-4-6' });
  });

  it('throws on unknown provider prefix', () => {
    expect(() => parseModelId('unknown:model-id')).toThrow(
      /Unknown model provider "unknown".*Supported providers: anthropic, google, openai/,
    );
  });

  it('throws on empty model ID after colon', () => {
    expect(() => parseModelId('anthropic:')).toThrow(
      /Empty model ID.*Expected format/,
    );
  });

  it('handles model IDs with colons in the model name', () => {
    // Only the first colon separates provider from model
    const result = parseModelId('openai:ft:gpt-4o:custom');
    expect(result).toEqual({ provider: 'openai', modelId: 'ft:gpt-4o:custom' });
  });
});

describe('createLanguageModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an Anthropic model with API key from config', async () => {
    const config = createTestUserConfig();
    const model = await createLanguageModel('anthropic:claude-sonnet-4-6', config);

    const { createAnthropic } = await import('@ai-sdk/anthropic');
    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: 'test-anthropic-key' });
    expect(model).toHaveProperty('modelId', 'claude-sonnet-4-6');
  });

  it('creates a Google model with API key from config', async () => {
    const config = createTestUserConfig();
    const model = await createLanguageModel('google:gemini-2.0-flash', config);

    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: 'test-google-key' });
    expect(model).toHaveProperty('modelId', 'gemini-2.0-flash');
  });

  it('creates an OpenAI model with API key from config', async () => {
    const config = createTestUserConfig();
    const model = await createLanguageModel('openai:gpt-4o', config);

    const { createOpenAI } = await import('@ai-sdk/openai');
    expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'test-openai-key' });
    expect(model).toHaveProperty('modelId', 'gpt-4o');
  });

  it('passes undefined for API key when config key is empty', async () => {
    const config = createTestUserConfig({ anthropicApiKey: '' });
    await createLanguageModel('anthropic:claude-sonnet-4-6', config);

    const { createAnthropic } = await import('@ai-sdk/anthropic');
    expect(createAnthropic).toHaveBeenCalledWith({ apiKey: undefined });
  });

  it('defaults bare model IDs to anthropic', async () => {
    const config = createTestUserConfig();
    const model = await createLanguageModel('claude-sonnet-4-6', config);

    const { createAnthropic } = await import('@ai-sdk/anthropic');
    expect(createAnthropic).toHaveBeenCalled();
    expect(model).toHaveProperty('modelId', 'claude-sonnet-4-6');
  });

  it('throws on unknown provider', async () => {
    const config = createTestUserConfig();
    await expect(
      createLanguageModel('mistral:model', config),
    ).rejects.toThrow(/Unknown model provider "mistral"/);
  });
});
