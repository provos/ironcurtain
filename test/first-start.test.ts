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

  /** Sets up mocks for a basic wizard flow: confirm setup, skip web search, choose auto-approve. */
  function setupBasicFlow(autoApprove: boolean): void {
    mocks.confirm.mockResolvedValueOnce(true);
    mocks.select.mockResolvedValueOnce('skip');
    mocks.confirm.mockResolvedValueOnce(autoApprove);
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
    mocks.confirm.mockResolvedValueOnce(true);
    mocks.select.mockResolvedValueOnce('skip');
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

  describe('re-run safety', () => {
    it('preserves existing web search API key when re-selecting same provider', async () => {
      seedConfig(env.testHome, {
        webSearch: { provider: 'brave', brave: { apiKey: 'existing-brave-key' } },
      });

      mocks.confirm.mockResolvedValueOnce(true);
      mocks.select.mockResolvedValueOnce('brave');
      mocks.confirm.mockResolvedValueOnce(false);

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

      mocks.confirm.mockResolvedValueOnce(true);
      mocks.select.mockResolvedValueOnce('tavily');
      mocks.text.mockResolvedValueOnce('new-tavily-key');
      mocks.confirm.mockResolvedValueOnce(false);

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

      const autoApproveCall = mocks.confirm.mock.calls[1][0] as { initialValue?: boolean };
      expect(autoApproveCall.initialValue).toBe(true);
    });
  });
});
