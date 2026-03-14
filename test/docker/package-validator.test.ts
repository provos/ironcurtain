import { describe, it, expect } from 'vitest';
import { createPackageValidator, canonicalPackageName, packageCacheKey } from '../../src/docker/package-validator.js';
import type { PackageIdentity, VersionMetadata } from '../../src/docker/package-types.js';

/** Helper: creates a Date N days ago from now. */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

describe('canonicalPackageName', () => {
  it('returns unscoped name as-is', () => {
    expect(canonicalPackageName({ registry: 'npm', name: 'express' })).toBe('express');
  });

  it('returns scoped name with @ prefix', () => {
    expect(canonicalPackageName({ registry: 'npm', name: 'node', scope: 'types' })).toBe('@types/node');
  });

  it('handles PyPI names', () => {
    expect(canonicalPackageName({ registry: 'pypi', name: 'numpy' })).toBe('numpy');
  });
});

describe('packageCacheKey', () => {
  it('includes registry prefix', () => {
    expect(packageCacheKey({ registry: 'npm', name: 'express' })).toBe('npm:express');
    expect(packageCacheKey({ registry: 'pypi', name: 'numpy' })).toBe('pypi:numpy');
  });

  it('includes scope for npm scoped packages', () => {
    expect(packageCacheKey({ registry: 'npm', name: 'node', scope: 'types' })).toBe('npm:@types/node');
  });
});

