/**
 * memory_recall tool handler.
 * Validates input and delegates to the engine.
 */

import type { MemoryEngine } from '../engine.js';
import { MAX_QUERY_LENGTH, validateTokenBudget, validateTags } from './validation.js';

export interface RecallInput {
  query: string;
  token_budget?: number;
  tags?: string[];
  format?: 'summary' | 'list' | 'raw';
}

const VALID_FORMATS = new Set(['summary', 'list', 'raw']);

export function validateRecallInput(args: Record<string, unknown>): RecallInput {
  const query = args.query;
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('query is required and must be a non-empty string');
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`);
  }

  const tokenBudget = validateTokenBudget(args.token_budget);
  const tags = validateTags(args.tags);

  const format = args.format;
  if (format !== undefined) {
    if (typeof format !== 'string' || !VALID_FORMATS.has(format)) {
      throw new Error("format must be one of: 'summary', 'list', 'raw'");
    }
  }

  return {
    query: query.trim(),
    token_budget: tokenBudget,
    tags,
    format: format as RecallInput['format'],
  };
}

export async function handleRecall(engine: MemoryEngine, args: Record<string, unknown>): Promise<string> {
  const input = validateRecallInput(args);
  const result = await engine.recall({
    query: input.query,
    token_budget: input.token_budget,
    tags: input.tags,
    format: input.format,
  });

  if (result.memories_used === 0) {
    return 'No relevant memories found.';
  }

  return result.content;
}
