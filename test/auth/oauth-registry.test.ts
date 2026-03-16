import { describe, expect, it } from 'vitest';
import { getAllOAuthProviders, getOAuthProvider, getProviderForServer } from '../../src/auth/oauth-registry.js';

describe('OAuth provider registry', () => {
  describe('getOAuthProvider', () => {
    it('returns the Google provider', () => {
      const provider = getOAuthProvider('google');
      expect(provider.id).toBe('google');
      expect(provider.displayName).toBe('Google Workspace');
      expect(provider.usePkce).toBe(true);
    });

    it('throws for unknown provider ID', () => {
      // @ts-expect-error testing invalid input
      expect(() => getOAuthProvider('unknown')).toThrow(/Unknown OAuth provider: unknown/);
    });
  });

  describe('getAllOAuthProviders', () => {
    it('returns all registered providers', () => {
      const providers = getAllOAuthProviders();
      expect(providers.length).toBeGreaterThanOrEqual(1);
      const ids = providers.map((p) => p.id);
      expect(ids).toContain('google');
    });
  });

  describe('getProviderForServer', () => {
    it('returns provider for a registered server name', () => {
      const provider = getProviderForServer('google-workspace');
      expect(provider).toBeDefined();
      expect(provider!.id).toBe('google');
    });

    it('returns undefined for unknown server name', () => {
      const provider = getProviderForServer('nonexistent-server');
      expect(provider).toBeUndefined();
    });
  });
});
