/**
 * Corpus-build driver: ingest a claude.ai conversation export into a memory DB
 * via the `memory_ingest` (ingestBlob) path.
 *
 * Run with tsx, loading .env for ANTHROPIC_API_KEY:
 *   npx tsx --import dotenv/config scripts/memory-corpus/build-corpus.ts --limit 3
 *
 * Pattern: a single Node process that owns the DB and imports the engine
 * internals directly (mirrors the LoCoMo fixture builder). One LLM call per
 * chunk goes to Haiku; nothing else egresses.
 *
 * SENSITIVE DATA: the export and the DB hold private conversation content. This
 * driver NEVER writes conversation/fact text to logs or to the progress file —
 * only counts and opaque uuids. See scripts/memory-corpus/README.md.
 *
 * DETERMINISM: per-store maintenance (which runs DECAY) is suppressed by a very
 * high MEMORY_MAINTENANCE_INTERVAL and MEMORY_DECAY_THRESHOLD=0, so backdated
 * 2023–2024 facts are not pruned mid-bulk. A single runConsolidation runs at the
 * very end (never runMaintenance). See the README for the rationale.
 */

import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type Database from 'better-sqlite3';

import { loadConfig } from '../../packages/memory-mcp-server/src/config.js';
import type { MemoryConfig } from '../../packages/memory-mcp-server/src/config.js';
import { initDatabase } from '../../packages/memory-mcp-server/src/storage/database.js';
import { ingestBlob } from '../../packages/memory-mcp-server/src/engine-impl.js';
import { runConsolidation } from '../../packages/memory-mcp-server/src/storage/consolidation.js';
import { getNamespaceStats } from '../../packages/memory-mcp-server/src/storage/queries.js';

import {
  parseArgs,
  assembleTranscript,
  isEmptyConversation,
  buildSource,
  resolveAsOf,
  buildProgressRecord,
  buildEmptyProgressRecord,
  computeResumeSet,
  type CliArgs,
  type ExportConversation,
  type ProgressRecord,
} from './corpus-lib.js';

// ---------- Config setup ----------

/**
 * Set the MEMORY_* env vars the engine reads, then load config. Requires
 * ANTHROPIC_API_KEY (we REQUIRE the LLM for the corpus — no silent degrade).
 */
function buildConfig(args: CliArgs): MemoryConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required (the corpus needs the LLM). ' +
        'Run with `--import dotenv/config` or export it in the environment.',
    );
  }

  process.env.MEMORY_LLM_BASE_URL = 'https://api.anthropic.com/v1/';
  process.env.MEMORY_LLM_API_KEY = apiKey;
  process.env.MEMORY_LLM_MODEL = process.env.MEMORY_LLM_MODEL ?? 'claude-haiku-4-5-20251001';
  process.env.MEMORY_DB_PATH = resolve(args.dbPath);
  process.env.MEMORY_NAMESPACE = args.namespace;
  // Determinism: never let per-store maintenance (which runs DECAY) fire mid-bulk.
  process.env.MEMORY_MAINTENANCE_INTERVAL = '100000000';
  process.env.MEMORY_DECAY_THRESHOLD = '0';
  process.env.MEMORY_RERANKER_ENABLED = 'false';

  return loadConfig();
}

// ---------- Export loading ----------

function loadExport(exportPath: string): ExportConversation[] {
  const raw = readFileSync(resolve(exportPath), 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Export is not a top-level JSON array of conversations.');
  }
  return parsed as ExportConversation[];
}

/**
 * Apply the --conversation / --limit selection. --conversation wins and selects
 * exactly one conversation; --limit caps the count of NON-EMPTY conversations.
 */
