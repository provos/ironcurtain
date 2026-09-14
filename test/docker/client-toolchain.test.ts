import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadClientToolchainManifest,
  preflightClientToolchain,
  getDockerToolchainSourceReference,
  type ClientToolchainCompatibility,
  type DockerToolchainArchitecture,
} from '../../src/docker-workload/client-toolchain.js';
import type { ContainerRuntime, DockerExecResult } from '../../src/docker/types.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Docker client toolchain manifest', () => {
  it.each(['amd64', 'arm64'] as const)('selects %s from the shared compatibility requirements', (architecture) => {
    const loaded = loadClientToolchainManifest(resolve('config/docker-workload/client-toolchain.json'), architecture);
    expect(loaded.manifest).toMatchObject({
      architecture,
      generation: 'docker-rootless-29.2.1-v2',
      buildxVersion: '0.31.1',
      composeVersion: '5.1.0',
    });
    expect(loaded.manifest).not.toHaveProperty('realRunc');
    expect(loaded.manifest).not.toHaveProperty('source');
    expect(loaded).not.toHaveProperty('sha256');
    expect(getDockerToolchainSourceReference(loaded.manifest)).toBe('docker:29.2.1-dind-rootless');
  });

  it('rejects symlink, writable, malformed, and internally incompatible manifests', () => {
    const fixture = manifestFixture();
    const symlink = join(fixture.directory, 'link.json');
    symlinkSync(fixture.path, symlink);
    expect(() => loadClientToolchainManifest(symlink, 'arm64')).toThrow(/non-symlink/u);

    chmodSync(fixture.path, 0o666);
    expect(() => loadClientToolchainManifest(fixture.path, 'arm64')).toThrow(/group\/world writable/u);
    chmodSync(fixture.path, 0o600);
    writeFileSync(fixture.path, '{\n', { mode: 0o600 });
    expect(() => loadClientToolchainManifest(fixture.path, 'arm64')).toThrow(/not valid JSON/u);

    writeFileSync(
      fixture.path,
      `${JSON.stringify({ ...fixture.manifest, docker: { ...fixture.manifest.docker, clientApiVersion: '1.99' } })}\n`,
      { mode: 0o600 },
    );
    expect(() => loadClientToolchainManifest(fixture.path, 'arm64')).toThrow(/outside the compatible range/u);
  });
});

