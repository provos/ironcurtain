/**
 * Corpus representativeness diagnostic.
 *
 * Answers ONE question with a GO/NO-GO verdict: is this corpus non-degenerate
 * enough that evolving the composite retrieval scorer is meaningful — i.e. are
 * the metadata signals (recency, importance) ALIVE and do they actively reshape
 * rankings, unlike the LoCoMo benchmark where flat metadata (importance ≡ 0.5,
 * identical created_at) made those terms dead weight?
 *
 * Three analyses, then a verdict:
 *   A. Distributional liveness — real db, READ-ONLY SQL. No LLM, no retrieval.
 *   B. Self-supervised recall probe — Haiku question generation + the REAL
 *      hybrid candidate pool, run on a COPY of the db so the real corpus stays
 *      pristine (retrieval mutates access stats). Emits a CONTENT-FREE fixture.
 *   C. Verdict — GO iff recency_live AND importance_live AND reshapes_rankings.
 *
 * Run with tsx, loading .env for ANTHROPIC_API_KEY:
 *   npx tsx --import dotenv/config scripts/memory-corpus/diagnose-corpus.ts
 *
 * SENSITIVE DATA: the corpus DB holds private conversation facts. This driver
 * NEVER writes fact/query text to stdout, logs, the fixture, or the report —
 * only opaque ids and numeric signals. The fixture and report live under the
 * gitignored `donotcommit/`. See scripts/memory-corpus/README.md.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import { loadConfig } from '../../packages/memory-mcp-server/src/config.js';
import type { MemoryConfig } from '../../packages/memory-mcp-server/src/config.js';
import { initDatabase } from '../../packages/memory-mcp-server/src/storage/database.js';
import type { MemoryRow } from '../../packages/memory-mcp-server/src/storage/database.js';
import { vectorSearch, ftsSearch } from '../../packages/memory-mcp-server/src/storage/queries.js';
import { hybridScoreFusion } from '../../packages/memory-mcp-server/src/retrieval/scoring.js';
import { embedQuery } from '../../packages/memory-mcp-server/src/embedding/embedder.js';
import { llmComplete } from '../../packages/memory-mcp-server/src/llm/client.js';

import { requireValue, parsePositiveInt, wireMemoryLlmEnv } from './corpus-lib.js';
import {
  summarizeRecency,
  summarizeImportance,
  summarizeNumeric,
  percentiles,
  histogram,
  recallTable,
  meanCompositeVsFusionTau,
  stratifiedSample,
  mulberry32,
  evaluateVerdict,
  SINGLE_SIGNAL_VARIANTS,
  type FixtureQuery,
  type FixtureCandidate,
  type SampleRow,
  type RecencySummary,
  type ImportanceSummary,
  type NumericSummary,
  type VerdictResult,
} from './diagnose-lib.js';

// ---------- CLI ----------

interface DiagnoseArgs {
  dbPath: string;
  namespace: string;
  sample: number;
  budget: number;
  seed: number;
  help: boolean;
}

const DEFAULTS = {
  dbPath: 'donotcommit/corpus/memories.memdb',
  namespace: 'claude-export',
  sample: 120,
  budget: 300,
  seed: 1,
};

function parseArgs(argv: readonly string[]): DiagnoseArgs {
  const args: DiagnoseArgs = { ...DEFAULTS, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--db':
        args.dbPath = requireValue(argv, (i += 1), flag);
        break;
      case '--namespace':
        args.namespace = requireValue(argv, (i += 1), flag);
        break;
      case '--sample':
        args.sample = parsePositiveInt(requireValue(argv, (i += 1), flag), flag);
        break;
      case '--budget':
        args.budget = parsePositiveInt(requireValue(argv, (i += 1), flag), flag);
        break;
      case '--seed':
        args.seed = parseIntFlag(requireValue(argv, (i += 1), flag), flag);
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }
  return args;
}

function parseIntFlag(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`Flag ${flag} requires an integer, got: ${raw}`);
  return n;
}

function printHelp(): void {
  process.stdout.write(
    [
      'diagnose-corpus — representativeness diagnostic for a memory corpus (GO/NO-GO)',
      '',
      'Answers: are the metadata signals (recency, importance) ALIVE and do they',
      'reshape rankings — i.e. is evolving the composite scorer meaningful on this',
      'corpus, unlike the flat-metadata LoCoMo benchmark?',
      '',
      'Usage: tsx --import dotenv/config scripts/memory-corpus/diagnose-corpus.ts [flags]',
      '',
      'Flags:',
      `  --db <path>          corpus memdb (default ${DEFAULTS.dbPath})`,
      `  --namespace <name>   memory namespace (default ${DEFAULTS.namespace})`,
      `  --sample <N>         probe sample size, stratified by recency (default ${DEFAULTS.sample})`,
      `  --budget <tokens>    recall@token-budget (default ${DEFAULTS.budget}, matches evolve dogfood)`,
      `  --seed <int>         deterministic sampling seed (default ${DEFAULTS.seed})`,
      '  -h, --help           show this help',
      '',
      'Part A (distributional stats) reads the real db READ-ONLY and needs no LLM.',
      'Part B (recall probe) copies the db to a temp path, embeds Haiku-generated',
      'questions, and needs ANTHROPIC_API_KEY (load via --import dotenv/config).',
      '',
      'Artifacts (content-free, under gitignored donotcommit/):',
      '  donotcommit/corpus/diagnostic-fixture.jsonl   per-query candidate signals',
      '  donotcommit/corpus/diagnostic-report.json     aggregate verdict numbers',
      '',
    ].join('\n'),
  );
}

// ---------- Config ----------

/** Wire MEMORY_* env so the engine helpers (embedder, LLM client) load Haiku. */
function buildConfig(args: DiagnoseArgs): MemoryConfig {
  wireMemoryLlmEnv(args.namespace);
  return loadConfig();
}

