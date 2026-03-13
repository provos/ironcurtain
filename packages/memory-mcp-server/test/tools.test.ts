import { describe, it, expect, vi } from 'vitest';
import type { MemoryEngine } from '../src/engine.js';
import { validateStoreInput, handleStore, formatStoreResult } from '../src/tools/store.js';
import { validateRecallInput, handleRecall } from '../src/tools/recall.js';
import { validateContextInput, handleContext } from '../src/tools/context.js';
import { validateForgetInput, handleForget } from '../src/tools/forget.js';
import { validateInspectInput, handleInspect } from '../src/tools/inspect.js';

function createMockEngine(overrides: Partial<MemoryEngine> = {}): MemoryEngine {
  return {
    store: vi.fn().mockResolvedValue({ id: 'abc123', action: 'created' }),
    recall: vi.fn().mockResolvedValue({
      content: 'Recalled content',
      memories_used: 3,
      total_matches: 10,
    }),
    context: vi.fn().mockResolvedValue('## Memory Briefing\n\nSome context here.'),
    forget: vi.fn().mockResolvedValue({ forgotten: 2 }),
    inspect: vi.fn().mockResolvedValue({
      total_memories: 100,
      active_memories: 80,
      decayed_memories: 15,
      compacted_memories: 5,
      oldest_memory: '2025-01-01T00:00:00Z',
      newest_memory: '2026-03-11T00:00:00Z',
      storage_bytes: 1048576,
      top_tags: [{ tag: 'preference', count: 42 }],
    }),
    close: vi.fn(),
    ...overrides,
  };
}

// ── memory_store validation ──────────────────────────────────────────

describe('memory_store', () => {
  describe('validateStoreInput', () => {
    it('accepts valid content only', () => {
      const result = validateStoreInput({ content: 'User likes dark mode' });
      expect(result.content).toBe('User likes dark mode');
      expect(result.tags).toBeUndefined();
      expect(result.importance).toBeUndefined();
    });

    it('accepts content with tags and importance', () => {
      const result = validateStoreInput({
        content: 'A fact',
        tags: ['pref', 'ui'],
        importance: 0.8,
      });
      expect(result.tags).toEqual(['pref', 'ui']);
      expect(result.importance).toBe(0.8);
    });

    it('trims content whitespace', () => {
      const result = validateStoreInput({ content: '  trimmed  ' });
      expect(result.content).toBe('trimmed');
    });

    it('rejects missing content', () => {
      expect(() => validateStoreInput({})).toThrow('content is required');
    });

    it('rejects empty content', () => {
      expect(() => validateStoreInput({ content: '   ' })).toThrow('content is required');
    });

    it('rejects non-string content', () => {
      expect(() => validateStoreInput({ content: 42 })).toThrow('content is required');
    });

    it('rejects non-array tags', () => {
      expect(() => validateStoreInput({ content: 'ok', tags: 'not-array' })).toThrow('tags must be an array');
    });

    it('rejects tags with non-string elements', () => {
      expect(() => validateStoreInput({ content: 'ok', tags: [1, 2] })).toThrow('tags must be an array of strings');
    });

    it('rejects importance out of range', () => {
      expect(() => validateStoreInput({ content: 'ok', importance: 1.5 })).toThrow(
        'importance must be a number between 0 and 1',
      );
    });

    it('rejects negative importance', () => {
      expect(() => validateStoreInput({ content: 'ok', importance: -0.1 })).toThrow(
        'importance must be a number between 0 and 1',
      );
    });
  });

  describe('formatStoreResult', () => {
    it('formats created result', () => {
      expect(formatStoreResult({ id: 'x', action: 'created' })).toBe('Stored memory x');
    });

    it('formats merged_duplicate result', () => {
      expect(formatStoreResult({ id: 'x', action: 'merged_duplicate' })).toContain('duplicate');
    });

    it('formats contradiction_resolved result', () => {
      expect(formatStoreResult({ id: 'x', action: 'contradiction_resolved' })).toContain('contradiction');
    });
  });

  describe('handleStore', () => {
    it('calls engine.store with correct args', async () => {
      const engine = createMockEngine();
      await handleStore(engine, {
        content: 'fact',
        tags: ['a'],
        importance: 0.7,
      });
      expect(engine.store).toHaveBeenCalledWith('fact', {
        tags: ['a'],
        importance: 0.7,
      });
    });

    it('returns formatted result', async () => {
      const engine = createMockEngine();
      const result = await handleStore(engine, { content: 'fact' });
      expect(result).toBe('Stored memory abc123');
    });
  });
});

