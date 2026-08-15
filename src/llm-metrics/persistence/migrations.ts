import type { DatabaseSync } from 'node:sqlite';

export const LLM_METRICS_SCHEMA_VERSION = 1;

/**
 * The first metrics schema is intentionally column-oriented. Request and
 * response payloads never cross this boundary, and there is no catch-all JSON
 * column that could accidentally retain content.
 */
const MIGRATION_1 = `
  CREATE TABLE IF NOT EXISTS llm_process_runs (
    process_run_id TEXT PRIMARY KEY,
    started_at_ms INTEGER NOT NULL,
    last_checkpoint_at_ms INTEGER NOT NULL,
    observed_count INTEGER NOT NULL DEFAULT 0,
    finalized_count INTEGER NOT NULL DEFAULT 0,
    enqueued_count INTEGER NOT NULL DEFAULT 0,
    clean_ended_at_ms INTEGER
  ) STRICT;

  CREATE TABLE IF NOT EXISTS llm_exchanges (
    ingestion_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange_id TEXT NOT NULL UNIQUE,
    schema_version INTEGER NOT NULL,
    completed_at_ms INTEGER NOT NULL,
    request_received_at_ms INTEGER NOT NULL,

    session_id TEXT,
    turn_id TEXT,
    agent_conversation_id TEXT,
    bundle_id TEXT,
    workflow_run_id TEXT,
    state_id TEXT,
    persona_id TEXT,
    attribution_quality TEXT NOT NULL,

    agent_name TEXT,
    logical_provider TEXT NOT NULL,
    provider_profile_id TEXT,
    protocol TEXT NOT NULL,
    gateway_kind TEXT NOT NULL,
    client_route_id TEXT,
    upstream_route_id TEXT,

    requested_model TEXT,
    requested_model_source TEXT NOT NULL,
    forwarded_model TEXT,
    forwarded_model_source TEXT NOT NULL,
    response_model TEXT,
    response_model_source TEXT NOT NULL,
    served_model TEXT,
    served_model_source TEXT NOT NULL,
    served_provider TEXT,
    served_provider_source TEXT NOT NULL,

    provider_request_id TEXT,
    provider_response_id TEXT,
    gateway_generation_id TEXT,

    streaming INTEGER,
    requested_service_tier TEXT,
    actual_service_tier TEXT,
    reasoning_mode TEXT,
    reasoning_effort TEXT,
    thinking_budget_tokens INTEGER,
    speed_mode TEXT,

    response_status_code INTEGER,
    termination_category TEXT NOT NULL,
    provider_stop_reason TEXT,
    refusal INTEGER,
    refusal_category TEXT,
    outcome_source TEXT NOT NULL,

    input_tokens_reported INTEGER,
    input_tokens_total INTEGER,
    input_tokens_uncached INTEGER,
    cache_read_input_tokens INTEGER,
    cache_write_input_tokens INTEGER,
    tool_use_input_tokens INTEGER,
    output_tokens_reported INTEGER,
    output_token_semantics TEXT NOT NULL,
    output_tokens_total INTEGER,
    thinking_tokens INTEGER,
    non_thinking_output_tokens INTEGER,
    provider_total_tokens INTEGER,
    canonical_total_tokens INTEGER,
    cost_usd REAL,
    usage_source TEXT,
    usage_completeness TEXT NOT NULL,
    usage_semantics_version INTEGER NOT NULL,
    input_measurement_provenance TEXT NOT NULL,
    output_measurement_provenance TEXT NOT NULL,
    thinking_measurement_provenance TEXT NOT NULL,
    non_thinking_measurement_provenance TEXT NOT NULL,

    request_body_complete_offset_ms REAL,
    response_headers_offset_ms REAL,
    first_upstream_body_byte_offset_ms REAL,
    first_protocol_event_offset_ms REAL,
    first_reasoning_offset_ms REAL,
    last_reasoning_offset_ms REAL,
    first_output_offset_ms REAL,
    last_output_offset_ms REAL,
    protocol_terminal_offset_ms REAL,
    upstream_response_end_offset_ms REAL,
    client_delivery_end_offset_ms REAL,
    client_delivery_status TEXT NOT NULL,

    quality_flags_json TEXT NOT NULL,
    process_run_id TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS llm_transport_attempts (
    exchange_id TEXT NOT NULL REFERENCES llm_exchanges(exchange_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    started_offset_ms REAL NOT NULL,
    ended_offset_ms REAL,
    status_code INTEGER,
    outcome TEXT NOT NULL,
    PRIMARY KEY (exchange_id, ordinal)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS llm_gateway_route_attempts (
    exchange_id TEXT NOT NULL REFERENCES llm_exchanges(exchange_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    provider TEXT,
    model TEXT,
    status_code INTEGER,
    selected INTEGER,
    source TEXT NOT NULL,
    PRIMARY KEY (exchange_id, ordinal)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS llm_metrics_gaps (
    process_run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    window_started_at_ms INTEGER NOT NULL,
    window_ended_at_ms INTEGER NOT NULL,
    occurrence_count INTEGER NOT NULL,
    PRIMARY KEY (process_run_id, kind, window_started_at_ms)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS llm_maintenance_leases (
    lease_name TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS llm_exchanges_completed_idx
    ON llm_exchanges (completed_at_ms DESC, exchange_id DESC);
  CREATE INDEX IF NOT EXISTS llm_exchanges_session_idx
    ON llm_exchanges (session_id, completed_at_ms DESC, exchange_id DESC);
  CREATE INDEX IF NOT EXISTS llm_exchanges_provider_model_idx
    ON llm_exchanges (logical_provider, served_model, completed_at_ms DESC);
  CREATE INDEX IF NOT EXISTS llm_exchanges_protocol_idx
    ON llm_exchanges (protocol, completed_at_ms DESC);
`;

const MIGRATIONS: Readonly<Partial<Record<number, string>>> = {
  1: MIGRATION_1,
};

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
  const value = row?.user_version;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid SQLite user_version');
  }
  return value;
}

/**
 * Applies additive migrations while holding SQLite's cross-process write lock.
 * The version is re-read after BEGIN IMMEDIATE so concurrent starters cannot
 * both apply the same migration.
 */
export function migrateLlmMetricsDatabase(database: DatabaseSync): number {
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  let version = readUserVersion(database);
  if (version > LLM_METRICS_SCHEMA_VERSION) {
    throw new Error(
      `LLM metrics database schema ${version} is newer than supported schema ${LLM_METRICS_SCHEMA_VERSION}`,
    );
  }

  while (version < LLM_METRICS_SCHEMA_VERSION) {
    database.exec('BEGIN IMMEDIATE');
    try {
      version = readUserVersion(database);
      if (version > LLM_METRICS_SCHEMA_VERSION) {
        throw new Error(
          `LLM metrics database schema ${version} is newer than supported schema ${LLM_METRICS_SCHEMA_VERSION}`,
        );
      }
      if (version === LLM_METRICS_SCHEMA_VERSION) {
        database.exec('COMMIT');
        break;
      }

      const nextVersion = version + 1;
      const sql = MIGRATIONS[nextVersion];
      if (sql === undefined) {
        throw new Error(`Missing LLM metrics migration ${nextVersion}`);
      }
      database.exec(sql);
      database.exec(`PRAGMA user_version = ${nextVersion}`);
      database.exec('COMMIT');
      version = nextVersion;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the migration error; the rollback may fail when BEGIN did.
      }
      throw error;
    }
  }

  return version;
}
