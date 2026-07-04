/**
 * Tests for `ironcurtain mux`'s preflight integration.
 *
 * These tests verify the contract introduced when preflight was added to
 * the mux command:
 *   1. Successful preflight prints the mode line to stderr and proceeds
 *      to construct the MuxApp.
 *   2. PreflightError is caught, printed in red, and exits with code 1
 *      WITHOUT constructing the MuxApp (i.e., never enters fullscreen).
 *   3. When `--agent` is omitted, `resolveSessionMode` is called with
 *      `requestedAgent: undefined` so `userConfig.preferredMode` is honored.
 *   4. When `--agent <name>` is provided, that value is passed through.
 *   5. Preflight runs BEFORE the autoApprove 3-second warning sleep
 *      (fail-fast semantics).
 *
 * The mux module is imported once and uses the dependency-injection seam
 * (`MuxMainDeps`) to substitute the real `resolveSessionMode`, `createMuxApp`,
 * and the autoApprove sleep. Native-deps probing (node-pty / terminal-kit)
 * is skipped via `skipNativeProbes: true` so the test does not require those
 * optional packages.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { PreflightOptions, PreflightResult } from '../src/session/preflight.js';
import { PreflightError } from '../src/session/preflight.js';
import type { MuxApp, MuxAppOptions } from '../src/mux/mux-app.js';

// --- Module mocks (hoisted) ---
// `loadConfig()` is mocked so the test does not require a real
// `~/.ironcurtain/config.json` or `mcp-servers.json` on disk.

const mockConfig: IronCurtainConfig = {
  auditLogPath: './audit.jsonl',
  allowedDirectory: join(tmpdir(), 'mux-test-sandbox'),
  mcpServers: {},
  protectedPaths: ['/protected/path'],
  generatedDir: join(tmpdir(), 'mux-test-generated'),
  constitutionPath: join(tmpdir(), 'mux-test-constitution.md'),
  agentModelId: 'anthropic:claude-sonnet-4-6',
  escalationTimeoutSeconds: 300,
  userConfig: {
    agentModelId: 'anthropic:claude-sonnet-4-6',
    policyModelId: 'anthropic:claude-sonnet-4-6',
    anthropicApiKey: 'test-api-key',
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
      enabled: false,
      thresholdTokens: 80_000,
      keepRecentMessages: 10,
      summaryModelId: 'anthropic:claude-haiku-4-5',
    },
    autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
    auditRedaction: { enabled: true },
    serverCredentials: {},
    // Native-only registry: the /new profile-picker step is skipped (G13 §9.7).
    modelProviders: { default: 'native', profiles: { native: { type: 'native' } } },
    gooseProvider: 'anthropic',
    gooseModel: 'claude-sonnet-4-20250514',
    preferredDockerAgent: 'claude-code',
    preferredMode: 'docker',
  },
};

vi.mock('../src/config/index.js', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    loadConfig: vi.fn(() => mockConfig),
  };
});

// Point the PTY registry into a temp dir so the `mkdirSync(registryDir, ...)`
// call doesn't touch the user's real `~/.ironcurtain/`.
vi.mock('../src/config/paths.js', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    getPtyRegistryDir: vi.fn(() => join(tmpdir(), `mux-test-registry-${process.pid}`)),
  };
});

// --- Imports (after mocks) ---

import { main as muxMain } from '../src/mux/mux-command.js';

// --- Helpers ---

function makePreflightSuccess(agent: 'claude-code' | 'goose' = 'claude-code'): PreflightResult {
  return {
    mode: { kind: 'docker', agent, authKind: 'apikey' },
    reason: `${agent} (API key)`,
  };
}

/** Builds a fake `MuxApp` whose `start()` immediately resolves. */
function makeFakeMuxApp(): MuxApp {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

/** Captures stderr writes during `main()` so tests can assert on them. */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any) => {
    if (typeof chunk === 'string') lines.push(chunk);
    else if (Buffer.isBuffer(chunk)) lines.push(chunk.toString('utf8'));
    return true;
  };
  return {
    lines,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = original;
    },
  };
}

