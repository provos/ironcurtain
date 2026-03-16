/**
 * Handles `ironcurtain auth [provider] [--scopes ...] [--revoke]`.
 *
 * Subcommands:
 *   ironcurtain auth              - show status of all providers
 *   ironcurtain auth status       - same as no args
 *   ironcurtain auth <provider>   - run OAuth flow for provider
 *   ironcurtain auth revoke <id>  - delete stored token for provider
 */

import { existsSync, unlinkSync } from 'node:fs';
import { getOAuthTokenPath } from '../config/paths.js';
import { loadClientCredentials } from './oauth-provider.js';
import { getAllOAuthProviders, resolveProviderOrExit } from './oauth-registry.js';
import { runOAuthFlow } from './oauth-flow.js';
import { saveOAuthToken } from './oauth-token-store.js';

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

function revokeToken(providerId: string): void {
  const provider = resolveProviderOrExit(providerId);

  const tokenPath = getOAuthTokenPath(provider.id);
  if (!existsSync(tokenPath)) {
    process.stdout.write(`No stored token found for ${provider.displayName}.\n`);
    return;
  }

  unlinkSync(tokenPath);
  process.stdout.write(`Token revoked for ${provider.displayName}.\n`);
  process.stdout.write(`Deleted: ${tokenPath}\n`);
}

// ---------------------------------------------------------------------------
// Authorize
// ---------------------------------------------------------------------------

async function authorize(providerId: string): Promise<void> {
  const provider = resolveProviderOrExit(providerId);

  const credentials = loadClientCredentials(provider);
  if (!credentials) {
    process.stdout.write(
      `No credentials configured for ${provider.displayName}.\n` +
        `Run 'ironcurtain setup ${provider.id} <credentials-file>' first.\n`,
    );
    process.exit(1);
  }

  const result = await runOAuthFlow(provider, credentials);
  saveOAuthToken(provider.id, result.token);
  process.stdout.write(`\n  Authorization successful!\n`);
  process.stdout.write(`  Granted scopes: ${result.grantedScopes.join(', ')}\n`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runAuthCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'status') {
    showStatus();
    return;
  }

  if (subcommand === 'revoke') {
    const providerId = args[1];
    if (!providerId) {
      process.stdout.write('Usage: ironcurtain auth revoke <provider>\n');
      process.exit(1);
    }
    revokeToken(providerId);
    return;
  }

  await authorize(subcommand);
}
