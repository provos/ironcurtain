import type { DockerAgent, ResolvedZaiProfile } from './user-config.js';
import { resolveMappedModel } from './model-mapping.js';
import { parseModelId } from './model-id.js';

export const ZAI_HOST = 'api.z.ai';
export const ZAI_DEFAULT_MODEL = 'glm-5.3';

/** Full SDK/client bases, kept separate because the protocols use different roots. */
export function zaiBaseUrls(plan: ResolvedZaiProfile['plan']) {
  return {
    messages: `https://${ZAI_HOST}/api/anthropic`,
    chat: `https://${ZAI_HOST}/api/${plan === 'coding' ? 'coding/' : ''}paas/v4`,
    responses: `https://${ZAI_HOST}/api/v1`,
  };
}

export function resolveZaiModel(profile: ResolvedZaiProfile, requested?: string, agent?: DockerAgent): string {
  const perAgent = agent === undefined ? undefined : profile.perAgent[agent];
  const model = requested ? parseModelId(requested).modelId : profile.model;
  return perAgent ?? resolveMappedModel(model, profile.modelMap) ?? model;
}
