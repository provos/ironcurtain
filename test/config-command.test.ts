import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** Env var names that need save/restore between tests. */
const ENV_VARS_TO_ISOLATE = [
  'IRONCURTAIN_HOME',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENAI_API_KEY',
] as const;

// Mock @clack/prompts before importing anything that uses it
const mockSelect = vi.fn();
const mockConfirm = vi.fn();
const mockText = vi.fn();
const mockIntro = vi.fn();
const mockOutro = vi.fn();
const mockNote = vi.fn();
const mockCancel = vi.fn();
const mockIsCancel = vi.fn().mockReturnValue(false);

vi.mock('@clack/prompts', () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
  text: (...args: unknown[]) => mockText(...args),
  intro: (...args: unknown[]) => mockIntro(...args),
  outro: (...args: unknown[]) => mockOutro(...args),
  note: (...args: unknown[]) => mockNote(...args),
  cancel: (...args: unknown[]) => mockCancel(...args),
  isCancel: (...args: unknown[]) => mockIsCancel(...args),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Now import the module under test
import {
  runConfigCommand,
  computeDiff,
  formatTokens,
  formatSeconds,
  formatCost,
  maskApiKey,
} from '../src/config/config-command.js';
import type { ResolvedUserConfig, UserConfig } from '../src/config/user-config.js';
import { USER_CONFIG_DEFAULTS } from '../src/config/user-config.js';

describe('config-command', () => {
  let testHome: string;
  const savedEnv: Record<string, string | undefined> = {};
  let savedIsTTY: boolean | undefined;

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-configcmd-'));
    for (const key of ENV_VARS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.IRONCURTAIN_HOME = testHome;
    savedIsTTY = process.stdin.isTTY;
    // Default to TTY for tests
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    // Reset mocks
    vi.clearAllMocks();
    mockIsCancel.mockReturnValue(false);
    // Suppress stderr from loadUserConfig
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    for (const key of ENV_VARS_TO_ISOLATE) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    Object.defineProperty(process.stdin, 'isTTY', { value: savedIsTTY, configurable: true });
    rmSync(testHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('model change flows through to disk', async () => {
    writeConfigFile({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
    });

    // Script: select Models -> select agentModelId -> pick opus -> Back -> Save -> confirm
    mockSelect
      .mockResolvedValueOnce('models') // main menu: Models
      .mockResolvedValueOnce('agentModelId') // Models sub: agentModelId
      .mockResolvedValueOnce('anthropic:claude-opus-4-6') // model selection
      .mockResolvedValueOnce('back') // Models sub: Back
      .mockResolvedValueOnce('save'); // main menu: Save & Exit
    mockConfirm.mockResolvedValueOnce(true); // confirm save

    await runConfigCommand();

    const onDisk = readConfigFromDisk();
    expect(onDisk.agentModelId).toBe('anthropic:claude-opus-4-6');
    // policyModelId should be unchanged
    expect(onDisk.policyModelId).toBe('anthropic:claude-sonnet-4-6');
  });

  it('nullable budget field set to null', async () => {
    writeConfigFile({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: { ...USER_CONFIG_DEFAULTS.resourceBudget },
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
    });

    // Script: Resources -> maxSteps -> disable -> Back -> Save -> confirm
    mockSelect
      .mockResolvedValueOnce('resources') // main menu: Resources
      .mockResolvedValueOnce('maxSteps') // Resource sub: maxSteps
      .mockResolvedValueOnce('disable') // 3-way: disable
      .mockResolvedValueOnce('back') // Resource sub: Back
      .mockResolvedValueOnce('save'); // main menu: Save
    mockConfirm.mockResolvedValueOnce(true);

    await runConfigCommand();

    const onDisk = readConfigFromDisk();
    const budget = onDisk.resourceBudget as Record<string, unknown>;
    expect(budget.maxSteps).toBeNull();
  });

  it('cancel discards all changes', async () => {
    writeConfigFile({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
    });

    // Script: select Models -> change agent -> Back -> Cancel
    mockSelect
      .mockResolvedValueOnce('models')
      .mockResolvedValueOnce('agentModelId')
      .mockResolvedValueOnce('anthropic:claude-opus-4-6')
      .mockResolvedValueOnce('back')
      .mockResolvedValueOnce('cancel');

    await runConfigCommand();

    const onDisk = readConfigFromDisk();
    expect(onDisk.agentModelId).toBe('anthropic:claude-sonnet-4-6');
    expect(mockCancel).toHaveBeenCalledWith('Changes discarded.');
  });

  it('save with no changes shows appropriate message', async () => {
    writeConfigFile({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
    });

    mockSelect.mockResolvedValueOnce('save'); // main menu: Save immediately

    await runConfigCommand();

    expect(mockOutro).toHaveBeenCalledWith('No changes to save.');
  });

  it('Web Search section appears in main menu', async () => {
    writeConfigFile({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
    });

    // Script: select Web Search -> Back -> Save
    mockSelect
      .mockResolvedValueOnce('websearch') // main menu: Web Search
      .mockResolvedValueOnce('back') // Web Search sub: Back
      .mockResolvedValueOnce('save'); // main menu: Save

    await runConfigCommand();

    // Verify the main menu select was called with websearch option
    const firstCall = mockSelect.mock.calls[0][0] as { options: { value: string; label: string }[] };
    expect(firstCall.options.some((o: { value: string }) => o.value === 'websearch')).toBe(true);
    expect(mockOutro).toHaveBeenCalledWith('No changes to save.');
  });

  it('Web Search provider selection stores in pending', async () => {
    writeConfigFile({
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
    });

    // Script: Web Search -> Select provider -> brave -> enter API key -> Back -> Save -> confirm
    mockSelect
      .mockResolvedValueOnce('websearch') // main menu: Web Search
      .mockResolvedValueOnce('select') // Web Search: Select provider
      .mockResolvedValueOnce('brave') // Provider: brave
      .mockResolvedValueOnce('back') // Web Search: Back
      .mockResolvedValueOnce('save'); // main menu: Save
    mockText.mockResolvedValueOnce('test-brave-key-123'); // API key
    mockConfirm.mockResolvedValueOnce(true); // confirm save

    await runConfigCommand();

    const onDisk = readConfigFromDisk();
    expect(onDisk.webSearch).toBeDefined();
    const ws = onDisk.webSearch as Record<string, unknown>;
    expect(ws.provider).toBe('brave');
    expect(ws.brave).toEqual({ apiKey: 'test-brave-key-123' });
  });

  it('non-TTY exits with error', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const stderrSpy = vi.spyOn(console, 'error').mockReturnValue();

    await expect(runConfigCommand()).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('TTY'));
  });

  // --- Helper ---

  function readConfigFromDisk(): Record<string, unknown> {
    return JSON.parse(readFileSync(resolve(testHome, 'config.json'), 'utf-8'));
  }

  function writeConfigFile(config: Record<string, unknown>): void {
    mkdirSync(testHome, { recursive: true });
    writeFileSync(resolve(testHome, 'config.json'), JSON.stringify(config, null, 2));
  }
});

describe('computeDiff', () => {
  const resolved: ResolvedUserConfig = {
    agentModelId: 'anthropic:claude-sonnet-4-6',
    policyModelId: 'anthropic:claude-sonnet-4-6',
    anthropicApiKey: '',
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
      enabled: true,
      thresholdTokens: 160_000,
      keepRecentMessages: 10,
      summaryModelId: 'anthropic:claude-haiku-4-5',
    },
    autoApprove: {
      enabled: false,
      modelId: 'anthropic:claude-haiku-4-5',
    },
    webSearch: {
      provider: null,
      brave: null,
      tavily: null,
      serpapi: null,
    },
    serverCredentials: {},
  };

  it('returns empty array when no changes', () => {
    expect(computeDiff(resolved, {})).toEqual([]);
  });

  it('detects top-level changes', () => {
    const pending: UserConfig = {
      agentModelId: 'anthropic:claude-opus-4-6',
    };
    const diffs = computeDiff(resolved, pending);
    expect(diffs).toEqual([['agentModelId', { from: 'anthropic:claude-sonnet-4-6', to: 'anthropic:claude-opus-4-6' }]]);
  });

  it('detects nested changes', () => {
    const pending: UserConfig = {
      resourceBudget: { maxSteps: null },
    };
    const diffs = computeDiff(resolved, pending);
    expect(diffs).toEqual([['resourceBudget.maxSteps', { from: 200, to: null }]]);
  });

  it('detects multiple changes across categories', () => {
    const pending: UserConfig = {
      agentModelId: 'anthropic:claude-opus-4-6',
      autoApprove: { enabled: true },
    };
    const diffs = computeDiff(resolved, pending);
    expect(diffs).toHaveLength(2);
    expect(diffs[0][0]).toBe('agentModelId');
    expect(diffs[1][0]).toBe('autoApprove.enabled');
  });

  it('ignores unchanged values in pending', () => {
    const pending: UserConfig = {
      agentModelId: 'anthropic:claude-sonnet-4-6', // same as resolved
    };
    expect(computeDiff(resolved, pending)).toEqual([]);
  });

  it('detects webSearch provider change', () => {
    const pending: UserConfig = {
      webSearch: { provider: 'brave', brave: { apiKey: 'test-key-12345' } },
    };
    const diffs = computeDiff(resolved, pending);
    expect(diffs.some(([path]) => path === 'webSearch.provider')).toBe(true);
    expect(diffs.some(([path]) => path === 'webSearch.brave.apiKey')).toBe(true);
  });

  it('masks API keys in webSearch diff', () => {
    const diffs = computeDiff(resolved, {
      webSearch: { provider: 'brave', brave: { apiKey: 'abcdefghijklmnop' } },
    });
    const apiKeyDiff = diffs.find(([p]) => p === 'webSearch.brave.apiKey');
    expect(apiKeyDiff).toBeDefined();
    expect(apiKeyDiff![1].to).toBe('abc...nop');
  });
});

