/**
 * Step 9b — post-dedup parent re-expansion ("return coarse"), HYBRID semantics.
 *
 * This is NOT the candidate ranker. It runs strictly AFTER the pipeline has
 * selected and ordered its kept facts (steps 1–9). It only reshapes the RETURNED
 * unit set: it keeps the breadth facts (the same fact list `expand:'none'` returns)
 * and surfaces the query-relevant source PASSAGE(s) of shared segments.
 *
 * HYBRID (not pure-AUGMENT): the single highest-ranked expanded passage is
 * GUARANTEED whenever the budget can fit it — its tokens are RESERVED before facts
 * are packed, so a default recall always gets depth and never silently degrades to
 * the lossy headlines. Including that passage may displace only the LOWEST-priority
 * kept facts (the tail that did not fit in `budget - reserve`); the top facts are
 * never evicted to make room (that was the original REPLACE regression). Additional
 * passages beyond the first are SUPPLEMENTARY — they ride leftover budget only, are
 * capped at `max_expand_passages`, and never displace a fact. Parent-dedup applies
 * to PASSAGES (one per segment), never to facts. It never touches the candidate set,
 * the fusion/composite/rerank scores, or the order in which facts were selected, and
 * it does NOT change `packToBudget`'s own logic.
 */

import type Database from 'better-sqlite3';
import type { MemoryConfig } from '../config.js';
import type { SegmentRow } from '../storage/database.js';
import type { ExpandMode } from '../types.js';
import type { ScoredMemory } from './scoring.js';
import { getSegmentsByIds } from '../storage/queries.js';
import { splitToPassages } from '../storage/extraction.js';
import { embed, cosineSimilarity } from '../embedding/embedder.js';
import { estimateTokens, packToBudget } from './scoring.js';

/** A heterogeneous recall display unit: a fact verbatim or an expanded passage. */
export interface DisplayUnit extends ScoredMemory {
  /** True when `content` is an expanded parent passage (not the fact text). */
  expanded: boolean;
}

export interface ExpansionResult {
  units: DisplayUnit[];
  expandedSegmentIds: string[];
}

/**
 * Split a segment into coherent passages, embed each, and return them ranked
 * best-first by cosine similarity to `queryEmbedding` (reusing the pipeline's
 * step-1 query embedding — no second query embed). `limit` truncates the result
 * to the top-N passages; omit it to rank the whole segment. Returns `[]` for a
 * segment that yields no passages.
 *
 * Shared by recall expansion (which takes `limit: 1` per segment) and
 * `memory_expand` / `engine.expand` (which ranks all passages of one segment).
 * Lives in the retrieval layer; `engine-impl` already depends on retrieval
 * (pipeline, scoring), so importing this introduces no new cross-layer cycle.
 */
export async function rankSegmentPassages(
  config: MemoryConfig,
  segmentText: string,
  queryEmbedding: Float32Array,
  limit?: number,
): Promise<string[]> {
  const passages = splitToPassages(segmentText);
  if (passages.length === 0) return [];
  // Single passage: no ranking needed; it is trivially the best (and only) one.
  if (passages.length === 1) return passages;

  const scored: Array<{ passage: string; sim: number }> = [];
  for (const passage of passages) {
    const passageEmbedding = await embed(passage, config);
    scored.push({ passage, sim: cosineSimilarity(passageEmbedding, queryEmbedding) });
  }
  scored.sort((a, b) => b.sim - a.sim);

  const ranked = scored.map((s) => s.passage);
  return limit === undefined ? ranked : ranked.slice(0, limit);
}

/**
 * Build the packed display list from the post-dedup kept facts (§5.3), HYBRID semantics.
 *
 * - `expand === 'none'`: byte-for-byte pass-through — `packToBudget` over the fact list.
 * - `expand === 'auto'`: keep the breadth facts; reserve + force-include the top
 *   shared-parent passage (a segment is shared when ≥2 kept facts point at it); append
 *   any further passages on leftover budget.
 * - `expand === 'parent'`: same as auto but the ≥2 gate is dropped (every kept fact with
 *   a parent is an expansion candidate).
 *
 * Returns the FINAL packed, score-ordered units (facts then passages), so the caller does
 * not run `packToBudget` again. The top passage is guaranteed whenever the budget can fit
 * it; the top facts are never evicted to make room for it (only the lowest-priority tail
 * facts are).
 */
