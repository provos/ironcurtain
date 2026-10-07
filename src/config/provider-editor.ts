/** Fixed editor fields shared by built-in providers. Persistence still uses the validated profile schema. */
import type { GatewayProfile, ProviderEditorDescriptor } from './provider-definitions.js';
import { cloneProviderPreference } from './provider-preference.js';
import { getGatewayDefinition } from './provider-definitions.js';

export interface GatewayProfileInput {
  type: string;
  apiKey?: string;
  plan?: string;
  model?: string;
  modelMap?: { match: string; model: string }[];
  perAgent?: Record<string, string | undefined>;
  providerPreference?: { order?: string[]; only?: string[]; allowFallbacks?: boolean };
  sessionAffinity?: boolean;
}

/** Project only controls supported by this provider; omitted maps and explicit [] remain distinct. */
export function resolvedGatewayToInput(
  profile: GatewayProfile,
  descriptor: ProviderEditorDescriptor = getGatewayDefinition(profile.type).editor,
): GatewayProfileInput {
  const perAgent = Object.fromEntries(Object.entries(profile.perAgent).filter(([, value]) => value !== undefined));
  return {
    type: profile.type,
    ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
    ...(profile.usesDefaultMap ? {} : { modelMap: profile.modelMap.map((rule) => ({ ...rule })) }),
    ...(Object.keys(perAgent).length ? { perAgent } : {}),
    ...(descriptor.model ? { model: profile.model } : {}),
    ...(descriptor.plan ? { plan: profile.plan } : {}),
    ...(descriptor.providerRouting && profile.providerPreference
      ? {
          providerPreference: cloneProviderPreference(profile.providerPreference),
        }
      : {}),
    ...(descriptor.sessionAffinity ? { sessionAffinity: profile.sessionAffinity } : {}),
  };
}
