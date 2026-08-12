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
import { readHardenedFile } from '../hardened-fs.js';
import { sha256Hex } from '../hash.js';
import { assertIronCurtainAgentRuntimeImage, loadDockerWorkloadCatalogPair } from './catalog-pair.js';
import type { DockerWorkloadAdmissionBindings } from './infrastructure.js';

/** Generous ceiling; the frozen profile ceiling is a few kilobytes of JSON. */
const MAX_PROFILE_CEILING_BYTES = 1024 * 1024;

export interface ResolveAdmissionBindingsOptions {
  /** Apple-bound catalog the outer session resolves its agent image from. */
  readonly catalogPath: string;
  /** Docker-bound catalog used to provision the VM-private Docker Engine. */
  readonly innerDockerCatalogPath: string;
  /** Exact outer agent image also made available to inner IronCurtain. */
  readonly selectedImageLogicalName: string;
}

/** Read the real operational inputs and assemble the admission bindings. */
export function resolveDockerWorkloadAdmissionBindings(
  options: ResolveAdmissionBindingsOptions,
): DockerWorkloadAdmissionBindings {
  assertIronCurtainAgentRuntimeImage(options.selectedImageLogicalName);
  const catalogs = loadDockerWorkloadCatalogPair({
    appleCatalogPath: options.catalogPath,
    dockerCatalogPath: options.innerDockerCatalogPath,
  });
  const selectedImage = catalogs.docker.catalog.images.find(
    (image) => image.logicalName === options.selectedImageLogicalName,
  );
  if (selectedImage === undefined) {
    throw new Error(
      `Docker-workload admission catalog is missing the selected image ${options.selectedImageLogicalName}: ` +
        options.innerDockerCatalogPath,
    );
  }
  return {
    catalogSha256: catalogs.apple.sha256,
    innerDockerCatalogSha256: catalogs.docker.sha256,
    toolchainDigest: selectedImage.toolchainDigest,
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
