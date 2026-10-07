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

import type { DockerAgent, ResolvedOpenRouterProfile } from '../config/user-config.js';
import type { ProviderConfig, RequestBodyRewriter } from './provider-config.js';
import type { AuthMethod } from './oauth-credentials.js';
import type { IronCurtainConfig } from '../config/types.js';

import type { GatewayProfile } from '../config/provider-definitions.js';
import { makeGatewayProvider, makeGatewayRequestRewriter } from './gateway-runtime.js';
export { globToRegExp, resolveMappedModel } from '../config/model-mapping.js';

/** Compatibility exports for existing callers; routing and endpoint policy have one shared implementation. */
export const ANTHROPIC_ONLY_BETA_FIELDS: readonly string[] = ['context_management'];
export interface OpenRouterRewriterConfig {
  readonly modelMap: readonly { match: string; model: string }[];
  readonly perAgentDefault: string | undefined;
  readonly providerPreference:
    { order?: readonly string[]; only?: readonly string[]; allowFallbacks?: boolean } | undefined;
  readonly sessionAffinity: boolean;
}

function rewriterProfile(cfg: OpenRouterRewriterConfig): GatewayProfile {
  return {
    type: 'openrouter',
    apiKey: '',
    usesDefaultMap: false,
    modelMap: cfg.modelMap,
    perAgent: { 'claude-code': cfg.perAgentDefault, codex: undefined, goose: undefined },
    providerPreference: cfg.providerPreference,
    sessionAffinity: cfg.sessionAffinity,
  };
}

export function makeOpenRouterRewriter(cfg: OpenRouterRewriterConfig): RequestBodyRewriter {
  return makeGatewayRequestRewriter(rewriterProfile(cfg), 'messages', 'claude-code');
}

export function makeOpenRouterProviderForProfile(
  kind: OpenRouterEndpointKind,
  profile: ResolvedOpenRouterProfile,
  agentId: DockerAgent,
): ProviderConfig {
  return makeGatewayProvider(profile, kind, agentId);
}

export type OpenRouterEndpointKind = 'messages' | 'chat' | 'responses';
export type OpenRouterWireFormat = 'anthropic' | 'responses' | 'chat';

/** Classification remains independent of routing and authorization. */
export function openRouterWireForPath(path?: string): OpenRouterWireFormat {
  const p = (path ?? '').split('?')[0];
  if (p.endsWith('/messages')) return 'anthropic';
  if (p.endsWith('/responses')) return 'responses';
  return 'chat';
}

export function makeOpenRouterProvider(kind: OpenRouterEndpointKind, rewriter: RequestBodyRewriter): ProviderConfig {
  return makeGatewayProvider(
    rewriterProfile({
      modelMap: [],
      perAgentDefault: undefined,
      providerPreference: undefined,
      sessionAffinity: false,
    }),
    kind,
    'claude-code',
    undefined,
    [],
    rewriter,
  );
}

// --- 7.5 Credential resolution ---

/**
 * The OpenRouter credential for a session whose active profile routes through
 * OpenRouter: an api-key {@link AuthMethod} when the profile carries a non-empty
 * key, or `{ kind: 'none' }` when the key is empty (which feeds infra prep's
 * clear no-credentials error, m5). Returns `undefined` for a native or unset
 * profile so each adapter's `detectCredential` DEFERS to its own agent-native
 * detection, preserving today's behavior byte-for-byte. Centralizes the
 * empty-key contract that would otherwise be re-branched identically in every
 * adapter (§9.6).
 */
export function openRouterCredential(config: IronCurtainConfig): AuthMethod | undefined {
  const profile = config.activeProviderProfile;
  if (profile?.type !== 'openrouter') return undefined;
  return profile.apiKey !== '' ? { kind: 'apikey', key: profile.apiKey } : { kind: 'none' };
}
