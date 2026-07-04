/**
 * OpenRouter transform logic for Docker Agent Mode.
 *
 * Encapsulates all OpenRouter-specific request transformation (per CLAUDE.md
 * "encapsulate risky operations"): glob model mapping, the MITM request-body
 * rewriter (model remap + `session_id` injection + provider pin + beta-field
 * strip), and the per-agent `ProviderConfig` factory. Adapters and the infra
 * bundle depend on this module, never on inline logic.
 *
 * See docs/designs/openrouter-integration.md §7.
 */

import { OPENROUTER_HOST } from '../config/user-config.js';
import type { DockerAgent, ResolvedOpenRouterProfile } from '../config/user-config.js';
import type { EndpointPattern, ProviderConfig, RequestBodyRewriter, RewriteResult } from './provider-config.js';

// --- 7.1 Glob resolution ---

/** Regex metacharacters that must be escaped in a glob literal (all but `*`). */
const REGEX_METACHARS = /[.+?^${}()|[\]\\]/g;

/**
 * Memoized compiled globs. `resolveMappedModel` runs on every rewritten request
 * (and in env-hint paths), so compiling the same handful of `modelMap` patterns
 * on each lookup is wasted work. Patterns originate from config (finite, small),
 * so the cache is effectively bounded.
 */
const GLOB_REGEX_CACHE = new Map<string, RegExp>();

/**
 * Compiles a `modelMap` glob to a RegExp anchored full-string,
 * case-insensitive. `*` becomes `.*`; every other regex metacharacter is
 * escaped so a literal `.` in e.g. `gpt-4.1` is not treated as a wildcard.
 * Results are memoized since this runs on every rewritten request.
 */
export function globToRegExp(glob: string): RegExp {
  const cached = GLOB_REGEX_CACHE.get(glob);
  if (cached) return cached;
  const escaped = glob.replace(REGEX_METACHARS, '\\$&').replace(/\*/g, '.*');
  const compiled = new RegExp(`^${escaped}$`, 'i');
  GLOB_REGEX_CACHE.set(glob, compiled);
  return compiled;
}

/**
 * Resolves the OpenRouter slug for a requested model id under an ordered map.
 * First matching rule wins. Returns `undefined` when nothing matches.
 *
 * Per D1, the CALLER resolves the final slug as
 * `perAgentDefault ?? resolveMappedModel(...) ?? <passthrough>` — an
 * agent-specific perAgent default takes precedence over a glob match; this
 * function performs only the glob lookup.
 */
export function resolveMappedModel(
  requestedModelId: string,
  modelMap: readonly { match: string; model: string }[],
): string | undefined {
  for (const rule of modelMap) {
    if (globToRegExp(rule.match).test(requestedModelId)) return rule.model;
  }
  return undefined;
}

// --- 7.3 The OpenRouter rewriter ---

/** Top-level fields Anthropic clients may send that non-Anthropic upstreams reject. */
export const ANTHROPIC_ONLY_BETA_FIELDS: readonly string[] = ['context_management'];

/** Maximum length of an injected OpenRouter `session_id` (D4). */
const SESSION_ID_MAX_LENGTH = 256;

export interface OpenRouterRewriterConfig {
  readonly modelMap: readonly { match: string; model: string }[];
  readonly perAgentDefault: string | undefined;
  readonly providerPreference:
    | { order?: readonly string[]; only?: readonly string[]; allowFallbacks?: boolean }
    | undefined;
  readonly sessionAffinity: boolean;
}

/** A GLM-family slug requires z.ai first-party endpoint affinity (D3/D4). */
function isGlmSlug(slug: string): boolean {
  return slug.startsWith('z-ai/');
}

/** Serializes a provider preference to the wire shape (snake_case `allow_fallbacks`). */
function providerPreferenceToWire(pref: {
  order?: readonly string[];
  only?: readonly string[];
  allowFallbacks?: boolean;
}): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  if (pref.order !== undefined) wire.order = [...pref.order];
  if (pref.only !== undefined) wire.only = [...pref.only];
  if (pref.allowFallbacks !== undefined) wire.allow_fallbacks = pref.allowFallbacks;
  return wire;
}

/**
 * Builds a RequestBodyRewriter for an OpenRouter completion request. Steps
 * (§7.3):
 *  0. Non-string `body.model` -> return null (no-op, m7).
 *  1. Capture `requestedModelId = body.model`, remap `model` to
 *     `perAgentDefault ?? resolveMappedModel(...) ?? requestedModelId`
 *     (perAgent WINS over the glob map, D1/D2).
 *  2. Inject `session_id = `${cacheKey}:${requestedModelId}`` truncated to 256
 *     when sessionAffinity, the mapped slug is `z-ai/*`, cacheKey is present,
 *     and `session_id` is absent. Deterministic (D4).
 *  3. Inject `provider` when the body has none: the configured preference
 *     (replaces the default) if set, else the D3 default soft pin
 *     `{ order: ["z-ai"] }` for a `z-ai/*` mapped slug.
 *  4. Strip ANTHROPIC_ONLY_BETA_FIELDS.
 *  5. Never touch `cache_control` blocks inside messages.
 * Returns null when nothing changed (caller skips re-serialization).
 */
