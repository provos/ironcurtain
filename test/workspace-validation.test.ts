import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { validateWorkspacePath } from '../src/session/workspace-validation.js';

/** Runs `fn` with IRONCURTAIN_HOME temporarily set to `fakePath`, then restores it. */
function withIronCurtainHome(fakePath: string, fn: () => void): void {
  const original = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = fakePath;
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = original;
    }
  }
}

describe('validateWorkspacePath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ic-workspace-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('accepts a valid existing directory', () => {
    const workspace = join(tempDir, 'project');
    mkdirSync(workspace);
    const result = validateWorkspacePath(workspace, []);
    expect(result).toBe(realpathSync(workspace));
  });

  it('rejects a non-existent path', () => {
    const workspace = join(tempDir, 'does-not-exist');
    expect(() => validateWorkspacePath(workspace, [])).toThrow('does not exist');
  });

  it('rejects a file (not a directory)', () => {
    const filePath = join(tempDir, 'file.txt');
    writeFileSync(filePath, 'hello');
    expect(() => validateWorkspacePath(filePath, [])).toThrow('not a directory');
  });

  it('rejects the root directory', () => {
    expect(() => validateWorkspacePath('/', [])).toThrow('root directory');
  });

  it('rejects the home directory', () => {
    expect(() => validateWorkspacePath(homedir(), [])).toThrow('home directory');
  });

  it('rejects a path inside the IronCurtain home directory', () => {
    const fakeHome = join(tempDir, 'ic-home');
    mkdirSync(fakeHome, { recursive: true });
    const inside = join(fakeHome, 'sessions');
    mkdirSync(inside, { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      expect(() => validateWorkspacePath(inside, [])).toThrow('IronCurtain home');
    });
  });

  it('rejects the IronCurtain home directory itself', () => {
    const fakeHome = join(tempDir, 'ic-home-self');
    mkdirSync(fakeHome, { recursive: true });

    withIronCurtainHome(fakeHome, () => {
      expect(() => validateWorkspacePath(fakeHome, [])).toThrow('IronCurtain home');
    });
  });

  it('rejects workspace inside a protected path', () => {
    const protectedDir = join(tempDir, 'protected');
    mkdirSync(protectedDir, { recursive: true });
    const workspace = join(protectedDir, 'sub');
    mkdirSync(workspace, { recursive: true });

    expect(() => validateWorkspacePath(workspace, [protectedDir])).toThrow('overlaps with protected path');
  });

  it('rejects workspace that contains a protected path', () => {
    const workspace = join(tempDir, 'broad');
    mkdirSync(workspace, { recursive: true });
    const protectedDir = join(workspace, 'secrets');
    mkdirSync(protectedDir, { recursive: true });

    expect(() => validateWorkspacePath(workspace, [protectedDir])).toThrow('would contain protected path');
  });

  it('resolves symlinks before validation', () => {
    const realDir = join(tempDir, 'real');
    mkdirSync(realDir, { recursive: true });
    const symlink = join(tempDir, 'link');
    symlinkSync(realDir, symlink);

    const result = validateWorkspacePath(symlink, []);
    // Should resolve to the real path
    expect(result).toBe(realpathSync(realDir));
  });

  it('accepts workspace that does not overlap with protected paths', () => {
    const workspace = join(tempDir, 'safe-project');
    mkdirSync(workspace, { recursive: true });
    const protectedDir = join(tempDir, 'protected-other');

    const result = validateWorkspacePath(workspace, [protectedDir]);
    expect(result).toBe(realpathSync(workspace));
  });
});
