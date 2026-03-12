/**
 * memory_store tool handler.
 * Validates input and delegates to the engine.
 */

import type { MemoryEngine } from '../engine.js';
import type { StoreResult } from '../types.js';

export interface StoreInput {
  content: string;
  tags?: string[];
  importance?: number;
  namespace?: string;
}

const MAX_CONTENT_LENGTH = 10000;
const MAX_TAGS = 50;
const MAX_TAG_LENGTH = 100;
const NAMESPACE_PATTERN = /^[a-zA-Z0-9_\-.:]+$/;
const MAX_NAMESPACE_LENGTH = 256;

export function validateStoreInput(args: Record<string, unknown>): StoreInput {
  const content = args.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('content is required and must be a non-empty string');
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`);
  }

  const tags = args.tags;
  if (tags !== undefined) {
    if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
      throw new Error('tags must be an array of strings');
    }
    if (tags.length > MAX_TAGS) {
      throw new Error(`tags array exceeds maximum of ${MAX_TAGS} items`);
    }
    if (tags.some((t: string) => t.length > MAX_TAG_LENGTH)) {
      throw new Error(`each tag must be at most ${MAX_TAG_LENGTH} characters`);
    }
  }

  const importance = args.importance;
  if (importance !== undefined) {
    if (typeof importance !== 'number' || !Number.isFinite(importance) || importance < 0 || importance > 1) {
      throw new Error('importance must be a number between 0 and 1');
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
    content: content.trim(),
    tags: tags,
    importance: importance,
    namespace: namespace,
  };
}

export function formatStoreResult(result: StoreResult): string {
  switch (result.action) {
    case 'created':
      return `Stored memory ${result.id}`;
    case 'merged_duplicate':
      return `Merged with existing memory ${result.id} (duplicate detected)`;
    case 'contradiction_resolved':
      return `Updated memory ${result.id} (contradiction resolved — new content supersedes old)`;
  }
}

export async function handleStore(engine: MemoryEngine, args: Record<string, unknown>): Promise<string> {
  const input = validateStoreInput(args);
  const result = await engine.store(input.content, {
    tags: input.tags,
    importance: input.importance,
    namespace: input.namespace,
  });
  return formatStoreResult(result);
}
