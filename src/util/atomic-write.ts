/**
 * Atomic file-write primitive shared across layers.
 *
 * A neutral leaf with no domain imports, so both offline pipeline tooling
 * (`src/pipeline/`) and live-layer modules (`src/persona/`, etc.) can use it
 * without a layering violation. JSON callers wrap this with their own
 * `JSON.stringify` + trailing-newline convention (which differs per consumer),
 * so only the raw-text primitive lives here.
 */

import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Atomically writes raw text using write-to-temp-then-rename.
 *
 * `renameSync` is atomic on POSIX filesystems, so a concurrent reader either
 * sees the complete old file or the complete new file — never a torn write.
 * The parent directory is created if missing.
 */
export function atomicWriteTextSync(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, text);
  renameSync(tmpPath, filePath);
}
