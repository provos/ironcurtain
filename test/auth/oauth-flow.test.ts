import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateCodeVerifier, computeCodeChallenge, runOAuthFlow, OAuthFlowError } from '../../src/auth/oauth-flow.js';
import type { OAuthProviderConfig, OAuthClientCredentials } from '../../src/auth/oauth-provider.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeProvider(tokenPort: number): OAuthProviderConfig {
  return {
    id: 'google',
    displayName: 'Test Provider',
    authorizationUrl: 'https://example.com/auth',
    tokenUrl: `http://127.0.0.1:${tokenPort}/token`,
    defaultScopes: ['scope1', 'scope2'],
    callbackPath: '/callback',
    usePkce: true,
    serverNames: ['test-server'],
    tokenEnvVar: 'TEST_TOKEN',
    refreshTokenEnvVar: 'TEST_REFRESH',
    clientIdEnvVar: 'TEST_CLIENT_ID',
    clientSecretEnvVar: 'TEST_CLIENT_SECRET',
    credentialsFilename: 'test-credentials.json',
  };
}

const testCredentials: OAuthClientCredentials = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
};

/**
 * Captures the authorization URL that would be opened in the browser.
 * Returns both the openUrl callback and a promise that resolves to the captured URL.
 */
function captureAuthUrl(): { openUrl: (url: string) => void; urlPromise: Promise<string> } {
  let resolve: (url: string) => void;
  const urlPromise = new Promise<string>((r) => {
    resolve = r;
  });
  return {
    openUrl: (url: string) => resolve(url),
    urlPromise,
  };
}

/**
 * Starts a mock OAuth token endpoint that validates the exchange request
 * and returns fake tokens.
 */
function startMockTokenServer(responseOverride?: { status: number; body: string }): {
  server: ReturnType<typeof createServer>;
  port: () => number;
  close: () => void;
  lastRequest: () => Record<string, string> | undefined;
} {
  let lastBody: Record<string, string> | undefined;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.url === '/token' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks).toString();
        lastBody = Object.fromEntries(new URLSearchParams(body));

        if (responseOverride) {
          res.writeHead(responseOverride.status, { 'Content-Type': 'application/json' });
          res.end(responseOverride.body);
          return;
        }

        if (lastBody.grant_type !== 'authorization_code' || !lastBody.code || !lastBody.code_verifier) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_request' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'mock-access-token',
            refresh_token: 'mock-refresh-token',
            expires_in: 3600,
            scope: 'scope1 scope2',
            token_type: 'Bearer',
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    })();
  });

  server.listen(0, '127.0.0.1');

  return {
    server,
    port: () => {
      const addr = server.address();
      return typeof addr === 'object' && addr !== null ? addr.port : 0;
    },
    close: () => server.close(),
    lastRequest: () => lastBody,
  };
}

async function waitForServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (server.listening) return;
  return new Promise((resolve) => server.once('listening', resolve));
}

/**
 * Simulates the browser callback by extracting the redirect_uri and state
 * from the authorization URL, then making a fetch to the callback server.
 */
async function simulateCallback(authUrl: string, params: Record<string, string>): Promise<Response> {
  const parsed = new URL(authUrl);
  const redirectUri = parsed.searchParams.get('redirect_uri')!;
  const callbackUrl = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    callbackUrl.searchParams.set(key, value);
  }
  return fetch(callbackUrl.toString());
}

// ---------------------------------------------------------------------------
// PKCE tests
// ---------------------------------------------------------------------------

