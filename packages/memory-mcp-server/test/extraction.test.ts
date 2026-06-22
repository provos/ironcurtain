import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseExtractedFacts,
  chunkBlob,
  MAX_INGEST_CHUNK_TOKENS,
  MAX_FACTS_PER_INGEST,
  MAX_INGEST_CHUNKS,
} from '../src/storage/extraction.js';
import { MAX_CONTENT_LENGTH } from '../src/tools/validation.js';
import { estimateTokens } from '../src/retrieval/scoring.js';

describe('parseExtractedFacts', () => {
  it('parses an array of {fact, importance} objects', () => {
    const raw =
      '[{"fact": "The user prefers dark mode", "importance": 0.8}, {"fact": "User uses Vim", "importance": 0.6}]';
    const facts = parseExtractedFacts(raw);
    expect(facts).toEqual([
      { fact: 'The user prefers dark mode', importance: 0.8 },
      { fact: 'User uses Vim', importance: 0.6 },
    ]);
  });

  it('trims whitespace from the fact string', () => {
    const facts = parseExtractedFacts('[{"fact": "  spaced fact  ", "importance": 0.5}]');
    expect(facts[0].fact).toBe('spaced fact');
  });

  it('tolerates bare-string items → importance undefined', () => {
    const facts = parseExtractedFacts('["A bare fact", "Another bare fact"]');
    expect(facts).toEqual([{ fact: 'A bare fact' }, { fact: 'Another bare fact' }]);
    expect(facts[0].importance).toBeUndefined();
  });

  it('treats missing importance as undefined', () => {
    const facts = parseExtractedFacts('[{"fact": "No importance here"}]');
    expect(facts).toEqual([{ fact: 'No importance here' }]);
    expect(facts[0].importance).toBeUndefined();
  });

  it('extracts a prose-wrapped JSON array', () => {
    const raw = 'Here are the facts:\n[{"fact": "Extracted from prose", "importance": 0.4}]\nThat is all.';
    const facts = parseExtractedFacts(raw);
    expect(facts).toEqual([{ fact: 'Extracted from prose', importance: 0.4 }]);
  });

  it('returns [] for non-array JSON', () => {
    expect(parseExtractedFacts('{"fact": "not an array"}')).toEqual([]);
  });

  it('returns [] for empty/junk input', () => {
    expect(parseExtractedFacts('')).toEqual([]);
    expect(parseExtractedFacts('not json at all')).toEqual([]);
    expect(parseExtractedFacts('[]')).toEqual([]);
  });

  it('drops items with empty or whitespace-only facts', () => {
    const facts = parseExtractedFacts('[{"fact": ""}, {"fact": "   "}, {"fact": "real"}]');
    expect(facts).toEqual([{ fact: 'real' }]);
  });

  it('drops items missing a string fact', () => {
    const facts = parseExtractedFacts('[{"importance": 0.5}, {"fact": 42}, {"fact": "ok"}]');
    expect(facts).toEqual([{ fact: 'ok' }]);
  });

  describe('importance clamping (A2)', () => {
    it('clamps importance above 1 to 1', () => {
      const facts = parseExtractedFacts('[{"fact": "too high", "importance": 5}]');
      expect(facts[0].importance).toBe(1);
    });

    it('clamps importance below 0 to 0', () => {
      const facts = parseExtractedFacts('[{"fact": "too low", "importance": -3}]');
      expect(facts[0].importance).toBe(0);
    });

    it('drops non-finite importance to undefined', () => {
      const facts = parseExtractedFacts('[{"fact": "infinite", "importance": 1e999}]');
      expect(facts[0].importance).toBeUndefined();
    });

    it('drops non-number importance to undefined', () => {
      const facts = parseExtractedFacts('[{"fact": "stringy", "importance": "high"}]');
      expect(facts[0].importance).toBeUndefined();
    });
  });

  it('caps an over-long fact at MAX_CONTENT_LENGTH', () => {
    const longFact = 'x'.repeat(MAX_CONTENT_LENGTH + 500);
    const facts = parseExtractedFacts(JSON.stringify([{ fact: longFact, importance: 0.5 }]));
    expect(facts).toHaveLength(1);
    expect(facts[0].fact.length).toBe(MAX_CONTENT_LENGTH);
  });

  it('caps the number of facts at MAX_FACTS_PER_INGEST', () => {
    const many = Array.from({ length: MAX_FACTS_PER_INGEST + 50 }, (_, i) => ({ fact: `fact ${i}` }));
    const facts = parseExtractedFacts(JSON.stringify(many));
    expect(facts.length).toBe(MAX_FACTS_PER_INGEST);
  });

  it('drops intra-batch exact-fact duplicates, keeping the first importance', () => {
    const raw = '[{"fact": "dup", "importance": 0.9}, {"fact": "dup", "importance": 0.1}, {"fact": "unique"}]';
    const facts = parseExtractedFacts(raw);
    expect(facts).toEqual([{ fact: 'dup', importance: 0.9 }, { fact: 'unique' }]);
  });

  describe('PII-safe parse (A6)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns [] on a non-JSON response and never echoes the sensitive substring on ANY channel', () => {
      // Widened beyond console.error to also cover process.stderr.write and
      // console.warn — future-proofs the guarantee against a regression that emits
      // via a different channel (T3).
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const sensitive = 'SSN-123-45-6789-SECRET';
      const raw = `Sorry, I cannot comply. ${sensitive} appears in the input.`;

      const facts = parseExtractedFacts(raw);

      expect(facts).toEqual([]);
      // parseExtractedFacts itself logs nothing, but assert defensively that nothing
      // it might emit on any stderr channel carries the substring.
      const allLogs = [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...stderrSpy.mock.calls]
        .map((c) => JSON.stringify(c))
        .join('\n');
      expect(allLogs).not.toContain(sensitive);
    });
  });
});

