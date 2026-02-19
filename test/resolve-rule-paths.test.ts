import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompiledRule } from '../src/pipeline/types.js';

// Mock node:fs so we control realpathSync behavior without touching disk
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: vi.fn(),
  };
});

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveRulePaths } from '../src/pipeline/compile.js';

const mockedRealpathSync = vi.mocked(realpathSync);

function makeRule(within?: string, overrides: Partial<CompiledRule> = {}): CompiledRule {
  return {
    name: 'test-rule',
    description: 'A test rule',
    principle: 'testing',
    if: within ? { paths: { roles: ['read-path'], within } } : {},
    then: 'allow',
    reason: 'test',
    ...overrides,
  };
}

describe('resolveRulePaths', () => {
  beforeEach(() => {
    mockedRealpathSync.mockReset();
  });

  it('returns rules unchanged when they have no paths.within', () => {
    const rules = [makeRule()];
    const result = resolveRulePaths(rules);
    expect(result).toEqual(rules);
    expect(mockedRealpathSync).not.toHaveBeenCalled();
  });

  it('resolves a symlinked path via realpathSync', () => {
    mockedRealpathSync.mockReturnValue('/mnt/c/Users/me/Downloads');

    const rules = [makeRule('/home/user/Downloads')];
    const result = resolveRulePaths(rules);

    expect(mockedRealpathSync).toHaveBeenCalledWith('/home/user/Downloads');
    expect(result[0].if.paths!.within).toBe('/mnt/c/Users/me/Downloads');
  });

  it('falls back to path.resolve when realpathSync throws (path does not exist)', () => {
    mockedRealpathSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const rules = [makeRule('/nonexistent/dir')];
    const result = resolveRulePaths(rules);

    expect(result[0].if.paths!.within).toBe(resolve('/nonexistent/dir'));
  });

  it('returns the original rule object when resolved path is unchanged', () => {
    const originalPath = '/already/canonical';
    mockedRealpathSync.mockReturnValue(originalPath);

    const rules = [makeRule(originalPath)];
    const result = resolveRulePaths(rules);

    // Same object reference -- no unnecessary copy
    expect(result[0]).toBe(rules[0]);
  });

  it('preserves other rule fields when replacing paths.within', () => {
    mockedRealpathSync.mockReturnValue('/resolved/path');

    const rule = makeRule('/original/path', {
      name: 'my-rule',
      then: 'deny',
      reason: 'custom reason',
    });
    rule.if.tool = ['write_file'];
    rule.if.roles = ['write-path'];

    const result = resolveRulePaths([rule]);
    expect(result[0]).toEqual({
      name: 'my-rule',
      description: 'A test rule',
      principle: 'testing',
      if: {
        tool: ['write_file'],
        roles: ['write-path'],
        paths: { roles: ['read-path'], within: '/resolved/path' },
      },
      then: 'deny',
      reason: 'custom reason',
    });
  });

  it('handles a mix of rules with and without paths', () => {
    mockedRealpathSync.mockReturnValue('/resolved');

    const rules = [
      makeRule(undefined, { name: 'no-path' }),
      makeRule('/symlink', { name: 'has-path' }),
      makeRule(undefined, { name: 'also-no-path' }),
    ];
    const result = resolveRulePaths(rules);

    // Rules without paths are returned as-is (same reference)
    expect(result[0]).toBe(rules[0]);
    expect(result[2]).toBe(rules[2]);
    // Rule with path gets resolved
    expect(result[1].if.paths!.within).toBe('/resolved');
  });

  it('returns empty array for empty input', () => {
    expect(resolveRulePaths([])).toEqual([]);
  });
});
