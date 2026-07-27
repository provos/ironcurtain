/**
 * Canonical filesystem locations of the committed frozen Docker-workload
 * artifacts (`<package>/config/docker-workload/`).
 *
 * These files are *reviewed records*, not runtime state: manifests that pin
 * reviewed egress origins and hash-bind the checked-in Dockerfiles. Every
 * consumer must import a helper from here instead of re-deriving the package
 * root inline, so the frozen locations can never drift apart and no caller can
 * be pointed at an unreviewed manifest by passing a different path.
 *
 * Runtime *staging* copies (which live under `$IRONCURTAIN_HOME`) are a
 * separate concern owned by `./preloaded-catalog-paths.ts`.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Root of this IronCurtain package. Resolves identically from `src/docker/`
 * under tsx and from `dist/docker/` in a build, since both are two levels
 * below the package root.
 */
export function getIronCurtainPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Committed frozen-record directory (`<package>/config/docker-workload`). */
export function getFrozenDockerWorkloadDir(): string {
  return resolve(getIronCurtainPackageRoot(), 'config', 'docker-workload');
}

/** Frozen narrow build-egress manifest (hash-binds the current Dockerfiles). */
export function getFrozenBuildEgressManifestPath(): string {
  return resolve(getFrozenDockerWorkloadDir(), 'build-egress-manifest.json');
}

/** Frozen anonymous workload-image registry-egress manifest. */
export function getFrozenRegistryEgressManifestPath(): string {
  return resolve(getFrozenDockerWorkloadDir(), 'registry-egress-manifest.json');
}
