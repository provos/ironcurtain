import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { resolveList, resolveAllLists, type ListResolverConfig } from '../src/pipeline/list-resolver.js';
import type { ListDefinition, ResolvedList } from '../src/pipeline/types.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const MOCK_GENERATE_RESULT = {
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: {
    inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 50, text: undefined, reasoning: undefined },
  },
  warnings: [],
  request: {},
  response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
};

/**
 * Creates a MockLanguageModelV3 that always returns the given values array.
 */
function createMockModel(values: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ values }) }],
      ...MOCK_GENERATE_RESULT,
    }),
  });
}

/**
 * Creates a MockLanguageModelV3 that counts calls and returns the given values.
 */
function createCountingMockModel(values: string[]): { model: MockLanguageModelV3; callCount: () => number } {
  let count = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      count++;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ values }) }],
        ...MOCK_GENERATE_RESULT,
      };
    },
  });
  return { model, callCount: () => count };
}

/**
 * Creates a minimal ListDefinition for testing.
 */
function makeDefinition(overrides: Partial<ListDefinition> = {}): ListDefinition {
  return {
    name: 'test-list',
    type: 'identifiers',
    principle: 'Test principle',
    generationPrompt: 'Generate a list of test items',
    requiresMcp: false,
    ...overrides,
  };
}

function makeConfig(values: string[]): ListResolverConfig {
  return { model: createMockModel(values) };
}

// ---------------------------------------------------------------------------
// resolveList — basic behavior
// ---------------------------------------------------------------------------