export async function expandKeptFacts(
  db: Database.Database,
  config: MemoryConfig,
  kept: ScoredMemory[],
  queryEmbedding: Float32Array,
  expand: ExpandMode,
  maxExpandPassages: number,
  budget: number,
): Promise<ExpansionResult> {
  const factUnits = kept.map(toFactUnit);

  if (expand === 'none') {
    return { units: packToBudget(factUnits, budget), expandedSegmentIds: [] };
  }

  // 1. Group kept facts by non-null segment_id, recording first (best) position.
  const groups = groupBySegment(kept);

  // 2. Decide which segments to expand for this mode.
  const minGroupSize = expand === 'parent' ? 1 : 2;
  const segmentIdsToExpand = [...groups.entries()]
    .filter(([, members]) => members.length >= minGroupSize)
    .map(([segmentId]) => segmentId);

  if (segmentIdsToExpand.length === 0) {
    return { units: packToBudget(factUnits, budget), expandedSegmentIds: [] };
  }

  // 3. Fetch the selected segments in one query.
  const segments = getSegmentsByIds(db, config.namespace, segmentIdsToExpand);
  const segmentById = new Map(segments.map((s) => [s.id, s]));

  // 4. Per expandable segment, split-and-rank to a chosen passage (segment-best-rank order).
  const chosenPassageBySegment = await choosePassages(config, segmentIdsToExpand, segmentById, queryEmbedding);

  // 5. Build the candidate passage units (overlap-deduped, capped), in segment-best-rank order.
  const passageUnits = buildPassageUnits(segmentIdsToExpand, groups, chosenPassageBySegment, maxExpandPassages);

  // 6. Pack facts + passages under a reservation that GUARANTEES the top passage's depth.
  return packHybrid(factUnits, passageUnits, budget);
}

/** A fact emitted verbatim (not expanded). */
function toFactUnit(mem: ScoredMemory): DisplayUnit {
  return { ...mem, expanded: false };
}

/** Group kept facts by non-null segment_id, preserving score order within each group. */
function groupBySegment(kept: ScoredMemory[]): Map<string, ScoredMemory[]> {
  const groups = new Map<string, ScoredMemory[]>();
  for (const mem of kept) {
    if (mem.segment_id === null) continue;
    const existing = groups.get(mem.segment_id);
    if (existing) {
      existing.push(mem);
    } else {
      groups.set(mem.segment_id, [mem]);
    }
  }
  return groups;
}

/**
 * For each expandable segment, split its content into passages, embed them, and pick
 * the passage most similar to the query embedding. Returns the chosen passage text per
 * segment id, keyed in segment-best-rank order. A segment with no row (forgotten parent)
 * or no passages is skipped — its facts are simply not augmented with a passage.
 *
 * The `maxExpandPassages` cap is NOT applied here: it caps the passages that SURVIVE
 * overlap-dedup in `buildPassageUnits`, so a passage dropped as an overlap duplicate does
 * not waste a cap slot.
 */
async function choosePassages(
  config: MemoryConfig,
  segmentIdsToExpand: string[],
  segmentById: Map<string, SegmentRow>,
  queryEmbedding: Float32Array,
): Promise<Map<string, string>> {
  const chosen = new Map<string, string>();

  for (const segmentId of segmentIdsToExpand) {
    const segment = segmentById.get(segmentId);
    if (!segment) continue; // forgotten/missing parent → no passage to append

    const ranked = await rankSegmentPassages(config, segment.content, queryEmbedding, 1);
    if (ranked.length > 0) chosen.set(segmentId, ranked[0]);
  }

  return chosen;
}

/**
 * Build the passage display units, one per shared segment, in segment-best-rank order,
 * after passage overlap-dedup and the `maxExpandPassages` cap. No budget logic here —
 * `packHybrid` decides which of these survive packing (the first is guaranteed, the rest
 * are supplementary).
 *
 * Each passage rides on its segment's best-ranked fact (carrying that fact's
 * date/importance so rendering is unchanged) but gets a DISTINCT synthetic id: the host
 * fact is also emitted, so a shared id would make id-keyed dedup/clustering treat the
 * passage as a duplicate of its host fact and silently drop it.
 */
function buildPassageUnits(
  segmentIdsToExpand: string[],
  groups: Map<string, ScoredMemory[]>,
  chosenPassageBySegment: Map<string, string>,
  maxExpandPassages: number,
): DisplayUnit[] {
  const passageUnits: DisplayUnit[] = [];
  const emittedPassages: string[] = [];

  for (const segmentId of segmentIdsToExpand) {
    if (passageUnits.length >= maxExpandPassages) break;

    const passage = chosenPassageBySegment.get(segmentId);
    // group[0] is the segment's best-ranked fact (groups preserve score order); the
    // passage rides on it so date/importance/id rendering is unchanged.
    const bestFact = groups.get(segmentId)?.[0];
    if (passage === undefined || bestFact === undefined) continue;

    // Overlap dedup: skip a passage that is a near-substring of an already-chosen one.
    if (isOverlapping(passage, emittedPassages)) continue;

    emittedPassages.push(passage);
    // Distinct id (host fact id + segment) so the passage is its own display unit, not
    // an id-collision duplicate of the host fact (which is also emitted, see above).
    passageUnits.push({ ...bestFact, id: `${bestFact.id}#seg:${segmentId}`, content: passage, expanded: true });
  }

  return passageUnits;
}

