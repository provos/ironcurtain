import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import type { IronCurtainConfig } from '../src/config/types.js';
import {
  parseCredentialsJson,
  loadCredentialsFromFile,
  isTokenExpired,
  detectAuthMethod,
  extractFromKeychain,
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

  it('returns oauth when valid credentials are found from file', () => {
    const creds = validCreds();
    const sources = makeSources({ loadFromFile: () => creds });

    const result = detectAuthMethod(makeConfig(), sources);
    expect(result.kind).toBe('oauth');
    if (result.kind === 'oauth') {
      expect(result.credentials.accessToken).toBe('sk-ant-oat01-test-access-token');
    }
  });

  it('falls back to apikey when no OAuth credentials', () => {
    const sources = makeSources({});
    const config = makeConfig({ anthropicApiKey: 'sk-ant-api03-test-key' });

    const result = detectAuthMethod(config, sources);
    expect(result.kind).toBe('apikey');
    if (result.kind === 'apikey') {
      expect(result.key).toBe('sk-ant-api03-test-key');
    }
  });

  it('returns none when no OAuth and no API key', () => {
    const sources = makeSources({});
    const config = makeConfig({ anthropicApiKey: '' });

    const result = detectAuthMethod(config, sources);
    expect(result.kind).toBe('none');
  });

  it('falls back to apikey when OAuth token is expired', () => {
    const sources = makeSources({ loadFromFile: () => expiredCreds() });
    const config = makeConfig({ anthropicApiKey: 'sk-ant-api03-fallback' });

    const result = detectAuthMethod(config, sources);
    expect(result.kind).toBe('apikey');
    if (result.kind === 'apikey') {
      expect(result.key).toBe('sk-ant-api03-fallback');
    }
  });

  it('respects IRONCURTAIN_DOCKER_AUTH=apikey override', () => {
    process.env.IRONCURTAIN_DOCKER_AUTH = 'apikey';

    const creds = validCreds();
    const sources = makeSources({ loadFromFile: () => creds });
    const config = makeConfig({ anthropicApiKey: 'sk-ant-api03-forced' });

    const result = detectAuthMethod(config, sources);
    expect(result.kind).toBe('apikey');
    if (result.kind === 'apikey') {
      expect(result.key).toBe('sk-ant-api03-forced');
    }
  });

  it('tries Keychain when credentials file returns null', () => {
    const keychainCreds = validCreds({ accessToken: 'sk-ant-oat01-keychain-token' });
    const sources = makeSources({
      loadFromFile: () => null,
      loadFromKeychain: () => keychainCreds,
    });

    const result = detectAuthMethod(makeConfig(), sources);
    expect(result.kind).toBe('oauth');
    if (result.kind === 'oauth') {
      expect(result.credentials.accessToken).toBe('sk-ant-oat01-keychain-token');
    }
  });

  it('does not try Keychain when credentials file exists but is expired', () => {
    let keychainCalled = false;
    const sources: CredentialSources = {
      loadFromFile: () => expiredCreds(),
      loadFromKeychain: () => {
        keychainCalled = true;
        return validCreds({ accessToken: 'sk-ant-oat01-keychain-fresh' });
      },
    };
    const config = makeConfig({ anthropicApiKey: 'sk-ant-api03-fallback' });

    const result = detectAuthMethod(config, sources);
    expect(keychainCalled).toBe(false);
    expect(result.kind).toBe('apikey');
  });

  it('falls back to apikey when Keychain credentials are expired', () => {
    const sources = makeSources({
      loadFromFile: () => null,
      loadFromKeychain: () => expiredCreds(),
    });
    const config = makeConfig({ anthropicApiKey: 'sk-ant-api03-keychain-fallback' });

    const result = detectAuthMethod(config, sources);
    expect(result.kind).toBe('apikey');
    if (result.kind === 'apikey') {
      expect(result.key).toBe('sk-ant-api03-keychain-fallback');
    }
  });

  it('returns none when all sources fail and no API key', () => {
    const sources = makeSources({});
    const config = makeConfig({ anthropicApiKey: '' });

    const result = detectAuthMethod(config, sources);
    expect(result.kind).toBe('none');
  });
});

// --- extractFromKeychain ---

describe('extractFromKeychain', () => {
  it('returns null on non-macOS platforms', () => {
    // This test runs on Linux CI, so extractFromKeychain should return null
    // because platform() !== 'darwin'.
    if (platform() !== 'darwin') {
      expect(extractFromKeychain()).toBeNull();
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
    const { claudeCodeAdapter } = await import('../src/docker/adapters/claude-code.js');
    const providers = claudeCodeAdapter.getProviders('oauth');
    expect(providers).toHaveLength(2);
    expect(providers[0].displayName).toBe('Anthropic (OAuth)');
    expect(providers[0].keyInjection).toEqual({ type: 'bearer' });
    expect(providers[1].displayName).toBe('Claude Platform (OAuth)');
    expect(providers[1].keyInjection).toEqual({ type: 'bearer' });
  });

  it('returns API key providers when authKind is apikey', async () => {
    const { claudeCodeAdapter } = await import('../src/docker/adapters/claude-code.js');
    const providers = claudeCodeAdapter.getProviders('apikey');
    expect(providers).toHaveLength(2);
    expect(providers[0].displayName).toBe('Anthropic');
    expect(providers[0].keyInjection).toEqual({ type: 'header', headerName: 'x-api-key' });
  });

  it('returns API key providers when authKind is undefined', async () => {
    const { claudeCodeAdapter } = await import('../src/docker/adapters/claude-code.js');
    const providers = claudeCodeAdapter.getProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0].displayName).toBe('Anthropic');
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN in OAuth mode', async () => {
    const { claudeCodeAdapter } = await import('../src/docker/adapters/claude-code.js');
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
    const { claudeCodeAdapter } = await import('../src/docker/adapters/claude-code.js');
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
    const { claudeCodeAdapter } = await import('../src/docker/adapters/claude-code.js');
    const config = {
      userConfig: { anthropicApiKey: 'sk-test' },
    } as IronCurtainConfig;

    const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-api03-ironcurtain-FAKE']]);
    const env = claudeCodeAdapter.buildEnv(config, fakeKeys);
    expect(env.IRONCURTAIN_API_KEY).toBe('sk-ant-api03-ironcurtain-FAKE');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});
