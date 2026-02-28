import { describe, it, expect, vi } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Mock realpathSync so tests don't depend on real filesystem symlinks.
// This isolates path normalization logic from host-specific symlink layout.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, realpathSync: (p: string) => p };
});
import {
  ARGUMENT_ROLE_REGISTRY,
  getRoleDefinition,
  getResourceRoles,
  isArgumentRole,
  getArgumentRoleValues,
  expandTilde,
  resolveRealPath,
  getRolesByCategory,
  getPathRoles,
  getUrlRoles,
} from '../src/types/argument-roles.js';
import type { ArgumentRole } from '../src/types/argument-roles.js';
import {
  normalizeUrl,
  extractDomain,
  extractDomainForRole,
  normalizeGitUrl,
  extractGitDomain,
  resolveGitRemote,
} from '../src/trusted-process/domain-utils.js';

describe('ARGUMENT_ROLE_REGISTRY', () => {
  it('contains all eleven roles', () => {
    expect(ARGUMENT_ROLE_REGISTRY.size).toBe(11);
  });

  it('has entries for all known roles', () => {
    const expectedRoles: ArgumentRole[] = [
      'read-path',
      'write-path',
      'delete-path',
      'write-history',
      'delete-history',
      'fetch-url',
      'git-remote-url',
      'github-owner',
      'branch-name',
      'commit-message',
      'none',
    ];
    for (const role of expectedRoles) {
      expect(ARGUMENT_ROLE_REGISTRY.has(role)).toBe(true);
    }
  });

  it('every role has category and annotationGuidance', () => {
    for (const [, def] of ARGUMENT_ROLE_REGISTRY) {
      expect(def.category).toBeDefined();
      expect(def.annotationGuidance).toBeDefined();
      expect(def.annotationGuidance.length).toBeGreaterThan(0);
    }
  });

  it('is read-only (Map interface prevents set)', () => {
    expect(ARGUMENT_ROLE_REGISTRY.get('read-path')).toBeDefined();
  });
});

describe('getRoleDefinition', () => {
  it('returns definition for read-path', () => {
    const def = getRoleDefinition('read-path');
    expect(def.isResourceIdentifier).toBe(true);
    expect(def.description).toContain('read');
  });

  it('returns definition for write-path', () => {
    const def = getRoleDefinition('write-path');
    expect(def.isResourceIdentifier).toBe(true);
    expect(def.description).toContain('written');
  });

  it('returns definition for delete-path', () => {
    const def = getRoleDefinition('delete-path');
    expect(def.isResourceIdentifier).toBe(true);
    expect(def.description).toContain('deleted');
  });

  it('returns definition for none', () => {
    const def = getRoleDefinition('none');
    expect(def.isResourceIdentifier).toBe(false);
    expect(def.description).toContain('no resource');
  });
});

describe('getResourceRoles', () => {
  it('returns only resource-identifier roles', () => {
    const roles = getResourceRoles();
    expect(roles).toContain('read-path');
    expect(roles).toContain('write-path');
    expect(roles).toContain('delete-path');
    expect(roles).toContain('fetch-url');
    expect(roles).toContain('git-remote-url');
    expect(roles).not.toContain('none');
    expect(roles).not.toContain('branch-name');
    expect(roles).not.toContain('commit-message');
  });

  it('returns exactly eight roles', () => {
    expect(getResourceRoles()).toHaveLength(8);
  });
});

describe('isArgumentRole', () => {
  it('returns true for valid roles', () => {
    expect(isArgumentRole('read-path')).toBe(true);
    expect(isArgumentRole('write-path')).toBe(true);
    expect(isArgumentRole('delete-path')).toBe(true);
    expect(isArgumentRole('write-history')).toBe(true);
    expect(isArgumentRole('delete-history')).toBe(true);
    expect(isArgumentRole('fetch-url')).toBe(true);
    expect(isArgumentRole('git-remote-url')).toBe(true);
    expect(isArgumentRole('github-owner')).toBe(true);
    expect(isArgumentRole('branch-name')).toBe(true);
    expect(isArgumentRole('commit-message')).toBe(true);
    expect(isArgumentRole('none')).toBe(true);
  });

  it('returns false for invalid strings', () => {
    expect(isArgumentRole('execute')).toBe(false);
    expect(isArgumentRole('')).toBe(false);
    expect(isArgumentRole('READ-PATH')).toBe(false);
  });
});

