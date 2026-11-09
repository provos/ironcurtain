/** Supported LLM provider identifiers. */
export type ProviderId = 'anthropic' | 'google' | 'openai';

/** Default provider when no prefix is specified. */
const DEFAULT_PROVIDER: ProviderId = 'anthropic';

/** Known provider identifiers for validation. */
const KNOWN_PROVIDERS = new Set<string>(['anthropic', 'google', 'openai']);

/**
 * Environment variable that supplies each provider's API key.
 *
 * Single source of truth for the provider→env-var mapping. Declared as an
 * exhaustive `Record<ProviderId, string>` so adding a provider to
 * {@link ProviderId} forces a matching entry here at compile time. Must stay
 * in sync with the env-var overrides applied in `resolveUserConfig()`.
 */
export const PROVIDER_ENV_VARS: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openai: 'OPENAI_API_KEY',
};

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
 * @throws Error if the model ID is empty after a recognized provider prefix (e.g. "anthropic:").
 * Unknown prefixes are treated as part of the model ID and default to the anthropic provider.
 */
export function parseModelId(qualifiedId: string): ParsedModelId {
  const colonIndex = qualifiedId.indexOf(':');

  if (colonIndex === -1) {
    return { provider: DEFAULT_PROVIDER, modelId: qualifiedId };
  }

  const prefix = qualifiedId.substring(0, colonIndex);

  // Only treat the prefix as a provider if it's a known provider name.
  // Otherwise the entire string is a model ID (e.g. Ollama tags like
  // "qwen3.5-uncensored:35b" where the colon separates name from tag).
  if (!KNOWN_PROVIDERS.has(prefix)) {
    return { provider: DEFAULT_PROVIDER, modelId: qualifiedId };
  }

  const modelId = qualifiedId.substring(colonIndex + 1);
  if (!modelId) {
    throw new Error(`Empty model ID in "${qualifiedId}". ` + `Expected format: "provider:model-id"`);
  }

  return { provider: prefix as ProviderId, modelId };
}
