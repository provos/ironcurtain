import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadClientToolchainManifest,
  preflightClientToolchain,
  type ClientToolchainManifest,
} from '../../src/docker-workload/client-toolchain.js';
import { catalogTupleDigest } from '../../src/docker/preloaded-image-catalog.js';
import type { ContainerRuntime, DockerExecResult } from '../../src/docker/types.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Docker client toolchain manifest', () => {
  it('loads the checked-in Mac arm64 candidate and hashes its exact bytes', () => {
    const loaded = loadClientToolchainManifest(resolve('config/docker-workload/client-toolchain.arm64.json'));
    expect(loaded.manifest).toMatchObject({
      architecture: 'arm64',
      generation: 'docker-rootless-29.2.1-mac-arm64-v1',
      buildxVersion: '0.31.1',
      composeVersion: '5.1.0',
    });
    expect(loaded.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects symlink, writable, malformed, and internally incompatible manifests', () => {
    const fixture = manifestFixture();
    const symlink = join(fixture.directory, 'link.json');
    symlinkSync(fixture.path, symlink);
    expect(() => loadClientToolchainManifest(symlink)).toThrow(/non-symlink/u);

    chmodSync(fixture.path, 0o666);
    expect(() => loadClientToolchainManifest(fixture.path)).toThrow(/group\/world writable/u);
    chmodSync(fixture.path, 0o600);
    writeFileSync(fixture.path, '{\n', { mode: 0o600 });
    expect(() => loadClientToolchainManifest(fixture.path)).toThrow(/not valid JSON/u);

    writeFileSync(
      fixture.path,
      `${JSON.stringify({ ...fixture.manifest, docker: { ...fixture.manifest.docker, clientApiVersion: '1.99' } })}\n`,
      { mode: 0o600 },
    );
    expect(() => loadClientToolchainManifest(fixture.path)).toThrow(/outside the compatible range/u);
  });
});

describe('Docker client toolchain preflight', () => {
  it('proves the exact connected tuple and catalog-compatible digest', async () => {
    const fixture = manifestFixture();
    const loaded = loadClientToolchainManifest(fixture.path);
    const runtime = runtimeFixture();
    const tuple = { dockerCli: '29.2.1', dockerDaemon: '29.2.1', buildx: '0.31.1', compose: '5.1.0' };
    const result = await preflightClientToolchain({
      runtime,
      containerId: 'agent-id',
      manifest: loaded,
      expectedToolchainDigest: catalogTupleDigest(tuple),
    });
    expect(result).toMatchObject({
      architecture: 'arm64',
      dockerApi: { min: '1.44', max: '1.53', actual: '1.53' },
      toolchain: tuple,
      toolchainDigest: catalogTupleDigest(tuple),
    });
    expect(runtime.exec).toHaveBeenNthCalledWith(
      1,
      'agent-id',
      ['docker', 'version', '--format', '{{json .}}'],
      15_000,
    );
  });

  it('fails closed for absent server data, version drift, plugin drift, and catalog drift', async () => {
    const fixture = manifestFixture();
    const loaded = loadClientToolchainManifest(fixture.path);
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

    await expect(
      preflightClientToolchain({
        runtime: runtimeFixture(),
        containerId: 'agent-id',
        manifest: loaded,
        expectedToolchainDigest: '0'.repeat(64),
      }),
    ).rejects.toThrow(/differs from the preloaded catalog/u);
  });

  it('rejects failed commands and unparseable plugin output', async () => {
    const fixture = manifestFixture();
    const loaded = loadClientToolchainManifest(fixture.path);
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
  readonly manifest: ClientToolchainManifest;
} {
  const directory = mkdtempSync(join(tmpdir(), 'client-toolchain-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'manifest.json');
  const manifest = {
    schemaVersion: 1,
    generation: 'docker-rootless-29.2.1-mac-arm64-v1',
    platform: 'linux',
    architecture: 'arm64',
    source: {
      daemonImage: `docker@sha256:${'1'.repeat(64)}`,
      daemonImageId: `sha256:${'2'.repeat(64)}`,
    },
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
  } as const satisfies ClientToolchainManifest;
  writeFileSync(path, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return { directory, path, manifest };
}

function runtimeFixture(
  options: {
    readonly docker?: string;
    readonly buildx?: string;
    readonly compose?: string;
    readonly failureAt?: number;
  } = {},
): Pick<ContainerRuntime, 'exec'> {
  let calls = 0;
  return {
    exec: vi.fn(async (): Promise<DockerExecResult> => {
      calls += 1;
      if (calls === options.failureAt) return { exitCode: 1, stdout: '', stderr: 'daemon unavailable' };
      if (calls === 1) return { exitCode: 0, stdout: options.docker ?? JSON.stringify(dockerVersion()), stderr: '' };
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

function dockerVersion(serverOverrides: Readonly<Record<string, string>> = {}) {
  return {
    Client: { Version: '29.2.1', ApiVersion: '1.53', Os: 'linux', Arch: 'arm64' },
    Server: {
      Version: '29.2.1',
      ApiVersion: '1.53',
      MinAPIVersion: '1.44',
      Os: 'linux',
      Arch: 'arm64',
      ...serverOverrides,
    },
  };
}
