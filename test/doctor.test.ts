/**
 * Tests for `ironcurtain doctor`.
 *
 * Two layers:
 *   - Pure unit tests for each check function (no IO unless mocked).
 *   - Integration smoke test that drives `runDoctorCommand([])` against a
 *     tmpdir IRONCURTAIN_HOME and asserts exit-code propagation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import chalk from 'chalk';

// Module mocks for the OAuth-refresh and API-round-trip unit tests below.
// `vi.fn(actual.fn)` keeps default behavior intact so the integration-style
// tests in `describe('runDoctorCommand', ...)` still hit the real impls;
// individual unit tests override with `mockResolvedValueOnce` / `mockReturnValueOnce`.
vi.mock('../src/docker/oauth-credentials.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/docker/oauth-credentials.js')>();
  return {
    ...actual,
    detectAuthMethod: vi.fn(actual.detectAuthMethod),
    refreshOAuthToken: vi.fn(actual.refreshOAuthToken),
    saveOAuthCredentials: vi.fn(actual.saveOAuthCredentials),
    writeToKeychain: vi.fn(actual.writeToKeychain),
  };
});
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(actual.generateText) };
});
vi.mock('../src/config/model-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/model-provider.js')>();
  return { ...actual, createLanguageModel: vi.fn(actual.createLanguageModel) };
});

import {
  checkAnnotationDrift,
  checkConstitutionDrift,
  checkDocker,
  checkMcpServerLiveness,
  checkNodeVersion,
  checkServerCredentials,
  collectDeclaredEnvVars,
  type CheckResult,
} from '../src/doctor/checks.js';
import type { ProbeResult } from '../src/doctor/mcp-liveness.js';
import type { IronCurtainConfig, MCPServerConfig } from '../src/config/types.js';
import { detectAuthMethod, refreshOAuthToken, saveOAuthCredentials } from '../src/docker/oauth-credentials.js';
import { generateText } from 'ai';
import { createLanguageModel } from '../src/config/model-provider.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Captures stdout/stderr writes (and console.error) and suppresses process.exit. */
async function captureOutput(fn: () => Promise<void>): Promise<{ output: string; exitCode: number | undefined }> {
  const writes: string[] = [];
  const origStdout = process.stdout.write;
  const origStderr = process.stderr.write;
  const origConsoleError = console.error;
  process.stdout.write = ((chunk: string) => {
    writes.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    writes.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  console.error = ((...args: unknown[]) => {
    writes.push(args.map(String).join(' ') + '\n');
  }) as typeof console.error;

  const origExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error(`__exit_${code ?? 0}`);
  }) as typeof process.exit;

  try {
    await fn();
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('__exit_')) {
      throw err;
    }
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    console.error = origConsoleError;
    process.exit = origExit;
  }
  return { output: writes.join(''), exitCode };
}

function buildServerConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    command: 'true',
    args: [],
    ...overrides,
  };
}

