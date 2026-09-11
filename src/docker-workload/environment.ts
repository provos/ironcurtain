import type { DockerEndpoint } from '../docker/docker-endpoint.js';
/** Runtime facts select an implemented profile; version strings are diagnostics. */
import { release } from 'node:os';
import type { DockerServerFacts } from '../docker/docker-probe.js';

export interface DockerWorkloadEnvironment {
  readonly dockerEndpoint?: DockerEndpoint;
  readonly profile: 'macos-desktop' | 'wsl-desktop' | 'apple-container';
  readonly architecture: 'amd64' | 'arm64';
  readonly egressTransport: 'tcp' | 'unix';
  readonly server?: DockerServerFacts;
}

export function isWsl2Host(platform: NodeJS.Platform, hostRelease: string): boolean {
  return platform === 'linux' && /microsoft.*wsl2|wsl2.*microsoft/i.test(hostRelease);
}

export function resolveDockerWorkloadEnvironment(
  runtimeKind: 'docker' | 'apple-container',
  server?: DockerServerFacts,
  host: { readonly platform: NodeJS.Platform; readonly release: string } = {
    platform: process.platform,
    release: release(),
  },
): DockerWorkloadEnvironment {
  if (runtimeKind === 'apple-container') {
    return { profile: 'apple-container', architecture: 'arm64', egressTransport: 'unix' };
  }
  if (server === undefined) throw new Error('Nested Docker requires execution-platform and daemon facts');
  if (server.osType !== 'linux') throw new Error('Nested Docker requires a Linux Docker server');
  if (host.platform === 'darwin') {
    return { profile: 'macos-desktop', architecture: server.architecture, egressTransport: 'tcp', server };
  }
  if (!isWsl2Host(host.platform, host.release)) {
    throw new Error('Nested Docker on Linux requires WSL2 with Docker Desktop; native Linux Engine is unqualified');
  }
  if (!/docker desktop/i.test(server.operatingSystem)) {
    throw new Error('Nested Docker on WSL2 requires Docker Desktop; the selected server is not Docker Desktop');
  }
  if (server.architecture !== 'amd64') throw new Error('Nested Docker on WSL2 supports amd64 only');
  if (server.cgroupVersion !== '2')
    throw new Error('Nested Docker on WSL2 requires cgroup v2 outer resource enforcement');
  if (!server.securityOptions.some((option) => option.startsWith('name=seccomp'))) {
    throw new Error('Nested Docker requires Docker seccomp support');
  }
  const unexpected = server.securityOptions.filter(
    (option) => !option.startsWith('name=seccomp') && option !== 'name=cgroupns',
  );
  if (unexpected.length !== 0) {
    throw new Error(
      `Nested Docker WSL profile does not cover these enforcing security options: ${unexpected.join(', ')}`,
    );
  }
  return { profile: 'wsl-desktop', architecture: 'amd64', egressTransport: 'unix', server };
}
