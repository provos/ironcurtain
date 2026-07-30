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
 * Every field is currently a real operational hash, so the set reports
 * `'qualified'` provenance. Provenance describes the weakest field, never the
 * strongest — see {@link PLACEHOLDER_ADMISSION_BINDING_FIELDS}.
 */

import { createHash } from 'node:crypto';
import { getFrozenProfileCeilingPath } from '../docker/docker-workload-paths.js';
import { loadPreloadedImageCatalog } from '../docker/preloaded-image-catalog.js';
import { readHardenedFile } from '../hardened-fs.js';
import { sha256Hex } from '../hash.js';
import type { DockerWorkloadAdmissionBindings } from './infrastructure.js';

/**
 * Catalog role whose toolchain digest the admission binds. The nested daemon
 * toolchain (dockerd/rootlesskit/containerd/runc) is staged by the base image
 * and every agent image is built `FROM` it, so the base role's digest is the
 * one that describes the daemon the session can actually start. It is also the
 * role the frozen qualification contract binds, so the two cannot drift.
 */
const BASE_IMAGE_LOGICAL_NAME = 'ironcurtain-base:latest';

/** Generous ceiling; the frozen profile ceiling is a few kilobytes of JSON. */
const MAX_PROFILE_CEILING_BYTES = 1024 * 1024;

/**
 * Bindings that cannot be sourced honestly yet — currently none.
 *
 * Every remaining field is hashed from the bytes the session really uses. A
 * future binding that can only be namespaced (see {@link placeholderBinding})
 * is listed here, which downgrades the whole set's provenance.
 */
export const PLACEHOLDER_ADMISSION_BINDING_FIELDS: readonly (keyof DockerWorkloadAdmissionBindings)[] = [];

export type AdmissionBindingsProvenance = 'placeholder' | 'qualified';

export interface ResolveAdmissionBindingsOptions {
  /** Staged catalog the session resolves its agent image from. */
  readonly catalogPath: string;
}

export interface ResolvedAdmissionBindings {
  readonly bindings: DockerWorkloadAdmissionBindings;
  /**
   * `'qualified'` only once every field is a real operational hash. While any
   * field is a placeholder the set as a whole is `'placeholder'` — a partially
   * real set must never present itself as evidence.
   */
  readonly provenance: AdmissionBindingsProvenance;
}

/**
 * Provenance describes the weakest field: one placeholder demotes the whole
 * set. Kept as a function of the field list so reintroducing a placeholder is
 * a one-line change that cannot forget to demote the provenance.
 */
export function admissionBindingsProvenance(
  placeholderFields: readonly string[] = PLACEHOLDER_ADMISSION_BINDING_FIELDS,
): AdmissionBindingsProvenance {
  return placeholderFields.length === 0 ? 'qualified' : 'placeholder';
}

/** Read the real operational inputs and assemble the admission bindings. */
export function resolveDockerWorkloadAdmissionBindings(
  options: ResolveAdmissionBindingsOptions,
): ResolvedAdmissionBindings {
  const catalog = loadPreloadedImageCatalog(options.catalogPath);
  const base = catalog.catalog.images.find((image) => image.logicalName === BASE_IMAGE_LOGICAL_NAME);
  if (base === undefined) {
    throw new Error(
      `Docker-workload admission catalog is missing the ${BASE_IMAGE_LOGICAL_NAME} role: ${options.catalogPath}`,
    );
  }
  return {
    bindings: {
      catalogSha256: catalog.sha256,
      toolchainDigest: base.toolchainDigest,
      profileSha256: frozenProfileCeilingSha256(),
    },
    provenance: admissionBindingsProvenance(),
  };
}

/**
 * A uniformly namespaced derived hash that CANNOT collide with a real
 * operational-artifact hash — it is never the bare config hash and never the
 * hash of any artifact. Unused while
 * {@link PLACEHOLDER_ADMISSION_BINDING_FIELDS} is empty; it is the mechanism a
 * future not-yet-sourceable binding uses, alongside the
 * `bindingsProvenance: 'placeholder'` the admission audit event then records.
 */
export function placeholderBinding(field: string, configHash: string): string {
  return createHash('sha256').update(`ironcurtain-placeholder:${field}:${configHash}`).digest('hex');
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
