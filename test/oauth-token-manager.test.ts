import { describe, it, expect, vi } from 'vitest';
import { OAuthTokenManager, type TokenManagerDeps } from '../src/docker/oauth-token-manager.js';
import type { OAuthCredentials } from '../src/docker/oauth-credentials.js';

function validCreds(overrides?: Partial<OAuthCredentials>): OAuthCredentials {
  return {
    accessToken: 'access-token-original',
    refreshToken: 'refresh-token-original',
    expiresAt: Date.now() + 3_600_000, // 1 hour
    ...overrides,
  };
}

function nearExpiryCreds(overrides?: Partial<OAuthCredentials>): OAuthCredentials {
  return {
    accessToken: 'access-token-expiring',
    refreshToken: 'refresh-token-expiring',
    expiresAt: Date.now() + 2 * 60 * 1000, // 2 minutes (within 5-min buffer)
    ...overrides,
  };
}

function refreshedCreds(overrides?: Partial<OAuthCredentials>): OAuthCredentials {
  return {
    accessToken: 'access-token-refreshed',
    refreshToken: 'refresh-token-refreshed',
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<TokenManagerDeps>): TokenManagerDeps {
  return {
    loadCredentials: vi.fn(() => null),
    loadFromKeychain: vi.fn(() => null),
    refreshToken: vi.fn(async () => null),
    saveCredentials: vi.fn(),
    credentialsFilePath: '/fake/.credentials.json',
    now: () => Date.now(),
    ...overrides,
  };
}

describe('OAuthTokenManager', () => {
  describe('getValidAccessToken', () => {
    it('returns current token when not near expiry', async () => {
      const creds = validCreds();
      const deps = makeDeps();
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.getValidAccessToken();
      expect(token).toBe('access-token-original');
      expect(deps.refreshToken).not.toHaveBeenCalled();
    });

    it('proactively refreshes when token is near expiry', async () => {
      const creds = nearExpiryCreds();
      const newCreds = refreshedCreds();
      const deps = makeDeps({
        refreshToken: vi.fn(async () => newCreds),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.getValidAccessToken();
      expect(token).toBe('access-token-refreshed');
      expect(deps.refreshToken).toHaveBeenCalledWith('refresh-token-expiring');
      expect(deps.saveCredentials).toHaveBeenCalledWith(newCreds, '/fake/.credentials.json');
    });

    it('re-reads credentials file before refreshing', async () => {
      const creds = nearExpiryCreds();
      const fileCreds = validCreds({ accessToken: 'access-from-file' });
      const deps = makeDeps({
        loadCredentials: vi.fn(() => fileCreds),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.getValidAccessToken();
      expect(token).toBe('access-from-file');
      // Should NOT call refreshToken since file had valid creds
      expect(deps.refreshToken).not.toHaveBeenCalled();
    });

    it('returns current token if refresh fails but token not yet expired', async () => {
      const creds = nearExpiryCreds();
      const deps = makeDeps({
        refreshToken: vi.fn(async () => null),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.getValidAccessToken();
      // Falls back to existing token
      expect(token).toBe('access-token-expiring');
    });
  });

  describe('handleAuthFailure', () => {
    it('refreshes and returns new token on success', async () => {
      const creds = validCreds();
      const newCreds = refreshedCreds();
      const deps = makeDeps({
        refreshToken: vi.fn(async () => newCreds),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.handleAuthFailure();
      expect(token).toBe('access-token-refreshed');
      expect(deps.saveCredentials).toHaveBeenCalled();
    });

    it('returns null when refresh is unrecoverable', async () => {
      const creds = validCreds();
      const deps = makeDeps({
        loadCredentials: vi.fn(() => null),
        refreshToken: vi.fn(async () => null),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.handleAuthFailure();
      expect(token).toBeNull();
    });

    it('uses file credentials on fallback re-read after refresh failure', async () => {
      const creds = validCreds();
      let readCount = 0;
      const deps = makeDeps({
        loadCredentials: vi.fn(() => {
          readCount++;
          // First read: return expired creds (or null)
          if (readCount === 1) return null;
          // Second read (fallback): return fresh creds from host CC
          return validCreds({ accessToken: 'access-from-host-cc' });
        }),
        refreshToken: vi.fn(async () => null),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.handleAuthFailure();
      expect(token).toBe('access-from-host-cc');
      expect(deps.loadCredentials).toHaveBeenCalledTimes(2);
    });

    it('uses refresh token from file when available', async () => {
      const creds = nearExpiryCreds();
      const fileCreds = nearExpiryCreds({
        refreshToken: 'refresh-from-file',
      });
      const newCreds = refreshedCreds();
      const deps = makeDeps({
        loadCredentials: vi.fn(() => fileCreds),
        refreshToken: vi.fn(async () => newCreds),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      // File creds are also expired, so it should use the file's refresh token
      await manager.handleAuthFailure();
      expect(deps.refreshToken).toHaveBeenCalledWith('refresh-from-file');
    });
  });

  describe('concurrency', () => {
    it('deduplicates concurrent refresh calls', async () => {
      const creds = validCreds();
      const newCreds = refreshedCreds();
      const refreshFn = vi.fn(
        () => new Promise<OAuthCredentials>((resolve) => setTimeout(() => resolve(newCreds), 50)),
      );
      const deps = makeDeps({ refreshToken: refreshFn });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      // Launch two concurrent handleAuthFailure calls
      const [token1, token2] = await Promise.all([manager.handleAuthFailure(), manager.handleAuthFailure()]);

      expect(token1).toBe('access-token-refreshed');
      expect(token2).toBe('access-token-refreshed');
      // refreshToken should only be called once (deduplication)
      expect(refreshFn).toHaveBeenCalledTimes(1);
    });

    it('allows new refresh after previous completes', async () => {
      const creds = validCreds();
      const refreshFn = vi.fn(async () => refreshedCreds());
      const deps = makeDeps({ refreshToken: refreshFn });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      await manager.handleAuthFailure();
      await manager.handleAuthFailure();
      // Two separate calls should each trigger a refresh
      expect(refreshFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('accessToken getter', () => {
    it('returns initial token', () => {
      const creds = validCreds();
      const deps = makeDeps();
      const manager = new OAuthTokenManager(creds, undefined, deps);
      expect(manager.accessToken).toBe('access-token-original');
    });

    it('returns updated token after refresh', async () => {
      const creds = validCreds();
      const newCreds = refreshedCreds();
      const deps = makeDeps({
        refreshToken: vi.fn(async () => newCreds),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      await manager.handleAuthFailure();
      expect(manager.accessToken).toBe('access-token-refreshed');
    });
  });

  describe('error handling', () => {
    it('continues even if saveCredentials throws', async () => {
      const creds = validCreds();
      const newCreds = refreshedCreds();
      const deps = makeDeps({
        refreshToken: vi.fn(async () => newCreds),
        saveCredentials: vi.fn(() => {
          throw new Error('disk full');
        }),
      });
      const manager = new OAuthTokenManager(creds, undefined, deps);

      const token = await manager.handleAuthFailure();
      // Should still return the new token despite save failure
      expect(token).toBe('access-token-refreshed');
      expect(manager.accessToken).toBe('access-token-refreshed');
    });
  });

  describe('Keychain mode (canRefresh: false)', () => {
    it('never calls refreshToken', async () => {
      const creds = nearExpiryCreds();
      const deps = makeDeps();
      const manager = new OAuthTokenManager(creds, { canRefresh: false }, deps);

      await manager.getValidAccessToken();
      expect(deps.refreshToken).not.toHaveBeenCalled();
    });

    it('re-reads file and uses valid credentials', async () => {
      const creds = nearExpiryCreds();
      const fileCreds = validCreds({ accessToken: 'access-from-file' });
      const deps = makeDeps({
        loadCredentials: vi.fn(() => fileCreds),
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: false }, deps);

      const token = await manager.getValidAccessToken();
      expect(token).toBe('access-from-file');
      expect(deps.refreshToken).not.toHaveBeenCalled();
    });

    it('falls back to Keychain when file has no valid creds', async () => {
      const creds = nearExpiryCreds();
      const keychainCreds = validCreds({ accessToken: 'access-from-keychain' });
      const deps = makeDeps({
        loadCredentials: vi.fn(() => null),
        loadFromKeychain: vi.fn(() => keychainCreds),
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: false }, deps);

      const token = await manager.getValidAccessToken();
      expect(token).toBe('access-from-keychain');
      expect(deps.loadFromKeychain).toHaveBeenCalled();
      expect(deps.refreshToken).not.toHaveBeenCalled();
    });

    it('returns null when both file and Keychain have expired creds', async () => {
      const creds = nearExpiryCreds();
      const deps = makeDeps({
        loadCredentials: vi.fn(() => nearExpiryCreds()),
        loadFromKeychain: vi.fn(() => nearExpiryCreds()),
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: false }, deps);

      const token = await manager.handleAuthFailure();
      expect(token).toBeNull();
      expect(deps.refreshToken).not.toHaveBeenCalled();
    });

    it('returns null on handleAuthFailure when no fresh creds available', async () => {
      const creds = validCreds();
      const deps = makeDeps({
        loadCredentials: vi.fn(() => null),
        loadFromKeychain: vi.fn(() => null),
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: false }, deps);

      const token = await manager.handleAuthFailure();
      expect(token).toBeNull();
    });

    it('does not save credentials', async () => {
      const creds = nearExpiryCreds();
      const keychainCreds = validCreds({ accessToken: 'access-from-keychain' });
      const deps = makeDeps({
        loadFromKeychain: vi.fn(() => keychainCreds),
      });
      const manager = new OAuthTokenManager(creds, { canRefresh: false }, deps);

      await manager.getValidAccessToken();
      expect(deps.saveCredentials).not.toHaveBeenCalled();
    });
  });
});