describe('maskApiKey', () => {
  it('returns "none" for undefined or null', () => {
    expect(maskApiKey(undefined)).toBe('none');
    expect(maskApiKey(null)).toBe('none');
  });

  it('returns "***" for short keys', () => {
    expect(maskApiKey('abc')).toBe('***');
    expect(maskApiKey('abcdef')).toBe('***');
  });

  it('masks long keys showing first 3 and last 3', () => {
    expect(maskApiKey('abcdefghijklmnop')).toBe('abc...nop');
  });
});

describe('formatters', () => {
  it('formatTokens', () => {
    expect(formatTokens(null)).toBe('disabled');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(160_000)).toBe('160K');
    expect(formatTokens(500)).toBe('500');
  });

  it('formatSeconds', () => {
    expect(formatSeconds(null)).toBe('disabled');
    expect(formatSeconds(1800)).toBe('30m');
    expect(formatSeconds(3600)).toBe('1h');
    expect(formatSeconds(3661)).toBe('1h 1m');
    expect(formatSeconds(90)).toBe('1m 30s');
    expect(formatSeconds(45)).toBe('45s');
  });

  it('formatCost', () => {
    expect(formatCost(null)).toBe('disabled');
    expect(formatCost(5)).toBe('$5.00');
    expect(formatCost(0.5)).toBe('$0.50');
  });
});
