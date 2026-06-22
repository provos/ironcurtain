/**
 * LLM-backed fact extraction for `memory_ingest`.
 *
 * Sits next to consolidation.ts / compaction.ts (the other LLM-on-write modules).
 * Reuses `llmComplete` from llm/client.js and `estimateTokens` from retrieval/scoring.js.
 *
 * PII-safe rule (hard): this module NEVER logs raw content/chunk/blob or the model's
 * raw response. Only lengths, token estimates, chunk indices, and content-free failure
 * shapes are ever emitted.
 */

import type { MemoryConfig } from '../config.js';
import { llmComplete } from '../llm/client.js';
import { estimateTokens } from '../retrieval/scoring.js';
import { MAX_CONTENT_LENGTH } from '../tools/validation.js';

export interface ExtractedFact {
  fact: string;
  /** 0–1, OPTIONAL; absent ⇒ caller falls back to the seed importance. */
  importance?: number;
}

export type IngestMode = 'conversation' | 'document';

// ---------- Constants ----------

/** Per-chunk token budget; comfortably inside Haiku's window with room for prompt + output. */
export const MAX_INGEST_CHUNK_TOKENS = 6000;

/** Cap total extracted facts per ingest to bound a runaway response. */
export const MAX_FACTS_PER_INGEST = 200;

/** Cap total chunks so a hostile/enormous blob can't fan out unboundedly. */
export const MAX_INGEST_CHUNKS = 50;

/**
 * Char-based hard cap per piece, derived from the per-chunk token budget via the
 * package's ~4-chars/token heuristic (`estimateTokens`). Used as a last-resort cut
 * for whitespace-free input so no emitted piece can exceed MAX_INGEST_CHUNK_TOKENS.
 */
const MAX_INGEST_CHUNK_CHARS = MAX_INGEST_CHUNK_TOKENS * 4;

/** Fraction of a window's lines re-fed at the head of the next window (A5). */
const CHUNK_OVERLAP_FRACTION = 0.12;

/**
 * Target token size for a recall-time passage (§5.3.1). A passage is the *returned*
 * unit on auto-expansion: small enough to fit the recall budget (default 800) with
 * room for supporting facts, large enough to carry a coherent clause.
 */
export const MAX_PASSAGE_TOKENS = 350;

// ---------- Prompts ----------

const SHARED_RULES =
  '- Output ONLY a JSON array of objects, each { "fact": "<self-contained fact>", ' +
  '"importance": <0.0-1.0> }. One atomic fact per element — never combine two facts with "and".\n' +
  '- Each fact must be self-contained: resolve pronouns to names and include the subject ' +
  '("The user prefers dark mode", not "prefers dark mode"), AND name the specific thing the ' +
  'fact is about — the project, product, document, game, or entity ("The user wants players to ' +
  'pay off all loans before winning Debt Quest", not "...before winning the game"). If a fact ' +
  'would be ambiguous out of context, name its referent.\n' +
  '- Extract only DURABLE facts worth remembering beyond this conversation: stable ' +
  'preferences, identity, project facts, decisions, learned constraints.\n' +
  '- SKIP ephemeral / session-local state: transient errors, one-off debugging steps, ' +
  '"let\'s try X", task chatter, pleasantries, meta-talk.\n' +
  '- "importance" reflects how durable/identity-defining the fact is: durable identity, ' +
  'standing preferences, and decisions → high (~0.7-1.0); useful-but-replaceable project ' +
  'facts → mid (~0.4-0.7); marginal/ephemeral facts you still chose to keep → low ' +
  '(~0.1-0.4). When unsure, omit "importance" and the caller will use the seed default.\n' +
  '- If nothing durable is stated, output []. Reply with ONLY the JSON array, no prose.';

export const CONVERSATION_EXTRACTION_PROMPT =
  'You extract atomic, durable facts from a conversation transcript for long-term memory.\n' +
  SHARED_RULES +
  '\n- Extract ONLY facts that are explicitly stated. Do NOT infer, summarize, or editorialize.';

export const DOCUMENT_EXTRACTION_PROMPT =
  'You extract atomic, durable facts from a document or session summary for long-term memory.\n' +
  SHARED_RULES +
  '\n- Reasonable inference is allowed where the text clearly implies a durable fact, but do ' +
  'not fabricate. Prefer atomic facts; split compound statements.';

function systemPromptFor(mode: IngestMode): string {
  return mode === 'document' ? DOCUMENT_EXTRACTION_PROMPT : CONVERSATION_EXTRACTION_PROMPT;
}

// ---------- Parsing ----------

interface RawFactObject {
  fact?: unknown;
  importance?: unknown;
}

