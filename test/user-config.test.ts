import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadUserConfig, saveUserConfig, validateModelId, USER_CONFIG_DEFAULTS } from '../src/config/user-config.js';

/** Env var names that need save/restore between tests. */
const ENV_VARS_TO_ISOLATE = [
  'IRONCURTAIN_HOME',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENAI_API_KEY',
] as const;

describe('loadUserConfig', () => {
  let testHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-userconfig-'));
    // Save and clear all env vars that affect config loading
    for (const key of ENV_VARS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.IRONCURTAIN_HOME = testHome;
  });

  afterEach(() => {
    // Restore all saved env vars
    for (const key of ENV_VARS_TO_ISOLATE) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  it('returns defaults when config file does not exist', () => {
    const config = loadUserConfig();

    expect(config.agentModelId).toBe(USER_CONFIG_DEFAULTS.agentModelId);
    expect(config.policyModelId).toBe(USER_CONFIG_DEFAULTS.policyModelId);
    expect(config.escalationTimeoutSeconds).toBe(USER_CONFIG_DEFAULTS.escalationTimeoutSeconds);
    expect(config.anthropicApiKey).toBe('');
  });

  it('auto-creates config file with defaults when missing', () => {
    loadUserConfig();

    const configPath = resolve(testHome, 'config.json');
    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(content.agentModelId).toBe(USER_CONFIG_DEFAULTS.agentModelId);
    expect(content.policyModelId).toBe(USER_CONFIG_DEFAULTS.policyModelId);
    expect(content.escalationTimeoutSeconds).toBe(USER_CONFIG_DEFAULTS.escalationTimeoutSeconds);
    // anthropicApiKey intentionally omitted from auto-created file
    expect(content.anthropicApiKey).toBeUndefined();
  });

  it('logs creation message to stderr when auto-creating', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    loadUserConfig();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Created default config at'));
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
      anthropicApiKey: 'sk-test-config-key',
      escalationTimeoutSeconds: 60,
    });

    const config = loadUserConfig();

    expect(config.agentModelId).toBe('claude-opus-4-6');
    expect(config.policyModelId).toBe('claude-haiku-3-5');
    expect(config.anthropicApiKey).toBe('sk-test-config-key');
    expect(config.escalationTimeoutSeconds).toBe(60);
  });

  it('ANTHROPIC_API_KEY env var overrides config file anthropicApiKey', () => {
    writeConfigFile({ anthropicApiKey: 'sk-from-config' });
    process.env.ANTHROPIC_API_KEY = 'sk-from-env';

    const config = loadUserConfig();

    expect(config.anthropicApiKey).toBe('sk-from-env');
  });

  it('uses config file anthropicApiKey when env var is not set', () => {
    writeConfigFile({ anthropicApiKey: 'sk-from-config' });
    delete process.env.ANTHROPIC_API_KEY;

    const config = loadUserConfig();

    expect(config.anthropicApiKey).toBe('sk-from-config');
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

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('unknown field "unknownField"'));
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
    expect(config.anthropicApiKey).toBe('');
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

  // --- New API key fields ---

  it('new API key fields default to empty string', () => {
    const config = loadUserConfig();

    expect(config.googleApiKey).toBe('');
    expect(config.openaiApiKey).toBe('');
  });

  it('reads googleApiKey and openaiApiKey from config file', () => {
    writeConfigFile({
      googleApiKey: 'test-google-key',
      openaiApiKey: 'test-openai-key',
    });

    const config = loadUserConfig();

    expect(config.googleApiKey).toBe('test-google-key');
    expect(config.openaiApiKey).toBe('test-openai-key');
  });

  it('GOOGLE_GENERATIVE_AI_API_KEY env var overrides config googleApiKey', () => {
    writeConfigFile({ googleApiKey: 'from-config' });
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'from-env';

    const config = loadUserConfig();

    expect(config.googleApiKey).toBe('from-env');
  });

  it('OPENAI_API_KEY env var overrides config openaiApiKey', () => {
    writeConfigFile({ openaiApiKey: 'from-config' });
    process.env.OPENAI_API_KEY = 'from-env';

    const config = loadUserConfig();

    expect(config.openaiApiKey).toBe('from-env');
  });

  // --- Qualified model ID validation ---

  it('accepts qualified model IDs with known providers', () => {
    writeConfigFile({ agentModelId: 'anthropic:claude-sonnet-4-6' });
    expect(() => loadUserConfig()).not.toThrow();

    writeConfigFile({ agentModelId: 'google:gemini-2.0-flash' });
    expect(() => loadUserConfig()).not.toThrow();

    writeConfigFile({ agentModelId: 'openai:gpt-4o' });
    expect(() => loadUserConfig()).not.toThrow();
  });

  it('accepts bare model IDs (no colon prefix)', () => {
    writeConfigFile({ agentModelId: 'claude-sonnet-4-6' });
    expect(() => loadUserConfig()).not.toThrow();
  });

  it('rejects model IDs with unknown provider prefix', () => {
    writeConfigFile({ agentModelId: 'unknown:model-id' });

    expect(() => loadUserConfig()).toThrow(/provider/i);
  });

  it('rejects policyModelId with unknown provider prefix', () => {
    writeConfigFile({ policyModelId: 'mistral:model-id' });

    expect(() => loadUserConfig()).toThrow(/provider/i);
  });

  it('defaults include anthropic: prefix', () => {
    expect(USER_CONFIG_DEFAULTS.agentModelId).toMatch(/^anthropic:/);
    expect(USER_CONFIG_DEFAULTS.policyModelId).toMatch(/^anthropic:/);
  });

  // --- Backfill missing fields ---

  it('backfills missing top-level fields while preserving user values', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    const config = loadUserConfig();
    expect(config.agentModelId).toBe('claude-opus-4-6');

    const onDisk = readConfigFromDisk();
    expect(onDisk.agentModelId).toBe('claude-opus-4-6');
    expect(onDisk.escalationTimeoutSeconds).toBe(USER_CONFIG_DEFAULTS.escalationTimeoutSeconds);
    expect(onDisk.resourceBudget).toEqual(USER_CONFIG_DEFAULTS.resourceBudget);
    expect(onDisk.autoCompact).toEqual(USER_CONFIG_DEFAULTS.autoCompact);
  });

  it('backfills missing nested sub-fields in existing objects', () => {
    writeConfigFile({ resourceBudget: { maxSteps: 100 } });

    loadUserConfig();

    const onDisk = readConfigFromDisk();
    const budget = onDisk.resourceBudget as Record<string, unknown>;
    expect(budget.maxSteps).toBe(100);
    expect(budget.maxTotalTokens).toBe(USER_CONFIG_DEFAULTS.resourceBudget.maxTotalTokens);
    expect(budget.warnThresholdPercent).toBe(USER_CONFIG_DEFAULTS.resourceBudget.warnThresholdPercent);
  });

  it('does not backfill sensitive fields (anthropicApiKey, googleApiKey, openaiApiKey)', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    loadUserConfig();

    const onDisk = readConfigFromDisk();
    expect(onDisk.anthropicApiKey).toBeUndefined();
    expect(onDisk.googleApiKey).toBeUndefined();
    expect(onDisk.openaiApiKey).toBeUndefined();
  });

  it('is idempotent — no write when file already has all fields', () => {
    // First call creates and backfills
    loadUserConfig();
    const configPath = resolve(testHome, 'config.json');
    const contentAfterFirst = readFileSync(configPath, 'utf-8');

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    loadUserConfig();
    stderrSpy.mockRestore();

    const contentAfterSecond = readFileSync(configPath, 'utf-8');
    expect(contentAfterSecond).toBe(contentAfterFirst);
    // Should not log backfill message on second call
    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining('Backfilled config fields'));
  });

  it('logs added fields to stderr during backfill', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    loadUserConfig();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Backfilled config fields'));
    stderrSpy.mockRestore();
  });

  it('preserves JSON formatting (2-space indent, trailing newline)', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    loadUserConfig();

    const raw = readFileSync(resolve(testHome, 'config.json'), 'utf-8');
    expect(raw).toMatch(/^\{/);
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  "agentModelId"');
  });

  it('preserves unknown fields in the file during backfill', () => {
    writeConfigFile({
      agentModelId: 'claude-opus-4-6',
      customField: 'keep-me',
    } as Record<string, unknown>);

    loadUserConfig();

    const onDisk = readConfigFromDisk();
    expect(onDisk.customField).toBe('keep-me');
  });

  it('preserves explicit null values in nested objects during backfill', () => {
    writeRawConfigFile(
      JSON.stringify(
        {
          resourceBudget: { maxSteps: null, maxTotalTokens: 500000 },
        },
        null,
        2,
      ),
    );

    loadUserConfig();

    const onDisk = readConfigFromDisk();
    const budget = onDisk.resourceBudget as Record<string, unknown>;
    expect(budget.maxSteps).toBeNull();
    expect(budget.maxTotalTokens).toBe(500000);
    expect(budget.warnThresholdPercent).toBe(USER_CONFIG_DEFAULTS.resourceBudget.warnThresholdPercent);
  });

  // --- autoApprove config ---

  it('default config has autoApprove.enabled === false', () => {
    const config = loadUserConfig();

    expect(config.autoApprove.enabled).toBe(false);
    expect(config.autoApprove.modelId).toBe(USER_CONFIG_DEFAULTS.autoApprove.modelId);
  });

  it('reads autoApprove enabled and modelId from config file', () => {
    writeConfigFile({
      autoApprove: { enabled: true, modelId: 'anthropic:claude-haiku-4-5' },
    });

    const config = loadUserConfig();

    expect(config.autoApprove.enabled).toBe(true);
    expect(config.autoApprove.modelId).toBe('anthropic:claude-haiku-4-5');
  });

  it('merges partial autoApprove with defaults', () => {
    writeConfigFile({
      autoApprove: { enabled: true },
    });

    const config = loadUserConfig();

    expect(config.autoApprove.enabled).toBe(true);
    expect(config.autoApprove.modelId).toBe(USER_CONFIG_DEFAULTS.autoApprove.modelId);
  });

  it('rejects autoApprove with invalid modelId', () => {
    writeConfigFile({
      autoApprove: { enabled: true, modelId: 'unknown:model' },
    });

    expect(() => loadUserConfig()).toThrow(/provider/i);
  });

  it('backfills autoApprove section when missing from existing config', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    loadUserConfig();

    const onDisk = readConfigFromDisk();
    expect(onDisk.autoApprove).toEqual(USER_CONFIG_DEFAULTS.autoApprove);
  });

  it('backfills missing sub-fields in existing autoApprove object', () => {
    writeConfigFile({ autoApprove: { enabled: true } });

    loadUserConfig();

    const onDisk = readConfigFromDisk();
    const autoApprove = onDisk.autoApprove as Record<string, unknown>;
    expect(autoApprove.enabled).toBe(true);
    expect(autoApprove.modelId).toBe(USER_CONFIG_DEFAULTS.autoApprove.modelId);
  });

  it('skips backfill on invalid JSON (file unchanged)', () => {
    const invalidJson = '{ invalid json }';
    writeRawConfigFile(invalidJson);

    expect(() => loadUserConfig()).toThrow(/Invalid JSON/);

    const raw = readFileSync(resolve(testHome, 'config.json'), 'utf-8');
    expect(raw).toBe(invalidJson);
  });

  // ── webSearch tests ────────────────────────────────────────────────

  it('valid webSearch parses correctly', () => {
    writeConfigFile({
      webSearch: {
        provider: 'brave',
        brave: { apiKey: 'test-brave-key' },
      },
    });

    const config = loadUserConfig();
    expect(config.webSearch.provider).toBe('brave');
    expect(config.webSearch.brave).toEqual({ apiKey: 'test-brave-key' });
  });

  it('invalid webSearch provider is rejected', () => {
    writeRawConfigFile(JSON.stringify({ webSearch: { provider: 'bing' } }, null, 2));

    expect(() => loadUserConfig()).toThrow();
  });

  it('empty webSearch API key is rejected', () => {
    writeConfigFile({
      webSearch: {
        provider: 'brave',
        brave: { apiKey: '' },
      },
    });

    expect(() => loadUserConfig()).toThrow();
  });

  it('webSearch not backfilled (in SENSITIVE_FIELDS)', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    loadUserConfig();

    const onDisk = readConfigFromDisk();
    expect(onDisk.webSearch).toBeUndefined();
  });

  it('webSearch defaults produce provider: null', () => {
    const config = loadUserConfig();

    expect(config.webSearch.provider).toBeNull();
    expect(config.webSearch.brave).toBeNull();
    expect(config.webSearch.tavily).toBeNull();
    expect(config.webSearch.serpapi).toBeNull();
  });

  // ── serverCredentials tests ─────────────────────────────────────────

  it('parses serverCredentials from config file', () => {
    writeConfigFile({
      serverCredentials: {
        git: { GH_TOKEN: 'ghp_xxxx' },
        fetch: { API_KEY: 'key_yyyy' },
      },
    });

    const config = loadUserConfig();
    expect(config.serverCredentials).toEqual({
      git: { GH_TOKEN: 'ghp_xxxx' },
      fetch: { API_KEY: 'key_yyyy' },
    });
  });

  it('defaults serverCredentials to empty object when absent', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    const config = loadUserConfig();
    expect(config.serverCredentials).toEqual({});
  });

  it('rejects empty credential values', () => {
    writeConfigFile({
      serverCredentials: { git: { GH_TOKEN: '' } },
    });

    expect(() => loadUserConfig()).toThrow();
  });

  it('does not backfill serverCredentials (in SENSITIVE_FIELDS)', () => {
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });

    loadUserConfig();

    const content = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
    expect(content.serverCredentials).toBeUndefined();
  });

  // ── Config file permissions tests ─────────────────────────────────

  it('creates config file with 0o600 permissions', () => {
    loadUserConfig();

    const configPath = resolve(testHome, 'config.json');
    const stats = statSync(configPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('warns when config file is group- or world-readable', () => {
    // Pre-create config with insecure permissions
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });
    chmodSync(resolve(testHome, 'config.json'), 0o644);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    loadUserConfig();

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes('readable by other users'))).toBe(true);
    stderrSpy.mockRestore();
  });

  it('does not warn when config file has 0o600 permissions', () => {
    // Pre-create config with secure permissions
    writeConfigFile({ agentModelId: 'claude-opus-4-6' });
    chmodSync(resolve(testHome, 'config.json'), 0o600);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    loadUserConfig();

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes('readable by other users'))).toBe(false);
    stderrSpy.mockRestore();
  });

  // --- Test helpers ---

  function readConfigFromDisk(): Record<string, unknown> {
    return JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
  }

  function writeRawConfigFile(content: string): void {
    mkdirSync(testHome, { recursive: true });
    writeFileSync(resolve(testHome, 'config.json'), content);
  }

  function writeConfigFile(config: Record<string, unknown>): void {
    writeRawConfigFile(JSON.stringify(config, null, 2));
  }
});

