/**
 * LLM API provider configuration for the MITM proxy.
 *
 * Each provider defines its host, allowed endpoints, key injection method,
 * and fake key prefix. The proxy uses these to filter requests and swap
 * sentinel keys for real ones.
 */

import { isPlainObject } from '../utils/is-plain-object.js';

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
  context: {
    method: string;
    path: string;
    agentKind?: AgentKind;
    /**
     * Stable per-conversation id used for OpenRouter `session_id` injection
     * (GLM cache affinity, D4). Set from the proxy's `tokenSessionId` snapshot.
     * All existing rewriters ignore it (backward-compatible).
     */
    cacheKey?: string;
  },
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
   * Endpoints whose exchanges are training-relevant and may be recorded by
   * the trajectory-capture pipeline. Same matcher shape as
   * `allowedEndpoints` (method + path glob, query string stripped before
   * matching). This is an ALLOWLIST: only completion endpoints belong here
   * (e.g. Anthropic `/v1/messages`, OpenAI Responses `/v1/responses`). The
   * large volume of host-shared housekeeping traffic (MCP-registry
   * pagination, telemetry batches, settings/eval pings) is deliberately
   * excluded so it never pollutes the captured corpus.
   *
   * Absent or empty means "capture nothing" — custom/unlisted providers do
   * not accidentally capture. See `isCapturableEndpoint` and §3 integration
   * point 4 of docs/designs/mitm-token-trajectory-capture.md.
   */
  readonly captureEndpoints?: readonly EndpointPattern[];

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
 * Returns true if `method`+`path` matches any pattern in `patterns`.
 * Path is normalized by stripping the query string; glob patterns ('*')
 * match exactly one path segment. Shared by `isEndpointAllowed` (forwarding
 * allowlist) and `isCapturableEndpoint` (capture allowlist).
 */
