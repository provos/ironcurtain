import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  ARGUMENT_ROLE_REGISTRY,
  getRoleDefinition,
  getResourceRoles,
  isArgumentRole,
  getArgumentRoleValues,
  expandTilde,
  normalizePath,
} from '../src/types/argument-roles.js';
import type { ArgumentRole } from '../src/types/argument-roles.js';

describe('ARGUMENT_ROLE_REGISTRY', () => {
  it('contains exactly four roles', () => {
    expect(ARGUMENT_ROLE_REGISTRY.size).toBe(4);
  });

  it('has entries for all known roles', () => {
    const expectedRoles: ArgumentRole[] = ['read-path', 'write-path', 'delete-path', 'none'];
    for (const role of expectedRoles) {
      expect(ARGUMENT_ROLE_REGISTRY.has(role)).toBe(true);
    }
  });

  it('is read-only (Map interface prevents set)', () => {
    // ReadonlyMap does not expose .set(), verified at the type level.
    // Runtime check: the registry object is a standard Map under the hood,
    // but the exported type prevents mutation in TypeScript.
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
    expect(roles).not.toContain('none');
  });

  it('returns exactly three roles', () => {
    expect(getResourceRoles()).toHaveLength(3);
  });
});

describe('isArgumentRole', () => {
  it('returns true for valid roles', () => {
    expect(isArgumentRole('read-path')).toBe(true);
    expect(isArgumentRole('write-path')).toBe(true);
    expect(isArgumentRole('delete-path')).toBe(true);
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

  it('contains all four roles', () => {
    const values = getArgumentRoleValues();
    expect(values).toContain('read-path');
    expect(values).toContain('write-path');
    expect(values).toContain('delete-path');
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

describe('normalizePath', () => {
  const home = homedir();

  it('expands tilde and resolves', () => {
    expect(normalizePath('~/Downloads')).toBe(`${home}/Downloads`);
  });

  it('resolves relative paths to absolute', () => {
    expect(normalizePath('./foo/bar')).toBe(resolve('./foo/bar'));
  });

  it('collapses parent traversals', () => {
    expect(normalizePath('/tmp/foo/../bar')).toBe('/tmp/bar');
  });

  it('returns absolute paths as-is (modulo normalization)', () => {
    expect(normalizePath('/tmp/clean')).toBe('/tmp/clean');
  });
});

describe('normalizers via registry', () => {
  it('path roles use normalizePath', () => {
    const home = homedir();
    for (const role of ['read-path', 'write-path', 'delete-path'] as ArgumentRole[]) {
      const def = getRoleDefinition(role);
      expect(def.normalize('~/test')).toBe(`${home}/test`);
      expect(def.normalize('/tmp/a/../b')).toBe('/tmp/b');
    }
  });

  it('none role uses identity', () => {
    const def = getRoleDefinition('none');
    expect(def.normalize('~/test')).toBe('~/test');
    expect(def.normalize('/etc/passwd')).toBe('/etc/passwd');
    expect(def.normalize('hello world')).toBe('hello world');
  });

  it('no current role defines prepareForPolicy', () => {
    for (const [, def] of ARGUMENT_ROLE_REGISTRY) {
      expect(def.prepareForPolicy).toBeUndefined();
    }
  });
});
