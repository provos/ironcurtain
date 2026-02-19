import { describe, it, expect, vi } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Mock realpathSync so tests don't depend on real filesystem symlinks.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, realpathSync: (p: string) => p };
});
import { expandTilde, normalizeToolArgPaths, prepareToolArgs } from '../src/trusted-process/path-utils.js';
import type { ToolAnnotation } from '../src/pipeline/types.js';

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

describe('prepareToolArgs', () => {
  const home = homedir();

  const annotation: ToolAnnotation = {
    toolName: 'edit_file',
    serverName: 'filesystem',
    comment: 'Edits a file',
    sideEffects: true,
    args: {
      path: ['read-path', 'write-path'],
      content: ['none'],
    },
  };

  it('normalizes path arguments based on annotation', () => {
    const { argsForTransport, argsForPolicy } = prepareToolArgs(
      { path: '~/test/file.txt', content: 'hello' },
      annotation,
    );
    expect(argsForTransport.path).toBe(`${home}/test/file.txt`);
    expect(argsForPolicy.path).toBe(`${home}/test/file.txt`);
  });

  it('does NOT normalize none-role arguments even if they look like paths', () => {
    const { argsForTransport, argsForPolicy } = prepareToolArgs(
      { path: '/tmp/file.txt', content: '/etc/passwd' },
      annotation,
    );
    // 'content' has role 'none' -- should pass through unchanged
    expect(argsForTransport.content).toBe('/etc/passwd');
    expect(argsForPolicy.content).toBe('/etc/passwd');
    // 'path' has resource role -- should be normalized
    expect(argsForTransport.path).toBe('/tmp/file.txt');
    expect(argsForPolicy.path).toBe('/tmp/file.txt');
  });

  it('falls back to heuristic when annotation is undefined', () => {
    const { argsForTransport, argsForPolicy } = prepareToolArgs(
      { path: '~/test/file.txt', content: '/etc/passwd' },
      undefined,
    );
    // Heuristic normalizes both since both look like paths
    expect(argsForTransport.path).toBe(`${home}/test/file.txt`);
    expect(argsForTransport.content).toBe('/etc/passwd');
    expect(argsForPolicy.path).toBe(`${home}/test/file.txt`);
    expect(argsForPolicy.content).toBe('/etc/passwd');
  });

  it('returns identical argsForTransport and argsForPolicy when no prepareForPolicy defined', () => {
    const { argsForTransport, argsForPolicy } = prepareToolArgs(
      { path: '~/test/file.txt', content: 'hello' },
      annotation,
    );
    expect(argsForTransport).toEqual(argsForPolicy);
  });

  it('does not mutate the input object', () => {
    const input = { path: '~/test/file.txt', content: 'hello' };
    const inputCopy = { ...input };
    prepareToolArgs(input, annotation);
    expect(input).toEqual(inputCopy);
  });

  it('handles arguments not present in annotation', () => {
    const { argsForTransport, argsForPolicy } = prepareToolArgs(
      { path: '/tmp/file.txt', unknownArg: '/etc/shadow' },
      annotation,
    );
    // Unknown args pass through unchanged
    expect(argsForTransport.unknownArg).toBe('/etc/shadow');
    expect(argsForPolicy.unknownArg).toBe('/etc/shadow');
  });

  it('normalizes tilde paths using resource role normalizer', () => {
    const { argsForTransport } = prepareToolArgs(
      { path: '~/Documents/notes.md', content: 'text' },
      annotation,
    );
    expect(argsForTransport.path).toBe(`${home}/Documents/notes.md`);
  });

  it('resolves relative paths using resource role normalizer', () => {
    const { argsForTransport } = prepareToolArgs(
      { path: './relative/file.txt', content: 'text' },
      annotation,
    );
    expect(argsForTransport.path).toBe(resolve('./relative/file.txt'));
  });

  it('handles string arrays in annotated args', () => {
    const arrayAnnotation: ToolAnnotation = {
      toolName: 'multi_read',
      serverName: 'filesystem',
      comment: 'Reads multiple files',
      sideEffects: false,
      args: { paths: ['read-path'] },
    };
    const { argsForTransport } = prepareToolArgs(
      { paths: ['~/a', '/tmp/b'] },
      arrayAnnotation,
    );
    expect(argsForTransport.paths).toEqual([`${home}/a`, '/tmp/b']);
  });

  it('handles empty args', () => {
    const { argsForTransport, argsForPolicy } = prepareToolArgs({}, annotation);
    expect(argsForTransport).toEqual({});
    expect(argsForPolicy).toEqual({});
  });
});
