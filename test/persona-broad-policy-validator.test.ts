/**
 * Unit tests for the broad-policy validator + ruleDelta (Phase 1c).
 *
 * The validator is LLM-independent: it inspects the COMPILED policy and rejects
 * '*' domains/lists or out-of-workspace paths.within UNLESS the persona is
 * opted in. ruleDelta diffs old vs new compiled policy by rule name.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  makeBroadPolicyValidator,
  findBroadPolicy,
  isBroadDomainPattern,
  BroadPolicyRejectedError,
} from '../src/persona/broad-policy-validator.js';
import { computeRuleDelta } from '../src/persona/rule-delta.js';
import type { CompiledPolicyFile, CompiledRule, DynamicListsFile } from '../src/pipeline/types.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-broad-test-${process.pid}`);
const WORKSPACE = resolve(TEST_HOME, 'workspace');

function rule(partial: Partial<CompiledRule> & { name: string }): CompiledRule {
  return {
    description: 'd',
    principle: 'pr',
    if: {},
    then: 'allow',
    reason: 'r',
    ...partial,
  };
}

function policy(rules: CompiledRule[]): CompiledPolicyFile {
  return { generatedAt: '', constitutionHash: 'h', inputHash: 'i', rules };
}

/** Builds a DynamicListsFile from a map of list-name => resolved values. */
function dynamicLists(
  lists: Record<string, { values?: string[]; manualAdditions?: string[]; manualRemovals?: string[] }>,
): DynamicListsFile {
  const out: DynamicListsFile['lists'] = {};
  for (const [name, l] of Object.entries(lists)) {
    out[name] = {
      values: l.values ?? [],
      manualAdditions: l.manualAdditions ?? [],
      manualRemovals: l.manualRemovals ?? [],
      resolvedAt: '',
      inputHash: 'i',
    };
  }
  return { generatedAt: '', lists: out };
}

beforeEach(() => {
  mkdirSync(WORKSPACE, { recursive: true });
});
afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('isBroadDomainPattern', () => {
  it('flags the bare wildcard and TLD-level / empty-suffix wildcards as broad', () => {
    for (const p of ['*', '*.', '*.com', '*.gov', '*.io']) {
      expect(isBroadDomainPattern(p)).toBe(true);
    }
  });

  it('treats per-registered-domain wildcards and bare hostnames as narrow', () => {
    for (const p of ['*.github.com', '*.example.co.uk', 'github.com', 'example.com']) {
      expect(isBroadDomainPattern(p)).toBe(false);
    }
  });
});