// ── memory_recall validation ─────────────────────────────────────────

describe('memory_recall', () => {
  describe('validateRecallInput', () => {
    it('accepts query only', () => {
      const result = validateRecallInput({ query: 'testing preferences' });
      expect(result.query).toBe('testing preferences');
    });

    it('accepts all optional fields', () => {
      const result = validateRecallInput({
        query: 'q',
        token_budget: 200,
        tags: ['pref'],
        format: 'list',
      });
      expect(result.token_budget).toBe(200);
      expect(result.tags).toEqual(['pref']);
      expect(result.format).toBe('list');
    });

    it('rejects missing query', () => {
      expect(() => validateRecallInput({})).toThrow('query is required');
    });

    it('rejects empty query', () => {
      expect(() => validateRecallInput({ query: '' })).toThrow('query is required');
    });

    it('rejects non-integer token_budget', () => {
      expect(() => validateRecallInput({ query: 'q', token_budget: 1.5 })).toThrow(
        'token_budget must be a positive integer',
      );
    });

    it('rejects zero token_budget', () => {
      expect(() => validateRecallInput({ query: 'q', token_budget: 0 })).toThrow(
        'token_budget must be a positive integer',
      );
    });

    it('accepts answer format', () => {
      const result = validateRecallInput({ query: 'q', format: 'answer' });
      expect(result.format).toBe('answer');
    });

    it('rejects invalid format', () => {
      expect(() => validateRecallInput({ query: 'q', format: 'xml' })).toThrow('format must be one of');
    });
  });

  describe('handleRecall', () => {
    it('calls engine.recall with correct args', async () => {
      const engine = createMockEngine();
      await handleRecall(engine, { query: 'test', format: 'raw' });
      expect(engine.recall).toHaveBeenCalledWith({
        query: 'test',
        token_budget: undefined,
        tags: undefined,
        format: 'raw',
      });
    });

    it('returns no-match message when empty', async () => {
      const engine = createMockEngine({
        recall: vi.fn().mockResolvedValue({
          content: '',
          memories_used: 0,
          total_matches: 0,
        }),
      });
      const result = await handleRecall(engine, { query: 'test' });
      expect(result).toBe('No relevant memories found.');
    });

    it('returns content when memories found', async () => {
      const engine = createMockEngine();
      const result = await handleRecall(engine, { query: 'test' });
      expect(result).toBe('Recalled content');
    });
  });
});

// ── memory_context validation ────────────────────────────────────────

describe('memory_context', () => {
  describe('validateContextInput', () => {
    it('accepts empty args', () => {
      const result = validateContextInput({});
      expect(result.task).toBeUndefined();
      expect(result.token_budget).toBeUndefined();
    });

    it('accepts task and token_budget', () => {
      const result = validateContextInput({
        task: 'Fix auth bug',
        token_budget: 1000,
      });
      expect(result.task).toBe('Fix auth bug');
      expect(result.token_budget).toBe(1000);
    });

    it('trims task whitespace', () => {
      const result = validateContextInput({ task: '  fix it  ' });
      expect(result.task).toBe('fix it');
    });

    it('rejects non-string task', () => {
      expect(() => validateContextInput({ task: 42 })).toThrow('task must be a string');
    });
  });

  describe('handleContext', () => {
    it('calls engine.context', async () => {
      const engine = createMockEngine();
      await handleContext(engine, { task: 'test' });
      expect(engine.context).toHaveBeenCalledWith({
        task: 'test',
        token_budget: undefined,
      });
    });

    it('returns fresh session message when empty', async () => {
      const engine = createMockEngine({
        context: vi.fn().mockResolvedValue(''),
      });
      const result = await handleContext(engine, {});
      expect(result).toContain('fresh session');
    });
  });
});

// ── memory_forget validation ─────────────────────────────────────────

