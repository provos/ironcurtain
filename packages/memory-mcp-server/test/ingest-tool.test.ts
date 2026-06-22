import { describe, it, expect, vi } from 'vitest';
import type { MemoryEngine } from '../src/engine.js';
import type { IngestResult } from '../src/types.js';
import { validateIngestInput, handleIngest, formatIngestResult } from '../src/tools/ingest.js';

function createMockEngine(ingestResult: IngestResult): MemoryEngine {
  return {
    store: vi.fn().mockResolvedValue({ id: 'x', action: 'created' }),
    ingest: vi.fn().mockResolvedValue(ingestResult),
    recall: vi.fn(),
    context: vi.fn(),
    forget: vi.fn(),
    inspect: vi.fn(),
    expand: vi.fn(),
    close: vi.fn(),
  };
}

describe('validateIngestInput', () => {
  it('rejects missing content', () => {
    expect(() => validateIngestInput({})).toThrow('content is required');
  });

  it('rejects empty / whitespace-only content', () => {
    expect(() => validateIngestInput({ content: '   ' })).toThrow('content is required');
  });

  it('rejects non-string content', () => {
    expect(() => validateIngestInput({ content: 42 })).toThrow('content is required');
  });

  it('trims content', () => {
    const input = validateIngestInput({ content: '  hello  ' });
    expect(input.content).toBe('hello');
  });

  it('defaults mode to conversation', () => {
    const input = validateIngestInput({ content: 'x' });
    expect(input.mode).toBe('conversation');
  });

  it('accepts mode=document', () => {
    const input = validateIngestInput({ content: 'x', mode: 'document' });
    expect(input.mode).toBe('document');
  });

  it('rejects an invalid mode', () => {
    expect(() => validateIngestInput({ content: 'x', mode: 'summary' })).toThrow('mode must be');
  });

  it('defaults on_extraction_failure to degrade', () => {
    const input = validateIngestInput({ content: 'x' });
    expect(input.on_extraction_failure).toBe('degrade');
  });

  it('accepts skip and error for on_extraction_failure', () => {
    expect(validateIngestInput({ content: 'x', on_extraction_failure: 'skip' }).on_extraction_failure).toBe('skip');
    expect(validateIngestInput({ content: 'x', on_extraction_failure: 'error' }).on_extraction_failure).toBe('error');
  });

  it('rejects an on_extraction_failure outside the enum', () => {
    expect(() => validateIngestInput({ content: 'x', on_extraction_failure: 'retry' })).toThrow(
      'on_extraction_failure must be',
    );
  });

  it('defaults dry_run to false', () => {
    expect(validateIngestInput({ content: 'x' }).dry_run).toBe(false);
  });

  it('rejects a non-boolean dry_run', () => {
    expect(() => validateIngestInput({ content: 'x', dry_run: 'yes' })).toThrow('dry_run must be a boolean');
  });

  describe('as_of normalization', () => {
    it('passes through an epoch-ms number', () => {
      const input = validateIngestInput({ content: 'x', as_of: 1_700_000_000_000 });
      expect(input.as_of).toBe(1_700_000_000_000);
    });

    it('normalizes an ISO 8601 string to epoch ms', () => {
      const iso = '2023-01-15T00:00:00.000Z';
      const input = validateIngestInput({ content: 'x', as_of: iso });
      expect(input.as_of).toBe(Date.parse(iso));
    });

    it('accepts a numeric STRING as epoch ms (P2)', () => {
      const input = validateIngestInput({ content: 'x', as_of: '1700000000000' });
      expect(input.as_of).toBe(1_700_000_000_000);
      // The engine contract is numeric — never a string.
      expect(typeof input.as_of).toBe('number');
    });

    it('rejects an empty / whitespace-only as_of string (P2 — Number("") is 0, must stay unparseable)', () => {
      expect(() => validateIngestInput({ content: 'x', as_of: '' })).toThrow('as_of');
      expect(() => validateIngestInput({ content: 'x', as_of: '   ' })).toThrow('as_of');
    });

    it('rejects a negative numeric as_of string (P2)', () => {
      expect(() => validateIngestInput({ content: 'x', as_of: '-1700000000000' })).toThrow('as_of');
    });

    it('rejects a non-parseable as_of string', () => {
      expect(() => validateIngestInput({ content: 'x', as_of: 'not a date' })).toThrow('as_of');
    });

    it('rejects a negative as_of number', () => {
      expect(() => validateIngestInput({ content: 'x', as_of: -5 })).toThrow('as_of');
    });

    it('rejects a non-finite as_of number', () => {
      expect(() => validateIngestInput({ content: 'x', as_of: Number.POSITIVE_INFINITY })).toThrow('as_of');
    });

    it('leaves as_of undefined when omitted', () => {
      expect(validateIngestInput({ content: 'x' }).as_of).toBeUndefined();
    });
  });

  it('validates tags and importance', () => {
    const input = validateIngestInput({ content: 'x', tags: ['a', 'b'], importance: 0.7 });
    expect(input.tags).toEqual(['a', 'b']);
    expect(input.importance).toBe(0.7);
  });

  it('rejects importance out of [0,1]', () => {
    expect(() => validateIngestInput({ content: 'x', importance: 1.5 })).toThrow('importance must be');
  });
});

