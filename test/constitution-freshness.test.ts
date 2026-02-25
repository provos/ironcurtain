import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { checkConstitutionFreshness } from '../src/config/index.js';
import { loadConstitutionText } from '../src/config/paths.js';
import type { CompiledPolicyFile } from '../src/pipeline/types.js';

function makePolicy(constitutionHash: string): CompiledPolicyFile {
  return {
    generatedAt: new Date().toISOString(),
    constitutionHash,
    inputHash: 'unused',
    rules: [],
  };
}

describe('checkConstitutionFreshness', () => {
  let tmpDir: string;
  const savedHome = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-freshness-'));
    // Point getUserConstitutionPath() at the temp dir so no user file interferes
    process.env.IRONCURTAIN_HOME = tmpDir;
  });

  afterEach(() => {
    if (savedHome !== undefined) {
      process.env.IRONCURTAIN_HOME = savedHome;
    } else {
      delete process.env.IRONCURTAIN_HOME;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits no warning when hash matches', () => {
    const constitutionPath = resolve(tmpDir, 'constitution.md');
    writeFileSync(constitutionPath, '# My constitution\nBe nice.');
    // User constitution must also exist for the combined hash
    const userPath = resolve(tmpDir, 'constitution-user.md');
    writeFileSync(userPath, 'user rules');
    const combined = '# My constitution\nBe nice.\n\nuser rules';
    const hash = createHash('sha256').update(combined).digest('hex');
    const policy = makePolicy(hash);

    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    checkConstitutionFreshness(policy, constitutionPath);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('emits warning to stderr when hash mismatches', () => {
    const constitutionPath = resolve(tmpDir, 'constitution.md');
    writeFileSync(constitutionPath, '# Updated constitution');
    const userPath = resolve(tmpDir, 'constitution-user.md');
    writeFileSync(userPath, 'user rules');
    const policy = makePolicy('stale-hash');

    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    checkConstitutionFreshness(policy, constitutionPath);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('constitution has changed');
    spy.mockRestore();
  });

  it('throws when base constitution file is missing', () => {
    const missingPath = resolve(tmpDir, 'nonexistent.md');
    const policy = makePolicy('any-hash');

    expect(() => checkConstitutionFreshness(policy, missingPath)).toThrow('Base constitution not found');
  });
});

describe('loadConstitutionText user-local override', () => {
  let tmpDir: string;
  const savedHome = process.env.IRONCURTAIN_HOME;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-constitution-'));
    process.env.IRONCURTAIN_HOME = tmpDir;
  });

  afterEach(() => {
    if (savedHome !== undefined) {
      process.env.IRONCURTAIN_HOME = savedHome;
    } else {
      delete process.env.IRONCURTAIN_HOME;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses package base with bundled user constitution when no user-local files exist', () => {
    const packagePath = resolve(tmpDir, 'package-constitution.md');
    writeFileSync(packagePath, 'package base');

    // No user files in tmpDir — falls back to bundled constitution-user-base.md
    const result = loadConstitutionText(packagePath);
    expect(result).toMatch(/^package base\n\n/);
    expect(result).toContain('User Policy Customizations');
  });

  it('uses user-local constitution.md instead of package base when it exists', () => {
    const packagePath = resolve(tmpDir, 'package-constitution.md');
    writeFileSync(packagePath, 'package base');

    // Write user-local override at ~/.ironcurtain/constitution.md
    const userBasePath = resolve(tmpDir, 'constitution.md');
    writeFileSync(userBasePath, 'user override base');

    // No constitution-user.md in tmpDir — falls back to bundled user base
    const result = loadConstitutionText(packagePath);
    expect(result).toMatch(/^user override base\n\n/);
    expect(result).toContain('User Policy Customizations');
  });

  it('appends constitution-user.md to user-local base', () => {
    const packagePath = resolve(tmpDir, 'package-constitution.md');
    writeFileSync(packagePath, 'package base');

    const userBasePath = resolve(tmpDir, 'constitution.md');
    writeFileSync(userBasePath, 'user override base');

    const userExtPath = resolve(tmpDir, 'constitution-user.md');
    writeFileSync(userExtPath, 'user extensions');

    expect(loadConstitutionText(packagePath)).toBe('user override base\n\nuser extensions');
  });

  it('appends constitution-user.md to package base when no user-local base exists', () => {
    const packagePath = resolve(tmpDir, 'package-constitution.md');
    writeFileSync(packagePath, 'package base');

    const userExtPath = resolve(tmpDir, 'constitution-user.md');
    writeFileSync(userExtPath, 'user extensions');

    expect(loadConstitutionText(packagePath)).toBe('package base\n\nuser extensions');
  });
});
