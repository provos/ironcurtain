import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadClientCredentials } from '../../src/auth/oauth-provider.js';
import type { OAuthProviderConfig } from '../../src/auth/oauth-provider.js';

// Stub provider config for tests
function makeProvider(credentialsFilename: string): OAuthProviderConfig {
  return {
    id: 'google',
    displayName: 'Test',
    authorizationUrl: 'https://example.com/auth',
    tokenUrl: 'https://example.com/token',
    defaultScopes: [],
    callbackPath: '/callback',
    usePkce: true,
    serverNames: ['test-server'],
    tokenEnvVar: 'TEST_TOKEN',
    refreshTokenEnvVar: 'TEST_REFRESH',
    clientIdEnvVar: 'TEST_CLIENT_ID',
    clientSecretEnvVar: 'TEST_CLIENT_SECRET',
    credentialsFilename,
  };
}

describe('loadClientCredentials', () => {
  let testDir: string;
  const originalEnv = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    testDir = resolve(tmpdir(), `ironcurtain-oauth-test-${process.pid}-${Date.now()}`);
    mkdirSync(resolve(testDir, 'oauth'), { recursive: true });
    process.env.IRONCURTAIN_HOME = testDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = originalEnv;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns null when credentials file does not exist', () => {
    const result = loadClientCredentials(makeProvider('nonexistent.json'));
    expect(result).toBeNull();
  });

  it('loads Google "installed" format credentials', () => {
    const provider = makeProvider('google-creds.json');
    writeFileSync(
      resolve(testDir, 'oauth', 'google-creds.json'),
      JSON.stringify({
        installed: {
          client_id: 'test-client-id.apps.googleusercontent.com',
          client_secret: 'test-secret-123',
        },
      }),
    );

    const result = loadClientCredentials(provider);
    expect(result).toEqual({
      clientId: 'test-client-id.apps.googleusercontent.com',
      clientSecret: 'test-secret-123',
    });
  });

  it('loads flat format credentials', () => {
    const provider = makeProvider('flat-creds.json');
    writeFileSync(
      resolve(testDir, 'oauth', 'flat-creds.json'),
      JSON.stringify({
        client_id: 'flat-client-id',
        client_secret: 'flat-secret',
      }),
    );

    const result = loadClientCredentials(provider);
    expect(result).toEqual({
      clientId: 'flat-client-id',
      clientSecret: 'flat-secret',
    });
  });

  it('throws on invalid JSON', () => {
    const provider = makeProvider('bad.json');
    writeFileSync(resolve(testDir, 'oauth', 'bad.json'), 'not json{{{');

    expect(() => loadClientCredentials(provider)).toThrow(/Invalid JSON/);
  });

  it('throws when file is not a JSON object', () => {
    const provider = makeProvider('array.json');
    writeFileSync(resolve(testDir, 'oauth', 'array.json'), '["not", "an", "object"]');

    expect(() => loadClientCredentials(provider)).toThrow(/expected a JSON object/);
  });

  it('throws when client_id is missing', () => {
    const provider = makeProvider('no-id.json');
    writeFileSync(resolve(testDir, 'oauth', 'no-id.json'), JSON.stringify({ client_secret: 'secret' }));

    expect(() => loadClientCredentials(provider)).toThrow(/Missing or empty client_id/);
  });

  it('throws when client_secret is missing', () => {
    const provider = makeProvider('no-secret.json');
    writeFileSync(resolve(testDir, 'oauth', 'no-secret.json'), JSON.stringify({ client_id: 'some-id' }));

    expect(() => loadClientCredentials(provider)).toThrow(/Missing or empty client_secret/);
  });

  it('throws when client_id is empty string', () => {
    const provider = makeProvider('empty-id.json');
    writeFileSync(
      resolve(testDir, 'oauth', 'empty-id.json'),
      JSON.stringify({ client_id: '', client_secret: 'secret' }),
    );

    expect(() => loadClientCredentials(provider)).toThrow(/Missing or empty client_id/);
  });

  it('throws when client_secret is empty string', () => {
    const provider = makeProvider('empty-secret.json');
    writeFileSync(
      resolve(testDir, 'oauth', 'empty-secret.json'),
      JSON.stringify({ client_id: 'some-id', client_secret: '' }),
    );

    expect(() => loadClientCredentials(provider)).toThrow(/Missing or empty client_secret/);
  });

  it('throws when installed wrapper has missing fields', () => {
    const provider = makeProvider('installed-bad.json');
    writeFileSync(
      resolve(testDir, 'oauth', 'installed-bad.json'),
      JSON.stringify({ installed: { client_id: 'id-only' } }),
    );

    expect(() => loadClientCredentials(provider)).toThrow(/Missing or empty client_secret/);
  });
});
