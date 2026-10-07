/** Host-only proxy integration for built-in protocol-compatible gateways. */
import type { DockerAgent } from '../config/user-config.js';
import type { IronCurtainConfig } from '../config/types.js';
import {
  getGatewayDefinition,
  resolveGatewayModel,
  type GatewayProfile,
  type GatewayProtocol,
} from '../config/provider-definitions.js';
import { cloneProviderPreference } from '../config/provider-preference.js';
import { gatewayProfile } from '../config/gateway-client.js';
import { anthropicRequestRewriter } from './provider-config.js';
import type { ProviderConfig, RequestBodyRewriter } from './provider-config.js';
import type { AuthMethod } from './oauth-credentials.js';

/** Auxiliary IDs are harness facts, not provider facts. Main client selections are never remapped. */
export function makeGatewayRequestRewriter(
  profile: GatewayProfile,
  protocol: GatewayProtocol,
  agent: DockerAgent,
  definition = getGatewayDefinition(profile.type),
  auxiliaryModels: readonly string[] = [],
): RequestBodyRewriter {
  return (body, context) => {
    if (definition.modelSelection === 'proxy' && typeof body.model !== 'string') return null;
    const filtered =
      protocol === 'messages' && definition.filterMessagesTools ? anthropicRequestRewriter(body, context) : null;
    const current = filtered?.modified ?? body;
    const modified = { ...current };
    const stripped = [...(filtered?.stripped ?? [])];
    if (typeof current.model === 'string') {
      const isAuxiliary = auxiliaryModels.includes(current.model);
      const model =
        definition.modelSelection === 'proxy' || isAuxiliary
          ? resolveGatewayModel(
              profile,
              current.model,
              {
                agent,
                wireId: true,
                fallback:
                  isAuxiliary && definition.modelSelection === 'client' ? definition.defaultModel(profile) : undefined,
              },
              definition,
            ).selected
          : current.model;
      if (model !== current.model) {
        modified.model = model;
        stripped.push(`model:${model}`);
      }
      const prefix = definition.sessionAffinityModelPrefix;
      if (
        profile.sessionAffinity &&
        prefix &&
        model.startsWith(prefix) &&
        context.cacheKey &&
        modified.session_id === undefined
      ) {
        const sessionId = `${context.cacheKey}:${current.model}`.slice(0, 256);
        modified.session_id = sessionId;
        stripped.push(`session_id:${sessionId.slice(0, 8)}`);
      }
      const fields = definition.requestFields?.(profile, model);
      for (const [key, value] of Object.entries(fields?.body ?? {})) {
        if (modified[key] !== undefined) continue;
        modified[key] = value;
        stripped.push(fields?.auditLabels[key] ?? key);
      }
    }
    if (definition.stripContextManagementOn.includes(protocol) && 'context_management' in modified) {
      delete modified.context_management;
      stripped.push(
        protocol === 'messages' && definition.modelSelection === 'client'
          ? 'context_management'
          : 'beta:context_management',
      );
    }
    return stripped.length ? { modified, stripped } : null;
  };
}

/** Copy routing facts for this session, while native OAuth refresh remains outside this snapshot. */
function routingSnapshot(profile: GatewayProfile): GatewayProfile {
  return {
    ...profile,
    apiKey: '',
    modelMap: profile.modelMap.map((rule) => ({ ...rule })),
    perAgent: { ...profile.perAgent },
    providerPreference: profile.providerPreference && cloneProviderPreference(profile.providerPreference),
  };
}

export function makeGatewayProvider(
  profile: GatewayProfile,
  protocol: GatewayProtocol,
  agent: DockerAgent,
  definition = getGatewayDefinition(profile.type),
  auxiliaryModels: readonly string[] = [],
  rewriter?: RequestBodyRewriter,
): ProviderConfig {
  const snapshot = routingSnapshot(profile);
  const paths = definition.proxyPaths(snapshot)[protocol];
  const path = paths.completion;
  return {
    id: definition.id,
    host: definition.host,
    displayName: `${definition.label} (${protocol}${definition.editor.plan ? `, ${snapshot.plan}` : ''})`,
    keyInjection: definition.keyInjection,
    fakeKeyPrefix: definition.fakeKeyPrefix,
    gatewayAdapterId: definition.id,
    allowedEndpoints: [{ method: 'POST', path }, ...paths.additional],
    captureEndpoints: [{ method: 'POST', path }],
    completionEndpoints: [
      {
        method: 'POST',
        path,
        protocol:
          protocol === 'messages'
            ? 'anthropic-messages'
            : protocol === 'responses'
              ? 'openai-responses'
              : 'openai-chat-completions',
        capabilities: {
          metricsSupport: protocol === 'chat' ? 'partial' : 'full',
          streamingUsageNegotiation: protocol === 'chat' ? 'client_or_agent_adapter' : 'none',
          trajectoryCapture: true,
        },
      },
    ],
    rewriteEndpoints: [path],
    requestRewriter: rewriter ?? makeGatewayRequestRewriter(snapshot, protocol, agent, definition, auxiliaryModels),
  };
}

export function gatewayProviders(
  config: IronCurtainConfig,
  protocol: GatewayProtocol,
  agent: DockerAgent,
  auxiliaryModels: readonly string[] = [],
): readonly ProviderConfig[] | undefined {
  const profile = gatewayProfile(config.activeProviderProfile);
  return profile && [makeGatewayProvider(profile, protocol, agent, undefined, auxiliaryModels)];
}

/** Keys remain in host auth resolution. Client-binding functions never return them. */
export function gatewayCredential(config: IronCurtainConfig): AuthMethod | undefined {
  const profile = gatewayProfile(config.activeProviderProfile);
  if (!profile) return undefined;
  getGatewayDefinition(profile.type);
  return profile.apiKey ? { kind: 'apikey', key: profile.apiKey } : { kind: 'none' };
}

export function gatewaySentinel(fakeKeys: ReadonlyMap<string, string>, host: string): string {
  const key = fakeKeys.get(host);
  if (!key) throw new Error(`No fake key generated for ${host}`);
  return key;
}