function selectConversations(conversations: ExportConversation[], args: CliArgs): ExportConversation[] {
  if (args.conversation !== undefined) {
    return conversations.filter((conv) => conv.uuid === args.conversation);
  }
  if (args.limit === undefined) {
    return conversations;
  }
  const selected: ExportConversation[] = [];
  for (const conv of conversations) {
    if (selected.filter((c) => !isEmptyConversation(c)).length >= args.limit) break;
    selected.push(conv);
  }
  return selected;
}

// ---------- Progress file (content-free) ----------

function loadProgressRecords(progressPath: string): ProgressRecord[] {
  if (!existsSync(progressPath)) return [];
  const lines = readFileSync(progressPath, 'utf-8').split('\n');
  const records: ProgressRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    records.push(JSON.parse(trimmed) as ProgressRecord);
  }
  return records;
}

function appendProgress(progressPath: string, record: ProgressRecord): void {
  appendFileSync(progressPath, `${JSON.stringify(record)}\n`);
}

// ---------- Direct-DB stats (content-free) ----------

interface CorpusStats {
  importanceMin: number | null;
  importanceMax: number | null;
  importanceMean: number | null;
  createdAtMin: number | null;
  createdAtMax: number | null;
}

/** Query importance + created_at spread directly — proves the corpus is non-flat. */
function queryCorpusStats(db: Database.Database, namespace: string): CorpusStats {
  const row = db
    .prepare(
      `SELECT MIN(importance) AS impMin, MAX(importance) AS impMax, AVG(importance) AS impMean,
              MIN(created_at) AS createdMin, MAX(created_at) AS createdMax
         FROM memories WHERE namespace = ?`,
    )
    .get(namespace) as {
    impMin: number | null;
    impMax: number | null;
    impMean: number | null;
    createdMin: number | null;
    createdMax: number | null;
  };
  return {
    importanceMin: row.impMin,
    importanceMax: row.impMax,
    importanceMean: row.impMean,
    createdAtMin: row.createdMin,
    createdAtMax: row.createdMax,
  };
}

// ---------- Per-conversation ingest ----------

interface RunTotals {
  processed: number;
  skippedEmpty: number;
  skippedFailed: number;
  partial: number;
  created: number;
  merged: number;
}

async function ingestConversation(
  db: Database.Database,
  config: MemoryConfig,
  conv: ExportConversation,
  dryRun: boolean,
  progressPath: string,
  totals: RunTotals,
  position: string,
): Promise<void> {
  const transcript = assembleTranscript(conv);
  const asOf = resolveAsOf(conv.created_at);
  if (asOf === undefined) {
    process.stderr.write(`${position} ${conv.uuid.slice(0, 8)} → WARNING: unparseable created_at, using now()\n`);
  }
  const result = await ingestBlob(db, config, transcript, {
    mode: 'document',
    as_of: asOf,
    source: buildSource(conv.uuid),
    tags: ['claude-export'],
    on_extraction_failure: 'skip',
    dry_run: dryRun,
  });

  const record = buildProgressRecord(conv.uuid, result);
  appendProgress(progressPath, record);

  totals.processed += 1;
  totals.created += result.created;
  totals.merged += result.merged;
  if (record.status === 'skipped-failed') totals.skippedFailed += 1;
  if (record.status === 'partial') totals.partial += 1;

  logProgress(position, conv.uuid, result.created, result.merged);
}

function logProgress(position: string, uuid: string, created: number, merged: number): void {
  // Content-free: uuid PREFIX only, no names/text.
  process.stderr.write(`${position} ${uuid.slice(0, 8)} → created=${created} merged=${merged}\n`);
}

