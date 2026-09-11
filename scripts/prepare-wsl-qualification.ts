#!/usr/bin/env tsx
/** Build required live-test images through the production environment/source/image seams. */
import { rmSync } from 'node:fs';
import { release } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadUserConfig, type ResolvedUserConfig } from '../src/config/user-config.js';
import { resolveDockerWorkloadConfig } from '../src/docker-workload/config.js';
import { ensureDockerImage } from '../src/docker/docker-infrastructure.js';
import type { AgentId } from '../src/docker/agent-adapter.js';
import { createSmokeRoot } from './smoke-environment.js';

export async function prepareWslQualificationImages(
  ensure: typeof ensureDockerImage = ensureDockerImage,
): Promise<void> {
  const root = createSmokeRoot('ic-na-');
  const previousHome = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = root;
  try {
    const config: ResolvedUserConfig = {
      ...loadUserConfig({ readOnly: true }),
      containerRuntime: 'docker',
      dockerResources: { memoryMb: 4096, cpus: 2 },
      dockerWorkload: resolveDockerWorkloadConfig(
        { enabled: true, networkAccess: 'offline' },
        { memoryMb: 4096, cpus: 2 },
      ),
    };
    let recordedEnvironment: string | undefined;
    // Every adapter uses the production environment, toolchain-source and image builder.
    for (const id of ['claude-code', 'goose', 'codex']) {
      process.stdout.write(`preparing required WSL qualification image: ${id}\n`);
      const prepared = await ensure(id as AgentId, config);
      const environment = prepared.dockerWorkloadEnvironment;
      if (environment?.profile !== 'wsl-desktop' || environment.server === undefined) {
        throw new Error('required image was not prepared through the admitted WSL Docker Desktop environment');
      }
      const observation = JSON.stringify({
        schemaVersion: 1,
        kind: 'wsl-qualification-environment',
        host: { platform: process.platform, kernelRelease: release() },
        profile: environment.profile,
        architecture: environment.architecture,
        egressTransport: environment.egressTransport,
        dockerServer: environment.server,
      });
      if (recordedEnvironment === undefined) {
        recordedEnvironment = observation;
        process.stdout.write(`${observation}\n`);
      } else if (recordedEnvironment !== observation) {
        throw new Error('WSL Docker Desktop environment changed while preparing required images');
      }
    }
  } finally {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.env.IRONCURTAIN_CONTAINER_RUNTIME = 'docker';
  await prepareWslQualificationImages();
}
