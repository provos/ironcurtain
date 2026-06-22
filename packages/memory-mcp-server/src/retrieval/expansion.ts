/**
 * Step 9b — post-dedup parent re-expansion ("return coarse"), AUGMENT semantics.
 *
 * This is NOT the candidate ranker. It runs strictly AFTER the pipeline has
 * selected and ordered its kept facts (steps 1–9). It only reshapes the RETURNED
 * unit set: it keeps EVERY kept fact (breadth-first — exactly what `expand:'none'`
 * returns) and APPENDS the query-relevant source PASSAGE(s) of shared segments
 * AFTER all the facts. Passages are supplementary, not a replacement: because the
 * greedy skip-not-break `packToBudget` packs in order, facts are packed first and a
 * passage only ever consumes leftover budget — so auto-expansion can never evict a
 * fact that `expand:'none'` would have kept. Parent-dedup applies to PASSAGES (one
 * passage per segment), never to facts. It never touches the candidate set, the
 * fusion/composite/rerank scores, or the order in which facts were selected.
 */

import type Database from 'better-sqlite3';
import type { MemoryConfig } from '../config.js';
import type { SegmentRow } from '../storage/database.js';
import type { ExpandMode } from '../types.js';
import type { ScoredMemory } from './scoring.js';
import { getSegmentsByIds } from '../storage/queries.js';
import { splitToPassages } from '../storage/extraction.js';
import { embed, cosineSimilarity } from '../embedding/embedder.js';

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
 * Build the display list from the post-dedup kept facts (§5.3), AUGMENT semantics.
 *
 * - `expand === 'none'`: byte-for-byte pass-through — every kept fact stays a fact.
 * - `expand === 'auto'`: keep all facts; append the shared-parent passage(s) (a
 *   segment is shared when ≥2 kept facts point at it) after the facts.
 * - `expand === 'parent'`: keep all facts; append the parent passage of every kept
 *   fact that has one (the ≥2 gate is dropped) after the facts.
 *
 * Expansion never drops or reorders a fact; it only APPENDS supplementary passages
 * after all the facts, in segment-best-rank order, capped at `maxExpandPassages`.
 */
export async function expandKeptFacts(
  db: Database.Database,
  config: MemoryConfig,
  kept: ScoredMemory[],
  queryEmbedding: Float32Array,
  expand: ExpandMode,
  maxExpandPassages: number,
): Promise<ExpansionResult> {
  if (expand === 'none') {
    return { units: kept.map(toFactUnit), expandedSegmentIds: [] };
  }

  // 1. Group kept facts by non-null segment_id, recording first (best) position.
  const groups = groupBySegment(kept);

  // 2. Decide which segments to expand for this mode.
  const minGroupSize = expand === 'parent' ? 1 : 2;
  const segmentIdsToExpand = [...groups.entries()]
    .filter(([, members]) => members.length >= minGroupSize)
    .map(([segmentId]) => segmentId);

  if (segmentIdsToExpand.length === 0) {
    return { units: kept.map(toFactUnit), expandedSegmentIds: [] };
  }

  // 3. Fetch the selected segments in one query.
  const segments = getSegmentsByIds(db, config.namespace, segmentIdsToExpand);
  const segmentById = new Map(segments.map((s) => [s.id, s]));

  // 4. Per expandable segment, split-and-rank to a chosen passage (segment-best-rank order).
  const chosenPassageBySegment = await choosePassages(config, segmentIdsToExpand, segmentById, queryEmbedding);

  // 5. Keep all facts (breadth-first); append the chosen passages after them, capped.
  return buildDisplayList(kept, segmentIdsToExpand, groups, chosenPassageBySegment, maxExpandPassages);
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
 * overlap-dedup in `buildDisplayList`, so a passage dropped as an overlap duplicate does
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

    const passage = await rankBestPassage(config, segment.content, queryEmbedding);
    if (passage !== null) chosen.set(segmentId, passage);
  }

  return chosen;
}

/**
 * Split a segment into passages, embed each, and return the one most similar to the
 * query embedding (reused from pipeline step 1 — no second query embed). Returns null
 * when the segment yields no passages.
 */
async function rankBestPassage(
  config: MemoryConfig,
  content: string,
  queryEmbedding: Float32Array,
): Promise<string | null> {
  const passages = splitToPassages(content);
  if (passages.length === 0) return null;
  if (passages.length === 1) return passages[0];

  let best = passages[0];
  let bestSim = -Infinity;
  for (const passage of passages) {
    const passageEmbedding = await embed(passage, config);
    const sim = cosineSimilarity(passageEmbedding, queryEmbedding);
    if (sim > bestSim) {
      bestSim = sim;
      best = passage;
    }
  }
  return best;
}

/**
 * Build the AUGMENT display list. First emit EVERY kept fact verbatim in score order —
 * byte-for-byte what `expand:'none'` returns, so breadth is never lost. THEN append the
 * chosen passages, one per shared segment, in segment-best-rank order. Because the
 * downstream greedy skip-not-break `packToBudget` packs in order, placing passages last
 * means facts are packed first and a passage only consumes leftover budget — auto-expand
 * never evicts a fact `expand:'none'` would have kept.
 *
 * Each appended passage rides on its segment's best-ranked fact (carrying that fact's
 * date/importance so rendering is unchanged) but gets a DISTINCT synthetic id: the
 * host fact is also emitted, so a shared id would make id-keyed dedup/clustering
 * (extractive-summary clustering, access-stat counting) treat the passage as a
 * duplicate of its host fact and silently drop it. Parent-dedup applies to PASSAGES
 * here (one passage per segment), never to facts. Overlap dedup drops a passage whose
 * text is a near-substring of an already-appended passage (§5.3.2); the
 * `maxExpandPassages` cap limits the passages that SURVIVE that dedup.
 */
function buildDisplayList(
  kept: ScoredMemory[],
  segmentIdsToExpand: string[],
  groups: Map<string, ScoredMemory[]>,
  chosenPassageBySegment: Map<string, string>,
  maxExpandPassages: number,
): ExpansionResult {
  // Breadth-first: keep every fact, in score order (identical to expand:'none').
  const units: DisplayUnit[] = kept.map(toFactUnit);

  const emittedPassages: string[] = [];
  const expandedSegmentIds: string[] = [];

  // Append passages AFTER all facts, in segment-best-rank order, deduped and capped.
  for (const segmentId of segmentIdsToExpand) {
    if (expandedSegmentIds.length >= maxExpandPassages) break;

    const passage = chosenPassageBySegment.get(segmentId);
    // group[0] is the segment's best-ranked fact (groups preserve score order); the
    // appended passage rides on it so date/importance/id rendering is unchanged.
    const bestFact = groups.get(segmentId)?.[0];
    if (passage === undefined || bestFact === undefined) continue;

    // Overlap dedup: skip a passage that is a near-substring of an already-appended one.
    if (isOverlapping(passage, emittedPassages)) continue;

    emittedPassages.push(passage);
    expandedSegmentIds.push(segmentId);
    // Distinct id (host fact id + segment) so the passage is its own display unit, not
    // an id-collision duplicate of the host fact (which is also emitted, see above).
    units.push({ ...bestFact, id: `${bestFact.id}#seg:${segmentId}`, content: passage, expanded: true });
  }

  return { units, expandedSegmentIds };
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
