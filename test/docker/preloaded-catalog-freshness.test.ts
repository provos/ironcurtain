/**
 * Binds the committed catalogs to the real build inputs on disk.
 *
 * The repository has twice shipped a frozen artifact that had silently diverged
 * from the source it claims to describe, because every test loaded a fixture
 * instead of the artifact. Loading and validating the committed catalog alone
 * does not close this gap: its metadata stays internally self-consistent when a
 * Dockerfile changes underneath it.
 *
 * This explicit qualification check recomputes from the source tree and
 * compares against the committed JSON. A red check means the qualification
 * fixture needs regeneration (`npm run qualify:catalog --`) — never that a
 * production session should be denied or an operator should refreeze before
 * starting IronCurtain. The ordinary test suite skips this source-freshness
 * gate; run `npm run qualify:catalog:check` when qualifying a catalog snapshot.
 *
 * Agent-role build hashes are deliberately out of scope: `hashKind: 'agent'`
 * derives from the live built image, not from the source tree.
 */

import { describe, expect, it } from 'vitest';
import {
  catalogImageSources,
  computeContentBuildHash,
  dockerfileSourceDigest,
  hostCatalogArchitecture,
} from '../../src/docker/preloaded-catalog-sources.js';
import { getFrozenCatalogPath } from '../../src/docker/preloaded-catalog-paths.js';
import {
  loadPreloadedImageCatalog,
  type PreloadedImageCatalogEntry,
} from '../../src/docker/preloaded-image-catalog.js';
import type { ContainerRuntimeKind } from '../../src/docker/container-runtime.js';

const RUNTIME_KINDS: readonly ContainerRuntimeKind[] = ['docker', 'apple-container'];

/** Loads through the real verifier, so a malformed committed catalog fails here too. */
function loadCatalog(kind: ContainerRuntimeKind): readonly PreloadedImageCatalogEntry[] {
  return loadPreloadedImageCatalog(getFrozenCatalogPath(kind)).catalog.images;
}

/**
 * `catalogImageSources()` picks the base Dockerfile by HOST architecture
 * (`Dockerfile.base.arm64` only on arm64), so recomputing an arm64 catalog's
 * hashes on an amd64 runner would compare two different files and report a
 * drift that is not there. Skip instead of crying wolf.
 */
const architectureMatches = (): boolean =>
  RUNTIME_KINDS.every((kind) => loadCatalog(kind).every((entry) => entry.architecture === hostCatalogArchitecture()));

const qualificationRequested = process.env.IRONCURTAIN_QUALIFY_CATALOG === '1';

describe.skipIf(!qualificationRequested || !architectureMatches())(
  'qualification-only preloaded catalogs match the source tree',
  () => {
    for (const kind of RUNTIME_KINDS) {
      describe(kind, () => {
        it('records the current content build hash for every content-hashed role', () => {
          const entries = loadCatalog(kind);
          const drifted = catalogImageSources()
            .filter((source) => source.hashKind === 'content')
            .flatMap((source) => {
              const entry = entries.find((candidate) => candidate.logicalName === source.logicalName);
              if (entry === undefined) return [`${source.role}: absent from the committed ${kind} catalog`];
              const actual = computeContentBuildHash(source.dockerfile, source.contextDir);
              return actual === entry.buildHash
                ? []
                : [`${source.role}: frozen ${entry.buildHash.slice(0, 16)} != on-disk ${actual.slice(0, 16)}`];
            });

          expect(drifted, `regenerate the ${kind} qualification catalog (npm run qualify:catalog --)`).toEqual([]);
        });

        it('records the current Dockerfile provenance digest for every role', () => {
          const entries = loadCatalog(kind);
          const drifted = catalogImageSources().flatMap((source) => {
            const entry = entries.find((candidate) => candidate.logicalName === source.logicalName);
            if (entry === undefined) return [`${source.role}: absent from the committed ${kind} catalog`];
            const actual = dockerfileSourceDigest(source.dockerfile);
            return actual === entry.provenance.sourceDigest
              ? []
              : [
                  `${source.role}: frozen ${entry.provenance.sourceDigest.slice(7, 23)} != on-disk ${actual.slice(7, 23)}`,
                ];
          });

          expect(drifted, `regenerate the ${kind} qualification catalog (npm run qualify:catalog --)`).toEqual([]);
        });

        it('records the declared toolchain tuple for every role', () => {
          // The tuple is hand-maintained qualification provenance. A stale
          // declaration would survive regeneration and misdescribe the fixture.
          const entries = loadCatalog(kind);
          const drifted = catalogImageSources().flatMap((source) => {
            const entry = entries.find((candidate) => candidate.logicalName === source.logicalName);
            if (entry === undefined) return [`${source.role}: absent from the committed ${kind} catalog`];
            // The catalog stores every field, nulls included, so compare the whole
            // tuple with a stable key order rather than dropping absent entries.
            const canonical = (tuple: Record<string, string | null>): string =>
              JSON.stringify(Object.fromEntries(Object.entries(tuple).sort(([a], [b]) => a.localeCompare(b))));
            return canonical(source.toolchain) === canonical(entry.toolchain)
              ? []
              : [`${source.role}: declared ${canonical(source.toolchain)} != frozen ${canonical(entry.toolchain)}`];
          });

          expect(drifted, `regenerate the ${kind} qualification catalog (npm run qualify:catalog --)`).toEqual([]);
        });
      });
    }
  },
);