// ---------- Part A: distributional stats (real db, READ-ONLY) ----------

interface RawSignals {
  ids: string[];
  createdAt: number[];
  importance: number[];
  accessCount: number[];
  contentLength: number[];
}

/** Pull the raw per-row signal arrays. READ-ONLY: only SELECT, never mutates. */
function readRawSignals(db: Database.Database, namespace: string): RawSignals {
  const rows = db
    .prepare(
      `SELECT id, created_at, importance, access_count, length(content) AS content_length
         FROM memories WHERE namespace = ?`,
    )
    .all(namespace) as Array<{
    id: string;
    created_at: number;
    importance: number;
    access_count: number;
    content_length: number;
  }>;
  return {
    ids: rows.map((r) => r.id),
    createdAt: rows.map((r) => r.created_at),
    importance: rows.map((r) => r.importance),
    accessCount: rows.map((r) => r.access_count),
    contentLength: rows.map((r) => r.content_length),
  };
}

interface DistributionalReport {
  rowCount: number;
  recency: RecencySummary;
  importance: ImportanceSummary;
  access: { numeric: NumericSummary; histogram: Record<string, number>; allZero: boolean };
  contentLength: { numeric: NumericSummary; percentiles: Record<string, number | null> };
}

function summarizeDistribution(raw: RawSignals): DistributionalReport {
  const accessNumeric = summarizeNumeric(raw.accessCount);
  return {
    rowCount: raw.ids.length,
    recency: summarizeRecency(raw.createdAt),
    importance: summarizeImportance(raw.importance),
    access: {
      numeric: accessNumeric,
      histogram: histogram(raw.accessCount, 1, 0, 0),
      allZero: accessNumeric.max === 0 || accessNumeric.max === null,
    },
    contentLength: {
      numeric: summarizeNumeric(raw.contentLength),
      percentiles: percentiles(raw.contentLength, [0, 0.25, 0.5, 0.75, 0.9, 1]),
    },
  };
}

// ---------- Part B: recall probe (db COPY) ----------

const DEFAULT_CANDIDATE_LIMIT = 50;
const MAX_VECTOR_DISTANCE = 0.9;

/** Copy the memdb (+ WAL/SHM sidecars if present) into a temp dir; return the copy path. */
function copyDbToTemp(dbPath: string): { copyPath: string; tempDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), 'corpus-diag-'));
  const copyPath = join(tempDir, 'corpus-copy.memdb');
  copyFileSync(dbPath, copyPath);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copyPath + suffix);
  }
  return { copyPath, tempDir };
}

/** Open a db read-only with the sqlite-vec extension loaded (for vector_distance_cosine). */
function openReadOnly(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  sqliteVec.load(db);
  return db;
}

