/** Credential-free, harness-specific views of a selected built-in gateway. */
import { parseModelId } from './model-id.js';
import type { DockerAgent, ResolvedProviderProfile } from './user-config.js';
import {
  getGatewayDefinition,
  resolveGatewayModel,
  type GatewayProfile,
  type GatewayProtocol,
  type GatewayDefinition,
  CONSERVATIVE_MODEL_METADATA,
} from './provider-definitions.js';

export function gatewayProfile(profile: ResolvedProviderProfile | undefined): GatewayProfile | undefined {
  return profile?.type === 'native' ? undefined : profile;
}

export interface GatewayRoute {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly baseUrl: string;
}

export function resolveGatewayRoute(
  profile: GatewayProfile,
  protocol: GatewayProtocol,
  definition = getGatewayDefinition(profile.type),
): GatewayRoute {
  return {
    id: definition.id,
    label: definition.label,
    host: definition.host,
    baseUrl: definition.baseUrls(profile)[protocol],
  };
}

function clientModel(
  profile: GatewayProfile,
  definition: GatewayDefinition,
  protocol: GatewayProtocol,
  agent: DockerAgent,
  requested?: string,
): string | undefined {
  const policy = definition.clientModels[protocol];
  if (policy === 'omit') return undefined;
  const fallback = definition.defaultModel(profile);
  const selection = resolveGatewayModel(
    profile,
    policy === 'profile-default' ? fallback : requested,
    {
      agent,
      fallback: policy === 'requested-or-default' ? fallback : undefined,
    },
    definition,
  );
  // Proxy-owned routes receive fresh request IDs. Feeding selected IDs back
  // into the proxy would turn A→B, B→C into two mappings of the same request.
  return definition.modelSelection === 'client'
    ? selection.selected
    : selection.source === 'default'
      ? fallback
      : selection.requested;
}

export function resolveMessagesClient(
  profile: GatewayProfile,
  requested?: string,
  definition = getGatewayDefinition(profile.type),
) {
  const aliases: Record<string, string> = {};
  for (const tier of ['SONNET', 'OPUS', 'HAIKU']) {
    const selection = resolveGatewayModel(
      profile,
      `claude-${tier.toLowerCase()}`,
      { agent: 'claude-code' },
      definition,
    );
    if (definition.aliasFallback === 'requested' || selection.source === 'map' || selection.source === 'per-agent')
      aliases[tier] = definition.modelSelection === 'client' ? selection.selected : selection.requested;
  }
  return {
    route: resolveGatewayRoute(profile, 'messages', definition),
    model: clientModel(profile, definition, 'messages', 'claude-code', requested),
    aliases,
  };
}

export function resolveResponsesClient(
  profile: GatewayProfile,
  requested?: string,
  definition = getGatewayDefinition(profile.type),
) {
  const model = clientModel(profile, definition, 'responses', 'codex', requested);
  if (model === undefined) throw new Error(`${definition.label} requires a Responses model selection.`);
  const selectedModel =
    definition.modelSelection === 'proxy'
      ? resolveGatewayModel(profile, model, { agent: 'codex', wireId: true }, definition).selected
      : model;
  const catalogModels = definition.codex.catalog
    ? [
        ...new Set([
          model,
          ...(definition.modelSelection === 'client'
            ? [
                definition.defaultModel(profile),
                ...profile.modelMap.map((rule) => rule.model),
                ...Object.values(profile.perAgent).filter((id) => id !== undefined),
              ]
            : []),
        ]),
      ]
    : undefined;
  return {
    route: resolveGatewayRoute(profile, 'responses', definition),
    model,
    environmentModel: definition.modelSelection === 'client' ? model : undefined,
    ...definition.codex,
    selectedModel,
    catalogModels: catalogModels?.map((id) => ({
      id,
      ...(definition.models?.[id === model ? selectedModel : id] ??
        definition.defaultModelMetadata ??
        CONSERVATIVE_MODEL_METADATA),
    })),
  };
}

export function resolveChatClient(
  profile: GatewayProfile,
  requested?: string,
  definition = getGatewayDefinition(profile.type),
) {
  const model = clientModel(profile, definition, 'chat', 'goose', requested);
  if (model === undefined) throw new Error(`${definition.label} requires a Chat model selection.`);
  return {
    route: resolveGatewayRoute(profile, 'chat', definition),
    model,
    ...definition.goose,
  };
}

/** Resolve each command afresh using the session's selected profile. Proxy-owned requests retain their IDs. */
export function resolveGatewayCommandModel(
  profile: ResolvedProviderProfile | undefined,
  requested: string,
  agent: DockerAgent,
): string | undefined {
  const gateway = gatewayProfile(profile);
  if (!gateway) return undefined;
  const definition = getGatewayDefinition(gateway.type);
  if (definition.modelSelection === 'proxy') return parseModelId(requested).modelId;
  return resolveGatewayModel(gateway, requested, { agent }, definition).selected;
}
