import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly files: readonly string[];
}

describe('npm package contents', () => {
  it('ships the authoritative dist workflow copy without duplicating source workflows', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;

    expect(manifest.files).toContain('dist/');
    expect(manifest.files).toContain('docker/');
    expect(manifest.files.some((path) => path.startsWith('src/workflow/workflows'))).toBe(false);
  });
});
