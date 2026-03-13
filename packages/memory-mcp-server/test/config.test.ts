import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = loadConfig({});
    expect(config.namespace).toBe('default');
    expect(config.embeddingModel).toBe('Xenova/bge-base-en-v1.5');
    expect(config.embeddingDtype).toBe('q8');
    expect(config.llmBaseUrl).toBeNull();
    expect(config.llmApiKey).toBeNull();
    expect(config.llmModel).toBe('claude-haiku-4-5-20251001');
    expect(config.decayThreshold).toBe(0.05);
    expect(config.maintenanceInterval).toBe(50);
    expect(config.compactionMinGroup).toBe(10);
    expect(config.defaultTokenBudget).toBe(500);
    expect(config.dbPath).toContain('memory-mcp');
  });

  it('reads env vars', () => {
    const config = loadConfig({
      MEMORY_DB_PATH: '/tmp/test.db',
      MEMORY_NAMESPACE: 'project-x',
      MEMORY_LLM_API_KEY: 'sk-test',
      MEMORY_LLM_BASE_URL: 'http://localhost:11434/v1',
      MEMORY_LLM_MODEL: 'llama3',
      MEMORY_DECAY_THRESHOLD: '0.1',
      MEMORY_MAINTENANCE_INTERVAL: '100',
      MEMORY_DEFAULT_TOKEN_BUDGET: '1000',
    });

    expect(config.dbPath).toBe('/tmp/test.db');
    expect(config.namespace).toBe('project-x');
    expect(config.llmApiKey).toBe('sk-test');
    expect(config.llmBaseUrl).toBe('http://localhost:11434/v1');
    expect(config.llmModel).toBe('llama3');
    expect(config.decayThreshold).toBe(0.1);
    expect(config.maintenanceInterval).toBe(100);
    expect(config.defaultTokenBudget).toBe(1000);
  });
});