describe('findBroadPolicy', () => {
  it('flags wildcard domains', () => {
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['*'] } } })]);
    const f = findBroadPolicy(p, WORKSPACE);
    expect(f.broadenedDomains).toEqual(['*']);
    expect(f.outOfWorkspacePaths).toEqual([]);
  });

  it('flags TLD-level prefix wildcards and records the actual pattern', () => {
    const p = policy([
      rule({ name: 'r1', if: { domains: { roles: [], allowed: ['*.com'] } } }),
      rule({ name: 'r2', if: { domains: { roles: [], allowed: ['*.'] } } }),
      rule({ name: 'r3', if: { domains: { roles: [], allowed: ['*.gov'] } } }),
    ]);
    const f = findBroadPolicy(p, WORKSPACE);
    expect(new Set(f.broadenedDomains)).toEqual(new Set(['*.com', '*.', '*.gov']));
  });

  it('does NOT flag a per-registered-domain wildcard (*.github.com)', () => {
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['*.github.com'] } } })]);
    expect(findBroadPolicy(p, WORKSPACE).broadenedDomains).toEqual([]);
  });

  it('flags wildcard list allowances', () => {
    const p = policy([rule({ name: 'r1', if: { lists: [{ roles: [], allowed: ['*'], matchType: 'domains' }] } })]);
    expect(findBroadPolicy(p, WORKSPACE).broadenedDomains).toEqual(['*']);
  });

  it('flags out-of-workspace paths.within', () => {
    const p = policy([rule({ name: 'r1', if: { paths: { roles: [], within: '/etc' } } })]);
    const f = findBroadPolicy(p, WORKSPACE);
    expect(f.outOfWorkspacePaths).toEqual(['/etc']);
  });

  it('accepts paths within the workspace', () => {
    const inside = resolve(WORKSPACE, 'sub');
    mkdirSync(inside, { recursive: true });
    const p = policy([rule({ name: 'r1', if: { paths: { roles: [], within: inside } } })]);
    expect(findBroadPolicy(p, WORKSPACE).outOfWorkspacePaths).toEqual([]);
  });

  it('accepts the workspace dir itself', () => {
    const p = policy([rule({ name: 'r1', if: { paths: { roles: [], within: WORKSPACE } } })]);
    expect(findBroadPolicy(p, WORKSPACE).outOfWorkspacePaths).toEqual([]);
  });

  it('resolves a @list domain reference to a broad wildcard and flags it (with via annotation)', () => {
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@news'] } } })]);
    const lists = dynamicLists({ news: { values: ['nytimes.com', '*.com'] } });
    const f = findBroadPolicy(p, WORKSPACE, lists);
    expect(f.broadenedDomains).toEqual(['*.com (via @news)']);
  });

  it('resolves a @list hidden in a list allowance and flags broad members', () => {
    const p = policy([rule({ name: 'r1', if: { lists: [{ roles: [], allowed: ['@sites'], matchType: 'domains' }] } })]);
    const lists = dynamicLists({ sites: { values: ['example.com'], manualAdditions: ['*.gov'] } });
    expect(findBroadPolicy(p, WORKSPACE, lists).broadenedDomains).toEqual(['*.gov (via @sites)']);
  });

  it('does not flag a @list resolving only to narrow values', () => {
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@news'] } } })]);
    const lists = dynamicLists({ news: { values: ['nytimes.com', '*.github.com'] } });
    expect(findBroadPolicy(p, WORKSPACE, lists).broadenedDomains).toEqual([]);
  });

  it('respects manualRemovals when resolving a @list (removed broad value is not flagged)', () => {
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@news'] } } })]);
    const lists = dynamicLists({ news: { values: ['nytimes.com', '*.com'], manualRemovals: ['*.com'] } });
    expect(findBroadPolicy(p, WORKSPACE, lists).broadenedDomains).toEqual([]);
  });

  it('ignores a @list reference with no resolved entry (missing list fails closed -> nothing to flag)', () => {
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@gone'] } } })]);
    expect(findBroadPolicy(p, WORKSPACE, dynamicLists({})).broadenedDomains).toEqual([]);
  });

  it('does not resolve @list references when no dynamicLists are supplied', () => {
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@news'] } } })]);
    // The literal '@news' symbol is not itself a broad pattern, so without
    // resolution there is nothing to flag.
    expect(findBroadPolicy(p, WORKSPACE).broadenedDomains).toEqual([]);
  });
});

