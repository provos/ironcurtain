/** Normalize the subset of `docker image inspect` shared by Docker runtimes. */

import type { DockerImageInfo } from './types.js';

export function parseDockerImageInfo(raw: unknown): DockerImageInfo {
  if (!isRecord(raw)) throw new Error('Unexpected docker image inspect result: expected object');
  const config = isRecord(raw.Config) ? raw.Config : {};
  const labelsRaw = isRecord(config.Labels) ? config.Labels : {};
  const labels = Object.fromEntries(
    Object.entries(labelsRaw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const repoTags = Array.isArray(raw.RepoTags)
    ? raw.RepoTags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return {
    id: typeof raw.Id === 'string' ? raw.Id : '',
    repoTags,
    labels,
    created: typeof raw.Created === 'string' ? raw.Created : '',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
