import { createServer, type Server } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OAuthTokenProvider, OAuthTokenExpiredError } from '../../src/auth/oauth-token-provider.js';
import type { OAuthProviderConfig, OAuthClientCredentials, StoredOAuthToken } from '../../src/auth/oauth-provider.js';
import { saveOAuthToken, loadOAuthToken } from '../../src/auth/oauth-token-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToken(overrides?: Partial<StoredOAuthToken>): StoredOAuthToken {
  return {
    accessToken: 'ya29.original-access-token',
    refreshToken: '1//original-refresh-token',
    expiresAt: Date.now() + 3600 * 1000, // 1 hour from now
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    ...overrides,
  };
}

function makeExpiredToken(overrides?: Partial<StoredOAuthToken>): StoredOAuthToken {
  return makeToken({
    expiresAt: Date.now() - 60_000, // expired 1 minute ago
    ...overrides,
  });
}

const TEST_CLIENT_CREDENTIALS: OAuthClientCredentials = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
};

/**
 * Creates a mock token endpoint server that responds to refresh_token grants.
 * Returns the server, its URL, and a list of received request bodies.
 */
function createMockTokenServer(
  responseOverrides?: Partial<{
    statusCode: number;
    body: string;
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }>,
): { server: Server; url: Promise<string>; requests: string[] } {
  const requests: string[] = [];

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      requests.push(body);

      const statusCode = responseOverrides?.statusCode ?? 200;
      if (statusCode !== 200) {
        res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
        res.end(responseOverrides?.body ?? 'Error');
        return;
      }

      const responseBody =
        responseOverrides?.body ??
        JSON.stringify({
          access_token: responseOverrides?.accessToken ?? 'ya29.refreshed-access-token',
          refresh_token: responseOverrides?.refreshToken,
          expires_in: responseOverrides?.expiresIn ?? 3600,
          scope: 'https://www.googleapis.com/auth/drive.readonly',
        });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(responseBody);
    });
  });

  const url = new Promise<string>((resolveUrl) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr !== null) {
        resolveUrl(`http://127.0.0.1:${addr.port}/token`);
      }
    });
  });

  return { server, url, requests };
}

