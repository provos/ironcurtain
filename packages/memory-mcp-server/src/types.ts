/**
 * Shared types for the memory MCP server.
 * Used by both the engine layer and the MCP tool handlers.
 */

export interface Memory {
  id: string;
  namespace: string;
  content: string;
  tags: string[];
  importance: number;
  created_at: number;
  updated_at: number;
  last_accessed_at: number;
  access_count: number;
  is_compacted: boolean;
  compacted_from: string[] | null;
  source: string | null;
  metadata: Record<string, unknown> | null;
}

export interface StoreResult {
  id: string;
  action: 'created' | 'merged_duplicate' | 'contradiction_resolved';
}

export interface IngestResult {
  // ---- honest write stats ----
  /** Rows newly created (action === 'created'). */
  created: number;
  /** Facts that hit an existing row (merged_duplicate / contradiction_resolved). */
  merged: number;
  /** ALIAS for `created`, kept for back-compat of the v1 field name. */
  ingested: number;
  /** Ids of all touched rows (created + merged); empty when dry_run. */
  memory_ids: string[];

  // ---- substance ----
  /** The extracted atomic facts + their importance (always populated). */
  facts: import('./storage/extraction.js').ExtractedFact[];

  // ---- diagnostics ----
  /** Number of LLM windows used (omitted when 1). */
  chunks?: number;
  /** Chunks that returned null/[] (omitted when 0). */
  failed_chunks?: number;
  /** True when we fell back to single-blob store, OR a partial failure occurred. */
  degraded?: boolean;
  /** True when SOME (not all) chunks failed but others produced facts. */
  partial?: boolean;
  /** True when on_extraction_failure='skip' wrote nothing. */
  skipped?: boolean;
}

export interface RecallOptions {
  query: string;
  token_budget?: number;
  tags?: string[];
  format?: import('./retrieval/formatting.js').FormatMode;
}

export interface RecallResult {
  content: string;
  memories_used: number;
  total_matches: number;
}

export interface ContextOptions {
  task?: string;
  token_budget?: number;
}

export interface ForgetOptions {
  ids?: string[];
  tags?: string[];
  query?: string;
  before?: string;
  confirm?: boolean;
  dry_run?: boolean;
}

export interface ForgetResult {
  forgotten: number;
  memories?: Array<{ id: string; content: string }>;
  truncated?: boolean;
}

export interface InspectOptions {
  view?: 'stats' | 'recent' | 'important' | 'tags' | 'export';
  ids?: string[];
  limit?: number;
}

export interface MemoryStats {
  total_memories: number;
  active_memories: number;
  decayed_memories: number;
  compacted_memories: number;
  oldest_memory: string | null;
  newest_memory: string | null;
  storage_bytes: number;
  top_tags: Array<{ tag: string; count: number }>;
}
