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
 * Provider packages are dynamically imported so that only the packages
 * for providers actually in use need to be installed.
 *
 * API key validation is deferred to the first API call -- the AI SDK
 * providers give better error messages than we could produce here.
 *
 * @param qualifiedId - Model specifier like "anthropic:claude-sonnet-4-6"
 * @param config - Resolved user config for API key lookup
 * @returns A LanguageModelV3 instance ready for use with generateText()
 */
export async function createLanguageModel(
  qualifiedId: string,
  config: ResolvedUserConfig,
): Promise<LanguageModelV3> {
  const { provider, modelId } = parseModelId(qualifiedId);

  switch (provider) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      const apiKey = config.apiKey || undefined;
      return createAnthropic({ apiKey })(modelId);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      const apiKey = config.googleApiKey || undefined;
      return createGoogleGenerativeAI({ apiKey })(modelId);
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      const apiKey = config.openaiApiKey || undefined;
      return createOpenAI({ apiKey })(modelId);
    }
  }
}
