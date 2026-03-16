/**
 * OAuth 2.0 authorization code flow with PKCE.
 *
 * Runs the complete browser-based flow: generates PKCE challenge,
 * starts an ephemeral callback server, opens the browser, waits for
 * the authorization code, and exchanges it for tokens.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { URL } from 'node:url';
import type { OAuthProviderConfig, OAuthClientCredentials, StoredOAuthToken } from './oauth-provider.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthFlowResult {
  readonly token: StoredOAuthToken;
  /** The scopes actually granted by the provider (may differ from requested). */
  readonly grantedScopes: readonly string[];
}

export class OAuthFlowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OAuthFlowError';
  }
}

export interface OAuthFlowOptions {
  /** Override how the authorization URL is opened (default: system browser). */
  readonly openUrl?: (url: string) => void;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

const CODE_VERIFIER_LENGTH = 64;

/** Generates a cryptographically random code verifier (43-128 chars, base64url). */
export function generateCodeVerifier(): string {
  return randomBytes(CODE_VERIFIER_LENGTH).toString('base64url');
}

/** Computes the S256 code challenge from a code verifier. */
export function computeCodeChallenge(verifier: string): string {
  const hash = createHash('sha256').update(verifier).digest();
  return hash.toString('base64url');
}

// ---------------------------------------------------------------------------
// State parameter (CSRF nonce)
// ---------------------------------------------------------------------------

function generateState(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// Browser open
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(cmd, [url], (err) => {
    // Best-effort: if browser fails to open, user can copy the URL from terminal
    if (err) {
      console.error(`Could not open browser automatically. Please visit:\n${url}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Callback server
// ---------------------------------------------------------------------------

type CallbackOutcome = { readonly ok: true; readonly code: string } | { readonly ok: false; readonly error: string };

function startCallbackServer(
  callbackPath: string,
  expectedState: string,
): { server: Server; result: Promise<CallbackOutcome>; getPort: () => number } {
  let resolveResult: (value: CallbackOutcome) => void;
  const result = new Promise<CallbackOutcome>((resolve) => {
    resolveResult = resolve;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1`);

    if (requestUrl.pathname !== callbackPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const error = requestUrl.searchParams.get('error');
    if (error) {
      const description = requestUrl.searchParams.get('error_description') ?? error;
      respondWithHtml(res, 'Authorization Failed', `Authorization failed: ${description}`);
      resolveResult({ ok: false, error: `Authorization failed: ${description}` });
      return;
    }

    const state = requestUrl.searchParams.get('state');
    if (state !== expectedState) {
      respondWithHtml(res, 'Invalid State', 'State parameter mismatch. Possible CSRF attack.');
      resolveResult({ ok: false, error: 'State parameter mismatch' });
      return;
    }

    const code = requestUrl.searchParams.get('code');
    if (!code) {
      respondWithHtml(res, 'Missing Code', 'No authorization code received.');
      resolveResult({ ok: false, error: 'No authorization code in callback' });
      return;
    }

    respondWithHtml(res, 'Authorization Successful', 'Authorization successful! You can close this tab.');
    resolveResult({ ok: true, code });
  });

  server.listen(0, '127.0.0.1');

  const getPort = (): number => {
    const address = server.address();
    if (typeof address === 'object' && address !== null) {
      return address.port;
    }
    throw new OAuthFlowError('Failed to get callback server port');
  };

  return { server, result, getPort };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function respondWithHtml(res: ServerResponse, title: string, message: string): void {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const html = `<!DOCTYPE html>
<html><head><title>${safeTitle}</title></head>
<body><h1>${safeTitle}</h1><p>${safeMessage}</p></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

async function exchangeCodeForTokens(
  provider: OAuthProviderConfig,
  clientCredentials: OAuthClientCredentials,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{ token: StoredOAuthToken; grantedScopes: readonly string[] }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientCredentials.clientId,
    client_secret: clientCredentials.clientSecret,
    code_verifier: codeVerifier,
  });

  const response = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new OAuthFlowError(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as TokenResponse;

  if (!data.access_token) {
    throw new OAuthFlowError('Token response missing access_token');
  }

  if (!data.refresh_token) {
    throw new OAuthFlowError(
      'Token response missing refresh_token. ' +
        'This usually means the provider did not issue a refresh token. ' +
        'For Google, ensure prompt=consent and access_type=offline are set.',
    );
  }

  if (!data.expires_in || data.expires_in <= 0) {
    throw new OAuthFlowError('Token response missing or invalid expires_in');
  }

  const expiresAt = Date.now() + data.expires_in * 1000;
  const grantedScopes = data.scope ? data.scope.split(' ') : [];

  const token: StoredOAuthToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    scopes: grantedScopes,
  };

  return { token, grantedScopes };
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

function buildAuthorizationUrl(
  provider: OAuthProviderConfig,
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  scopes: readonly string[],
): string {
  const url = new URL(provider.authorizationUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', scopes.join(' '));

  if (provider.usePkce) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }

  // Request offline access for refresh tokens
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');

  return url.toString();
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Runs the OAuth 2.0 authorization code flow with PKCE.
 *
 * 1. Generates PKCE code verifier and challenge
 * 2. Starts an ephemeral HTTP server on 127.0.0.1:0 (OS-assigned port)
 * 3. Opens the authorization URL in the user's default browser
 * 4. Waits for the callback with the authorization code
 * 5. Exchanges the code for tokens using client_id + client_secret
 * 6. Stops the callback server
 */
export async function runOAuthFlow(
  provider: OAuthProviderConfig,
  clientCredentials: OAuthClientCredentials,
  scopes?: readonly string[],
  timeoutMs?: number,
  options?: OAuthFlowOptions,
): Promise<OAuthFlowResult> {
  const effectiveScopes = scopes ?? provider.defaultScopes;
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Step 1: PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);

  // Step 2: State nonce
  const state = generateState();

  // Step 3: Start callback server
  const { server, result, getPort } = startCallbackServer(provider.callbackPath, state);

  try {
    // Wait for the server to be listening before reading the port
    await new Promise<void>((resolve) => {
      if (server.listening) {
        resolve();
      } else {
        server.once('listening', resolve);
      }
    });

    const port = getPort();
    const redirectUri = `http://127.0.0.1:${port}${provider.callbackPath}`;

    // Step 4: Build authorization URL and open browser
    const authUrl = buildAuthorizationUrl(
      provider,
      clientCredentials.clientId,
      redirectUri,
      state,
      codeChallenge,
      effectiveScopes,
    );
    const opener = options?.openUrl ?? openBrowser;
    opener(authUrl);

    // Step 5: Wait for callback (with timeout)
    const outcome = await withTimeout(result, timeout);

    if (!outcome.ok) {
      throw new OAuthFlowError(outcome.error);
    }

    // Step 6: Exchange code for tokens
    return await exchangeCodeForTokens(provider, clientCredentials, outcome.code, redirectUri, codeVerifier);
  } finally {
    // Step 7: Stop server
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new OAuthFlowError(`OAuth flow timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