/**
 * Replaces `process.exit` with one that throws a tagged error. The mux command
 * uses `process.exit(1)` on PreflightError; without this stub the test process
 * would actually exit. The thrown error is caught at the test's `await`.
 */
function stubProcessExit(): { restore: () => void } {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as never);
  return { restore: () => exitSpy.mockRestore() };
}

describe('ironcurtain mux preflight integration', () => {
  let stderr: ReturnType<typeof captureStderr>;
  let exitStub: ReturnType<typeof stubProcessExit>;

  beforeEach(async () => {
    stderr = captureStderr();
    exitStub = stubProcessExit();
    // Reset the loadConfig mock so tests that override it don't leak.
    const configModule = await import('../src/config/index.js');
    vi.mocked(configModule.loadConfig).mockReturnValue(mockConfig);
  });

  afterEach(() => {
    stderr.restore();
    exitStub.restore();
    vi.restoreAllMocks();
  });

  it('successful preflight prints the mode line and constructs the MuxApp', async () => {
    const fakeApp = makeFakeMuxApp();
    const resolveSessionMode = vi.fn().mockResolvedValue(makePreflightSuccess('claude-code'));
    const createMuxApp = vi.fn(() => fakeApp);

    await muxMain([], {
      resolveSessionMode,
      createMuxApp,
      skipNativeProbes: true,
    });

    expect(resolveSessionMode).toHaveBeenCalledOnce();
    expect(createMuxApp).toHaveBeenCalledOnce();
    expect(fakeApp.start).toHaveBeenCalledOnce();
    // Mode line must reach stderr in the same shape as `start`/`daemon`/`bot`.
    const stderrText = stderr.lines.join('');
    expect(stderrText).toMatch(/Mode: docker \/ claude-code \(API key\)/);
  });

  it('--capture-traces forwards captureTraces: true to the MuxApp', async () => {
    const resolveSessionMode = vi.fn().mockResolvedValue(makePreflightSuccess('claude-code'));
    const createMuxApp = vi.fn(() => makeFakeMuxApp());

    await muxMain(['--capture-traces'], {
      resolveSessionMode,
      createMuxApp,
      skipNativeProbes: true,
    });

    expect(createMuxApp).toHaveBeenCalledOnce();
    const appOptions = createMuxApp.mock.calls[0][0] as MuxAppOptions;
    expect(appOptions.captureTraces).toBe(true);
  });

  it('without --capture-traces, captureTraces is undefined (child falls through to config)', async () => {
    const resolveSessionMode = vi.fn().mockResolvedValue(makePreflightSuccess('claude-code'));
    const createMuxApp = vi.fn(() => makeFakeMuxApp());

    await muxMain([], {
      resolveSessionMode,
      createMuxApp,
      skipNativeProbes: true,
    });

    expect(createMuxApp).toHaveBeenCalledOnce();
    const appOptions = createMuxApp.mock.calls[0][0] as MuxAppOptions;
    expect(appOptions.captureTraces).toBeUndefined();
  });

  it('PreflightError is printed in red and exits with code 1; MuxApp is NOT constructed', async () => {
    const resolveSessionMode = vi.fn().mockRejectedValue(new PreflightError('Docker is not available'));
    const createMuxApp = vi.fn(() => makeFakeMuxApp());

    await expect(
      muxMain([], {
        resolveSessionMode,
        createMuxApp,
        skipNativeProbes: true,
      }),
    ).rejects.toThrow('process.exit:1');

    expect(resolveSessionMode).toHaveBeenCalledOnce();
    expect(createMuxApp).not.toHaveBeenCalled();
    const stderrText = stderr.lines.join('');
    // The error message itself reaches stderr (chalk.red wraps it; the
    // message body is plain so we can match on the literal).
    expect(stderrText).toMatch(/Docker is not available/);
    expect(stderrText).toMatch(/Run `ironcurtain doctor` for a full diagnostic/);
  });

  it('omitting --agent passes requestedAgent: undefined so preferredMode is honored', async () => {
    const resolveSessionMode = vi.fn().mockResolvedValue(makePreflightSuccess('claude-code'));
    const createMuxApp = vi.fn(() => makeFakeMuxApp());

    await muxMain([], {
      resolveSessionMode,
      createMuxApp,
      skipNativeProbes: true,
    });

    expect(resolveSessionMode).toHaveBeenCalledOnce();
    const callArg = resolveSessionMode.mock.calls[0][0] as PreflightOptions;
    expect(callArg.requestedAgent).toBeUndefined();
  });

  it('explicit --agent claude-code is forwarded to resolveSessionMode', async () => {
    const resolveSessionMode = vi.fn().mockResolvedValue(makePreflightSuccess('claude-code'));
    const createMuxApp = vi.fn(() => makeFakeMuxApp());

    await muxMain(['--agent', 'claude-code'], {
      resolveSessionMode,
      createMuxApp,
      skipNativeProbes: true,
    });

    expect(resolveSessionMode).toHaveBeenCalledOnce();
    const callArg = resolveSessionMode.mock.calls[0][0] as PreflightOptions;
    expect(callArg.requestedAgent).toBe('claude-code');
  });

  it('preflight runs BEFORE the autoApprove warning sleep (fail-fast)', async () => {
    // Arrange: enable autoApprove with no API key so the warning would fire,
    // and have preflight reject so we can prove we never reached the sleep.
    const configWithBadAutoApprove: IronCurtainConfig = {
      ...mockConfig,
      userConfig: {
        ...mockConfig.userConfig,
        autoApprove: { enabled: true, modelId: 'anthropic:claude-haiku-4-5' },
        anthropicApiKey: '',
        googleApiKey: '',
        openaiApiKey: '',
      },
    };
    const configModule = await import('../src/config/index.js');
    vi.mocked(configModule.loadConfig).mockReturnValue(configWithBadAutoApprove);

    const sleep = vi.fn().mockResolvedValue(undefined);
    const resolveSessionMode = vi.fn().mockRejectedValue(new PreflightError('preflight failed'));
    const createMuxApp = vi.fn(() => makeFakeMuxApp());

    await expect(
      muxMain([], {
        resolveSessionMode,
        createMuxApp,
        skipNativeProbes: true,
        sleep,
      }),
    ).rejects.toThrow('process.exit:1');

    // The 3-second sleep MUST NOT have been triggered — preflight short-
    // circuits before the autoApprove warning block runs.
    expect(sleep).not.toHaveBeenCalled();
    expect(createMuxApp).not.toHaveBeenCalled();
  });

  it('builtin mode is rejected with a clean error (mux requires Docker)', async () => {
    // If preferredMode resolves to builtin, the mux child PTY can't run.
    // Fail fast with a single coherent message rather than per-tab spam.
    const resolveSessionMode = vi.fn().mockResolvedValue({
      mode: { kind: 'builtin' },
      reason: 'preferredMode = builtin',
    });
    const createMuxApp = vi.fn(() => makeFakeMuxApp());

    await expect(
      muxMain([], {
        resolveSessionMode,
        createMuxApp,
        skipNativeProbes: true,
      }),
    ).rejects.toThrow('process.exit:1');

    expect(createMuxApp).not.toHaveBeenCalled();
    const stderrText = stderr.lines.join('');
    expect(stderrText).toMatch(/ironcurtain mux requires Docker agent mode/);
  });

  it('uses the resolved preflight agent (not the raw --agent value) when constructing the MuxApp', async () => {
    // When --agent is omitted, the resolved agent must come from preflight
    // (driven by preferredDockerAgent), not from a hardcoded default.
    const resolveSessionMode = vi.fn().mockResolvedValue(makePreflightSuccess('goose'));
    const captured: MuxAppOptions[] = [];
    const createMuxApp = vi.fn((opts: MuxAppOptions) => {
      captured.push(opts);
      return makeFakeMuxApp();
    });

    await muxMain([], {
      resolveSessionMode,
      createMuxApp,
      skipNativeProbes: true,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].agent).toBe('goose');
  });
});