describe('makeBroadPolicyValidator', () => {
  it('rejects a wildcard-domain policy when not opted in', () => {
    const validate = makeBroadPolicyValidator(WORKSPACE, false);
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['*'] } } })]);
    expect(() => validate(p)).toThrowError(BroadPolicyRejectedError);
    try {
      validate(p);
    } catch (err) {
      expect((err as BroadPolicyRejectedError).code).toBe('BROAD_POLICY_REJECTED');
    }
  });

  it('rejects an out-of-workspace path when not opted in', () => {
    const validate = makeBroadPolicyValidator(WORKSPACE, false);
    const p = policy([rule({ name: 'r1', if: { paths: { roles: [], within: '/' } } })]);
    expect(() => validate(p)).toThrowError(BroadPolicyRejectedError);
  });

  it('rejects a TLD-level prefix-wildcard domain when not opted in', () => {
    const validate = makeBroadPolicyValidator(WORKSPACE, false);
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['*.com'] } } })]);
    expect(() => validate(p)).toThrowError(BroadPolicyRejectedError);
  });

  it('rejects a TLD-level prefix wildcard hidden in a list allowance when not opted in', () => {
    const validate = makeBroadPolicyValidator(WORKSPACE, false);
    const p = policy([rule({ name: 'r1', if: { lists: [{ roles: [], allowed: ['*.gov'], matchType: 'domains' }] } })]);
    expect(() => validate(p)).toThrowError(BroadPolicyRejectedError);
  });

  it('passes a narrow policy (bare host + per-registered-domain wildcard) when not opted in', () => {
    const validate = makeBroadPolicyValidator(WORKSPACE, false);
    const p = policy([
      rule({ name: 'r1', if: { domains: { roles: [], allowed: ['example.com'] } } }),
      rule({ name: 'r2', if: { domains: { roles: [], allowed: ['*.github.com'] } } }),
    ]);
    expect(() => validate(p)).not.toThrow();
  });

  it('passes a broad policy when opted in', () => {
    const validate = makeBroadPolicyValidator(WORKSPACE, true);
    const p = policy([
      rule({ name: 'r1', if: { domains: { roles: [], allowed: ['*'] } } }),
      rule({ name: 'r2', if: { paths: { roles: [], within: '/etc' } } }),
    ]);
    expect(() => validate(p)).not.toThrow();
  });

  it('rejects a @list that RESOLVES to a broad wildcard when not opted in', () => {
    const validate = makeBroadPolicyValidator(WORKSPACE, false);
    // The rule only stores the '@news' symbol; the broad value lives in the
    // resolved dynamic-lists. Without the resolved lists this would slip through.
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@news'] } } })]);
    const lists = dynamicLists({ news: { values: ['nytimes.com', '*.com'] } });
    expect(() => validate(p, lists)).toThrowError(BroadPolicyRejectedError);
    try {
      validate(p, lists);
    } catch (err) {
      expect((err as BroadPolicyRejectedError).data?.broadenedDomains).toEqual(['*.com (via @news)']);
    }
  });

  it('accepts a @list that resolves only to narrow values when not opted in', () => {
    const validate = makeBroadPolicyValidator(WORKSPACE, false);
    const p = policy([rule({ name: 'r1', if: { domains: { roles: [], allowed: ['@news'] } } })]);
    const lists = dynamicLists({ news: { values: ['nytimes.com', '*.github.com'] } });
    expect(() => validate(p, lists)).not.toThrow();
  });
});

describe('computeRuleDelta', () => {
  it('counts added / removed / loosened rules', () => {
    const oldP = policy([rule({ name: 'keep', then: 'escalate' }), rule({ name: 'gone', then: 'allow' })]);
    const newP = policy([
      rule({ name: 'keep', then: 'allow' }), // loosened: escalate -> allow
      rule({ name: 'fresh', then: 'allow' }), // added
    ]);
    const delta = computeRuleDelta(oldP, newP, WORKSPACE);
    expect(delta.added).toBe(1);
    expect(delta.removed).toBe(1);
    expect(delta.loosened).toBe(1);
  });

  it('reports broadenedDomains / outOfWorkspacePaths from the new policy', () => {
    const newP = policy([
      rule({ name: 'r1', if: { domains: { roles: [], allowed: ['*'] } } }),
      rule({ name: 'r2', if: { paths: { roles: [], within: '/srv' } } }),
    ]);
    const delta = computeRuleDelta(policy([]), newP, WORKSPACE);
    expect(delta.broadenedDomains).toEqual(['*']);
    expect(delta.outOfWorkspacePaths).toEqual(['/srv']);
  });

  it('treats every rule as added when there is no previous policy', () => {
    const newP = policy([rule({ name: 'a' }), rule({ name: 'b' })]);
    const delta = computeRuleDelta(undefined, newP, WORKSPACE);
    expect(delta.added).toBe(2);
    expect(delta.removed).toBe(0);
  });
});