describe('generateCodeVerifier', () => {
  it('produces a base64url string of at least 43 characters', () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces unique values on each call', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });
});

describe('computeCodeChallenge', () => {
  it('produces the correct S256 hash for a known test vector', () => {
    // RFC 7636 Appendix B test vector
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = computeCodeChallenge(verifier);

    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('produces base64url output without padding', () => {
    const challenge = computeCodeChallenge('test-verifier');
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain('=');
  });
});

// ---------------------------------------------------------------------------
// Full flow integration tests
// ---------------------------------------------------------------------------

describe('runOAuthFlow', () => {
  let mockTokenServer: ReturnType<typeof startMockTokenServer>;

  beforeEach(async () => {
    mockTokenServer = startMockTokenServer();
    await waitForServer(mockTokenServer.server);
  });

  afterEach(() => {
    mockTokenServer.close();
  });

  it('completes the full flow and returns tokens', async () => {
    const provider = makeProvider(mockTokenServer.port());
    const { openUrl, urlPromise } = captureAuthUrl();

    const flowPromise = runOAuthFlow(provider, testCredentials, undefined, 10_000, { openUrl });

    const authUrl = await urlPromise;
    const parsed = new URL(authUrl);

    // Verify authorization URL parameters
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('scope')).toBe('scope1 scope2');

    const state = parsed.searchParams.get('state')!;
    expect(state).toBeTruthy();

    // Simulate the browser callback
    const callbackResponse = await simulateCallback(authUrl, { code: 'test-auth-code', state });
    expect(callbackResponse.ok).toBe(true);

    const result = await flowPromise;

    expect(result.token.accessToken).toBe('mock-access-token');
    expect(result.token.refreshToken).toBe('mock-refresh-token');
    expect(result.token.expiresAt).toBeGreaterThan(Date.now());
    expect(result.grantedScopes).toEqual(['scope1', 'scope2']);

    // Verify the token exchange request
    const lastReq = mockTokenServer.lastRequest();
    expect(lastReq).toBeDefined();
    expect(lastReq!.code).toBe('test-auth-code');
    expect(lastReq!.code_verifier).toBeTruthy();
    expect(lastReq!.client_id).toBe('test-client-id');
    expect(lastReq!.client_secret).toBe('test-client-secret');
    expect(lastReq!.grant_type).toBe('authorization_code');
  });

  it('throws OAuthFlowError on timeout', async () => {
    const provider = makeProvider(mockTokenServer.port());

    // Never simulate the callback -- should time out
    await expect(runOAuthFlow(provider, testCredentials, undefined, 100, { openUrl: () => {} })).rejects.toThrow(
      OAuthFlowError,
    );

    await expect(runOAuthFlow(provider, testCredentials, undefined, 100, { openUrl: () => {} })).rejects.toThrow(
      /timed out/,
    );
  });

  it('throws OAuthFlowError when provider returns error in callback', async () => {
    const provider = makeProvider(mockTokenServer.port());
    const { openUrl, urlPromise } = captureAuthUrl();

    const flowPromise = runOAuthFlow(provider, testCredentials, undefined, 10_000, { openUrl });
    // Attach catch immediately to prevent unhandled rejection
    flowPromise.catch(() => {});

    const authUrl = await urlPromise;

    // Simulate error callback (user denied access)
    await simulateCallback(authUrl, {
      error: 'access_denied',
      error_description: 'User denied access',
    });

    await expect(flowPromise).rejects.toThrow(OAuthFlowError);
    await expect(flowPromise).rejects.toThrow(/User denied access/);
  });

  it('throws OAuthFlowError on state mismatch', async () => {
    const provider = makeProvider(mockTokenServer.port());
    const { openUrl, urlPromise } = captureAuthUrl();

    const flowPromise = runOAuthFlow(provider, testCredentials, undefined, 10_000, { openUrl });
    // Attach catch immediately to prevent unhandled rejection
    flowPromise.catch(() => {});

    const authUrl = await urlPromise;

    // Send callback with wrong state
    await simulateCallback(authUrl, { code: 'test-code', state: 'wrong-state' });

    await expect(flowPromise).rejects.toThrow(OAuthFlowError);
    await expect(flowPromise).rejects.toThrow(/State parameter mismatch/);
  });

  it('uses custom scopes when provided', async () => {
    const provider = makeProvider(mockTokenServer.port());
    const customScopes = ['custom-scope-1', 'custom-scope-2'];
    const { openUrl, urlPromise } = captureAuthUrl();

    const flowPromise = runOAuthFlow(provider, testCredentials, customScopes, 10_000, { openUrl });

    const authUrl = await urlPromise;
    const parsed = new URL(authUrl);
    expect(parsed.searchParams.get('scope')).toBe('custom-scope-1 custom-scope-2');

    // Complete the flow
    const state = parsed.searchParams.get('state')!;
    await simulateCallback(authUrl, { code: 'test-code', state });

    const result = await flowPromise;
    expect(result.token.accessToken).toBe('mock-access-token');
  });

  it('throws OAuthFlowError when token exchange fails', async () => {
    // Create a token server that returns errors
    const badTokenServer = startMockTokenServer({ status: 401, body: '{"error":"invalid_client"}' });
    await waitForServer(badTokenServer.server);

    const provider = makeProvider(badTokenServer.port());
    const { openUrl, urlPromise } = captureAuthUrl();

    const flowPromise = runOAuthFlow(provider, testCredentials, undefined, 10_000, { openUrl });
    flowPromise.catch(() => {});

    const authUrl = await urlPromise;
    const parsed = new URL(authUrl);
    const state = parsed.searchParams.get('state')!;

    await simulateCallback(authUrl, { code: 'test-code', state });

    await expect(flowPromise).rejects.toThrow(OAuthFlowError);
    await expect(flowPromise).rejects.toThrow(/Token exchange failed/);

    badTokenServer.close();
  });
});
