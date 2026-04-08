/**
 * Unit tests for workflow file browser dispatch helpers.
 */

import { describe, it, expect } from 'vitest';
import { inferLanguage, resolveAndContain } from '../src/web-ui/dispatch/workflow-dispatch.js';

describe('inferLanguage', () => {
  it('maps TypeScript extensions', () => {
    expect(inferLanguage('foo.ts')).toBe('typescript');
    expect(inferLanguage('foo.tsx')).toBe('typescript');
  });

  it('maps JavaScript extensions', () => {
    expect(inferLanguage('foo.js')).toBe('javascript');
    expect(inferLanguage('foo.jsx')).toBe('javascript');
  });

  it('maps JSON', () => {
    expect(inferLanguage('package.json')).toBe('json');
  });

  it('maps Markdown', () => {
    expect(inferLanguage('README.md')).toBe('markdown');
  });

  it('maps YAML', () => {
    expect(inferLanguage('config.yaml')).toBe('yaml');
    expect(inferLanguage('config.yml')).toBe('yaml');
  });

  it('defaults to text for unknown extensions', () => {
    expect(inferLanguage('file.xyz')).toBe('text');
    expect(inferLanguage('Makefile')).toBe('text');
  });

  it('handles nested paths', () => {
    expect(inferLanguage('src/deep/nested/file.py')).toBe('python');
  });
});

describe('resolveAndContain', () => {
  const workspace = '/tmp/test-workspace';

  it('resolves simple relative paths', () => {
    const result = resolveAndContain(workspace, 'src/index.ts');
    expect(result).toBe('/tmp/test-workspace/src/index.ts');
  });

  it('rejects absolute paths', () => {
    expect(() => resolveAndContain(workspace, '/etc/passwd')).toThrow('Path must be relative');
  });

  it('rejects path traversal', () => {
    expect(() => resolveAndContain(workspace, '../../../etc/passwd')).toThrow('Path must be relative');
  });

  it('resolves empty path to workspace root', () => {
    const result = resolveAndContain(workspace, '');
    expect(result).toBe('/tmp/test-workspace');
  });

  it('resolves dot path to workspace root', () => {
    const result = resolveAndContain(workspace, '.');
    expect(result).toBe('/tmp/test-workspace');
  });
});
