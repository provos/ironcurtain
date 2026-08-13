/** Monotonic generation selection for the operator catalog-freeze command. */

import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ContainerRuntimeKind } from './container-runtime.js';
import { loadPreloadedImageCatalog } from './preloaded-image-catalog.js';

export type CatalogArchitecture = 'amd64' | 'arm64';

export interface CatalogGenerationRecord {
  readonly path: string;
  readonly runtimeKind: ContainerRuntimeKind;
  readonly generation: string;
  readonly architectures: readonly CatalogArchitecture[];
}

export interface CatalogGenerationInput {
  readonly path: string;
  readonly runtimeKind: ContainerRuntimeKind;
}

interface ParsedGeneration {
  readonly architecture: CatalogArchitecture;
  readonly version: number;
}

const GENERATION_PATTERN = /^ironcurtain-preloaded-(amd64|arm64)-v([1-9][0-9]*)$/u;

/**
 * Load every present operational/frozen catalog through the real hardened
 * parser. A present malformed catalog is a blocker; it is never ignored when
 * choosing a supposedly newer generation.
 */
export function loadCatalogGenerationRecords(inputs: readonly CatalogGenerationInput[]): CatalogGenerationRecord[] {
  return inputs.flatMap((input) => {
    if (!existsSync(input.path)) return [];
    const loaded = loadPreloadedImageCatalog(input.path);
    if (loaded.catalog.runtimeKind !== input.runtimeKind) {
      throw new Error(
        `preloaded catalog generation input has wrong runtime kind at ${input.path}: ` +
          `expected ${input.runtimeKind}, got ${loaded.catalog.runtimeKind}`,
      );
    }
    return [
      {
        path: input.path,
        runtimeKind: input.runtimeKind,
        generation: loaded.catalog.generation,
        architectures: [...new Set(loaded.catalog.images.map((entry) => entry.architecture))],
      },
    ];
  });
}

/**
 * Resolve a canonical generation that cannot reuse or regress any present
 * staged/frozen generation for this host architecture.
 */
export function resolvePreloadedCatalogGeneration(options: {
  readonly architecture: CatalogArchitecture;
  readonly requestedGeneration?: string;
  readonly catalogs: readonly CatalogGenerationRecord[];
}): string {
  let maximum = 0;
  for (const catalog of options.catalogs) {
    const parsed = parseGeneration(catalog.generation, `catalog ${catalog.path}`);
    if (
      catalog.architectures.length !== 1 ||
      catalog.architectures[0] !== parsed.architecture ||
      parsed.architecture !== options.architecture
    ) {
      throw new Error(
        `preloaded catalog generation architecture mismatch at ${catalog.path}: ` +
          `generation=${parsed.architecture}, images=${catalog.architectures.join(',') || '(none)'}, ` +
          `host=${options.architecture}`,
      );
    }
    if (parsed.version > maximum) maximum = parsed.version;
  }

  if (options.requestedGeneration !== undefined) {
    const requested = parseGeneration(options.requestedGeneration, 'requested generation');
    if (requested.architecture !== options.architecture) {
      throw new Error(
        `requested preloaded catalog generation targets ${requested.architecture}, not ${options.architecture}`,
      );
    }
    if (requested.version <= maximum) {
      throw new Error(
        `requested preloaded catalog generation must be newer than every present generation (max v${maximum})`,
      );
    }
    return options.requestedGeneration;
  }

  if (maximum === Number.MAX_SAFE_INTEGER) {
    throw new Error('cannot derive a newer preloaded catalog generation: version space is exhausted');
  }
  return `ironcurtain-preloaded-${options.architecture}-v${maximum + 1}`;
}

function parseGeneration(value: string, label: string): ParsedGeneration {
  const match = GENERATION_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`${label} is not canonical; expected ironcurtain-preloaded-<amd64|arm64>-v<positive-integer>`);
  }
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`${label} version must be a positive safe integer`);
  }
  return { architecture: match[1] as CatalogArchitecture, version };
}

/**
 * One stable lock per host user and canonical `/tmp`, independent of cwd,
 * repository checkout, TMPDIR, and IRONCURTAIN_HOME. The mutable Docker image
 * tags used during a freeze are daemon-global, so a per-staging-root lock is
 * insufficient.
 */
export function getPreloadedCatalogBuildLockPath(): string {
  if (process.getuid === undefined) throw new Error('preloaded catalog build lock requires a POSIX user identity');
  return join(realpathSync('/tmp'), `.ironcurtain-build-preloaded-catalog-${process.getuid()}.lock`);
}
