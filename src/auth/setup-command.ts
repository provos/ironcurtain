/**
 * Handles `ironcurtain setup <provider> <credentials-file>`.
 * Validates and imports OAuth client credentials into the local store.
 */

import { copyFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getOAuthDir } from '../config/paths.js';
import { loadClientCredentials } from './oauth-provider.js';
import { printAvailableProviders, resolveProviderOrExit } from './oauth-registry.js';

function truncate(value: string, maxLen: number): string {
  return value.length > maxLen ? value.slice(0, maxLen) + '...' : value;
}

/**
 * Runs the credential import command.
 *
 * Usage: ironcurtain setup <provider> <credentials-file>
 */
export function runSetupCommand(args: string[]): void {
  const providerId = args[0];
  const credentialsPath = args[1];

  if (!providerId) {
    process.stdout.write('Usage: ironcurtain setup <provider> <credentials-file>\n\n');
    printAvailableProviders();
    process.exit(1);
  }

  const provider = resolveProviderOrExit(providerId);

  if (!credentialsPath) {
    process.stdout.write(`Usage: ironcurtain setup ${providerId} <credentials-file>\n`);
    process.stdout.write('\nProvide the path to the credentials JSON file downloaded from your provider.\n');
    process.exit(1);
  }

  const resolvedPath = resolve(credentialsPath);
  if (!existsSync(resolvedPath)) {
    process.stdout.write(`File not found: ${resolvedPath}\n`);
    process.exit(1);
  }

  // Ensure the oauth directory exists and copy the file first
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
