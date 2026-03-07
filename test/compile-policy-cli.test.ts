/**
 * Tests for compile-policy CLI argument parsing.
 */

import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseCompilePolicyArgs } from '../src/pipeline/compile.js';

describe('parseCompilePolicyArgs', () => {
  it('returns empty object when no args provided', () => {
    const result = parseCompilePolicyArgs([]);
    expect(result).toEqual({});
  });

  it('parses --constitution flag', () => {
    const result = parseCompilePolicyArgs(['--constitution', 'my-constitution.md']);
    expect(result.constitution).toBe(resolve('my-constitution.md'));
  });

  it('parses --output-dir flag', () => {
    const result = parseCompilePolicyArgs(['--output-dir', '/tmp/output']);
    expect(result.outputDir).toBe('/tmp/output');
  });

  it('parses both flags together', () => {
    const result = parseCompilePolicyArgs([
      '--constitution',
      '/path/to/constitution.md',
      '--output-dir',
      '/tmp/output',
    ]);
    expect(result.constitution).toBe('/path/to/constitution.md');
    expect(result.outputDir).toBe('/tmp/output');
  });

  it('ignores flags without values', () => {
    const result = parseCompilePolicyArgs(['--constitution']);
    expect(result.constitution).toBeUndefined();
  });

  it('ignores unknown flags', () => {
    const result = parseCompilePolicyArgs(['--unknown', 'value']);
    expect(result).toEqual({});
  });

  it('resolves relative constitution paths to absolute', () => {
    const result = parseCompilePolicyArgs(['--constitution', './relative/path.md']);
    expect(result.constitution).toBe(resolve('./relative/path.md'));
    expect(result.constitution).toMatch(/^\//);
  });

  it('resolves relative output-dir paths to absolute', () => {
    const result = parseCompilePolicyArgs(['--output-dir', './relative/dir']);
    expect(result.outputDir).toBe(resolve('./relative/dir'));
    expect(result.outputDir).toMatch(/^\//);
  });
});