describe('handleIngest routing', () => {
  it('routes to engine.ingest with normalized options', async () => {
    const result: IngestResult = {
      created: 2,
      merged: 1,
      memory_ids: ['a1b2c3d4e5', 'f6g7h8i9j0', 'k1l2m3n4o5'],
      facts: [{ fact: 'f1' }, { fact: 'f2' }, { fact: 'f3' }],
    };
    const engine = createMockEngine(result);
    const text = await handleIngest(engine, {
      content: '  blob  ',
      mode: 'document',
      tags: ['seed'],
      importance: 0.6,
      as_of: '2023-01-15T00:00:00.000Z',
    });

    expect(engine.ingest).toHaveBeenCalledWith('blob', {
      source: undefined,
      mode: 'document',
      tags: ['seed'],
      importance: 0.6,
      dry_run: false,
      as_of: Date.parse('2023-01-15T00:00:00.000Z'),
      on_extraction_failure: 'degrade',
    });
    expect(text).toContain('Ingested 3 atomic fact');
    expect(text).toContain('2 new memories, 1 merged');
  });
});

describe('formatIngestResult', () => {
  it('renders a normal result reporting created and merged separately (A7)', () => {
    const text = formatIngestResult(
      {
        created: 6,
        merged: 1,
        memory_ids: ['aaaaaaaa11', 'bbbbbbbb22'],
        facts: Array.from({ length: 7 }, (_, i) => ({ fact: `f${i}` })),
      },
      false,
    );
    expect(text).toContain('Ingested 7 atomic fact');
    expect(text).toContain('6 new memories');
    expect(text).toContain('1 merged into existing');
    expect(text).toContain('aaaaaaaa…');
  });

  it('renders a clean empty result as a 0-fact ingest, not a dry run or failure', () => {
    const text = formatIngestResult({ created: 0, merged: 0, memory_ids: [], facts: [] }, false);
    expect(text).toContain('Ingested 0 atomic fact');
    expect(text).not.toContain('Dry run');
    expect(text).not.toContain('failed');
  });

  it('renders a dry_run preview with per-fact importance', () => {
    const text = formatIngestResult(
      {
        created: 0,
        merged: 0,
        memory_ids: [],
        facts: [{ fact: 'First fact', importance: 0.9 }, { fact: 'Second fact' }],
      },
      true,
    );
    expect(text).toContain('Dry run — nothing written.');
    expect(text).toContain('1. First fact (importance: 0.9)');
    expect(text).toContain('2. Second fact');
  });

  it('flags an incomplete dry_run preview when a chunk failed (A3/A4)', () => {
    const text = formatIngestResult(
      {
        created: 0,
        merged: 0,
        memory_ids: [],
        facts: [{ fact: 'Only fact from the good chunk' }],
        chunks: 2,
        failed_chunks: 1,
        partial: true,
      },
      true,
    );
    expect(text).toContain('Dry run — nothing written.');
    expect(text).toContain('1 of 2 chunks failed extraction');
    expect(text).toMatch(/incomplete|missing facts/i);
  });

  it('renders a partial result', () => {
    const text = formatIngestResult(
      {
        created: 3,
        merged: 1,
        memory_ids: ['id1', 'id2', 'id3', 'id4'],
        facts: Array.from({ length: 4 }, (_, i) => ({ fact: `f${i}` })),
        chunks: 3,
        failed_chunks: 1,
        degraded: true,
        partial: true,
      },
      false,
    );
    expect(text).toContain('Ingested 4 atomic fact');
    expect(text).toContain('1 of 3 chunks failed extraction — partial result.');
  });

  it('renders a full degrade (single-blob store)', () => {
    const text = formatIngestResult(
      {
        created: 1,
        merged: 0,
        memory_ids: ['deadbeef99'],
        facts: [{ fact: 'the whole blob', importance: 0.5 }],
        degraded: true,
      },
      false,
    );
    expect(text).toContain('stored the blob as a single memory deadbeef…');
  });

  it('renders a skipped result', () => {
    const text = formatIngestResult({ created: 0, merged: 0, memory_ids: [], facts: [], skipped: true }, false);
    expect(text).toContain('nothing written');
    expect(text).toContain('skip');
  });
});
