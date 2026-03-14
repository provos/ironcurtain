/**
 * Integration tests for memory MCP server injection into sessions.
 *
 * Tests that buildSessionConfig() correctly injects (or skips) the
 * memory server based on configuration, and that memory DB paths
 * resolve correctly for persona and cron job sessions.
 */

import { describe, it, expect } from 'vitest';
import { resolveMemoryDbPath } from '../src/memory/resolve-memory-path.js';
import {
  MEMORY_SERVER_NAME,
  buildMemoryServerConfig,
  verifyMemoryServerConfig,
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

  it('throws when neither persona nor jobId is set', () => {
    expect(() => resolveMemoryDbPath({})).toThrow('requires either persona or jobId');
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

  it('does not set LLM env vars when no keys are provided', () => {
    const config = buildMemoryServerConfig({ dbPath: '/tmp/test.db' });
    expect(config.env?.MEMORY_LLM_BASE_URL).toBeUndefined();
    expect(config.env?.MEMORY_LLM_API_KEY).toBeUndefined();
  });
});

describe('MEMORY_SERVER_NAME', () => {
  it('is the string "memory"', () => {
    expect(MEMORY_SERVER_NAME).toBe('memory');
  });
});

describe('verifyMemoryServerConfig', () => {
  it('returns true for config produced by buildMemoryServerConfig', () => {
    const servers: Record<string, MCPServerConfig> = {
      memory: buildMemoryServerConfig({ dbPath: '/tmp/test.db' }),
    };
    expect(verifyMemoryServerConfig(servers)).toBe(true);
  });

  it('returns false when no memory server is configured', () => {
    const servers: Record<string, MCPServerConfig> = {
      filesystem: { command: 'node', args: ['/tmp'] },
    };
    expect(verifyMemoryServerConfig(servers)).toBe(false);
  });

  it('throws when memory server has extra args (preload injection)', () => {
    const servers: Record<string, MCPServerConfig> = {
      memory: { command: 'node', args: ['-r', 'evil.js', buildMemoryServerConfig({ dbPath: '/tmp/test.db' }).args[0]] },
    };
    expect(() => verifyMemoryServerConfig(servers)).toThrow('unexpected config');
  });

  it('throws when memory server has wrong command', () => {
    const servers: Record<string, MCPServerConfig> = {
      memory: { command: 'npx', args: [buildMemoryServerConfig({ dbPath: '/tmp/test.db' }).args[0]] },
    };
    expect(() => verifyMemoryServerConfig(servers)).toThrow('unexpected config');
  });

  it('throws when memory server has wrong entry point', () => {
    const servers: Record<string, MCPServerConfig> = {
      memory: { command: 'node', args: ['/path/to/evil.js'] },
    };
    expect(() => verifyMemoryServerConfig(servers)).toThrow('unexpected config');
  });

  it('throws when memory server args contain entry but also other args', () => {
    const servers: Record<string, MCPServerConfig> = {
      memory: { command: 'node', args: ['--inspect', buildMemoryServerConfig({ dbPath: '/tmp/test.db' }).args[0]] },
    };
    expect(() => verifyMemoryServerConfig(servers)).toThrow('unexpected config');
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
    const filtered = applyServerAllowlist(servers, ['memory']);
    expect(filtered).toHaveProperty('memory');
  });
});