const QUESTION_SYSTEM_PROMPT =
  'Given a single fact, output ONLY a short, natural question that a user might ask ' +
  'which this fact answers. No preamble, no quotes, no explanation — just the question.';

/**
 * One Haiku call: fact text in, a natural question out. Returns null on failure
 * or when no LLM is configured. `llmComplete` already returns null on error and
 * logs only a PII-safe error shape (never the fact prompt or SDK body).
 */
async function generateQuestion(config: MemoryConfig, factContent: string): Promise<string | null> {
  const q = await llmComplete(config, QUESTION_SYSTEM_PROMPT, factContent, { maxTokens: 60 });
  return q?.trim() || null;
}

/**
 * Build the CONTENT-FREE candidate pool for a query by running the REAL hybrid
 * retrieval (vector KNN + FTS5 + production fusion). We call the search/fusion
 * helpers directly rather than `recall()` so that (a) nothing mutates access
 * stats and (b) only numeric signals — never content — leave this function.
 */
function buildCandidatePool(
  db: Database.Database,
  namespace: string,
  queryEmbedding: Float32Array,
  queryText: string,
  goldId: string,
): FixtureCandidate[] {
  const vectorResults = vectorSearch(db, namespace, queryEmbedding, DEFAULT_CANDIDATE_LIMIT).filter(
    (r) => r.distance < MAX_VECTOR_DISTANCE,
  );
  const ftsResults = ftsSearch(db, namespace, queryText, DEFAULT_CANDIDATE_LIMIT);

  const all = new Map<string, MemoryRow>();
  for (const m of vectorResults) all.set(m.id, m);
  for (const m of ftsResults) all.set(m.id, m);

  const distanceById = new Map(vectorResults.map((r) => [r.id, r.distance]));
  const bm25ById = new Map(ftsResults.map((r) => [r.id, r.bm25_score]));

  // Fuse only to confirm the pool is well-formed; the fixture stores raw signals,
  // and the pure lib re-derives fusion from them at analysis time.
  hybridScoreFusion(vectorResults, ftsResults, all);

  const candidates: FixtureCandidate[] = [];
  for (const [id, m] of all) {
    candidates.push({
      id,
      is_gold: id === goldId,
      vector_distance: distanceById.get(id),
      bm25_score: bm25ById.get(id),
      created_at: m.created_at,
      last_accessed_at: m.last_accessed_at,
      access_count: m.access_count,
      importance: m.importance,
      content_length: m.content.length,
    });
  }
  return candidates;
}

/** Read a sampled fact's content from the COPY db (content stays local, never persisted). */
function readContent(db: Database.Database, namespace: string, id: string): string | null {
  const row = db.prepare(`SELECT content FROM memories WHERE namespace = ? AND id = ?`).get(namespace, id) as
    | { content: string }
    | undefined;
  return row?.content ?? null;
}

interface ProbeResult {
  queries: FixtureQuery[];
  generated: number;
  skipped: number;
}

/**
 * Run the self-supervised probe on the db COPY: for each sampled fact, generate
 * a question (Haiku), retrieve the candidate pool, and record a content-free
 * fixture row. Appends each row to the fixture file as it goes.
 */
async function runRecallProbe(
  db: Database.Database,
  config: MemoryConfig,
  sampleIds: readonly string[],
  fixturePath: string,
): Promise<ProbeResult> {
  writeFileSync(fixturePath, '');
  const queries: FixtureQuery[] = [];
  let generated = 0;
  let skipped = 0;

  for (let i = 0; i < sampleIds.length; i += 1) {
    const goldId = sampleIds[i];
    const content = readContent(db, config.namespace, goldId);
    if (content === null) {
      skipped += 1;
      continue;
    }

    const question = await generateQuestion(config, content);
    if (question === null) {
      skipped += 1;
      continue;
    }

    const queryEmbedding = await embedQuery(question, config);
    const candidates = buildCandidatePool(db, config.namespace, queryEmbedding, question, goldId);

    const query: FixtureQuery = { query_id: `probe-${i}`, gold_id: goldId, candidates };
    queries.push(query);
    appendFileSync(fixturePath, `${JSON.stringify(query)}\n`);
    generated += 1;

    if ((i + 1) % 20 === 0) {
      process.stderr.write(`  probe ${i + 1}/${sampleIds.length} (generated=${generated} skipped=${skipped})\n`);
    }
  }

  return { queries, generated, skipped };
}

