/**
 * Engine interface that the MCP tool handlers call.
 * The actual implementation (engine-impl.ts) wires together
 * storage, retrieval, embedding, and LLM modules.
 */

import type {
  StoreResult,
  IngestResult,
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
  /** Provenance stamped on the row. The insert path already supports `source`. */
  source?: string;
  /**
   * Epoch ms. When set, stamps created_at/updated_at/last_accessed_at to this
   * value at insert time (the `as_of` backdate mechanism). Absent ⇒ Date.now().
   */
  createdAt?: number;
}

export interface IngestOptions {
  source?: string;
  mode?: 'conversation' | 'document';
  tags?: string[];
  /** SEED importance; per-fact importance from extraction overrides it. */
  importance?: number;
  dry_run?: boolean;
  /** Normalized to epoch ms by the handler before reaching the engine. */
  as_of?: number;
  /** How to handle a chunk/call that yields no facts. Default 'degrade'. */
  on_extraction_failure?: 'degrade' | 'skip' | 'error';
}

export interface MemoryEngine {
  store(content: string, opts: StoreOptions): Promise<StoreResult>;
  ingest(content: string, opts: IngestOptions): Promise<IngestResult>;
  recall(opts: RecallOptions): Promise<RecallResult>;
  context(opts: ContextOptions): Promise<string>;
  forget(opts: ForgetOptions): Promise<ForgetResult>;
  inspect(opts: InspectOptions): Promise<MemoryStats | Memory[] | string>;
  close(): void;
}
