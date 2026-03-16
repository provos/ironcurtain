/**
 * CLI entry point for `ironcurtain auth` subcommands.
 *
 * Manages third-party OAuth providers: credential import, authorization,
 * status checking, and token revocation.
 *
 * Subcommands:
 *   ironcurtain auth                           - show status of all providers
 *   ironcurtain auth import <provider> <file>  - import OAuth client credentials
 *   ironcurtain auth <provider>                - authorize a provider (opens browser)
 *   ironcurtain auth <provider> --scopes x,y   - authorize with additional scopes
 *   ironcurtain auth status                    - same as no args
 *   ironcurtain auth revoke <provider>         - revoke and delete stored token
 */

import { copyFileSync, existsSync, unlinkSync, chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { printHelp, type CommandSpec } from '../cli-help.js';
import { getOAuthDir, getOAuthTokenPath } from '../config/paths.js';
import type { OAuthProviderConfig } from './oauth-provider.js';
import { loadClientCredentials } from './oauth-provider.js';
import { getAllOAuthProviders, printAvailableProviders, resolveProviderOrExit } from './oauth-registry.js';
import { runOAuthFlow } from './oauth-flow.js';
import { loadOAuthToken, saveOAuthToken } from './oauth-token-store.js';

// ---------------------------------------------------------------------------
// Help specs
// ---------------------------------------------------------------------------

const authSpec: CommandSpec = {
  name: 'ironcurtain auth',
  description: 'Manage third-party OAuth providers for MCP servers',
  usage: [
    'ironcurtain auth                              # Show provider status',
    'ironcurtain auth import <provider> <file>      # Import client credentials',
    'ironcurtain auth <provider>                    # Authorize (opens browser)',
    'ironcurtain auth <provider> --scopes <scopes>  # Authorize with extra scopes',
    'ironcurtain auth revoke <provider>             # Revoke stored token',
    'ironcurtain auth status                        # Show provider status',
  ],
  subcommands: [
    { name: 'import <provider> <file>', description: 'Import OAuth client credentials from provider' },
    { name: '<provider>', description: 'Authorize a provider (opens browser for OAuth flow)' },
    { name: 'revoke <provider>', description: 'Revoke and delete stored OAuth token' },
    { name: 'status', description: 'Show authorization status for all providers' },
  ],
  options: [
    { flag: 'scopes', description: 'Comma-separated scopes for incremental consent', placeholder: '<scopes>' },
    { flag: 'help', short: 'h', description: 'Show this help message' },
  ],
  examples: [
    'ironcurtain auth import google ~/Downloads/credentials.json',
    'ironcurtain auth google',
    'ironcurtain auth google --scopes gmail.send,calendar.events',
    'ironcurtain auth revoke google',
    'ironcurtain auth status',
  ],
};

// ---------------------------------------------------------------------------
// Google Cloud setup guide (shown when credentials are missing)
// ---------------------------------------------------------------------------

const GOOGLE_SETUP_GUIDE = `
  Google Cloud Project Setup
  ==========================

  IronCurtain requires you to create your own Google Cloud OAuth credentials.
  This is a one-time setup.

  Step 1: Create a Google Cloud Project
    Go to https://console.cloud.google.com/projectcreate
    Enter a project name (e.g., "IronCurtain") and click Create.

  Step 2: Enable Google Workspace APIs
    Navigate to APIs & Services > Library and enable:
      - Gmail API
      - Google Calendar API
      - Google Drive API

  Step 3: Configure the OAuth Consent Screen
    Navigate to APIs & Services > OAuth consent screen
    Set User type to "External" (or "Internal" for Google Workspace orgs)
    Fill in App name, support email, and developer contact email.
    Add scopes: gmail.readonly, calendar.readonly, drive.readonly
    Under Test users, add your Google account email.

    Note: In "Testing" mode, refresh tokens expire after 7 days.
    You will need to re-authorize weekly.

  Step 4: Create OAuth Client Credentials
    Navigate to APIs & Services > Credentials
    Click "Create Credentials" > "OAuth client ID"
    Select Application type: "Desktop app"
    Enter a name (e.g., "IronCurtain CLI")
    Click Create, then "Download JSON"

  Step 5: Import into IronCurtain
    ironcurtain auth import google /path/to/downloaded-credentials.json

  For more details, see: docs/designs/third-party-oauth.md
`;

function truncate(value: string, maxLen: number): string {
  return value.length > maxLen ? value.slice(0, maxLen) + '...' : value;
}

// ---------------------------------------------------------------------------
// Import credentials
// ---------------------------------------------------------------------------

/**
 * Handles `ironcurtain auth import <provider> <credentials-file>`.
 * Shows provider-specific setup guidance when credentials file is not provided.
 */
function importCredentials(args: string[]): void {
  const providerId = args[0];
  const credentialsPath = args[1];

  if (!providerId) {
    process.stdout.write('Usage: ironcurtain auth import <provider> <credentials-file>\n\n');
    printAvailableProviders();
    process.exit(1);
  }

  const provider = resolveProviderOrExit(providerId);

  if (!credentialsPath) {
    process.stdout.write(`Usage: ironcurtain auth import ${providerId} <credentials-file>\n`);
    process.stdout.write('\nProvide the path to the credentials JSON file downloaded from your provider.\n');
    if (provider.id === 'google') {
      process.stdout.write(GOOGLE_SETUP_GUIDE);
    }
    process.exit(1);
    return;
  }

  const resolvedPath = resolve(credentialsPath);
  if (!existsSync(resolvedPath)) {
    process.stdout.write(`File not found: ${resolvedPath}\n`);
    process.exit(1);
  }

  // Ensure the oauth directory exists and copy the file
  const oauthDir = getOAuthDir();
  mkdirSync(oauthDir, { recursive: true });

  const destPath = resolve(oauthDir, provider.credentialsFilename);
  copyFileSync(resolvedPath, destPath);
  chmodSync(destPath, 0o600);

  // Validate by loading the copied credentials
  const credentials = loadClientCredentials(provider);
  if (!credentials) {
    process.stdout.write(`Invalid credentials file: could not extract client_id and client_secret.\n`);
    process.exit(1);
  }

  process.stdout.write(`\n  ${provider.displayName} -- Import OAuth Credentials\n\n`);
  process.stdout.write(`  Found client_id: ${truncate(credentials.clientId, 20)}\n`);
  process.stdout.write(`  Credentials saved to ${destPath}\n\n`);
  process.stdout.write(`  Next step: run 'ironcurtain auth ${provider.id}' to authorize.\n\n`);
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

function showStatus(): void {
  const providers = getAllOAuthProviders();

  if (providers.length === 0) {
    process.stdout.write('No OAuth providers registered.\n');
    return;
  }

  process.stdout.write('\nOAuth Provider Status:\n\n');

  for (const provider of providers) {
    const hasCredentials = loadClientCredentials(provider) !== null;
    const tokenPath = getOAuthTokenPath(provider.id);
    const hasToken = existsSync(tokenPath);

    const credStatus = hasCredentials ? 'configured' : 'not configured';
    const tokenStatus = hasToken ? 'authorized' : 'not authorized';

    process.stdout.write(`  ${provider.displayName} (${provider.id})\n`);
    process.stdout.write(`    Credentials: ${credStatus}\n`);
    process.stdout.write(`    Token:       ${tokenStatus}\n`);
    process.stdout.write('\n');
  }
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/**
 * Attempts to revoke the token server-side via the provider's revocation
 * endpoint (if configured), then deletes the local token file.
 */
async function revokeToken(providerId: string): Promise<void> {
  const provider = resolveProviderOrExit(providerId);

  const tokenPath = getOAuthTokenPath(provider.id);
  if (!existsSync(tokenPath)) {
    process.stdout.write(`No stored token found for ${provider.displayName}.\n`);
    return;
  }

  // Attempt server-side revocation if the provider has a revocation endpoint
  await revokeTokenRemotely(provider);

  unlinkSync(tokenPath);
  process.stdout.write(`Token revoked for ${provider.displayName}.\n`);
  process.stdout.write(`Deleted: ${tokenPath}\n`);
}

/**
 * Calls the provider's token revocation endpoint to invalidate the token
 * server-side. Best-effort: logs a warning on failure but does not throw.
 */
async function revokeTokenRemotely(provider: OAuthProviderConfig): Promise<void> {
  if (!provider.revocationUrl) {
    return;
  }

  const token = loadOAuthToken(provider.id);
  if (!token) {
    return;
  }

  // Prefer revoking the refresh token (invalidates both access and refresh)
  const tokenToRevoke = token.refreshToken || token.accessToken;

  try {
    const response = await fetch(provider.revocationUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokenToRevoke }).toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      process.stdout.write(`Warning: Server-side revocation returned ${response.status}: ${text}\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Warning: Could not reach revocation endpoint: ${message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Authorize
// ---------------------------------------------------------------------------

/**
 * Parses optional --scopes flag from remaining args after the provider name.
 * Returns the scopes array, or undefined if not specified.
 */
function parseScopesArg(args: string[]): readonly string[] | undefined {
  // args is everything after the provider name
  if (args.length === 0) {
    return undefined;
  }

  try {
    const { values } = parseArgs({
      args,
      options: {
        scopes: { type: 'string' },
      },
      strict: false,
    });

    if (typeof values.scopes === 'string' && values.scopes.length > 0) {
      return values.scopes.split(',').map((s) => s.trim());
    }
  } catch {
    // Ignore parse errors -- treat as no scopes
  }

  return undefined;
}

async function authorize(providerId: string, extraArgs: string[]): Promise<void> {
  const provider = resolveProviderOrExit(providerId);

  const credentials = loadClientCredentials(provider);
  if (!credentials) {
    process.stdout.write(
      `No credentials configured for ${provider.displayName}.\n` +
        `Run 'ironcurtain auth import ${provider.id} <credentials-file>' first.\n`,
    );
    if (provider.id === 'google') {
      process.stdout.write(GOOGLE_SETUP_GUIDE);
    }
    process.exit(1);
  }

  const requestedScopes = parseScopesArg(extraArgs);

  // Determine effective scopes (merge existing + requested for incremental consent)
  let effectiveScopes: readonly string[] | undefined;
  if (requestedScopes) {
    const existingToken = loadOAuthToken(provider.id);
    const existingScopes = existingToken?.scopes ?? [];
    const merged = [...new Set([...existingScopes, ...requestedScopes])];
    effectiveScopes = merged;

    process.stdout.write(`\n  ${provider.displayName} OAuth -- Incremental Consent\n\n`);
    if (existingScopes.length > 0) {
      process.stdout.write('  Existing scopes:\n');
      for (const scope of existingScopes) {
        process.stdout.write(`    - ${scope}\n`);
      }
      process.stdout.write('\n  Requesting additional scopes:\n');
      for (const scope of requestedScopes) {
        if (!existingScopes.includes(scope)) {
          process.stdout.write(`    + ${scope}\n`);
        }
      }
      process.stdout.write('\n');
    }
  } else {
    process.stdout.write(`\n  ${provider.displayName} OAuth\n\n`);
    process.stdout.write(`  Using credentials: ${truncate(credentials.clientId, 30)}\n`);
    process.stdout.write(`  Requesting scopes: ${provider.defaultScopes.join(', ')}\n\n`);
  }

  process.stdout.write('  Opening browser for authorization...\n');

  const result = await runOAuthFlow(provider, credentials, effectiveScopes);
  saveOAuthToken(provider.id, result.token);

  const tokenPath = getOAuthTokenPath(provider.id);
  process.stdout.write(`\n  Authorization successful!\n`);
  process.stdout.write(`  Token stored at ${tokenPath}\n`);
  process.stdout.write(`  Granted scopes: ${result.grantedScopes.join(', ')}\n\n`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runAuthCommand(args: string[]): Promise<void> {
  // Check for --help anywhere in the args
  if (args.includes('--help') || args.includes('-h')) {
    printHelp(authSpec);
    return;
  }

  const subcommand = args[0];

  if (!subcommand || subcommand === 'status') {
    showStatus();
    return;
  }

  if (subcommand === 'import') {
    importCredentials(args.slice(1));
    return;
  }

  if (subcommand === 'revoke') {
    const providerId = args[1];
    if (!providerId) {
      process.stdout.write('Usage: ironcurtain auth revoke <provider>\n');
      process.exit(1);
    }
    await revokeToken(providerId);
    return;
  }

  // Remaining args after the provider name go to authorize for --scopes parsing
  await authorize(subcommand, args.slice(1));
}