/** Trim and hard-cap a fact's text at MAX_CONTENT_LENGTH (applies to BOTH shapes). */
function capFactText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_CONTENT_LENGTH ? trimmed.slice(0, MAX_CONTENT_LENGTH) : trimmed;
}

function coerceFact(item: unknown): ExtractedFact | null {
  // Accept a bare string OR an object { fact, importance? }.
  if (typeof item === 'string') {
    const fact = capFactText(item);
    return fact.length > 0 ? { fact } : null;
  }
  if (item === null || typeof item !== 'object') return null;

  const obj = item as RawFactObject;
  if (typeof obj.fact !== 'string') return null;
  const fact = capFactText(obj.fact);
  if (fact.length === 0) return null;

  let importance: number | undefined;
  if (typeof obj.importance === 'number' && Number.isFinite(obj.importance)) {
    importance = Math.min(1, Math.max(0, obj.importance));
  }

  return importance === undefined ? { fact } : { fact, importance };
}

/**
 * Parse the model's text response into ExtractedFact[]. Pure & defensive,
 * mirroring `parseBatchJudgments`.
 *
 * Returns `null` on a PARSE FAILURE — no JSON array found, invalid JSON, or a
 * non-array payload — which the caller treats as a chunk failure. Returns a
 * (possibly empty) array on a successful parse; an empty array is a VALID
 * outcome meaning the model reported no durable facts (the prompt instructs it
 * to emit `[]` in that case), NOT a failure. NEVER echoes `raw` (A6).
 */
export function parseExtractedFacts(raw: string): ExtractedFact[] | null {
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    if (!Array.isArray(parsed)) return null;

    const facts: ExtractedFact[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      const coerced = coerceFact(item);
      if (!coerced) continue;
      if (seen.has(coerced.fact)) continue;
      seen.add(coerced.fact);
      facts.push(coerced);
      if (facts.length >= MAX_FACTS_PER_INGEST) break;
    }
    return facts;
  } catch {
    return null;
  }
}

// ---------- Chunking ----------

/**
 * Cut a single string into char-bounded pieces of at most MAX_INGEST_CHUNK_CHARS
 * (≈ MAX_INGEST_CHUNK_TOKENS at ~4 chars/token). Last-resort fallback for content
 * with no usable whitespace (base64, minified JSON, one giant token) so that no
 * emitted piece can exceed the token cap.
 */
function hardCutChars(text: string): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += MAX_INGEST_CHUNK_CHARS) {
    pieces.push(text.slice(i, i + MAX_INGEST_CHUNK_CHARS));
  }
  return pieces;
}

/**
 * Hard-split a single pathological line (longer than the threshold) on whitespace
 * into sub-lines that each fit under MAX_INGEST_CHUNK_TOKENS. Any resulting piece
 * that still exceeds the budget — e.g. a single whitespace-free giant token —
 * falls back to a char-based hard cut, so the token cap is a HARD bound regardless
 * of input.
 */
function hardSplitLine(line: string): string[] {
  const words = line.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return capPieces([line]);

  const pieces: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (estimateTokens(candidate) > MAX_INGEST_CHUNK_TOKENS && current.length > 0) {
      pieces.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) pieces.push(current);
  return capPieces(pieces);
}

/** Replace any piece still over the token budget with char-bounded sub-pieces. */
function capPieces(pieces: string[]): string[] {
  const capped: string[] = [];
  for (const piece of pieces) {
    if (estimateTokens(piece) > MAX_INGEST_CHUNK_TOKENS) {
      capped.push(...hardCutChars(piece));
    } else {
      capped.push(piece);
    }
  }
  return capped;
}

/**
 * Split a blob into line-oriented windows of ~MAX_INGEST_CHUNK_TOKENS, with a
 * ~10-15% line overlap between adjacent windows (A5). Pathological long lines are
 * hard-split on whitespace. Total chunk count is bounded by MAX_INGEST_CHUNKS.
 */