describe('saveUserConfig', () => {
  let testHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-saveconfig-'));
    for (const key of ENV_VARS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.IRONCURTAIN_HOME = testHome;
  });

  afterEach(() => {
    for (const key of ENV_VARS_TO_ISOLATE) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  it('creates config when none exists', () => {
    saveUserConfig({ agentModelId: 'anthropic:claude-opus-4-6' });

    const onDisk = readConfigFromDisk();
    expect(onDisk.agentModelId).toBe('anthropic:claude-opus-4-6');
  });

  it('merges new fields into existing config', () => {
    writeConfigFile({ agentModelId: 'anthropic:claude-sonnet-4-6' });

    saveUserConfig({ policyModelId: 'google:gemini-2.5-flash' });

    const onDisk = readConfigFromDisk();
    expect(onDisk.agentModelId).toBe('anthropic:claude-sonnet-4-6');
    expect(onDisk.policyModelId).toBe('google:gemini-2.5-flash');
  });

  it('preserves existing fields not in changes', () => {
    writeConfigFile({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 120,
    });

    saveUserConfig({ agentModelId: 'anthropic:claude-opus-4-6' });

    const onDisk = readConfigFromDisk();
    expect(onDisk.agentModelId).toBe('anthropic:claude-opus-4-6');
    expect(onDisk.escalationTimeoutSeconds).toBe(120);
  });

  it('handles nested object merging (resourceBudget sub-fields)', () => {
    writeConfigFile({
      resourceBudget: { maxSteps: 100, maxTotalTokens: 500000 },
    });

    saveUserConfig({ resourceBudget: { maxSteps: 300 } });

    const onDisk = readConfigFromDisk();
    const budget = onDisk.resourceBudget as Record<string, unknown>;
    expect(budget.maxSteps).toBe(300);
    expect(budget.maxTotalTokens).toBe(500000);
  });

  it('preserves null values for disabled budget fields', () => {
    writeConfigFile({
      resourceBudget: { maxSteps: 100 },
    });

    saveUserConfig({ resourceBudget: { maxSteps: null } });

    const onDisk = readConfigFromDisk();
    const budget = onDisk.resourceBudget as Record<string, unknown>;
    expect(budget.maxSteps).toBeNull();
  });

  it('validates before writing (rejects invalid model IDs)', () => {
    writeConfigFile({ agentModelId: 'anthropic:claude-sonnet-4-6' });

    expect(() => saveUserConfig({ agentModelId: 'unknown:bad-model' })).toThrow(/provider/i);

    // File should be unchanged
    const onDisk = readConfigFromDisk();
    expect(onDisk.agentModelId).toBe('anthropic:claude-sonnet-4-6');
  });

  it('preserves unknown fields in existing config', () => {
    writeConfigFile({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      customField: 'keep-me',
    });

    saveUserConfig({ policyModelId: 'google:gemini-2.5-flash' });

    const onDisk = readConfigFromDisk();
    expect(onDisk.customField).toBe('keep-me');
    expect(onDisk.policyModelId).toBe('google:gemini-2.5-flash');
  });

  it('writes with 2-space indent and trailing newline', () => {
    saveUserConfig({ agentModelId: 'anthropic:claude-opus-4-6' });

    const raw = readFileSync(resolve(testHome, 'config.json'), 'utf-8');
    expect(raw).toContain('  "agentModelId"');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('sets owner-only permissions (0600) on saved config file', () => {
    saveUserConfig({ agentModelId: 'anthropic:claude-opus-4-6' });

    const configPath = resolve(testHome, 'config.json');
    const mode = statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  function readConfigFromDisk(): Record<string, unknown> {
    return JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
  }

  function writeConfigFile(config: Record<string, unknown>): void {
    mkdirSync(testHome, { recursive: true });
    writeFileSync(resolve(testHome, 'config.json'), JSON.stringify(config, null, 2));
  }
});

describe('validateModelId', () => {
  it('returns undefined for valid model IDs', () => {
    expect(validateModelId('anthropic:claude-sonnet-4-6')).toBeUndefined();
    expect(validateModelId('google:gemini-2.5-flash')).toBeUndefined();
    expect(validateModelId('openai:gpt-4o')).toBeUndefined();
    expect(validateModelId('claude-sonnet-4-6')).toBeUndefined();
  });

  it('returns error message for invalid model IDs', () => {
    expect(validateModelId('unknown:model')).toBeDefined();
    expect(validateModelId('')).toBeDefined();
  });
});