// ---------- Report assembly + printing ----------

interface FullReport {
  meta: {
    namespace: string;
    sample_requested: number;
    sample_probed: number;
    budget: number;
    seed: number;
    generated_at: string;
  };
  distributional: DistributionalReport;
  probe: {
    recall_at_budget: Record<string, number>;
    composite_vs_fusion_tau: number;
    not_single_signal_confound: boolean;
    single_signal_variants: readonly string[];
  };
  verdict: VerdictResult;
}

function fmt(n: number | null, digits = 3): string {
  return n === null ? 'n/a' : n.toFixed(digits);
}

function fmtTime(epochMs: number | null): string {
  return epochMs === null ? 'n/a' : new Date(epochMs).toISOString();
}

function printReport(report: FullReport): void {
  const { distributional: d, probe: p, verdict: v } = report;
  const out: string[] = [];
  out.push('');
  out.push('===== CORPUS REPRESENTATIVENESS DIAGNOSTIC =====');
  out.push(`namespace:            ${report.meta.namespace}`);
  out.push(`rows:                 ${d.rowCount}`);
  out.push(`sample probed:        ${report.meta.sample_probed} / ${report.meta.sample_requested} requested`);
  out.push(`budget:               ${report.meta.budget} tokens   seed: ${report.meta.seed}`);
  out.push('');

  out.push('--- A. Recency ---');
  out.push(`  span:               ${fmtTime(d.recency.numeric.min)} → ${fmtTime(d.recency.numeric.max)}`);
  out.push(`  span days:          ${fmt(d.recency.spanDays, 1)}`);
  out.push(`  distinct yr-months: ${d.recency.distinctYearMonths}`);
  out.push(
    `  stddev (days):      ${fmt(d.recency.numeric.stddev === null ? null : d.recency.numeric.stddev / 86400000, 1)}`,
  );
  out.push(`  fraction by year:   ${formatFractionMap(d.recency.fractionByYear)}`);
  out.push(`  histogram (quarter):${formatCountMap(d.recency.histogramByQuarter)}`);

  out.push('--- A. Importance ---');
  out.push(
    `  min/max/mean:       ${fmt(d.importance.numeric.min)} / ${fmt(d.importance.numeric.max)} / ${fmt(d.importance.numeric.mean)}`,
  );
  out.push(`  stddev:             ${fmt(d.importance.numeric.stddev)}`);
  out.push(`  distinct values:    ${d.importance.distinctValues}`);
  out.push(`  fraction at 0.5:    ${fmt(d.importance.fractionAtSeed)}`);
  out.push(`  histogram (0.1):    ${formatCountMap(d.importance.histogram)}`);

  out.push('--- A. Access (LATENT — zero until the corpus is queried) ---');
  out.push(
    `  min/max/mean:       ${fmt(d.access.numeric.min)} / ${fmt(d.access.numeric.max)} / ${fmt(d.access.numeric.mean)}`,
  );
  out.push(
    `  all zero:           ${d.access.allZero} ${d.access.allZero ? '(expected on a fresh corpus — not a failure)' : ''}`,
  );

  out.push('--- A. Content length (atomicity sanity) ---');
  out.push(
    `  min/max/mean:       ${fmt(d.contentLength.numeric.min, 0)} / ${fmt(d.contentLength.numeric.max, 0)} / ${fmt(d.contentLength.numeric.mean, 0)}`,
  );
  out.push(`  percentiles:        ${formatPercentiles(d.contentLength.percentiles)}`);

  out.push('');
  out.push('--- B. Recall@budget by ranking variant ---');
  for (const [variant, recall] of Object.entries(p.recall_at_budget)) {
    out.push(`  ${variant.padEnd(18)}${fmt(recall)}`);
  }
  out.push(`  composite vs fusion Kendall-tau: ${fmt(p.composite_vs_fusion_tau)}`);
  out.push(`  composite ≥ every single-signal baseline (confound check): ${p.not_single_signal_confound}`);

  out.push('');
  out.push('--- Thresholds ---');
  out.push(`  distinct year-months ≥ ${v.thresholds.minDistinctYearMonths}`);
  out.push(`  recency stddev (days) ≥ ${v.thresholds.minRecencyStddevDays}`);
  out.push(`  importance stddev ≥ ${v.thresholds.minImportanceStddev}`);
  out.push(`  fraction at 0.5 < ${v.thresholds.maxFractionAtSeed}`);
  out.push(`  composite-vs-fusion tau < ${v.thresholds.maxReshapeTau}`);

  out.push('');
  out.push('--- C. Verdict ---');
  out.push(`  recency_live:               ${v.recencyLive}`);
  out.push(`  importance_live:            ${v.importanceLive}`);
  out.push(`  reshapes_rankings:          ${v.reshapesRankings}`);
  out.push(`  not_single_signal_confound: ${v.notSingleSignalConfound} (supporting evidence)`);
  if (!v.go) out.push(`  failed conditions:          ${v.failedConditions.join(', ')}`);
  out.push('');
  out.push(`  >>> ${v.go ? 'GO' : 'NO-GO'} <<<`);
  out.push('================================================');
  out.push('');
  process.stdout.write(out.join('\n'));
}