function buildConfig(overrides: Partial<IronCurtainConfig> = {}): IronCurtainConfig {
  const userConfigStub = {
    agentModelId: 'anthropic:claude-sonnet-4-6',
    policyModelId: 'anthropic:claude-sonnet-4-6',
    prefilterModelId: 'anthropic:claude-haiku-4-5',
    anthropicApiKey: '',
    googleApiKey: '',
    openaiApiKey: '',
    anthropicBaseUrl: '',
    openaiBaseUrl: '',
    googleBaseUrl: '',
    escalationTimeoutSeconds: 300,
    resourceBudget: {
      maxTotalTokens: 1_000_000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5,
      warnThresholdPercent: 80,
    },
    autoCompact: { enabled: true, thresholdTokens: 100_000, keepRecentMessages: 10, summaryModelId: 'anthropic:m' },
    autoApprove: { enabled: false, modelId: 'anthropic:m' },
    auditRedaction: { enabled: true },
    memory: { enabled: true, autoSave: true, llmBaseUrl: undefined, llmApiKey: undefined },
    webSearch: { provider: null, brave: null, tavily: null, serpapi: null },
    serverCredentials: {},
    signal: null,
    gooseProvider: 'anthropic' as const,
    gooseModel: 'claude',
    preferredDockerAgent: 'claude-code' as const,
    packageInstall: { enabled: true, quarantineDays: 2, allowedPackages: [], deniedPackages: [] },
  };
  return {
    auditLogPath: '/tmp/audit.jsonl',
    allowedDirectory: '/tmp',
    mcpServers: {},
    protectedPaths: [],
    generatedDir: '/tmp/generated',
    constitutionPath: '/tmp/constitution.md',
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: userConfigStub,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit: checkNodeVersion
// ---------------------------------------------------------------------------

describe('checkNodeVersion', () => {
  it('passes for supported major versions', () => {
    expect(checkNodeVersion('22.13.0').status).toBe('ok');
    expect(checkNodeVersion('23.5.0').status).toBe('ok');
    expect(checkNodeVersion('24.0.0').status).toBe('ok');
  });

  it('fails for too-old major version', () => {
    const result = checkNodeVersion('20.10.0');
    expect(result.status).toBe('fail');
    expect(result.hint).toMatch(/22\.x/);
  });

  it('fails for too-new major version', () => {
    const result = checkNodeVersion('25.0.0');
    expect(result.status).toBe('fail');
  });

  it('fails for unparseable input', () => {
    expect(checkNodeVersion('not-a-version').status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// Unit: checkDocker
// ---------------------------------------------------------------------------

describe('checkDocker', () => {
  it('returns ok when Docker is available', async () => {
    const result = await checkDocker(async () => ({ available: true }));
    expect(result.status).toBe('ok');
    expect(result.message).toBe('running');
  });

  it('returns warn when Docker is unavailable', async () => {
    const result = await checkDocker(async () => ({
      available: false,
      reason: 'not found',
      detailedMessage: 'docker: command not found',
    }));
    expect(result.status).toBe('warn');
    expect(result.hint).toBe('docker: command not found');
  });
});

// ---------------------------------------------------------------------------
// Unit: collectDeclaredEnvVars + checkServerCredentials
// ---------------------------------------------------------------------------

describe('collectDeclaredEnvVars', () => {
  it('collects -e flags from args (Docker convention)', () => {
    const cfg = buildServerConfig({
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/x'],
    });
    expect(collectDeclaredEnvVars(cfg)).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN']);
  });

  it('skips -e KEY=value form', () => {
    const cfg = buildServerConfig({ args: ['-e', 'TOKEN=abc'] });
    expect(collectDeclaredEnvVars(cfg)).toEqual([]);
  });

  it('collects credential-like env keys from config.env', () => {
    const cfg = buildServerConfig({
      env: { MY_API_KEY: '', MCP_TRANSPORT_TYPE: 'stdio' },
    });
    // Only MY_API_KEY is credential-shaped.
    expect(collectDeclaredEnvVars(cfg)).toEqual(['MY_API_KEY']);
  });

  it('returns empty when nothing declared', () => {
    expect(collectDeclaredEnvVars(buildServerConfig())).toEqual([]);
  });
});

describe('checkServerCredentials', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('passes when no credentials are needed', () => {
    const cfg = buildConfig({ mcpServers: { foo: buildServerConfig() } });
    const result = checkServerCredentials('foo', cfg.mcpServers.foo, cfg);
    expect(result.status).toBe('ok');
    expect(result.message).toBe('no credentials required');
  });

  it('passes when env var is set in process.env', () => {
    process.env.MY_TOKEN = 'abc';
    const server = buildServerConfig({ args: ['-e', 'MY_TOKEN'] });
    const cfg = buildConfig({ mcpServers: { svc: server } });
    expect(checkServerCredentials('svc', server, cfg).status).toBe('ok');
  });

  it('passes when env var is set in serverCredentials', () => {
    delete process.env.MY_TOKEN;
    const server = buildServerConfig({ args: ['-e', 'MY_TOKEN'] });
    const cfg = buildConfig({
      mcpServers: { svc: server },
      userConfig: {
        ...buildConfig().userConfig,
        serverCredentials: { svc: { MY_TOKEN: 'xyz' } },
      },
    });
    expect(checkServerCredentials('svc', server, cfg).status).toBe('ok');
  });

  it('passes when env var is set inline in serverConfig.env', () => {
    delete process.env.MY_TOKEN;
    const server = buildServerConfig({ args: [], env: { MY_TOKEN: 'inline-value' } });
    const cfg = buildConfig({ mcpServers: { svc: server } });
    expect(checkServerCredentials('svc', server, cfg).status).toBe('ok');
  });

  it('warns when credentials are missing', () => {
    delete process.env.MY_TOKEN;
    const server = buildServerConfig({ args: ['-e', 'MY_TOKEN'] });
    const cfg = buildConfig({ mcpServers: { svc: server } });
    const result = checkServerCredentials('svc', server, cfg);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('MY_TOKEN');
  });
});

// ---------------------------------------------------------------------------
// Unit: checkConstitutionDrift
// ---------------------------------------------------------------------------

describe('checkConstitutionDrift', () => {
  let tmp: string;
  const savedHome = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'ironcurtain-doctor-drift-'));
    process.env.IRONCURTAIN_HOME = tmp;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns ok when hashes match', async () => {
    const constitutionPath = resolve(tmp, 'constitution.md');
    writeFileSync(constitutionPath, 'base');
    writeFileSync(resolve(tmp, 'constitution-user.md'), 'rules');
    const { computeConstitutionHash } = await import('../src/config/paths.js');
    const hash = computeConstitutionHash(constitutionPath);
    const cfg = buildConfig({ constitutionPath });
    expect(checkConstitutionDrift(cfg, { constitutionHash: hash }).status).toBe('ok');
  });

  it('returns warn when hashes differ', () => {
    const constitutionPath = resolve(tmp, 'constitution.md');
    writeFileSync(constitutionPath, 'base');
    writeFileSync(resolve(tmp, 'constitution-user.md'), 'rules');
    const cfg = buildConfig({ constitutionPath });
    const result = checkConstitutionDrift(cfg, { constitutionHash: 'stale' });
    expect(result.status).toBe('warn');
    expect(result.hint).toMatch(/compile-policy/);
  });

  it('returns fail when constitution file is missing', () => {
    const cfg = buildConfig({ constitutionPath: resolve(tmp, 'missing.md') });
    expect(checkConstitutionDrift(cfg, { constitutionHash: 'x' }).status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// Unit: checkAnnotationDrift
// ---------------------------------------------------------------------------

describe('checkAnnotationDrift', () => {
  it('returns ok when annotations cover all configured servers', () => {
    const annotations = {
      generatedAt: '',
      servers: { fs: { inputHash: 'h', tools: [] } },
    };
    const mcpServers = { fs: buildServerConfig() };
    expect(checkAnnotationDrift(annotations, mcpServers).status).toBe('ok');
  });

  it('warns when a configured server has no annotations', () => {
    const annotations = { generatedAt: '', servers: {} };
    const mcpServers = { fs: buildServerConfig() };
    const result = checkAnnotationDrift(annotations, mcpServers);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('missing: fs');
    expect(result.hint).toContain('annotate-tools --server fs');
  });

  it('warns when annotations have orphaned entries', () => {
    const annotations = {
      generatedAt: '',
      servers: { gone: { inputHash: 'h', tools: [] } },
    };
    const mcpServers = {};
    const result = checkAnnotationDrift(annotations, mcpServers);
    expect(result.status).toBe('warn');
    expect(result.message).toContain('orphaned: gone');
  });
});

// ---------------------------------------------------------------------------
// Unit: checkMcpServerLiveness
// ---------------------------------------------------------------------------

describe('checkMcpServerLiveness', () => {
  it('returns a single skip entry when no servers are configured', async () => {
    const cfg = buildConfig({ mcpServers: {} });
    const results = await checkMcpServerLiveness(cfg);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('skip');
  });

  it('skips servers with missing credentials without spawning', async () => {
    delete process.env.MY_TOKEN;
    const probe = vi.fn();
    const server = buildServerConfig({ args: ['-e', 'MY_TOKEN'] });
    const cfg = buildConfig({ mcpServers: { svc: server } });
    const results = await checkMcpServerLiveness(cfg, { probe });
    expect(probe).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ name: 'svc', status: 'skip' });
  });

  it('runs probes for servers with credentials', async () => {
    process.env.MY_TOKEN = 'value';
    const probe = vi.fn(
      async (): Promise<ProbeResult> => ({
        status: 'ok',
        toolCount: 7,
        elapsedMs: 412,
      }),
    );
    const cfg = buildConfig({
      mcpServers: { svc: buildServerConfig({ args: ['-e', 'MY_TOKEN'] }) },
    });
    const results = await checkMcpServerLiveness(cfg, { probe });
    expect(probe).toHaveBeenCalledOnce();
    expect(results[0].status).toBe('ok');
    expect(results[0].message).toContain('7 tools');
    delete process.env.MY_TOKEN;
  });

  it('reports probe failures as fail with reason in hint', async () => {
    const probe = vi.fn(
      async (): Promise<ProbeResult> => ({
        status: 'fail',
        elapsedMs: 1200,
        reason: 'spawn ENOENT',
      }),
    );
    const cfg = buildConfig({ mcpServers: { svc: buildServerConfig() } });
    const results = await checkMcpServerLiveness(cfg, { probe });
    expect(results[0].status).toBe('fail');
    expect(results[0].hint).toBe('spawn ENOENT');
  });
});

// ---------------------------------------------------------------------------
// Integration: runDoctorCommand exit-code propagation
// ---------------------------------------------------------------------------

describe('runDoctorCommand', () => {
  let tmp: string;
  const savedHome = process.env.IRONCURTAIN_HOME;
  const savedColor = process.env.FORCE_COLOR;
  const savedAllowed = process.env.ALLOWED_DIRECTORY;
  const savedChalkLevel = chalk.level;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'ironcurtain-doctor-int-'));
    process.env.IRONCURTAIN_HOME = tmp;
    process.env.FORCE_COLOR = '0';
    chalk.level = 0;
    // Avoid any incidental ANTHROPIC_API_KEY from the runner environment
    // affecting credential checks (we want deterministic 'no creds').
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ALLOWED_DIRECTORY = tmp;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    if (savedColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = savedColor;
    if (savedAllowed === undefined) delete process.env.ALLOWED_DIRECTORY;
    else process.env.ALLOWED_DIRECTORY = savedAllowed;
    chalk.level = savedChalkLevel;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('prints help and returns when --help is passed', async () => {
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const { output, exitCode } = await captureOutput(() => runDoctorCommand(['--help']));
    expect(output).toContain('ironcurtain doctor');
    expect(output).toContain('--check-api');
    expect(exitCode).toBeUndefined();
  });

  it('prints all sections and a summary footer', async () => {
    // loadConfig() reads from src/config/mcp-servers.json which exists
    // in the repo. We pass a probe stub through DoctorDeps to avoid
    // actually spawning the configured MCP server processes.
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const probeStub = vi.fn(
      async (): Promise<ProbeResult> => ({
        status: 'ok',
        toolCount: 1,
        elapsedMs: 10,
      }),
    );
    const { output } = await captureOutput(() => runDoctorCommand([], { probeMcpServer: probeStub }));
    expect(output).toContain('Environment');
    expect(output).toContain('Configuration');
    expect(output).toContain('Credentials');
    expect(output).toContain('MCP servers');
    expect(output).toMatch(/Summary: \d+ ok, \d+ warn, \d+ fail/);
  });

  it('rejects unknown flags by printing an error', async () => {
    const { runDoctorCommand } = await import('../src/doctor/doctor-command.js');
    const { output, exitCode } = await captureOutput(() => runDoctorCommand(['--bogus']));
    expect(output).toMatch(/--bogus/i);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Unit: checkOAuthRefresh
// ---------------------------------------------------------------------------

describe('checkOAuthRefresh', () => {
  const baseConfig = buildConfig();
  const oauthAuth = {
    kind: 'oauth' as const,
    source: 'file' as const,
    credentials: { accessToken: 'old', refreshToken: 'rt-old', expiresAt: Date.now() + 60_000 },
  };
  const freshCreds = { accessToken: 'new', refreshToken: 'rt-new', expiresAt: Date.now() + 3_600_000 };

  it('skips when no OAuth credentials are present', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce({ kind: 'none' });
    const { checkOAuthRefresh } = await import('../src/doctor/oauth-checks.js');
    const r = await checkOAuthRefresh(baseConfig);
    expect(r.status).toBe('skip');
    expect(r.message).toMatch(/no OAuth credentials/);
  });

  it('returns ok and persists rotated credentials on successful refresh', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce(oauthAuth);
    vi.mocked(refreshOAuthToken).mockResolvedValueOnce({ kind: 'ok', credentials: freshCreds });
    vi.mocked(saveOAuthCredentials).mockReturnValueOnce(undefined);
    const { checkOAuthRefresh } = await import('../src/doctor/oauth-checks.js');
    const r = await checkOAuthRefresh(baseConfig);
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/valid \(.*, file\)/);
    expect(saveOAuthCredentials).toHaveBeenCalledWith(freshCreds);
  });

  it('reports HTTP rejection with the status code and a re-login hint', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce(oauthAuth);
    vi.mocked(refreshOAuthToken).mockResolvedValueOnce({ kind: 'http-error', status: 401 });
    const { checkOAuthRefresh } = await import('../src/doctor/oauth-checks.js');
    const r = await checkOAuthRefresh(baseConfig);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/HTTP 401/);
    expect(r.hint).toMatch(/Refresh token has been invalidated/);
  });

  it('reports network errors with the underlying message', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce(oauthAuth);
    vi.mocked(refreshOAuthToken).mockResolvedValueOnce({ kind: 'network-error', message: 'ECONNRESET' });
    const { checkOAuthRefresh } = await import('../src/doctor/oauth-checks.js');
    const r = await checkOAuthRefresh(baseConfig);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/network error/);
    expect(r.hint).toBe('ECONNRESET');
  });

  it('reports parse errors with the detail', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce(oauthAuth);
    vi.mocked(refreshOAuthToken).mockResolvedValueOnce({ kind: 'parse-error', detail: 'missing access_token' });
    const { checkOAuthRefresh } = await import('../src/doctor/oauth-checks.js');
    const r = await checkOAuthRefresh(baseConfig);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/unparseable/);
    expect(r.hint).toBe('missing access_token');
  });

  it('reports persistence failure separately so the user knows credentials are now invalid', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce(oauthAuth);
    vi.mocked(refreshOAuthToken).mockResolvedValueOnce({ kind: 'ok', credentials: freshCreds });
    vi.mocked(saveOAuthCredentials).mockImplementationOnce(() => {
      throw new Error('EACCES: write denied');
    });
    const { checkOAuthRefresh } = await import('../src/doctor/oauth-checks.js');
    const r = await checkOAuthRefresh(baseConfig);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/refresh succeeded but persistence failed/);
    expect(r.message).toMatch(/EACCES/);
    expect(r.hint).toMatch(/Run `claude login`/);
  });
});