describe('resolveList', () => {
  describe('basic resolution', () => {
    it('returns the values produced by the LLM', async () => {
      const def = makeDefinition({ type: 'identifiers' });
      const result = await resolveList(def, makeConfig(['alpha', 'beta', 'gamma']));
      expect(result.values).toContain('alpha');
      expect(result.values).toContain('beta');
      expect(result.values).toContain('gamma');
    });

    it('returns a valid ISO 8601 resolvedAt timestamp', async () => {
      const def = makeDefinition();
      const result = await resolveList(def, makeConfig(['x']));
      expect(Number.isNaN(Date.parse(result.resolvedAt))).toBe(false);
      expect(new Date(result.resolvedAt).toISOString()).toBe(result.resolvedAt);
    });

    it('returns a non-empty inputHash', async () => {
      const def = makeDefinition();
      const result = await resolveList(def, makeConfig(['x']));
      expect(result.inputHash).toBeTruthy();
      expect(typeof result.inputHash).toBe('string');
    });

    it('starts with empty manualAdditions and manualRemovals when none in existing', async () => {
      const def = makeDefinition();
      const result = await resolveList(def, makeConfig(['x']));
      expect(result.manualAdditions).toEqual([]);
      expect(result.manualRemovals).toEqual([]);
    });

    it('deduplicates identical values', async () => {
      const def = makeDefinition({ type: 'identifiers' });
      const result = await resolveList(def, makeConfig(['dup', 'dup', 'unique']));
      expect(result.values.filter((v) => v === 'dup')).toHaveLength(1);
    });

    it('calls onProgress with list name', async () => {
      const def = makeDefinition({ name: 'my-list' });
      const progress: string[] = [];
      await resolveList(def, makeConfig(['x']), undefined, (msg) => progress.push(msg));
      expect(progress.some((m) => m.includes('my-list'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // domain type — auto-expansion of apex domains
  // ---------------------------------------------------------------------------

  describe('domain type — automatic wildcard expansion', () => {
    it('auto-adds *.domain wildcard for bare apex domain', async () => {
      const def = makeDefinition({ type: 'domains' });
      const result = await resolveList(def, makeConfig(['example.com']));
      expect(result.values).toContain('example.com');
      expect(result.values).toContain('*.example.com');
    });

    it('does not double-add wildcard when already present', async () => {
      const def = makeDefinition({ type: 'domains' });
      const result = await resolveList(def, makeConfig(['*.example.com']));
      const wildcardCount = result.values.filter((v) => v === '*.example.com').length;
      expect(wildcardCount).toBe(1);
      // The bare apex should NOT be added for already-wildcard entries
      expect(result.values).toContain('*.example.com');
    });

    it('expands multiple apex domains independently', async () => {
      const def = makeDefinition({ type: 'domains' });
      const result = await resolveList(def, makeConfig(['foo.com', 'bar.org']));
      expect(result.values).toContain('foo.com');
      expect(result.values).toContain('*.foo.com');
      expect(result.values).toContain('bar.org');
      expect(result.values).toContain('*.bar.org');
    });
  });

  // ---------------------------------------------------------------------------
  // validation — type-specific filters
  // ---------------------------------------------------------------------------

  describe('validation — invalid values are dropped', () => {
    it('drops invalid domain values (with whitespace)', async () => {
      const def = makeDefinition({ type: 'domains' });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await resolveList(def, makeConfig(['valid.com', 'not valid.com', '']));
        expect(result.values).toContain('valid.com');
        expect(result.values).not.toContain('not valid.com');
        expect(result.values).not.toContain('');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('drops domain values with protocol prefix', async () => {
      const def = makeDefinition({ type: 'domains' });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await resolveList(def, makeConfig(['https://example.com', 'example.com']));
        expect(result.values).not.toContain('https://example.com');
        expect(result.values).toContain('example.com');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('accepts valid wildcard domain', async () => {
      const def = makeDefinition({ type: 'domains' });
      const result = await resolveList(def, makeConfig(['*.github.com']));
      expect(result.values).toContain('*.github.com');
    });

    it('drops invalid email values (no @)', async () => {
      const def = makeDefinition({ type: 'emails' });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await resolveList(def, makeConfig(['valid@example.com', 'notanemail', '']));
        expect(result.values).toContain('valid@example.com');
        expect(result.values).not.toContain('notanemail');
        expect(result.values).not.toContain('');
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('drops identifier values that contain whitespace', async () => {
      const def = makeDefinition({ type: 'identifiers' });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await resolveList(def, makeConfig(['valid-id', 'has space', '']));
        expect(result.values).toContain('valid-id');
        expect(result.values).not.toContain('has space');
        expect(result.values).not.toContain('');
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // manual overrides from existing ResolvedList
  // ---------------------------------------------------------------------------

  describe('manual overrides', () => {
    it('preserves manualAdditions from existing resolution', async () => {
      const def = makeDefinition({ type: 'identifiers' });
      const existing: ResolvedList = {
        values: [],
        manualAdditions: ['always-include'],
        manualRemovals: [],
        resolvedAt: new Date().toISOString(),
        inputHash: 'old-hash',
      };
      const result = await resolveList(def, makeConfig(['llm-value']), existing);
      expect(result.values).toContain('always-include');
      expect(result.values).toContain('llm-value');
      expect(result.manualAdditions).toEqual(['always-include']);
    });

    it('applies manualRemovals to exclude values from LLM output', async () => {
      const def = makeDefinition({ type: 'identifiers' });
      const existing: ResolvedList = {
        values: [],
        manualAdditions: [],
        manualRemovals: ['remove-me'],
        resolvedAt: new Date().toISOString(),
        inputHash: 'old-hash',
      };
      const result = await resolveList(def, makeConfig(['keep-me', 'remove-me']), existing);
      expect(result.values).toContain('keep-me');
      expect(result.values).not.toContain('remove-me');
      expect(result.manualRemovals).toEqual(['remove-me']);
    });

    it('manual removals also block values from manualAdditions', async () => {
      const def = makeDefinition({ type: 'identifiers' });
      const existing: ResolvedList = {
        values: [],
        manualAdditions: ['conflict'],
        manualRemovals: ['conflict'],
        resolvedAt: new Date().toISOString(),
        inputHash: 'old-hash',
      };
      const result = await resolveList(def, makeConfig([]), existing);
      expect(result.values).not.toContain('conflict');
    });
  });

  // ---------------------------------------------------------------------------
  // MCP-required error cases
  // ---------------------------------------------------------------------------

  describe('MCP-required list without connections', () => {
    it('throws when requiresMcp is true and no policyEngine provided', async () => {
      const def = makeDefinition({ requiresMcp: true, name: 'github-repos' });
      const config: ListResolverConfig = { model: createMockModel([]) };
      await expect(resolveList(def, config)).rejects.toThrow(/no read-only PolicyEngine/);
      await expect(resolveList(def, config)).rejects.toThrow(/github-repos/);
    });

    it('throws when mcpConnections map is empty', async () => {
      const def = makeDefinition({ requiresMcp: true });
      const config: ListResolverConfig = {
        model: createMockModel([]),
        mcpConnections: new Map(),
      };
      // Without policyEngine, the policyEngine check fires first
      await expect(resolveList(def, config)).rejects.toThrow(/no read-only PolicyEngine/);
    });
  });

  // ---------------------------------------------------------------------------
  // inputHash consistency
  // ---------------------------------------------------------------------------

  describe('inputHash consistency', () => {
    it('produces the same hash for the same definition', async () => {
      const def = makeDefinition();
      const result1 = await resolveList(def, makeConfig(['a']));
      const result2 = await resolveList(def, makeConfig(['b']));
      expect(result1.inputHash).toBe(result2.inputHash);
    });

    it('produces a different hash when generationPrompt changes', async () => {
      const def1 = makeDefinition({ generationPrompt: 'Prompt A' });
      const def2 = makeDefinition({ generationPrompt: 'Prompt B' });
      const result1 = await resolveList(def1, makeConfig(['x']));
      const result2 = await resolveList(def2, makeConfig(['x']));
      expect(result1.inputHash).not.toBe(result2.inputHash);
    });

    it('produces a different hash when type changes', async () => {
      const def1 = makeDefinition({ type: 'domains' });
      const def2 = makeDefinition({ type: 'emails' });
      const result1 = await resolveList(def1, makeConfig(['a@b.com']));
      const result2 = await resolveList(def2, makeConfig(['a@b.com']));
      expect(result1.inputHash).not.toBe(result2.inputHash);
    });
  });
});

// ---------------------------------------------------------------------------
// resolveAllLists — caching and batch behavior
// ---------------------------------------------------------------------------

describe('resolveAllLists', () => {
  describe('empty input', () => {
    it('returns a DynamicListsFile with empty lists for empty definitions', async () => {
      const config = makeConfig([]);
      const result = await resolveAllLists([], config);
      expect(result.lists).toEqual({});
      expect(result.generatedAt).toBeTruthy();
    });
  });

  describe('cache behavior', () => {
    it('calls the LLM once when there is no existing resolved list', async () => {
      const { model, callCount } = createCountingMockModel(['item1']);
      const def = makeDefinition({ name: 'my-list' });
      const config: ListResolverConfig = { model };

      await resolveAllLists([def], config);
      expect(callCount()).toBe(1);
    });

    it('skips LLM call when inputHash matches (cache hit)', async () => {
      // First pass: resolve and get the hash
      const { model: model1, callCount: callCount1 } = createCountingMockModel(['cached-value']);
      const def = makeDefinition({ name: 'cached-list', type: 'identifiers' });
      const config1: ListResolverConfig = { model: model1 };

      const first = await resolveAllLists([def], config1);
      expect(callCount1()).toBe(1);

      // Second pass: same definition + existing result (hash matches) → no LLM call
      const { model: model2, callCount: callCount2 } = createCountingMockModel(['new-value']);
      const config2: ListResolverConfig = { model: model2 };

      const second = await resolveAllLists([def], config2, first);
      expect(callCount2()).toBe(0);
      // The cached values are preserved
      expect(second.lists['cached-list'].values).toContain('cached-value');
    });

    it('re-resolves when the definition changes (cache miss)', async () => {
      // First pass: compute hash for def1
      const { model: model1, callCount: callCount1 } = createCountingMockModel(['old-value']);
      const def1 = makeDefinition({ name: 'evolving-list', generationPrompt: 'First prompt' });
      const config1: ListResolverConfig = { model: model1 };

      const first = await resolveAllLists([def1], config1);
      expect(callCount1()).toBe(1);

      // Second pass: different generationPrompt → different hash → re-resolves
      const { model: model2, callCount: callCount2 } = createCountingMockModel(['new-value']);
      const def2 = makeDefinition({ name: 'evolving-list', generationPrompt: 'Changed prompt' });
      const config2: ListResolverConfig = { model: model2 };

      const second = await resolveAllLists([def2], config2, first);
      expect(callCount2()).toBe(1);
      expect(second.lists['evolving-list'].values).toContain('new-value');
    });

    it('bypasses cache when bypassCache is true', async () => {
      // First pass: populate cache
      const { model: model1 } = createCountingMockModel(['original']);
      const def = makeDefinition({ name: 'force-refresh' });
      const config1: ListResolverConfig = { model: model1 };
      const first = await resolveAllLists([def], config1);

      // Second pass: same hash, but bypassCache forces re-resolution
      const { model: model2, callCount: callCount2 } = createCountingMockModel(['fresh-value']);
      const config2: ListResolverConfig = { model: model2 };

      const second = await resolveAllLists([def], config2, first, undefined, true);
      expect(callCount2()).toBe(1);
      expect(second.lists['force-refresh'].values).toContain('fresh-value');
    });

    it('reports progress for cached lists', async () => {
      // Set up a cached list (matching hash)
      const { model: model1 } = createCountingMockModel(['cached']);
      const def = makeDefinition({ name: 'progress-list' });
      const first = await resolveAllLists([def], { model: model1 });

      // On second pass, onProgress should fire with "(cached)" message
      const { model: model2 } = createCountingMockModel(['new']);
      const progressMessages: string[] = [];
      await resolveAllLists([def], { model: model2 }, first, (msg) => progressMessages.push(msg));

      expect(progressMessages.some((m) => m.includes('cached'))).toBe(true);
    });

    it('resolves multiple lists, caching only those with matching hashes', async () => {
      const defA = makeDefinition({ name: 'list-a', generationPrompt: 'Prompt A' });
      const defB = makeDefinition({ name: 'list-b', generationPrompt: 'Prompt B' });

      // First pass: resolve both
      const { model: model1, callCount: callCount1 } = createCountingMockModel(['x']);
      const first = await resolveAllLists([defA, defB], { model: model1 });
      expect(callCount1()).toBe(2);

      // Second pass: only defB changed → only one LLM call
      const defBChanged = makeDefinition({ name: 'list-b', generationPrompt: 'NEW Prompt B' });
      const { model: model2, callCount: callCount2 } = createCountingMockModel(['y']);
      await resolveAllLists([defA, defBChanged], { model: model2 }, first);
      expect(callCount2()).toBe(1);
    });
  });

  describe('output structure', () => {
    it('includes all resolved list names as keys', async () => {
      const defA = makeDefinition({ name: 'alpha' });
      const defB = makeDefinition({ name: 'beta' });
      const result = await resolveAllLists([defA, defB], makeConfig(['v']));
      expect(Object.keys(result.lists)).toContain('alpha');
      expect(Object.keys(result.lists)).toContain('beta');
    });

    it('each resolved entry has required fields', async () => {
      const def = makeDefinition({ name: 'check' });
      const result = await resolveAllLists([def], makeConfig(['item']));
      const entry = result.lists['check'];
      expect(Array.isArray(entry.values)).toBe(true);
      expect(Array.isArray(entry.manualAdditions)).toBe(true);
      expect(Array.isArray(entry.manualRemovals)).toBe(true);
      expect(typeof entry.resolvedAt).toBe('string');
      expect(typeof entry.inputHash).toBe('string');
    });
  });
});
