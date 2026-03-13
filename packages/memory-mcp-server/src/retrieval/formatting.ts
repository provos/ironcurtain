import type { ScoredMemory } from './scoring.js';
import type { MemoryConfig } from '../config.js';
import { llmComplete } from '../llm/client.js';
import { clusterByEmbeddingSimilarity } from './dedup.js';
import { parseTags } from '../utils/tags.js';

export const FORMAT_MODES = ['summary', 'list', 'raw', 'answer'] as const;
export type FormatMode = (typeof FORMAT_MODES)[number];

/**
 * Format scored memories according to the requested format mode.
 */
export async function formatMemories(
  memories: ScoredMemory[],
  embeddings: Map<string, Float32Array>,
  query: string,
  tokenBudget: number,
  format: FormatMode,
  config: MemoryConfig,
): Promise<string> {
  switch (format) {
    case 'summary':
      return formatAsSummary(memories, embeddings, query, tokenBudget, config);
    case 'answer':
      return formatAsAnswer(memories, query, tokenBudget, config);
    case 'list':
      return formatAsList(memories);
    case 'raw':
      return formatAsRaw(memories);
  }
}

async function formatAsSummary(
  memories: ScoredMemory[],
  embeddings: Map<string, Float32Array>,
  query: string,
  tokenBudget: number,
  config: MemoryConfig,
): Promise<string> {
  if (memories.length === 0) return 'No relevant memories found.';

  // Try LLM abstractive summarization first
  const llmResult = await formatAsSummaryWithLLM(memories, query, tokenBudget, config);
  if (llmResult) return llmResult;

  // Extractive fallback
  return formatAsSummaryExtractive(memories, embeddings);
}

/** Build numbered memory text for LLM prompts. Shared by summary and answer formats. */
function buildMemoriesText(memories: ScoredMemory[]): string {
  return memories
    .map((m, i) => `[${i + 1}] (${new Date(m.created_at).toISOString().slice(0, 10)}) ${m.content}`)
    .join('\n');
}

async function formatAsAnswer(
  memories: ScoredMemory[],
  query: string,
  tokenBudget: number,
  config: MemoryConfig,
): Promise<string> {
  if (memories.length === 0) return 'No relevant memories found.';

  const llmResult = await llmComplete(
    config,
    `You are a question-answering assistant with access to the user's stored memories. ` +
      `Answer the user's question based only on the provided memories. Be concise and direct. ` +
      `If the memories don't contain enough information to answer, say so clearly.`,
    `Question: ${query}\n\n<memories>\n${buildMemoriesText(memories)}\n</memories>`,
    { maxTokens: tokenBudget },
  );

  // Fall back to list format when no LLM is configured
  if (llmResult === null) return formatAsList(memories);

  return llmResult;
}

async function formatAsSummaryWithLLM(
  memories: ScoredMemory[],
  query: string,
  tokenBudget: number,
  config: MemoryConfig,
): Promise<string | null> {
  return llmComplete(
    config,
    `You are a memory compression assistant. Summarize the memories provided within <memories> tags into a concise, ` +
      `information-dense response relevant to the query. Preserve specific details (names, dates, ` +
      `numbers, exact preferences). Do not add information not present in the memories. ` +
      `Target approximately ${tokenBudget} tokens.`,
    `Query: ${query}\n\n<memories>\n${buildMemoriesText(memories)}\n</memories>`,
    { maxTokens: tokenBudget },
  );
}

function formatAsSummaryExtractive(memories: ScoredMemory[], embeddings: Map<string, Float32Array>): string {
  const clusters = clusterByEmbeddingSimilarity(memories, embeddings, 0.8);

  return clusters
    .map((cluster) => {
      if (cluster.length === 1) return cluster[0].content;
      const lead = cluster[0].content;
      const extras = cluster
        .slice(1)
        .map((m) => m.content)
        .filter((c) => !lead.includes(c));
      return extras.length > 0 ? `${lead} (Related: ${extras.join('; ')})` : lead;
    })
    .join('\n\n');
}

function formatAsList(memories: ScoredMemory[]): string {
  if (memories.length === 0) return 'No relevant memories found.';

  const lines = memories.map((m) => {
    const date = new Date(m.created_at).toISOString().slice(0, 10);
    return `- [${date}] ${m.content} (importance: ${m.importance})`;
  });

  return lines.join('\n');
}

function formatAsRaw(memories: ScoredMemory[]): string {
  const items = memories.map((m) => ({
    id: m.id,
    content: m.content,
    tags: parseTags(m.tags),
    importance: m.importance,
    created_at: m.created_at,
    updated_at: m.updated_at,
    last_accessed_at: m.last_accessed_at,
    access_count: m.access_count,
    is_compacted: m.is_compacted === 1,
    source: m.source,
  }));
  return JSON.stringify(items, null, 2);
}
