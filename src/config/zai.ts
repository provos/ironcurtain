import type { DockerAgent, ResolvedZaiProfile } from './user-config.js';
import {
  getGatewayDefinition,
  resolveGatewayModel,
  GLM_DEFAULT_MODEL,
  GLM_FLASH_MODEL,
} from './provider-definitions.js';

export const ZAI_HOST = getGatewayDefinition('zai').host;
export const ZAI_DEFAULT_MODEL = GLM_DEFAULT_MODEL;
export const ZAI_DEFAULT_FLASH_MODEL = GLM_FLASH_MODEL;

/** Full SDK/client bases, kept separate because the protocols use different roots. */
export function zaiBaseUrls(plan: ResolvedZaiProfile['plan']) {
  return getGatewayDefinition('zai').baseUrls({ type: 'zai', plan });
}

export function resolveZaiModel(profile: ResolvedZaiProfile, requested?: string, agent?: DockerAgent): string {
  return resolveGatewayModel(profile, requested, { agent }).selected;
}
