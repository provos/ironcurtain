import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

// ---- Mock the LLM so extraction returns canned facts, but the REAL embedder + ----
// ---- store/segment/recall pipeline run end-to-end. Recall uses format 'list' so ----
// ---- the LLM formatter is never invoked (deterministic, no queue consumption). ----
const llmMock = vi.hoisted(() => ({
  responses: [] as Array<string | null>,
  hasLLM: true,
  calls: 0,
}));

vi.mock('../src/llm/client.js', () => ({
  getLLMClient: vi.fn(() => (llmMock.hasLLM ? {} : null)),
  llmComplete: vi.fn(async () => {
    llmMock.calls += 1;
    if (!llmMock.hasLLM) return null;
    const next = llmMock.responses.shift();
    return next === undefined ? null : next;
  }),
}));

import { initDatabase } from '../src/storage/database.js';
import type { SegmentRow } from '../src/storage/database.js';
import { getMemoriesByIds } from '../src/storage/queries.js';
import { createMemoryEngineFromConfig } from '../src/engine-impl.js';
import type { MemoryEngine } from '../src/engine.js';
import type { MemoryConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { estimateTokens } from '../src/retrieval/scoring.js';
import { rankSegmentPassages } from '../src/retrieval/expansion.js';
import { embedQuery } from '../src/embedding/embedder.js';

const NAMESPACE = 'test';

function setResponses(...responses: Array<string | null>): void {
  llmMock.responses = responses;
  llmMock.hasLLM = true;
  llmMock.calls = 0;
}

function factsJson(facts: Array<{ fact: string; importance?: number }>): string {
  return JSON.stringify(facts);
}

function testConfig(dbPath: string): MemoryConfig {
  return {
    ...loadConfig({}),
    dbPath,
    namespace: NAMESPACE,
    llmApiKey: 'test-key',
    llmBaseUrl: 'http://localhost:1234/v1',
    maintenanceInterval: 10000,
    // Determinism: the cross-encoder reranker re-orders conversational text
    // unpredictably for synthetic content; disable it so the shared-parent facts
    // reliably co-occur in the kept set. The candidate ranker is otherwise unchanged.
    rerankerEnabled: false,
  };
}

// ---- The synthetic contract segment. It contains a $250k distribution-cap clause
// ---- and an IP-rights clause that are NEVER extracted as facts — only the headline
// ---- facts below are. The clauses live only in the segment (the Bandalert shape).
// ---- Each clause section is its own coherent, ON-TOPIC paragraph (no generic
// ---- padding), long enough that the split produces DISTINCT cap / IP / NDA passages
// ---- — so split-and-rank proves it returns the query-relevant slice, not the chunk.
const REVENUE_CLAUSE =
  'Distribution and revenue. The distribution cap is $250k per year of net distribution revenue. ' +
  'Once cumulative distribution revenue exceeds that two-hundred-and-fifty-thousand-dollar ceiling, the ' +
  'revenue split shifts from seventy-thirty to fifty-fifty in the artist favor for the remainder of the year. ' +
  'The distribution cap resets every January, recoupable advances are charged against the label revenue share ' +
  'before the split is computed, and statements of distribution revenue are delivered quarterly. Streaming, ' +
  'download, physical, and synchronization revenue all count toward the distribution cap, while merchandise ' +
  'revenue and live touring income are excluded from the cap and from the distribution revenue split entirely.';

const IP_CLAUSE =
  'Intellectual property. The intellectual property in the master recordings reverts to the artist after seven ' +
  'years from release, and until reversion the label holds an exclusive license to exploit the masters. The ' +
  'artist retains all songwriting and publishing rights, all copyright in the underlying musical compositions, ' +
  'and the moral rights of authorship for the full duration of the agreement. Derivative works, remixes, and ' +
  'sampling of the master recordings require the artist written consent, and any trademark in the artist name ' +
  'and logo remains the sole intellectual property of the artist and is merely licensed to the label. The ' +
  'reversion of intellectual property is automatic and does not require any further assignment, and on reversion ' +
  'the label must deliver all master recordings, stems, and session files to the artist. Neighbouring rights ' +
  'and performer royalties in the master recordings are collected by the artist nominated society, and the ' +
  'intellectual property indemnity covers third-party infringement claims arising from the compositions.';

const NDA_CLAUSE =
  'Confidentiality. A mutual non-disclosure clause covers all financial terms, the existence of side letters, ' +
  'and any unreleased recordings for the term of the agreement plus two years after termination. Neither party ' +
  'may disclose confidential information to third parties except auditors and legal counsel under equivalent ' +
  'confidentiality obligations. Breach of the non-disclosure clause entitles the non-breaching party to ' +
  'injunctive relief, and the confidentiality obligations survive the expiry or termination of the agreement. ' +
  'The non-disclosure clause expressly designates the distribution statements and the recoupment schedule as ' +
  'confidential information, and any press release about the agreement requires the prior written approval of ' +
  'both parties. The confidentiality obligations bind employees, contractors, and affiliates of each party, and ' +
  'a residual-knowledge exception does not apply to the specifically enumerated confidential financial terms.';

const CONTRACT_SEGMENT = [
  'Contract overview. This document is the Bandalert distribution agreement between the label and the artist.',
  '',
  REVENUE_CLAUSE,
  '',
  IP_CLAUSE,
  '',
  NDA_CLAUSE,
].join('\n');

// Seven headline facts — the lossy decomposition. NONE of them states the $250k number
// or the IP-reversion mechanics; those survive only inside CONTRACT_SEGMENT.
const HEADLINE_FACTS = [
  { fact: 'The Bandalert distribution agreement is between the label and the artist', importance: 0.8 },
  { fact: 'The Bandalert agreement has a distribution revenue cap', importance: 0.7 },
  { fact: 'The Bandalert agreement specifies a revenue split that changes above the cap', importance: 0.7 },
  { fact: 'The Bandalert agreement has an intellectual property reversion clause', importance: 0.7 },
  { fact: 'The Bandalert agreement lets the artist retain publishing rights', importance: 0.6 },
  { fact: 'The Bandalert agreement contains a mutual non-disclosure clause', importance: 0.6 },
  { fact: 'The Bandalert agreement resets terms annually', importance: 0.5 },
];

describe('parent re-expansion (Bandalert contract)', () => {
  let tmpDir: string;
  let dbPath: string;
  let engine: MemoryEngine;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-expand-test-'));
    dbPath = join(tmpDir, 'test.db');
    const config = testConfig(dbPath);
    engine = createMemoryEngineFromConfig(config);
    db = initDatabase(dbPath, config.embeddingModel);
  });

  afterEach(() => {
    engine.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function ingestContract(): Promise<void> {
    setResponses(factsJson(HEADLINE_FACTS));
    const result = await engine.ingest(CONTRACT_SEGMENT, { mode: 'document' });
    // One segment, seven linked headline facts.
    expect(result.segments_created).toBe(1);
    expect(result.created).toBe(7);
  }

  it('auto-expands a shared parent BY DEFAULT (no expand arg): AUGMENTs the facts with the $250k clause that was never a fact', async () => {
    await ingestContract();

    // A DEFAULT recall — no `expand` argument at all.
    const result = await engine.recall({ query: 'Bandalert distribution agreement cap and revenue', format: 'list' });

    expect(result.expanded).toBe(true);
    // PASSAGE parent-dedup: the one shared parent contributes exactly one passage.
    expect(result.expanded_segment_ids).toHaveLength(1);

    // AUGMENT, not replace: the passage carries the $250k clause that was NEVER a fact …
    expect(result.content).toContain('$250k');
    const allHeadlineText = HEADLINE_FACTS.map((f) => f.fact).join(' ');
    expect(allHeadlineText).not.toContain('$250k'); // sanity: the clause is not a fact

    // … AND the breadth facts are PRESERVED, not collapsed into the passage. Compare
    // against expand:'none' at the SAME budget (the ranker is identical, so 'none' is
    // the breadth baseline): every fact 'none' returns is still present under 'auto'.
    // (Under the old REPLACE semantics these sibling facts were dropped — this is the
    // assertion that would have failed then.) The full superset guarantee is asserted
    // exhaustively in the breadth-preservation regression test below.
    const none = await engine.recall({
      query: 'Bandalert distribution agreement cap and revenue',
      format: 'raw',
      expand: 'none',
    });
    const noneFacts = (JSON.parse(none.content) as Array<{ content: string }>).map((i) => i.content);
    expect(noneFacts.length).toBeGreaterThan(1); // several headline facts co-retrieve
    for (const fact of noneFacts) {
      expect(result.content).toContain(fact);
    }
  });

  it('the expanded unit is a passage that fits the default 800 budget AND leaves room for ≥1 fact', async () => {
    await ingestContract();

    const result = await engine.recall({ query: 'Bandalert distribution cap revenue split', format: 'list' });

    expect(result.expanded).toBe(true);
    // Total returned tokens fit the bumped default budget (800).
    expect(estimateTokens(result.content)).toBeLessThanOrEqual(800);
    // The whole 6000-char segment would never fit — assert the returned text is
    // passage-sized, not the entire chunk.
    expect(result.content.length).toBeLessThan(CONTRACT_SEGMENT.length);
    // Out-of-the-box shape: a passage PLUS at least one supporting fact (a list line
    // that is not the expanded passage). The list separates units by newline.
    const lines = result.content.split('\n').filter((l) => l.trim().length > 0);
    const factLines = lines.filter((l) => !l.includes('$250k'));
    expect(factLines.length).toBeGreaterThanOrEqual(1);
  });

  // Raw format exposes each unit's `expanded` flag, so fact units and the appended
  // passage unit can be separated cleanly. Helpers shared by the hybrid tests below.
  const rawFactContents = (raw: { content: string }): string[] => {
    const items = JSON.parse(raw.content) as Array<{ content: string; expanded: boolean }>;
    return items.filter((i) => !i.expanded).map((i) => i.content);
  };
  const rawPassageCount = (raw: { content: string }): number => {
    const items = JSON.parse(raw.content) as Array<{ expanded: boolean }>;
    return items.filter((i) => i.expanded).length;
  };

  it('HYBRID win: at a budget facts alone would fill, the top passage is STILL guaranteed by reservation while the TOP breadth facts survive (F1 — fails under pure-AUGMENT passage-last)', async () => {
    await ingestContract();

    const query = 'Bandalert distribution agreement cap and revenue';

    // Measure the real fact + passage token sizes from a wide auto recall (the packer
    // estimates tokens off each unit's `content`).
    const autoWide = await engine.recall({ query, format: 'raw', expand: 'auto', token_budget: 4000 });
    const wideItems = JSON.parse(autoWide.content) as Array<{ content: string; expanded: boolean }>;
    const factTokens = wideItems.filter((i) => !i.expanded).map((i) => estimateTokens(i.content));
    const passageTokens = wideItems.filter((i) => i.expanded).reduce((sum, i) => sum + estimateTokens(i.content), 0);
    const allFactTokens = factTokens.reduce((a, b) => a + b, 0);
    const smallestFactTokens = Math.min(...factTokens);
    expect(wideItems.filter((i) => i.expanded).length).toBe(1); // exactly one shared parent
    expect(factTokens.length).toBeGreaterThanOrEqual(2); // ≥2 facts co-retrieve

    // Size the budget so facts ALONE would fill it (every fact fits, no spare room for a
    // passage if facts were packed first — the pure-AUGMENT skip-the-passage zone), yet
    // the reservation still fits the passage by displacing only the lowest-priority TAIL
    // fact: budget = allFactTokens + passageTokens − smallestFactTokens. Facts-first packs
    // all facts (allFactTokens ≤ budget) leaving only passageTokens − smallestFactTokens
    // of room — one token short of the passage, so pure-AUGMENT would SKIP it. Hybrid
    // reserves the passage, packs facts into budget − passageTokens (which is
    // allFactTokens − smallestFactTokens — every fact but the smallest), and force-includes
    // the passage. Require the smallest fact to be the strict minimum so exactly one is
    // displaced.
    expect(factTokens.filter((t) => t === smallestFactTokens)).toHaveLength(1);
    const budget = allFactTokens + passageTokens - smallestFactTokens;
    expect(allFactTokens).toBeLessThanOrEqual(budget); // facts alone all fit (would fill it)

    const auto = await engine.recall({ query, format: 'raw', expand: 'auto', token_budget: budget });
    const none = await engine.recall({ query, format: 'raw', expand: 'none', token_budget: budget });

    // (a) DEPTH guaranteed: the single top passage is included even though facts could
    //     have filled the budget. This is the assertion that FAILS under pure-AUGMENT
    //     (passage-last), where the passage is skipped and `expanded` is false.
    expect(auto.expanded).toBe(true);
    expect(rawPassageCount(auto)).toBe(1);
    expect(auto.content).toContain('$250k');

    // (b) BREADTH preserved: every fact EXCEPT the displaced lowest-priority tail is still
    //     present. `none` returns all facts in score order; the passage displaced only the
    //     last (lowest-priority) one, so the TOP facts (all but the last) survive under auto.
    const noneFacts = rawFactContents(none);
    const autoFacts = new Set(rawFactContents(auto));
    expect(noneFacts.length).toBeGreaterThanOrEqual(2);
    const topFacts = noneFacts.slice(0, noneFacts.length - 1); // all but the displaced tail
    for (const fact of topFacts) {
      expect(autoFacts.has(fact)).toBe(true);
    }
    // Exactly one fact was displaced to make room for the guaranteed passage.
    expect(autoFacts.size).toBe(noneFacts.length - 1);
  });

  it('no wholesale eviction: the passage displaces at most the lowest-priority tail fact(s); the facts above the tail are a SUPERSET kept (regression — passage must NOT get top priority and evict breadth)', async () => {
    await ingestContract();

    const query = 'Bandalert distribution agreement cap and revenue';

    // Generous budget: facts AND the passage all fit — auto is a strict SUPERSET of none.
    const wideBudget = 800;
    const noneWide = await engine.recall({ query, format: 'raw', expand: 'none', token_budget: wideBudget });
    const autoWide = await engine.recall({ query, format: 'raw', expand: 'auto', token_budget: wideBudget });

    const noneFacts = rawFactContents(noneWide);
    const autoFacts = new Set(rawFactContents(autoWide));
    expect(noneFacts.length).toBeGreaterThan(0); // the query genuinely retrieves facts

    // EVERY fact expand:none returns is ALSO returned under expand:auto (the superset
    // property at a budget where everything fits — auto never silently drops a breadth
    // fact). This FAILS if expansion REPLACED sibling facts with the passage, or if the
    // passage were given TOP priority and evicted breadth.
    for (const fact of noneFacts) {
      expect(autoFacts.has(fact)).toBe(true);
    }
    // … and on top of the full fact set, exactly the top passage is appended.
    expect(autoWide.expanded).toBe(true);
    expect(rawPassageCount(autoWide)).toBe(1);
    expect(autoWide.content).toContain('$250k');
  });

  it('picks the query-relevant passage (IP query → IP passage, not the cap passage)', async () => {
    await ingestContract();

    // An IP-focused query (no "Bandalert" token, which would pull the overview
    // passage). Vector search still retrieves the contract's IP headline facts.
    const result = await engine.recall({
      query: 'intellectual property reversion publishing rights master recordings',
      format: 'list',
    });

    expect(result.expanded).toBe(true);
    // Split-and-rank must choose the IP passage, not the $250k cap passage.
    expect(result.content).toContain('intellectual property');
    expect(result.content).toContain('reverts');
    expect(result.content).not.toContain('$250k');
  });

  it('a pinpoint single-fact recall does NOT expand (no regression), identical with expand:none', async () => {
    // A lone fact with its OWN single-fact segment — only one fact shares the parent.
    setResponses(factsJson([{ fact: 'The Anthropic API key env var is ANTHROPIC_API_KEY' }]));
    await engine.ingest('My Anthropic API key env var is ANTHROPIC_API_KEY.', {});

    const auto = await engine.recall({ query: 'what is the Anthropic API key variable name', format: 'list' });
    expect(auto.expanded).toBe(false);
    expect(auto.content).toContain('ANTHROPIC_API_KEY');

    const none = await engine.recall({
      query: 'what is the Anthropic API key variable name',
      format: 'list',
      expand: 'none',
    });
    expect(none.expanded).toBe(false);
    expect(none.content).toBe(auto.content);
  });

  it("expand:'parent' force-expands a lone parent (ignores the ≥2 gate)", async () => {
    // A single fact whose segment carries extra clause detail.
    const segment = [
      'Vendor terms. The SaaS vendor invoice is net-30.',
      '',
      'Penalties. A late payment incurs a 1.5% monthly interest charge and suspension after sixty days.',
    ].join('\n');
    setResponses(factsJson([{ fact: 'The SaaS vendor invoice payment term is net-30' }]));
    await engine.ingest(segment, {});

    // auto: a single fact → no shared parent → no expansion.
    const auto = await engine.recall({ query: 'SaaS vendor invoice payment terms', format: 'list' });
    expect(auto.expanded).toBe(false);

    // parent: force-expand the lone parent → the penalty clause comes back.
    const forced = await engine.recall({
      query: 'SaaS vendor invoice payment terms',
      format: 'list',
      expand: 'parent',
    });
    expect(forced.expanded).toBe(true);
    expect(forced.content).toContain('1.5%');
  });

  it('respects max_expand_passages and never exceeds the budget', async () => {
    await ingestContract();

    // Even forcing parent expansion with a raised budget, the count cap holds and the
    // total never exceeds the budget (skip-not-break preserved).
    const budget = 4000;
    const result = await engine.recall({
      query: 'Bandalert distribution cap intellectual property confidentiality',
      format: 'list',
      expand: 'parent',
      max_expand_passages: 1,
      token_budget: budget,
    });

    expect(result.expanded_segment_ids.length).toBeLessThanOrEqual(1);
    expect(estimateTokens(result.content)).toBeLessThanOrEqual(budget);
  });

  it('a parent-less (store-path) memory recalls the fact, not a passage', async () => {
    // store() never sets a segment_id → the fact is its own parent (§4.3).
    await engine.store('The user prefers tabs over spaces', { importance: 0.6 });

    const result = await engine.recall({ query: 'tabs or spaces preference', format: 'list' });
    expect(result.expanded).toBe(false);
    expect(result.content).toContain('tabs over spaces');
  });

  it('falls back to the fact when the parent segment was force-deleted (forgotten parent)', async () => {
    await ingestContract();

    // Force-delete the segment rows out from under the facts, leaving the memories'
    // segment_id pointers dangling (the "forgotten parent" robustness case). FK
    // enforcement is briefly disabled so the delete leaves a genuine dangling pointer.
    db.pragma('foreign_keys = OFF');
    db.prepare(`DELETE FROM segments WHERE namespace = ?`).run(NAMESPACE);
    db.pragma('foreign_keys = ON');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM segments WHERE namespace = ?`).get(NAMESPACE)).toEqual({ n: 0 });

    const result = await engine.recall({ query: 'Bandalert distribution agreement cap', format: 'list' });
    // No segment to expand → emit the facts; no crash.
    expect(result.expanded).toBe(false);
    expect(result.content.toLowerCase()).toContain('bandalert');
  });

  it('surfaces expanded + expanded_segment_ids in every format, and per-unit segment_id in raw', async () => {
    await ingestContract();
    const query = 'Bandalert distribution cap and revenue split';

    // 'list' and 'raw' never call the LLM; 'summary'/'answer' would, so feed a canned
    // formatter response for those so the structured metadata can be asserted.
    for (const format of ['list', 'raw'] as const) {
      const result = await engine.recall({ query, format });
      expect(result.expanded).toBe(true);
      expect(result.expanded_segment_ids).toHaveLength(1);
    }

    // raw: the per-unit segment_id + expanded flag ride on the JSON.
    const raw = await engine.recall({ query, format: 'raw' });
    const items = JSON.parse(raw.content) as Array<{ segment_id: string | null; expanded: boolean }>;
    const expandedUnit = items.find((i) => i.expanded);
    expect(expandedUnit).toBeDefined();
    expect(expandedUnit?.segment_id).toBe(raw.expanded_segment_ids[0]);

    // summary: structured fields ride alongside the (canned) summary text.
    setResponses('A concise briefing about the Bandalert distribution cap of $250k.');
    const summary = await engine.recall({ query, format: 'summary' });
    expect(summary.expanded).toBe(true);
    expect(summary.expanded_segment_ids).toHaveLength(1);
  });

  describe('memory_expand tool path', () => {
    function contractSegmentId(): string {
      const seg = db.prepare(`SELECT * FROM segments WHERE namespace = ?`).get(NAMESPACE) as SegmentRow | undefined;
      expect(seg).toBeDefined();
      return seg?.id ?? '';
    }

    it('returns the query-ranked passages for a segment id', async () => {
      await ingestContract();
      const segId = contractSegmentId();

      const result = await engine.expand(segId, 'intellectual property reversion');
      expect(result.found).toBe(true);
      expect(result.passages.length).toBeGreaterThan(0);
      // Top-ranked passage is the IP passage.
      expect(result.passages[0]).toContain('intellectual property');
    });

    it('returns whole-segment passages when no query is given', async () => {
      await ingestContract();
      const segId = contractSegmentId();

      const result = await engine.expand(segId);
      expect(result.found).toBe(true);
      expect(result.passages.length).toBeGreaterThan(0);
      expect(result.passages.join('\n')).toContain('$250k');
    });

    it('reports not-found for an unknown segment id', async () => {
      const result = await engine.expand('does-not-exist');
      expect(result.found).toBe(false);
      expect(result.passages).toEqual([]);
    });
  });

  it('links all seven facts to the one segment (parent-dedup precondition)', async () => {
    await ingestContract();
    const rows = db.prepare(`SELECT segment_id FROM memories WHERE namespace = ?`).all(NAMESPACE) as Array<{
      segment_id: string | null;
    }>;
    const distinct = new Set(rows.map((r) => r.segment_id));
    expect(distinct.size).toBe(1);
    expect([...distinct][0]).not.toBeNull();

    // The linked rows really exist and round-trip through getMemoriesByIds.
    const ids = (db.prepare(`SELECT id FROM memories WHERE namespace = ?`).all(NAMESPACE) as Array<{ id: string }>).map(
      (r) => r.id,
    );
    expect(getMemoriesByIds(db, NAMESPACE, ids)).toHaveLength(7);
  });
});

// ---- Two DISTINCT shared-parent segments that genuinely co-retrieve. Used for the
// ---- overlap-dedup (§5.3.2) and max_expand_passages-cap (§5.4) cases, which both
// ---- require >1 segment auto-expanding in one result. Each segment has an OFF-query
// ---- overview paragraph (so the query-relevant slice splits into its own passage) and
// ---- ≥2 headline facts (so each auto-expands independently). ----

// An identical arbitration clause — the boundary content chunkBlob's ~10–15% overlap
// window copies verbatim into two ADJACENT segments. It is its own coherent paragraph,
// so split-and-rank isolates it as a single passage, identical across both segments.
const SHARED_ARB_CLAUSE =
  'Dispute resolution. All disputes arising under this agreement are resolved exclusively by binding ' +
  'arbitration seated in the state of Delaware under the commercial rules of the American Arbitration ' +
  'Association, the arbitration award is final and binding on both parties and may be entered in any court of ' +
  'competent jurisdiction, and the seat of arbitration may not be changed without the written consent of both ' +
  'parties.';

// Off-query padding that pushes each overview past the passage cap so the shared
// arbitration clause splits off into its own passage rather than packing with the overview.
const OVERVIEW_PAD =
  'The operational appendix further details the supply chain logistics, the regional warehousing footprint, ' +
  'the carrier selection matrix, and the customs brokerage arrangements for every supported market in the ' +
  'territory schedule. ';

function disputeSegment(overviewLead: string): string {
  const overview = (overviewLead + ' ' + OVERVIEW_PAD.repeat(5)).trim();
  return [overview, '', SHARED_ARB_CLAUSE].join('\n');
}

const ACME_SEGMENT = disputeSegment(
  'Acme distribution overview. The Acme master distribution agreement covers worldwide physical and digital distribution.',
);
const GLOBEX_SEGMENT = disputeSegment(
  'Globex catalogue overview. The Globex catalogue licensing deal covers streaming and synchronization rights.',
);

const ACME_FACTS = [
  { fact: 'The Acme distribution agreement resolves disputes by binding arbitration in Delaware', importance: 0.7 },
  { fact: 'The Acme distribution agreement uses American Arbitration Association rules', importance: 0.7 },
];
const GLOBEX_FACTS = [
  { fact: 'The Globex licensing agreement resolves disputes by binding arbitration in Delaware', importance: 0.7 },
  { fact: 'The Globex licensing agreement uses American Arbitration Association rules', importance: 0.7 },
];

const DISPUTE_QUERY = 'binding arbitration Delaware American Arbitration Association dispute resolution';

describe('two distinct shared-parent segments (overlap dedup + passage cap)', () => {
  let tmpDir: string;
  let engine: MemoryEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-multiseg-expand-'));
    engine = createMemoryEngineFromConfig(testConfig(join(tmpDir, 'test.db')));
  });

  afterEach(() => {
    engine.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // Ingest both dispute segments as two DISTINCT segments, each with 2 headline facts.
  async function ingestBothSegments(): Promise<void> {
    setResponses(factsJson(ACME_FACTS));
    const acme = await engine.ingest(ACME_SEGMENT, { mode: 'document' });
    expect(acme.segments_created).toBe(1); // one distinct segment
    expect(acme.created).toBe(2); // ≥2 facts → auto-expand precondition

    setResponses(factsJson(GLOBEX_FACTS));
    const globex = await engine.ingest(GLOBEX_SEGMENT, { mode: 'document' });
    expect(globex.segments_created).toBe(1); // a SECOND distinct segment
    expect(globex.created).toBe(2);
  }

  it('overlap dedup: a sentence shared by two co-retrieved segments is emitted at most once (§5.3.2)', async () => {
    await ingestBothSegments();

    // Default 'auto' over a query that pulls the arbitration facts from BOTH segments.
    // Each segment's split-and-rank picks the IDENTICAL shared arbitration passage; the
    // overlap dedup must drop the duplicate so the shared sentence is not emitted twice.
    const result = await engine.recall({
      query: DISPUTE_QUERY,
      format: 'raw',
      token_budget: 4000,
      max_expand_passages: 5, // well above 2 so the cap is NOT what limits the result
    });

    expect(result.expanded).toBe(true);
    // Precondition: the query genuinely co-retrieved facts from both shared-parent
    // groups (all four arbitration facts), so both segments were expansion candidates.
    expect(result.total_matches).toBeGreaterThanOrEqual(4);

    // The shared arbitration sentence appears AT MOST once across all returned passages.
    const sharedMarker = 'binding arbitration seated in the state of Delaware';
    const occurrences = result.content.split(sharedMarker).length - 1;
    expect(occurrences).toBe(1);

    // And exactly ONE passage/segment survived the overlap dedup (the duplicate dropped).
    // Without the dedup, BOTH identical passages would be emitted (2 segment ids).
    expect(result.expanded_segment_ids).toHaveLength(1);
  });

  it('max_expand_passages truncates to N even when more segments would expand (§5.4)', async () => {
    await ingestBothSegments();

    // A query whose relevant slice is each segment's DISTINCT overview, so the two chosen
    // passages are NOT overlap-duplicates — without the cap, BOTH would expand. Force the
    // ≥2 gate off the table with 'parent' and a budget large enough to fit both passages,
    // so the ONLY thing that can limit the result to one passage is the cap itself.
    const budget = 4000;
    const overviewQuery = 'Acme Globex distribution catalogue licensing overview territories streaming rights';

    // Control: with a generous cap, BOTH distinct segments expand (precondition — proves
    // the cap test below is non-vacuous; without the cap, length would be 2).
    const uncapped = await engine.recall({
      query: overviewQuery,
      format: 'raw',
      token_budget: budget,
      expand: 'parent',
      max_expand_passages: 5,
    });
    expect(uncapped.expanded_segment_ids).toHaveLength(2);

    // Cap at 1 → exactly ONE passage/segment is emitted (the cap truncates to N).
    const capped = await engine.recall({
      query: overviewQuery,
      format: 'raw',
      token_budget: budget,
      expand: 'parent',
      max_expand_passages: 1,
    });
    expect(capped.expanded).toBe(true);
    expect(capped.expanded_segment_ids).toHaveLength(1);
    // Budget adherence: the packer never overruns the budget (skip-not-break).
    expect(estimateTokens(capped.content)).toBeLessThanOrEqual(budget);
  });
});

describe('memory_context auto-expands a shared-parent corpus', () => {
  let tmpDir: string;
  let dbPath: string;
  let engine: MemoryEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-context-expand-'));
    dbPath = join(tmpDir, 'test.db');
    engine = createMemoryEngineFromConfig(testConfig(dbPath));
  });

  afterEach(() => {
    engine.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns the passage on a task briefing over the contract corpus', async () => {
    setResponses(factsJson(HEADLINE_FACTS));
    await engine.ingest(CONTRACT_SEGMENT, { mode: 'document' });

    // memory_context's task recall is wired to expand:'auto'. Force the extractive
    // (no-LLM) summary path so the assertion is deterministic.
    llmMock.hasLLM = false;
    const briefing = await engine.context({ task: 'Bandalert distribution agreement cap and revenue' });

    expect(briefing).toContain('$250k');
  });
});

// `rankSegmentPassages` is the shared split→embed→rank helper (F6), used by BOTH recall
// expansion (limit 1 per segment) and `engine.expand`/`memory_expand` (all passages).
describe('rankSegmentPassages (shared split-and-rank helper)', () => {
  const config = testConfig(join(tmpdir(), 'rank-helper-unused.db'));

  it('ranks the query-relevant passage first and honors the limit', async () => {
    const queryEmbedding = await embedQuery('intellectual property reversion publishing rights', config);

    const all = await rankSegmentPassages(config, CONTRACT_SEGMENT, queryEmbedding);
    // The whole segment splits into multiple coherent passages …
    expect(all.length).toBeGreaterThan(1);
    // … and the IP query ranks the IP passage first (not the $250k cap passage).
    expect(all[0]).toContain('intellectual property');
    expect(all[0]).not.toContain('$250k');

    // The limit truncates to the top-N (the same best-first order recall expansion uses).
    const topOne = await rankSegmentPassages(config, CONTRACT_SEGMENT, queryEmbedding, 1);
    expect(topOne).toEqual(all.slice(0, 1));
  });

  it('returns [] for an empty segment and the lone passage for a short one', async () => {
    const queryEmbedding = await embedQuery('anything', config);

    expect(await rankSegmentPassages(config, '   ', queryEmbedding)).toEqual([]);

    const short = 'A single short coherent sentence about nothing in particular.';
    expect(await rankSegmentPassages(config, short, queryEmbedding)).toEqual([short]);
  });
});
