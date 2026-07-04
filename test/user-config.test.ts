import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadUserConfig,
  saveUserConfig,
  userConfigSchema,
  validateModelId,
  resolveActiveProfile,
  USER_CONFIG_DEFAULTS,
  DEFAULT_MODEL_MAP,
  DEFAULT_GLM_SLUG,
} from '../src/config/user-config.js';
import type { ResolvedOpenRouterProfile } from '../src/config/user-config.js';

/** Env var names that need save/restore between tests. */
const ENV_VARS_TO_ISOLATE = [
  'IRONCURTAIN_HOME',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'GOOGLE_API_BASE_URL',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
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

  it('schema rejects non-finite dockerResources values', () => {
    // Infinity/NaN can land in the resolved object via interactive prompts
    // before serialization (JSON.stringify would later turn them into `null`,
    // silently flipping a huge value into "unlimited"). The schema must
    // reject these at the boundary.
    expect(userConfigSchema.safeParse({ dockerResources: { cpus: Infinity } }).success).toBe(false);
    expect(userConfigSchema.safeParse({ dockerResources: { cpus: NaN } }).success).toBe(false);
    expect(userConfigSchema.safeParse({ dockerResources: { memoryMb: Infinity } }).success).toBe(false);
    expect(userConfigSchema.safeParse({ dockerResources: { memoryMb: NaN } }).success).toBe(false);
  });

  it('warns about unknown fields to stderr', () => {
    writeConfigFile({ unknownField: 'value' });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    loadUserConfig();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('unknown field "unknownField"'));
    stderrSpy.mockRestore();
  });

  it('does not throw on unknown fields', () => {
    writeConfigFile({ extraField: true, anotherExtra: 42 });

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

  // --- Base URL env var validation ---

  it('throws when ANTHROPIC_BASE_URL is malformed', () => {
    // The schema validates `anthropicBaseUrl` from the config file via
    // `z.url()`; the env override must apply the same rule rather than
    // accepting whatever string is in the environment. Without this guard,
    // a typo'd env var would surface as an opaque fetch failure mid-session.
    process.env.ANTHROPIC_BASE_URL = 'not-a-url';
    expect(() => loadUserConfig()).toThrow(/ANTHROPIC_BASE_URL/);
  });

  it('throws when OPENAI_BASE_URL is malformed', () => {
    process.env.OPENAI_BASE_URL = 'definitely-not-a-url';
    expect(() => loadUserConfig()).toThrow(/OPENAI_BASE_URL/);
  });

  it('throws when GOOGLE_API_BASE_URL is malformed', () => {
    process.env.GOOGLE_API_BASE_URL = '://broken';
    expect(() => loadUserConfig()).toThrow(/GOOGLE_API_BASE_URL/);
  });

  it('accepts a well-formed ANTHROPIC_BASE_URL env var', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/anthropic';
    const config = loadUserConfig();
    expect(config.anthropicBaseUrl).toBe('https://openrouter.ai/anthropic');
  });

  it('leaves anthropicBaseUrl as the config-file value when ANTHROPIC_BASE_URL is empty', () => {
    writeConfigFile({ anthropicBaseUrl: 'https://example.invalid/anthropic' });
    delete process.env.ANTHROPIC_BASE_URL;
    const config = loadUserConfig();
    expect(config.anthropicBaseUrl).toBe('https://example.invalid/anthropic');
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
    });

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

  it('removes a section when saved with empty object (disable pattern)', () => {
    writeConfigFile({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      webSearch: { provider: 'brave', brave: { apiKey: 'test-key' } },
    });

    // Empty object signals "delete this section" (used by config editor's Disable action)
    saveUserConfig({ webSearch: {} });

    const onDisk = readConfigFromDisk();
    expect(onDisk.webSearch).toBeUndefined();
    expect(onDisk.agentModelId).toBe('anthropic:claude-sonnet-4-6');
  });

  function readConfigFromDisk(): Record<string, unknown> {
    return JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
  }

  function writeConfigFile(config: Record<string, unknown>): void {
    mkdirSync(testHome, { recursive: true });
    writeFileSync(resolve(testHome, 'config.json'), JSON.stringify(config, null, 2));
  }
});

