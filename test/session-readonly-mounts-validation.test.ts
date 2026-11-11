import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReadonlyMounts } from '../src/docker/container-workspace.js';
import {
  MAX_READONLY_MOUNTS,
  formatReadonlyMountsPrompt,
  normalizeHostPathInput,
  readonlyMountsOverlapWorkspace,
  readWslAutomountRoot,
  resolveReadonlyMounts,
  restoreReadonlyMounts,
} from '../src/session/readonly-mounts.js';

describe('normalizeHostPathInput', () => {
  const wsl = { wsl: true, automountRoot: '/mnt/' };

  it('translates Windows drive paths under WSL', () => {
    expect(normalizeHostPathInput('D:\\Training', wsl)).toBe('/mnt/d/Training');
    expect(normalizeHostPathInput('d:/Training/sub/', wsl)).toBe('/mnt/d/Training/sub');
    expect(normalizeHostPathInput('  E:\\  ', wsl)).toBe('/mnt/e');
    expect(normalizeHostPathInput('C:', wsl)).toBe('/mnt/c');
  });

  it('honors a custom automount root', () => {
    expect(normalizeHostPathInput('D:\\x', { wsl: true, automountRoot: '/win/' })).toBe('/win/d/x');
  });

  it('leaves POSIX paths and non-WSL input unchanged', () => {
    expect(normalizeHostPathInput('/mnt/d/Training', wsl)).toBe('/mnt/d/Training');
    expect(normalizeHostPathInput('D:\\Training', { wsl: false, automountRoot: '/mnt/' })).toBe('D:\\Training');
  });
});

describe('readWslAutomountRoot', () => {
  it('defaults to /mnt/', () => {
    expect(readWslAutomountRoot('')).toBe('/mnt/');
    expect(readWslAutomountRoot('[network]\nroot = /nope/\n')).toBe('/mnt/');
  });

  it('reads [automount] root', () => {
    expect(readWslAutomountRoot('[automount]\nenabled = true\nroot = /win\n')).toBe('/win/');
    expect(readWslAutomountRoot('[automount]\nroot="/drives/"\n')).toBe('/drives/');
  });
});

