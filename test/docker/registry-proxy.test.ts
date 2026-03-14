import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import { PassThrough } from 'node:stream';
import {
  parseNpmUrl,
  parsePypiSimpleUrl,
  parsePypiTarballUrl,
  extractPypiPackageFromFilename,
  normalizePypiName,
  isNpmMetadataRequest,
  isNpmTarballRequest,
  isPypiSimpleRequest,
  filterNpmPackument,
  filterPypiIndex,
  getCachedVersions,
  setCachedVersions,
  handleRegistryRequest,
  npmRegistry,
  type NpmPackument,
  type RegistryHandlerOptions,
} from '../../src/docker/registry-proxy.js';
import { createPackageValidator, DENY_ALL_VALIDATOR } from '../../src/docker/package-validator.js';
import type { AllowedVersionCache, PackageIdentity } from '../../src/docker/package-types.js';

// ── npm URL parsing ─────────────────────────────────────────────────

describe('parseNpmUrl', () => {
  describe('metadata requests', () => {
    it('parses unscoped package', () => {
      expect(parseNpmUrl('/express')).toEqual({
        registry: 'npm',
        name: 'express',
      });
    });

    it('parses scoped package', () => {
      expect(parseNpmUrl('/@types/node')).toEqual({
        registry: 'npm',
        name: 'node',
        scope: 'types',
      });
    });

    it('parses URL-encoded scoped package', () => {
      expect(parseNpmUrl('/@types%2fnode')).toEqual({
        registry: 'npm',
        name: 'node',
        scope: 'types',
      });
    });

    it('strips query string', () => {
      expect(parseNpmUrl('/express?version=latest')).toEqual({
        registry: 'npm',
        name: 'express',
      });
    });

    it('returns undefined for root path', () => {
      expect(parseNpmUrl('/')).toBeUndefined();
    });

    it('returns undefined for /-/ path', () => {
      expect(parseNpmUrl('/-')).toBeUndefined();
    });

    it('returns undefined for paths with extra segments', () => {
      expect(parseNpmUrl('/express/something')).toBeUndefined();
    });
  });

  describe('tarball requests', () => {
    it('parses unscoped tarball', () => {
      expect(parseNpmUrl('/express/-/express-4.18.2.tgz')).toEqual({
        registry: 'npm',
        name: 'express',
        version: '4.18.2',
      });
    });

    it('parses scoped tarball', () => {
      expect(parseNpmUrl('/@types/node/-/node-20.0.0.tgz')).toEqual({
        registry: 'npm',
        name: 'node',
        scope: 'types',
        version: '20.0.0',
      });
    });

    it('handles pre-release versions', () => {
      expect(parseNpmUrl('/react/-/react-19.0.0-rc.1.tgz')).toEqual({
        registry: 'npm',
        name: 'react',
        version: '19.0.0-rc.1',
      });
    });
  });
});

// ── PyPI URL parsing ────────────────────────────────────────────────

describe('parsePypiSimpleUrl', () => {
  it('parses simple package path with trailing slash', () => {
    expect(parsePypiSimpleUrl('/simple/numpy/')).toEqual({
      registry: 'pypi',
      name: 'numpy',
    });
  });

  it('parses without trailing slash', () => {
    expect(parsePypiSimpleUrl('/simple/numpy')).toEqual({
      registry: 'pypi',
      name: 'numpy',
    });
  });

  it('normalizes package name', () => {
    const result = parsePypiSimpleUrl('/simple/My_Package/');
    expect(result?.name).toBe('my-package');
  });

  it('returns undefined for non-simple paths', () => {
    expect(parsePypiSimpleUrl('/pypi/numpy/json')).toBeUndefined();
  });

  it('returns undefined for root simple path', () => {
    expect(parsePypiSimpleUrl('/simple/')).toBeUndefined();
  });
});

describe('parsePypiTarballUrl', () => {
  it('parses sdist tar.gz', () => {
    const result = parsePypiTarballUrl('/packages/hash/numpy-1.26.0.tar.gz');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'numpy',
      version: '1.26.0',
    });
  });

  it('parses wheel', () => {
    const result = parsePypiTarballUrl('/packages/hash/numpy-1.26.0-cp312-cp312-manylinux_2_17_x86_64.whl');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'numpy',
      version: '1.26.0',
    });
  });

  it('parses zip sdist', () => {
    const result = parsePypiTarballUrl('/packages/hash/some-package-2.0.0.zip');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'some-package',
      version: '2.0.0',
    });
  });

  it('returns undefined for unrecognized format', () => {
    expect(parsePypiTarballUrl('/packages/hash/readme.txt')).toBeUndefined();
  });
});