describe('chunkBlob', () => {
  it('returns a single chunk for a short blob', () => {
    const blob = 'line one\nline two\nline three';
    const chunks = chunkBlob(blob);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(blob);
  });

  function bigBlob(lineCount: number): string {
    // Each line ~ 200 chars (~50 tokens); lineCount lines comfortably exceeds the threshold.
    const line = 'word '.repeat(40).trim();
    return Array.from({ length: lineCount }, (_, i) => `${i}: ${line}`).join('\n');
  }

  it('splits a long blob into multiple newline-oriented chunks', () => {
    const blob = bigBlob(600);
    expect(estimateTokens(blob)).toBeGreaterThan(MAX_INGEST_CHUNK_TOKENS);

    const chunks = chunkBlob(blob);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should stay within (roughly) the token threshold.
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(MAX_INGEST_CHUNK_TOKENS + 200);
    }
  });

  it('overlaps adjacent chunks by ~10–15% of lines (A5)', () => {
    const blob = bigBlob(600);
    const chunks = chunkBlob(blob);
    expect(chunks.length).toBeGreaterThan(1);

    // The tail lines of chunk N must reappear as a contiguous prefix at the head
    // of chunk N+1 (the ~10–15% line overlap, A5).
    const firstLines = chunks[0].split('\n');
    const secondLines = chunks[1].split('\n');

    // The single last line of chunk 0 must reappear inside chunk 1's overlap region.
    const lastLine = firstLines[firstLines.length - 1];
    expect(secondLines).toContain(lastLine);

    // Find how long the shared prefix is, then assert it is a real tail of chunk 0.
    const overlapLen = secondLines.indexOf(lastLine) + 1;
    expect(overlapLen).toBeGreaterThan(0);
    const chunk0Tail = firstLines.slice(firstLines.length - overlapLen);
    expect(secondLines.slice(0, overlapLen)).toEqual(chunk0Tail);
  });

  it('hard-splits a single pathological line longer than the threshold', () => {
    const hugeLine = 'token '.repeat(MAX_INGEST_CHUNK_TOKENS * 2).trim();
    expect(estimateTokens(hugeLine)).toBeGreaterThan(MAX_INGEST_CHUNK_TOKENS);

    const chunks = chunkBlob(hugeLine);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(MAX_INGEST_CHUNK_TOKENS + 200);
    }
  });

  it('enforces the token cap as a HARD bound on a whitespace-free giant line (P1)', () => {
    // A 100k-char line with NO whitespace (e.g. base64 / minified JSON / one giant
    // token). Whitespace-splitting alone would return it whole and blow the cap;
    // the char-based hard cut must keep every emitted piece at or under the budget.
    const hugeToken = 'A'.repeat(100_000);
    expect(estimateTokens(hugeToken)).toBeGreaterThan(MAX_INGEST_CHUNK_TOKENS);

    const chunks = chunkBlob(hugeToken);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // HARD bound: no slack — each piece is ≤ the cap, not cap + epsilon.
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(MAX_INGEST_CHUNK_TOKENS);
    }
    // Round-trips losslessly (the cut only partitions, never drops characters).
    expect(chunks.join('')).toBe(hugeToken);
  });

  it('bounds the total chunk count at MAX_INGEST_CHUNKS', () => {
    const blob = bigBlob(20000);
    const chunks = chunkBlob(blob);
    expect(chunks.length).toBeLessThanOrEqual(MAX_INGEST_CHUNKS);
  });
});
