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

export interface RecallOptions {
  query: string;
  token_budget?: number;
  tags?: string[];
  format?: 'summary' | 'list' | 'raw';
  namespace?: string;
}

export interface RecallResult {
  content: string;
  memories_used: number;
  total_matches: number;
}

export interface ContextOptions {
  task?: string;
  token_budget?: number;
  namespace?: string;
}

export interface ForgetOptions {
  ids?: string[];
  tags?: string[];
  query?: string;
  before?: string;
  confirm?: boolean;
  dry_run?: boolean;
  namespace?: string;
}

export interface ForgetResult {
  forgotten: number;
  memories?: Array<{ id: string; content: string }>;
}

export interface InspectOptions {
  view?: 'stats' | 'recent' | 'important' | 'tags' | 'export';
  ids?: string[];
  limit?: number;
  namespace?: string;
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
