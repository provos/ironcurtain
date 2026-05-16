/**
 * LLM API provider configuration for the MITM proxy.
 *
 * Each provider defines its host, allowed endpoints, key injection method,
 * and fake key prefix. The proxy uses these to filter requests and swap
 * sentinel keys for real ones.
 */

/**
 * Discriminator for the agent invoking the proxy. Set at proxy construction
 * time via `MitmProxyOptions.agentKind`. Currently the only named kind is
 * `'workflow'`, which opts the request-body rewriter into workflow-only
 * strips (e.g. removing the schedule built-in skill's tools). `undefined`
 * means standalone / interactive / unknown — no agent-kind-conditional
 * rewrites apply.
 */
export type AgentKind = 'workflow';

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
 *
 * `context.agentKind` is the kind of agent that originated the request, when
 * known. Rewriters that condition on agent kind should treat `undefined` as
 * "no agent-kind context available" and fall back to the most conservative
 * (i.e. non-stripping) behavior.
 */
export type RequestBodyRewriter = (
  body: Record<string, unknown>,
  context: { method: string; path: string; agentKind?: AgentKind },
) => RewriteResult | null;

/**
 * Upstream target for provider requests when the default API host
 * is overridden via environment variables (e.g., ANTHROPIC_BASE_URL).
 * The MITM proxy uses this to route upstream connections to a custom
 * API gateway (e.g., LiteLLM) instead of the provider's canonical host.
 */
export interface UpstreamTarget {
  /** Hostname of the upstream server. */
  readonly hostname: string;
  /** Port number of the upstream server. */
  readonly port: number;
  /** Path prefix to prepend to all request paths ('' for none). */
  readonly pathPrefix: string;
  /** Whether to use TLS for the upstream connection. */
  readonly useTls: boolean;
}

/**
 * Parses a base URL string into an UpstreamTarget.
 *
 * Supports http:// and https:// URLs. The path component becomes the
 * pathPrefix (trailing slashes stripped). Defaults to port 443 for
 * https and port 80 for http when no port is specified.
 *
 * @throws {Error} If the URL uses an unsupported protocol.
 */
export function parseUpstreamBaseUrl(baseUrl: string): UpstreamTarget {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported protocol in upstream base URL: ${parsed.protocol}`);
  }
  const useTls = parsed.protocol === 'https:';
  const defaultPort = useTls ? 443 : 80;
  const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
  const pathPrefix = parsed.pathname.replace(/\/+$/, '');

  return { hostname: parsed.hostname, port, pathPrefix, useTls };
}

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

  /**
   * Optional upstream target override. When set, the MITM proxy routes
   * requests to this target instead of the provider's canonical host.
   * Populated from environment variables (e.g., ANTHROPIC_BASE_URL).
   */
  readonly upstreamTarget?: UpstreamTarget;
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
 * Walks the Anthropic Messages API `tools` array, asking `classify` to
 * label each entry. Entries with a non-null label are removed and their
 * labels collected into `stripped`; entries returning `null` are kept.
 * Returns `null` when nothing matched, so the caller can skip serialization.
 */
function stripToolsBy(body: Record<string, unknown>, classify: (tool: unknown) => string | null): RewriteResult | null {
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const stripped: string[] = [];
  const kept: unknown[] = [];

  for (const tool of tools) {
    const label = classify(tool);
    if (label !== null) {
      stripped.push(label);
    } else {
      kept.push(tool);
    }
  }

  if (stripped.length === 0) return null;
  return { modified: { ...body, tools: kept }, stripped };
}

/**
 * Server-side tools (e.g. web_search_20250305, computer_20250124) have a
 * `type` field that is not "custom". Custom/MCP-bridged tools either have
 * no `type` field or `type: "custom"`.
 */
export function stripServerSideTools(body: Record<string, unknown>): RewriteResult | null {
  return stripToolsBy(body, (tool) => {
    if (typeof tool !== 'object' || tool === null || !('type' in tool)) return null;
    const { type } = tool as Record<string, unknown>;
    return typeof type === 'string' && type !== 'custom' ? type : null;
  });
}

/**
 * Claude Code's built-in `schedule` skill exposes `ScheduleWakeup`,
 * `CronCreate`, `CronList`, and `CronDelete`. These tools end the current
 * assistant turn expecting an external Claude Code runtime to re-fire the
 * session at the scheduled time. IronCurtain invokes `claude` as a one-shot
 * subprocess and does NOT honor those wakeups: a workflow agent that calls
 * `ScheduleWakeup` will silently end its turn (often with an empty thinking
 * block and no text), which produces no parseable `agent_status` block and
 * trips the workflow harness's missing-status guard.
 *
 * Upstream tracking: https://github.com/anthropics/claude-code/issues/53746
 * (open enhancement, no committed fix).
 */
const SCHEDULE_SKILL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ScheduleWakeup',
  'CronCreate',
  'CronList',
  'CronDelete',
]);

/**
 * Strips the schedule built-in skill's tools from the Anthropic Messages API
 * `tools` array. Filters by tool `name` (these tools arrive as custom-shaped
 * entries declared by the Claude Code CLI client, not as server-side tools).
 */
export function stripScheduleSkillTools(body: Record<string, unknown>): RewriteResult | null {
  return stripToolsBy(body, (tool) => {
    if (typeof tool !== 'object' || tool === null || !('name' in tool)) return null;
    const { name } = tool as Record<string, unknown>;
    return typeof name === 'string' && SCHEDULE_SKILL_TOOL_NAMES.has(name) ? name : null;
  });
}

/**
 * Combined rewriter for Anthropic /v1/messages requests. Always strips
 * server-side tools; additionally strips the schedule built-in skill's tools
 * when the originating agent is a workflow agent. Agent kinds other than
 * 'workflow' (including `undefined`) do not strip the schedule tools, so
 * interactive and standalone sessions are unaffected.
 */
export function anthropicRequestRewriter(
  body: Record<string, unknown>,
  context: { method: string; path: string; agentKind?: AgentKind },
): RewriteResult | null {
  const serverSide = stripServerSideTools(body);
  const afterServerSide = serverSide ? serverSide.modified : body;

  if (context.agentKind === 'workflow') {
    const scheduleStrip = stripScheduleSkillTools(afterServerSide);
    if (scheduleStrip) {
      return {
        modified: scheduleStrip.modified,
        stripped: [...(serverSide?.stripped ?? []), ...scheduleStrip.stripped],
      };
    }
  }

  return serverSide;
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
    { method: 'POST', path: '/api/event_logging/v2/batch' },
    { method: 'POST', path: '/api/eval/*' },
    // MCP marketplace
    { method: 'GET', path: '/mcp-registry/v0/servers' },
  ],
  keyInjection: { type: 'header', headerName: 'x-api-key' },
  fakeKeyPrefix: 'sk-ant-api03-ironcurtain-',
  requestRewriter: anthropicRequestRewriter,
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
  requestRewriter: anthropicRequestRewriter,
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
