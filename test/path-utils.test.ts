import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { expandTilde, normalizeToolArgPaths } from '../src/trusted-process/path-utils.js';

describe('expandTilde', () => {
  const home = homedir();

  it('expands ~/path to homedir/path', () => {
    expect(expandTilde('~/Downloads')).toBe(`${home}/Downloads`);
  });

  it('expands bare ~ to homedir', () => {
    expect(expandTilde('~')).toBe(home);
  });

  it('expands ~/deeply/nested/path', () => {
    expect(expandTilde('~/a/b/c')).toBe(`${home}/a/b/c`);
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandTilde('/absolute/path')).toBe('/absolute/path');
  });

  it('leaves relative paths unchanged', () => {
    expect(expandTilde('./relative')).toBe('./relative');
  });

  it('leaves bare strings unchanged', () => {
    expect(expandTilde('no-tilde')).toBe('no-tilde');
  });

  it('does not expand tilde in the middle of a path', () => {
    expect(expandTilde('/some/~user/path')).toBe('/some/~user/path');
  });
});

describe('normalizeToolArgPaths', () => {
  const home = homedir();

  it('normalizes tilde paths in string values', () => {
    const result = normalizeToolArgPaths({ path: '~/Downloads' });
    expect(result.path).toBe(`${home}/Downloads`);
  });

  it('resolves parent traversals', () => {
    const result = normalizeToolArgPaths({ path: '/tmp/foo/../bar' });
    expect(result.path).toBe('/tmp/bar');
  });

  it('resolves relative paths to absolute', () => {
    const result = normalizeToolArgPaths({ path: './relative/file.txt' });
    expect(result.path).toBe(resolve('./relative/file.txt'));
  });

  it('normalizes absolute paths (no-op for clean absolute paths)', () => {
    const result = normalizeToolArgPaths({ path: '/tmp/clean/path' });
    expect(result.path).toBe('/tmp/clean/path');
  });

  it('normalizes path-like strings in arrays', () => {
    const result = normalizeToolArgPaths({ paths: ['~/a', '/tmp/b'] });
    expect(result.paths).toEqual([`${home}/a`, '/tmp/b']);
  });

  it('preserves non-path string values', () => {
    const result = normalizeToolArgPaths({ content: 'hello world', name: 'test' });
    expect(result.content).toBe('hello world');
    expect(result.name).toBe('test');
  });

  it('preserves numeric values', () => {
    const result = normalizeToolArgPaths({ count: 42 });
    expect(result.count).toBe(42);
  });

  it('preserves boolean values', () => {
    const result = normalizeToolArgPaths({ dryRun: false });
    expect(result.dryRun).toBe(false);
  });

  it('does not normalize strings that do not look like paths', () => {
    const result = normalizeToolArgPaths({ path: 'not-a-path' });
    expect(result.path).toBe('not-a-path');
  });

  it('handles mixed arrays (normalizes path-like, preserves others)', () => {
    const result = normalizeToolArgPaths({ items: ['~/a', 'plain', 42, '/tmp/b'] });
    expect(result.items).toEqual([`${home}/a`, 'plain', 42, '/tmp/b']);
  });

  it('does not mutate the input object', () => {
    const input = { path: '~/Downloads', content: 'hello' };
    const inputCopy = { ...input };
    normalizeToolArgPaths(input);
    expect(input).toEqual(inputCopy);
  });

  it('handles empty arguments', () => {
    const result = normalizeToolArgPaths({});
    expect(result).toEqual({});
  });

  it('handles null and undefined values', () => {
    const result = normalizeToolArgPaths({ a: null, b: undefined });
    expect(result.a).toBeNull();
    expect(result.b).toBeUndefined();
  });
});
