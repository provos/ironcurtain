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
const MAX_QUERY_LENGTH = 2000;
const MAX_TOKEN_BUDGET = 50000;
const MAX_TAGS = 50;
const NAMESPACE_PATTERN = /^[a-zA-Z0-9_\-.:]+$/;
const MAX_NAMESPACE_LENGTH = 256;

export function validateRecallInput(args: Record<string, unknown>): RecallInput {
  const query = args.query;
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('query is required and must be a non-empty string');
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`);
  }

  const tokenBudget = args.token_budget;
  if (tokenBudget !== undefined) {
    if (typeof tokenBudget !== 'number' || !Number.isInteger(tokenBudget) || tokenBudget < 1) {
      throw new Error('token_budget must be a positive integer');
    }
    if (tokenBudget > MAX_TOKEN_BUDGET) {
      throw new Error(`token_budget exceeds maximum of ${MAX_TOKEN_BUDGET}`);
    }
  }

  const tags = args.tags;
  if (tags !== undefined) {
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
      throw new Error('tags must be an array of strings');
    }
    if (tags.length > MAX_TAGS) {
      throw new Error(`tags array exceeds maximum of ${MAX_TAGS} items`);
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
  if (typeof namespace === 'string') {
    if (namespace.length > MAX_NAMESPACE_LENGTH) {
      throw new Error(`namespace exceeds maximum length of ${MAX_NAMESPACE_LENGTH} characters`);
    }
    if (!NAMESPACE_PATTERN.test(namespace)) {
      throw new Error('namespace must contain only alphanumeric characters, hyphens, underscores, dots, and colons');
    }
  }

  return {
    query: query.trim(),
    token_budget: tokenBudget,
    tags: tags,
    format: format as RecallInput['format'],
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
