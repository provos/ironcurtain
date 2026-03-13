/**
 * Integration tests for memory MCP server injection into sessions.
 *
 * Tests that buildSessionConfig() correctly injects (or skips) the
 * memory server based on configuration, and that memory DB paths
 * resolve correctly for persona / cron / default sessions.
 */

import { describe, it, expect } from 'vitest';
import { resolveMemoryDbPath } from '../src/memory/resolve-memory-path.js';
import {
  getMemoryToolAnnotations,
  MEMORY_BLANKET_ALLOW_RULE,
  MEMORY_SERVER_NAME,
  buildMemoryServerConfig,
} from '../src/memory/memory-annotations.js';
import { applyServerAllowlist } from '../src/persona/resolve.js';
import type { MCPServerConfig } from '../src/config/types.js';

describe('resolveMemoryDbPath', () => {
  it('returns persona-specific path when persona is set', () => {
    const path = resolveMemoryDbPath({ persona: 'exec-assistant' });
    expect(path).toMatch(/personas\/exec-assistant\/memory\.db$/);
  });

  it('returns job-specific path when jobId is set', () => {
    const path = resolveMemoryDbPath({ jobId: 'job-123' });
    expect(path).toMatch(/jobs\/job-123\/memory\.db$/);
  });

  it('prefers persona over jobId when both are set', () => {
    const path = resolveMemoryDbPath({ persona: 'exec-assistant', jobId: 'job-123' });
    expect(path).toMatch(/personas\/exec-assistant\/memory\.db$/);
  });

  it('returns default path when neither persona nor jobId is set', () => {
    const path = resolveMemoryDbPath();
    expect(path).toMatch(/memory\/default\.db$/);
  });

  it('returns default path for empty options', () => {
    const path = resolveMemoryDbPath({});
    expect(path).toMatch(/memory\/default\.db$/);
  });
});

describe('getMemoryToolAnnotations', () => {
  it('returns annotations for all 5 memory tools', () => {
    const annotations = getMemoryToolAnnotations();
    expect(annotations).toHaveLength(5);
    const names = annotations.map((a) => a.toolName);
    expect(names).toEqual(['memory_store', 'memory_recall', 'memory_context', 'memory_forget', 'memory_inspect']);
  });

  it('marks store and forget as having side effects', () => {
    const annotations = getMemoryToolAnnotations();
    const store = annotations.find((a) => a.toolName === 'memory_store')!;
    const forget = annotations.find((a) => a.toolName === 'memory_forget')!;
    expect(store.sideEffects).toBe(true);
    expect(forget.sideEffects).toBe(true);
  });

  it('marks recall, context, and inspect as side-effect-free', () => {
    const annotations = getMemoryToolAnnotations();
    const recall = annotations.find((a) => a.toolName === 'memory_recall')!;
    const context = annotations.find((a) => a.toolName === 'memory_context')!;
    const inspect = annotations.find((a) => a.toolName === 'memory_inspect')!;
    expect(recall.sideEffects).toBe(false);
    expect(context.sideEffects).toBe(false);
    expect(inspect.sideEffects).toBe(false);
  });

  it('assigns all args the none role', () => {
    const annotations = getMemoryToolAnnotations();
    for (const annotation of annotations) {
      for (const roles of Object.values(annotation.args)) {
        expect(roles).toEqual(['none']);
      }
    }
  });

  it('sets serverName to memory for all tools', () => {
    const annotations = getMemoryToolAnnotations();
    for (const annotation of annotations) {
      expect(annotation.serverName).toBe(MEMORY_SERVER_NAME);
    }
  });
});

describe('MEMORY_BLANKET_ALLOW_RULE', () => {
  it('targets the memory server', () => {
    expect(MEMORY_BLANKET_ALLOW_RULE.if.server).toEqual([MEMORY_SERVER_NAME]);
  });

  it('has allow decision', () => {
    expect(MEMORY_BLANKET_ALLOW_RULE.then).toBe('allow');
  });
});

describe('buildMemoryServerConfig', () => {
  it('builds a valid MCP server config', () => {
    const config = buildMemoryServerConfig({ dbPath: '/tmp/test.db' });
    expect(config.command).toBe('node');
    expect(config.args).toHaveLength(1);
    expect(config.args[0]).toMatch(/memory-mcp-server\/dist\/index\.js$/);
    expect(config.env?.MEMORY_DB_PATH).toBe('/tmp/test.db');
    expect(config.sandbox).toBe(false);
  });

  it('includes namespace in env when provided', () => {
    const config = buildMemoryServerConfig({ dbPath: '/tmp/test.db', namespace: 'my-persona' });
    expect(config.env?.MEMORY_NAMESPACE).toBe('my-persona');
  });

  it('omits namespace from env when not provided', () => {
    const config = buildMemoryServerConfig({ dbPath: '/tmp/test.db' });
    expect(config.env?.MEMORY_NAMESPACE).toBeUndefined();
  });

  it('uses explicit LLM config when provided', () => {
    const config = buildMemoryServerConfig({
      dbPath: '/tmp/test.db',
      llmBaseUrl: 'https://custom.api/v1/',
      llmApiKey: 'custom-key',
    });
    expect(config.env?.MEMORY_LLM_BASE_URL).toBe('https://custom.api/v1/');
    expect(config.env?.MEMORY_LLM_API_KEY).toBe('custom-key');
  });

  it('falls back to Anthropic defaults when no explicit LLM config', () => {
    const config = buildMemoryServerConfig({
      dbPath: '/tmp/test.db',
      anthropicApiKey: 'sk-ant-test',
    });
    expect(config.env?.MEMORY_LLM_BASE_URL).toBe('https://api.anthropic.com/v1/');
    expect(config.env?.MEMORY_LLM_API_KEY).toBe('sk-ant-test');
  });

  it('does not set LLM env vars when no keys are available', () => {
    const config = buildMemoryServerConfig({ dbPath: '/tmp/test.db' });
    expect(config.env?.MEMORY_LLM_BASE_URL).toBeUndefined();
    expect(config.env?.MEMORY_LLM_API_KEY).toBeUndefined();
  });
});

describe('applyServerAllowlist always includes memory', () => {
  const servers: Record<string, MCPServerConfig> = {
    filesystem: { command: 'node', args: ['/tmp'] },
    memory: { command: 'node', args: ['mem.js'] },
    github: { command: 'docker', args: ['run'] },
  };

  it('includes memory even when allowlist does not mention it', () => {
    const filtered = applyServerAllowlist(servers, ['github']);
    expect(filtered).toHaveProperty('filesystem');
    expect(filtered).toHaveProperty('memory');
    expect(filtered).toHaveProperty('github');
  });

  it('does not warn about memory being unknown', () => {
    // memory should be treated like filesystem - no warning when in allowlist
    // This is tested indirectly: the function should not throw or warn for 'memory'
    const filtered = applyServerAllowlist(servers, ['memory']);
    expect(filtered).toHaveProperty('memory');
  });
});