describe('extractPypiPackageFromFilename', () => {
  it('handles hyphenated package names', () => {
    const result = extractPypiPackageFromFilename('my-package-1.0.0.tar.gz');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'my-package',
      version: '1.0.0',
    });
  });

  it('handles underscore package names', () => {
    const result = extractPypiPackageFromFilename('my_package-1.0.0.tar.gz');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'my-package', // normalized
      version: '1.0.0',
    });
  });

  it('handles complex wheel filenames', () => {
    const result = extractPypiPackageFromFilename('scipy-1.12.0-cp312-cp312-macosx_12_0_arm64.whl');
    expect(result).toEqual({
      registry: 'pypi',
      name: 'scipy',
      version: '1.12.0',
    });
  });
});

describe('normalizePypiName', () => {
  it('lowercases', () => {
    expect(normalizePypiName('NumPy')).toBe('numpy');
  });

  it('replaces underscores with hyphens', () => {
    expect(normalizePypiName('my_package')).toBe('my-package');
  });

  it('replaces dots with hyphens', () => {
    expect(normalizePypiName('zope.interface')).toBe('zope-interface');
  });

  it('collapses consecutive separators', () => {
    expect(normalizePypiName('my__package')).toBe('my-package');
  });
});

// ── Request classification ──────────────────────────────────────────

describe('isNpmMetadataRequest', () => {
  it('returns true for metadata URLs', () => {
    expect(isNpmMetadataRequest('/express')).toBe(true);
    expect(isNpmMetadataRequest('/@types/node')).toBe(true);
  });

  it('returns false for tarball URLs', () => {
    expect(isNpmMetadataRequest('/express/-/express-4.18.2.tgz')).toBe(false);
  });

  it('returns false for non-package paths', () => {
    expect(isNpmMetadataRequest('/')).toBe(false);
  });
});

describe('isNpmTarballRequest', () => {
  it('returns true for tarball URLs', () => {
    expect(isNpmTarballRequest('/express/-/express-4.18.2.tgz')).toBe(true);
  });

  it('returns false for metadata URLs', () => {
    expect(isNpmTarballRequest('/express')).toBe(false);
  });
});

describe('isPypiSimpleRequest', () => {
  it('returns true for simple index URLs', () => {
    expect(isPypiSimpleRequest('/simple/numpy/')).toBe(true);
  });

  it('returns false for other paths', () => {
    expect(isPypiSimpleRequest('/pypi/numpy/json')).toBe(false);
  });
});

// ── npm packument filtering ─────────────────────────────────────────

