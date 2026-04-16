/**
 * TF-IDF word scorer for the observe TUI rain panel.
 *
 * Maintains a running TF-IDF model over the session, treating each
 * message turn or tool call as a "document" and the full session
 * history as the corpus. Produces top-scoring words for rain panel
 * word drops, with throttle/dedup to avoid repetition.
 *
 * Depends on observe-tui-types.ts only. No external dependencies.
 */

import type { TokenStreamEvent } from '../docker/token-stream-types.js';
import type { WordDropSource } from './observe-tui-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum word length to consider for scoring. */
const MIN_WORD_LENGTH = 4;

/** Number of top-scoring words to return per document. */
const TOP_N_WORDS = 3;

/** Milliseconds before a recently-shown word can be re-enqueued. */
const DEDUP_WINDOW_MS = 30_000;

/** Characters of accumulated text before mid-stream scoring triggers. */
const MID_STREAM_THRESHOLD = 200;

// ---------------------------------------------------------------------------
// Stop words
// ---------------------------------------------------------------------------

/** Common English words that are uninteresting for display. */
const ENGLISH_STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'back',
  'been',
  'before',
  'being',
  'between',
  'both',
  'came',
  'come',
  'could',
  'each',
  'does',
  'done',
  'down',
  'even',
  'find',
  'first',
  'from',
  'going',
  'good',
  'great',
  'have',
  'here',
  'into',
  'just',
  'know',
  'like',
  'long',
  'look',
  'made',
  'make',
  'many',
  'more',
  'most',
  'much',
  'must',
  'need',
  'never',
  'next',
  'only',
  'other',
  'over',
  'part',
  'said',
  'same',
  'should',
  'show',
  'some',
  'still',
  'such',
  'sure',
  'take',
  'tell',
  'than',
  'that',
  'them',
  'then',
  'there',
  'these',
  'they',
  'thing',
  'think',
  'this',
  'those',
  'through',
  'time',
  'used',
  'very',
  'want',
  'well',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'with',
  'without',
  'word',
  'work',
  'would',
  'year',
  'your',
]);

/** Common code tokens that are uninteresting for display. */
const CODE_STOP_WORDS = new Set([
  'async',
  'await',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'constructor',
  'continue',
  'default',
  'delete',
  'else',
  'enum',
  'error',
  'export',
  'extends',
  'false',
  'finally',
  'function',
  'global',
  'implements',
  'import',
  'instanceof',
  'interface',
  'module',
  'null',
  'number',
  'object',
  'package',
  'private',
  'protected',
  'public',
  'readonly',
  'require',
  'return',
  'static',
  'string',
  'super',
  'switch',
  'template',
  'this',
  'throw',
  'true',
  'type',
  'typeof',
  'undefined',
  'unknown',
  'void',
  'while',
  'with',
  'yield',
  'console',
  'process',
  'promise',
  'array',
]);

function isStopWord(word: string): boolean {
  const lower = word.toLowerCase();
  return ENGLISH_STOP_WORDS.has(lower) || CODE_STOP_WORDS.has(lower);
}

// ---------------------------------------------------------------------------
// Word extraction
// ---------------------------------------------------------------------------

