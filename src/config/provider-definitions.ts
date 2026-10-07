/** Built-in gateway facts. Configuration consumers use these descriptions, not service-name branches. */
import type { DockerAgent } from './user-config.js';
import { parseModelId } from './model-id.js';
import { resolveMappedModel } from './model-mapping.js';
import { openRouterRequestFields } from './openrouter.js';

/** Normalized facts consumed by routing; service-specific persistence schemas remain authoritative. */
export interface GatewayProfile {
  readonly type: string;
  readonly apiKey: string;
  readonly modelMap: readonly { readonly match: string; readonly model: string }[];
  readonly usesDefaultMap: boolean;
  readonly perAgent: Readonly<Record<DockerAgent, string | undefined>>;
  readonly model?: string;
  readonly plan?: string;
  readonly providerPreference?: {
    readonly order?: readonly string[];
    readonly only?: readonly string[];
    readonly allowFallbacks?: boolean;
  };
  readonly sessionAffinity?: boolean;
}
export type GatewayProtocol = 'messages' | 'responses' | 'chat';

export interface ProviderEditorDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly credentialEnv: string;
  readonly credentialPlaceholder: string;
  readonly modelPlaceholder: string;
  readonly catalog: 'remote' | 'manual';
  readonly model?: { readonly label: string; readonly defaultValue: string; readonly defaultMapMatch?: string };
  readonly plan?: {
    readonly defaultValue: string;
    readonly choices: readonly { readonly value: string; readonly label: string }[];
  };
  readonly providerRouting: boolean;
  readonly sessionAffinity: boolean;
  readonly defaultMap: readonly { readonly match: string; readonly model: string }[];
}

export interface GatewayDefinition {
  readonly id: string;
  readonly label: string;
  readonly editor: ProviderEditorDescriptor;
  readonly host: string;
  /** Mapping authority for Docker request paths; host SDKs always select directly. */
  readonly modelSelection: 'client' | 'proxy';
  readonly clientModels: Readonly<
    Record<GatewayProtocol, 'omit' | 'profile-default' | 'requested' | 'requested-or-default'>
  >;
  readonly aliasFallback: 'omit' | 'requested';
  readonly fakeKeyPrefix: string;
  readonly codex: { readonly credentialEnv: string; readonly catalog: boolean; readonly webSockets?: boolean };
  readonly goose: { readonly provider: string; readonly credentialEnv: string; readonly endpointOverride: boolean };
  readonly structuredOutput: 'schema' | 'json-object';
  /** Preserve the existing native credential diagnostic for this legacy gateway. */
  readonly nativeCredentialHelp?: boolean;
  readonly models?: Readonly<Record<string, ProviderModelMetadata>>;
  readonly defaultModelMetadata?: ProviderModelMetadata;
  readonly sessionAffinityModelPrefix?: string;
  readonly stripContextManagementOn: readonly GatewayProtocol[];
  readonly filterMessagesTools: boolean;
  readonly keyInjection: { readonly type: 'bearer' };
  /** Authorization is declared independently of client base URLs. */
  proxyPaths(profile: Pick<GatewayProfile, 'type' | 'plan'>): Readonly<
    Record<
      GatewayProtocol,
      {
        readonly completion: string;
        readonly additional: readonly { readonly method: 'GET' | 'POST'; readonly path: string }[];
      }
    >
  >;
  requestFields?(profile: GatewayProfile, model: string): GatewayRequestFields | undefined;
  defaultModel(profile: GatewayProfile): string;
  baseUrls(profile: Pick<GatewayProfile, 'type' | 'plan'>): Readonly<Record<GatewayProtocol, string>>;
}

export interface GatewayRequestFields {
  readonly body: Readonly<Record<string, unknown>>;
  readonly auditLabels: Readonly<Record<string, string>>;
}

export interface ProviderModelMetadata {
  readonly contextWindow: number;
  readonly inputModalities: readonly string[];
  readonly reasoning?: {
    readonly defaultLevel: string;
    readonly levels: readonly string[];
    readonly summaries: boolean;
  };
  readonly parallelToolCalls?: boolean;
}
export const CONSERVATIVE_MODEL_METADATA: ProviderModelMetadata = { contextWindow: 200000, inputModalities: ['text'] };

