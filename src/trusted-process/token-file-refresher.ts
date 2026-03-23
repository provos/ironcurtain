/**
 * Proactive OAuth credential file refresher for MCP servers.
 *
 * Runs in the proxy process. Periodically checks token expiry and
 * writes fresh credential files before the access token expires.
 * The MCP server's own loadCredentialsQuietly() re-reads the file
 * on each tool call, picking up the refreshed token transparently.
 *
 * Why this lives in the proxy process (not session):
 * - The proxy process spawns and owns the MCP server child processes
 * - The proxy process has direct access to the credential file directory
 * - The proxy process lifetime matches the MCP server lifetime
 */

/** Configuration for a single server's token refresh. */
export interface TokenRefreshConfig {
  /** OAuth provider ID (e.g., 'google'). Used in log messages. */
  readonly providerId: string;
  /** Function to obtain a fresh access token. Calls OAuthTokenProvider. */
  readonly getAccessToken: () => Promise<{
    accessToken: string;
    expiresAt: number;
    scopes: readonly string[];
  }>;
  /** Function to write the credential file in the format the MCP server expects. */
  readonly writeCredentialFile: (accessToken: string, expiresAt: number, scopes: readonly string[]) => void;
  /** Optional callback to log to the session log (not just stderr). */
  readonly logToSession?: (message: string) => void;
}

/**
 * Default refresh check interval: 5 minutes.
 *
 * Much shorter than the MCP server's own 45-minute interval, ensuring
 * we always refresh well before the ~60-minute access token lifetime
 * expires. With a 10-minute-before-expiry threshold, the worst case
 * is 5 + 10 = 15 minutes before expiry.
 */
export const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Refresh when within 10 minutes of expiry.
 * Exported for test access.
 */
export const REFRESH_THRESHOLD_MS = 10 * 60 * 1000;

/**
 * Manages proactive token refresh for a single MCP server.
 *
 * Checks token expiry on a timer and writes a fresh credential file
 * before the access token expires. Errors are logged to stderr but
 * never thrown (the refresher runs on an interval and must not crash).
 */
export class TokenFileRefresher {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private currentExpiresAt: number;
  private readonly config: TokenRefreshConfig;

  constructor(config: TokenRefreshConfig, initialExpiresAt: number) {
    this.config = config;
    this.currentExpiresAt = initialExpiresAt;
  }

  /** Logs to session log (if available) and stderr. */
  private log(message: string, isError = false): void {
    const prefix = `[token-refresher:${this.config.providerId}]`;
    const full = `${prefix} ${message}`;
    this.config.logToSession?.(full);
    if (isError) {
      process.stderr.write(`${full}\n`);
    }
  }

  /** Starts the periodic refresh check. Performs an immediate check first. */
  start(intervalMs: number = DEFAULT_REFRESH_INTERVAL_MS): void {
    if (this.intervalHandle !== null) return;

    // Immediate check — catches tokens already near expiry at session start
    void this.refreshIfNeeded();

    this.intervalHandle = setInterval(() => {
      void this.refreshIfNeeded();
    }, intervalMs);

    // Ensure the interval doesn't keep the process alive
    this.intervalHandle.unref();
  }

  /** Stops the periodic refresh and cleans up. */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Performs a single refresh check.
   * Public for testing; normally called by the interval.
   *
   * Errors are caught and logged to stderr -- never propagated.
   */
  async refreshIfNeeded(): Promise<void> {
    // Guard against concurrent refreshes (slow network can overlap next tick)
    if (this.inflight) return;

    try {
      const now = Date.now();
      const timeUntilExpiry = this.currentExpiresAt - now;

      if (timeUntilExpiry > REFRESH_THRESHOLD_MS) {
        return; // Token still has plenty of time
      }

      const minUntilExpiry = Math.round(timeUntilExpiry / 60_000);
      this.log(`Refreshing token (${minUntilExpiry} min until expiry)`);

      const refresh = (async () => {
        const { accessToken, expiresAt, scopes } = await this.config.getAccessToken();
        this.config.writeCredentialFile(accessToken, expiresAt, scopes);
        this.currentExpiresAt = expiresAt;
        const newMin = Math.round((expiresAt - Date.now()) / 60_000);
        this.log(`Token refreshed successfully (new expiry in ${newMin} min)`);
      })();
      this.inflight = refresh;
      await refresh;
    } catch (err) {
      // Log but don't throw -- this runs on an interval
      const message = err instanceof Error ? err.message : String(err);
      this.log(`FAILED to refresh token: ${message}`, true);
    } finally {
      this.inflight = null;
    }
  }
}
