import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir, platform, homedir } from 'node:os';
import type { IronCurtainConfig } from '../src/config/types.js';
import {
  parseCredentialsJson,
  parseAnthropicCredentialsJson,
  getAnthropicCredentialsFilePath,
  parseCodexAuthJson,
  loadCodexOAuthCredentials,
  loadCredentialsFromFile,
  isTokenExpired,
  detectAuthMethod,
  extractFromKeychain,
  extractFromKeychainWithService,
  writeToKeychain,
  refreshOAuthToken,
  refreshCodexOAuthToken,
  saveOAuthCredentials,
  saveCodexOAuthCredentials,
  type OAuthCredentials,
  type CredentialSources,
} from '../src/docker/oauth-credentials.js';

// Valid OAuth credentials fixture
const VALID_CREDENTIALS = {
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-test-access-token',
    refreshToken: 'sk-ant-ort01-test-refresh-token',
    expiresAt: Date.now() + 3_600_000, // 1 hour from now
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
  },
};

// Valid Anthropic CLI credential store fixture (~/.config/anthropic/credentials/default.json)
const VALID_ANTHROPIC_CLI_CREDENTIALS = {
  version: '1.0',
  type: 'oauth_token',
  access_token: 'sk-ant-oat01-cli-access-token',
  expires_at: Math.floor((Date.now() + 3_600_000) / 1000),
  refresh_token: 'sk-ant-ort01-cli-refresh-token',
  scope: 'user:developer user:inference user:profile',
  organization_uuid: 'org-uuid-1234',
};

function makeConfig(overrides?: Partial<IronCurtainConfig['userConfig']>): IronCurtainConfig {
  return {
    auditLogPath: '/tmp/audit.jsonl',
    allowedDirectory: '/tmp/sandbox',
    mcpServers: {},
    protectedPaths: [],
    generatedDir: '/tmp/generated',
    constitutionPath: '/tmp/constitution.md',
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
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
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      webSearch: { provider: null, brave: null, tavily: null, serpapi: null },
      serverCredentials: {},
      signal: null,
      ...overrides,
    },
  };
}