describe('filterNpmPackument', () => {
  const olderDate = new Date('2022-06-01T00:00:00Z').toISOString();
  const oldDate = new Date('2023-01-01T00:00:00Z').toISOString();
  const newDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

  const packument: NpmPackument = {
    name: 'express',
    versions: {
      '4.17.0': { version: '4.17.0' },
      '4.18.0': { version: '4.18.0' },
      '5.0.0': { version: '5.0.0' },
    },
    'dist-tags': {
      latest: '5.0.0',
      previous: '4.18.0',
    },
    time: {
      created: '2010-01-01T00:00:00Z',
      modified: newDate,
      '4.17.0': olderDate,
      '4.18.0': oldDate,
      '5.0.0': newDate,
    },
  };

  it('filters out versions newer than quarantine period', () => {
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { filtered, denied } = filterNpmPackument(packument, validator, 'express');

    expect(Object.keys(filtered.versions)).toEqual(['4.17.0', '4.18.0']);
    expect(denied).toHaveLength(1);
    expect(denied[0].version).toBe('5.0.0');
  });

  it('updates dist-tags.latest when original latest is filtered', () => {
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { filtered } = filterNpmPackument(packument, validator, 'express');

    expect(filtered['dist-tags'].latest).toBe('4.18.0');
    // 'previous' still points to an allowed version
    expect(filtered['dist-tags'].previous).toBe('4.18.0');
  });

  it('preserves created and modified timestamps', () => {
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { filtered } = filterNpmPackument(packument, validator, 'express');

    expect(filtered.time?.created).toBe('2010-01-01T00:00:00Z');
    expect(filtered.time?.modified).toBe(newDate);
  });

  it('removes filtered version timestamps from time object', () => {
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { filtered } = filterNpmPackument(packument, validator, 'express');

    expect(filtered.time?.['5.0.0']).toBeUndefined();
    expect(filtered.time?.['4.17.0']).toBe(olderDate);
  });

  it('allows all versions when quarantine is disabled', () => {
    const validator = createPackageValidator({ quarantineDays: 0 });
    const { filtered, denied } = filterNpmPackument(packument, validator, 'express');

    expect(Object.keys(filtered.versions)).toEqual(['4.17.0', '4.18.0', '5.0.0']);
    expect(denied).toHaveLength(0);
  });

  it('filters denied packages completely', () => {
    const validator = createPackageValidator({ deniedPackages: ['express'] });
    const { filtered, denied } = filterNpmPackument(packument, validator, 'express');

    expect(Object.keys(filtered.versions)).toHaveLength(0);
    expect(denied).toHaveLength(3);
  });

  it('handles scoped packages', () => {
    const scopedPackument: NpmPackument = {
      name: '@types/node',
      versions: { '20.0.0': { version: '20.0.0' } },
      'dist-tags': { latest: '20.0.0' },
      time: { '20.0.0': oldDate },
    };
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { filtered } = filterNpmPackument(scopedPackument, validator, 'node', 'types');

    expect(Object.keys(filtered.versions)).toEqual(['20.0.0']);
  });
});

// ── PyPI index filtering ────────────────────────────────────────────

describe('filterPypiIndex', () => {
  const oldDate = new Date('2023-01-01T00:00:00Z');
  const newDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

  const html = `<!DOCTYPE html>
<html><body>
<a href="../../packages/hash/numpy-1.25.0.tar.gz#sha256=abc123">numpy-1.25.0.tar.gz</a>
<a href="../../packages/hash/numpy-1.26.0.tar.gz#sha256=def456">numpy-1.26.0.tar.gz</a>
<a href="../../packages/hash/numpy-2.0.0.tar.gz#sha256=ghi789">numpy-2.0.0.tar.gz</a>
<a href="../../packages/hash/numpy-2.0.0-cp312-cp312-manylinux.whl#sha256=jkl012">numpy-2.0.0-cp312-cp312-manylinux.whl</a>
</body></html>`;

  const timestamps = new Map<string, Date>([
    ['1.25.0', oldDate],
    ['1.26.0', oldDate],
    ['2.0.0', newDate],
  ]);

  it('removes links for denied versions', () => {
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { filtered, denied, allowedVersions } = filterPypiIndex(html, validator, 'numpy', timestamps);

    expect(filtered).toContain('numpy-1.25.0.tar.gz');
    expect(filtered).toContain('numpy-1.26.0.tar.gz');
    expect(filtered).not.toContain('numpy-2.0.0');
    expect(denied).toHaveLength(1);
    expect(denied[0].version).toBe('2.0.0');
    expect(allowedVersions).toEqual(new Set(['1.25.0', '1.26.0']));
  });

  it('deduplicates denied versions (multiple files per version)', () => {
    const validator = createPackageValidator({ quarantineDays: 7 });
    const { denied } = filterPypiIndex(html, validator, 'numpy', timestamps);

    // 2.0.0 has both .tar.gz and .whl but should appear once in denied
    expect(denied.filter((d) => d.version === '2.0.0')).toHaveLength(1);
  });

  it('keeps all links when quarantine is disabled', () => {
    const validator = createPackageValidator({ quarantineDays: 0 });
    const { filtered, denied, allowedVersions } = filterPypiIndex(html, validator, 'numpy', timestamps);

    expect(filtered).toContain('numpy-2.0.0.tar.gz');
    expect(denied).toHaveLength(0);
    expect(allowedVersions).toEqual(new Set(['1.25.0', '1.26.0', '2.0.0']));
  });

  it('removes all links for denied packages', () => {
    const validator = createPackageValidator({ deniedPackages: ['numpy'] });
    const { denied, allowedVersions } = filterPypiIndex(html, validator, 'numpy', timestamps);

    expect(denied.length).toBeGreaterThan(0);
    expect(allowedVersions.size).toBe(0);
  });
});

