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
      `The existing memory is provided within <existing_memory> tags and the new memory within <new_memory> tags.\n` +
      `Reply with exactly one word: "duplicate", "contradiction", or "distinct".\n` +
      `- "duplicate": they express the same fact, possibly worded differently\n` +
      `- "contradiction": they express conflicting facts about the same topic (the new one supersedes the old)\n` +
      `- "distinct": they are about different topics or complementary facts`,
    `<existing_memory>\n${existingContent}\n</existing_memory>\n<new_memory>\n${newContent}\n</new_memory>`,
    { maxTokens: 10 },
  );

  const normalized = result?.trim().toLowerCase();
  if (normalized === 'duplicate' || normalized === 'contradiction') return normalized;
  return 'distinct';
}

// ---------- Batch judgment ----------

/** A pair of memories to be judged. */
export interface CandidatePair {
  newId: string;
  newContent: string;
  existingId: string;
  existingContent: string;
}

export type PairRelation = 'duplicate' | 'contradiction' | 'distinct';

export interface BatchJudgment {
  pairIndex: number;
  relation: PairRelation;
}

const MAX_PAIRS_PER_CALL = 20;

/**
 * Judge multiple memory pairs in a single LLM call.
 * Returns a judgment for each pair. On LLM failure, defaults all to 'distinct'.
 */
export async function batchJudgeMemoryRelations(
  config: MemoryConfig,
  pairs: CandidatePair[],
): Promise<BatchJudgment[]> {
  const allJudgments: BatchJudgment[] = [];
  let globalOffset = 0;

  for (let i = 0; i < pairs.length; i += MAX_PAIRS_PER_CALL) {
    const batch = pairs.slice(i, i + MAX_PAIRS_PER_CALL);
    const judgments = await judgeBatch(config, batch, globalOffset);
    allJudgments.push(...judgments);
    globalOffset += batch.length;
  }

  return allJudgments;
}

async function judgeBatch(config: MemoryConfig, batch: CandidatePair[], indexOffset: number): Promise<BatchJudgment[]> {
  const pairsText = batch
    .map(
      (pair, i) =>
        `<pair index="${i}">\n` +
        `<existing>${pair.existingContent}</existing>\n` +
        `<new>${pair.newContent}</new>\n` +
        `</pair>`,
    )
    .join('\n');

  const systemPrompt =
    `You judge whether pairs of memories are duplicates, contradictions, or distinct facts.\n` +
    `For each pair, reply with a JSON array of objects: [{"index": 0, "relation": "duplicate"}, ...].\n` +
    `Rules:\n` +
    `- "duplicate": they express the same fact, possibly worded differently\n` +
    `- "contradiction": they express conflicting facts about the same topic (the new one supersedes)\n` +
    `- "distinct": they are about different topics or complementary facts\n` +
    `Reply ONLY with the JSON array, no other text.`;

  const result = await llmComplete(config, systemPrompt, pairsText, {
    maxTokens: Math.min(batch.length * 30, 1000),
  });

  if (!result) {
    return batch.map((_, i) => ({
      pairIndex: indexOffset + i,
      relation: 'distinct' as PairRelation,
    }));
  }

  return parseBatchJudgments(result, batch.length, indexOffset);
}

export function parseBatchJudgments(raw: string, expectedCount: number, indexOffset: number): BatchJudgment[] {
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found');

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      index: number;
      relation: string;
    }>;

    const validRelations = new Set(['duplicate', 'contradiction', 'distinct']);
    const judgments: BatchJudgment[] = [];

    for (const item of parsed) {
      if (typeof item.index !== 'number' || item.index < 0 || item.index >= expectedCount) continue;
      const relation = validRelations.has(item.relation) ? (item.relation as PairRelation) : 'distinct';
      judgments.push({ pairIndex: indexOffset + item.index, relation });
    }

    // Fill in missing pairs as 'distinct'
    const seen = new Set(judgments.map((j) => j.pairIndex));
    for (let i = 0; i < expectedCount; i++) {
      if (!seen.has(indexOffset + i)) {
        judgments.push({ pairIndex: indexOffset + i, relation: 'distinct' });
      }
    }

    return judgments;
  } catch {
    return Array.from({ length: expectedCount }, (_, i) => ({
      pairIndex: indexOffset + i,
      relation: 'distinct' as PairRelation,
    }));
  }
}