export function makeOpenRouterRewriter(cfg: OpenRouterRewriterConfig): RequestBodyRewriter {
  return (body, context) => {
    // Step 0: m7 no-op on a non-string model.
    if (typeof body.model !== 'string') return null;

    const requestedModelId = body.model;
    const stripped: string[] = [];
    const modified: Record<string, unknown> = { ...body };

    // Step 1: model remap (D1/D2 precedence).
    const slug = cfg.perAgentDefault ?? resolveMappedModel(requestedModelId, cfg.modelMap) ?? requestedModelId;
    if (slug !== requestedModelId) {
      modified.model = slug;
      stripped.push(`model:${slug}`);
    }

    // Step 2: session_id injection (D4).
    if (cfg.sessionAffinity && isGlmSlug(slug) && context.cacheKey && modified.session_id === undefined) {
      const sessionId = `${context.cacheKey}:${requestedModelId}`.slice(0, SESSION_ID_MAX_LENGTH);
      modified.session_id = sessionId;
      stripped.push(`session_id:${sessionId.slice(0, 8)}`);
    }

    // Step 3: provider injection (D3). Never overwrite an existing `provider`.
    if (modified.provider === undefined) {
      if (cfg.providerPreference !== undefined) {
        modified.provider = providerPreferenceToWire(cfg.providerPreference);
        stripped.push('provider:pin');
      } else if (isGlmSlug(slug)) {
        modified.provider = { order: ['z-ai'] };
        stripped.push('provider:default-z-ai');
      }
    }

    // Step 4: strip Anthropic-only beta fields (cache_control is left intact — step 5).
    // Rebuild without the denylisted top-level keys (avoids a dynamic `delete`).
    const betaToStrip = ANTHROPIC_ONLY_BETA_FIELDS.filter((field) => field in modified);
    for (const field of betaToStrip) stripped.push(`beta:${field}`);
    const finalBody =
      betaToStrip.length > 0
        ? Object.fromEntries(Object.entries(modified).filter(([key]) => !betaToStrip.includes(key)))
        : modified;

    if (stripped.length === 0) return null;
    return { modified: finalBody, stripped } satisfies RewriteResult;
  };
}

/**
 * Builds an {@link OpenRouterRewriterConfig} from a resolved openrouter
 * profile for a specific agent. `perAgentDefault` is the agent's own
 * `perAgent` override (D1: it WINS over the glob `modelMap`); `modelMap`,
 * `providerPreference`, and `sessionAffinity` are shared across agents.
 *
 * Keeping this in `openrouter.ts` (rather than duplicating the field pick in
 * each adapter) is the single place that maps the profile shape to the
 * rewriter's contract, per §9.6.
 */
export function rewriterConfigFromProfile(
  profile: ResolvedOpenRouterProfile,
  agentId: DockerAgent,
): OpenRouterRewriterConfig {
  return {
    modelMap: profile.modelMap,
    perAgentDefault: profile.perAgent[agentId],
    providerPreference: profile.providerPreference,
    sessionAffinity: profile.sessionAffinity,
  };
}

/**
 * Builds the per-agent OpenRouter provider from a resolved openrouter
 * profile: constructs the rewriter (via {@link rewriterConfigFromProfile})
 * and wires it into {@link makeOpenRouterProvider} for the agent's endpoint
 * kind. The single call site each adapter's `getProviders` needs.
 */
export function makeOpenRouterProviderForProfile(
  kind: OpenRouterEndpointKind,
  profile: ResolvedOpenRouterProfile,
  agentId: DockerAgent,
): ProviderConfig {
  const rewriter = makeOpenRouterRewriter(rewriterConfigFromProfile(profile, agentId));
  return makeOpenRouterProvider(kind, rewriter);
}

// --- 7.4 Provider config factory ---

/** Endpoint subset an agent uses on OpenRouter. */
export type OpenRouterEndpointKind = 'messages' | 'chat' | 'responses';

/** Structurally valid OpenRouter key shape; swapped host-side. */
const OPENROUTER_FAKE_KEY_PREFIX = 'sk-or-v1-ironcurtain-';

/** The single completion POST path per endpoint kind. */
const COMPLETION_PATH: Readonly<Record<OpenRouterEndpointKind, string>> = {
  messages: '/api/v1/messages',
  chat: '/api/v1/chat/completions',
  responses: '/api/v1/responses',
};

/** Allowlisted endpoints per kind (completion path + metadata + count_tokens for messages, D5). */
function allowedEndpointsFor(kind: OpenRouterEndpointKind): EndpointPattern[] {
  const endpoints: EndpointPattern[] = [{ method: 'POST', path: COMPLETION_PATH[kind] }];
  // D5: count_tokens is allowlisted (but not rewritten/captured) for the messages kind.
  if (kind === 'messages') {
    endpoints.push({ method: 'POST', path: '/api/v1/messages/count_tokens' });
  }
  // GET /api/v1/models is available on every kind (§9).
  endpoints.push({ method: 'GET', path: '/api/v1/models' });
  return endpoints;
}

/**
 * Builds the openrouterProvider for a given agent's endpoint kind and
 * rewriter. Host `openrouter.ai`; bearer key injection; fake-key prefix
 * `sk-or-v1-ironcurtain-`. The rewriter is attached to the COMPLETION POST
 * path only; count_tokens is allowlisted but neither rewritten nor captured
 * (the proxy passes through whatever OpenRouter returns, 2xx or 4xx, D5).
 */
export function makeOpenRouterProvider(kind: OpenRouterEndpointKind, rewriter: RequestBodyRewriter): ProviderConfig {
  const completionPath = COMPLETION_PATH[kind];
  return {
    host: OPENROUTER_HOST,
    displayName: `OpenRouter (${kind})`,
    allowedEndpoints: allowedEndpointsFor(kind),
    captureEndpoints: [{ method: 'POST', path: completionPath }],
    keyInjection: { type: 'bearer' },
    fakeKeyPrefix: OPENROUTER_FAKE_KEY_PREFIX,
    requestRewriter: rewriter,
    rewriteEndpoints: [completionPath],
  };
}