function formatFractionMap(m: Record<string, number>): string {
  return Object.entries(m)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(' ');
}

function formatCountMap(m: Record<string, number>): string {
  return Object.entries(m)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
}

function formatPercentiles(m: Record<string, number | null>): string {
  return Object.entries(m)
    .map(([k, v]) => `${k}=${v === null ? 'n/a' : Math.round(v)}`)
    .join(' ');
}

// ---------- Main ----------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const config = buildConfig(args);
  const dbPath = resolve(args.dbPath);
  if (!existsSync(dbPath)) {
    throw new Error(`Corpus db not found: ${dbPath} (build it first with build-corpus.ts)`);
  }
  config.dbPath = dbPath;

  const outDir = dirname(dbPath);
  mkdirSync(outDir, { recursive: true });
  const fixturePath = join(outDir, 'diagnostic-fixture.jsonl');
  const reportPath = join(outDir, 'diagnostic-report.json');

  // ---- Part A: distributional stats on the REAL db, READ-ONLY ----
  process.stderr.write('Part A: distributional stats (read-only)…\n');
  const roDb = openReadOnly(dbPath);
  let raw: RawSignals;
  try {
    raw = readRawSignals(roDb, config.namespace);
  } finally {
    roDb.close();
  }
  if (raw.ids.length === 0) {
    throw new Error(`Namespace '${config.namespace}' has no memories in ${dbPath}.`);
  }
  const distributional = summarizeDistribution(raw);

  // ---- Part B: recall probe on a COPY of the db ----
  process.stderr.write('Part B: recall probe (on a db copy)…\n');
  const sampleRows: SampleRow[] = raw.ids.map((id, i) => ({ id, created_at: raw.createdAt[i] }));
  const sampleIds = stratifiedSample(sampleRows, args.sample, mulberry32(args.seed));

  const { copyPath, tempDir } = copyDbToTemp(dbPath);
  let probe: ProbeResult;
  const copyDb = initDatabase(copyPath, config.embeddingModel);
  try {
    probe = await runRecallProbe(copyDb, config, sampleIds, fixturePath);
  } finally {
    copyDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
  if (probe.queries.length === 0) {
    throw new Error('Recall probe produced no queries (all questions failed). Cannot evaluate the verdict.');
  }

  // ---- Part C: verdict (pure logic on the fixture + distributional stats) ----
  const now = Date.now();
  const table = recallTable(probe.queries, args.budget, now);
  const tau = meanCompositeVsFusionTau(probe.queries, now);
  const verdict = evaluateVerdict({
    recency: distributional.recency,
    importance: distributional.importance,
    reshapeTau: tau,
    recallTable: table,
  });

  const report: FullReport = {
    meta: {
      namespace: config.namespace,
      sample_requested: args.sample,
      sample_probed: probe.generated,
      budget: args.budget,
      seed: args.seed,
      generated_at: new Date().toISOString(),
    },
    distributional,
    probe: {
      recall_at_budget: table,
      composite_vs_fusion_tau: tau,
      not_single_signal_confound: verdict.notSingleSignalConfound,
      single_signal_variants: SINGLE_SIGNAL_VARIANTS,
    },
    verdict,
  };

  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  printReport(report);
  process.stderr.write(`\nfixture: ${fixturePath}\nreport:  ${reportPath}\n`);
  process.exitCode = verdict.go ? 0 : 1;
}

run().catch((err: unknown) => {
  process.stderr.write(`diagnose-corpus failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
