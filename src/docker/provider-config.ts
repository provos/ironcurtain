/**
 * LLM API provider configuration for the MITM proxy.
 *
 * Each provider defines its host, allowed endpoints, key injection method,
 * and fake key prefix. The proxy uses these to filter requests and swap
 * sentinel keys for real ones.
 */

/**
 * Result from a RequestBodyRewriter when modifications were made.
 */
export interface RewriteResult {
  /** The modified request body object. */
  readonly modified: Record<string, unknown>;
  /** Human-readable descriptions of what was stripped (for logging). */
  readonly stripped: string[];
}

/**
 * A function that inspects and optionally modifies a parsed JSON request body.
 * Returns a RewriteResult if the body was modified, or null if no changes needed.
 */
export type RequestBodyRewriter = (
  body: Record<string, unknown>,
  context: { method: string; path: string },
) => RewriteResult | null;

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

  /**
   * Optional function to inspect and modify request bodies before forwarding.
   * Only called for endpoints listed in rewriteEndpoints.
   */
  readonly requestRewriter?: RequestBodyRewriter;

  /**
   * Paths for which the proxy should buffer and rewrite request bodies.
   * Only applies to POST requests. Requires requestRewriter to be set.
   */
  readonly rewriteEndpoints?: readonly string[];
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

// --- Request body rewriters ---

/**
 * Returns the server-side tool type string if the tool entry is a
 * server-side tool, or null if it is a custom/MCP-bridged tool.
 *
 * Server-side tools have a `type` field that is not "custom".
 * Custom tools either have no `type` field or `type: "custom"`.
 */
function getServerSideToolType(tool: unknown): string | null {
  if (typeof tool !== 'object' || tool === null || !('type' in tool)) return null;
  const { type } = tool as Record<string, unknown>;
  if (typeof type === 'string' && type !== 'custom') return type;
  return null;
}

/**
 * Strips server-side tools from the Anthropic Messages API `tools` array.
 *
 * Server-side tools (e.g. web_search_20250305, computer_20250124) have a
 * `type` field that is not "custom". Custom/MCP-bridged tools either have
 * no `type` field or `type: "custom"`.
 */
export function stripServerSideTools(body: Record<string, unknown>): RewriteResult | null {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const stripped: string[] = [];
  const kept: unknown[] = [];

  for (const tool of tools) {
    const serverType = getServerSideToolType(tool);
    if (serverType) {
      stripped.push(serverType);
    } else {
      kept.push(tool);
    }
  }

  if (stripped.length === 0) return null;

  return {
    modified: { ...body, tools: kept },
    stripped,
  };
}

/**
 * Returns true if this request should have its body buffered and rewritten.
 * Only matches POST requests to paths listed in the provider's rewriteEndpoints.
 */
export function shouldRewriteBody(
  config: ProviderConfig,
  method: string | undefined,
  path: string | undefined,
): boolean {
  if (!config.requestRewriter || !config.rewriteEndpoints) return false;
  if (!method || method.toUpperCase() !== 'POST') return false;
  if (!path) return false;
  const cleanPath = path.split('?')[0];
  return config.rewriteEndpoints.includes(cleanPath);
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
    { method: 'GET', path: '/api/hello' },
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
  requestRewriter: stripServerSideTools,
  rewriteEndpoints: ['/v1/messages'],
};

export const claudePlatformProvider: ProviderConfig = {
  host: 'platform.claude.com',
  displayName: 'Claude Platform',
  allowedEndpoints: [{ method: 'GET', path: '/v1/oauth/hello' }],
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

export const anthropicOAuthProvider: ProviderConfig = {
  host: 'api.anthropic.com',
  displayName: 'Anthropic (OAuth)',
  allowedEndpoints: [
    ...anthropicProvider.allowedEndpoints,
    // OAuth-only: usage data requires an OAuth session
    { method: 'GET' as const, path: '/api/oauth/usage' },
  ],
  keyInjection: { type: 'bearer' },
  fakeKeyPrefix: 'sk-ant-oat01-ironcurtain-',
  requestRewriter: stripServerSideTools,
  rewriteEndpoints: ['/v1/messages'],
};

export const claudePlatformOAuthProvider: ProviderConfig = {
  host: 'platform.claude.com',
  displayName: 'Claude Platform (OAuth)',
  allowedEndpoints: claudePlatformProvider.allowedEndpoints,
  keyInjection: { type: 'bearer' },
  fakeKeyPrefix: 'sk-ant-oat01-ironcurtain-',
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