describe('preferredMode field', () => {
  let testHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-prefmode-'));
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

  function writeConfigFile(config: Record<string, unknown>): void {
    mkdirSync(testHome, { recursive: true });
    writeFileSync(resolve(testHome, 'config.json'), JSON.stringify(config, null, 2));
  }

  it('defaults to "docker" when not set', () => {
    const config = loadUserConfig();
    expect(config.preferredMode).toBe('docker');
  });

  it('accepts "docker"', () => {
    writeConfigFile({ preferredMode: 'docker' });
    expect(loadUserConfig().preferredMode).toBe('docker');
  });

  it('accepts "builtin"', () => {
    writeConfigFile({ preferredMode: 'builtin' });
    expect(loadUserConfig().preferredMode).toBe('builtin');
  });

  it('rejects "auto" with a clear schema error', () => {
    writeConfigFile({ preferredMode: 'auto' });
    expect(() => loadUserConfig()).toThrow(/preferredMode/);
  });

  it('rejects unrelated string values', () => {
    writeConfigFile({ preferredMode: 'pty' });
    expect(() => loadUserConfig()).toThrow(/preferredMode/);
  });
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

// --- G1: modelProviders provider-profile registry (openrouter-integration §6/§12.1) ---

/** The §6 two-profile example config. */
const TWO_PROFILE_EXAMPLE = {
  modelProviders: {
    default: 'glm-5.2',
    profiles: {
      'glm-5.2': {
        type: 'openrouter',
        apiKey: 'sk-or-v1-REDACTED',
        modelMap: [
          { match: '*opus*', model: 'z-ai/glm-5.2' },
          { match: '*sonnet*', model: 'z-ai/glm-5.2' },
          { match: '*haiku*', model: 'z-ai/glm-5.2' },
        ],
        perAgent: { goose: 'z-ai/glm-5.2', codex: 'z-ai/glm-5.2' },
        providerPreference: { order: ['z-ai'], allowFallbacks: false },
        sessionAffinity: true,
      },
      kimi: {
        type: 'openrouter',
        modelMap: [{ match: '*', model: 'moonshot/kimi-k3' }],
      },
    },
  },
} as const;

describe('modelProviders schema (userConfigSchema.safeParse)', () => {
  it('accepts the §6 two-profile example', () => {
    const result = userConfigSchema.safeParse(TWO_PROFILE_EXAMPLE);
    expect(result.success).toBe(true);
  });

  it('rejects a modelMap entry with an empty match', () => {
    const result = userConfigSchema.safeParse({
      modelProviders: {
        profiles: { p: { type: 'openrouter', modelMap: [{ match: '', model: 'z-ai/glm-5.2' }] } },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a user-defined profile named "native" (reserved)', () => {
    const result = userConfigSchema.safeParse({
      modelProviders: { profiles: { native: { type: 'openrouter' } } },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('reserved');
  });

  it('rejects default naming a non-existent profile', () => {
    const result = userConfigSchema.safeParse({
      modelProviders: { default: 'ghost', profiles: { real: { type: 'openrouter' } } },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain('must name a configured profile');
  });

  it('accepts default "native"', () => {
    const result = userConfigSchema.safeParse({ modelProviders: { default: 'native' } });
    expect(result.success).toBe(true);
  });

  it('accepts default naming a configured profile', () => {
    const result = userConfigSchema.safeParse({
      modelProviders: { default: 'glm-5.2', profiles: { 'glm-5.2': { type: 'openrouter' } } },
    });
    expect(result.success).toBe(true);
  });
});

describe('modelProviders resolution (loadUserConfig)', () => {
  let testHome: string;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['IRONCURTAIN_HOME', 'OPENROUTER_API_KEY'] as const;

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-modelproviders-'));
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.IRONCURTAIN_HOME = testHome;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  function writeConfigFile(config: Record<string, unknown>): void {
    mkdirSync(testHome, { recursive: true });
    writeFileSync(resolve(testHome, 'config.json'), JSON.stringify(config, null, 2));
  }

  it('always includes the implicit native profile, even when modelProviders is absent', () => {
    const config = loadUserConfig();
    expect(config.modelProviders.profiles.native).toEqual({ type: 'native' });
  });

  it('default resolves to "native" when unset', () => {
    const config = loadUserConfig();
    expect(config.modelProviders.default).toBe('native');
  });

  it('resolves default from config when set', () => {
    writeConfigFile({ modelProviders: { default: 'glm-5.2', profiles: { 'glm-5.2': { type: 'openrouter' } } } });
    const config = loadUserConfig();
    expect(config.modelProviders.default).toBe('glm-5.2');
  });

  it('applies DEFAULT_MODEL_MAP to an openrouter profile with no modelMap', () => {
    writeConfigFile({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-x' } } } });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.modelMap).toEqual(DEFAULT_MODEL_MAP);
  });

  it('preserves an explicit empty modelMap (D1 per-agent-only mode)', () => {
    writeConfigFile({
      modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-x', modelMap: [] } } },
    });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.modelMap).toEqual([]);
  });

  it('sets usesDefaultMap true when the profile OMITS modelMap (default-tracking)', () => {
    writeConfigFile({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-x' } } } });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.usesDefaultMap).toBe(true);
    expect(p.modelMap).toEqual(DEFAULT_MODEL_MAP);
  });

  it('sets usesDefaultMap false for an explicit empty modelMap (per-agent-only, not default)', () => {
    writeConfigFile({
      modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-x', modelMap: [] } } },
    });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.usesDefaultMap).toBe(false);
  });

  it('sets usesDefaultMap false for an explicit non-empty modelMap', () => {
    writeConfigFile({
      modelProviders: {
        profiles: {
          p: { type: 'openrouter', apiKey: 'sk-or-v1-x', modelMap: [{ match: '*', model: 'z-ai/glm-5.2' }] },
        },
      },
    });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.usesDefaultMap).toBe(false);
  });

  it('defaults sessionAffinity to true when absent', () => {
    writeConfigFile({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-x' } } } });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.sessionAffinity).toBe(true);
  });

  it('honors an explicit sessionAffinity=false', () => {
    writeConfigFile({
      modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-x', sessionAffinity: false } } },
    });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.sessionAffinity).toBe(false);
  });

  it('resolves apiKey to "" when neither env nor config sets it', () => {
    writeConfigFile({ modelProviders: { profiles: { p: { type: 'openrouter' } } } });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.apiKey).toBe('');
  });

  it('OPENROUTER_API_KEY env beats every profile config apiKey', () => {
    writeConfigFile({
      modelProviders: {
        profiles: {
          a: { type: 'openrouter', apiKey: 'sk-or-v1-config-a' },
          b: { type: 'openrouter' },
        },
      },
    });
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-from-env';
    const config = loadUserConfig();
    const a = config.modelProviders.profiles.a as ResolvedOpenRouterProfile;
    const b = config.modelProviders.profiles.b as ResolvedOpenRouterProfile;
    expect(a.apiKey).toBe('sk-or-v1-from-env');
    expect(b.apiKey).toBe('sk-or-v1-from-env');
  });

  it('uses the profile config apiKey when OPENROUTER_API_KEY is unset', () => {
    writeConfigFile({ modelProviders: { profiles: { a: { type: 'openrouter', apiKey: 'sk-or-v1-config-a' } } } });
    const config = loadUserConfig();
    const a = config.modelProviders.profiles.a as ResolvedOpenRouterProfile;
    expect(a.apiKey).toBe('sk-or-v1-config-a');
  });

  it('resolves perAgent overrides, leaving unset agents undefined', () => {
    writeConfigFile({
      modelProviders: {
        profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-x', perAgent: { goose: 'z-ai/glm-5.2' } } },
      },
    });
    const config = loadUserConfig();
    const p = config.modelProviders.profiles.p as ResolvedOpenRouterProfile;
    expect(p.perAgent.goose).toBe('z-ai/glm-5.2');
    expect(p.perAgent['claude-code']).toBeUndefined();
    expect(p.perAgent.codex).toBeUndefined();
  });

  it('does not back-fill modelProviders into the config file (computeMissingDefaults skips it)', () => {
    // Trigger auto-creation, then confirm no modelProviders key is written.
    loadUserConfig();
    const written = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
    expect(written.modelProviders).toBeUndefined();
  });

  it('persists an explicitly-set profile apiKey via saveUserConfig', () => {
    loadUserConfig();
    saveUserConfig({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-persist' } } } });
    const written = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
    expect(written.modelProviders.profiles.p.apiKey).toBe('sk-or-v1-persist');
  });

  it('never persists the OPENROUTER_API_KEY env value (env-only profile → apiKey omitted)', () => {
    // Simulates the editor/web-UI persisting a resolved profile whose apiKey was
    // injected only from the env var (applyOpenrouterKeyEnv) — it must not land on disk.
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-from-env';
    saveUserConfig({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-from-env' } } } });
    const written = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
    expect(written.modelProviders.profiles.p.apiKey).toBeUndefined();
    // Round-trips: the env var still supplies the key at load time.
    expect((loadUserConfig().modelProviders.profiles.p as ResolvedOpenRouterProfile).apiKey).toBe('sk-or-v1-from-env');
  });

  it('restores a distinct file-origin apiKey when scrubbing the env value', () => {
    writeConfigFile({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-file' } } } });
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-from-env';
    // A save that carries the env-injected key (as the resolved editor value would).
    saveUserConfig({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-from-env' } } } });
    const written = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
    expect(written.modelProviders.profiles.p.apiKey).toBe('sk-or-v1-file');
  });

  it('persists a user-typed key that differs from the env value', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-from-env';
    saveUserConfig({ modelProviders: { profiles: { p: { type: 'openrouter', apiKey: 'sk-or-v1-typed' } } } });
    const written = JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
    expect(written.modelProviders.profiles.p.apiKey).toBe('sk-or-v1-typed');
  });
});

describe('resolveActiveProfile (pure resolver)', () => {
  const modelProviders = {
    default: 'glm-5.2',
    profiles: {
      native: { type: 'native' as const },
      'glm-5.2': {
        type: 'openrouter' as const,
        apiKey: 'sk-or-v1-x',
        modelMap: DEFAULT_MODEL_MAP,
        usesDefaultMap: false,
        perAgent: { 'claude-code': undefined, goose: undefined, codex: undefined },
        providerPreference: undefined,
        sessionAffinity: true,
      },
      kimi: {
        type: 'openrouter' as const,
        apiKey: '',
        modelMap: [{ match: '*', model: 'moonshot/kimi-k3' }],
        usesDefaultMap: false,
        perAgent: { 'claude-code': undefined, goose: undefined, codex: undefined },
        providerPreference: undefined,
        sessionAffinity: true,
      },
    },
  };

  it('returns the explicitly named profile', () => {
    const profile = resolveActiveProfile(modelProviders, 'kimi');
    expect(profile).toBe(modelProviders.profiles.kimi);
  });

  it('falls back to modelProviders.default when no name is given', () => {
    const profile = resolveActiveProfile(modelProviders, undefined);
    expect(profile).toBe(modelProviders.profiles['glm-5.2']);
  });

  it('falls back to native when default is native and no name is given', () => {
    const nativeOnly = { default: 'native', profiles: { native: { type: 'native' as const } } };
    expect(resolveActiveProfile(nativeOnly, undefined)).toEqual({ type: 'native' });
  });

  it('resolves an explicit "native" name', () => {
    expect(resolveActiveProfile(modelProviders, 'native')).toEqual({ type: 'native' });
  });

  it('throws a clear error listing available profiles for an unknown name', () => {
    expect(() => resolveActiveProfile(modelProviders, 'does-not-exist')).toThrow(
      'Unknown provider profile "does-not-exist". Available: native, glm-5.2, kimi.',
    );
  });

  it('DEFAULT_GLM_SLUG is the default map target', () => {
    // Guards against DEFAULT_MODEL_MAP drifting away from the GLM slug.
    for (const rule of DEFAULT_MODEL_MAP) {
      expect(rule.model).toBe(DEFAULT_GLM_SLUG);
    }
  });
});
