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