describe('Docker client toolchain preflight', () => {
  it.each(['amd64', 'arm64'] as const)(
    'checks the connected %s tuple and records version provenance',
    async (architecture) => {
      const fixture = manifestFixture();
      const loaded = loadClientToolchainManifest(fixture.path, architecture);
      const runtime = runtimeFixture({ architecture });
      const tuple = { dockerCli: '29.2.1', dockerDaemon: '29.2.1', buildx: '0.31.1', compose: '5.1.0' };
      const result = await preflightClientToolchain({
        runtime,
        containerId: 'agent-id',
        manifest: loaded,
      });
      expect(result).toMatchObject({
        architecture,
        dockerApi: { actual: '1.53' },
        toolchain: tuple,
      });
      expect(runtime.exec).toHaveBeenNthCalledWith(
        1,
        'agent-id',
        ['docker', 'version', '--format', '{{json .}}'],
        15_000,
      );
    },
  );

  it('rejects either client or daemon architecture mismatching the selected target', async () => {
    const fixture = manifestFixture();
    const loaded = loadClientToolchainManifest(fixture.path, 'amd64');
    for (const side of ['Client', 'Server'] as const) {
      const docker = dockerVersion({}, 'amd64');
      docker[side].Arch = 'arm64';
      await expect(
        preflightClientToolchain({
          runtime: runtimeFixture({ docker: JSON.stringify(docker) }),
          containerId: 'agent-id',
          manifest: loaded,
        }),
      ).rejects.toThrow(/architecture expected amd64, got arm64/u);
    }
  });

  it('fails closed for absent server data, version drift, and plugin drift', async () => {
    const fixture = manifestFixture();
    const loaded = loadClientToolchainManifest(fixture.path, 'arm64');
    await expect(
      preflightClientToolchain({
        runtime: runtimeFixture({ docker: JSON.stringify({ Client: dockerVersion().Client, Server: null }) }),
        containerId: 'agent-id',
        manifest: loaded,
      }),
    ).rejects.toThrow(/incomplete/u);

    await expect(
      preflightClientToolchain({
        runtime: runtimeFixture({ docker: JSON.stringify(dockerVersion({ Version: '29.2.2' })) }),
        containerId: 'agent-id',
        manifest: loaded,
      }),
    ).rejects.toThrow(/daemon version expected 29\.2\.1, got 29\.2\.2/u);

    await expect(
      preflightClientToolchain({
        runtime: runtimeFixture({ buildx: 'github.com/docker/buildx v0.32.0 deadbeef' }),
        containerId: 'agent-id',
        manifest: loaded,
      }),
    ).rejects.toThrow(/Buildx version expected 0\.31\.1, got 0\.32\.0/u);
  });

  it('rejects failed commands and unparseable plugin output', async () => {
    const fixture = manifestFixture();
    const loaded = loadClientToolchainManifest(fixture.path, 'arm64');
    await expect(
      preflightClientToolchain({
        runtime: runtimeFixture({ failureAt: 1 }),
        containerId: 'agent-id',
        manifest: loaded,
      }),
    ).rejects.toThrow(/probe failed.*daemon unavailable/u);
    await expect(
      preflightClientToolchain({
        runtime: runtimeFixture({ compose: 'Docker Compose is mysterious' }),
        containerId: 'agent-id',
        manifest: loaded,
      }),
    ).rejects.toThrow(/Compose version probe returned an unknown format/u);
  });
});

function manifestFixture(): {
  readonly directory: string;
  readonly path: string;
  readonly manifest: ClientToolchainCompatibility;
} {
  const directory = mkdtempSync(join(tmpdir(), 'client-toolchain-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'manifest.json');
  const manifest = {
    schemaVersion: 2,
    generation: 'docker-rootless-29.2.1-v2',
    platform: 'linux',
    docker: {
      cliVersion: '29.2.1',
      daemonVersion: '29.2.1',
      clientApiVersion: '1.53',
      daemonApiVersion: '1.53',
      minimumDaemonApiVersion: '1.44',
      compatibleApiRange: { min: '1.44', max: '1.53' },
    },
    buildxVersion: '0.31.1',
    composeVersion: '5.1.0',
  } as const satisfies ClientToolchainCompatibility;
  writeFileSync(path, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return { directory, path, manifest };
}

function runtimeFixture(
  options: {
    readonly docker?: string;
    readonly buildx?: string;
    readonly compose?: string;
    readonly failureAt?: number;
    readonly architecture?: DockerToolchainArchitecture;
  } = {},
): Pick<ContainerRuntime, 'exec'> {
  let calls = 0;
  return {
    exec: vi.fn(async (): Promise<DockerExecResult> => {
      calls += 1;
      if (calls === options.failureAt) return { exitCode: 1, stdout: '', stderr: 'daemon unavailable' };
      if (calls === 1) {
        return {
          exitCode: 0,
          stdout: options.docker ?? JSON.stringify(dockerVersion({}, options.architecture)),
          stderr: '',
        };
      }
      if (calls === 2) {
        return {
          exitCode: 0,
          stdout: options.buildx ?? 'github.com/docker/buildx v0.31.1 a2675950',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: options.compose ?? '5.1.0', stderr: '' };
    }),
  };
}

function dockerVersion(
  serverOverrides: Readonly<Record<string, string>> = {},
  architecture: DockerToolchainArchitecture = 'arm64',
) {
  return {
    Client: { Version: '29.2.1', ApiVersion: '1.53', Os: 'linux', Arch: architecture },
    Server: {
      Version: '29.2.1',
      ApiVersion: '1.53',
      MinAPIVersion: '1.44',
      Os: 'linux',
      Arch: architecture,
      ...serverOverrides,
    },
  };
}
