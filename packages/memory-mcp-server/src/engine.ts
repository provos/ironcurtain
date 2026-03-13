/**
 * Engine interface that the MCP tool handlers call.
 * The actual implementation (engine-impl.ts) wires together
 * storage, retrieval, embedding, and LLM modules.
 */

import type {
  StoreResult,
  RecallOptions,
  RecallResult,
  ContextOptions,
  ForgetOptions,
  ForgetResult,
  InspectOptions,
  Memory,
  MemoryStats,
} from './types.js';

export interface StoreOptions {
  tags?: string[];
  importance?: number;
}

export interface MemoryEngine {
  store(content: string, opts: StoreOptions): Promise<StoreResult>;
  recall(opts: RecallOptions): Promise<RecallResult>;
  context(opts: ContextOptions): Promise<string>;
  forget(opts: ForgetOptions): Promise<ForgetResult>;
  inspect(opts: InspectOptions): Promise<MemoryStats | Memory[] | string>;
  close(): void;
}