describe('resolveReadonlyMounts', () => {
  let tempDir: string;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'ic-ro-mounts-')));
    fakeHome = join(tempDir, 'ironcurtain-home');
    mkdirSync(fakeHome);
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = fakeHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function dir(...parts: string[]): string {
    const path = join(tempDir, ...parts);
    mkdirSync(path, { recursive: true });
    return path;
  }

  it('canonicalizes paths and assigns /mnt/ro targets', () => {
    const training = dir('data', 'Training');
    const result = resolveReadonlyMounts([training]);
    expect(result.mounts).toEqual([{ hostPath: training, containerPath: '/mnt/ro/Training' }]);
    expect(result.warnings).toEqual([]);
  });

  it('follows symlinks to the canonical directory', () => {
    const target = dir('real');
    const link = join(tempDir, 'link');
    symlinkSync(target, link);
    expect(resolveReadonlyMounts([link]).mounts[0].hostPath).toBe(target);
  });

  it('deduplicates paths and disambiguates colliding basenames', () => {
    const a = dir('a', 'data');
    const b = dir('b', 'data');
    const c = dir('c', 'my data!');
    const result = resolveReadonlyMounts([a, a, b, c]);
    expect(result.mounts.map((m) => m.containerPath)).toEqual(['/mnt/ro/data', '/mnt/ro/data-2', '/mnt/ro/my_data_']);
  });

  it('rejects missing paths, files, and empty input', () => {
    expect(() => resolveReadonlyMounts([join(tempDir, 'missing')])).toThrow(/does not exist/);
    expect(() => resolveReadonlyMounts([''])).toThrow(/empty/);
    expect(() => resolveReadonlyMounts(['/tmp/x\ny'])).toThrow(/control characters/);
  });

  it('rejects root and the home directory', () => {
    expect(() => resolveReadonlyMounts(['/'])).toThrow(/root directory/);
    expect(() => resolveReadonlyMounts([homedir()])).toThrow(/home directory/);
  });

  it('rejects the IronCurtain home, anything inside it, and any parent of it', () => {
    expect(() => resolveReadonlyMounts([fakeHome])).toThrow(/IronCurtain credentials or state/);
    const inside = join(fakeHome, 'sessions');
    mkdirSync(inside);
    expect(() => resolveReadonlyMounts([inside])).toThrow(/IronCurtain credentials or state/);
    expect(() => resolveReadonlyMounts([tempDir])).toThrow(/IronCurtain credentials or state/);
  });

  it('rejects agent credential directories', () => {
    expect(() => resolveReadonlyMounts([join(homedir(), '.claude')])).toThrow();
  });

  it('rejects socket-bearing system directories', () => {
    // The fake IronCurtain home lives in the OS temp dir, which may sit under
    // the path being tested (/tmp on Linux, /var/folders on macOS). Then the
    // credentials guard rejects first -- still refused, different reason.
    const expectRejected = (path: string, reason: RegExp): void => {
      const homeInside = realpathSync(fakeHome).startsWith(`${realpathSync(path)}/`);
      expect(() => resolveReadonlyMounts([path])).toThrow(homeInside ? /IronCurtain credentials or state/ : reason);
    };
    // These exist on both Linux and macOS (/proc and /run are Linux-only).
    expectRejected('/dev', /system directory/);
    expectRejected('/var', /system directory/);
    expectRejected('/tmp', /host sockets/);
    expectRejected('/var/tmp', /host sockets/);
  });

  it('allows mounting the current directory or its parent when no .env exists there', () => {
    const data = dir('data');
    const sub = dir('data', 'sub');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(sub);
    try {
      expect(resolveReadonlyMounts([data, sub]).mounts.map((m) => m.hostPath)).toEqual([data, sub]);
      writeFileSync(join(sub, '.env'), 'ANTHROPIC_API_KEY=x\n');
      expect(() => resolveReadonlyMounts([data])).toThrow(/IronCurtain credentials or state/);
    } finally {
      cwd.mockRestore();
    }
  });

  it('rejects well-known socket directories inside /tmp but allows other /tmp data', () => {
    const socketDir = `/tmp/ssh-ic-ro-test-${process.pid}`;
    mkdirSync(join(socketDir, 'inner'), { recursive: true });
    try {
      expect(() => resolveReadonlyMounts([socketDir])).toThrow(/holds host sockets/);
      expect(() => resolveReadonlyMounts([join(socketDir, 'inner')])).toThrow(/holds host sockets/);
    } finally {
      rmSync(socketDir, { recursive: true, force: true });
    }
    expect(() => resolveReadonlyMounts([dir('dataset')])).not.toThrow();
  });

  // DrvFS keeps the typed letter case, so only identity comparison catches
  // `/mnt/c/WINDOWS` aliasing a `/mnt/c/Windows` guard. Runs only under WSL.
  it.skipIf(!existsSync('/mnt/c/Windows'))('rejects case-variant aliases of a guard on case-insensitive DrvFS', () => {
    process.env.IRONCURTAIN_HOME = '/mnt/c/Windows';
    expect(() => resolveReadonlyMounts(['/mnt/c/WINDOWS'])).toThrow(/IronCurtain credentials or state/);
    expect(() => resolveReadonlyMounts(['/mnt/c'])).toThrow(/IronCurtain credentials or state/);
  });

  it('enforces the mount count limit', () => {
    const paths = Array.from({ length: MAX_READONLY_MOUNTS + 1 }, (_, i) => dir(`m${i}`));
    expect(() => resolveReadonlyMounts(paths)).toThrow(/At most/);
  });
});