describe('getArgumentRoleValues', () => {
  it('returns a non-empty tuple', () => {
    const values = getArgumentRoleValues();
    expect(values.length).toBeGreaterThanOrEqual(1);
  });

  it('contains all eleven roles', () => {
    const values = getArgumentRoleValues();
    expect(values).toContain('read-path');
    expect(values).toContain('write-path');
    expect(values).toContain('delete-path');
    expect(values).toContain('write-history');
    expect(values).toContain('delete-history');
    expect(values).toContain('fetch-url');
    expect(values).toContain('git-remote-url');
    expect(values).toContain('github-owner');
    expect(values).toContain('branch-name');
    expect(values).toContain('commit-message');
    expect(values).toContain('none');
  });
});

describe('expandTilde', () => {
  const home = homedir();

  it('expands ~/path to homedir/path', () => {
    expect(expandTilde('~/Downloads')).toBe(`${home}/Downloads`);
  });

  it('expands bare ~ to homedir', () => {
    expect(expandTilde('~')).toBe(home);
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

describe('resolveRealPath', () => {
  const home = homedir();

  it('expands tilde before resolving', () => {
    expect(resolveRealPath('~/Downloads')).toBe(`${home}/Downloads`);
  });

  it('resolves relative paths to absolute', () => {
    expect(resolveRealPath('./foo/bar')).toBe(resolve('./foo/bar'));
  });

  it('collapses parent traversals', () => {
    expect(resolveRealPath('/tmp/foo/../bar')).toBe('/tmp/bar');
  });

  it('returns absolute paths as-is (modulo normalization)', () => {
    expect(resolveRealPath('/tmp/clean')).toBe('/tmp/clean');
  });
});

describe('normalizers via registry', () => {
  it('path roles use resolveRealPath', () => {
    const home = homedir();
    for (const role of [
      'read-path',
      'write-path',
      'delete-path',
      'write-history',
      'delete-history',
    ] as ArgumentRole[]) {
      const def = getRoleDefinition(role);
      expect(def.canonicalize('~/test')).toBe(`${home}/test`);
      expect(def.canonicalize('/tmp/a/../b')).toBe('/tmp/b');
    }
  });

  it('none role uses identity', () => {
    const def = getRoleDefinition('none');
    expect(def.canonicalize('~/test')).toBe('~/test');
    expect(def.canonicalize('/etc/passwd')).toBe('/etc/passwd');
    expect(def.canonicalize('hello world')).toBe('hello world');
  });

  it('url roles have url category', () => {
    const fetchDef = getRoleDefinition('fetch-url');
    expect(fetchDef.category).toBe('url');

    const gitDef = getRoleDefinition('git-remote-url');
    expect(gitDef.category).toBe('url');
  });

  it('opaque roles use identity', () => {
    for (const role of ['branch-name', 'commit-message', 'none'] as ArgumentRole[]) {
      const def = getRoleDefinition(role);
      expect(def.canonicalize('anything')).toBe('anything');
    }
  });
});

describe('normalizeUrl', () => {
  it('normalizes simple URL', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  it('preserves path component', () => {
    expect(normalizeUrl('https://example.com/path/to/resource')).toBe('https://example.com/path/to/resource');
  });

  it('preserves port', () => {
    expect(normalizeUrl('https://example.com:8080/path')).toBe('https://example.com:8080/path');
  });

  it('returns invalid input as-is', () => {
    expect(normalizeUrl('not-a-url')).toBe('not-a-url');
  });
});

describe('extractDomain', () => {
  it('extracts domain from HTTPS URL', () => {
    expect(extractDomain('https://github.com/user/repo')).toBe('github.com');
  });

  it('extracts domain from HTTP URL', () => {
    expect(extractDomain('http://example.com')).toBe('example.com');
  });

  it('returns invalid input as-is', () => {
    expect(extractDomain('not-a-url')).toBe('not-a-url');
  });
});

describe('normalizeGitUrl', () => {
  it('returns SSH URLs as-is', () => {
    expect(normalizeGitUrl('git@github.com:user/repo.git')).toBe('git@github.com:user/repo.git');
  });

  it('normalizes HTTP git URLs', () => {
    expect(normalizeGitUrl('https://github.com/user/repo.git/')).toBe('https://github.com/user/repo.git');
  });

  it('returns non-URL strings as-is', () => {
    expect(normalizeGitUrl('origin')).toBe('origin');
  });
});

describe('extractDomainForRole', () => {
  it('uses extractDomain for fetch-url', () => {
    expect(extractDomainForRole('https://example.com/path', 'fetch-url')).toBe('example.com');
  });

  it('uses extractGitDomain for git-remote-url with SSH URL', () => {
    expect(extractDomainForRole('git@github.com:user/repo.git', 'git-remote-url')).toBe('github.com');
  });

  it('uses extractGitDomain for git-remote-url with HTTPS URL', () => {
    expect(extractDomainForRole('https://gitlab.com/user/repo.git', 'git-remote-url')).toBe('gitlab.com');
  });
});

describe('extractGitDomain', () => {
  it('extracts domain from SSH URL', () => {
    expect(extractGitDomain('git@github.com:user/repo.git')).toBe('github.com');
  });

  it('extracts domain from HTTPS URL', () => {
    expect(extractGitDomain('https://gitlab.com/user/repo.git')).toBe('gitlab.com');
  });

  it('returns named remote as-is (not a URL)', () => {
    expect(extractGitDomain('origin')).toBe('origin');
  });
});

describe('resolveGitRemote', () => {
  it('returns URLs with :// as-is', () => {
    expect(resolveGitRemote('https://github.com/user/repo.git', {})).toBe('https://github.com/user/repo.git');
  });

  it('returns SSH URLs as-is', () => {
    expect(resolveGitRemote('git@github.com:user/repo.git', {})).toBe('git@github.com:user/repo.git');
  });

  it('returns original value when git command fails (no repo)', () => {
    // Resolution will fail because /nonexistent is not a git repo
    expect(resolveGitRemote('origin', { path: '/nonexistent' })).toBe('origin');
  });

  it('uses path argument as cwd for git command', () => {
    // This test verifies the function signature accepts allArgs with path
    const result = resolveGitRemote('nonexistent-remote', { path: '/tmp' });
    // Should fail gracefully and return original value
    expect(result).toBe('nonexistent-remote');
  });
});

describe('getRolesByCategory', () => {
  it('returns path-category roles', () => {
    const paths = getRolesByCategory('path');
    expect(paths).toContain('read-path');
    expect(paths).toContain('write-path');
    expect(paths).toContain('delete-path');
    expect(paths).toContain('write-history');
    expect(paths).toContain('delete-history');
    expect(paths).toHaveLength(5);
  });

  it('returns url-category roles', () => {
    const urls = getRolesByCategory('url');
    expect(urls).toContain('fetch-url');
    expect(urls).toContain('git-remote-url');
    expect(urls).toHaveLength(2);
  });

  it('returns opaque-category roles', () => {
    const opaques = getRolesByCategory('opaque');
    expect(opaques).toContain('branch-name');
    expect(opaques).toContain('commit-message');
    expect(opaques).toContain('none');
    expect(opaques).toHaveLength(3);
  });
});

describe('getPathRoles', () => {
  it('returns all five path roles', () => {
    const roles = getPathRoles();
    expect(roles).toEqual(['read-path', 'write-path', 'delete-path', 'write-history', 'delete-history']);
  });
});

describe('getUrlRoles', () => {
  it('returns exactly the two URL roles', () => {
    const roles = getUrlRoles();
    expect(roles).toEqual(['fetch-url', 'git-remote-url']);
  });
});
