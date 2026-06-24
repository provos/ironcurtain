/**
 * Atomic file-write primitive shared across layers.
 *
 * A neutral leaf with no domain imports, so both offline pipeline tooling
 * (`src/pipeline/`) and live-layer modules (`src/persona/`, etc.) can use it
 * without a layering violation. The raw-text primitive lives here; pipeline
 * artifacts append their own trailing newline on top of it.
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

/**
 * Atomically writes a pretty-printed JSON value (NO trailing newline) via
 * {@link atomicWriteTextSync} (which also creates the parent dir). The
 * no-newline layout matches the historical `persona.json` on-disk convention,
 * so persona-service can use a leaf primitive instead of importing from the
 * escalation domain module. Consumers needing a trailing newline (e.g. pipeline
 * artifacts) append it themselves.
 */
export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  atomicWriteTextSync(filePath, JSON.stringify(data, null, 2));
}
