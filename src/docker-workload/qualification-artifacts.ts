/**
 * Recompute a frozen qualification contract's artifact bindings from the real repository.
 *
 * `bindings` is the contract's claim that a backend was qualified against exactly these TCB
 * artifacts. The run-record check in `verifyVitestQualificationRun` only proves a *run* carried the
 * same bindings as its contract — the runner copies `contract.bindings` into the record, so on its
 * own that comparison is a contract against a copy of itself. This module supplies the missing
 * half: the frozen claim against the bytes on disk. Any drift fails closed on the first mismatch.
 *
 * Offline release tooling (the qualification driver and the freeze-guard tests). Sessions bind
 * operational inputs at admission time and must not import this module.
 */

import { join, resolve } from 'node:path';
import type { ContainerRuntimeKind } from '../docker/container-runtime.js';
import { preloadedCatalogFileName } from '../docker/preloaded-catalog-paths.js';
import { loadPreloadedImageCatalog } from '../docker/preloaded-image-catalog.js';
import { MAX_QUALIFICATION_JSON_BYTES, type QualificationContract } from '../docker/qualification-contract.js';
import { RUNTIME_TRUST_SCHEMA } from '../docker/runtime-trust.js';
import { readHardenedFile } from '../hardened-fs.js';
import { sha256Hex } from '../hash.js';

/** Catalog role whose immutable image ID and toolchain digest the contract binds. */
const BASE_IMAGE_LOGICAL_NAME = 'ironcurtain-base:latest';

/**
 * Backend platform -> the catalog record frozen for that backend. `linux-docker` is absent on
 * purpose: a catalog is frozen on the host that built it, so the macOS-frozen
 * `preloaded-catalog.docker.json` must never stand in for a Linux record that does not exist yet.
 */
const CATALOG_RUNTIME_KIND: Partial<Record<QualificationContract['platform'], ContainerRuntimeKind>> = {
  'apple-container': 'apple-container',
  'docker-desktop': 'docker',
};

type FileHashBinding = 'profileSha256' | 'watchdogSha256' | 'buildEgressSha256';

/** Repository-relative artifact backing each raw-file-hash binding. */
const FILE_HASH_BINDINGS: readonly (readonly [FileHashBinding, string])[] = [
  ['profileSha256', 'config/docker-workload/profile-ceiling.json'],
  ['watchdogSha256', 'config/docker-workload/resource-watchdog-policy.json'],
  ['buildEgressSha256', 'config/docker-workload/build-egress-manifest.json'],
];

/**
 * Verify every disk-derivable binding of a frozen contract against the repository artifacts.
 *
 * Deliberately unverified here:
 * - `publicCaSha256` — derived from the freeze host's Node `rootCertificates` store, not a repo
 *   artifact, and Node-version scoped; recomputing it would fail across Node versions.
 * - `sourceCommit` / `dirtyPatchSha256` — git state rather than a file. The qualification driver
 *   reports HEAD drift as a warning, because a contract is frozen against one tree while the tree
 *   keeps moving.
 * - `relaySha256` — nullable, and no built relay binary is committed today.
 *
 * @throws on the first binding whose frozen value differs from the on-disk artifact.
 */
export function verifyQualificationArtifactBindings(contract: QualificationContract, repositoryRoot: string): void {
  const root = resolve(repositoryRoot);
  const { bindings } = contract;

  const catalogPath = resolveCatalogPath(contract, root);
  const catalog = loadPreloadedImageCatalog(catalogPath);
  const base = catalog.catalog.images.find((image) => image.logicalName === BASE_IMAGE_LOGICAL_NAME);
  if (base === undefined) {
    throw new Error(`qualification catalog is missing the ${BASE_IMAGE_LOGICAL_NAME} role: ${catalogPath}`);
  }
  const baseSource = `${catalogPath} role ${BASE_IMAGE_LOGICAL_NAME}`;
  assertBinding('catalogSha256', bindings.catalogSha256, catalog.sha256, catalogPath);
  assertBinding('runtimeImageId', bindings.runtimeImageId, base.runtimeImageId, baseSource);
  assertBinding('toolchainDigest', bindings.toolchainDigest, base.toolchainDigest, baseSource);

  for (const [binding, relativePath] of FILE_HASH_BINDINGS) {
    const path = join(root, relativePath);
    assertBinding(binding, bindings[binding], artifactSha256(path, binding), path);
  }

  assertBinding(
    'runtimeTrustSchema',
    bindings.runtimeTrustSchema,
    RUNTIME_TRUST_SCHEMA,
    'src/docker/runtime-trust.ts RUNTIME_TRUST_SCHEMA',
  );
}

function resolveCatalogPath(contract: QualificationContract, root: string): string {
  const runtimeKind = CATALOG_RUNTIME_KIND[contract.platform];
  if (runtimeKind === undefined) {
    throw new Error(`no catalog mapping for platform: ${contract.platform}`);
  }
  return join(root, 'config', 'docker-workload', preloadedCatalogFileName(runtimeKind));
}

/** SHA-256 of the exact file bytes, read through the same hardened path `loadImmutableHostJson` uses. */
function artifactSha256(path: string, binding: string): string {
  const bytes = readHardenedFile(path, {
    label: `qualification artifact for ${binding}`,
    minBytes: 2,
    maxBytes: MAX_QUALIFICATION_JSON_BYTES,
  });
  return sha256Hex(bytes);
}

function assertBinding(binding: string, frozen: string | null, actual: string, source: string): void {
  if (frozen === actual) return;
  throw new Error(
    `qualification binding drift: ${binding} does not match ${source} ` +
      `(frozen ${frozen ?? 'null'}, on disk ${actual})`,
  );
}
