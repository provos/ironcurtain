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
  autocomplete: vi.fn(),
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
  autocomplete: (...args: unknown[]) => mocks.autocomplete(...args),
  intro: (...args: unknown[]) => mocks.intro(...args),
  outro: (...args: unknown[]) => mocks.outro(...args),
  note: (...args: unknown[]) => mocks.note(...args),
  cancel: (...args: unknown[]) => mocks.cancel(...args),
  isCancel: (...args: unknown[]) => mocks.isCancel(...args),
  log: mocks.log,
}));

// Stub the network fetch in the catalog leaf so interactive-flow tests never hit
// openrouter.ai. A plain (non-vi.fn) function is immune to clear/restoreAllMocks.
// `catalogEnforces` stays REAL so slugPromptMode's truth table exercises production logic.
vi.mock('../src/config/openrouter-catalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/openrouter-catalog.js')>();
  return {
    ...actual,
    listOpenrouterModels: () => Promise.resolve({ models: [], source: 'bundled' as const, fetchedAt: 0 }),
  };
});

// Now import the module under test
import {
  runConfigCommand,
  computeDiff,
  repointDefaultAfterDelete,
  formatTokens,
  formatSeconds,
  formatCost,
  buildSlugOptions,
  slugPromptMode,
} from '../src/config/config-command.js';
import type { ModelCatalogResult, ModelCatalogSource } from '../src/config/openrouter-catalog.js';
import type { ResolvedUserConfig, UserConfig } from '../src/config/user-config.js';
import { USER_CONFIG_DEFAULTS, loadUserConfig, maskApiKey } from '../src/config/user-config.js';

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

  it('Model Providers section appears in main menu', async () => {
    seedConfig(env.testHome, {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
    });

    // Script: enter Model Providers -> Back -> Save (no changes)
    mocks.select
      .mockResolvedValueOnce('modelProviders') // main menu: Model Providers
      .mockResolvedValueOnce('back') // Model Providers: Back
      .mockResolvedValueOnce('save'); // main menu: Save

    await runConfigCommand();

    const firstCall = mocks.select.mock.calls[0][0] as { options: { value: string }[] };
    expect(firstCall.options.some((o) => o.value === 'modelProviders')).toBe(true);
    expect(mocks.outro).toHaveBeenCalledWith('No changes to save.');
  });

  it('adding an openrouter profile writes the whole modelProviders block', async () => {
    seedConfig(env.testHome, {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
    });

    // Script: Model Providers -> Add profile -> (name) -> (key) -> Back -> Save -> confirm
    mocks.select
      .mockResolvedValueOnce('modelProviders') // main menu
      .mockResolvedValueOnce('add') // Model Providers: Add profile
      .mockResolvedValueOnce('back') // Model Providers: Back
      .mockResolvedValueOnce('save'); // main menu: Save
    mocks.text
      .mockResolvedValueOnce('glm-5.2') // profile name
      .mockResolvedValueOnce('sk-or-v1-testkey-abcdef'); // api key
    mocks.confirm.mockResolvedValueOnce(true); // confirm save

    await runConfigCommand();

    const onDisk = readConfig(env.testHome);
    const mp = onDisk.modelProviders as {
      default?: string;
      profiles: Record<string, { type: string; apiKey?: string }>;
    };
    expect(mp.profiles['glm-5.2']).toEqual({ type: 'openrouter', apiKey: 'sk-or-v1-testkey-abcdef' });
    // native is implicit and must NOT be persisted.
    expect(mp.profiles.native).toBeUndefined();
    // A subsequent load must not throw (schema + refines pass).
    expect(() => loadUserConfig()).not.toThrow();
  });

  it('setting the default profile persists modelProviders.default', async () => {
    seedConfig(env.testHome, {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
      modelProviders: {
        default: 'native',
        profiles: { glm: { type: 'openrouter', apiKey: 'sk-or-v1-storedkey-abcdefgh' } },
      },
    });

    // Script: Model Providers -> Set default -> glm -> Back -> Save -> confirm
    mocks.select
      .mockResolvedValueOnce('modelProviders') // main menu
      .mockResolvedValueOnce('default') // Model Providers: Set default
      .mockResolvedValueOnce('glm') // default selector: glm
      .mockResolvedValueOnce('back') // Model Providers: Back
      .mockResolvedValueOnce('save'); // main menu: Save
    mocks.confirm.mockResolvedValueOnce(true);

    await runConfigCommand();

    const onDisk = readConfig(env.testHome);
    const mp = onDisk.modelProviders as { default?: string };
    expect(mp.default).toBe('glm');
    expect(() => loadUserConfig()).not.toThrow();
  });

  it('deleting the default-pointed profile re-points default to native (F10)', async () => {
    seedConfig(env.testHome, {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
      modelProviders: {
        default: 'glm', // default points at the profile we delete
        profiles: { glm: { type: 'openrouter', apiKey: 'sk-or-v1-storedkey-abcdefgh' } },
      },
    });

    // Script: Model Providers -> edit glm -> delete -> confirm delete -> Back -> Save -> confirm save
    mocks.select
      .mockResolvedValueOnce('modelProviders') // main menu
      .mockResolvedValueOnce('profile:glm') // Model Providers: edit glm
      .mockResolvedValueOnce('delete') // Profile: Delete
      .mockResolvedValueOnce('back') // Model Providers: Back
      .mockResolvedValueOnce('save'); // main menu: Save
    mocks.confirm
      .mockResolvedValueOnce(true) // confirm delete
      .mockResolvedValueOnce(true); // confirm save

    await runConfigCommand();

    const onDisk = readConfig(env.testHome);
    const mp = onDisk.modelProviders as {
      default?: string;
      profiles: Record<string, unknown>;
    };
    // The dangling default must have been re-pointed to native, never left as 'glm'.
    expect(mp.default).toBe('native');
    expect(mp.profiles.glm).toBeUndefined();
    // The persisted config must load without the HARD refine error.
    expect(() => loadUserConfig()).not.toThrow();
  });

  it('non-TTY exits with error', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
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
    modelProviders: {
      default: 'native',
      profiles: {
        native: { type: 'native' },
        glm: {
          type: 'openrouter',
          apiKey: 'sk-or-v1-storedkey-abcdefghijklmnop',
          modelMap: [
            { match: '*sonnet*', model: 'z-ai/glm-5.2' },
            { match: '*opus*', model: 'z-ai/glm-5.2' },
          ],
          perAgent: { 'claude-code': undefined, goose: 'z-ai/glm-5.2', codex: undefined },
          providerPreference: { order: ['z-ai'] },
          sessionAffinity: true,
        },
      },
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

  it('shows modelProviders profile changes with masked key', () => {
    const diffs = computeDiff(resolved, {
      modelProviders: {
        default: 'native',
        profiles: {
          glm: {
            type: 'openrouter',
            apiKey: 'sk-or-v1-newkey-qrstuvwxyz012345',
            modelMap: [
              { match: '*sonnet*', model: 'z-ai/glm-5.2' },
              { match: '*opus*', model: 'z-ai/glm-5.2' },
            ],
            perAgent: { goose: 'z-ai/glm-5.2' },
            providerPreference: { order: ['z-ai'] },
            sessionAffinity: true,
          },
        },
      },
    });
    const keyDiff = diffs.find(([p]) => p === 'modelProviders.profiles.glm.apiKey');
    expect(keyDiff).toBeDefined();
    // Only the key changed; the mask hides the raw value.
    expect(keyDiff![1].from).toBe('sk-...nop');
    expect(keyDiff![1].to).toBe('sk-...345');
    // No other profile fields changed, so only the apiKey diff is present.
    expect(diffs.filter(([p]) => p.startsWith('modelProviders.profiles.glm'))).toHaveLength(1);
  });

  it('produces an EMPTY diff for a no-op modelProviders edit (m14)', () => {
    // Same object CONTENT as resolved, different object reference (read-modify-write
    // round-trip). The dedicated deep-equality branch must yield no diff.
    const pending: UserConfig = {
      modelProviders: {
        default: 'native',
        profiles: {
          glm: {
            type: 'openrouter',
            apiKey: 'sk-or-v1-storedkey-abcdefghijklmnop',
            modelMap: [
              { match: '*sonnet*', model: 'z-ai/glm-5.2' },
              { match: '*opus*', model: 'z-ai/glm-5.2' },
            ],
            perAgent: { goose: 'z-ai/glm-5.2' },
            providerPreference: { order: ['z-ai'] },
            sessionAffinity: true,
          },
        },
      },
    };
    expect(computeDiff(resolved, pending)).toEqual([]);
  });

  it('diffs the default selector change', () => {
    const diffs = computeDiff(resolved, {
      modelProviders: {
        default: 'glm',
        profiles: {
          glm: {
            type: 'openrouter',
            apiKey: 'sk-or-v1-storedkey-abcdefghijklmnop',
            modelMap: [
              { match: '*sonnet*', model: 'z-ai/glm-5.2' },
              { match: '*opus*', model: 'z-ai/glm-5.2' },
            ],
            perAgent: { goose: 'z-ai/glm-5.2' },
            providerPreference: { order: ['z-ai'] },
            sessionAffinity: true,
          },
        },
      },
    });
    expect(diffs).toContainEqual(['modelProviders.default', { from: 'native', to: 'glm' }]);
  });

  it('diffs a removed profile', () => {
    // Whole-record write that omits `glm` → the profile is dropped.
    const diffs = computeDiff(resolved, {
      modelProviders: { default: 'native', profiles: {} },
    });
    expect(diffs).toContainEqual(['modelProviders.profiles.glm', { from: 'configured', to: 'removed' }]);
  });
});

