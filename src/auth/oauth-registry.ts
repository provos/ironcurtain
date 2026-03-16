/**
 * OAuth provider registry.
 *
 * Central lookup for all registered OAuth providers. Provides access
 * by provider ID or by MCP server name.
 */

import type { OAuthProviderConfig, OAuthProviderId } from './oauth-provider.js';
import { googleOAuthProvider } from './providers/google.js';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const providers: readonly OAuthProviderConfig[] = [googleOAuthProvider];

const providerById = new Map<OAuthProviderId, OAuthProviderConfig>(providers.map((p) => [p.id, p]));

const providerByServerName = new Map<string, OAuthProviderConfig>(
  providers.flatMap((p) => p.serverNames.map((name) => [name, p] as const)),
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the provider config for a given provider ID.
 * Throws if the provider ID is not registered.
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderConfig {
  const provider = providerById.get(id);
  if (!provider) {
    throw new Error(`Unknown OAuth provider: ${id}`);
  }
  return provider;
}

/**
 * Returns all registered OAuth providers.
 */
export function getAllOAuthProviders(): readonly OAuthProviderConfig[] {
  return providers;
}

/**
 * Returns the provider config associated with a given MCP server name,
 * or undefined if no provider is registered for that server.
 */
export function getProviderForServer(serverName: string): OAuthProviderConfig | undefined {
  return providerByServerName.get(serverName);
}

/**
 * Returns true if the given string is a registered provider ID.
 */
export function isValidProviderId(id: string): id is OAuthProviderId {
  return providerById.has(id as OAuthProviderId);
}

/**
 * Resolves a provider ID string to its config, or writes an error and exits
 * if the ID is not registered. Shared by setup-command and auth-command.
 */
export function resolveProviderOrExit(id: string): OAuthProviderConfig {
  if (!isValidProviderId(id)) {
    process.stdout.write(`Unknown provider: ${id}\n\n`);
    printAvailableProviders();
    process.exit(1);
  }
  return getOAuthProvider(id);
}

/**
 * Prints registered provider IDs and display names to stdout.
 */
export function printAvailableProviders(): void {
  process.stdout.write('Available providers:\n');
  for (const p of providers) {
    process.stdout.write(`  ${p.id}  ${p.displayName}\n`);
  }
  process.stdout.write('\n');
}
