/**
 * Step 9b — post-dedup parent re-expansion ("return coarse").
 *
 * This is NOT the candidate ranker. It runs strictly AFTER the pipeline has
 * selected and ordered its kept facts (steps 1–9). It only reshapes the RETURNED
 * unit: when several kept facts share one source segment, it emits a single
 * query-relevant PASSAGE of that segment in place of the redundant headlines.
 * It never touches the candidate set, the fusion/composite/rerank scores, or the
 * order in which facts were selected.
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
 * Build the ordered display list from the post-dedup kept facts (§5.3).
 *
 * - `expand === 'none'`: byte-for-byte pass-through — every kept fact stays a fact.
 * - `expand === 'auto'`: expand a parent only when ≥2 kept facts share it.
 * - `expand === 'parent'`: expand the parent of every kept fact that has one.
 *
 * Expansion replaces a fact with its segment's query-ranked passage at the fact's
 * best position; parent-deduped siblings collapse into that one passage.
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

  // 4. Per expandable segment, split-and-rank to a chosen passage (capped count).
  const chosenPassageBySegment = await choosePassages(
    config,
    segmentIdsToExpand,
    segmentById,
    queryEmbedding,
    maxExpandPassages,
  );

  // 5. Walk kept in score order, emitting passages once (parent-dedup) and facts otherwise.
  return buildDisplayList(kept, chosenPassageBySegment);
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
 * segment id. A segment with no row (forgotten parent) or no passages is skipped — its
 * facts then fall back to fact emission.
 *
 * The global `maxExpandPassages` count cap is honored here: segments are visited in the
 * order they were selected (score order of their best fact) and once the cap is reached,
 * no further segment gets a passage (its facts fall back to facts).
 */
async function choosePassages(
  config: MemoryConfig,
  segmentIdsToExpand: string[],
  segmentById: Map<string, SegmentRow>,
  queryEmbedding: Float32Array,
  maxExpandPassages: number,
): Promise<Map<string, string>> {
  const chosen = new Map<string, string>();

  for (const segmentId of segmentIdsToExpand) {
    if (chosen.size >= maxExpandPassages) break;
    const segment = segmentById.get(segmentId);
    if (!segment) continue; // forgotten/missing parent → fall back to facts

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
 * Walk kept facts in score order. The FIRST fact of an expanded segment becomes the
 * passage unit (carrying that fact's date/importance so rendering is unchanged); later
 * facts sharing the same segment are dropped (parent-dedup). A fact whose segment was
 * not chosen for a passage (lone parent under auto, forgotten parent, or null segment)
 * is emitted verbatim. Overlap dedup drops a passage whose text is a near-substring of
 * an already-emitted passage (§5.3.2).
 */
function buildDisplayList(kept: ScoredMemory[], chosenPassageBySegment: Map<string, string>): ExpansionResult {
  const units: DisplayUnit[] = [];
  const emittedSegments = new Set<string>();
  const emittedPassages: string[] = [];
  const expandedSegmentIds: string[] = [];

  for (const mem of kept) {
    const segmentId = mem.segment_id;
    const passage = segmentId !== null ? chosenPassageBySegment.get(segmentId) : undefined;

    // Not an expanded segment → emit the fact verbatim.
    if (segmentId === null || passage === undefined) {
      units.push(toFactUnit(mem));
      continue;
    }

    // Expanded segment already emitted → parent-dedup, drop this sibling.
    if (emittedSegments.has(segmentId)) continue;
    emittedSegments.add(segmentId);

    // Overlap dedup: skip a passage that is a near-substring of an already-emitted one.
    if (isOverlapping(passage, emittedPassages)) continue;

    emittedPassages.push(passage);
    expandedSegmentIds.push(segmentId);
    units.push({ ...mem, content: passage, expanded: true });
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