export function chunkBlob(blob: string): string[] {
  if (estimateTokens(blob) <= MAX_INGEST_CHUNK_TOKENS) {
    return [blob];
  }

  // Normalize lines, hard-splitting any single line that exceeds the threshold.
  const rawLines = blob.split('\n');
  const lines: string[] = [];
  for (const line of rawLines) {
    if (estimateTokens(line) > MAX_INGEST_CHUNK_TOKENS) {
      lines.push(...hardSplitLine(line));
    } else {
      lines.push(line);
    }
  }

  const chunks: string[] = [];
  let window: string[] = [];
  let windowTokens = 0;

  const flush = (): void => {
    if (window.length === 0) return;
    chunks.push(window.join('\n'));
    // Carry the tail ~CHUNK_OVERLAP_FRACTION of lines into the next window (A5).
    const overlapCount = Math.min(window.length - 1, Math.max(1, Math.floor(window.length * CHUNK_OVERLAP_FRACTION)));
    const overlap = overlapCount > 0 ? window.slice(window.length - overlapCount) : [];
    window = [...overlap];
    windowTokens = overlap.reduce((sum, l) => sum + estimateTokens(l) + 1, 0);
  };

  for (const line of lines) {
    const lineTokens = estimateTokens(line) + 1; // +1 for the newline
    if (windowTokens + lineTokens > MAX_INGEST_CHUNK_TOKENS && window.length > 0) {
      flush();
      if (chunks.length >= MAX_INGEST_CHUNKS) break;
    }
    window.push(line);
    windowTokens += lineTokens;
  }

  if (chunks.length < MAX_INGEST_CHUNKS && window.length > 0) {
    chunks.push(window.join('\n'));
  }

  return chunks.slice(0, MAX_INGEST_CHUNKS);
}

// ---------- Passage splitting (recall-time return shaping) ----------

/**
 * Split a segment into COHERENT passages of at most ~MAX_PASSAGE_TOKENS, on
 * meaning-preserving boundaries (paragraph breaks / conversation turns first,
 * sentence boundaries as a fallback). Pure & unit-testable; used at recall time
 * (§5.3.1) to return a query-relevant slice of an expanded parent rather than the
 * whole 6000-token chunk.
 *
 * Greedy accumulation: pack atomic units (paragraphs, then sentences for an
 * oversized paragraph) into a passage until the next unit would overflow the token
 * cap, then start a new passage. An empty/whitespace-only input yields `[]`.
 */
export function splitToPassages(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const units = toAtomicUnits(trimmed);
  return packUnitsToPassages(units);
}

/**
 * Break text into atomic units no larger than the passage cap: paragraph/turn
 * blocks first, splitting any block still over the cap into sentences (and, as a
 * last resort for a giant sentence, a char-bounded cut so a unit never exceeds the
 * cap).
 */
function toAtomicUnits(text: string): string[] {
  const blocks = text
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  const units: string[] = [];
  for (const block of blocks) {
    if (estimateTokens(block) <= MAX_PASSAGE_TOKENS) {
      units.push(block);
      continue;
    }
    for (const sentence of splitIntoSentences(block)) {
      if (estimateTokens(sentence) <= MAX_PASSAGE_TOKENS) {
        units.push(sentence);
      } else {
        units.push(...hardCutToPassageChars(sentence));
      }
    }
  }
  return units;
}

/** Split a block into sentences on `.`/`!`/`?` + whitespace, keeping the punctuation. */
function splitIntoSentences(block: string): string[] {
  return block
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Last-resort char-bounded cut for a single oversized sentence (no usable boundary). */
function hardCutToPassageChars(text: string): string[] {
  const maxChars = MAX_PASSAGE_TOKENS * 4;
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    pieces.push(text.slice(i, i + maxChars).trim());
  }
  return pieces.filter((p) => p.length > 0);
}

/** Greedily accumulate atomic units into passages bounded by the token cap. */
function packUnitsToPassages(units: string[]): string[] {
  const passages: string[] = [];
  let current = '';
  for (const unit of units) {
    const candidate = current.length === 0 ? unit : `${current}\n\n${unit}`;
    if (current.length > 0 && estimateTokens(candidate) > MAX_PASSAGE_TOKENS) {
      passages.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) passages.push(current);
  return passages;
}

// ---------- LLM call ----------

/**
 * Extract atomic durable facts from a single chunk via one LLM call.
 *
 * Returns:
 *   - ExtractedFact[]  on a successful parse — may be [] when the model parsed
 *                      fine but reported no durable facts (a VALID outcome, NOT
 *                      a failure),
 *   - null             when no LLM is configured, the call hard-failed, or the
 *                      response was unparseable.
 *
 * The caller treats only `null` as a chunk failure for diagnostics.
 * PII-safe: never logs the chunk or the raw response.
 */
export async function extractFacts(
  config: MemoryConfig,
  blob: string,
  mode: IngestMode,
): Promise<ExtractedFact[] | null> {
  const maxTokens = Math.min(1500, Math.max(300, estimateTokens(blob)));
  const raw = await llmComplete(config, systemPromptFor(mode), `<input>\n${blob}\n</input>`, { maxTokens });
  if (raw === null) return null;

  const facts = parseExtractedFacts(raw);
  if (facts === null) {
    // Genuine parse failure — content-free failure shape only (A6).
    console.error(`[memory-server] extraction: unparseable ${raw.length}-char response`);
    return null;
  }
  return facts;
}