// ---------- Main ----------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const config = buildConfig(args);
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const progressPath = resolve(dirname(config.dbPath), 'progress.jsonl');

  const priorRecords = loadProgressRecords(progressPath);
  const dbExists = existsSync(config.dbPath);
  if (!args.resume && dbExists && priorRecords.length > 0) {
    process.stderr.write('WARNING: db/progress already exist and --resume not set; appending to existing corpus.\n');
  }
  const resumeSkip = args.resume ? computeResumeSet(priorRecords) : new Set<string>();

  const allConversations = loadExport(args.exportPath);
  const selected = selectConversations(allConversations, args);

  const db = initDatabase(config.dbPath, config.embeddingModel);
  const startMs = Date.now();
  const totals: RunTotals = { processed: 0, skippedEmpty: 0, skippedFailed: 0, partial: 0, created: 0, merged: 0 };

  try {
    for (let i = 0; i < selected.length; i += 1) {
      const conv = selected[i];
      const position = `[${i + 1}/${selected.length}]`;

      if (args.resume && resumeSkip.has(conv.uuid)) {
        process.stderr.write(`${position} ${conv.uuid.slice(0, 8)} → skip (already done)\n`);
        continue;
      }

      if (isEmptyConversation(conv)) {
        appendProgress(progressPath, buildEmptyProgressRecord(conv.uuid));
        totals.skippedEmpty += 1;
        process.stderr.write(`${position} ${conv.uuid.slice(0, 8)} → skip (empty)\n`);
        continue;
      }

      await ingestConversation(db, config, conv, args.dryRun, progressPath, totals, position);
    }

    if (!args.dryRun) {
      const summary = await runConsolidation(db, config);
      process.stderr.write(
        `consolidation: consolidated=${summary.consolidated} merged=${summary.merged} superseded=${summary.superseded}\n`,
      );
    }

    printSummary(db, config, selected.length, totals, startMs, args.dryRun);
  } finally {
    db.close();
  }
}

function printSummary(
  db: Database.Database,
  config: MemoryConfig,
  total: number,
  totals: RunTotals,
  startMs: number,
  dryRun: boolean,
): void {
  const stats = queryCorpusStats(db, config.namespace);
  const namespaceTotal = getNamespaceStats(db, config.namespace).total_memories;
  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);

  const lines = [
    '',
    '===== CORPUS BUILD SUMMARY =====',
    `dry_run:              ${dryRun}`,
    `conversations total:  ${total}`,
    `  processed:          ${totals.processed}`,
    `  skipped-empty:      ${totals.skippedEmpty}`,
    `  skipped-failed:     ${totals.skippedFailed}`,
    `  partial:            ${totals.partial}`,
    `memories created:     ${totals.created}`,
    `memories merged:      ${totals.merged}`,
    `namespace total rows: ${namespaceTotal}`,
    `importance min/max/mean: ${fmt(stats.importanceMin)} / ${fmt(stats.importanceMax)} / ${fmt(stats.importanceMean)}`,
    `created_at min/max:   ${fmtTime(stats.createdAtMin)} / ${fmtTime(stats.createdAtMax)}`,
    `elapsed seconds:      ${elapsedSec}`,
    '================================',
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
}

function fmt(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

function fmtTime(epochMs: number | null): string {
  return epochMs === null ? 'n/a' : new Date(epochMs).toISOString();
}

function printHelp(): void {
  process.stdout.write(
    [
      'build-corpus — ingest a claude.ai conversation export into a memory DB',
      '',
      'Usage: tsx --import dotenv/config scripts/memory-corpus/build-corpus.ts [flags]',
      '',
      'Flags:',
      '  --export <path>        export JSON (default donotcommit/claude-export/conversations.json)',
      '  --db <path>            output memdb (default donotcommit/corpus/memories.memdb)',
      '  --namespace <name>     memory namespace (default claude-export)',
      '  --limit <N>            process only first N non-empty conversations',
      '  --conversation <uuid>  process only that conversation',
      '  --dry-run              extract but write nothing (still egresses to Haiku)',
      '  --resume               skip conversations already recorded done; retry failed',
      '  -h, --help             show this help',
      '',
      'Requires ANTHROPIC_API_KEY (load via --import dotenv/config).',
      '',
    ].join('\n'),
  );
}

run().catch((err: unknown) => {
  process.stderr.write(`build-corpus failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