describe('repointDefaultAfterDelete (F10)', () => {
  it('keeps the default when it still names a remaining profile', () => {
    expect(repointDefaultAfterDelete('glm', ['glm', 'kimi'])).toBe('glm');
  });

  it('re-points a dangling default to native', () => {
    // `glm` was just deleted → not in the remaining names → re-point.
    expect(repointDefaultAfterDelete('glm', ['kimi'])).toBe('native');
  });

  it('re-points to native when no profiles remain', () => {
    expect(repointDefaultAfterDelete('glm', [])).toBe('native');
  });

  it('leaves native untouched', () => {
    expect(repointDefaultAfterDelete('native', [])).toBe('native');
    expect(repointDefaultAfterDelete('native', ['glm'])).toBe('native');
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

describe('buildSlugOptions', () => {
  const models = ['anthropic/claude-opus-4', 'z-ai/glm-5.2', 'openai/gpt-4o'];
  const cat = (source: ModelCatalogSource, slugs: string[] = models): ModelCatalogResult => ({
    models: slugs,
    source,
    fetchedAt: source === 'bundled' ? 0 : 1,
  });

  it('prepends the (none) sentinel FIRST when allowNone is true', () => {
    const opts = buildSlugOptions(cat('live'), '', { allowNone: true });
    expect(opts[0]).toEqual({ value: '', label: '(none — use model map)' });
    // the catalog slugs follow, in catalog order
    expect(opts.slice(1).map((o) => o.value)).toEqual(models);
  });

  it('omits the (none) sentinel when allowNone is false (map-row model is required)', () => {
    const opts = buildSlugOptions(cat('live'), '', { allowNone: false });
    expect(opts.some((o) => o.value === '')).toBe(false);
    expect(opts.map((o) => o.value)).toEqual(models);
  });

  it('appends a grandfather option when current is non-empty and absent from the catalog', () => {
    const opts = buildSlugOptions(cat('live'), 'legacy/delisted-model', { allowNone: false });
    expect(opts[opts.length - 1]).toEqual({
      value: 'legacy/delisted-model',
      label: 'legacy/delisted-model  (current, unverified)',
    });
    expect(opts).toHaveLength(models.length + 1);
  });

  it('does NOT add a grandfather option when current is already in the catalog', () => {
    const opts = buildSlugOptions(cat('live'), 'z-ai/glm-5.2', { allowNone: false });
    expect(opts).toHaveLength(models.length);
    expect(opts.filter((o) => o.value === 'z-ai/glm-5.2')).toHaveLength(1);
  });

  it('does NOT add a grandfather option when current is empty', () => {
    const opts = buildSlugOptions(cat('live'), '', { allowNone: false });
    expect(opts).toHaveLength(models.length);
  });

  it('places (none) first AND the grandfather last (perAgent editing a delisted slug)', () => {
    const opts = buildSlugOptions(cat('cache'), 'legacy/delisted', { allowNone: true });
    expect(opts[0].value).toBe('');
    expect(opts[opts.length - 1]).toEqual({
      value: 'legacy/delisted',
      label: 'legacy/delisted  (current, unverified)',
    });
    expect(opts).toHaveLength(models.length + 2); // (none) + catalog + grandfather
  });

  it('never injects a __refresh__ sentinel (CHANGE 2)', () => {
    const variants = [
      buildSlugOptions(cat('live'), 'legacy/x', { allowNone: true }),
      buildSlugOptions(cat('live'), '', { allowNone: false }),
      buildSlugOptions(cat('cache'), 'z-ai/glm-5.2', { allowNone: true }),
    ];
    for (const opts of variants) {
      expect(opts.some((o) => o.value === '__refresh__')).toBe(false);
      expect(opts.some((o) => o.label.includes('Refresh'))).toBe(false);
    }
  });
});

describe('slugPromptMode', () => {
  it('is autocomplete for authoritative sources (live/cache hard-block)', () => {
    expect(slugPromptMode('live')).toBe('autocomplete');
    expect(slugPromptMode('cache')).toBe('autocomplete');
  });

  it('is freetext for the bundled floor (warn-only)', () => {
    expect(slugPromptMode('bundled')).toBe('freetext');
  });
});
