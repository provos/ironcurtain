import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  extractPolicyRoots,
  toMcpRoots,
  directoryForPath,
} from '../src/trusted-process/policy-roots.js';
import type { CompiledPolicyFile, CompiledRule } from '../src/pipeline/types.js';

function makeRule(overrides: {
  name?: string;
  then: 'allow' | 'deny' | 'escalate';
  paths?: { roles: string[]; within: string };
}): CompiledRule {
  return {
    name: overrides.name ?? `test-rule-${Math.random().toString(36).slice(2, 8)}`,
    description: 'test rule',
    principle: 'test',
    if: {
      ...(overrides.paths ? { paths: overrides.paths as CompiledRule['if']['paths'] } : {}),
    },
    then: overrides.then,
    reason: 'test reason',
  };
}

function makePolicyFile(rules: CompiledRule[]): CompiledPolicyFile {
  return {
    generatedAt: new Date().toISOString(),
    constitutionHash: 'test-hash',
    inputHash: 'test-input-hash',
    rules,
  };
}

describe('extractPolicyRoots', () => {
  it('always includes the sandbox directory as the first root', () => {
    const policy = makePolicyFile([]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toEqual([{ path: '/tmp/sandbox', name: 'sandbox' }]);
  });

  it('extracts directories from allow rules with paths.within', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'allow',
        paths: { roles: ['read-path'], within: '/home/user/Downloads' },
      }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(2);
    expect(roots[1].path).toBe('/home/user/Downloads');
  });

  it('extracts directories from escalate rules with paths.within', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'escalate',
        paths: { roles: ['read-path'], within: '/home/user/Desktop' },
      }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(2);
    expect(roots[1].path).toBe('/home/user/Desktop');
  });

  it('excludes deny rules', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'deny',
        paths: { roles: ['delete-path'], within: '/home/user/important' },
      }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(1); // sandbox only
  });

  it('excludes catch-all rules without paths.within', () => {
    const policy = makePolicyFile([
      makeRule({ then: 'escalate' }), // no paths condition
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(1); // sandbox only
  });

  it('deduplicates directories referenced by multiple rules', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'allow',
        paths: { roles: ['read-path'], within: '/home/user/Downloads' },
      }),
      makeRule({
        then: 'allow',
        paths: { roles: ['write-path'], within: '/home/user/Downloads' },
      }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(2); // sandbox + Downloads (once)
  });

  it('deduplicates when sandbox matches a rule directory', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'allow',
        paths: { roles: ['read-path'], within: '/tmp/sandbox' },
      }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(1); // sandbox only, no duplicate
  });

  it('uses rule name as the root name', () => {
    const policy = makePolicyFile([
      makeRule({
        name: 'allow-rwd-downloads',
        then: 'allow',
        paths: { roles: ['read-path'], within: '/home/user/Downloads' },
      }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots[1].name).toBe('allow-rwd-downloads');
  });

  it('resolves relative paths before deduplication', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'allow',
        paths: { roles: ['read-path'], within: './relative/dir' },
      }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots[1].path).toBe(resolve('./relative/dir'));
  });
});

describe('toMcpRoots', () => {
  it('converts paths to file:// URIs', () => {
    const mcpRoots = toMcpRoots([
      { path: '/tmp/sandbox', name: 'sandbox' },
      { path: '/home/user/Downloads', name: 'downloads' },
    ]);
    expect(mcpRoots).toEqual([
      { uri: 'file:///tmp/sandbox', name: 'sandbox' },
      { uri: 'file:///home/user/Downloads', name: 'downloads' },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(toMcpRoots([])).toEqual([]);
  });
});

describe('directoryForPath', () => {
  it('returns dirname for a file path', () => {
    expect(directoryForPath('/etc/hosts')).toBe('/etc');
  });

  it('returns the directory itself for a trailing-slash path', () => {
    expect(directoryForPath('/home/user/Documents/')).toBe('/home/user/Documents');
  });

  it('resolves relative paths before extracting directory', () => {
    expect(directoryForPath('relative/file.txt')).toBe(resolve('relative'));
  });

  it('handles deeply nested file paths', () => {
    expect(directoryForPath('/a/b/c/d/file.txt')).toBe('/a/b/c/d');
  });

  it('handles root-level files', () => {
    expect(directoryForPath('/file.txt')).toBe('/');
  });
});