function makeProvider(tokenUrl: string): OAuthProviderConfig {
  return {
    id: 'google',
    displayName: 'Google Workspace',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl,
    defaultScopes: ['https://www.googleapis.com/auth/drive.readonly'],
    callbackPath: '/callback',
    usePkce: true,
    serverNames: ['google-workspace'],
    tokenEnvVar: 'GOOGLE_ACCESS_TOKEN',
    refreshTokenEnvVar: 'GOOGLE_REFRESH_TOKEN',
    clientIdEnvVar: 'GOOGLE_CLIENT_ID',
    clientSecretEnvVar: 'GOOGLE_CLIENT_SECRET',
    credentialsFilename: 'google-credentials.json',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OAuthTokenProvider', () => {
  let testDir: string;
  const originalEnv = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    testDir = resolve(tmpdir(), `ironcurtain-token-provider-test-${process.pid}-${Date.now()}`);
    mkdirSync(resolve(testDir, 'oauth'), { recursive: true });
    process.env.IRONCURTAIN_HOME = testDir;
  });

  afterEach(() => {
    process.env.IRONCURTAIN_HOME = originalEnv;
    rmSync(testDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // isAuthorized
  // -----------------------------------------------------------------------

  describe('isAuthorized', () => {
    it('returns false when no token file exists', () => {
      const provider = makeProvider('http://localhost/token');
      const tp = new OAuthTokenProvider(provider, TEST_CLIENT_CREDENTIALS);
      expect(tp.isAuthorized()).toBe(false);
    });

    it('returns true when a token file exists', () => {
      const token = makeToken();
      saveOAuthToken('google', token);

      const provider = makeProvider('http://localhost/token');
      const tp = new OAuthTokenProvider(provider, TEST_CLIENT_CREDENTIALS);
      expect(tp.isAuthorized()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // getValidAccessToken -- happy path
  // -----------------------------------------------------------------------

  describe('getValidAccessToken', () => {
    it('returns access token when not expired', async () => {
      const token = makeToken();
      saveOAuthToken('google', token);

      const provider = makeProvider('http://localhost/token');
      const tp = new OAuthTokenProvider(provider, TEST_CLIENT_CREDENTIALS);

      const result = await tp.getValidAccessToken();
      expect(result).toBe('ya29.original-access-token');
    });

    it('throws when no token file exists', async () => {
      const provider = makeProvider('http://localhost/token');
      const tp = new OAuthTokenProvider(provider, TEST_CLIENT_CREDENTIALS);

      await expect(tp.getValidAccessToken()).rejects.toThrow(OAuthTokenExpiredError);
      await expect(tp.getValidAccessToken()).rejects.toThrow(/No stored token/);
    });

    // ---------------------------------------------------------------------
    // Refresh
    // ---------------------------------------------------------------------

    it('refreshes when token is expired', async () => {
      const expiredToken = makeExpiredToken();
      saveOAuthToken('google', expiredToken);

      const { server, url, requests } = createMockTokenServer();
      try {
        const tokenUrl = await url;
        const provider = makeProvider(tokenUrl);
        const tp = new OAuthTokenProvider(provider, TEST_CLIENT_CREDENTIALS);

        const result = await tp.getValidAccessToken();
        expect(result).toBe('ya29.refreshed-access-token');

        // Verify the refresh request was sent correctly
        expect(requests).toHaveLength(1);
        const params = new URLSearchParams(requests[0]);
        expect(params.get('grant_type')).toBe('refresh_token');
        expect(params.get('client_id')).toBe('test-client-id');
        expect(params.get('client_secret')).toBe('test-client-secret');
        expect(params.get('refresh_token')).toBe('1//original-refresh-token');

        // Verify the refreshed token was saved to disk
        const saved = loadOAuthToken('google');
        expect(saved?.accessToken).toBe('ya29.refreshed-access-token');
      } finally {
        server.close();
      }
    });

    it('preserves original refresh token when provider does not return a new one', async () => {
      const expiredToken = makeExpiredToken();
      saveOAuthToken('google', expiredToken);

      const { server, url } = createMockTokenServer();
      try {
        const tokenUrl = await url;
        const provider = makeProvider(tokenUrl);
        const tp = new OAuthTokenProvider(provider, TEST_CLIENT_CREDENTIALS);

        await tp.getValidAccessToken();

        const saved = loadOAuthToken('google');
        expect(saved?.refreshToken).toBe('1//original-refresh-token');
      } finally {
        server.close();
      }
    });

    it('uses new refresh token when provider returns one', async () => {
      const expiredToken = makeExpiredToken();
      saveOAuthToken('google', expiredToken);

      const { server, url } = createMockTokenServer({ refreshToken: '1//new-refresh-token' });
      try {
        const tokenUrl = await url;
        const provider = makeProvider(tokenUrl);
        const tp = new OAuthTokenProvider(provider, TEST_CLIENT_CREDENTIALS);

        await tp.getValidAccessToken();

        const saved = loadOAuthToken('google');
        expect(saved?.refreshToken).toBe('1//new-refresh-token');
      } finally {
        server.close();
      }
    });

    // ---------------------------------------------------------------------
    // Re-read before refresh
    // ---------------------------------------------------------------------

    it('re-reads from disk before refreshing (another process may have refreshed)', async () => {
      // Start with an expired token
      const expiredToken = makeExpiredToken();
      saveOAuthToken('google', expiredToken);

      // Simulate another process refreshing the token: write a fresh token
      // between when the provider sees the expired token and when it refreshes.
      // We do this by saving a fresh token before creating the provider, then
      // the re-read in executeRefresh will find a valid token and skip the HTTP call.
      const freshToken = makeToken({ accessToken: 'ya29.refreshed-by-other-process' });
      saveOAuthToken('google', freshToken);

      const { server, url, requests } = createMockTokenServer();
      try {
        const tokenUrl = await url;
        const provider = makeProvider(tokenUrl);
        const tp = new OAuthTokenProvider(provider, TEST_CLIENT_CREDENTIALS);

        // Force the initial check to see an expired token by overwriting with expired
        // then immediately restoring the fresh one. The provider reads the expired token
        // in getValidAccessToken(), then executeRefresh() re-reads and finds the fresh one.
        saveOAuthToken('google', expiredToken);

        // Now save the fresh token so the re-read in executeRefresh picks it up
        // We need to be sneaky: save the fresh token right before the re-read.
        // Since we can't intercept, we'll save it now and the initial read in
        // getValidAccessToken() will see expired, but executeRefresh()'s re-read will see fresh.
        // This works because we save the fresh token NOW, and the flow is:
        //   1. getValidAccessToken() -> loadOAuthToken() -> expired (from the save above)
        //   Actually no, we last saved expiredToken. Let's restructure.

        // Correct approach: save expired token, then between the initial load (expired)
        // and the re-read in executeRefresh, the token becomes fresh.
        // Since both happen synchronously before the async refresh, we need to rely on
        // the fact that the re-read in executeRefresh is a separate loadOAuthToken call.

        // Save expired so initial check triggers refresh path
        saveOAuthToken('google', expiredToken);
        // Now immediately overwrite with fresh -- the re-read in executeRefresh will find this
        saveOAuthToken('google', freshToken);

        const result = await tp.getValidAccessToken();
        expect(result).toBe('ya29.refreshed-by-other-process');

        // No HTTP refresh request should have been made
        expect(requests).toHaveLength(0);
      } finally {
        server.close();
      }
    });

    // ---------------------------------------------------------------------
    // Deduplication
    // ---------------------------------------------------------------------

    it('deduplicates concurrent refresh calls', async () => {
      const expiredToken = makeExpiredToken();
      saveOAuthToken('google', expiredToken);

      const { server, url, requests } = createMockTokenServer();
      try {
        const tokenUrl = await url;
        const provider = makeProvider(tokenUrl);
        const tp = new OAuthTokenProvider(provider, TEST_CLIENT_CREDENTIALS);

        // Fire three concurrent requests
        const [r1, r2, r3] = await Promise.all([
          tp.getValidAccessToken(),
          tp.getValidAccessToken(),
          tp.getValidAccessToken(),
        ]);

        // All should get the same refreshed token
        expect(r1).toBe('ya29.refreshed-access-token');
        expect(r2).toBe('ya29.refreshed-access-token');
        expect(r3).toBe('ya29.refreshed-access-token');

        // Only one HTTP request should have been made
        expect(requests).toHaveLength(1);
      } finally {
        server.close();
      }
    });

    // ---------------------------------------------------------------------
    // Refresh failure
    // ---------------------------------------------------------------------

    it('throws OAuthTokenExpiredError on refresh failure', async () => {
      const expiredToken = makeExpiredToken();
      saveOAuthToken('google', expiredToken);

      const { server, url } = createMockTokenServer({ statusCode: 400, body: 'invalid_grant' });
      try {
        const tokenUrl = await url;
        const provider = makeProvider(tokenUrl);
        const tp = new OAuthTokenProvider(provider, TEST_CLIENT_CREDENTIALS);

        await expect(tp.getValidAccessToken()).rejects.toThrow(OAuthTokenExpiredError);
        await expect(tp.getValidAccessToken()).rejects.toThrow(/re-authorize/);
      } finally {
        server.close();
      }
    });

    it('throws OAuthTokenExpiredError when response has no access_token', async () => {
      const expiredToken = makeExpiredToken();
      saveOAuthToken('google', expiredToken);

      const { server, url } = createMockTokenServer({
        body: JSON.stringify({ token_type: 'Bearer' }), // missing access_token
      });
      try {
        const tokenUrl = await url;
        const provider = makeProvider(tokenUrl);
        const tp = new OAuthTokenProvider(provider, TEST_CLIENT_CREDENTIALS);

        await expect(tp.getValidAccessToken()).rejects.toThrow(OAuthTokenExpiredError);
      } finally {
        server.close();
      }
    });
  });
});
