import OpenAI from 'openai';
import type { MemoryConfig } from '../config.js';

let llmClient: OpenAI | null = null;
let clientConfig: { baseUrl: string | null; apiKey: string | null } | null = null;

/**
 * Get or lazily create the OpenAI-compatible LLM client.
 * Returns null when no LLM is configured (graceful degradation).
 */
export function getLLMClient(config: MemoryConfig): OpenAI | null {
  if (config.llmApiKey === null && config.llmBaseUrl === null) return null;

  // Re-create client if config changed
  if (llmClient && clientConfig?.baseUrl === config.llmBaseUrl && clientConfig.apiKey === config.llmApiKey) {
    return llmClient;
  }

  llmClient = new OpenAI({
    apiKey: config.llmApiKey ?? 'not-needed',
    baseURL: config.llmBaseUrl ?? undefined,
  });
  clientConfig = { baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey };

  return llmClient;
}

export interface LlmCompleteOptions {
  maxTokens?: number;
}

/**
 * Send a system + user prompt to the configured LLM.
 * Returns null when no LLM is configured or on error (graceful fallback).
 */
export async function llmComplete(
  config: MemoryConfig,
  systemPrompt: string,
  userPrompt: string,
  opts?: LlmCompleteOptions,
): Promise<string | null> {
  const client = getLLMClient(config);
  if (!client) return null;

  try {
    const response = await client.chat.completions.create({
      model: config.llmModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: opts?.maxTokens ?? 300,
      temperature: 0,
    });
    return response.choices[0]?.message?.content ?? null;
  } catch (err) {
    console.error('[memory-server] LLM call failed:', err);
    return null;
  }
}

/**
 * Judge whether two memories are duplicates, contradictions, or distinct.
 * Returns 'distinct' as default when LLM is unavailable or unclear.
 */
export async function judgeMemoryRelation(
  config: MemoryConfig,
  newContent: string,
  existingContent: string,
): Promise<'duplicate' | 'contradiction' | 'distinct'> {
  const result = await llmComplete(
    config,
    `You judge whether two memories are duplicates, contradictions, or distinct facts.\n` +
      `Reply with exactly one word: "duplicate", "contradiction", or "distinct".\n` +
      `- "duplicate": they express the same fact, possibly worded differently\n` +
      `- "contradiction": they express conflicting facts about the same topic (the new one supersedes the old)\n` +
      `- "distinct": they are about different topics or complementary facts`,
    `Existing memory: ${existingContent}\nNew memory: ${newContent}`,
    { maxTokens: 10 },
  );

  const normalized = result?.trim().toLowerCase();
  if (normalized === 'duplicate' || normalized === 'contradiction') return normalized;
  return 'distinct';
}