describe('createPackageValidator', () => {
  describe('default configuration (2-day quarantine)', () => {
    const validator = createPackageValidator();

    it('allows packages with metadata older than 2 days', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'express', version: '4.18.2' };
      const metadata: VersionMetadata = { publishedAt: daysAgo(30) };
      expect(validator.validate(pkg, metadata)).toEqual({
        status: 'allow',
        reason: 'Passed all validation checks',
      });
    });

    it('denies packages published less than 2 days ago', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'express', version: '5.0.0' };
      const metadata: VersionMetadata = { publishedAt: daysAgo(1) };
      const result = validator.validate(pkg, metadata);
      expect(result.status).toBe('deny');
      expect(result.reason).toContain('1 day(s) old');
      expect(result.reason).toContain('quarantine: 2 days');
    });

    it('denies packages with no metadata (fail-closed)', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'unknown-pkg', version: '1.0.0' };
      const result = validator.validate(pkg, undefined);
      expect(result.status).toBe('deny');
      expect(result.reason).toContain('fail-closed');
    });

    it('denies packages with no publish timestamp (fail-closed)', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'mystery', version: '1.0.0' };
      const result = validator.validate(pkg, {});
      expect(result.status).toBe('deny');
      expect(result.reason).toContain('No publish timestamp');
    });

    it('allows packages published exactly 2 days ago', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'express', version: '4.19.0' };
      const metadata: VersionMetadata = { publishedAt: daysAgo(2) };
      expect(validator.validate(pkg, metadata).status).toBe('allow');
    });
  });

  describe('denylist', () => {
    const validator = createPackageValidator({
      deniedPackages: ['malicious-pkg', 'bad-*'],
    });

    it('denies exact match', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'malicious-pkg', version: '1.0.0' };
      const result = validator.validate(pkg, { publishedAt: daysAgo(30) });
      expect(result.status).toBe('deny');
      expect(result.reason).toContain('deny list');
    });

    it('denies glob match', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'bad-actor', version: '1.0.0' };
      const result = validator.validate(pkg, { publishedAt: daysAgo(30) });
      expect(result.status).toBe('deny');
      expect(result.reason).toContain('deny list');
    });

    it('allows non-matching package', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'good-pkg', version: '1.0.0' };
      const result = validator.validate(pkg, { publishedAt: daysAgo(30) });
      expect(result.status).toBe('allow');
    });
  });

  describe('allowlist', () => {
    const validator = createPackageValidator({
      allowedPackages: ['express', '@types/*'],
      quarantineDays: 7,
    });

    it('allows exact match and bypasses age gate', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'express', version: '5.0.0' };
      const metadata: VersionMetadata = { publishedAt: daysAgo(1) }; // Very new
      const result = validator.validate(pkg, metadata);
      expect(result.status).toBe('allow');
      expect(result.reason).toContain('allow list');
    });

    it('allows glob match for scoped packages', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'node', scope: 'types', version: '20.0.0' };
      const metadata: VersionMetadata = { publishedAt: daysAgo(0) }; // Brand new
      const result = validator.validate(pkg, metadata);
      expect(result.status).toBe('allow');
      expect(result.reason).toContain('allow list');
    });

    it('does not allow non-matching package that is too new', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'react', version: '19.0.0' };
      const metadata: VersionMetadata = { publishedAt: daysAgo(1) };
      expect(validator.validate(pkg, metadata).status).toBe('deny');
    });
  });

  describe('case-insensitive pattern matching', () => {
    const validator = createPackageValidator({
      allowedPackages: ['Express'],
      deniedPackages: ['Bad-Actor'],
    });

    it('allowlist matches case-insensitively', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'express', version: '4.18.2' };
      const metadata: VersionMetadata = { publishedAt: daysAgo(0) };
      const result = validator.validate(pkg, metadata);
      expect(result.status).toBe('allow');
      expect(result.reason).toContain('allow list');
    });

    it('denylist matches case-insensitively', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'bad-actor', version: '1.0.0' };
      const result = validator.validate(pkg, { publishedAt: daysAgo(30) });
      expect(result.status).toBe('deny');
      expect(result.reason).toContain('deny list');
    });
  });

  describe('denylist takes precedence over allowlist', () => {
    const validator = createPackageValidator({
      allowedPackages: ['express'],
      deniedPackages: ['express'],
    });

    it('denies when package is on both lists', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'express', version: '4.18.2' };
      const result = validator.validate(pkg, { publishedAt: daysAgo(30) });
      expect(result.status).toBe('deny');
      expect(result.reason).toContain('deny list');
    });
  });

  describe('quarantine disabled (quarantineDays: 0)', () => {
    const validator = createPackageValidator({ quarantineDays: 0 });

    it('allows brand new packages', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'new-pkg', version: '1.0.0' };
      const metadata: VersionMetadata = { publishedAt: daysAgo(0) };
      expect(validator.validate(pkg, metadata).status).toBe('allow');
    });

    it('allows packages with no metadata', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'mystery', version: '1.0.0' };
      expect(validator.validate(pkg, undefined).status).toBe('allow');
    });
  });

  describe('custom quarantine period', () => {
    const validator = createPackageValidator({ quarantineDays: 30 });

    it('denies packages newer than 30 days', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'react', version: '19.0.0' };
      const metadata: VersionMetadata = { publishedAt: daysAgo(15) };
      const result = validator.validate(pkg, metadata);
      expect(result.status).toBe('deny');
      expect(result.reason).toContain('quarantine: 30 days');
    });

    it('allows packages older than 30 days', () => {
      const pkg: PackageIdentity = { registry: 'npm', name: 'react', version: '18.2.0' };
      const metadata: VersionMetadata = { publishedAt: daysAgo(365) };
      expect(validator.validate(pkg, metadata).status).toBe('allow');
    });
  });

  describe('PyPI packages', () => {
    const validator = createPackageValidator({
      allowedPackages: ['numpy'],
      quarantineDays: 7,
    });

    it('validates PyPI packages the same way', () => {
      const pkg: PackageIdentity = { registry: 'pypi', name: 'numpy', version: '1.26.0' };
      const metadata: VersionMetadata = { publishedAt: daysAgo(1) };
      // numpy is allowlisted, so should pass even though very new
      expect(validator.validate(pkg, metadata).status).toBe('allow');
    });

    it('denies non-allowlisted new PyPI packages', () => {
      const pkg: PackageIdentity = { registry: 'pypi', name: 'sketchy-pkg', version: '0.1.0' };
      const metadata: VersionMetadata = { publishedAt: daysAgo(2) };
      expect(validator.validate(pkg, metadata).status).toBe('deny');
    });
  });
});