/**
 * HYBRID pack: reserve budget for the single top passage so DEPTH is guaranteed, pack the
 * breadth facts into the remainder so the TOP facts are never evicted, then fill leftover
 * with the remaining facts and the supplementary passages.
 *
 * Mechanism (no change to `packToBudget`'s own logic):
 *   1. If the top passage cannot fit the whole budget, fall back to facts only
 *      (`packToBudget(facts, budget)`); `expanded` is false — no infinite reserve.
 *   2. Otherwise reserve `estimateTokens(topPassage)` and `packToBudget(facts,
 *      budget - reserve)` — the breadth facts are packed FIRST, so they are never evicted
 *      to fit the passage (only the lowest-priority tail facts that did not fit the
 *      reduced budget are displaced).
 *   3. Force-include the top passage (its tokens were reserved, so it always fits).
 *   4. Fill the leftover budget greedily (skip-not-break) with the not-yet-included facts
 *      and the supplementary passages — these only ever consume what is left, so they
 *      never displace a fact.
 *
 * The returned order is score-ordered facts, then the guaranteed top passage, then any
 * supplementary passages — matching the existing "facts then passages" display contract.
 */
function packHybrid(factUnits: DisplayUnit[], passageUnits: DisplayUnit[], budget: number): ExpansionResult {
  // No passage candidates → facts only (no reservation, no expansion).
  if (passageUnits.length === 0) {
    return { units: packToBudget(factUnits, budget), expandedSegmentIds: [] };
  }

  const topPassage = passageUnits[0];
  const reserve = estimateTokens(topPassage.content);

  // The top passage cannot fit even the whole budget alone (no infinite reserve):
  // fall back to facts only (`expanded` false).
  if (reserve > budget) {
    return { units: packToBudget(factUnits, budget), expandedSegmentIds: [] };
  }

  // Pack the breadth facts into the budget MINUS the reserved passage so the top facts
  // are never evicted to make room — only the lowest-priority tail facts are displaced.
  const packedFacts = packToBudget(factUnits, budget - reserve);
  const usedTokens = packedFacts.reduce((sum, u) => sum + estimateTokens(u.content), 0);

  const selected: DisplayUnit[] = [...packedFacts, topPassage];
  const expandedSegmentIds: string[] = [segmentIdOf(topPassage)];
  let remaining = budget - usedTokens - reserve;

  // Fill leftover budget greedily (skip-not-break): facts that did not make the reserved
  // pack, then the supplementary passages. These ride leftover budget only — they never
  // displace a fact, and the cap was already applied when the passage units were built.
  const includedFactIds = new Set(packedFacts.map((u) => u.id));
  const leftover: DisplayUnit[] = [...factUnits.filter((u) => !includedFactIds.has(u.id)), ...passageUnits.slice(1)];
  for (const unit of leftover) {
    const tokens = estimateTokens(unit.content);
    if (tokens > remaining) continue; // skip, don't break — a smaller later unit may fit
    if (unit.expanded) expandedSegmentIds.push(segmentIdOf(unit));
    selected.push(unit);
    remaining -= tokens;
  }

  return { units: selected, expandedSegmentIds };
}

/** Recover the segment id a passage unit was built from (it rides the `#seg:<id>` suffix). */
function segmentIdOf(passageUnit: DisplayUnit): string {
  const marker = '#seg:';
  const idx = passageUnit.id.indexOf(marker);
  return idx === -1 ? (passageUnit.segment_id ?? '') : passageUnit.id.slice(idx + marker.length);
}

/** Normalize whitespace for overlap comparison. */
function normalizeForOverlap(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when `passage` is a (near-)substring of any already-emitted passage, or vice-versa. */
function isOverlapping(passage: string, emitted: string[]): boolean {
  const norm = normalizeForOverlap(passage);
  if (norm.length === 0) return true;
  return emitted.some((prev) => {
    const prevNorm = normalizeForOverlap(prev);
    return prevNorm.includes(norm) || norm.includes(prevNorm);
  });
}
