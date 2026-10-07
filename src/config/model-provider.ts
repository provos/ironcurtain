/**
 * Multi-provider model resolution.
 *
 * Parses qualified model ID strings ("provider:model-id") and creates
 * LanguageModel instances using the appropriate AI SDK provider package.
 *
 * Provider packages are dynamically imported so that only the packages
 * for providers actually in use need to be installed.
 *
 * Adding a new provider requires:
 * 1. Adding the identifier to ProviderId
 * 2. Adding a case to createLanguageModel()
 * 3. Optionally adding a key field to UserConfig
 * 4. Installing the @ai-sdk/<provider> package
 */

import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { ResolvedUserConfig, HostModelRole } from './user-config.js';
import { resolveActiveProfile } from './user-config.js';
import { resolveMappedModel } from './model-mapping.js';
import { resolveZaiModel, zaiBaseUrls } from './zai.js';
import { parseModelId } from './model-id.js';
import type { ProviderId } from './model-id.js';

export { parseModelId, PROVIDER_ENV_VARS } from './model-id.js';
export type { ProviderId, ParsedModelId } from './model-id.js';

/**
 * Returns a proxy-aware fetch function if HTTPS_PROXY or HTTP_PROXY is set.
 * Memoized: the ProxyAgent and fetch wrapper are created once and reused.
 */
let cachedProxyFetch: typeof globalThis.fetch | undefined;
let cachedProxyUrl: string | undefined;

async function getProxyFetch(): Promise<typeof globalThis.fetch | undefined> {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxyUrl) return undefined;
  if (cachedProxyFetch && cachedProxyUrl === proxyUrl) return cachedProxyFetch;

  const { ProxyAgent, fetch: undiciFetch } = await import('undici');
  const dispatcher = new ProxyAgent(proxyUrl);
  // undici's fetch types are structurally incompatible with globalThis.fetch
  // but fully compatible at runtime. The AI SDK only uses standard fetch semantics.
  const proxyFetch = (input: unknown, init?: unknown) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Record<string, unknown>),
      dispatcher,
    });
  cachedProxyUrl = proxyUrl;
  cachedProxyFetch = proxyFetch as unknown as typeof globalThis.fetch;
  return cachedProxyFetch;
}

/**
 * Creates a LanguageModel from a qualified model ID and user config.
 *
 * Resolves the API key from config based on the model's provider,
 * then delegates to createLanguageModelFromEnv().
 *
 * @param qualifiedId - Model specifier like "anthropic:claude-sonnet-4-6"
 * @param config - Resolved user config for API key lookup
 * @returns A LanguageModelV3 instance ready for use with generateText()
 */
export async function createLanguageModel(
  qualifiedId: string,
  config: ResolvedUserConfig,
  role?: HostModelRole,
): Promise<LanguageModelV3> {
  const profileName = role === undefined ? undefined : config.hostModelProfiles?.[role];
  if (profileName !== undefined) {
    const profile = resolveActiveProfile(config.modelProviders, profileName);
    if (profile.type !== 'native') {
      if (!profile.apiKey) throw new Error(`No API key configured for host model profile "${profileName}".`);
      const requested = parseModelId(qualifiedId).modelId;
      const model =
        profile.type === 'zai'
          ? resolveZaiModel(profile, requested)
          : (resolveMappedModel(requested, profile.modelMap) ?? requested);
      const { createOpenAI } = await import('@ai-sdk/openai');
      const provider = createOpenAI({
        name: profile.type,
        apiKey: profile.apiKey,
        baseURL: profile.type === 'zai' ? zaiBaseUrls(profile.plan).chat : 'https://openrouter.ai/api/v1',
        fetch: await getProxyFetch(),
      });
      // Gateways implement Chat Completions; the SDK's default is Responses.
      const chat = provider.chat(model);
      if (profile.type !== 'zai') return chat;
      const { wrapLanguageModel } = await import('ai');
      return wrapLanguageModel({
        model: chat,
        middleware: {
          specificationVersion: 'v3',
          // eslint-disable-next-line @typescript-eslint/require-await -- middleware requires a Promise
          async transformParams({ params }) {
            if (params.responseFormat?.type !== 'json' || params.responseFormat.schema === undefined) return params;
            // Z.AI documents JSON mode with client-side schema validation.
            // Keep the AI SDK's output validation, supplying the schema in the prompt.
            return {
              ...params,
              responseFormat: { type: 'json' },
              prompt: [
                {
                  role: 'system',
                  content: `Return JSON matching this schema: ${JSON.stringify(params.responseFormat.schema)}`,
                },
                ...params.prompt,
              ],
            };
          },
        },
      });
    }
  }
  const { provider } = parseModelId(qualifiedId);
  return createLanguageModelFromEnv(
    qualifiedId,
    resolveApiKeyForProvider(provider, config),
    resolveBaseUrlForProvider(provider, config),
  );
}

/**
 * Creates a LanguageModel from a qualified model ID and an explicit API key.
 *
 * Unlike createLanguageModel(), this does not require a ResolvedUserConfig.
 * Designed for use in the proxy process, which receives the model ID and
 * API key via environment variables.
 *
 * @param qualifiedId - Model specifier like "anthropic:claude-haiku-4-5"
 * @param apiKey - Explicit API key for the model's provider (empty string uses env/default)
 * @returns A LanguageModelV3 instance ready for use with generateText()
 */
export async function createLanguageModelFromEnv(
  qualifiedId: string,
  apiKey: string,
  baseURL?: string,
): Promise<LanguageModelV3> {
  const { provider, modelId } = parseModelId(qualifiedId);
  const key = apiKey || undefined;
  const url = baseURL || undefined;
  const fetch = await getProxyFetch();

  switch (provider) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      // The shared override is an API root (as consumed by Claude Code and
      // Docker's MITM). The SDK appends /messages, rather than /v1/messages.
      // Preserve explicit SDK /v1 bases while deriving it for root overrides.
      const root = (url ?? (process.env.ANTHROPIC_BASE_URL || undefined))?.replace(/\/+$/, '');
      const sdkBaseURL = root === undefined || root.endsWith('/v1') ? root : `${root}/v1`;
      return createAnthropic({ apiKey: key, baseURL: sdkBaseURL, fetch })(modelId);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ apiKey: key, baseURL: url, fetch })(modelId);
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey: key, baseURL: url, fetch })(modelId);
    }
  }
}

/**
 * Resolves the API key for a given provider from user config.
 * Returns empty string when no key is configured.
 */
export function resolveApiKeyForProvider(provider: ProviderId, config: ResolvedUserConfig): string {
  switch (provider) {
    case 'anthropic':
      return config.anthropicApiKey;
    case 'google':
      return config.googleApiKey;
    case 'openai':
      return config.openaiApiKey;
  }
}

export function resolveHostModelApiKey(qualifiedId: string, config: ResolvedUserConfig, role: HostModelRole): string {
  const name = config.hostModelProfiles?.[role];
  const profile = name === undefined ? undefined : resolveActiveProfile(config.modelProviders, name);
  return profile && profile.type !== 'native'
    ? profile.apiKey
    : resolveApiKeyForProvider(parseModelId(qualifiedId).provider, config);
}

/**
 * Resolves the base URL override for a given provider from user config.
 * Returns empty string when no override is configured.
 */
export function resolveBaseUrlForProvider(provider: ProviderId, config: ResolvedUserConfig): string {
  switch (provider) {
    case 'anthropic':
      return config.anthropicBaseUrl;
    case 'google':
      return config.googleBaseUrl;
    case 'openai':
      return config.openaiBaseUrl;
  }
}
