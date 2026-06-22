import { describe, it, expect } from 'vitest';

import {
  assembleTranscript,
  isEmptyConversation,
  buildSource,
  resolveAsOf,
  buildProgressRecord,
  buildEmptyProgressRecord,
  computeResumeSet,
  parseArgs,
  DEFAULT_ARGS,
  type ExportConversation,
  type ProgressRecord,
  type IngestResultLike,
} from '../scripts/memory-corpus/corpus-lib.js';

// ---------- Synthetic fixtures (NOT real export data) ----------

function conv(overrides: Partial<ExportConversation> = {}): ExportConversation {
  return {
    uuid: 'conv-1',
    created_at: '2023-05-01T12:00:00.000Z',
    chat_messages: [
      { uuid: 'm1', sender: 'human', text: 'I prefer dark mode.' },
      { uuid: 'm2', sender: 'assistant', text: 'Noted, dark mode it is.' },
    ],
    ...overrides,
  };
}

describe('assembleTranscript', () => {
  it('labels each line with the sender and joins with newlines', () => {
    expect(assembleTranscript(conv())).toBe('human: I prefer dark mode.\nassistant: Noted, dark mode it is.');
  });

  it('drops messages whose text is empty or whitespace-only', () => {
    const c = conv({
      chat_messages: [
        { uuid: 'm1', sender: 'human', text: 'keep me' },
        { uuid: 'm2', sender: 'assistant', text: '' },
        { uuid: 'm3', sender: 'human', text: '   ' },
        { uuid: 'm4', sender: 'assistant', text: 'keep me too' },
      ],
    });
    expect(assembleTranscript(c)).toBe('human: keep me\nassistant: keep me too');
  });

  it('uses `text`, never `content`', () => {
    // A message carrying only structured `content` (no usable text) is dropped.
    const c = conv({
      chat_messages: [
        { uuid: 'm1', sender: 'human', text: '', content: [{ type: 'text', text: 'from content' }] } as never,
        { uuid: 'm2', sender: 'assistant', text: 'from text' },
      ],
    });
    const transcript = assembleTranscript(c);
    expect(transcript).toBe('assistant: from text');
    expect(transcript).not.toContain('from content');
  });
});

describe('isEmptyConversation', () => {
  it('is false when at least one message has non-empty text', () => {
    expect(isEmptyConversation(conv())).toBe(false);
  });

  it('is true when there are no messages', () => {
    expect(isEmptyConversation(conv({ chat_messages: [] }))).toBe(true);
  });

  it('is true when all messages have empty/whitespace text', () => {
    const c = conv({
      chat_messages: [
        { uuid: 'm1', sender: 'human', text: '' },
        { uuid: 'm2', sender: 'assistant', text: '  ' },
      ],
    });
    expect(isEmptyConversation(c)).toBe(true);
  });
});

describe('buildSource', () => {
  it('formats the provenance string as claude-export:<uuid>', () => {
    expect(buildSource('3f2a-abc')).toBe('claude-export:3f2a-abc');
  });
});

describe('resolveAsOf (created_at is the backdate source)', () => {
  it('resolves an ISO 8601 created_at to its epoch-ms (not now)', () => {
    // The driver passes resolveAsOf(conv.created_at) as as_of; this asserts the
    // contract that created_at is the source-of-truth timestamp, not now.
    const c = conv({ created_at: '2024-02-29T08:30:00.000Z' });
    expect(resolveAsOf(c.created_at)).toBe(Date.UTC(2024, 1, 29, 8, 30, 0));
  });

  it('returns undefined for an unparseable or missing created_at (engine falls back to now)', () => {
    expect(resolveAsOf('not a date')).toBeUndefined();
    expect(resolveAsOf('')).toBeUndefined();
    expect(resolveAsOf(undefined)).toBeUndefined();
  });
});

