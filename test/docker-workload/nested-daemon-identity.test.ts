import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stageNestedDaemonIdentity } from '../../src/docker-workload/nested-daemon-identity.js';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'daemon-identity-')));
  directories.push(path);
  return path;
}

describe('nested daemon identity staging', () => {
  it('stages exact non-1000 identity files individually read-only below a private host parent', () => {
    const path = directory();
    const mounts = stageNestedDaemonIdentity(path, { uid: 1101, gid: 1102 });
    expect(mounts.map(({ target, readonly }) => ({ target, readonly }))).toEqual(
      ['passwd', 'group', 'subuid', 'subgid'].map((name) => ({ target: `/etc/${name}`, readonly: true })),
    );
    expect(readFileSync(join(path, 'passwd'), 'utf8')).toContain(
      'rootless:x:1101:1102:rootless:/home/rootless:/bin/sh',
    );
    for (const mount of mounts) expect(lstatSync(mount.source).mode & 0o777).toBe(0o444);
    expect(lstatSync(path).mode & 0o777).toBe(0o700);
    expect(stageNestedDaemonIdentity(path, { uid: 1101, gid: 1102 })).toEqual(mounts);
  });

  it('keeps each parent identity out of its subordinate range', () => {
    const path = directory();
    stageNestedDaemonIdentity(path, { uid: 100001, gid: 100002 });
    expect(readFileSync(join(path, 'subuid'), 'utf8')).toBe('rootless:200000:65536\n');
    expect(readFileSync(join(path, 'subgid'), 'utf8')).toBe('rootless:200000:65536\n');
  });

  it.each([0, -1, 1.5, 2_147_483_648, Number.NaN])('rejects unsupported rootless identity %s', (uid) => {
    expect(() => stageNestedDaemonIdentity(directory(), { uid, gid: 1102 })).toThrow(/non-root positive/);
  });

  it('rejects changed identity files and symlink substitutions without overwriting them', () => {
    const path = directory();
    stageNestedDaemonIdentity(path, { uid: 1101, gid: 1102 });
    expect(() => stageNestedDaemonIdentity(path, { uid: 1103, gid: 1102 })).toThrow(/identity file changed/);
    const original = readFileSync(join(path, 'passwd'), 'utf8');
    const other = join(directory(), 'other-passwd');
    writeFileSync(other, original, { mode: 0o444 });
    rmSync(join(path, 'passwd'));
    symlinkSync(other, join(path, 'passwd'));
    expect(() => stageNestedDaemonIdentity(path, { uid: 1101, gid: 1102 })).toThrow(/non-symlink/);
    expect(readFileSync(other, 'utf8')).toBe(original);
  });

  it('rejects a group-readable configuration parent', () => {
    const path = directory();
    chmodSync(path, 0o750);
    expect(() => stageNestedDaemonIdentity(path, { uid: 1101, gid: 1102 })).toThrow(/owner-only directory/);
  });
});
