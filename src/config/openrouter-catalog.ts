/**
 * OpenRouter model-catalog resolver.
 *
 * Resolves the set of valid OpenRouter model slugs from the PUBLIC
 * `GET /api/v1/models` endpoint, with a bundled floor for offline degradation.
 * The result carries a `source` that drives client-side validation strictness:
 * an authoritative (`live` / `cache`) list hard-blocks unknown slugs, while the
 * known-incomplete `bundled` floor only warns (see `catalogEnforces`).
 *
 * This module NEVER throws — every failure path degrades to a usable result.
 *
 * Layering: this is the FIRST network I/O in `src/config/`. It is acceptable
 * because this leaf is imported only by the config editor (`config-command.ts`)
 * and the daemon dispatch (`config-dispatch.ts`) — NOT on `loadConfig()`'s path.
 * Keep it that way: nothing on the config-load path may import this.
 */

import { OPENROUTER_API_V1 } from './user-config.js';
import { OPENROUTER_FALLBACK_SLUGS } from './openrouter-models-fallback.js';

export type ModelCatalogSource = 'live' | 'cache' | 'bundled';

export interface ModelCatalogResult {
  /** Sorted, de-duped OpenRouter slugs (the `.id` of each `/models` entry). */
  readonly models: readonly string[];
  readonly source: ModelCatalogSource;
  /** Epoch ms of the underlying fetch; 0 for the pure-bundled floor. */
  readonly fetchedAt: number;
}

/** The public `/models` endpoint. No key is ever sent — it needs none. */
const MODELS_ENDPOINT = `${OPENROUTER_API_V1}/models`;

/** In-memory catalog TTL (6h). Model lists change rarely. */
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

/** Single-attempt fetch budget. A hung network must not stall the editor. */
const FETCH_TIMEOUT_MS = 4000;

/** Cache singleton — only ever holds a real (live-origin) result. */
interface CacheEntry {
  readonly result: ModelCatalogResult;
  readonly expiresAt: number;
}
let cache: CacheEntry | undefined;

/**
 * The rule-table predicate: true when this source is authoritative and thus
 * blocks unknown slugs; false for the known-incomplete `bundled` floor.
 *
 * The web UI mirrors this as `sourceEnforces` in
 * `packages/web-ui/src/routes/settings-helpers.ts` — it cannot import this module
 * across the package boundary, so keep the two one-liners in sync.
 */
export function catalogEnforces(source: ModelCatalogSource): boolean {
  return source !== 'bundled';
}

/** Test-only: clear the module cache so each case starts isolated. */
export function __resetCatalogCacheForTests(): void {
  cache = undefined;
}

/**
 * Resolves the OpenRouter model catalog. NEVER throws — always degrades:
 *   fetch ok             -> { source: 'live' }   (and populates the cache)
 *   within TTL           -> { source: 'cache' }
 *   fetch fails, prior   -> { source: 'cache' }  (serve the stale-but-real list)
 *   fetch fails, no prior-> { source: 'bundled' }
 * `forceRefresh: true` bypasses the TTL.
 */
export async function listOpenrouterModels(opts?: { forceRefresh?: boolean }): Promise<ModelCatalogResult> {
  const now = Date.now();

  if (!opts?.forceRefresh && cache !== undefined && now < cache.expiresAt) {
    return { ...cache.result, source: 'cache' };
  }

  const models = await fetchModelSlugs();
  if (models !== undefined) {
    const result: ModelCatalogResult = { models, source: 'live', fetchedAt: now };
    cache = { result, expiresAt: now + CATALOG_TTL_MS };
    return result;
  }

  // Fetch failed. A prior real result still enforces (it was live once); tag it
  // `cache` while preserving its original fetch time.
  if (cache !== undefined) {
    return { ...cache.result, source: 'cache' };
  }

  return { models: OPENROUTER_FALLBACK_SLUGS, source: 'bundled', fetchedAt: 0 };
}

/**
 * Single public GET with a hard timeout. Returns the parsed slug list, or
 * `undefined` on any failure (non-2xx, malformed body, empty data, thrown/abort).
 * No `Authorization` header — the endpoint is public and a key must never leak.
 */
async function fetchModelSlugs(): Promise<readonly string[] | undefined> {
  try {
    const res = await fetch(MODELS_ENDPOINT, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    return parseModelSlugs(body);
  } catch {
    return undefined;
  }
}

/**
 * Defensive parse of the `{ data: [{ id }] }` envelope. Keeps only string `.id`s,
 * sorts + de-dupes. Non-object / non-array-`data` / empty-after-filter -> failure.
 */
function parseModelSlugs(body: unknown): readonly string[] | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;

  const ids: string[] = [];
  for (const entry of data) {
    const id = extractId(entry);
    if (id !== undefined) ids.push(id);
  }
  if (ids.length === 0) return undefined;
  return Array.from(new Set(ids)).sort();
}

/** Extracts a string `.id` from one catalog entry, or `undefined`. */
function extractId(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const id = (entry as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}
