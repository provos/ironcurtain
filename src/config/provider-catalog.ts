/** Editor-only network boundary. Never import this module from config loading or runtime routing. */
import { getGatewayDefinition } from './provider-definitions.js';
import { listOpenrouterModels, type ModelCatalogResult } from './openrouter-catalog.js';

const LOADERS: Readonly<Partial<Record<string, (opts?: { forceRefresh?: boolean }) => Promise<ModelCatalogResult>>>> = {
  openrouter: listOpenrouterModels,
};

export async function listProviderModels(
  service: string,
  opts?: { forceRefresh?: boolean },
): Promise<ModelCatalogResult> {
  const descriptor = getGatewayDefinition(service).editor;
  if (descriptor.catalog === 'manual') return { models: [], source: 'bundled', fetchedAt: 0 };
  const loader = LOADERS[service];
  if (!loader) throw new Error(`No catalog loader registered for ${descriptor.label}.`);
  return loader(opts);
}
