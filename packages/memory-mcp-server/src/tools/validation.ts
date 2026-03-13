/**
 * Shared validation constants and helpers used across tool handlers.
 */

export const MAX_CONTENT_LENGTH = 10000;
export const MAX_QUERY_LENGTH = 2000;
export const MAX_TOKEN_BUDGET = 50000;
export const MAX_TAGS = 50;
export const MAX_TAG_LENGTH = 100;
export const MAX_IDS = 100;
export const MAX_LIMIT = 1000;

/**
 * Validate and return a tags array, or undefined if not provided.
 */
export function validateTags(tags: unknown): string[] | undefined {
  if (tags === undefined) return undefined;
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
    throw new Error('tags must be an array of strings');
  }
  if (tags.length > MAX_TAGS) {
    throw new Error(`tags array exceeds maximum of ${MAX_TAGS} items`);
  }
  if (tags.some((t: string) => t.length > MAX_TAG_LENGTH)) {
    throw new Error(`each tag must be at most ${MAX_TAG_LENGTH} characters`);
  }
  return tags;
}

/**
 * Validate and return an IDs array, or undefined if not provided.
 */
export function validateIds(ids: unknown): string[] | undefined {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
    throw new Error('ids must be an array of strings');
  }
  if (ids.length > MAX_IDS) {
    throw new Error(`ids array exceeds maximum of ${MAX_IDS} items`);
  }
  return ids;
}

/**
 * Validate and return a token budget, or undefined if not provided.
 */
export function validateTokenBudget(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('token_budget must be a positive integer');
  }
  if (value > MAX_TOKEN_BUDGET) {
    throw new Error(`token_budget exceeds maximum of ${MAX_TOKEN_BUDGET}`);
  }
  return value;
}
