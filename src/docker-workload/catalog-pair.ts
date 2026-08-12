/** Validation for the Apple-outer / Docker-inner preloaded catalog pair. */

import {
  loadPreloadedImageCatalog,
  type LoadedPreloadedImageCatalog,
  type PreloadedImageCatalogEntry,
} from '../docker/preloaded-image-catalog.js';
import { stableStringify } from '../hash.js';

/** Agent images eligible for same-agent IronCurtain sessions inside the VM. */
export const IRONCURTAIN_AGENT_RUNTIME_IMAGES = [
  'ironcurtain-claude-code:latest',
  'ironcurtain-codex:latest',
  'ironcurtain-goose:latest',
] as const;

export type IronCurtainAgentRuntimeImage = (typeof IRONCURTAIN_AGENT_RUNTIME_IMAGES)[number];

export function assertIronCurtainAgentRuntimeImage(value: string): asserts value is IronCurtainAgentRuntimeImage {
  if (!(IRONCURTAIN_AGENT_RUNTIME_IMAGES as readonly string[]).includes(value)) {
    throw new Error(`Docker-workload selected image is not an IronCurtain agent image: ${value}`);
  }
}

export interface DockerWorkloadCatalogPair {
  readonly apple: LoadedPreloadedImageCatalog;
  readonly docker: LoadedPreloadedImageCatalog;
}

/**
 * Load the two operational catalogs and prove they describe one artifact set.
 * Runtime kind and immutable runtime image ID are the only backend-specific
 * entry fields; every archive and all metadata that adjudicates it are shared.
 */
export function loadDockerWorkloadCatalogPair(options: {
  readonly appleCatalogPath: string;
  readonly dockerCatalogPath: string;
}): DockerWorkloadCatalogPair {
  const apple = loadPreloadedImageCatalog(options.appleCatalogPath);
  const docker = loadPreloadedImageCatalog(options.dockerCatalogPath);
  if (apple.catalog.runtimeKind !== 'apple-container') {
    throw new Error(`outer catalog has wrong runtime kind: ${apple.catalog.runtimeKind}`);
  }
  if (docker.catalog.runtimeKind !== 'docker') {
    throw new Error(`inner catalog has wrong runtime kind: ${docker.catalog.runtimeKind}`);
  }
  if (apple.catalog.generation !== docker.catalog.generation) {
    throw new Error('Apple and Docker catalogs have different generations');
  }
  if (apple.catalog.createdAt !== docker.catalog.createdAt) {
    throw new Error('Apple and Docker catalogs have different creation times');
  }

  const dockerByName = new Map(docker.catalog.images.map((entry) => [entry.logicalName, entry]));
  if (dockerByName.size !== apple.catalog.images.length) {
    throw new Error('Apple and Docker catalogs have different logical image sets');
  }
  for (const appleEntry of apple.catalog.images) {
    const dockerEntry = dockerByName.get(appleEntry.logicalName);
    if (dockerEntry === undefined) {
      throw new Error(`Docker catalog is missing Apple catalog image: ${appleEntry.logicalName}`);
    }
    assertSharedEntry(appleEntry, dockerEntry);
    dockerByName.delete(appleEntry.logicalName);
  }
  if (dockerByName.size !== 0) {
    throw new Error(`Docker catalog has images absent from Apple catalog: ${[...dockerByName.keys()].join(', ')}`);
  }
  return { apple, docker };
}

function assertSharedEntry(apple: PreloadedImageCatalogEntry, docker: PreloadedImageCatalogEntry): void {
  if (stableStringify(sharedEntryFields(apple)) !== stableStringify(sharedEntryFields(docker))) {
    throw new Error(`Apple and Docker catalog metadata differs for image: ${apple.logicalName}`);
  }
}

function sharedEntryFields(entry: PreloadedImageCatalogEntry): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'runtimeKind' && key !== 'runtimeImageId'));
}