// ---------------------------------------------------------------------------
// Unit: checkAgentApiRoundtrip
// ---------------------------------------------------------------------------

describe('checkAgentApiRoundtrip', () => {
  const baseConfig = buildConfig();
  const fakeModel = {} as never;

  function configWithApiKey(provider: 'anthropic' | 'openai' | 'google', key: string) {
    return buildConfig({
      agentModelId: `${provider}:test-model`,
      userConfig: { ...baseConfig.userConfig, [`${provider}ApiKey`]: key },
    });
  }

  it('skips with provider-aware message when no API key is set and provider is non-Anthropic', async () => {
    // For non-Anthropic providers the OAuth fallback branch is short-circuited,
    // so detectAuthMethod is never called — no need to mock it here.
    const { checkAgentApiRoundtrip } = await import('../src/doctor/checks.js');
    const r = await checkAgentApiRoundtrip(buildConfig({ agentModelId: 'openai:gpt-4' }));
    expect(r.name).toBe('OpenAI API round-trip');
    expect(r.status).toBe('skip');
    expect(r.message).toMatch(/no OpenAI API key/);
  });

  it('skips with OAuth-aware message when Anthropic provider has OAuth but no API key', async () => {
    vi.mocked(detectAuthMethod).mockResolvedValueOnce({
      kind: 'oauth',
      source: 'file',
      credentials: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60_000 },
    });
    const { checkAgentApiRoundtrip } = await import('../src/doctor/checks.js');
    const r = await checkAgentApiRoundtrip(baseConfig);
    expect(r.name).toBe('Anthropic API round-trip');
    expect(r.status).toBe('skip');
    expect(r.message).toMatch(/OAuth-only setup/);
  });

  it('reports ok with elapsed time on a successful round-trip', async () => {
    vi.mocked(createLanguageModel).mockResolvedValueOnce(fakeModel);
    vi.mocked(generateText).mockResolvedValueOnce({} as never);
    const { checkAgentApiRoundtrip } = await import('../src/doctor/checks.js');
    const r = await checkAgentApiRoundtrip(configWithApiKey('anthropic', 'sk-test'));
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/responded in/);
  });

  it('extracts url, status, cause, and code from AI SDK errors via describeApiError', async () => {
    vi.mocked(createLanguageModel).mockResolvedValueOnce(fakeModel);
    const sdkError = Object.assign(new Error('Cannot connect to API'), {
      url: 'https://api.anthropic.com/v1/messages',
      statusCode: 500,
      cause: Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }),
    });
    vi.mocked(generateText).mockRejectedValueOnce(sdkError);
    const { checkAgentApiRoundtrip } = await import('../src/doctor/checks.js');
    const r = await checkAgentApiRoundtrip(configWithApiKey('anthropic', 'sk-test'));
    expect(r.status).toBe('fail');
    expect(r.message).toContain('Cannot connect to API');
    expect(r.message).toContain('url=https://api.anthropic.com/v1/messages');
    expect(r.message).toContain('status=500');
    expect(r.message).toContain('cause=fetch failed');
    expect(r.message).toContain('code=ECONNREFUSED');
  });

  it('passes a timeout abortSignal to generateText so a hung provider cannot block doctor', async () => {
    vi.mocked(createLanguageModel).mockResolvedValueOnce(fakeModel);
    vi.mocked(generateText).mockResolvedValueOnce({} as never);
    const { checkAgentApiRoundtrip } = await import('../src/doctor/checks.js');
    await checkAgentApiRoundtrip(configWithApiKey('anthropic', 'sk-test'));
    const callArgs = vi.mocked(generateText).mock.calls[0][0] as {
      abortSignal?: AbortSignal;
      maxRetries?: number;
    };
    expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal);
    expect(callArgs.maxRetries).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Smoke: CheckResult shape stays stable
// ---------------------------------------------------------------------------

describe('CheckResult shape', () => {
  it('all unit checks return a name, status, and message', () => {
    const samples: CheckResult[] = [
      checkNodeVersion('22.13.0'),
      checkAnnotationDrift({ generatedAt: '', servers: {} }, {}),
    ];
    for (const r of samples) {
      expect(typeof r.name).toBe('string');
      expect(['ok', 'warn', 'fail', 'skip']).toContain(r.status);
      expect(typeof r.message).toBe('string');
    }
  });
});
