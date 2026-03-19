/**
 * Tests for per-server policy compilation helpers.
 *
 * These are pure function tests for the merge, validation, caching,
 * and filtering helpers used by the per-server compilation path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CompiledRule, ListDefinition } from '../src/pipeline/types.js';
import {
  computeServerPolicyHash,
  deduplicateListDefinitions,
  getHandwrittenScenariosForServer,
  mergeServerResults,
  validateServerScoping,
} from '../src/pipeline/pipeline-runner.js';

// ---------------------------------------------------------------------------
// validateServerScoping
// ---------------------------------------------------------------------------

describe('validateServerScoping', () => {
  const makeRule = (name: string, server?: string[]): CompiledRule => ({
    name,
    description: 'test',
    principle: 'test',
    if: { server },
    then: 'allow',
    reason: 'test',
  });

  it('passes when all rules are scoped to the expected server', () => {
    const rules = [makeRule('r1', ['filesystem']), makeRule('r2', ['filesystem'])];
    expect(() => validateServerScoping('filesystem', rules)).not.toThrow();
  });

  it('passes with an empty rule set', () => {
    expect(() => validateServerScoping('filesystem', [])).not.toThrow();
  });

  it('throws when a rule is missing the server field', () => {
    const rules = [makeRule('r1', undefined)];
    expect(() => validateServerScoping('filesystem', rules)).toThrow(/missing.*server/i);
  });

  it('throws when a rule is scoped to a different server', () => {
    const rules = [makeRule('r1', ['git'])];
    expect(() => validateServerScoping('filesystem', rules)).toThrow(/missing.*server.*\["filesystem"\]/i);
  });

  it('throws when a rule has multiple servers', () => {
    const rules = [makeRule('r1', ['filesystem', 'git'])];
    expect(() => validateServerScoping('filesystem', rules)).toThrow(/unexpected.*server scope/i);
  });

  it('throws when a rule has an empty server array', () => {
    const rules = [makeRule('r1', [])];
    expect(() => validateServerScoping('filesystem', rules)).toThrow(/missing.*server/i);
  });
});

// ---------------------------------------------------------------------------
// deduplicateListDefinitions
// ---------------------------------------------------------------------------

describe('deduplicateListDefinitions', () => {
  const makeDef = (name: string, prompt: string): ListDefinition => ({
    name,
    type: 'domains',
    principle: 'test',
    generationPrompt: prompt,
    requiresMcp: false,
  });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateListDefinitions([])).toEqual([]);
  });

  it('keeps all unique list definitions', () => {
    const defs = [makeDef('list-a', 'prompt a'), makeDef('list-b', 'prompt b')];
    const result = deduplicateListDefinitions(defs);
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.name)).toEqual(['list-a', 'list-b']);
  });

  it('deduplicates by name, keeping the first definition', () => {
    const defs = [makeDef('list-a', 'first prompt'), makeDef('list-a', 'second prompt')];
    const result = deduplicateListDefinitions(defs);
    expect(result).toHaveLength(1);
    expect(result[0].generationPrompt).toBe('first prompt');
  });

  it('logs a warning when duplicate names have different prompts', () => {
    const defs = [makeDef('list-a', 'first prompt'), makeDef('list-a', 'different prompt')];
    deduplicateListDefinitions(defs);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('divergent generation prompts'));
  });

  it('does not warn when duplicate names have identical prompts', () => {
    const defs = [makeDef('list-a', 'same prompt'), makeDef('list-a', 'same prompt')];
    deduplicateListDefinitions(defs);
    expect(console.error).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// mergeServerResults
// ---------------------------------------------------------------------------

describe('mergeServerResults', () => {
  const makeResult = (serverName: string, ruleCount: number, listDefs: ListDefinition[] = []) => ({
    serverName,
    rules: Array.from({ length: ruleCount }, (_, i) => ({
      name: `${serverName}-rule-${i}`,
      description: 'test',
      principle: 'test',
      if: { server: [serverName] },
      then: 'allow' as const,
      reason: 'test',
    })),
    listDefinitions: listDefs,
    scenarios: [],
    inputHash: `hash-${serverName}`,
    constitutionHash: 'const-hash',
  });

  it('merges rules in alphabetical server order', () => {
    const results = [makeResult('git', 2), makeResult('filesystem', 1)];
    const merged = mergeServerResults(results, 'const-hash');

    // filesystem comes before git alphabetically
    expect(merged.rules[0].name).toBe('filesystem-rule-0');
    expect(merged.rules[1].name).toBe('git-rule-0');
    expect(merged.rules[2].name).toBe('git-rule-1');
  });

  it('produces a deterministic inputHash from server hashes', () => {
    const results = [makeResult('git', 1), makeResult('filesystem', 1)];
    const merged1 = mergeServerResults(results, 'h');
    const merged2 = mergeServerResults([...results].reverse(), 'h');
    // Same servers regardless of input order -> same hash
    expect(merged1.inputHash).toBe(merged2.inputHash);
  });

  it('includes constitutionHash', () => {
    const results = [makeResult('fs', 1)];
    const merged = mergeServerResults(results, 'my-hash');
    expect(merged.constitutionHash).toBe('my-hash');
  });

  it('sets listDefinitions only when non-empty', () => {
    const noLists = mergeServerResults([makeResult('fs', 1)], 'h');
    expect(noLists.listDefinitions).toBeUndefined();

    const withLists = mergeServerResults(
      [
        makeResult('fs', 1, [
          { name: 'list-a', type: 'domains', principle: 'p', generationPrompt: 'gp', requiresMcp: false },
        ]),
      ],
      'h',
    );
    expect(withLists.listDefinitions).toHaveLength(1);
  });

  it('handles empty results array', () => {
    const merged = mergeServerResults([], 'h');
    expect(merged.rules).toEqual([]);
    expect(merged.listDefinitions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeServerPolicyHash
// ---------------------------------------------------------------------------

describe('computeServerPolicyHash', () => {
  const annotations = [
    {
      toolName: 'read_file',
      serverName: 'filesystem',
      comment: 'reads a file',

      args: { path: ['read-path' as const] },
    },
  ];

  it('produces consistent hashes for identical inputs', () => {
    const h1 = computeServerPolicyHash('fs', 'constitution', annotations, 'prompt');
    const h2 = computeServerPolicyHash('fs', 'constitution', annotations, 'prompt');
    expect(h1).toBe(h2);
  });

  it('changes when server name changes', () => {
    const h1 = computeServerPolicyHash('fs', 'c', annotations, 'p');
    const h2 = computeServerPolicyHash('git', 'c', annotations, 'p');
    expect(h1).not.toBe(h2);
  });

  it('changes when constitution changes', () => {
    const h1 = computeServerPolicyHash('fs', 'constitution-v1', annotations, 'p');
    const h2 = computeServerPolicyHash('fs', 'constitution-v2', annotations, 'p');
    expect(h1).not.toBe(h2);
  });

  it('changes when annotations change', () => {
    const h1 = computeServerPolicyHash('fs', 'c', annotations, 'p');
    const h2 = computeServerPolicyHash('fs', 'c', [{ ...annotations[0], comment: 'different' }], 'p');
    expect(h1).not.toBe(h2);
  });

  it('changes when prompt template changes', () => {
    const h1 = computeServerPolicyHash('fs', 'c', annotations, 'prompt-v1');
    const h2 = computeServerPolicyHash('fs', 'c', annotations, 'prompt-v2');
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// getHandwrittenScenariosForServer
// ---------------------------------------------------------------------------

describe('getHandwrittenScenariosForServer', () => {
  const sandbox = '/tmp/sandbox';

  it('returns filesystem scenarios for the filesystem server', () => {
    const scenarios = getHandwrittenScenariosForServer('filesystem', sandbox);
    expect(scenarios.length).toBeGreaterThan(0);
    for (const s of scenarios) {
      expect(s.request.serverName).toBe('filesystem');
    }
  });

  it('returns empty array for servers with no handwritten scenarios', () => {
    const scenarios = getHandwrittenScenariosForServer('git', sandbox);
    expect(scenarios).toEqual([]);
  });

  it('returns empty array for nonexistent server names', () => {
    const scenarios = getHandwrittenScenariosForServer('nonexistent', sandbox);
    expect(scenarios).toEqual([]);
  });

  it('uses the sandbox directory in scenario arguments', () => {
    const scenarios = getHandwrittenScenariosForServer('filesystem', '/my/sandbox');
    const hasPathWithSandbox = scenarios.some((s) => JSON.stringify(s.request.arguments).includes('/my/sandbox'));
    expect(hasPathWithSandbox).toBe(true);
  });
});