describe('buildProgressRecord', () => {
  function result(overrides: Partial<IngestResultLike> = {}): IngestResultLike {
    return { created: 5, merged: 2, facts: { length: 7 }, ...overrides };
  }

  it('records counts only (no fact text)', () => {
    const record = buildProgressRecord('conv-9', result({ chunks: 3, failed_chunks: 0 }));
    expect(record).toEqual({
      uuid: 'conv-9',
      status: 'ingested',
      created: 5,
      merged: 2,
      facts: 7,
      failed_chunks: 0,
      chunks: 3,
    });
  });

  it('marks status=partial when partial is set', () => {
    const record = buildProgressRecord('c', result({ partial: true, failed_chunks: 1, chunks: 2 }));
    expect(record.status).toBe('partial');
    expect(record.failed_chunks).toBe(1);
  });

  it('marks status=skipped-failed when skipped is set', () => {
    const record = buildProgressRecord('c', result({ skipped: true, created: 0, merged: 0, facts: { length: 0 } }));
    expect(record.status).toBe('skipped-failed');
  });

  it('defaults chunks to 1 and failed_chunks to 0 when omitted', () => {
    const record = buildProgressRecord('c', result());
    expect(record.chunks).toBe(1);
    expect(record.failed_chunks).toBe(0);
  });

  it('buildEmptyProgressRecord produces a zeroed skipped-empty record', () => {
    expect(buildEmptyProgressRecord('e')).toEqual({
      uuid: 'e',
      status: 'skipped-empty',
      created: 0,
      merged: 0,
      facts: 0,
      failed_chunks: 0,
      chunks: 0,
    });
  });
});

describe('computeResumeSet', () => {
  const records: ProgressRecord[] = [
    { uuid: 'done-ingested', status: 'ingested', created: 3, merged: 0, facts: 3, failed_chunks: 0, chunks: 1 },
    { uuid: 'done-partial', status: 'partial', created: 1, merged: 0, facts: 1, failed_chunks: 1, chunks: 2 },
    { uuid: 'done-empty', status: 'skipped-empty', created: 0, merged: 0, facts: 0, failed_chunks: 0, chunks: 0 },
    { uuid: 'retry-failed', status: 'skipped-failed', created: 0, merged: 0, facts: 0, failed_chunks: 1, chunks: 1 },
  ];

  it('skips ingested, partial, and skipped-empty; retries skipped-failed', () => {
    const skip = computeResumeSet(records);
    expect(skip.has('done-ingested')).toBe(true);
    expect(skip.has('done-partial')).toBe(true);
    expect(skip.has('done-empty')).toBe(true);
    expect(skip.has('retry-failed')).toBe(false);
  });

  it('treats a uuid as done if any of its records is done, even if a prior attempt failed', () => {
    const withRetry: ProgressRecord[] = [
      { uuid: 'x', status: 'skipped-failed', created: 0, merged: 0, facts: 0, failed_chunks: 1, chunks: 1 },
      { uuid: 'x', status: 'ingested', created: 2, merged: 0, facts: 2, failed_chunks: 0, chunks: 1 },
    ];
    expect(computeResumeSet(withRetry).has('x')).toBe(true);
  });

  it('returns an empty set for no records', () => {
    expect(computeResumeSet([]).size).toBe(0);
  });
});

describe('parseArgs', () => {
  it('applies defaults when no flags are given', () => {
    const args = parseArgs([]);
    expect(args.exportPath).toBe(DEFAULT_ARGS.exportPath);
    expect(args.dbPath).toBe(DEFAULT_ARGS.dbPath);
    expect(args.namespace).toBe(DEFAULT_ARGS.namespace);
    expect(args.dryRun).toBe(false);
    expect(args.resume).toBe(false);
    expect(args.limit).toBeUndefined();
    expect(args.conversation).toBeUndefined();
  });

  it('parses value flags', () => {
    const args = parseArgs([
      '--export',
      '/tmp/e.json',
      '--db',
      '/tmp/m.memdb',
      '--namespace',
      'ns',
      '--conversation',
      'abc-123',
    ]);
    expect(args.exportPath).toBe('/tmp/e.json');
    expect(args.dbPath).toBe('/tmp/m.memdb');
    expect(args.namespace).toBe('ns');
    expect(args.conversation).toBe('abc-123');
  });

  it('parses boolean flags', () => {
    const args = parseArgs(['--dry-run', '--resume']);
    expect(args.dryRun).toBe(true);
    expect(args.resume).toBe(true);
  });

  it('parses --limit as a positive integer', () => {
    expect(parseArgs(['--limit', '3']).limit).toBe(3);
  });

  it('rejects a non-positive or non-integer --limit', () => {
    expect(() => parseArgs(['--limit', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--limit', '-1'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--limit', 'abc'])).toThrow(/positive integer/);
  });

  it('throws when a value flag is missing its value', () => {
    expect(() => parseArgs(['--db'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--db', '--resume'])).toThrow(/requires a value/);
  });

  it('throws on an unknown flag', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown flag/);
  });

  it('sets help for --help and -h', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});
