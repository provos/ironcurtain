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
 * One field is still honestly a placeholder — see
 * {@link PLACEHOLDER_ADMISSION_BINDING_FIELDS} — so the whole set is reported
 * as `'placeholder'` provenance. Provenance describes the weakest field, never
 * the strongest.
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
 * Bindings that cannot be sourced honestly yet.
 *
 * `performanceBudgetSha256`: the only frozen budget
 * (`test/docker-workload/performance-budget.<variant>-<arch>.json`) lives in
 * the test tree, which the published package does not ship (`package.json`
 * `files`). Hashing it from session code would ENOENT in an installed copy,
 * and relocating a frozen artifact is a re-freeze, not a wiring change. Left
 * as a namespaced derived placeholder until the budget is published as a
 * runtime-readable artifact.
 */
export const PLACEHOLDER_ADMISSION_BINDING_FIELDS = ['performanceBudgetSha256'] as const;

export interface ResolveAdmissionBindingsOptions {
  /** Staged catalog the session resolves its agent image from. */
  readonly catalogPath: string;
  /** Resolved capability config hash; namespaces the remaining placeholder. */
  readonly configHash: string;
}

export interface ResolvedAdmissionBindings {
  readonly bindings: DockerWorkloadAdmissionBindings;
  /**
   * `'qualified'` only once every field is a real operational hash. While any
   * field is a placeholder the set as a whole is `'placeholder'` — a partially
   * real set must never present itself as evidence.
   */
  readonly provenance: 'placeholder' | 'qualified';
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
      performanceBudgetSha256: placeholderBinding('performanceBudgetSha256', options.configHash),
    },
    // Not 'qualified': PLACEHOLDER_ADMISSION_BINDING_FIELDS is non-empty. Flip
    // this only when that list is empty — the last placeholder decides.
    provenance: 'placeholder',
  };
}

/**
 * A uniformly namespaced derived hash that CANNOT collide with a real
 * operational-artifact hash — it is never the bare config hash and never the
 * hash of any artifact. The admission audit event records
 * `bindingsProvenance: 'placeholder'` alongside it.
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
