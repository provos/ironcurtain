import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadUserConfig, USER_CONFIG_DEFAULTS } from '../src/config/user-config.js';

describe('loadUserConfig', () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-userconfig-'));
    originalHome = process.env.IRONCURTAIN_HOME;
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.IRONCURTAIN_HOME = testHome;
    // Clear API key to isolate tests from env
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.IRONCURTAIN_HOME = originalHome;
    } else {
      delete process.env.IRONCURTAIN_HOME;
    }
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  it('returns defaults when config file does not exist', () => {
    const config = loadUserConfig();

    expect(config.agentModelId).toBe(USER_CONFIG_DEFAULTS.agentModelId);
    expect(config.policyModelId).toBe(USER_CONFIG_DEFAULTS.policyModelId);
    expect(config.escalationTimeoutSeconds).toBe(USER_CONFIG_DEFAULTS.escalationTimeoutSeconds);
    expect(config.apiKey).toBe('');
  });

  it('auto-creates config file with defaults when missing', () => {
    loadUserConfig();

    const configPath = resolve(testHome, 'config.json');
    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(content.agentModelId).toBe(USER_CONFIG_DEFAULTS.agentModelId);
    expect(content.policyModelId).toBe(USER_CONFIG_DEFAULTS.policyModelId);
    expect(content.escalationTimeoutSeconds).toBe(USER_CONFIG_DEFAULTS.escalationTimeoutSeconds);
    // apiKey intentionally omitted from auto-created file
    expect(content.apiKey).toBeUndefined();
  });

  it('logs creation message to stderr when auto-creating', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    loadUserConfig();

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Created default config at'),
    );
    stderrSpy.mockRestore();
  });

  it('parses valid config and merges with defaults', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    const config = loadUserConfig();

    expect(config.agentModelId).toBe('claude-opus-4-6');
    // Other fields should use defaults
    expect(config.policyModelId).toBe(USER_CONFIG_DEFAULTS.policyModelId);
    expect(config.escalationTimeoutSeconds).toBe(USER_CONFIG_DEFAULTS.escalationTimeoutSeconds);
  });

  it('reads all fields from config file', () => {
    writeConfigFile({
      agentModelId: 'claude-opus-4-6',
      policyModelId: 'claude-haiku-3-5',
      apiKey: 'sk-test-config-key',
      escalationTimeoutSeconds: 60,
    });

    const config = loadUserConfig();

    expect(config.agentModelId).toBe('claude-opus-4-6');
    expect(config.policyModelId).toBe('claude-haiku-3-5');
    expect(config.apiKey).toBe('sk-test-config-key');
    expect(config.escalationTimeoutSeconds).toBe(60);
  });

  it('ANTHROPIC_API_KEY env var overrides config file apiKey', () => {
    writeConfigFile({ apiKey: 'sk-from-config' });
    process.env.ANTHROPIC_API_KEY = 'sk-from-env';

    const config = loadUserConfig();

    expect(config.apiKey).toBe('sk-from-env');
  });

  it('uses config file apiKey when env var is not set', () => {
    writeConfigFile({ apiKey: 'sk-from-config' });
    delete process.env.ANTHROPIC_API_KEY;

    const config = loadUserConfig();

    expect(config.apiKey).toBe('sk-from-config');
  });

  it('throws on invalid JSON', () => {
    writeRawConfigFile('{ invalid json }');

    expect(() => loadUserConfig()).toThrow(/Invalid JSON/);
  });

  it('throws on invalid agentModelId (empty string)', () => {
    writeConfigFile({ agentModelId: '' });

    expect(() => loadUserConfig()).toThrow(/agentModelId/);
  });

  it('throws on invalid escalationTimeoutSeconds (too low)', () => {
    writeConfigFile({ escalationTimeoutSeconds: 10 });

    expect(() => loadUserConfig()).toThrow(/escalationTimeoutSeconds/);
  });

  it('throws on invalid escalationTimeoutSeconds (too high)', () => {
    writeConfigFile({ escalationTimeoutSeconds: 1000 });

    expect(() => loadUserConfig()).toThrow(/escalationTimeoutSeconds/);
  });

  it('throws on invalid escalationTimeoutSeconds (not integer)', () => {
    writeConfigFile({ escalationTimeoutSeconds: 60.5 });

    expect(() => loadUserConfig()).toThrow(/escalationTimeoutSeconds/);
  });

  it('throws on invalid field type (number for agentModelId)', () => {
    writeRawConfigFile(JSON.stringify({ agentModelId: 123 }));

    expect(() => loadUserConfig()).toThrow(/agentModelId/);
  });

  it('warns about unknown fields to stderr', () => {
    writeConfigFile({ unknownField: 'value' } as Record<string, unknown>);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    loadUserConfig();

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown field "unknownField"'),
    );
    stderrSpy.mockRestore();
  });

  it('does not throw on unknown fields', () => {
    writeConfigFile({ extraField: true, anotherExtra: 42 } as Record<string, unknown>);

    // Should not throw, just warn
    expect(() => loadUserConfig()).not.toThrow();
  });

  it('missing optional fields use defaults', () => {
    writeConfigFile({});

    const config = loadUserConfig();

    expect(config.agentModelId).toBe(USER_CONFIG_DEFAULTS.agentModelId);
    expect(config.policyModelId).toBe(USER_CONFIG_DEFAULTS.policyModelId);
    expect(config.escalationTimeoutSeconds).toBe(USER_CONFIG_DEFAULTS.escalationTimeoutSeconds);
    expect(config.apiKey).toBe('');
  });

  it('accepts boundary escalation timeout values', () => {
    writeConfigFile({ escalationTimeoutSeconds: 30 });
    expect(loadUserConfig().escalationTimeoutSeconds).toBe(30);

    writeConfigFile({ escalationTimeoutSeconds: 600 });
    expect(loadUserConfig().escalationTimeoutSeconds).toBe(600);
  });

  it('creates parent directory if it does not exist', () => {
    const nestedHome = resolve(testHome, 'nested', 'deep');
    process.env.IRONCURTAIN_HOME = nestedHome;

    const config = loadUserConfig();

    expect(config.agentModelId).toBe(USER_CONFIG_DEFAULTS.agentModelId);
    // Verify file was created in nested directory
    const content = readFileSync(resolve(nestedHome, 'config.json'), 'utf-8');
    expect(JSON.parse(content)).toHaveProperty('agentModelId');
  });

  it('includes config path in error messages', () => {
    writeRawConfigFile('not json');

    expect(() => loadUserConfig()).toThrow(resolve(testHome, 'config.json'));
  });

  // --- Test helpers ---

  function writeRawConfigFile(content: string): void {
    mkdirSync(testHome, { recursive: true });
    writeFileSync(resolve(testHome, 'config.json'), content);
  }

  function writeConfigFile(config: Record<string, unknown>): void {
    writeRawConfigFile(JSON.stringify(config, null, 2));
  }
});