describe('restoreReadonlyMounts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'ic-ro-restore-')));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function mkdir(name: string): string {
    const path = join(tempDir, name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  describe('adding folders on resume', () => {
    it('keeps saved container paths and gives additions non-colliding ones', () => {
      const saved = mkdir('a/data');
      const added = mkdir('b/data');
      const result = restoreReadonlyMounts([{ hostPath: saved, containerPath: '/mnt/ro/data' }], [added]);
      expect(result.mounts).toEqual([
        { hostPath: saved, containerPath: '/mnt/ro/data' },
        { hostPath: added, containerPath: '/mnt/ro/data-2' },
      ]);
      expect(result.persist).toEqual(result.mounts);
      expect(result.added).toEqual([{ hostPath: added, containerPath: '/mnt/ro/data-2' }]);
    });

    it('avoids the container path of a saved folder that is currently missing, and keeps it saved', () => {
      const gone = join(tempDir, 'gone');
      const added = mkdir('other/gone');
      const result = restoreReadonlyMounts([{ hostPath: gone, containerPath: '/mnt/ro/gone' }], [added]);
      expect(result.mounts).toEqual([{ hostPath: added, containerPath: '/mnt/ro/gone-2' }]);
      expect(result.persist).toEqual([
        { hostPath: gone, containerPath: '/mnt/ro/gone' },
        { hostPath: added, containerPath: '/mnt/ro/gone-2' },
      ]);
      expect(result.warnings[0]).toMatch(/no longer available/);
    });

    it('skips folders the session already mounts and reports no change', () => {
      const saved = mkdir('data');
      const result = restoreReadonlyMounts([{ hostPath: saved, containerPath: '/mnt/ro/data' }], [`${saved}/`]);
      expect(result.mounts).toEqual([{ hostPath: saved, containerPath: '/mnt/ro/data' }]);
      expect(result.persist).toBeUndefined();
      expect(result.added).toEqual([]);
    });

    it('skips re-adding a saved folder that is currently missing instead of failing', () => {
      const gone = join(tempDir, 'unplugged');
      const extra = mkdir('extra');
      const result = restoreReadonlyMounts([{ hostPath: gone, containerPath: '/mnt/ro/unplugged' }], [gone, extra]);
      expect(result.added).toEqual([{ hostPath: extra, containerPath: '/mnt/ro/extra' }]);
      expect(result.mounts).toEqual([{ hostPath: extra, containerPath: '/mnt/ro/extra' }]);
      expect(result.warnings[0]).toMatch(/no longer available/);
    });

    it('adds a folder given twice only once', () => {
      const extra = mkdir('extra');
      const result = restoreReadonlyMounts(undefined, [extra, `${extra}/`]);
      expect(result.added).toEqual([{ hostPath: extra, containerPath: '/mnt/ro/extra' }]);
    });

    it('counts saved folders, including missing ones, toward the limit', () => {
      const saved = Array.from({ length: MAX_READONLY_MOUNTS }, (_, i) => ({
        hostPath: join(tempDir, `missing-${i}`),
        containerPath: `/mnt/ro/missing-${i}`,
      }));
      expect(() => restoreReadonlyMounts(saved, [mkdir('extra')])).toThrow(/session has 8, adding 1/);
    });

    it('rejects an unsafe addition', () => {
      expect(() => restoreReadonlyMounts(undefined, ['/dev'])).toThrow(/system directory/);
    });
  });

  it('returns nothing when no mounts were persisted', () => {
    expect(restoreReadonlyMounts(undefined)).toEqual({ mounts: [], warnings: [], added: [] });
  });

  it('keeps existing mounts with their original container path', () => {
    const data = join(tempDir, 'data');
    mkdirSync(data);
    const result = restoreReadonlyMounts([{ hostPath: data, containerPath: '/mnt/ro/data-2' }]);
    expect(result.mounts).toEqual([{ hostPath: data, containerPath: '/mnt/ro/data-2' }]);
  });

  it('drops a vanished directory with a warning', () => {
    const result = restoreReadonlyMounts([{ hostPath: join(tempDir, 'gone'), containerPath: '/mnt/ro/gone' }]);
    expect(result.mounts).toEqual([]);
    expect(result.warnings[0]).toMatch(/no longer available/);
  });

  it('rejects malformed records', () => {
    expect(() => restoreReadonlyMounts('nope')).toThrow(/malformed/);
    expect(() => restoreReadonlyMounts([{ hostPath: tempDir, containerPath: '/etc' }])).toThrow(/malformed/);
    expect(() => restoreReadonlyMounts([{ hostPath: 'relative', containerPath: '/mnt/ro/x' }])).toThrow(/malformed/);
    expect(() => restoreReadonlyMounts([{ hostPath: tempDir, containerPath: '/mnt/ro/..' }])).toThrow(/malformed/);
    expect(() => restoreReadonlyMounts([{ hostPath: tempDir, containerPath: '/mnt/ro/.' }])).toThrow(/malformed/);
  });

  it('rejects a persisted path that is now unsafe', () => {
    expect(() => restoreReadonlyMounts([{ hostPath: '/dev', containerPath: '/mnt/ro/dev' }])).toThrow(
      /system directory/,
    );
  });
});

describe('container wiring helpers', () => {
  const specs = [{ hostPath: '/mnt/d/Training', containerPath: '/mnt/ro/Training' }];

  it('builds read-only Docker mounts', () => {
    expect(buildReadonlyMounts(specs)).toEqual([
      { source: '/mnt/d/Training', target: '/mnt/ro/Training', readonly: true },
    ]);
    expect(buildReadonlyMounts(undefined)).toEqual([]);
  });

  it('detects overlap with the workspace in either direction', () => {
    expect(readonlyMountsOverlapWorkspace(specs, '/mnt/d/Training/proj')).toBe(true);
    expect(readonlyMountsOverlapWorkspace(specs, '/mnt/d')).toBe(true);
    expect(readonlyMountsOverlapWorkspace(specs, '/home/me/proj')).toBe(false);
  });

  it('formats the agent prompt section', () => {
    expect(formatReadonlyMountsPrompt([], [])).toBeUndefined();
    const prompt = formatReadonlyMountsPrompt(specs, ['gone']);
    expect(prompt).toContain('`/mnt/ro/Training` (host: `/mnt/d/Training`)');
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('Note: gone');
  });
});