describe('memory_forget', () => {
  describe('validateForgetInput', () => {
    it('accepts ids', () => {
      const result = validateForgetInput({ ids: ['a', 'b'] });
      expect(result.ids).toEqual(['a', 'b']);
    });

    it('accepts tags with confirm', () => {
      const result = validateForgetInput({
        tags: ['old'],
        confirm: true,
      });
      expect(result.tags).toEqual(['old']);
      expect(result.confirm).toBe(true);
    });

    it('accepts before timestamp', () => {
      const result = validateForgetInput({
        before: '2025-01-01T00:00:00Z',
        confirm: true,
      });
      expect(result.before).toBe('2025-01-01T00:00:00Z');
    });

    it('rejects no targeting criteria', () => {
      expect(() => validateForgetInput({})).toThrow('At least one of ids, tags, query, or before');
    });

    it('rejects invalid before timestamp', () => {
      expect(() => validateForgetInput({ before: 'not-a-date' })).toThrow('valid ISO 8601');
    });

    it('rejects non-array ids', () => {
      expect(() => validateForgetInput({ ids: 'single' })).toThrow('ids must be an array');
    });
  });

  describe('handleForget', () => {
    it('requires confirmation for bulk operations', async () => {
      const engine = createMockEngine();
      const result = await handleForget(engine, { tags: ['old'] });
      expect(result).toContain('confirm=true');
      expect(engine.forget).not.toHaveBeenCalled();
    });

    it('allows id-based deletion without confirm', async () => {
      const engine = createMockEngine();
      await handleForget(engine, { ids: ['abc'] });
      expect(engine.forget).toHaveBeenCalled();
    });

    it('formats dry_run preview', async () => {
      const engine = createMockEngine({
        forget: vi.fn().mockResolvedValue({
          forgotten: 2,
          memories: [
            { id: 'a', content: 'First memory' },
            { id: 'b', content: 'Second memory' },
          ],
        }),
      });
      const result = await handleForget(engine, {
        tags: ['old'],
        confirm: true,
        dry_run: true,
      });
      expect(result).toContain('Would forget 2');
      expect(result).toContain('First memory');
    });

    it('formats deletion count', async () => {
      const engine = createMockEngine();
      const result = await handleForget(engine, { ids: ['a'] });
      expect(result).toBe('Forgot 2 memories.');
    });
  });
});

// ── memory_inspect validation ────────────────────────────────────────

describe('memory_inspect', () => {
  describe('validateInspectInput', () => {
    it('accepts empty args (defaults to stats)', () => {
      const result = validateInspectInput({});
      expect(result.view).toBeUndefined();
    });

    it('accepts valid view', () => {
      const result = validateInspectInput({ view: 'recent', limit: 5 });
      expect(result.view).toBe('recent');
      expect(result.limit).toBe(5);
    });

    it('accepts ids', () => {
      const result = validateInspectInput({ ids: ['x', 'y'] });
      expect(result.ids).toEqual(['x', 'y']);
    });

    it('rejects invalid view', () => {
      expect(() => validateInspectInput({ view: 'invalid' })).toThrow('view must be one of');
    });

    it('rejects non-positive limit', () => {
      expect(() => validateInspectInput({ limit: 0 })).toThrow('limit must be a positive integer');
    });

    it('rejects non-integer limit', () => {
      expect(() => validateInspectInput({ limit: 2.5 })).toThrow('limit must be a positive integer');
    });
  });

  describe('handleInspect', () => {
    it('formats stats view', async () => {
      const engine = createMockEngine();
      const result = await handleInspect(engine, { view: 'stats' });
      expect(result).toContain('Memory Statistics');
      expect(result).toContain('Total memories: 100');
      expect(result).toContain('Active: 80');
      expect(result).toContain('preference: 42');
      expect(result).toContain('1.0 MB');
    });

    it('formats memory list', async () => {
      const engine = createMockEngine({
        inspect: vi.fn().mockResolvedValue([
          {
            id: 'mem1',
            namespace: 'default',
            content: 'User likes tests',
            tags: ['preference'],
            importance: 0.8,
            created_at: 1710000000000,
            updated_at: 1710000000000,
            last_accessed_at: 1710000000000,
            access_count: 3,
            is_compacted: false,
            compacted_from: null,
            source: null,
            metadata: null,
          },
        ]),
      });
      const result = await handleInspect(engine, { view: 'recent' });
      expect(result).toContain('mem1');
      expect(result).toContain('User likes tests');
      expect(result).toContain('preference');
    });

    it('formats empty memory list', async () => {
      const engine = createMockEngine({
        inspect: vi.fn().mockResolvedValue([]),
      });
      const result = await handleInspect(engine, { view: 'recent' });
      expect(result).toBe('No memories found.');
    });

    it('returns export string as-is', async () => {
      const engine = createMockEngine({
        inspect: vi.fn().mockResolvedValue('{"id":"a","content":"test"}\n'),
      });
      const result = await handleInspect(engine, { view: 'export' });
      expect(result).toBe('{"id":"a","content":"test"}\n');
    });
  });
});