export const GLM_DEFAULT_MODEL = 'glm-5.3';
export const GLM_FLASH_MODEL = 'glm-5.3-flash';
export const OPENROUTER_DEFAULT_MODEL = `z-ai/${GLM_DEFAULT_MODEL}`;
export const OPENROUTER_FLASH_MODEL = `z-ai/${GLM_FLASH_MODEL}`;
export const OPENROUTER_DEFAULT_MAP = [
  { match: '*opus*', model: OPENROUTER_DEFAULT_MODEL },
  { match: '*sonnet*', model: OPENROUTER_FLASH_MODEL },
  { match: '*haiku*', model: OPENROUTER_FLASH_MODEL },
] as const;

const GLM_MODEL_METADATA: ProviderModelMetadata = {
  ...CONSERVATIVE_MODEL_METADATA,
  reasoning: { defaultLevel: 'high', levels: ['low', 'high'], summaries: true },
  parallelToolCalls: true,
};

const DEFINITIONS: readonly GatewayDefinition[] = [
  {
    id: 'openrouter',
    nativeCredentialHelp: true,
    label: 'OpenRouter',
    host: 'openrouter.ai',
    modelSelection: 'proxy',
    clientModels: { messages: 'omit', responses: 'profile-default', chat: 'requested-or-default' },
    aliasFallback: 'omit',
    fakeKeyPrefix: 'sk-or-v1-ironcurtain-',
    codex: { credentialEnv: 'OPENROUTER_API_KEY', catalog: true },
    goose: { provider: 'openrouter', credentialEnv: 'OPENROUTER_API_KEY', endpointOverride: false },
    structuredOutput: 'schema',
    keyInjection: { type: 'bearer' },
    stripContextManagementOn: ['messages', 'responses', 'chat'],
    filterMessagesTools: false,
    sessionAffinityModelPrefix: 'z-ai/',
    requestFields: openRouterRequestFields,
    proxyPaths: () => ({
      messages: {
        completion: '/api/v1/messages',
        additional: [
          { method: 'POST', path: '/api/v1/messages/count_tokens' },
          { method: 'GET', path: '/api/v1/models' },
        ],
      },
      responses: { completion: '/api/v1/responses', additional: [{ method: 'GET', path: '/api/v1/models' }] },
      chat: { completion: '/api/v1/chat/completions', additional: [{ method: 'GET', path: '/api/v1/models' }] },
    }),
    defaultModel: () => OPENROUTER_DEFAULT_MODEL,
    baseUrls: () => ({
      messages: 'https://openrouter.ai/api',
      responses: 'https://openrouter.ai/api/v1',
      chat: 'https://openrouter.ai/api/v1',
    }),
    editor: {
      id: 'openrouter',
      label: 'OpenRouter',
      description: 'Routes through OpenRouter with a model map, provider preferences, and session affinity.',
      credentialEnv: 'OPENROUTER_API_KEY',
      credentialPlaceholder: 'sk-or-v1-...',
      modelPlaceholder: OPENROUTER_FLASH_MODEL,
      catalog: 'remote',
      providerRouting: true,
      sessionAffinity: true,
      defaultMap: OPENROUTER_DEFAULT_MAP,
    },
  },
  {
    id: 'zai',
    label: 'Z.AI',
    host: 'api.z.ai',
    modelSelection: 'client',
    clientModels: { messages: 'requested', responses: 'requested', chat: 'requested' },
    aliasFallback: 'requested',
    fakeKeyPrefix: 'sk-ironcurtain-zai-',
    codex: { credentialEnv: 'ZAI_API_KEY', catalog: true, webSockets: false },
    goose: { provider: 'openai', credentialEnv: 'OPENAI_API_KEY', endpointOverride: true },
    structuredOutput: 'json-object',
    keyInjection: { type: 'bearer' },
    stripContextManagementOn: ['messages'],
    filterMessagesTools: true,
    defaultModelMetadata: GLM_MODEL_METADATA,
    models: { [GLM_DEFAULT_MODEL]: { ...GLM_MODEL_METADATA, contextWindow: 1048576 } },
    proxyPaths: (profile) => ({
      messages: {
        completion: '/api/anthropic/v1/messages',
        additional: [{ method: 'POST', path: '/api/anthropic/v1/messages/count_tokens' }],
      },
      responses: { completion: '/api/v1/responses', additional: [] },
      chat: {
        completion: `/api/${profile.plan === 'coding' ? 'coding/' : ''}paas/v4/chat/completions`,
        additional: [],
      },
    }),
    defaultModel: (profile) => profile.model ?? GLM_DEFAULT_MODEL,
    baseUrls: (profile) => ({
      messages: 'https://api.z.ai/api/anthropic',
      responses: 'https://api.z.ai/api/v1',
      chat: `https://api.z.ai/api/${profile.plan === 'coding' ? 'coding/' : ''}paas/v4`,
    }),
    editor: {
      id: 'zai',
      label: 'Z.AI (direct)',
      description: 'Connects directly using the selected API plan and model preset.',
      credentialEnv: 'ZAI_API_KEY',
      credentialPlaceholder: 'Z.AI API key',
      modelPlaceholder: GLM_DEFAULT_MODEL,
      catalog: 'manual',
      model: { label: 'Default model / Opus target', defaultValue: GLM_DEFAULT_MODEL, defaultMapMatch: '*opus*' },
      plan: {
        defaultValue: 'api',
        choices: [
          { value: 'api', label: 'Standard API' },
          { value: 'coding', label: 'Coding Plan' },
        ],
      },
      providerRouting: false,
      sessionAffinity: false,
      defaultMap: [
        { match: '*opus*', model: GLM_DEFAULT_MODEL },
        { match: '*sonnet*', model: GLM_FLASH_MODEL },
        { match: '*haiku*', model: GLM_FLASH_MODEL },
      ],
    },
  },
];