// ── AllowedVersionCache ─────────────────────────────────────────────

describe('AllowedVersionCache', () => {
  it('stores and retrieves versions', () => {
    const cache: AllowedVersionCache = new Map();
    const pkg: PackageIdentity = { registry: 'npm', name: 'express' };

    setCachedVersions(cache, pkg, new Set(['4.17.0', '4.18.0']));
    const versions = getCachedVersions(cache, pkg);

    expect(versions).toBeDefined();
    expect(versions!.has('4.17.0')).toBe(true);
    expect(versions!.has('4.18.0')).toBe(true);
    expect(versions!.has('5.0.0')).toBe(false);
  });

  it('returns undefined on cache miss', () => {
    const cache: AllowedVersionCache = new Map();
    const pkg: PackageIdentity = { registry: 'npm', name: 'express' };

    expect(getCachedVersions(cache, pkg)).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    const cache: AllowedVersionCache = new Map();
    const pkg: PackageIdentity = { registry: 'npm', name: 'express' };

    // Manually set an old entry
    const key = 'npm:express';
    cache.set(key, {
      allowedVersions: new Set(['4.17.0']),
      cachedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
    });

    expect(getCachedVersions(cache, pkg)).toBeUndefined();
  });

  it('uses different keys for different registries', () => {
    const cache: AllowedVersionCache = new Map();
    const npmPkg: PackageIdentity = { registry: 'npm', name: 'requests' };
    const pypiPkg: PackageIdentity = { registry: 'pypi', name: 'requests' };

    setCachedVersions(cache, npmPkg, new Set(['1.0.0']));
    setCachedVersions(cache, pypiPkg, new Set(['2.0.0']));

    expect(getCachedVersions(cache, npmPkg)!.has('1.0.0')).toBe(true);
    expect(getCachedVersions(cache, pypiPkg)!.has('2.0.0')).toBe(true);
  });
});

// ── Adversarial tarball backstop routing ─────────────────────────────

describe('handleRegistryRequest: adversarial /-/ paths', () => {
  /** Creates a fake IncomingMessage with the given URL. */
  function fakeReq(url: string): http.IncomingMessage {
    const req = new PassThrough() as unknown as http.IncomingMessage;
    req.url = url;
    req.method = 'GET';
    req.headers = {};
    return req;
  }

  /** Creates a fake ServerResponse that captures statusCode and body. */
  function fakeRes(): http.ServerResponse & { body: string; statusCode: number } {
    const res = new PassThrough() as unknown as http.ServerResponse & { body: string; statusCode: number };
    res.body = '';
    res.statusCode = 0;
    res.writeHead = ((code: number) => {
      res.statusCode = code;
      return res;
    }) as unknown as typeof res.writeHead;
    res.end = ((data?: string) => {
      if (data) res.body = data;
      return res;
    }) as unknown as typeof res.end;
    return res;
  }

  const options: RegistryHandlerOptions = {
    validator: DENY_ALL_VALIDATOR,
    cache: new Map(),
  };

  const adversarialPaths = [
    '/-/some-random-path',
    '/-/',
    '/express/-/not-a-real-tarball',
    '/express/-/',
    '/@scope/pkg/-/garbled-filename.xyz',
    '/-/v1/security/advisories',
    '/express/-/express-99.99.99.tgz', // valid-looking but won't be in cache
  ];

  for (const path of adversarialPaths) {
    it(`denies crafted path: ${path}`, async () => {
      const req = fakeReq(path);
      const res = fakeRes();

      await handleRegistryRequest(npmRegistry, req, res, 'registry.npmjs.org', 443, options);

      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('Forbidden');
    });
  }

  it('does not deny legitimate npm metadata requests', async () => {
    const req = fakeReq('/express');
    const res = fakeRes();

    // This will try to fetch upstream and fail (no real network), resulting in 502
    // The important thing is it does NOT return 403
    await handleRegistryRequest(npmRegistry, req, res, 'registry.npmjs.org', 443, options);

    expect(res.statusCode).not.toBe(403);
  });
});
