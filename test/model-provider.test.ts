import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseModelId, createLanguageModel } from '../src/config/model-provider.js';
import type { ResolvedUserConfig } from '../src/config/user-config.js';

// Mock all provider packages so tests don't need real API keys
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() =>
    vi.fn((modelId: string) => ({
      modelId,
      provider: 'anthropic',
      specificationVersion: 'v2',
    })),
  ),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() =>
    vi.fn((modelId: string) => ({
      modelId,
      provider: 'google',
      specificationVersion: 'v2',
    })),
  ),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() =>
    vi.fn((modelId: string) => ({
      modelId,
      provider: 'openai',
      specificationVersion: 'v2',
    })),
  ),
}));

function createTestUserConfig(overrides: Partial<ResolvedUserConfig> = {}): ResolvedUserConfig {
  return {
    agentModelId: 'anthropic:claude-sonnet-4-6',
    policyModelId: 'anthropic:claude-sonnet-4-6',
    anthropicApiKey: 'test-anthropic-key',
    googleApiKey: 'test-google-key',
    openaiApiKey: 'test-openai-key',
    anthropicBaseUrl: '',
    openaiBaseUrl: '',
    googleBaseUrl: '',
    escalationTimeoutSeconds: 300,
    resourceBudget: {
      maxTotalTokens: 1_000_000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5.0,
      warnThresholdPercent: 80,
    },
    autoCompact: {
      enabled: true,
      thresholdTokens: 160_000,
      keepRecentMessages: 10,
      summaryModelId: 'anthropic:claude-haiku-4-5',
    },
    autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
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

  it('treats unknown prefix as part of model ID with default provider', () => {
    // "unknown:model-id" is not a known provider, so the whole string is the model ID
    const result = parseModelId('unknown:model-id');
    expect(result).toEqual({ provider: 'anthropic', modelId: 'unknown:model-id' });
  });

  it('handles Ollama-style model tags with colons', () => {
    // Ollama tags like "qwen3.5-uncensored:35b" use colon for name:tag
    const result = parseModelId('jaahas/qwen3.5-uncensored:35b');
    expect(result).toEqual({ provider: 'anthropic', modelId: 'jaahas/qwen3.5-uncensored:35b' });
  });

  it('throws on empty model ID after known provider colon', () => {
    expect(() => parseModelId('anthropic:')).toThrow(/Empty model ID.*Expected format/);
  });

  it('handles model IDs with colons in the model name', () => {
    // Only the first colon separates provider from model when prefix is a known provider
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
    expect(createAnthropic).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-anthropic-key' }));
    expect(model).toHaveProperty('modelId', 'claude-sonnet-4-6');
  });

  it('creates a Google model with API key from config', async () => {
    const config = createTestUserConfig();
    const model = await createLanguageModel('google:gemini-2.0-flash', config);

    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-google-key' }));
    expect(model).toHaveProperty('modelId', 'gemini-2.0-flash');
  });

  it('creates an OpenAI model with API key from config', async () => {
    const config = createTestUserConfig();
    const model = await createLanguageModel('openai:gpt-4o', config);

    const { createOpenAI } = await import('@ai-sdk/openai');
    expect(createOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-openai-key' }));
    expect(model).toHaveProperty('modelId', 'gpt-4o');
  });

  it('passes undefined for API key when config key is empty', async () => {
    const config = createTestUserConfig({ anthropicApiKey: '' });
    await createLanguageModel('anthropic:claude-sonnet-4-6', config);

    const { createAnthropic } = await import('@ai-sdk/anthropic');
    expect(createAnthropic).toHaveBeenCalledWith(expect.objectContaining({ apiKey: undefined }));
  });

  it('defaults bare model IDs to anthropic', async () => {
    const config = createTestUserConfig();
    const model = await createLanguageModel('claude-sonnet-4-6', config);

    const { createAnthropic } = await import('@ai-sdk/anthropic');
    expect(createAnthropic).toHaveBeenCalled();
    expect(model).toHaveProperty('modelId', 'claude-sonnet-4-6');
  });

  it('treats unknown prefix as model ID on default provider', async () => {
    const config = createTestUserConfig();
    const model = await createLanguageModel('mistral:model', config);

    // "mistral" is not a known provider, so the full string becomes the model ID
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    expect(createAnthropic).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-anthropic-key' }));
    expect(model).toHaveProperty('modelId', 'mistral:model');
  });

  it('passes baseURL to Anthropic provider when configured', async () => {
    const config = createTestUserConfig({ anthropicBaseUrl: 'https://gateway.example.com' });
    await createLanguageModel('anthropic:claude-sonnet-4-6', config);

    const { createAnthropic } = await import('@ai-sdk/anthropic');
    expect(createAnthropic).toHaveBeenCalledWith(expect.objectContaining({ baseURL: 'https://gateway.example.com' }));
  });

  it('passes baseURL to Google provider when configured', async () => {
    const config = createTestUserConfig({ googleBaseUrl: 'https://google-gateway.example.com' });
    await createLanguageModel('google:gemini-2.0-flash', config);

    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://google-gateway.example.com' }),
    );
  });

  it('passes baseURL to OpenAI provider when configured', async () => {
    const config = createTestUserConfig({ openaiBaseUrl: 'https://openai-gateway.example.com' });
    await createLanguageModel('openai:gpt-4o', config);

    const { createOpenAI } = await import('@ai-sdk/openai');
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://openai-gateway.example.com' }),
    );
  });

  it('passes undefined baseURL when not configured', async () => {
    const config = createTestUserConfig();
    await createLanguageModel('anthropic:claude-sonnet-4-6', config);

    const { createAnthropic } = await import('@ai-sdk/anthropic');
    expect(createAnthropic).toHaveBeenCalledWith(expect.objectContaining({ baseURL: undefined }));
  });

  it('passes proxy fetch when HTTPS_PROXY is set', async () => {
    const original = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://test-proxy:8080';
    try {
      const config = createTestUserConfig();
      await createLanguageModel('anthropic:claude-sonnet-4-6', config);
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      expect(createAnthropic).toHaveBeenCalledWith(expect.objectContaining({ fetch: expect.any(Function) }));
    } finally {
      if (original) process.env.HTTPS_PROXY = original;
      else delete process.env.HTTPS_PROXY;
    }
  });

  it('omits proxy fetch when no proxy env vars are set', async () => {
    const origHttps = process.env.HTTPS_PROXY;
    const origHttp = process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    try {
      // Use vi.resetModules + dynamic import to get a fresh module without cached proxy
      vi.resetModules();
      const { createLanguageModel: freshCreateLanguageModel } = await import('../src/config/model-provider.js');
      const config = createTestUserConfig();
      await freshCreateLanguageModel('anthropic:claude-sonnet-4-6', config);
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      expect(createAnthropic).toHaveBeenCalledWith(expect.objectContaining({ fetch: undefined }));
    } finally {
      if (origHttps) process.env.HTTPS_PROXY = origHttps;
      if (origHttp) process.env.HTTP_PROXY = origHttp;
    }
  });
});