export function getGatewayDefinition(id: string): GatewayDefinition {
  const definition = DEFINITIONS.find((entry) => entry.id === id);
  if (!definition) throw new Error(`Unknown built-in model provider "${id}".`);
  return definition;
}

/** Public, credential-free metadata; no runtime factories are serialized. */
export function getProviderEditorDescriptors(): readonly ProviderEditorDescriptor[] {
  return DEFINITIONS.map((definition) => structuredClone(definition.editor));
}

export interface ModelSelection {
  readonly requested: string;
  readonly selected: string;
  readonly source: 'per-agent' | 'map' | 'requested' | 'default';
}

/** Resolve a fresh request and report its selection provenance. Wire paths decide which stage owns mapping. */
export function resolveGatewayModel(
  profile: GatewayProfile,
  requested?: string,
  options: { readonly agent?: DockerAgent; readonly fallback?: string; readonly wireId?: boolean } = {},
  definition = getGatewayDefinition(profile.type),
): ModelSelection {
  const candidate = requested
    ? options.wireId
      ? requested
      : parseModelId(requested).modelId
    : definition.defaultModel(profile);
  const override = options.agent === undefined ? undefined : profile.perAgent[options.agent];
  const mapped = override === undefined ? resolveMappedModel(candidate, profile.modelMap) : undefined;
  return {
    requested: candidate,
    selected: override ?? mapped ?? options.fallback ?? candidate,
    source:
      override !== undefined
        ? 'per-agent'
        : mapped !== undefined
          ? 'map'
          : options.fallback !== undefined || !requested
            ? 'default'
            : 'requested',
  };
}

/** Defaults stay derived; explicit maps (including []) are never replaced. */
export function providerDefaultMap(
  id: string,
  model?: string,
): readonly { readonly match: string; readonly model: string }[] {
  const descriptor = getGatewayDefinition(id).editor;
  return descriptor.defaultMap.map((rule) => ({
    ...rule,
    model:
      descriptor.model && rule.match === descriptor.model.defaultMapMatch
        ? (model ?? descriptor.model.defaultValue)
        : rule.model,
  }));
}

export function providerDefaultMapSummary(descriptor: ProviderEditorDescriptor): string {
  return descriptor.defaultMap
    .map(
      (rule) =>
        `${rule.match} → ${descriptor.model && rule.match === descriptor.model.defaultMapMatch ? 'configured default model' : rule.model}`,
    )
    .join('; ');
}

/** A presentation hint uses the same resolver as routing, without credentials. */
export function providerProfileSummary(profile: GatewayProfile): string {
  const definition = getGatewayDefinition(profile.type);
  const selected = resolveGatewayModel(profile, 'claude-sonnet', {
    agent: 'claude-code',
    fallback: definition.aliasFallback === 'omit' ? definition.defaultModel(profile) : undefined,
  }).selected;
  return `${selected} (${definition.label}${definition.editor.plan ? `, ${profile.plan}` : ''})`;
}
