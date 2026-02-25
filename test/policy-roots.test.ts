import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extractPolicyRoots, toMcpRoots, directoryForPath } from '../src/trusted-process/policy-roots.js';
import type { CompiledPolicyFile, CompiledRule } from '../src/pipeline/types.js';

// Real temp directories so tests work on macOS (where /tmp → /private/tmp)
let tempDir: string;
let sandboxDir: string;
let downloadsDir: string;
let desktopDir: string;
let importantDir: string;
let sandboxLink: string;
let testFile: string;
let linkedFile: string;

beforeAll(() => {
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'policy-roots-test-')));
  sandboxDir = join(tempDir, 'sandbox');
  downloadsDir = join(tempDir, 'downloads');
  desktopDir = join(tempDir, 'desktop');
  importantDir = join(tempDir, 'important');

  mkdirSync(sandboxDir);
  mkdirSync(downloadsDir);
  mkdirSync(desktopDir);
  mkdirSync(importantDir);

  // Symlink pointing to the sandbox directory
  sandboxLink = join(tempDir, 'sandbox-link');
  symlinkSync(sandboxDir, sandboxLink);

  // Real file + file symlink
  testFile = join(sandboxDir, 'test-file.txt');
  writeFileSync(testFile, 'test');
  linkedFile = join(tempDir, 'linked-file.txt');
  symlinkSync(testFile, linkedFile);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

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
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots).toEqual([{ path: sandboxDir, name: 'sandbox' }]);
  });

  it('extracts directories from allow rules with paths.within', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'allow',
        paths: { roles: ['read-path'], within: downloadsDir },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots).toHaveLength(2);
    expect(roots[1].path).toBe(downloadsDir);
  });

  it('extracts directories from escalate rules with paths.within', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'escalate',
        paths: { roles: ['read-path'], within: desktopDir },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots).toHaveLength(2);
    expect(roots[1].path).toBe(desktopDir);
  });

  it('excludes deny rules', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'deny',
        paths: { roles: ['delete-path'], within: importantDir },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots).toHaveLength(1); // sandbox only
  });

  it('excludes catch-all rules without paths.within', () => {
    const policy = makePolicyFile([
      makeRule({ then: 'escalate' }), // no paths condition
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots).toHaveLength(1); // sandbox only
  });

  it('deduplicates directories referenced by multiple rules', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'allow',
        paths: { roles: ['read-path'], within: downloadsDir },
      }),
      makeRule({
        then: 'allow',
        paths: { roles: ['write-path'], within: downloadsDir },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots).toHaveLength(2); // sandbox + Downloads (once)
  });

  it('deduplicates when sandbox matches a rule directory', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'allow',
        paths: { roles: ['read-path'], within: sandboxDir },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots).toHaveLength(1); // sandbox only, no duplicate
  });

  it('uses rule name as the root name', () => {
    const policy = makePolicyFile([
      makeRule({
        name: 'allow-rwd-downloads',
        then: 'allow',
        paths: { roles: ['read-path'], within: downloadsDir },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots[1].name).toBe('allow-rwd-downloads');
  });

  it('resolves relative paths before deduplication', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'allow',
        paths: { roles: ['read-path'], within: './relative/dir' },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxDir);
    expect(roots[1].path).toBe(resolve('./relative/dir'));
  });

  it('resolves symlink sandbox path to the real directory', () => {
    const policy = makePolicyFile([]);
    const roots = extractPolicyRoots(policy, sandboxLink);
    expect(roots).toEqual([{ path: sandboxDir, name: 'sandbox' }]);
  });

  it('deduplicates when sandbox symlink and rule point to same real directory', () => {
    const policy = makePolicyFile([
      makeRule({
        then: 'allow',
        paths: { roles: ['read-path'], within: sandboxDir },
      }),
    ]);
    const roots = extractPolicyRoots(policy, sandboxLink);
    expect(roots).toHaveLength(1); // sandbox only, symlink resolved to same real path
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
    expect(directoryForPath(testFile)).toBe(sandboxDir);
  });

  it('returns the directory itself for a trailing-slash path', () => {
    expect(directoryForPath(desktopDir + '/')).toBe(desktopDir);
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

  it('resolves symlinks before extracting directory', () => {
    expect(directoryForPath(linkedFile)).toBe(sandboxDir);
  });
});
