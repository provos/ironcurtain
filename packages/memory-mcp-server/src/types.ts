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
  /** FK to the source segment a `memory_ingest` fact was extracted from. NULL otherwise. */
  segment_id: string | null;
}

/** A recall-time return unit: either a fact verbatim or an expanded parent passage. */
export type ExpandMode = 'none' | 'auto' | 'parent';

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
  /** Ids of all touched rows (created + merged); empty when dry_run. */
  memory_ids: string[];

  // ---- substance ----
  /** The extracted atomic facts + their importance (always populated). */
  facts: import('./storage/extraction.js').ExtractedFact[];

  // ---- diagnostics ----
  /** Number of LLM windows used (omitted when 1). */
  chunks?: number;
  /**
   * Chunks that FAILED extraction — returned `null` (no LLM / hard error / unparseable).
   * A parsed empty array `[]` is a valid "nothing durable" result, NOT a failed chunk.
   * Omitted when 0.
   */
  failed_chunks?: number;
  /** True when we fell back to single-blob store, OR a partial failure occurred. */
  degraded?: boolean;
  /** True when SOME (not all) chunks failed but others produced facts. */
  partial?: boolean;
  /** True when on_extraction_failure='skip' wrote nothing. */
  skipped?: boolean;

  /** Count of `segments` rows written (omitted when 0 / dry_run). */
  segments_created?: number;
}

export interface RecallOptions {
  query: string;
  token_budget?: number;
  tags?: string[];
  format?: import('./retrieval/formatting.js').FormatMode;
  /**
   * Parent re-expansion mode (§5.2), default `'auto'`:
   *   - `'auto'`   — expand a parent when ≥2 kept facts share it (the shared-parent signature);
   *   - `'none'`   — force off (byte-for-byte today's facts-only behavior);
   *   - `'parent'` — force-expand the parent of every kept fact that has one.
   */
  expand?: ExpandMode;
  /** Cap on returned expanded passages across the whole result (§5.4). Default 2. */
  max_expand_passages?: number;
}

export interface RecallResult {
  content: string;
  memories_used: number;
  total_matches: number;
  /** True when any returned unit was an expanded parent passage (every format). */
  expanded?: boolean;
  /** The segment_ids that were expanded (every format; omitted/[] when none). */
  expanded_segment_ids?: string[];
}

/** Result of `memory_expand`: the parent segment's query-ranked passages. */
export interface ExpandResult {
  segment_id: string;
  /** Query-ranked passages of the parent (or whole-segment passages when no query). */
  passages: string[];
  /** False when the segment_id has no segment row (forgotten/never-ingested parent). */
  found: boolean;
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
