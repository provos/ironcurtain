import { describe, it, expect } from 'vitest';
import { getLLMClient, llmComplete, judgeMemoryRelation } from '../src/llm/client.js';
import type { MemoryConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';

function configWithoutLLM(): MemoryConfig {
  return {
    ...loadConfig({}),
    llmApiKey: null,
    llmBaseUrl: null,
  };
}

describe('getLLMClient', () => {
  it('returns null when no LLM key or URL configured', () => {
    const client = getLLMClient(configWithoutLLM());
    expect(client).toBeNull();
  });

  it('creates a client when API key is set', () => {
    const config = {
      ...configWithoutLLM(),
      llmApiKey: 'test-key',
      llmBaseUrl: 'http://localhost:1234/v1',
    };
    const client = getLLMClient(config);
    expect(client).not.toBeNull();
  });

  it('creates a client when only base URL is set (Ollama)', () => {
    const config = {
      ...configWithoutLLM(),
      llmBaseUrl: 'http://localhost:11434/v1',
    };
    const client = getLLMClient(config);
    expect(client).not.toBeNull();
  });
});

describe('llmComplete', () => {
  it('returns null when no LLM configured', async () => {
    const result = await llmComplete(configWithoutLLM(), 'system prompt', 'user prompt');
    expect(result).toBeNull();
  });
});

describe('judgeMemoryRelation', () => {
  it('returns distinct when no LLM configured', async () => {
    const result = await judgeMemoryRelation(configWithoutLLM(), 'new memory', 'existing memory');
    expect(result).toBe('distinct');
  });
});
