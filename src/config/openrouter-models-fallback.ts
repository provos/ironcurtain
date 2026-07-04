/**
 * Bundled OpenRouter model-slug floor.
 *
 * A deliberately small, hand-maintained list — a FLOOR, not a mirror of the live
 * catalog. Its only jobs are (1) keep the model picker non-empty when OpenRouter
 * is unreachable and (2) never block the shipped defaults. It is allowed to be
 * stale precisely because a `bundled` source resolves to warn-only validation
 * (see `catalogEnforces` in `openrouter-catalog.ts`).
 *
 * INVARIANT: must contain `DEFAULT_GLM_SLUG` and every `DEFAULT_MODEL_MAP` target
 * (both from `user-config.ts`) so a freshly-shipped default profile is always
 * saveable offline. Kept pre-sorted + de-duped so the catalog can serve it by
 * reference without re-processing.
 */
export const OPENROUTER_FALLBACK_SLUGS: readonly string[] = [
  'anthropic/claude-3-haiku',
  'anthropic/claude-3.5-haiku',
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-3.7-sonnet',
  'anthropic/claude-opus-4',
  'anthropic/claude-opus-4.1',
  'anthropic/claude-sonnet-4',
  'anthropic/claude-sonnet-4.5',
  'deepseek/deepseek-chat',
  'deepseek/deepseek-r1',
  'deepseek/deepseek-r1-0528',
  'deepseek/deepseek-v3',
  'google/gemini-2.0-flash',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
  'google/gemini-2.5-pro',
  'meta-llama/llama-3.3-70b-instruct',
  'mistralai/mistral-large',
  'moonshotai/kimi-k2',
  'moonshotai/kimi-k2-0905',
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/gpt-5',
  'openai/o3',
  'openai/o4-mini',
  'qwen/qwen3-235b-a22b',
  'x-ai/grok-4',
  'z-ai/glm-4.5',
  'z-ai/glm-4.6',
  'z-ai/glm-5.2',
];