/** Pattern for splitting text into word candidates. */
const WORD_SPLIT_RE = /[\s,.;:!?()[\]{}<>"'`|/\\=+*&#@^~]+/;

/** Strings that are purely numeric -- always rejected. */
const PURE_NUMERIC_RE = /^[0-9]+$/;

/** Strings that contain only hex characters (case-insensitive). */
const HEX_CHARS_ONLY_RE = /^[0-9a-f]+$/i;

/** Strings containing at least one digit. */
const CONTAINS_DIGIT_RE = /[0-9]/;

/**
 * Minimum length for a hex-looking string to be considered an
 * identifier/hash rather than an English word. Below this we
 * prefer to keep the word (e.g., "face", "cafe", "decade").
 */
const MIN_HEX_IDENTIFIER_LENGTH = 8;

/**
 * Reject strings that are purely numeric or clearly hash/identifier-like.
 *
 * Purely numeric: always rejected.
 * Hex-looking: rejected only when long enough AND containing at least one
 * digit. This catches commit SHAs and content hashes (e.g., `a3f92c1b8d4e`)
 * while preserving real English words that happen to use only hex letters
 * (e.g., `face`, `cafe`, `beef`, `decade`, `feedback`).
 */
function isNumericOrHashLike(lower: string): boolean {
  if (PURE_NUMERIC_RE.test(lower)) return true;
  if (HEX_CHARS_ONLY_RE.test(lower) && lower.length >= MIN_HEX_IDENTIFIER_LENGTH && CONTAINS_DIGIT_RE.test(lower)) {
    return true;
  }
  return false;
}

/**
 * Extract candidate words from plain text.
 *
 * Returns an array of { original, lower } tuples where `original`
 * preserves the source casing for display and `lower` is used for
 * matching and dedup.
 */
export function extractWordsFromText(text: string): Array<{ original: string; lower: string }> {
  const results: Array<{ original: string; lower: string }> = [];
  const parts = text.split(WORD_SPLIT_RE);

  for (const raw of parts) {
    // Strip leading/trailing punctuation and quotes
    const cleaned = raw.replace(/^[^a-zA-Z0-9_]+|[^a-zA-Z0-9_]+$/g, '');
    if (cleaned.length < MIN_WORD_LENGTH) continue;

    const lower = cleaned.toLowerCase();

    // Skip all-digit tokens and hash-like identifiers
    if (isNumericOrHashLike(lower)) continue;

    // Skip stop words
    if (isStopWord(cleaned)) continue;

    results.push({ original: cleaned, lower });
  }

  return results;
}

/** Pattern matching function/method calls like `foo.bar()` or `baz()`. */
const FUNC_CALL_RE = /(?:[\w$]+\.)*?([\w$]+)\s*\(/g;

/** Pattern matching meaningful string literals (single or double quoted, 4+ chars). */
const STRING_LITERAL_RE = /(?:"([^"]{4,})"|'([^']{4,})')/g;

/** Pattern matching MCP-style dotted tool names like `google_workspace.calendar_get_events`. */
const DOTTED_TOOL_RE = /(\w+)\.(\w{4,})/g;

/**
 * Extract words from code content (e.g., the `code` field of execute_code).
 *
 * Extracts function/method call names, meaningful string literals,
 * dotted tool names, and also runs the regular word extractor on
 * the full text.
 */
export function extractWordsFromCode(code: string): Array<{ original: string; lower: string }> {
  const results: Array<{ original: string; lower: string }> = [];
  const seen = new Set<string>();

  function addIfNew(original: string): void {
    const lower = original.toLowerCase();
    if (lower.length < MIN_WORD_LENGTH) return;
    if (seen.has(lower)) return;
    if (isNumericOrHashLike(lower)) return;
    if (isStopWord(original)) return;
    seen.add(lower);
    results.push({ original, lower });
  }

  // Extract function/method call names
  for (const match of code.matchAll(FUNC_CALL_RE)) {
    addIfNew(match[1]);
  }

  // Extract dotted tool names (second segment)
  for (const match of code.matchAll(DOTTED_TOOL_RE)) {
    addIfNew(match[2]);
  }

  // Extract string literals
  for (const match of code.matchAll(STRING_LITERAL_RE)) {
    const literal = match[1] || match[2];
    // Skip path-like strings unless they look like filenames
    if (literal.startsWith('/') && literal.includes('/')) {
      // Extract just the filename
      const segments = literal.split('/');
      const filename = segments[segments.length - 1];
      if (filename && filename.length >= MIN_WORD_LENGTH) {
        addIfNew(filename.replace(/\.[^.]+$/, '')); // strip extension
      }
    } else {
      // Run word extractor on the literal
      for (const w of extractWordsFromText(literal)) {
        addIfNew(w.original);
      }
    }
  }

  // Also run regular extraction on the full code text
  for (const w of extractWordsFromText(code)) {
    addIfNew(w.original);
  }

  return results;
}

/**
 * Try to extract the `code` field from accumulated tool input JSON.
 * Returns the code string, or null if parsing fails or no code field.
 */
export function extractCodeFromToolInput(accumulatedJson: string): string | null {
  try {
    const parsed: unknown = JSON.parse(accumulatedJson);
    if (parsed && typeof parsed === 'object' && 'code' in parsed) {
      const code = (parsed as Record<string, unknown>).code;
      if (typeof code === 'string') return code;
    }
  } catch {
    // Incomplete JSON -- expected during streaming
  }
  return null;
}

// ---------------------------------------------------------------------------
// TF-IDF scoring
// ---------------------------------------------------------------------------

/**
 * Compute term frequency for a list of words.
 * Returns a map from lowercase word to count.
 */
function computeTf(words: Array<{ lower: string }>): Map<string, number> {
  const tf = new Map<string, number>();
  for (const { lower } of words) {
    tf.set(lower, (tf.get(lower) ?? 0) + 1);
  }
  return tf;
}

/**
 * Scored word result from TF-IDF computation.
 */
export interface ScoredWord {
  /** Original-cased word for display. */
  word: string;
  /** Lowercase key for dedup. */
  key: string;
  /** TF-IDF score. */
  score: number;
}

// ---------------------------------------------------------------------------
// WordScorer
// ---------------------------------------------------------------------------

/** Public interface for the word scorer. */
export interface WordScorer {
  /**
   * Score a new document (message text or tool input).
   * Adds it to the corpus and returns the top-scoring words.
   */
  scoreDocument(words: Array<{ original: string; lower: string }>): ScoredWord[];

  /**
   * Check if a word can be shown (not recently displayed).
   * If allowed, records it as shown.
   */
  tryShow(key: string, now?: number): boolean;

  /** Number of documents in the corpus. */
  readonly documentCount: number;
}

/**
 * Create a WordScorer that maintains a running TF-IDF model.
 *
 * @param topN - Number of top-scoring words to return (default: 3)
 * @param dedupWindowMs - Milliseconds before re-showing a word (default: 30s)
 */
export function createWordScorer(topN = TOP_N_WORDS, dedupWindowMs = DEDUP_WINDOW_MS): WordScorer {
  // Corpus: document frequency (how many documents contain each word)
  const df = new Map<string, number>();
  let docCount = 0;

  // Recently shown words: key -> timestamp
  const recentlyShown = new Map<string, number>();

  return {
    get documentCount(): number {
      return docCount;
    },

    scoreDocument(words: Array<{ original: string; lower: string }>): ScoredWord[] {
      if (words.length === 0) return [];

      docCount++;

      // Update document frequency: each unique word in this doc increments df
      const uniqueInDoc = new Set<string>();
      for (const { lower } of words) {
        uniqueInDoc.add(lower);
      }
      for (const lower of uniqueInDoc) {
        df.set(lower, (df.get(lower) ?? 0) + 1);
      }

      // Compute TF for this document
      const tf = computeTf(words);

      // Build the best original-cased form for each word
      const bestOriginal = new Map<string, string>();
      for (const { original, lower } of words) {
        // Prefer the form that appears first
        if (!bestOriginal.has(lower)) {
          bestOriginal.set(lower, original);
        }
      }

      // Score each unique word: TF * IDF
      const scored: ScoredWord[] = [];
      for (const [lower, count] of tf) {
        const idf = Math.log((docCount + 1) / ((df.get(lower) ?? 0) + 1));
        const score = count * idf;
        scored.push({
          word: bestOriginal.get(lower) ?? lower,
          key: lower,
          score,
        });
      }

      // Sort by score descending, return top N
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topN);
    },

    tryShow(key: string, now?: number): boolean {
      const ts = now ?? Date.now();

      // Clean expired entries (amortized, check a few each call)
      let cleanCount = 0;
      for (const [k, t] of recentlyShown) {
        if (ts - t > dedupWindowMs) {
          recentlyShown.delete(k);
        }
        if (++cleanCount >= 5) break;
      }

      const lastShown = recentlyShown.get(key);
      if (lastShown !== undefined && ts - lastShown < dedupWindowMs) {
        return false;
      }

      recentlyShown.set(key, ts);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Tool name cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up MCP tool names for display.
 * Strips `mcp__` prefix and server name prefix.
 * e.g., `mcp__ironcurtain__execute_code` -> `execute_code`
 */
export function cleanToolName(toolName: string): string {
  // Strip mcp__serverName__ prefix
  const mpcPrefixMatch = toolName.match(/^mcp__[^_]+__(.+)$/);
  if (mpcPrefixMatch) return mpcPrefixMatch[1];

  // Strip simpler server__ prefix
  const serverPrefixMatch = toolName.match(/^[^_]+__(.+)$/);
  if (serverPrefixMatch) return serverPrefixMatch[1];

  return toolName;
}

/**
 * Shorten a model name for display.
 * Strips the "claude-" prefix if present.
 * e.g., "claude-sonnet-4-20250514" -> "sonnet-4-20250514"
 */
export function shortenModelName(model: string): string {
  if (model.startsWith('claude-')) return model.slice(7);
  return model;
}

// ---------------------------------------------------------------------------
// Text accumulator for mid-stream scoring
// ---------------------------------------------------------------------------

/** Tracks accumulated text for periodic mid-stream word extraction. */
export interface TextAccumulator {
  /** Append text and return words if the threshold is reached. */
  append(text: string): Array<{ original: string; lower: string }> | null;
  /** Flush remaining text and return words (for message_end). */
  flush(): Array<{ original: string; lower: string }>;
  /** Reset the accumulator (for message_start). */
  reset(): void;
  /** Current accumulated text length. */
  readonly length: number;
}

export function createTextAccumulator(threshold = MID_STREAM_THRESHOLD): TextAccumulator {
  let buffer = '';
  let scoredUpTo = 0;

  return {
    get length(): number {
      return buffer.length;
    },

    append(text: string): Array<{ original: string; lower: string }> | null {
      buffer += text;
      if (buffer.length - scoredUpTo >= threshold) {
        const words = extractWordsFromText(buffer.slice(scoredUpTo));
        scoredUpTo = buffer.length;
        return words.length > 0 ? words : null;
      }
      return null;
    },

    flush(): Array<{ original: string; lower: string }> {
      const words = extractWordsFromText(buffer);
      buffer = '';
      scoredUpTo = 0;
      return words;
    },

    reset(): void {
      buffer = '';
      scoredUpTo = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Tool input accumulator for word scoring
// ---------------------------------------------------------------------------

/** Tracks accumulated tool input JSON for word extraction on completion. */
export interface ToolInputAccumulator {
  /** Start a new tool call. */
  start(toolName: string): void;
  /** Append an input JSON delta fragment. */
  appendDelta(delta: string): void;
  /** Flush the accumulated input and return extracted words plus the tool name. */
  flush(): { toolName: string; words: Array<{ original: string; lower: string }> } | null;
  /** Whether a tool call is in progress. */
  readonly active: boolean;
}

export function createToolInputAccumulator(): ToolInputAccumulator {
  let toolName: string | null = null;
  let inputBuffer = '';

  return {
    get active(): boolean {
      return toolName !== null;
    },

    start(name: string): void {
      toolName = name;
      inputBuffer = '';
    },

    appendDelta(delta: string): void {
      inputBuffer += delta;
    },

    flush(): { toolName: string; words: Array<{ original: string; lower: string }> } | null {
      if (toolName === null) return null;

      const name = toolName;
      const accumulated = inputBuffer;
      toolName = null;
      inputBuffer = '';

      const words: Array<{ original: string; lower: string }> = [];

      // Try to extract code from execute_code tool input
      const code = extractCodeFromToolInput(accumulated);
      if (code) {
        words.push(...extractWordsFromCode(code));
      } else {
        // Fall back to plain text extraction from the raw JSON
        words.push(...extractWordsFromText(accumulated));
      }

      return { toolName: name, words };
    },
  };
}

// ---------------------------------------------------------------------------
// Per-session word scoring state
// ---------------------------------------------------------------------------

/** Per-session scoring state (text accumulator + tool input accumulator). */
export interface SessionWordState {
  readonly textAccumulator: TextAccumulator;
  readonly toolAccumulator: ToolInputAccumulator;
}

export function createSessionWordState(): SessionWordState {
  return {
    textAccumulator: createTextAccumulator(),
    toolAccumulator: createToolInputAccumulator(),
  };
}

// ---------------------------------------------------------------------------
// Orchestrator helper: process events and produce word drops
// ---------------------------------------------------------------------------

/** A word drop candidate ready for enqueuing. */
export interface WordDropCandidate {
  word: string;
  source: WordDropSource;
}

/**
 * Process a token stream event through the word scorer and produce
 * word drop candidates. Returns an array of candidates to enqueue.
 *
 * This is the main integration point between the orchestrator and
 * the word scorer. The caller is responsible for calling
 * `rainEngine.enqueueWord()` for each returned candidate.
 */
export function processEventForWords(
  event: TokenStreamEvent,
  sessionWordState: SessionWordState,
  scorer: WordScorer,
  now?: number,
): WordDropCandidate[] {
  const candidates: WordDropCandidate[] = [];
  const ts = now ?? Date.now();

  function addScoredWords(words: Array<{ original: string; lower: string }>, source: WordDropSource): void {
    const scored = scorer.scoreDocument(words);
    for (const s of scored) {
      if (scorer.tryShow(s.key, ts)) {
        candidates.push({ word: s.word, source });
      }
    }
  }

  switch (event.kind) {
    case 'message_start': {
      sessionWordState.textAccumulator.reset();
      const short = shortenModelName(event.model);
      if (scorer.tryShow(short.toLowerCase(), ts)) {
        candidates.push({ word: short, source: 'model' });
      }
      break;
    }

    case 'text_delta': {
      const midWords = sessionWordState.textAccumulator.append(event.text);
      if (midWords) {
        addScoredWords(midWords, 'text');
      }
      break;
    }

    case 'tool_use': {
      if (event.toolName !== '') {
        // New tool call starting: flush any previous tool accumulator
        const prev = sessionWordState.toolAccumulator.flush();
        if (prev && prev.words.length > 0) {
          addScoredWords(prev.words, 'tool');
        }
        // Start new accumulator
        sessionWordState.toolAccumulator.start(event.toolName);
        // Enqueue cleaned tool name
        const cleaned = cleanToolName(event.toolName);
        if (cleaned.length >= MIN_WORD_LENGTH && scorer.tryShow(cleaned.toLowerCase(), ts)) {
          candidates.push({ word: cleaned, source: 'tool' });
        }
      } else if (event.inputDelta) {
        // input_json_delta fragment
        sessionWordState.toolAccumulator.appendDelta(event.inputDelta);
      }
      break;
    }

    case 'message_end': {
      // Flush text accumulator
      const textWords = sessionWordState.textAccumulator.flush();
      if (textWords.length > 0) {
        addScoredWords(textWords, 'text');
      }
      // Flush tool accumulator (in case the last tool call wasn't followed by another)
      const toolResult = sessionWordState.toolAccumulator.flush();
      if (toolResult && toolResult.words.length > 0) {
        addScoredWords(toolResult.words, 'tool');
      }
      break;
    }
  }

  return candidates;
}
