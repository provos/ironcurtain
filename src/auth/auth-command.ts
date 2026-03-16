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

import { copyFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as p from '@clack/prompts';
import { printHelp, type CommandSpec } from '../cli-help.js';
import { getOAuthDir, getOAuthTokenPath } from '../config/paths.js';
import type { OAuthProviderConfig, StoredOAuthToken } from './oauth-provider.js';
import { loadClientCredentials } from './oauth-provider.js';
import { getAllOAuthProviders, printAvailableProviders, resolveProviderOrExit } from './oauth-registry.js';
import { runOAuthFlow } from './oauth-flow.js';
import { deleteOAuthToken, loadOAuthToken, saveOAuthToken } from './oauth-token-store.js';

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
    Add scopes based on what you need:
      Read-only (default):  gmail.readonly, calendar.readonly, drive.readonly
      Write access:         gmail.send, calendar.events, drive.file
    You choose which scopes to enable — write scopes are optional.
    Under Test users, add your Google account email.

    Note: In "Testing" mode, refresh tokens expire after 7 days.
    You will need to re-authorize weekly.

    To add write scopes after initial authorization:
      ironcurtain auth google --scopes gmail.send,calendar.events

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

/** Provider-specific setup guides, keyed by provider ID. */
const SETUP_GUIDES: Readonly<Record<string, string>> = {
  google: GOOGLE_SETUP_GUIDE,
};

function showSetupGuide(providerId: string): void {
  const guide = SETUP_GUIDES[providerId];
  if (guide) {
    process.stdout.write(guide);
  }
}

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
    showSetupGuide(provider.id);
    process.exit(1);
    return;
  }

  const resolvedPath = resolve(credentialsPath);

  // Ensure the oauth directory exists and copy the file
  const oauthDir = getOAuthDir();
  mkdirSync(oauthDir, { recursive: true });

  const destPath = resolve(oauthDir, provider.credentialsFilename);
  try {
    copyFileSync(resolvedPath, destPath);
    chmodSync(destPath, 0o600);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Failed to import credentials: ${message}\n`);
    process.exit(1);
  }

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
    let credStatus: string;
    try {
      credStatus = loadClientCredentials(provider) !== null ? 'configured' : 'not configured';
    } catch {
      credStatus = 'invalid';
    }
    const tokenPath = getOAuthTokenPath(provider.id);
    const hasToken = existsSync(tokenPath);

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

  const token = loadOAuthToken(provider.id);
  if (!token) {
    process.stdout.write(`No stored token found for ${provider.displayName}.\n`);
    return;
  }

  // Attempt server-side revocation if the provider has a revocation endpoint
  await revokeTokenRemotely(provider, token);

  deleteOAuthToken(provider.id);
  process.stdout.write(`Token revoked for ${provider.displayName}.\n`);
  process.stdout.write(`Deleted: ${getOAuthTokenPath(provider.id)}\n`);
}

/**
 * Calls the provider's token revocation endpoint to invalidate the token
 * server-side. Best-effort: logs a warning on failure but does not throw.
 */
async function revokeTokenRemotely(provider: OAuthProviderConfig, token: StoredOAuthToken): Promise<void> {
  if (!provider.revocationUrl) {
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
      return values.scopes
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
  } catch {
    // Ignore parse errors -- treat as no scopes
  }

  return undefined;
}

/**
 * Checks whether any of the selected scopes are non-default for this provider.
 * Used to decide whether to show a consent-screen warning.
 */
function hasNonDefaultScopes(provider: OAuthProviderConfig, scopes: readonly string[]): boolean {
  const defaults = new Set(provider.defaultScopes);
  return scopes.some((s) => !defaults.has(s));
}

/**
 * Shows a warning note about non-default scopes requiring Google Cloud
 * consent screen configuration, then prompts for confirmation.
 * Returns false if the user cancels.
 */
async function confirmNonDefaultScopes(provider: OAuthProviderConfig, scopes: readonly string[]): Promise<boolean> {
  if (!hasNonDefaultScopes(provider, scopes)) {
    return true;
  }

  const defaults = new Set(provider.defaultScopes);
  const nonDefault = scopes.filter((s) => !defaults.has(s));

  p.note(
    'The following scopes require write access:\n\n' +
      nonDefault.map((s) => `  ${s}`).join('\n') +
      '\n\n' +
      'Make sure these scopes are enabled in your Google Cloud\n' +
      "project's OAuth consent screen before proceeding.\n" +
      'See: APIs & Services > OAuth consent screen > Scopes',
    'Non-default scopes selected',
  );

  const confirmed = await p.confirm({
    message: 'Continue with authorization?',
    initialValue: true,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    return false;
  }

  return true;
}

async function authorize(providerId: string, extraArgs: string[]): Promise<void> {
  const provider = resolveProviderOrExit(providerId);

  let credentials;
  try {
    credentials = loadClientCredentials(provider);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Invalid credentials for ${provider.displayName}: ${message}\n`);
    process.stdout.write(`Re-import with: ironcurtain auth import ${provider.id} <credentials-file>\n`);
    process.exit(1);
  }
  if (!credentials) {
    process.stdout.write(
      `No credentials configured for ${provider.displayName}.\n` +
        `Run 'ironcurtain auth import ${provider.id} <credentials-file>' first.\n`,
    );
    showSetupGuide(provider.id);
    process.exit(1);
  }

  const requestedScopes = parseScopesArg(extraArgs);

  // Determine effective scopes (merge default + existing + requested for incremental consent)
  let effectiveScopes: readonly string[] | undefined;
  let needsConfirmation = false;

  if (requestedScopes) {
    // --scopes flag: resolve short names and merge with existing
    const resolved = provider.resolveShortScopes ? provider.resolveShortScopes(requestedScopes) : requestedScopes;

    const existingToken = loadOAuthToken(provider.id);
    const existingScopes = existingToken?.scopes ?? [];
    // Always include provider defaults as baseline so --scopes only adds, never drops
    const merged = [...new Set([...provider.defaultScopes, ...existingScopes, ...resolved])];
    effectiveScopes = merged;

    process.stdout.write(`\n  ${provider.displayName} OAuth -- Incremental Consent\n\n`);
    if (existingScopes.length > 0) {
      process.stdout.write('  Existing scopes:\n');
      for (const scope of existingScopes) {
        process.stdout.write(`    - ${scope}\n`);
      }
      process.stdout.write('\n  Requesting additional scopes:\n');
      for (const scope of resolved) {
        if (!existingScopes.includes(scope)) {
          process.stdout.write(`    + ${scope}\n`);
        }
      }
      process.stdout.write('\n');
    }
  } else if (process.stdin.isTTY && provider.scopePicker) {
    // Interactive TTY: show the scope picker
    const existingToken = loadOAuthToken(provider.id);
    const existingScopes = existingToken?.scopes ?? [];

    const selected = await provider.scopePicker(existingScopes);
    if (p.isCancel(selected)) {
      p.cancel('Authorization cancelled.');
      return;
    }

    effectiveScopes = selected;
    needsConfirmation = true;
  } else {
    // Non-interactive: use defaults
    process.stdout.write(`\n  ${provider.displayName} OAuth\n\n`);
    process.stdout.write(`  Using credentials: ${truncate(credentials.clientId, 30)}\n`);
    process.stdout.write(`  Requesting scopes: ${provider.defaultScopes.join(', ')}\n\n`);
  }

  // Warn about non-default scopes and confirm (for interactive picker only)
  if (effectiveScopes && needsConfirmation) {
    const confirmed = await confirmNonDefaultScopes(provider, effectiveScopes);
    if (!confirmed) {
      p.cancel('Authorization cancelled.');
      return;
    }
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
  const subcommand = args[0];

  // Show help when --help/-h is the first arg or no subcommand is given.
  // Don't intercept --help after a subcommand — let subcommands handle their own help.
  if (subcommand === '--help' || subcommand === '-h') {
    printHelp(authSpec);
    return;
  }

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
