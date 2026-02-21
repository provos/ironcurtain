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
import type { ResolvedUserConfig } from './user-config.js';

/** Supported LLM provider identifiers. */
export type ProviderId = 'anthropic' | 'google' | 'openai';

/** Default provider when no prefix is specified. */
const DEFAULT_PROVIDER: ProviderId = 'anthropic';

/** Known provider identifiers for validation. */
const KNOWN_PROVIDERS = new Set<string>(['anthropic', 'google', 'openai']);

/**
 * Parsed model specifier. A "qualified model ID" has the form
 * "provider:model-name". A bare model ID defaults to Anthropic.
 */
export interface ParsedModelId {
  readonly provider: ProviderId;
  readonly modelId: string;
}

/**
 * Parses a qualified model ID string into provider and model components.
 *
 * Format: "provider:model-id" or just "model-id" (defaults to anthropic).
 *
 * @throws Error if the provider prefix is not recognized or model ID is empty
 */
export function parseModelId(qualifiedId: string): ParsedModelId {
  const colonIndex = qualifiedId.indexOf(':');

  if (colonIndex === -1) {
    return { provider: DEFAULT_PROVIDER, modelId: qualifiedId };
  }

  const prefix = qualifiedId.substring(0, colonIndex);
  const modelId = qualifiedId.substring(colonIndex + 1);

  if (!KNOWN_PROVIDERS.has(prefix)) {
    const known = [...KNOWN_PROVIDERS].sort().join(', ');
    throw new Error(
      `Unknown model provider "${prefix}" in "${qualifiedId}". ` +
      `Supported providers: ${known}`,
    );
  }

  if (!modelId) {
    throw new Error(
      `Empty model ID in "${qualifiedId}". ` +
      `Expected format: "provider:model-id"`,
    );
  }

  return { provider: prefix as ProviderId, modelId };
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
): Promise<LanguageModelV3> {
  const { provider } = parseModelId(qualifiedId);
  return createLanguageModelFromEnv(qualifiedId, resolveApiKeyForProvider(provider, config));
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
): Promise<LanguageModelV3> {
  const { provider, modelId } = parseModelId(qualifiedId);
  const key = apiKey || undefined;

  switch (provider) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({ apiKey: key })(modelId);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({ apiKey: key })(modelId);
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey: key })(modelId);
    }
  }
}

/**
 * Resolves the API key for a given provider from user config.
 * Returns empty string when no key is configured.
 */
export function resolveApiKeyForProvider(
  provider: ProviderId,
  config: ResolvedUserConfig,
): string {
  switch (provider) {
    case 'anthropic': return config.anthropicApiKey;
    case 'google': return config.googleApiKey;
    case 'openai': return config.openaiApiKey;
  }
}