function matchesEndpoint(
  patterns: readonly EndpointPattern[],
  method: string | undefined,
  path: string | undefined,
): boolean {
  if (!method || !path) return false;
  const cleanPath = path.split('?')[0]; // strip query string

  return patterns.some((ep) => {
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

/**
 * Checks whether a request method+path is in the provider's forwarding
 * allowlist. Requests not matching any pattern get a 403.
 */
export function isEndpointAllowed(
  config: ProviderConfig,
  method: string | undefined,
  path: string | undefined,
): boolean {
  return matchesEndpoint(config.allowedEndpoints, method, path);
}

/**
 * Checks whether a request method+path is training-relevant and therefore
 * eligible for trajectory capture. Gated on the provider's `captureEndpoints`
 * allowlist (completion paths only). Returns false when `captureEndpoints` is
 * absent or empty, so capture is opt-in per provider and unlisted/custom
 * providers never record. Strictly subtractive — a false result skips the
 * capture branch and leaves the forwarding path untouched. See §3 integration
 * point 4 of docs/designs/mitm-token-trajectory-capture.md.
 */
export function isCapturableEndpoint(
  config: ProviderConfig,
  method: string | undefined,
  path: string | undefined,
): boolean {
  if (!config.captureEndpoints || config.captureEndpoints.length === 0) return false;
  return matchesEndpoint(config.captureEndpoints, method, path);
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

const FUNCTION_BLOCK_PATTERN = /<function>([\s\S]*?)<\/function>\s*/g;
const FUNCTION_BLOCK_NAME_PATTERN = /"name"\s*:\s*"([^"]+)"/;

/**
 * Walks `body.messages[].content[].tool_result.content[]` and removes
 * references to schedule-skill tools that `stripScheduleSkillTools` strips
 * from the outgoing `tools` array. Two leakage paths are scrubbed:
 * `{type:"tool_reference", tool_name:"<stripped>"}` entries from ToolSearch
 * keyword/`select:` results, and `<function>{"name":"<stripped>",...}</function>`
 * schema blocks from `select:` results that load a full tool schema.
 *
 * Necessary because removing a tool from `tools` does NOT remove dangling
 * references already recorded in conversation history. Anthropic 400s the
 * next request with "Tool reference 'X' not found in available tools" if
 * any such reference survives, and Claude Code records that 400 as a
 * synthetic assistant turn it cannot recover from — wedging the session.
 */
export function stripScheduleSkillToolReferences(body: Record<string, unknown>): RewriteResult | null {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const stripped: string[] = [];
  const newMessages: unknown[] = [];

  for (const rawMsg of messages as unknown[]) {
    const result = rewriteMessageContent(rawMsg);
    if (result === null) {
      newMessages.push(rawMsg);
      continue;
    }
    newMessages.push(result.value);
    stripped.push(...result.labels);
  }

  if (stripped.length === 0) return null;
  return { modified: { ...body, messages: newMessages }, stripped };
}

interface Rewrite {
  readonly value: Record<string, unknown>;
  readonly labels: readonly string[];
}

function rewriteMessageContent(rawMsg: unknown): Rewrite | null {
  if (!isPlainObject(rawMsg)) return null;
  const content = rawMsg.content;
  if (!Array.isArray(content)) return null;

  const labels: string[] = [];
  const newContent: unknown[] = [];
  let changed = false;

  for (const rawBlock of content as unknown[]) {
    const result = rewriteToolResultBlock(rawBlock);
    if (result === null) {
      newContent.push(rawBlock);
      continue;
    }
    newContent.push(result.value);
    labels.push(...result.labels);
    changed = true;
  }

  if (!changed) return null;
  return { value: { ...rawMsg, content: newContent }, labels };
}

function rewriteToolResultBlock(rawBlock: unknown): Rewrite | null {
  if (!isPlainObject(rawBlock)) return null;
  if (rawBlock.type !== 'tool_result') return null;
  const innerContent = rawBlock.content;
  if (!Array.isArray(innerContent)) return null;

  const labels: string[] = [];
  const keptInner: unknown[] = [];
  let changed = false;

  for (const rawEntry of innerContent as unknown[]) {
    const result = scrubToolResultEntry(rawEntry);
    if (result === null) {
      keptInner.push(rawEntry);
      continue;
    }
    if (result.kind !== 'drop') {
      keptInner.push(result.value);
    }
    labels.push(...result.labels);
    changed = true;
  }

  if (!changed) return null;
  // Empty tool_result.content arrays are accepted by the Anthropic API,
  // but a deterministic placeholder makes the scrub visible to the agent
  // and avoids depending on that acceptance.
  const finalInner = keptInner.length > 0 ? keptInner : [{ type: 'text', text: '(filtered)' }];
  return { value: { ...rawBlock, content: finalInner }, labels };
}

type EntryResult =
  | { readonly kind: 'drop'; readonly labels: readonly string[] }
  | { readonly kind: 'replace'; readonly value: Record<string, unknown>; readonly labels: readonly string[] };

function scrubToolResultEntry(rawEntry: unknown): EntryResult | null {
  if (!isPlainObject(rawEntry)) return null;

  if (rawEntry.type === 'tool_reference' && typeof rawEntry.tool_name === 'string') {
    if (!SCHEDULE_SKILL_TOOL_NAMES.has(rawEntry.tool_name)) return null;
    return { kind: 'drop', labels: [`tool_reference:${rawEntry.tool_name}`] };
  }

  if (rawEntry.type === 'text' && typeof rawEntry.text === 'string') {
    // Fast-path: most tool_result text is tool output, not ToolSearch results.
    if (!rawEntry.text.includes('<function>')) return null;
    const labels: string[] = [];
    const scrubbed = rawEntry.text.replace(FUNCTION_BLOCK_PATTERN, (match, blockBody: string) => {
      const nameMatch = FUNCTION_BLOCK_NAME_PATTERN.exec(blockBody);
      if (nameMatch && SCHEDULE_SKILL_TOOL_NAMES.has(nameMatch[1])) {
        labels.push(`function_block:${nameMatch[1]}`);
        return '';
      }
      return match;
    });
    if (labels.length === 0) return null;
    return { kind: 'replace', value: { ...rawEntry, text: scrubbed }, labels };
  }

  return null;
}

/**
 * Combined rewriter for Anthropic /v1/messages requests. Always strips
 * server-side tools; additionally strips the schedule built-in skill's tools
 * and any dangling history references to them when the originating agent is
 * a workflow agent. Agent kinds other than 'workflow' (including `undefined`)
 * do not strip the schedule tools, so interactive and standalone sessions
 * are unaffected.
 */
export function anthropicRequestRewriter(
  body: Record<string, unknown>,
  context: { method: string; path: string; agentKind?: AgentKind },
): RewriteResult | null {
  const serverSide = stripServerSideTools(body);
  let current = serverSide ? serverSide.modified : body;
  const stripped: string[] = serverSide ? [...serverSide.stripped] : [];

  if (context.agentKind === 'workflow') {
    const toolsStrip = stripScheduleSkillTools(current);
    if (toolsStrip) {
      current = toolsStrip.modified;
      stripped.push(...toolsStrip.stripped);
    }
    const historyStrip = stripScheduleSkillToolReferences(current);
    if (historyStrip) {
      current = historyStrip.modified;
      stripped.push(...historyStrip.stripped);
    }
  }

  if (stripped.length === 0) return null;
  return { modified: current, stripped };
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
  // Capture only the completion endpoint; the housekeeping paths above
  // (settings, telemetry, eval, registry) carry no model-emitted content.
  captureEndpoints: [{ method: 'POST', path: '/v1/messages' }],
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
    // The Responses API is the path modern OpenAI agents (incl. Codex with an
    // API key) use; /v1/chat/completions is kept for goose's OpenAI provider.
    { method: 'POST', path: '/v1/responses' },
    { method: 'POST', path: '/v1/chat/completions' },
    { method: 'GET', path: '/v1/models' },
  ],
  // Capture only the Responses API: it shares the chatgpt.com wire format and
  // is reassembled by ResponsesReassembler (createReassembler routes
  // api.openai.com → ResponsesReassembler). /v1/chat/completions is NOT
  // captured — no harness uses it and there is no chat-completions reassembler.
  captureEndpoints: [{ method: 'POST', path: '/v1/responses' }],
  keyInjection: { type: 'bearer' },
  fakeKeyPrefix: 'sk-ironcurtain-',
};

export const codexChatGptProvider: ProviderConfig = {
  host: 'chatgpt.com',
  displayName: 'ChatGPT Codex',
  allowedEndpoints: [
    { method: 'GET', path: '/agent-identities/jwks' },
    { method: 'GET', path: '/wham/agent-identities/jwks' },
    { method: 'GET', path: '/codex-backend/agent-identity' },
    { method: 'POST', path: '/codex-backend/agent-identity' },
    // backend-api allowlist — least-privilege, enumerated from live Codex CLI
    // 0.139.0 runs (a simple completion and a file-edit-plus-shell task) through
    // this proxy. Exact paths only (no wildcard) so the real ChatGPT OAuth token
    // is forwarded to exactly the endpoints Codex needs and nothing else.
    //
    // (a) The only functionally required backend-api calls observed are
    //     GET /backend-api/codex/models and GET+POST /backend-api/codex/responses
    //     (the completion stream); sessions complete with these alone.
    // (b) REPLACES a prior `/backend-api/codex/*` single-segment wildcard, which
    //     would also have forwarded the token to unrelated future sub-surfaces.
    // (c) Intentionally still blocked (Codex attempts them; runs are unaffected):
    //     POST /backend-api/codex/analytics-events/events (telemetry),
    //     GET /backend-api/plugins/*, GET /backend-api/ps/plugins/installed,
    //     POST /backend-api/wham/apps (plugin/app marketplace). None are needed
    //     for headless exec; blocking them keeps egress minimal.
    // (d) If a future Codex version 403s on a path it genuinely needs, add that
    //     specific exact path here — do NOT re-introduce a wildcard.
    { method: 'GET', path: '/backend-api/codex/models' },
    { method: 'GET', path: '/backend-api/codex/responses' },
    { method: 'POST', path: '/backend-api/codex/responses' },
  ],
  // The completion call Codex streams is POST /backend-api/codex/responses
  // (verified against a live codex exec run). chatgpt.com classifies as the
  // 'openai' capture provider and is reassembled by ResponsesReassembler
  // against the named-event Responses stream (response.* events; terminal
  // response.completed). The ~7 GET /backend-api/codex/responses calls are
  // polling/resume that return application/json state, not a fresh
  // generation, and are GETs — so they never match this POST capture gate.
  captureEndpoints: [{ method: 'POST', path: '/backend-api/codex/responses' }],
  keyInjection: { type: 'bearer' },
  // Codex expects ChatGPT access tokens to be JWT-shaped in auth.json.
  // Keep the fake credential structurally valid so local parsing passes,
  // then swap it host-side before forwarding upstream.
  fakeKeyPrefix:
    'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjQxMDI0NDQ4MDAsImlzcyI6Imlyb25jdXJ0YWluIiwic3ViIjoiY29kZXgtZmFrZSJ9.',
};

export const codexAuthProvider: ProviderConfig = {
  host: 'auth.openai.com',
  displayName: 'OpenAI Auth',
  allowedEndpoints: [{ method: 'GET', path: '/api/accounts/v1/user-auth-credential/whoami' }],
  keyInjection: { type: 'bearer' },
  fakeKeyPrefix: codexChatGptProvider.fakeKeyPrefix,
};

export const anthropicOAuthProvider: ProviderConfig = {
  host: 'api.anthropic.com',
  displayName: 'Anthropic (OAuth)',
  allowedEndpoints: [
    ...anthropicProvider.allowedEndpoints,
    // OAuth-only: usage data requires an OAuth session
    { method: 'GET' as const, path: '/api/oauth/usage' },
  ],
  captureEndpoints: anthropicProvider.captureEndpoints,
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
  captureEndpoints: [
    { method: 'POST', path: '/v1beta/models/*/generateContent' },
    { method: 'POST', path: '/v1beta/models/*/streamGenerateContent' },
  ],
  keyInjection: { type: 'header', headerName: 'x-goog-api-key' },
  fakeKeyPrefix: 'AIzaSy-ironcurtain-',
};
