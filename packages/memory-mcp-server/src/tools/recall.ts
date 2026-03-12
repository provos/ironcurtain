/**
 * memory_recall tool handler.
 * Validates input and delegates to the engine.
 */

import type { MemoryEngine } from '../engine.js';

export interface RecallInput {
  query: string;
  token_budget?: number;
  tags?: string[];
  format?: 'summary' | 'list' | 'raw';
  namespace?: string;
}

const VALID_FORMATS = new Set(['summary', 'list', 'raw']);

export function validateRecallInput(args: Record<string, unknown>): RecallInput {
  const query = args.query;
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('query is required and must be a non-empty string');
  }

  const tokenBudget = args.token_budget;
  if (tokenBudget !== undefined) {
    if (typeof tokenBudget !== 'number' || !Number.isInteger(tokenBudget) || tokenBudget < 1) {
      throw new Error('token_budget must be a positive integer');
    }
  }

  const tags = args.tags;
  if (tags !== undefined) {
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
      throw new Error('tags must be an array of strings');
    }
  }

  const format = args.format;
  if (format !== undefined) {
    if (typeof format !== 'string' || !VALID_FORMATS.has(format)) {
      throw new Error("format must be one of: 'summary', 'list', 'raw'");
    }
  }

  const namespace = args.namespace;
  if (namespace !== undefined && typeof namespace !== 'string') {
    throw new Error('namespace must be a string');
  }

  return {
    query: query.trim(),
    token_budget: tokenBudget,
    tags: tags,
    format: format,
    namespace: namespace,
  };
}

export async function handleRecall(engine: MemoryEngine, args: Record<string, unknown>): Promise<string> {
  const input = validateRecallInput(args);
  const result = await engine.recall({
    query: input.query,
    token_budget: input.token_budget,
    tags: input.tags,
    format: input.format,
    namespace: input.namespace,
  });

  if (result.memories_used === 0) {
    return 'No relevant memories found.';
  }

  return result.content;
}
