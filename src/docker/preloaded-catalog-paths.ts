/**
 * Canonical filesystem locations for preloaded image catalogs.
 *
 * Two distinct roles, deliberately separated:
 *
 * - The **frozen record** lives in the package's `config/docker-workload/`
 *   directory and is committed for review/evidence (immutable IDs, digests,
 *   provenance). It is NOT read at runtime: it sits inside the repository,
 *   which for a nested Docker workload is the untrusted checkout.
 * - The **runtime staging** copy lives under the trusted host home
 *   (`$IRONCURTAIN_HOME`, default `~/.ironcurtain`). The sealed `.tar`
 *   archives are staged next to the catalog JSON there, because
 *   `resolvePreloadedImage()` resolves each archive relative to its catalog's
 *   own directory. This is the path an `ImageProvisioning.catalogPath` points
 *   at.
 *
 * All callers must import these helpers instead of hardcoding the file names,
 * so the two locations can never drift apart.
 */

import { resolve } from 'node:path';
import { getIronCurtainHome } from '../config/paths.js';
import type { ContainerRuntimeKind } from './container-runtime.js';
import { getFrozenDockerWorkloadDir } from './docker-workload-paths.js';

/** Basename of a backend-bound catalog file, e.g. `preloaded-catalog.docker.json`. */
export function preloadedCatalogFileName(runtimeKind: ContainerRuntimeKind): string {
  return `preloaded-catalog.${runtimeKind}.json`;
}

/** Committed frozen-record directory (`<package>/config/docker-workload`). */
export function getFrozenCatalogDir(): string {
  return getFrozenDockerWorkloadDir();
}

/** Path of the committed frozen catalog record for a backend. */
export function getFrozenCatalogPath(runtimeKind: ContainerRuntimeKind): string {
  return resolve(getFrozenCatalogDir(), preloadedCatalogFileName(runtimeKind));
}

/**
 * Trusted, private (mode 0700) staging directory that holds the sealed archives
 * plus the runtime-resolvable catalog JSON. Lives outside any workspace.
 */
export function getPreloadedCatalogStagingDir(): string {
  return resolve(getIronCurtainHome(), 'docker-workload', 'preloaded-catalog');
}

/** Runtime catalog path a session's `ImageProvisioning.catalogPath` points at. */
export function getStagedCatalogPath(runtimeKind: ContainerRuntimeKind): string {
  return resolve(getPreloadedCatalogStagingDir(), preloadedCatalogFileName(runtimeKind));
}
