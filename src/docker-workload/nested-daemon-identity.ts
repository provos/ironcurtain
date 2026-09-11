/** Host-owned identity inputs for the existing rootless daemon sidecar. */
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertCanonicalHostPath, readHardenedFile } from '../hardened-fs.js';
import type { DockerMount } from '../docker/types.js';

export interface NestedDaemonIdentity {
  readonly uid: number;
  readonly gid: number;
}

export function assertNestedDaemonIdentity(identity: NestedDaemonIdentity): void {
  for (const id of [identity.uid, identity.gid]) {
    if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) {
      throw new Error('nested daemon requires a non-root positive UID/GID');
    }
  }
}

/** The private parent is never mounted; only individual immutable leaves are. */
export function prepareNestedDaemonHostConfigDirectory(directory: string): void {
  assertCanonicalHostPath(directory, 'nested daemon host configuration directory');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700 ||
    stats.uid !== process.getuid?.() ||
    realpathSync(directory) !== directory
  ) {
    throw new Error('nested daemon host configuration must be a canonical owner-only directory');
  }
}

export function stageNestedDaemonIdentity(directory: string, identity: NestedDaemonIdentity): readonly DockerMount[] {
  assertNestedDaemonIdentity(identity);
  prepareNestedDaemonHostConfigDirectory(directory);
  // Avoid overlapping the real UID/GID with its subordinate range. These IDs
  // exist inside the outer container; no host subordinate-ID file is changed.
  const subordinateBase = (id: number): number => (id >= 100_000 && id < 165_536 ? 200_000 : 100_000);
  const files = {
    passwd: `root:x:0:0:root:/root:/bin/sh\nrootless:x:${identity.uid}:${identity.gid}:rootless:/home/rootless:/bin/sh\n`,
    group: `root:x:0:\nrootless:x:${identity.gid}:\n`,
    subuid: `rootless:${subordinateBase(identity.uid)}:65536\n`,
    subgid: `rootless:${subordinateBase(identity.gid)}:65536\n`,
  };
  return Object.entries(files).map(([name, content]) => {
    const source = join(directory, name);
    try {
      writeFileSync(source, content, { flag: 'wx', mode: 0o444 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = readHardenedFile(source, { label: `nested daemon ${name}`, minBytes: 1, maxBytes: 4096 });
      if (!existing.equals(Buffer.from(content)) || (lstatSync(source).mode & 0o777) !== 0o444) {
        throw new Error(`nested daemon identity file changed: ${name}`, { cause: error });
      }
    }
    return { source, target: `/etc/${name}`, readonly: true };
  });
}
