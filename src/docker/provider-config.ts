/**
 * LLM API provider configuration for the MITM proxy.
 *
 * Each provider defines its host, allowed endpoints, key injection method,
 * and fake key prefix. The proxy uses these to filter requests and swap
 * sentinel keys for real ones.
 */

/**
 * Configuration for an LLM API provider, describing how the MITM proxy
 * should handle traffic to this provider's API.
 */
export interface ProviderConfig {
  /** Hostname of the API endpoint (e.g., 'api.anthropic.com'). */
  readonly host: string;

  /** Human-readable provider name for logging. */
  readonly displayName: string;

  /**
   * Allowed HTTP endpoints. Requests not matching any pattern get 403.
   * Patterns use exact method match and path matching (see EndpointPattern).
   */
  readonly allowedEndpoints: readonly EndpointPattern[];

  /**
   * How the API key is transmitted in requests.
   * Determines where the proxy looks for the fake key and injects the real one.
   */
  readonly keyInjection: KeyInjection;

  /**
   * Prefix for generating fake sentinel keys that pass client-side validation.
   * Example: 'sk-ant-api03-' for Anthropic.
   */
  readonly fakeKeyPrefix: string;
}

export interface EndpointPattern {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /**
   * Path pattern. Supports two forms:
   * - Exact match: '/v1/messages' (compared after stripping query string)
   * - Glob with '*' segments: '/v1beta/models/STAR/generateContent'
   *   (each '*' matches exactly one path segment [^/]+)
   *
   * Non-glob characters are regex-escaped before matching to prevent
   * metacharacters in paths (e.g., '.') from being interpreted as regex.
   */
  readonly path: string;
}

/**
 * How the API key is transmitted in requests.
 */
export type KeyInjection = { readonly type: 'header'; readonly headerName: string } | { readonly type: 'bearer' };

/**
 * Checks whether a request method+path is in the provider's allowlist.
 */
export function isEndpointAllowed(
  config: ProviderConfig,
  method: string | undefined,
  path: string | undefined,
): boolean {
  if (!method || !path) return false;
  const cleanPath = path.split('?')[0]; // strip query string

  return config.allowedEndpoints.some((ep) => {
    if (ep.method !== method.toUpperCase()) return false;
    if (ep.path.includes('*')) {
      // Escape regex metacharacters in non-glob segments, then replace
      // '*' with [^/]+ to match exactly one path segment.
      const escaped = ep.path
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]+');
      const regex = new RegExp('^' + escaped + '$');
      return regex.test(cleanPath);
    }
    return cleanPath === ep.path;
  });
}

// --- Built-in providers ---

export const anthropicProvider: ProviderConfig = {
  host: 'api.anthropic.com',
  displayName: 'Anthropic',
  allowedEndpoints: [
    // Core API
    { method: 'POST', path: '/v1/messages' },
    { method: 'POST', path: '/v1/messages/count_tokens' },
    // Claude Code internal endpoints
    { method: 'GET', path: '/api/claude_code/settings' },
    { method: 'GET', path: '/api/claude_code/policy_limits' },
    { method: 'GET', path: '/api/claude_code/organizations/metrics_enabled' },
    { method: 'GET', path: '/api/claude_code_penguin_mode' },
    // Telemetry
    { method: 'POST', path: '/api/event_logging/batch' },
    { method: 'POST', path: '/api/eval/*' },
  ],
  keyInjection: { type: 'header', headerName: 'x-api-key' },
  fakeKeyPrefix: 'sk-ant-api03-ironcurtain-',
};

export const openaiProvider: ProviderConfig = {
  host: 'api.openai.com',
  displayName: 'OpenAI',
  allowedEndpoints: [
    { method: 'POST', path: '/v1/chat/completions' },
    { method: 'GET', path: '/v1/models' },
  ],
  keyInjection: { type: 'bearer' },
  fakeKeyPrefix: 'sk-ironcurtain-',
};

export const googleProvider: ProviderConfig = {
  host: 'generativelanguage.googleapis.com',
  displayName: 'Google',
  allowedEndpoints: [
    { method: 'POST', path: '/v1beta/models/*/generateContent' },
    { method: 'POST', path: '/v1beta/models/*/streamGenerateContent' },
  ],
  keyInjection: { type: 'header', headerName: 'x-goog-api-key' },
  fakeKeyPrefix: 'AIzaSy-ironcurtain-',
};
