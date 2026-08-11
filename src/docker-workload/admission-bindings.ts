/**
 * Resolve the operational attestation bindings one Docker-workload admission
 * records on its lease (§8.2 step 1).
 *
 * `DockerWorkloadAdmissionBindings` binds OPERATIONAL inputs — the artifacts
 * that decide what a session actually runs — not release provenance. Each field
 * is therefore recomputed here from the bytes the session will really use
 * (the staged catalog it resolves its image from, the frozen profile ceiling it
 * is held to), rather than copied out of a frozen record that merely claims
 * them. A missing or malformed artifact fails admission closed.
 *
 * Every field is a real operational hash. If a future binding cannot be
 * sourced from an input the session actually uses, it must not be added here.
 */

import { getFrozenProfileCeilingPath } from '../docker/docker-workload-paths.js';
import { loadPreloadedImageCatalog } from '../docker/preloaded-image-catalog.js';
import { readHardenedFile } from '../hardened-fs.js';
import { sha256Hex } from '../hash.js';
import type { DockerWorkloadAdmissionBindings } from './infrastructure.js';

/**
 * Catalog role whose toolchain digest the admission binds. The nested daemon
 * toolchain (dockerd/rootlesskit/containerd/runc) is staged by the base image
 * and every agent image is built `FROM` it, so the base role's digest is the
 * one that describes the daemon the session can actually start. Admission
 * resolves this value directly from the same catalog entry used to select the
 * image, so the recorded toolchain identity cannot drift from image selection.
 */
const BASE_IMAGE_LOGICAL_NAME = 'ironcurtain-base:latest';

/** Generous ceiling; the frozen profile ceiling is a few kilobytes of JSON. */
const MAX_PROFILE_CEILING_BYTES = 1024 * 1024;

export interface ResolveAdmissionBindingsOptions {
  /** Staged catalog the session resolves its agent image from. */
  readonly catalogPath: string;
}

/** Read the real operational inputs and assemble the admission bindings. */
export function resolveDockerWorkloadAdmissionBindings(
  options: ResolveAdmissionBindingsOptions,
): DockerWorkloadAdmissionBindings {
  const catalog = loadPreloadedImageCatalog(options.catalogPath);
  const base = catalog.catalog.images.find((image) => image.logicalName === BASE_IMAGE_LOGICAL_NAME);
  if (base === undefined) {
    throw new Error(
      `Docker-workload admission catalog is missing the ${BASE_IMAGE_LOGICAL_NAME} role: ${options.catalogPath}`,
    );
  }
  return {
    catalogSha256: catalog.sha256,
    toolchainDigest: base.toolchainDigest,
    profileSha256: frozenProfileCeilingSha256(),
  };
}

function frozenProfileCeilingSha256(): string {
  const path = getFrozenProfileCeilingPath();
  return sha256Hex(
    readHardenedFile(path, {
      label: 'Docker-workload profile ceiling',
      minBytes: 2,
      maxBytes: MAX_PROFILE_CEILING_BYTES,
    }),
  );
}
