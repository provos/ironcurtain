import type { DockerAgent, ResolvedZaiProfile } from '../config/user-config.js';
import type { IronCurtainConfig } from '../config/types.js';
import type { AuthMethod } from './oauth-credentials.js';
import { makeGatewayProvider } from './gateway-runtime.js';
import type { ProviderConfig } from './provider-config.js';

export function zaiCredential(config: IronCurtainConfig): AuthMethod | undefined {
  const profile = config.activeProviderProfile;
  if (profile?.type !== 'zai') return undefined;
  return profile.apiKey ? { kind: 'apikey', key: profile.apiKey } : { kind: 'none' };
}

export function makeZaiProvider(profile: ResolvedZaiProfile, agent: DockerAgent): ProviderConfig {
  const protocol = agent === 'claude-code' ? 'messages' : agent === 'codex' ? 'responses' : 'chat';
  return makeGatewayProvider(profile, protocol, agent, undefined, agent === 'goose' ? ['gpt-4o-mini'] : []);
}
