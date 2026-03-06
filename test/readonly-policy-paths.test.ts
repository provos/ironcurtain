/**
 * Tests for read-only policy path helpers.
 */

import { describe, it, expect } from 'vitest';
import { getReadOnlyPolicyDir, getPackageConfigDir } from '../src/config/paths.js';

describe('getReadOnlyPolicyDir', () => {
  it('returns an absolute path', () => {
    const dir = getReadOnlyPolicyDir();
    expect(dir).toMatch(/^\//);
  });

  it('ends with generated-readonly', () => {
    const dir = getReadOnlyPolicyDir();
    expect(dir).toMatch(/generated-readonly$/);
  });

  it('is under the config directory', () => {
    const configDir = getPackageConfigDir();
    const readOnlyDir = getReadOnlyPolicyDir();
    expect(readOnlyDir.startsWith(configDir)).toBe(true);
  });
});

describe('getPackageConfigDir', () => {
  it('returns an absolute path', () => {
    const dir = getPackageConfigDir();
    expect(dir).toMatch(/^\//);
  });

  it('ends with config', () => {
    const dir = getPackageConfigDir();
    expect(dir).toMatch(/config$/);
  });
});
