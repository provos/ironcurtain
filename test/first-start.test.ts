import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  type ConfigTestEnv,
  setupConfigEnv,
  teardownConfigEnv,
  seedConfig,
  readConfig,
  configExists,
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

import { runFirstStart } from '../src/config/first-start.js';

describe('first-start wizard', () => {
  let env: ConfigTestEnv;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    env = setupConfigEnv('firststart');
    process.env.ANTHROPIC_API_KEY = 'test-key';

    vi.clearAllMocks();
    mocks.isCancel.mockReturnValue(false);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    teardownConfigEnv(env);
    vi.restoreAllMocks();
  });

  /** Sets up mocks for a basic wizard flow: confirm setup, skip web search, skip GitHub token, choose auto-approve. */
  function setupBasicFlow(autoApprove: boolean): void {
    mocks.confirm.mockResolvedValueOnce(true); // Step 1: continue with setup
    mocks.select.mockResolvedValueOnce('skip'); // Step 4: web search provider
    mocks.confirm.mockResolvedValueOnce(false); // Step 5: skip GitHub token
    mocks.confirm.mockResolvedValueOnce(autoApprove); // Step 6: auto-approve
  }

  it('full flow with auto-approve enabled writes config', async () => {
    setupBasicFlow(true);

    await runFirstStart();

    const config = readConfig(env.testHome);
    expect(config.autoApprove?.enabled).toBe(true);
    expect(mocks.outro).toHaveBeenCalled();
  });

  it('auto-approve declined writes enabled: false', async () => {
    setupBasicFlow(false);

    await runFirstStart();

    const config = readConfig(env.testHome);
    expect(config.autoApprove?.enabled).toBe(false);
  });

  it('cancel at auto-approve step exits', async () => {
    mocks.confirm.mockResolvedValueOnce(true); // continue with setup
    mocks.select.mockResolvedValueOnce('skip'); // skip web search
    mocks.confirm.mockResolvedValueOnce(false); // skip GitHub token
    mocks.confirm.mockResolvedValueOnce(Symbol.for('cancel'));
    mocks.isCancel.mockImplementation((v: unknown) => typeof v === 'symbol');

    await expect(runFirstStart()).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mocks.cancel).toHaveBeenCalledWith('Setup cancelled.');
  });

  it('cancel at initial confirm exits early', async () => {
    mocks.confirm.mockResolvedValueOnce(Symbol.for('cancel'));
    mocks.isCancel.mockImplementation((v: unknown) => typeof v === 'symbol');

    await expect(runFirstStart()).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('cancel at auto-approve does not write config', async () => {
    mocks.confirm.mockResolvedValueOnce(true); // continue with setup
    mocks.select.mockResolvedValueOnce('skip'); // skip web search
    mocks.confirm.mockResolvedValueOnce(false); // skip GitHub token
    mocks.confirm.mockResolvedValueOnce(Symbol.for('cancel'));
    mocks.isCancel.mockImplementation((v: unknown) => typeof v === 'symbol');

    await expect(runFirstStart()).rejects.toThrow('process.exit');

    expect(configExists(env.testHome)).toBe(false);
  });

  it('exits cleanly on broken config file', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    mkdirSync(env.testHome, { recursive: true });
    writeFileSync(resolve(env.testHome, 'config.json'), 'not valid json');

    mocks.confirm.mockResolvedValueOnce(true);

    await expect(runFirstStart()).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.log.error).toHaveBeenCalled();
  });

  describe('re-run safety', () => {
    it('preserves existing web search API key when re-selecting same provider', async () => {
      seedConfig(env.testHome, {
        webSearch: { provider: 'brave', brave: { apiKey: 'existing-brave-key' } },
      });

      mocks.confirm.mockResolvedValueOnce(true); // continue with setup
      mocks.select.mockResolvedValueOnce('brave'); // re-select brave
      mocks.confirm.mockResolvedValueOnce(false); // skip GitHub token
      mocks.confirm.mockResolvedValueOnce(false); // auto-approve

      await runFirstStart();

      const config = readConfig(env.testHome);
      expect(config.webSearch?.provider).toBe('brave');
      expect(config.webSearch?.brave?.apiKey).toBe('existing-brave-key');
      expect(mocks.text).not.toHaveBeenCalled();
    });

    it('prompts for API key when switching to a new provider', async () => {
      seedConfig(env.testHome, {
        webSearch: { provider: 'brave', brave: { apiKey: 'existing-brave-key' } },
      });

      mocks.confirm.mockResolvedValueOnce(true); // continue with setup
      mocks.select.mockResolvedValueOnce('tavily'); // switch to tavily
      mocks.text.mockResolvedValueOnce('new-tavily-key'); // enter key
      mocks.confirm.mockResolvedValueOnce(false); // skip GitHub token
      mocks.confirm.mockResolvedValueOnce(false); // auto-approve

      await runFirstStart();

      const config = readConfig(env.testHome);
      expect(config.webSearch?.provider).toBe('tavily');
      expect(config.webSearch?.tavily?.apiKey).toBe('new-tavily-key');
      expect(mocks.text).toHaveBeenCalledTimes(1);
    });

    it('preserves existing auto-approve state as initialValue', async () => {
      seedConfig(env.testHome, { autoApprove: { enabled: true } });

      setupBasicFlow(true);

      await runFirstStart();

      const autoApproveCall = mocks.confirm.mock.calls[2][0] as { initialValue?: boolean };
      expect(autoApproveCall.initialValue).toBe(true);
    });
  });
});
