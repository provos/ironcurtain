import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  type ConfigTestEnv,
  setupConfigEnv,
  teardownConfigEnv,
  seedConfig,
  readConfig,
} from './helpers/config-test-setup.js';

// Mocks must be defined via vi.hoisted() so they're available when vi.mock() runs
const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  confirm: vi.fn(),
  text: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('@clack/prompts', () => ({
  select: (...args: unknown[]) => mocks.select(...args),
  confirm: (...args: unknown[]) => mocks.confirm(...args),
  text: (...args: unknown[]) => mocks.text(...args),
  intro: (...args: unknown[]) => mocks.intro(...args),
  outro: (...args: unknown[]) => mocks.outro(...args),
  note: (...args: unknown[]) => mocks.note(...args),
  cancel: (...args: unknown[]) => mocks.cancel(...args),
  isCancel: (...args: unknown[]) => mocks.isCancel(...args),
  log: mocks.log,
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
  let env: ConfigTestEnv;
  let savedIsTTY: boolean | undefined;

  beforeEach(() => {
    env = setupConfigEnv('configcmd');
    savedIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    vi.clearAllMocks();
    mocks.isCancel.mockReturnValue(false);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: savedIsTTY, configurable: true });
    teardownConfigEnv(env);
    vi.restoreAllMocks();
  });

  it('model change flows through to disk', async () => {
    seedConfig(env.testHome, {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
    });

    // Script: select Models -> select agentModelId -> pick opus -> Back -> Save -> confirm
    mocks.select
      .mockResolvedValueOnce('models') // main menu: Models
      .mockResolvedValueOnce('agentModelId') // Models sub: agentModelId
      .mockResolvedValueOnce('anthropic:claude-opus-4-6') // model selection
      .mockResolvedValueOnce('back') // Models sub: Back
      .mockResolvedValueOnce('save'); // main menu: Save & Exit
    mocks.confirm.mockResolvedValueOnce(true); // confirm save

    await runConfigCommand();

    const onDisk = readConfig(env.testHome);
    expect(onDisk.agentModelId).toBe('anthropic:claude-opus-4-6');
    // policyModelId should be unchanged
    expect(onDisk.policyModelId).toBe('anthropic:claude-sonnet-4-6');
  });

  it('nullable budget field set to null', async () => {
    seedConfig(env.testHome, {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: { ...USER_CONFIG_DEFAULTS.resourceBudget },
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
    });

    // Script: Resources -> maxSteps -> disable -> Back -> Save -> confirm
    mocks.select
      .mockResolvedValueOnce('resources') // main menu: Resources
      .mockResolvedValueOnce('maxSteps') // Resource sub: maxSteps
      .mockResolvedValueOnce('disable') // 3-way: disable
      .mockResolvedValueOnce('back') // Resource sub: Back
      .mockResolvedValueOnce('save'); // main menu: Save
    mocks.confirm.mockResolvedValueOnce(true);

    await runConfigCommand();

    const onDisk = readConfig(env.testHome);
    const budget = onDisk.resourceBudget as Record<string, unknown>;
    expect(budget.maxSteps).toBeNull();
  });

  it('cancel discards all changes', async () => {
    seedConfig(env.testHome, {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
    });

    // Script: select Models -> change agent -> Back -> Cancel
    mocks.select
      .mockResolvedValueOnce('models')
      .mockResolvedValueOnce('agentModelId')
      .mockResolvedValueOnce('anthropic:claude-opus-4-6')
      .mockResolvedValueOnce('back')
      .mockResolvedValueOnce('cancel');

    await runConfigCommand();

    const onDisk = readConfig(env.testHome);
    expect(onDisk.agentModelId).toBe('anthropic:claude-sonnet-4-6');
    expect(mocks.cancel).toHaveBeenCalledWith('Changes discarded.');
  });

  it('save with no changes shows appropriate message', async () => {
    seedConfig(env.testHome, {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
    });

    mocks.select.mockResolvedValueOnce('save'); // main menu: Save immediately

    await runConfigCommand();

    expect(mocks.outro).toHaveBeenCalledWith('No changes to save.');
  });

  it('Web Search section appears in main menu', async () => {
    seedConfig(env.testHome, {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
    });

    // Script: select Web Search -> Back -> Save
    mocks.select
      .mockResolvedValueOnce('websearch') // main menu: Web Search
      .mockResolvedValueOnce('back') // Web Search sub: Back
      .mockResolvedValueOnce('save'); // main menu: Save

    await runConfigCommand();

    // Verify the main menu select was called with websearch option
    const firstCall = mocks.select.mock.calls[0][0] as { options: { value: string; label: string }[] };
    expect(firstCall.options.some((o: { value: string }) => o.value === 'websearch')).toBe(true);
    expect(mocks.outro).toHaveBeenCalledWith('No changes to save.');
  });

  it('Web Search provider selection stores in pending', async () => {
    seedConfig(env.testHome, {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
    });

    // Script: Web Search -> Select provider -> brave -> enter API key -> Back -> Save -> confirm
    mocks.select
      .mockResolvedValueOnce('websearch') // main menu: Web Search
      .mockResolvedValueOnce('select') // Web Search: Select provider
      .mockResolvedValueOnce('brave') // Provider: brave
      .mockResolvedValueOnce('back') // Web Search: Back
      .mockResolvedValueOnce('save'); // main menu: Save
    mocks.text.mockResolvedValueOnce('test-brave-key-123'); // API key
    mocks.confirm.mockResolvedValueOnce(true); // confirm save

    await runConfigCommand();

    const onDisk = readConfig(env.testHome);
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
