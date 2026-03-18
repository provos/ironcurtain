import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TokenFileRefresher,
  REFRESH_THRESHOLD_MS,
  type TokenRefreshConfig,
} from '../src/trusted-process/token-file-refresher.js';

function createMockConfig(overrides: Partial<TokenRefreshConfig> = {}): TokenRefreshConfig {
  return {
    providerId: 'google',
    getAccessToken: vi.fn().mockResolvedValue({
      accessToken: 'ya29.refreshed',
      expiresAt: Date.now() + 3600_000,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    }),
    writeCredentialFile: vi.fn(),
    ...overrides,
  };
}

describe('TokenFileRefresher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('refreshIfNeeded', () => {
    it('does nothing when token is not near expiry', async () => {
      const config = createMockConfig();
      const farFuture = Date.now() + 60 * 60 * 1000; // 1 hour from now
      const refresher = new TokenFileRefresher(config, farFuture);

      await refresher.refreshIfNeeded();

      expect(config.getAccessToken).not.toHaveBeenCalled();
      expect(config.writeCredentialFile).not.toHaveBeenCalled();
    });

    it('refreshes when token is within threshold of expiry', async () => {
      const config = createMockConfig();
      const nearExpiry = Date.now() + REFRESH_THRESHOLD_MS - 1000; // 9 min from now
      const refresher = new TokenFileRefresher(config, nearExpiry);

      await refresher.refreshIfNeeded();

      expect(config.getAccessToken).toHaveBeenCalledOnce();
      expect(config.writeCredentialFile).toHaveBeenCalledWith('ya29.refreshed', expect.any(Number), [
        'https://www.googleapis.com/auth/gmail.readonly',
      ]);
    });

    it('refreshes when token is already expired', async () => {
      const config = createMockConfig();
      const expired = Date.now() - 1000; // 1 second ago
      const refresher = new TokenFileRefresher(config, expired);

      await refresher.refreshIfNeeded();

      expect(config.getAccessToken).toHaveBeenCalledOnce();
      expect(config.writeCredentialFile).toHaveBeenCalledOnce();
    });

    it('updates internal expiry after successful refresh', async () => {
      const newExpiresAt = Date.now() + 3600_000;
      const config = createMockConfig({
        getAccessToken: vi.fn().mockResolvedValue({
          accessToken: 'ya29.new',
          expiresAt: newExpiresAt,
          scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        }),
      });
      const nearExpiry = Date.now() + 1000;
      const refresher = new TokenFileRefresher(config, nearExpiry);

      // First call should refresh
      await refresher.refreshIfNeeded();
      expect(config.getAccessToken).toHaveBeenCalledOnce();

      // Second call should not refresh (token is now fresh)
      await refresher.refreshIfNeeded();
      expect(config.getAccessToken).toHaveBeenCalledOnce();
    });

    it('passes fresh scopes from getAccessToken to writeCredentialFile', async () => {
      const freshScopes = [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/calendar.readonly',
      ];
      const config = createMockConfig({
        getAccessToken: vi.fn().mockResolvedValue({
          accessToken: 'ya29.fresh',
          expiresAt: Date.now() + 3600_000,
          scopes: freshScopes,
        }),
      });
      const expired = Date.now() - 1000;
      const refresher = new TokenFileRefresher(config, expired);

      await refresher.refreshIfNeeded();

      expect(config.writeCredentialFile).toHaveBeenCalledWith('ya29.fresh', expect.any(Number), freshScopes);
    });

    it('logs errors to stderr without throwing', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const config = createMockConfig({
        getAccessToken: vi.fn().mockRejectedValue(new Error('Token endpoint unreachable')),
      });
      const expired = Date.now() - 1000;
      const refresher = new TokenFileRefresher(config, expired);

      // Should not throw
      await refresher.refreshIfNeeded();

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Token endpoint unreachable'));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[token-refresher]'));
      expect(config.writeCredentialFile).not.toHaveBeenCalled();

      stderrSpy.mockRestore();
    });

    it('logs non-Error exceptions to stderr', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const config = createMockConfig({
        getAccessToken: vi.fn().mockRejectedValue('string error'),
      });
      const refresher = new TokenFileRefresher(config, Date.now() - 1000);

      await refresher.refreshIfNeeded();

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('string error'));

      stderrSpy.mockRestore();
    });
  });

  describe('start/stop lifecycle', () => {
    it('calls refreshIfNeeded on the interval', async () => {
      const config = createMockConfig();
      const nearExpiry = Date.now() + REFRESH_THRESHOLD_MS - 1000;
      const refresher = new TokenFileRefresher(config, nearExpiry);

      refresher.start(1000); // 1 second interval for testing

      // Advance past one interval tick
      await vi.advanceTimersByTimeAsync(1000);
      expect(config.getAccessToken).toHaveBeenCalledOnce();

      refresher.stop();
    });

    it('stop prevents further refresh checks', async () => {
      const config = createMockConfig();
      const nearExpiry = Date.now() + REFRESH_THRESHOLD_MS - 1000;
      const refresher = new TokenFileRefresher(config, nearExpiry);

      refresher.start(1000);

      await vi.advanceTimersByTimeAsync(1000);
      expect(config.getAccessToken).toHaveBeenCalledOnce();

      refresher.stop();

      await vi.advanceTimersByTimeAsync(5000);
      // Still only called once -- no more ticks after stop
      expect(config.getAccessToken).toHaveBeenCalledOnce();
    });

    it('start is idempotent (does not create multiple intervals)', async () => {
      const config = createMockConfig();
      const nearExpiry = Date.now() + REFRESH_THRESHOLD_MS - 1000;
      const refresher = new TokenFileRefresher(config, nearExpiry);

      refresher.start(1000);
      refresher.start(1000); // Second call should be a no-op

      await vi.advanceTimersByTimeAsync(1000);
      // Should still only fire once per interval, not twice
      expect(config.getAccessToken).toHaveBeenCalledOnce();

      refresher.stop();
    });

    it('stop is idempotent (safe to call multiple times)', () => {
      const config = createMockConfig();
      const refresher = new TokenFileRefresher(config, Date.now() + 3600_000);

      refresher.start(1000);
      refresher.stop();
      refresher.stop(); // Should not throw
    });
  });
});