function validCreds(overrides?: Partial<OAuthCredentials>): OAuthCredentials {
  return {
    accessToken: 'sk-ant-oat01-test-access-token',
    refreshToken: 'sk-ant-ort01-test-refresh-token',
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

function expiredCreds(overrides?: Partial<OAuthCredentials>): OAuthCredentials {
  return {
    accessToken: 'sk-ant-oat01-expired',
    refreshToken: 'sk-ant-ort01-expired',
    expiresAt: Date.now() - 1000,
    ...overrides,
  };
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: string | Record<string, unknown>) =>
    Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.${encode('sig')}`;
}

function makeSources(overrides: Partial<CredentialSources>): CredentialSources {
  return {
    loadFromFile: () => null,
    loadFromKeychain: () => null,
    ...overrides,
  };
}

// --- parseCredentialsJson ---

describe('parseCredentialsJson', () => {
  it('parses valid credentials JSON', () => {
    const result = parseCredentialsJson(JSON.stringify(VALID_CREDENTIALS));
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('sk-ant-oat01-test-access-token');
    expect(result!.refreshToken).toBe('sk-ant-ort01-test-refresh-token');
    expect(result!.expiresAt).toBe(VALID_CREDENTIALS.claudeAiOauth.expiresAt);
  });

  it('returns null for invalid JSON', () => {
    expect(parseCredentialsJson('not json')).toBeNull();
  });

  it('returns null for empty object', () => {
    expect(parseCredentialsJson('{}')).toBeNull();
  });

  it('returns null when claudeAiOauth is missing', () => {
    expect(parseCredentialsJson(JSON.stringify({ otherField: 'value' }))).toBeNull();
  });

  it('returns null when claudeAiOauth is not an object', () => {
    expect(parseCredentialsJson(JSON.stringify({ claudeAiOauth: 'string' }))).toBeNull();
  });

  it('returns null when accessToken is missing', () => {
    const creds = {
      claudeAiOauth: {
        refreshToken: 'sk-ant-ort01-test',
        expiresAt: Date.now() + 3600000,
      },
    };
    expect(parseCredentialsJson(JSON.stringify(creds))).toBeNull();
  });

  it('returns null when accessToken is empty string', () => {
    const creds = {
      claudeAiOauth: {
        accessToken: '',
        refreshToken: 'sk-ant-ort01-test',
        expiresAt: Date.now() + 3600000,
      },
    };
    expect(parseCredentialsJson(JSON.stringify(creds))).toBeNull();
  });

  it('returns null when refreshToken is missing', () => {
    const creds = {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-test',
        expiresAt: Date.now() + 3600000,
      },
    };
    expect(parseCredentialsJson(JSON.stringify(creds))).toBeNull();
  });

  it('returns null when expiresAt is missing', () => {
    const creds = {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-test',
        refreshToken: 'sk-ant-ort01-test',
      },
    };
    expect(parseCredentialsJson(JSON.stringify(creds))).toBeNull();
  });

  it('returns null when expiresAt is not a number', () => {
    const creds = {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-test',
        refreshToken: 'sk-ant-ort01-test',
        expiresAt: '2026-01-01',
      },
    };
    expect(parseCredentialsJson(JSON.stringify(creds))).toBeNull();
  });

  it('returns null when expiresAt is non-finite or non-positive', () => {
    const base = { accessToken: 'sk-ant-oat01-test', refreshToken: 'sk-ant-ort01-test' };
    expect(parseCredentialsJson(JSON.stringify({ claudeAiOauth: { ...base, expiresAt: NaN } }))).toBeNull();
    expect(parseCredentialsJson(JSON.stringify({ claudeAiOauth: { ...base, expiresAt: Infinity } }))).toBeNull();
    expect(parseCredentialsJson(JSON.stringify({ claudeAiOauth: { ...base, expiresAt: -1 } }))).toBeNull();
    expect(parseCredentialsJson(JSON.stringify({ claudeAiOauth: { ...base, expiresAt: 0 } }))).toBeNull();
  });

  it('returns null for non-object JSON root', () => {
    expect(parseCredentialsJson('"just a string"')).toBeNull();
    expect(parseCredentialsJson('42')).toBeNull();
    expect(parseCredentialsJson('null')).toBeNull();
    expect(parseCredentialsJson('[]')).toBeNull();
  });
});

// --- parseAnthropicCredentialsJson ---

describe('parseAnthropicCredentialsJson', () => {
  it('parses Anthropic CLI credentials and converts expires_at to milliseconds', () => {
    const result = parseAnthropicCredentialsJson(JSON.stringify(VALID_ANTHROPIC_CLI_CREDENTIALS));
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('sk-ant-oat01-cli-access-token');
    expect(result!.refreshToken).toBe('sk-ant-ort01-cli-refresh-token');
    expect(result!.expiresAt).toBe(VALID_ANTHROPIC_CLI_CREDENTIALS.expires_at * 1000);
  });

  it('tags CLI-store credentials with clientKind anthropic-cli', () => {
    const result = parseAnthropicCredentialsJson(JSON.stringify(VALID_ANTHROPIC_CLI_CREDENTIALS));
    expect(result!.clientKind).toBe('anthropic-cli');
    // Claude Code credentials stay untagged (undefined means claude-code)
    expect(parseCredentialsJson(JSON.stringify(VALID_CREDENTIALS))!.clientKind).toBeUndefined();
  });

  it('returns null when type is present but not oauth_token', () => {
    const creds = { ...VALID_ANTHROPIC_CLI_CREDENTIALS, type: 'api_key' };
    expect(parseAnthropicCredentialsJson(JSON.stringify(creds))).toBeNull();
  });

  it('accepts credentials without a type field (documented store schema)', () => {
    // The WIF reference documents {version, access_token, expires_at,
    // refresh_token, scope} without a type discriminator.
    const noType = { ...VALID_ANTHROPIC_CLI_CREDENTIALS, type: undefined };
    const result = parseAnthropicCredentialsJson(JSON.stringify(noType));
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('sk-ant-oat01-cli-access-token');
  });

  it('returns null when required fields are missing or invalid', () => {
    // JSON.stringify drops keys whose value is undefined
    const noAccess = { ...VALID_ANTHROPIC_CLI_CREDENTIALS, access_token: undefined };
    const noRefresh = { ...VALID_ANTHROPIC_CLI_CREDENTIALS, refresh_token: undefined };
    expect(parseAnthropicCredentialsJson(JSON.stringify(noAccess))).toBeNull();
    expect(parseAnthropicCredentialsJson(JSON.stringify(noRefresh))).toBeNull();
    expect(
      parseAnthropicCredentialsJson(JSON.stringify({ ...VALID_ANTHROPIC_CLI_CREDENTIALS, expires_at: 'soon' })),
    ).toBeNull();
    expect(parseAnthropicCredentialsJson('not json')).toBeNull();
    expect(parseAnthropicCredentialsJson('null')).toBeNull();
  });
});

// --- getAnthropicCredentialsFilePath ---

describe('getAnthropicCredentialsFilePath', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to ~/.config/anthropic/credentials/default.json', () => {
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', '');
    delete process.env.ANTHROPIC_CONFIG_DIR;
    vi.stubEnv('XDG_CONFIG_HOME', '');
    delete process.env.XDG_CONFIG_HOME;
    expect(getAnthropicCredentialsFilePath()).toBe(
      resolve(homedir(), '.config', 'anthropic', 'credentials', 'default.json'),
    );
  });

  it('honors XDG_CONFIG_HOME', () => {
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', '');
    delete process.env.ANTHROPIC_CONFIG_DIR;
    vi.stubEnv('XDG_CONFIG_HOME', '/custom/xdg');
    expect(getAnthropicCredentialsFilePath()).toBe(resolve('/custom/xdg', 'anthropic', 'credentials', 'default.json'));
  });

  it('prefers ANTHROPIC_CONFIG_DIR over XDG_CONFIG_HOME', () => {
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', '/custom/anthropic');
    vi.stubEnv('XDG_CONFIG_HOME', '/custom/xdg');
    expect(getAnthropicCredentialsFilePath()).toBe(resolve('/custom/anthropic', 'credentials', 'default.json'));
  });

  it('treats an empty ANTHROPIC_CONFIG_DIR as unset', () => {
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', '');
    vi.stubEnv('XDG_CONFIG_HOME', '/custom/xdg');
    expect(getAnthropicCredentialsFilePath()).toBe(resolve('/custom/xdg', 'anthropic', 'credentials', 'default.json'));
  });
});

describe('parseCodexAuthJson', () => {
  it('parses Codex ChatGPT auth.json credentials', () => {
    const accessToken = unsignedJwt({ exp: 4_102_444_800, sub: 'codex-test' });
    const idToken = unsignedJwt({ email: 'test@example.com' });
    const result = parseCodexAuthJson(
      JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          id_token: idToken,
          access_token: accessToken,
          refresh_token: 'codex-refresh-token',
          account_id: 'acct_123',
        },
      }),
    );

    expect(result).toEqual({
      accessToken,
      refreshToken: 'codex-refresh-token',
      expiresAt: 4_102_444_800_000,
      idToken,
      accountId: 'acct_123',
    });
  });

  it('parses externally managed Codex ChatGPT token auth.json credentials', () => {
    const accessToken = unsignedJwt({ exp: 4_102_444_800, sub: 'codex-test' });
    const result = parseCodexAuthJson(
      JSON.stringify({
        auth_mode: 'chatgptAuthTokens',
        tokens: {
          access_token: accessToken,
          refresh_token: '',
          account_id: 'acct_external',
        },
      }),
    );

    expect(result).toEqual({
      accessToken,
      refreshToken: '',
      expiresAt: 4_102_444_800_000,
      idToken: undefined,
      accountId: 'acct_external',
    });
  });

  it('rejects API-key auth and malformed token shapes', () => {
    expect(parseCodexAuthJson(JSON.stringify({ auth_mode: 'apikey', tokens: { access_token: 'token' } }))).toBeNull();
    expect(parseCodexAuthJson(JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }))).toBeNull();
    expect(parseCodexAuthJson('not json')).toBeNull();
  });
});

// --- loadCredentialsFromFile ---

describe('loadCredentialsFromFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'oauth-creds-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads valid credentials from a file', () => {
    const filePath = resolve(tmpDir, '.credentials.json');
    writeFileSync(filePath, JSON.stringify(VALID_CREDENTIALS));

    const result = loadCredentialsFromFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('sk-ant-oat01-test-access-token');
  });

  it('returns null when file does not exist', () => {
    const result = loadCredentialsFromFile(resolve(tmpDir, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('returns null when file contains invalid JSON', () => {
    const filePath = resolve(tmpDir, '.credentials.json');
    writeFileSync(filePath, 'not valid json {{{');

    const result = loadCredentialsFromFile(filePath);
    expect(result).toBeNull();
  });

  it('returns null when file contains valid JSON without claudeAiOauth', () => {
    const filePath = resolve(tmpDir, '.credentials.json');
    writeFileSync(filePath, JSON.stringify({ someOtherKey: 'value' }));

    const result = loadCredentialsFromFile(filePath);
    expect(result).toBeNull();
  });

  it('loads Anthropic CLI-format credentials', () => {
    const filePath = resolve(tmpDir, 'default.json');
    writeFileSync(filePath, JSON.stringify(VALID_ANTHROPIC_CLI_CREDENTIALS));

    const result = loadCredentialsFromFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('sk-ant-oat01-cli-access-token');
    expect(result!.expiresAt).toBe(VALID_ANTHROPIC_CLI_CREDENTIALS.expires_at * 1000);
  });
});

describe('loadCodexOAuthCredentials', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codex-oauth-creds-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads valid Codex credentials from a file', () => {
    const filePath = resolve(tmpDir, 'auth.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'codex-access-token', refresh_token: 'codex-refresh-token' },
      }),
    );

    const result = loadCodexOAuthCredentials(filePath);
    expect(result?.accessToken).toBe('codex-access-token');
  });

  it('returns null when the file is missing or not ChatGPT auth', () => {
    expect(loadCodexOAuthCredentials(resolve(tmpDir, 'missing.json'))).toBeNull();

    const filePath = resolve(tmpDir, 'auth.json');
    writeFileSync(filePath, JSON.stringify({ auth_mode: 'apikey', tokens: { access_token: 'codex-access-token' } }));
    expect(loadCodexOAuthCredentials(filePath)).toBeNull();
  });
});

// --- isTokenExpired ---

describe('isTokenExpired', () => {
  it('returns false for token valid well into the future', () => {
    expect(isTokenExpired(validCreds())).toBe(false);
  });

  it('returns true for token that expired in the past', () => {
    expect(isTokenExpired(expiredCreds())).toBe(true);
  });

  it('returns true for token expiring within 5-minute buffer', () => {
    const credentials = validCreds({ expiresAt: Date.now() + 2 * 60 * 1000 });
    expect(isTokenExpired(credentials)).toBe(true);
  });

  it('returns false for token expiring just after 5-minute buffer', () => {
    const credentials = validCreds({ expiresAt: Date.now() + 6 * 60 * 1000 });
    expect(isTokenExpired(credentials)).toBe(false);
  });
});

// --- detectAuthMethod ---

describe('detectAuthMethod', () => {
  let savedDockerAuth: string | undefined;

  beforeEach(() => {
    savedDockerAuth = process.env.IRONCURTAIN_DOCKER_AUTH;
    delete process.env.IRONCURTAIN_DOCKER_AUTH;
  });

  afterEach(() => {
    if (savedDockerAuth === undefined) {
      delete process.env.IRONCURTAIN_DOCKER_AUTH;
    } else {
      process.env.IRONCURTAIN_DOCKER_AUTH = savedDockerAuth;
    }
  });

  it('returns oauth when valid credentials are found from file', async () => {
    const creds = validCreds();
    const sources = makeSources({ loadFromFile: () => creds });

    const result = await detectAuthMethod(makeConfig(), sources);
    expect(result.kind).toBe('oauth');
    if (result.kind === 'oauth') {
      expect(result.credentials.accessToken).toBe('sk-ant-oat01-test-access-token');
      expect(result.source).toBe('file');
    }
  });

  it('reports the source file path when loadFromFilesWithSource is available', async () => {
    const creds = validCreds();
    const filePath = '/home/user/.config/anthropic/credentials/default.json';
    const sources = makeSources({
      loadFromFilesWithSource: () => [{ credentials: creds, filePath }],
    });

    const result = await detectAuthMethod(makeConfig(), sources);
    expect(result.kind).toBe('oauth');
    if (result.kind === 'oauth' && result.source === 'file') {
      expect(result.filePath).toBe(filePath);
    }
  });

  it('saves refreshed credentials back to the originating file', async () => {
    const filePath = '/home/user/.config/anthropic/credentials/default.json';
    const refreshed = validCreds({ accessToken: 'sk-ant-oat01-refreshed' });
    const saveToFile = vi.fn();
    const sources = makeSources({
      loadFromFilesWithSource: () => [{ credentials: expiredCreds(), filePath }],
      refreshToken: async () => refreshed,
      saveToFile,
    });

    const result = await detectAuthMethod(makeConfig(), sources);
    expect(result.kind).toBe('oauth');
    if (result.kind === 'oauth' && result.source === 'file') {
      expect(result.credentials.accessToken).toBe('sk-ant-oat01-refreshed');
      expect(result.filePath).toBe(filePath);
    }
    expect(saveToFile).toHaveBeenCalledWith(refreshed, filePath);
  });

  it('does not let an expired legacy file shadow a valid Anthropic CLI file', async () => {
    const legacyPath = '/home/user/.claude/.credentials.json';
    const cliPath = '/home/user/.config/anthropic/credentials/default.json';
    const cliCreds = validCreds({ accessToken: 'sk-ant-oat01-cli-valid' });
    const sources = makeSources({
      loadFromFilesWithSource: () => [
        { credentials: expiredCreds(), filePath: legacyPath },
        { credentials: cliCreds, filePath: cliPath },
      ],
      // Legacy refresh token is stale/revoked
      refreshToken: async () => null,
    });

    const result = await detectAuthMethod(makeConfig(), sources);
    expect(result.kind).toBe('oauth');
    if (result.kind === 'oauth' && result.source === 'file') {
      expect(result.credentials.accessToken).toBe('sk-ant-oat01-cli-valid');
      expect(result.filePath).toBe(cliPath);
    }
  });

  it('falls through to the next file when the first is expired and unrefreshable', async () => {
    const legacyPath = '/home/user/.claude/.credentials.json';
    const cliPath = '/home/user/.config/anthropic/credentials/default.json';
    const expiredLegacy = expiredCreds({ refreshToken: 'sk-ant-ort01-legacy-stale' });
    const expiredCli = expiredCreds({ refreshToken: 'sk-ant-ort01-cli-good' });
    const refreshed = validCreds({ accessToken: 'sk-ant-oat01-cli-refreshed' });
    const saveToFile = vi.fn();
    const sources = makeSources({
      loadFromFilesWithSource: () => [
        { credentials: expiredLegacy, filePath: legacyPath },
        { credentials: expiredCli, filePath: cliPath },
      ],
      // Only the CLI store's refresh token still works
      refreshToken: async (rt) => (rt === 'sk-ant-ort01-cli-good' ? refreshed : null),
      saveToFile,
    });

    const result = await detectAuthMethod(makeConfig(), sources);
    expect(result.kind).toBe('oauth');
    if (result.kind === 'oauth' && result.source === 'file') {
      expect(result.credentials.accessToken).toBe('sk-ant-oat01-cli-refreshed');
      expect(result.filePath).toBe(cliPath);
    }
    expect(saveToFile).toHaveBeenCalledWith(refreshed, cliPath);
  });

  it('refreshes CLI-store credentials with their own client kind', async () => {
    const cliPath = '/home/user/.config/anthropic/credentials/default.json';
    const expiredCli = expiredCreds({ refreshToken: 'sk-ant-ort01-cli', clientKind: 'anthropic-cli' });
    const refreshed = validCreds({ clientKind: 'anthropic-cli' });
    const refreshToken = vi.fn(async () => refreshed);
    const sources = makeSources({
      loadFromFilesWithSource: () => [{ credentials: expiredCli, filePath: cliPath }],
      refreshToken,
      saveToFile: vi.fn(),
    });

    const result = await detectAuthMethod(makeConfig(), sources);
    expect(result.kind).toBe('oauth');
    expect(refreshToken).toHaveBeenCalledWith('sk-ant-ort01-cli', 'anthropic-cli');
  });

  it('falls back to apikey when no OAuth credentials', async () => {
    const sources = makeSources({});
    const config = makeConfig({ anthropicApiKey: 'sk-ant-api03-test-key' });

    const result = await detectAuthMethod(config, sources);
    expect(result.kind).toBe('apikey');
    if (result.kind === 'apikey') {
      expect(result.key).toBe('sk-ant-api03-test-key');
    }
  });

  it('returns none when no OAuth and no API key', async () => {
    const sources = makeSources({});
    const config = makeConfig({ anthropicApiKey: '' });

    const result = await detectAuthMethod(config, sources);
    expect(result.kind).toBe('none');
  });

  it('falls back to apikey when OAuth token is expired and no refresh', async () => {
    const sources = makeSources({ loadFromFile: () => expiredCreds() });
    const config = makeConfig({ anthropicApiKey: 'sk-ant-api03-fallback' });

    const result = await detectAuthMethod(config, sources);
    expect(result.kind).toBe('apikey');
    if (result.kind === 'apikey') {
      expect(result.key).toBe('sk-ant-api03-fallback');
    }
  });

  it('respects IRONCURTAIN_DOCKER_AUTH=apikey override', async () => {
    process.env.IRONCURTAIN_DOCKER_AUTH = 'apikey';

    const creds = validCreds();
    const sources = makeSources({ loadFromFile: () => creds });
    const config = makeConfig({ anthropicApiKey: 'sk-ant-api03-forced' });

    const result = await detectAuthMethod(config, sources);
    expect(result.kind).toBe('apikey');
    if (result.kind === 'apikey') {
      expect(result.key).toBe('sk-ant-api03-forced');
    }
  });

  it('tries Keychain when credentials file returns null', async () => {
    const keychainCreds = validCreds({ accessToken: 'sk-ant-oat01-keychain-token' });
    const sources = makeSources({
      loadFromFile: () => null,
      loadFromKeychain: () => keychainCreds,
    });

    const result = await detectAuthMethod(makeConfig(), sources);
    expect(result.kind).toBe('oauth');
    if (result.kind === 'oauth') {
      expect(result.credentials.accessToken).toBe('sk-ant-oat01-keychain-token');
      expect(result.source).toBe('keychain');
    }
  });

  it('does not try Keychain when credentials file exists but is expired', async () => {
    let keychainCalled = false;
    const sources: CredentialSources = {
      loadFromFile: () => expiredCreds(),
      loadFromKeychain: () => {
        keychainCalled = true;
        return validCreds({ accessToken: 'sk-ant-oat01-keychain-fresh' });
      },
    };
    const config = makeConfig({ anthropicApiKey: 'sk-ant-api03-fallback' });

    const result = await detectAuthMethod(config, sources);
    expect(keychainCalled).toBe(false);
    expect(result.kind).toBe('apikey');
    if (result.kind === 'apikey') {
      expect(result.key).toBe('sk-ant-api03-fallback');
    }
  });

  it('falls back to apikey when Keychain credentials are expired and no refresh', async () => {
    const sources = makeSources({
      loadFromFile: () => null,
      loadFromKeychain: () => expiredCreds(),
    });
    const config = makeConfig({ anthropicApiKey: 'sk-ant-api03-keychain-fallback' });

    const result = await detectAuthMethod(config, sources);
    expect(result.kind).toBe('apikey');
    if (result.kind === 'apikey') {
      expect(result.key).toBe('sk-ant-api03-keychain-fallback');
    }
  });

  it('returns none when all sources fail and no API key', async () => {
    const sources = makeSources({});
    const config = makeConfig({ anthropicApiKey: '' });

    const result = await detectAuthMethod(config, sources);
    expect(result.kind).toBe('none');
  });

  it('refreshes expired file credentials when refresh function is provided', async () => {
    const refreshed = validCreds({ accessToken: 'sk-ant-oat01-refreshed' });
    const saveFn = vi.fn();
    const sources = makeSources({
      loadFromFile: () => expiredCreds(),
      refreshToken: async () => refreshed,
      saveToFile: saveFn,
    });

    const result = await detectAuthMethod(makeConfig(), sources);
    expect(result.kind).toBe('oauth');
    if (result.kind === 'oauth') {
      expect(result.credentials.accessToken).toBe('sk-ant-oat01-refreshed');
      expect(result.source).toBe('file');
    }
    expect(saveFn).toHaveBeenCalledWith(refreshed, undefined);
  });

  it('refreshes expired Keychain credentials and returns keychainServiceName', async () => {
    const refreshed = validCreds({ accessToken: 'sk-ant-oat01-keychain-refreshed' });
    const writeKcFn = vi.fn();
    const sources = makeSources({
      loadFromFile: () => null,
      loadFromKeychainWithService: () => ({
        credentials: expiredCreds(),
        serviceName: 'Claude Code-credentials',
      }),
      refreshToken: async () => refreshed,
      writeToKeychain: writeKcFn,
    });

    const result = await detectAuthMethod(makeConfig(), sources);
    expect(result.kind).toBe('oauth');
    if (result.kind === 'oauth') {
      expect(result.credentials.accessToken).toBe('sk-ant-oat01-keychain-refreshed');
      expect(result.source).toBe('keychain');
      if (result.source === 'keychain') {
        expect(result.keychainServiceName).toBe('Claude Code-credentials');
      }
    }
    expect(writeKcFn).toHaveBeenCalledWith(refreshed, 'Claude Code-credentials');
  });

  it('falls back to apikey when expired credentials refresh fails', async () => {
    const sources = makeSources({
      loadFromFile: () => expiredCreds(),
      refreshToken: async () => null,
    });
    const config = makeConfig({ anthropicApiKey: 'sk-ant-api03-fallback' });

    const result = await detectAuthMethod(config, sources);
    expect(result.kind).toBe('apikey');
  });

  it('falls back to apikey when expired Keychain credentials refresh fails', async () => {
    const sources = makeSources({
      loadFromFile: () => null,
      loadFromKeychainWithService: () => ({
        credentials: expiredCreds(),
        serviceName: 'Claude Code',
      }),
      refreshToken: async () => null,
    });
    const config = makeConfig({ anthropicApiKey: 'sk-ant-api03-kc-fallback' });

    const result = await detectAuthMethod(config, sources);
    expect(result.kind).toBe('apikey');
    if (result.kind === 'apikey') {
      expect(result.key).toBe('sk-ant-api03-kc-fallback');
    }
  });

  it('Keychain result includes serviceName from loadFromKeychainWithService', async () => {
    const keychainCreds = validCreds({ accessToken: 'sk-ant-oat01-kc-with-service' });
    const sources = makeSources({
      loadFromFile: () => null,
      loadFromKeychainWithService: () => ({
        credentials: keychainCreds,
        serviceName: 'Claude Code',
      }),
    });

    const result = await detectAuthMethod(makeConfig(), sources);
    expect(result.kind).toBe('oauth');
    if (result.kind === 'oauth' && result.source === 'keychain') {
      expect(result.keychainServiceName).toBe('Claude Code');
    }
  });
});

// --- extractFromKeychain ---

describe('extractFromKeychain', () => {
  it('returns null on non-macOS platforms', () => {
    if (platform() !== 'darwin') {
      expect(extractFromKeychain()).toBeNull();
    }
  });
});

// --- extractFromKeychainWithService ---

describe('extractFromKeychainWithService', () => {
  it('returns null on non-macOS platforms', () => {
    if (platform() !== 'darwin') {
      expect(extractFromKeychainWithService()).toBeNull();
    }
  });
});

// --- writeToKeychain ---

describe('writeToKeychain', () => {
  it('is a no-op on non-macOS platforms', () => {
    if (platform() !== 'darwin') {
      // Should not throw
      expect(() => writeToKeychain(validCreds(), 'Claude Code')).not.toThrow();
    }
  });
});

// --- OAuth provider configs ---

describe('OAuth provider configs', () => {
  it('anthropicOAuthProvider uses bearer injection', async () => {
    const { anthropicOAuthProvider } = await import('../src/docker/provider-config.js');
    expect(anthropicOAuthProvider.host).toBe('api.anthropic.com');
    expect(anthropicOAuthProvider.keyInjection).toEqual({ type: 'bearer' });
    expect(anthropicOAuthProvider.fakeKeyPrefix).toBe('sk-ant-oat01-ironcurtain-');
    expect(anthropicOAuthProvider.displayName).toBe('Anthropic (OAuth)');
  });

  it('claudePlatformOAuthProvider uses bearer injection', async () => {
    const { claudePlatformOAuthProvider } = await import('../src/docker/provider-config.js');
    expect(claudePlatformOAuthProvider.host).toBe('platform.claude.com');
    expect(claudePlatformOAuthProvider.keyInjection).toEqual({ type: 'bearer' });
    expect(claudePlatformOAuthProvider.fakeKeyPrefix).toBe('sk-ant-oat01-ironcurtain-');
  });

  it('OAuth providers include all API key provider endpoints plus OAuth-only ones', async () => {
    const { anthropicProvider, anthropicOAuthProvider, claudePlatformProvider, claudePlatformOAuthProvider } =
      await import('../src/docker/provider-config.js');

    // OAuth Anthropic provider has all base endpoints plus /api/oauth/usage
    for (const ep of anthropicProvider.allowedEndpoints) {
      expect(anthropicOAuthProvider.allowedEndpoints).toContainEqual(ep);
    }
    expect(anthropicOAuthProvider.allowedEndpoints).toContainEqual({ method: 'GET', path: '/api/oauth/usage' });
    expect(anthropicProvider.allowedEndpoints).not.toContainEqual({ method: 'GET', path: '/api/oauth/usage' });

    // Platform providers share endpoints
    expect(claudePlatformOAuthProvider.allowedEndpoints).toBe(claudePlatformProvider.allowedEndpoints);
  });

  it('OAuth Anthropic provider has request rewriter', async () => {
    const { anthropicOAuthProvider, anthropicProvider } = await import('../src/docker/provider-config.js');
    expect(anthropicOAuthProvider.requestRewriter).toBe(anthropicProvider.requestRewriter);
    expect(anthropicOAuthProvider.rewriteEndpoints).toEqual(['/v1/messages']);
  });
});

// --- Claude Code adapter OAuth support ---

describe('Claude Code adapter OAuth support', () => {
  it('returns OAuth providers when authKind is oauth', async () => {
    const { createClaudeCodeAdapter: createAdapter } = await import('../src/docker/adapters/claude-code.js');
    const claudeCodeAdapter = createAdapter();
    const providers = claudeCodeAdapter.getProviders({} as IronCurtainConfig, 'oauth');
    expect(providers).toHaveLength(2);
    expect(providers[0].displayName).toBe('Anthropic (OAuth)');
    expect(providers[0].keyInjection).toEqual({ type: 'bearer' });
    expect(providers[1].displayName).toBe('Claude Platform (OAuth)');
    expect(providers[1].keyInjection).toEqual({ type: 'bearer' });
  });

  it('returns API key providers when authKind is apikey', async () => {
    const { createClaudeCodeAdapter: createAdapter } = await import('../src/docker/adapters/claude-code.js');
    const claudeCodeAdapter = createAdapter();
    const providers = claudeCodeAdapter.getProviders({} as IronCurtainConfig, 'apikey');
    expect(providers).toHaveLength(2);
    expect(providers[0].displayName).toBe('Anthropic');
    expect(providers[0].keyInjection).toEqual({ type: 'header', headerName: 'x-api-key' });
  });

  it('returns API key providers when authKind is undefined', async () => {
    const { createClaudeCodeAdapter: createAdapter } = await import('../src/docker/adapters/claude-code.js');
    const claudeCodeAdapter = createAdapter();
    const providers = claudeCodeAdapter.getProviders({} as IronCurtainConfig);
    expect(providers).toHaveLength(2);
    expect(providers[0].displayName).toBe('Anthropic');
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN in OAuth mode', async () => {
    const { createClaudeCodeAdapter: createAdapter } = await import('../src/docker/adapters/claude-code.js');
    const claudeCodeAdapter = createAdapter();
    const config = {
      dockerAuth: { kind: 'oauth' as const },
      userConfig: { anthropicApiKey: 'sk-test' },
    } as IronCurtainConfig;

    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-oat01-ironcurtain-FAKE']]);
    const env = claudeCodeAdapter.buildEnv(config, fakeKeys);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-ironcurtain-FAKE');
    expect(env.IRONCURTAIN_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_UPDATE_CHECK).toBe('1');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/usr/local/share/ca-certificates/ironcurtain-ca.crt');
  });

  it('sets IRONCURTAIN_API_KEY in API key mode', async () => {
    const { createClaudeCodeAdapter: createAdapter } = await import('../src/docker/adapters/claude-code.js');
    const claudeCodeAdapter = createAdapter();
    const config = {
      dockerAuth: { kind: 'apikey' as const },
      userConfig: { anthropicApiKey: 'sk-test' },
    } as IronCurtainConfig;

    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = claudeCodeAdapter.buildEnv(config, fakeKeys);
    expect(env.IRONCURTAIN_API_KEY).toBe('sk-ant-api03-ironcurtain-FAKE');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('defaults to API key mode when dockerAuth is undefined', async () => {
    const { createClaudeCodeAdapter: createAdapter } = await import('../src/docker/adapters/claude-code.js');
    const claudeCodeAdapter = createAdapter();
    const config = {
      userConfig: { anthropicApiKey: 'sk-test' },
    } as IronCurtainConfig;

    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = claudeCodeAdapter.buildEnv(config, fakeKeys);
    expect(env.IRONCURTAIN_API_KEY).toBe('sk-ant-api03-ironcurtain-FAKE');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

// --- refreshOAuthToken ---

describe('refreshOAuthToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok with new credentials on successful refresh', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as Response);

    const result = await refreshOAuthToken('old-refresh-token');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.credentials.accessToken).toBe('new-access-token');
    expect(result.credentials.refreshToken).toBe('new-refresh-token');
    expect(result.credentials.expiresAt).toBeGreaterThan(Date.now());

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall[0]).toBe('https://platform.claude.com/v1/oauth/token');
    const opts = fetchCall[1] as RequestInit;
    expect(opts.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });
    const body = new URLSearchParams(opts.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh-token');
    expect(body.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(opts.signal).toBeDefined();
  });

  it('sends a JSON grant with the Anthropic CLI client to api.anthropic.com for anthropic-cli credentials', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        access_token: 'new-cli-access-token',
        refresh_token: 'new-cli-refresh-token',
        expires_in: 28800,
      }),
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse as Response);

    const result = await refreshOAuthToken('old-cli-refresh-token', 'anthropic-cli');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.credentials.accessToken).toBe('new-cli-access-token');
    // The client kind must survive the refresh so the NEXT refresh also
    // targets the issuing client instead of falling back to Claude Code's.
    expect(result.credentials.clientKind).toBe('anthropic-cli');

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.anthropic.com/v1/oauth/token');
    const opts = fetchCall[1] as RequestInit;
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.grant_type).toBe('refresh_token');
    expect(body.refresh_token).toBe('old-cli-refresh-token');
    expect(body.client_id).toBe('41077d10-94b8-4194-be48-d251e9eb21b4');
  });

  it('does not tag claude-code refreshes with a clientKind', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-access', refresh_token: 'new-rt', expires_in: 3600 }),
    } as Response);

    const result = await refreshOAuthToken('old-refresh-token', 'claude-code');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.credentials.clientKind).toBeUndefined();
  });

  it('returns http-error with status on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error": "invalid_grant"}',
    } as Response);

    const result = await refreshOAuthToken('bad-refresh-token');
    expect(result).toEqual({ kind: 'http-error', status: 400 });
  });

  it('tolerates an unreadable error body on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const result = await refreshOAuthToken('bad-refresh-token');
    expect(result).toEqual({ kind: 'http-error', status: 500 });
  });

  it('returns network-error with message when fetch rejects', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));

    const result = await refreshOAuthToken('any-token');
    expect(result.kind).toBe('network-error');
    if (result.kind !== 'network-error') throw new Error('expected network-error');
    expect(result.message).toBe('connect ECONNREFUSED');
  });

  it('returns parse-error when response lacks expires_in', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'token' }), // missing expires_in
    } as Response);

    const result = await refreshOAuthToken('any-token');
    expect(result.kind).toBe('parse-error');
    if (result.kind !== 'parse-error') throw new Error('expected parse-error');
    expect(result.detail).toMatch(/expires_in/);
  });

  it('returns parse-error when response lacks access_token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ expires_in: 3600 }),
    } as Response);

    const result = await refreshOAuthToken('any-token');
    expect(result.kind).toBe('parse-error');
    if (result.kind !== 'parse-error') throw new Error('expected parse-error');
    expect(result.detail).toMatch(/access_token/);
  });

  it('preserves original refresh token when response omits refresh_token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-access', expires_in: 3600 }),
    } as Response);

    const result = await refreshOAuthToken('original-refresh-token');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.credentials.accessToken).toBe('new-access');
    expect(result.credentials.refreshToken).toBe('original-refresh-token');
  });

  it('returns parse-error when expires_in is invalid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'token',
        refresh_token: 'rt',
        expires_in: -1,
      }),
    } as Response);

    const result = await refreshOAuthToken('any-token');
    expect(result.kind).toBe('parse-error');
  });
});

describe('refreshCodexOAuthToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok with new Codex credentials on successful refresh', async () => {
    const accessToken = unsignedJwt({ exp: 4_102_444_800, sub: 'codex-test' });
    const idToken = unsignedJwt({ email: 'test@example.com' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: accessToken,
        refresh_token: 'new-refresh-token',
        id_token: idToken,
      }),
    } as Response);

    const result = await refreshCodexOAuthToken('old-refresh-token');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.credentials.accessToken).toBe(accessToken);
    expect(result.credentials.refreshToken).toBe('new-refresh-token');
    expect(result.credentials.expiresAt).toBe(4_102_444_800_000);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall[0]).toBe('https://auth.openai.com/oauth/token');
    const opts = fetchCall[1] as RequestInit;
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh-token',
    });
  });

  it('returns parse-error when Codex refresh response lacks access_token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ refresh_token: 'rt' }),
    } as Response);

    const result = await refreshCodexOAuthToken('any-token');
    expect(result.kind).toBe('parse-error');
  });
});

describe('refreshResultToCreds', () => {
  it('flattens ok to credentials', async () => {
    const { refreshResultToCreds } = await import('../src/docker/oauth-credentials.js');
    const creds: OAuthCredentials = {
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
    };
    expect(refreshResultToCreds({ kind: 'ok', credentials: creds })).toBe(creds);
  });

  it('flattens non-ok variants to null', async () => {
    const { refreshResultToCreds } = await import('../src/docker/oauth-credentials.js');
    expect(refreshResultToCreds({ kind: 'http-error', status: 401 })).toBeNull();
    expect(refreshResultToCreds({ kind: 'parse-error', detail: 'x' })).toBeNull();
    expect(refreshResultToCreds({ kind: 'network-error', message: 'x' })).toBeNull();
  });
});

// --- saveOAuthCredentials ---

describe('saveOAuthCredentials', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'oauth-save-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates new credentials file when none exists', () => {
    const filePath = resolve(tmpDir, '.credentials.json');
    const creds = validCreds();
    saveOAuthCredentials(creds, filePath);

    const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(saved.claudeAiOauth.accessToken).toBe(creds.accessToken);
    expect(saved.claudeAiOauth.refreshToken).toBe(creds.refreshToken);
    expect(saved.claudeAiOauth.expiresAt).toBe(creds.expiresAt);
  });

  it('preserves existing fields in the file', () => {
    const filePath = resolve(tmpDir, '.credentials.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'old',
          refreshToken: 'old',
          expiresAt: 1000,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
        otherField: 'preserved',
      }),
    );

    const creds = validCreds({ accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: 9999 });
    saveOAuthCredentials(creds, filePath);

    const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
    // Updated fields
    expect(saved.claudeAiOauth.accessToken).toBe('new-at');
    expect(saved.claudeAiOauth.refreshToken).toBe('new-rt');
    expect(saved.claudeAiOauth.expiresAt).toBe(9999);
    // Preserved fields
    expect(saved.claudeAiOauth.scopes).toEqual(['user:inference']);
    expect(saved.claudeAiOauth.subscriptionType).toBe('max');
    expect(saved.otherField).toBe('preserved');
  });

  it('handles corrupted existing file gracefully', () => {
    const filePath = resolve(tmpDir, '.credentials.json');
    writeFileSync(filePath, 'not valid json {{{');

    const creds = validCreds();
    saveOAuthCredentials(creds, filePath);

    const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(saved.claudeAiOauth.accessToken).toBe(creds.accessToken);
  });

  it('preserves the Anthropic CLI format when writing to an Anthropic CLI file', () => {
    const filePath = resolve(tmpDir, 'default.json');
    writeFileSync(filePath, JSON.stringify(VALID_ANTHROPIC_CLI_CREDENTIALS));

    const expiresAt = Date.now() + 7_200_000;
    const creds = validCreds({ accessToken: 'new-at', refreshToken: 'new-rt', expiresAt });
    saveOAuthCredentials(creds, filePath);

    const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
    // Updated fields, snake_case, expires_at back in epoch seconds
    expect(saved.access_token).toBe('new-at');
    expect(saved.refresh_token).toBe('new-rt');
    expect(saved.expires_at).toBe(Math.round(expiresAt / 1000));
    // Preserved fields
    expect(saved.type).toBe('oauth_token');
    expect(saved.version).toBe('1.0');
    expect(saved.scope).toBe(VALID_ANTHROPIC_CLI_CREDENTIALS.scope);
    expect(saved.organization_uuid).toBe(VALID_ANTHROPIC_CLI_CREDENTIALS.organization_uuid);
    // No claudeAiOauth wrapper introduced
    expect(saved.claudeAiOauth).toBeUndefined();
  });

  it('preserves the Anthropic CLI format for a file without a type field', () => {
    const filePath = resolve(tmpDir, 'default.json');
    const noType = { ...VALID_ANTHROPIC_CLI_CREDENTIALS, type: undefined };
    writeFileSync(filePath, JSON.stringify(noType));

    const creds = validCreds({ accessToken: 'new-at' });
    saveOAuthCredentials(creds, filePath);

    const saved = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(saved.access_token).toBe('new-at');
    expect(saved.claudeAiOauth).toBeUndefined();
  });

  it('writes the Anthropic CLI format when the CLI store file vanished before save', () => {
    // The origin file can be deleted or rotated by the Anthropic CLI between
    // detection and refresh write-back; the path must decide the format.
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', resolve(tmpDir, 'anthropic'));
    try {
      const cliPath = resolve(tmpDir, 'anthropic', 'credentials', 'default.json');
      mkdirSync(resolve(tmpDir, 'anthropic', 'credentials'), { recursive: true });

      const expiresAt = Date.now() + 3_600_000;
      const creds = validCreds({ accessToken: 'new-at', refreshToken: 'new-rt', expiresAt });
      saveOAuthCredentials(creds, cliPath);

      const saved = JSON.parse(readFileSync(cliPath, 'utf-8'));
      expect(saved.access_token).toBe('new-at');
      expect(saved.refresh_token).toBe('new-rt');
      expect(saved.expires_at).toBe(Math.round(expiresAt / 1000));
      expect(saved.claudeAiOauth).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('saveCodexOAuthCredentials', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'codex-oauth-save-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updates Codex auth.json tokens while preserving existing token metadata', () => {
    const filePath = resolve(tmpDir, 'auth.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: 'old-id-token',
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          account_id: 'acct_123',
        },
      }),
    );

    saveCodexOAuthCredentials(
      {
        accessToken: unsignedJwt({ exp: 4_102_444_800 }),
        refreshToken: 'new-refresh',
        expiresAt: 4_102_444_800_000,
      },
      filePath,
    );

    const saved = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      auth_mode?: string;
      tokens?: Record<string, unknown>;
    };
    expect(saved.auth_mode).toBe('chatgpt');
    expect(saved.tokens?.access_token).toBe(unsignedJwt({ exp: 4_102_444_800 }));
    expect(saved.tokens?.refresh_token).toBe('new-refresh');
    expect(saved.tokens?.id_token).toBe('old-id-token');
    expect(saved.tokens?.account_id).toBe('acct_123');
  });
});
