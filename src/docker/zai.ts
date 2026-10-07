import type { DockerAgent, ResolvedZaiProfile } from '../config/user-config.js';
import { ZAI_HOST, resolveZaiModel, zaiBaseUrls } from '../config/zai.js';
import type { IronCurtainConfig } from '../config/types.js';
import type { AuthMethod } from './oauth-credentials.js';
import { anthropicRequestRewriter } from './provider-config.js';
import type { ProviderConfig } from './provider-config.js';

export function zaiCredential(config: IronCurtainConfig): AuthMethod | undefined {
  const profile = config.activeProviderProfile;
  if (profile?.type !== 'zai') return undefined;
  return profile.apiKey ? { kind: 'apikey', key: profile.apiKey } : { kind: 'none' };
}

export function makeZaiProvider(profile: ResolvedZaiProfile, agent: DockerAgent): ProviderConfig {
  const kind = agent === 'claude-code' ? 'messages' : agent === 'codex' ? 'responses' : 'chat';
  const root = new URL(zaiBaseUrls(profile.plan)[kind]).pathname;
  const path = `${root}/${kind === 'messages' ? 'v1/messages' : kind === 'chat' ? 'chat/completions' : 'responses'}`;
  const protocol =
    kind === 'messages' ? 'anthropic-messages' : kind === 'responses' ? 'openai-responses' : 'openai-chat-completions';
  return {
    id: 'zai',
    host: ZAI_HOST,
    displayName: `Z.AI (${kind}, ${profile.plan})`,
    keyInjection: { type: 'bearer' },
    fakeKeyPrefix: 'sk-ironcurtain-zai-',
    gatewayAdapterId: 'zai',
    allowedEndpoints: [
      { method: 'POST', path },
      ...(kind === 'messages' ? [{ method: 'POST' as const, path: `${path}/count_tokens` }] : []),
    ],
    captureEndpoints: [{ method: 'POST', path }],
    completionEndpoints: [
      {
        method: 'POST',
        path,
        protocol,
        capabilities: {
          metricsSupport: kind === 'chat' ? 'partial' : 'full',
          streamingUsageNegotiation: kind === 'chat' ? 'client_or_agent_adapter' : 'none',
          trajectoryCapture: true,
        },
      },
    ],
    rewriteEndpoints: [path],
    requestRewriter(body, context) {
      const filtered = kind === 'messages' ? anthropicRequestRewriter(body, context) : null;
      const current = filtered?.modified ?? body;
      const stripped = [...(filtered?.stripped ?? [])];
      const modified = { ...current };
      if (kind === 'messages' && 'context_management' in modified) {
        delete modified.context_management;
        stripped.push('context_management');
      }
      return stripped.length ? { modified, stripped } : null;
    },
  };
}

/** Client-side metadata, scoped to models declared by the selected profile/session. */
export function zaiCodexCatalog(profile: ResolvedZaiProfile, requested?: string): string {
  const models = new Set([
    profile.model,
    resolveZaiModel(profile, requested, 'codex'),
    ...profile.modelMap.map((rule) => rule.model),
    ...Object.values(profile.perAgent).filter((m) => m !== undefined),
  ]);
  return JSON.stringify(
    {
      models: [...models].map((slug) => ({
        slug,
        display_name: slug,
        description: 'Z.AI model',
        default_reasoning_level: 'high',
        supported_reasoning_levels: [
          { effort: 'low', description: 'Light reasoning' },
          { effort: 'high', description: 'Enhanced reasoning' },
        ],
        shell_type: 'shell_command',
        visibility: 'list',
        supported_in_api: true,
        priority: 0,
        base_instructions: '',
        supports_reasoning_summaries: true,
        default_reasoning_summary: 'none',
        support_verbosity: false,
        apply_patch_tool_type: 'freeform',
        truncation_policy: { mode: 'bytes', limit: 10000 },
        context_window: slug === 'glm-5.3' ? 1048576 : 200000,
        max_context_window: slug === 'glm-5.3' ? 1048576 : 200000,
        effective_context_window_percent: 95,
        supports_parallel_tool_calls: true,
        experimental_supported_tools: [],
        input_modalities: ['text'],
      })),
    },
    null,
    2,
  );
}
