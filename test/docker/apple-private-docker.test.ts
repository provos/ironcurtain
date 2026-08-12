import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPLE_VM_INNER_DOCKER_CATALOG_DIR,
  createAppleVmPrivateDockerRuntime,
  provisionAppleVmDockerWorkload,
  stageAppleVmDockerWorkloadBootstrap,
} from '../../src/docker-workload/apple-private-docker.js';
import {
  APPLE_VM_DAEMON_DOCKER_HOST,
  APPLE_VM_DAEMON_TOOLCHAIN_DIR,
} from '../../src/docker-workload/apple-vm-daemon.js';
import { IRONCURTAIN_AGENT_RUNTIME_IMAGES } from '../../src/docker-workload/catalog-pair.js';
import { resolveDockerWorkloadAdmissionBindings } from '../../src/docker-workload/admission-bindings.js';
import {
  buildPreloadedImageLabels,
  loadPreloadedImageCatalog,
  type PreloadedImageCatalog,
} from '../../src/docker/preloaded-image-catalog.js';
import { getFrozenCatalogPath, preloadedCatalogFileName } from '../../src/docker/preloaded-catalog-paths.js';
import { loadClientToolchainManifest } from '../../src/docker-workload/client-toolchain.js';
import type { ContainerRuntime, DockerExecResult } from '../../src/docker/types.js';
import { writeOciArchiveFixture } from '../helpers/oci-archive-fixture.js';
import {
  TEST_APPLE_VM_DOCKER_WORKLOAD_BOOTSTRAP,
  createTestAppleVmDockerWorkloadBootstrap,
  respondHealthyAppleVmDaemon,
} from '../docker-workload/helpers/infrastructure-harness.js';

let tempDirectory: string;

beforeEach(() => {
  tempDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'apple-private-docker-')));
});

afterEach(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});

describe('bundle-immutable Apple VM Docker catalog staging', () => {
  it('hard-links only the catalog pair and selected agent archive', () => {
    const source = createCatalogSource();
    const leaseStagingRoot = resolve(tempDirectory, 'lease-staging');
    mkdirSync(leaseStagingRoot, { mode: 0o700 });
    const bindings = resolveDockerWorkloadAdmissionBindings({
      catalogPath: resolve(source, preloadedCatalogFileName('apple-container')),
      innerDockerCatalogPath: resolve(source, preloadedCatalogFileName('docker')),
      selectedImageLogicalName: 'ironcurtain-claude-code:latest',
    });

    const staged = stageAppleVmDockerWorkloadBootstrap({
      leaseStagingRoot,
      bindings,
      selectedImageLogicalName: 'ironcurtain-claude-code:latest',
      sourceCatalogDirectory: source,
    });

    expect(readdirSync(staged.hostCatalogDirectory).sort()).toEqual([
      'agent-claude-code.tar',
      preloadedCatalogFileName('apple-container'),
      preloadedCatalogFileName('docker'),
    ]);
    expect(staged.guestCatalogDirectory).toBe(APPLE_VM_INNER_DOCKER_CATALOG_DIR);
    for (const file of readdirSync(staged.hostCatalogDirectory)) {
      const sourceStat = lstatSync(resolve(source, file));
      const stagedStat = lstatSync(resolve(staged.hostCatalogDirectory, file));
      expect([stagedStat.dev, stagedStat.ino]).toEqual([sourceStat.dev, sourceStat.ino]);
    }

    rmSync(source, { recursive: true });
    expect(loadPreloadedImageCatalog(staged.outerAppleCatalogPath).sha256).toBe(bindings.catalogSha256);
    expect(loadPreloadedImageCatalog(staged.innerDockerCatalogPath).sha256).toBe(bindings.innerDockerCatalogSha256);
  });

  it('fails closed if a required archive source is a symlink', () => {
    const source = createCatalogSource();
    const leaseStagingRoot = resolve(tempDirectory, 'lease-staging');
    mkdirSync(leaseStagingRoot, { mode: 0o700 });
    const bindings = resolveDockerWorkloadAdmissionBindings({
      catalogPath: resolve(source, preloadedCatalogFileName('apple-container')),
      innerDockerCatalogPath: resolve(source, preloadedCatalogFileName('docker')),
      selectedImageLogicalName: 'ironcurtain-claude-code:latest',
    });
    rmSync(resolve(source, 'agent-claude-code.tar'));
    symlinkSync(resolve(source, 'agent-codex.tar'), resolve(source, 'agent-claude-code.tar'));

    expect(() =>
      stageAppleVmDockerWorkloadBootstrap({
        leaseStagingRoot,
        bindings,
        selectedImageLogicalName: 'ironcurtain-claude-code:latest',
        sourceCatalogDirectory: source,
      }),
    ).toThrow(/owner-owned, non-writable regular file/u);
  });

  it('rejects a catalog changed after the admission hashes were computed', () => {
    const source = createCatalogSource();
    const leaseStagingRoot = resolve(tempDirectory, 'lease-staging');
    mkdirSync(leaseStagingRoot, { mode: 0o700 });
    const dockerCatalogPath = resolve(source, preloadedCatalogFileName('docker'));
    const bindings = resolveDockerWorkloadAdmissionBindings({
      catalogPath: resolve(source, preloadedCatalogFileName('apple-container')),
      innerDockerCatalogPath: dockerCatalogPath,
      selectedImageLogicalName: 'ironcurtain-claude-code:latest',
    });
    chmodSync(dockerCatalogPath, 0o600);
    writeFileSync(dockerCatalogPath, ` ${readFileSync(dockerCatalogPath, 'utf8')}`);

    expect(() =>
      stageAppleVmDockerWorkloadBootstrap({
        leaseStagingRoot,
        bindings,
        selectedImageLogicalName: 'ironcurtain-claude-code:latest',
        sourceCatalogDirectory: source,
      }),
    ).toThrow(/Docker catalog changed after Docker-workload admission/u);
  });
});

describe('private Docker Engine adapter and provisioning', () => {
  it('binds every trusted command to the pinned client and private socket, preflighting before inspect', async () => {
    const commands: (readonly string[])[] = [];
    const outerRuntime = execRuntime((argv) => {
      commands.push([...argv]);
      return respondHealthyAppleVmDaemon(argv);
    });

    const config = createTestAppleVmDockerWorkloadBootstrap(tempDirectory);
    const selectedArchivePath = resolve(config.hostCatalogDirectory, 'agent-claude-code.tar');
    const result = await provisionAppleVmDockerWorkload({
      outerRuntime,
      containerId: 'outer-vm',
      config,
    });

    expect(result.image.logicalName).toBe('ironcurtain-claude-code:latest');
    expect(existsSync(selectedArchivePath)).toBe(false);
    expect(commands.every((argv) => argv[0] === `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`)).toBe(true);
    expect(commands.every((argv) => argv[1] === '--host' && argv[2] === APPLE_VM_DAEMON_DOCKER_HOST)).toBe(true);
    expect(commands.slice(0, 3).map((argv) => argv[3])).toEqual(['version', 'buildx', 'compose']);
    expect(commands.slice(3).map((argv) => argv.at(-1))).toEqual(['ironcurtain-claude-code:latest']);
  });

  it('rejects a stale selected image without any build, pull, or replacement load', async () => {
    const commands: (readonly string[])[] = [];
    const outerRuntime = execRuntime((argv) => {
      commands.push([...argv]);
      if (argv.includes('image') && argv.includes('inspect')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Id: `sha256:${'0'.repeat(64)}`,
              RepoTags: ['ironcurtain-claude-code:latest'],
              Config: { Labels: {} },
              Created: '2026-07-20T12:00:00.000Z',
            },
          ]),
          stderr: '',
        };
      }
      return respondHealthyAppleVmDaemon(argv);
    });

    const config = createTestAppleVmDockerWorkloadBootstrap(tempDirectory);
    await expect(
      provisionAppleVmDockerWorkload({
        outerRuntime,
        containerId: 'outer-vm',
        config,
      }),
    ).rejects.toThrow(/preloaded image ID mismatch/u);

    const operations = commands.map((argv) => argv.join(' ')).join('\n');
    expect(operations).not.toMatch(/\b(?:build|pull)\b/u);
    expect(operations).not.toContain('image load');
  });

  it('verifies and loads the selected archive through the exact guest path, then reinspects it', async () => {
    const manifest = loadClientToolchainManifest(TEST_APPLE_VM_DOCKER_WORKLOAD_BOOTSTRAP.clientToolchainManifestPath);
    const logicalName = 'ironcurtain-claude-code:latest';
    const generation = 'private-docker-load-test';
    const entry = writeOciArchiveFixture({
      directory: tempDirectory,
      logicalName,
      buildHash: 'a'.repeat(64),
      architecture: manifest.manifest.architecture,
      catalogGeneration: generation,
      toolchain: {
        dockerCli: manifest.manifest.docker.cliVersion,
        dockerDaemon: manifest.manifest.docker.daemonVersion,
        buildx: manifest.manifest.buildxVersion,
        compose: manifest.manifest.composeVersion,
      },
      dockerApi: manifest.manifest.docker.compatibleApiRange,
    });
    const catalog: PreloadedImageCatalog = {
      schemaVersion: 1,
      runtimeKind: 'docker',
      generation,
      createdAt: '2026-07-20T12:00:00.000Z',
      images: [entry],
    };
    const innerDockerCatalogPath = resolve(tempDirectory, preloadedCatalogFileName('docker'));
    writeFileSync(innerDockerCatalogPath, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });

    const commands: (readonly string[])[] = [];
    let loaded = false;
    let archiveExistedDuringLoad = false;
    const outerRuntime = execRuntime((argv) => {
      commands.push([...argv]);
      if (argv.includes('image') && argv.includes('inspect')) {
        if (!loaded) return { exitCode: 1, stdout: '', stderr: `No such image: ${logicalName}` };
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Id: entry.runtimeImageId,
              RepoTags: [logicalName],
              Config: { Labels: buildPreloadedImageLabels(entry, generation) },
              Created: entry.provenance.createdAt,
            },
          ]),
          stderr: '',
        };
      }
      if (argv.includes('image') && argv.includes('load')) {
        archiveExistedDuringLoad = existsSync(resolve(tempDirectory, entry.archive.fileName));
        loaded = true;
        return { exitCode: 0, stdout: `Loaded image: ${logicalName}\n`, stderr: '' };
      }
      return respondHealthyAppleVmDaemon(argv);
    });

    await expect(
      provisionAppleVmDockerWorkload({
        outerRuntime,
        containerId: 'outer-vm',
        config: {
          hostCatalogDirectory: tempDirectory,
          guestCatalogDirectory: APPLE_VM_INNER_DOCKER_CATALOG_DIR,
          outerAppleCatalogPath: resolve(tempDirectory, preloadedCatalogFileName('apple-container')),
          innerDockerCatalogPath,
          selectedImageLogicalName: logicalName,
          clientToolchainManifestPath: manifest.path,
        },
      }),
    ).resolves.toMatchObject({ image: { logicalName, immutableImageId: entry.runtimeImageId } });

    expect(archiveExistedDuringLoad).toBe(true);
    expect(existsSync(resolve(tempDirectory, entry.archive.fileName))).toBe(false);
    const imageCommands = commands.filter((argv) => argv.includes('image'));
    expect(imageCommands.map((argv) => argv[3])).toEqual(['image', 'image', 'image']);
    expect(imageCommands[1]?.slice(3)).toEqual([
      'image',
      'load',
      '--input',
      `${APPLE_VM_INNER_DOCKER_CATALOG_DIR}/${entry.archive.fileName}`,
    ]);
  });

  it('translates only direct catalog archive children to the read-only guest mount', async () => {
    const commands: (readonly string[])[] = [];
    const runtime = createAppleVmPrivateDockerRuntime({
      outerRuntime: execRuntime((argv) => {
        commands.push([...argv]);
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
      containerId: 'outer-vm',
      hostCatalogDirectory: '/trusted/catalog',
      guestCatalogDirectory: APPLE_VM_INNER_DOCKER_CATALOG_DIR,
    });

    await runtime.loadImageArchive('/trusted/catalog/base.tar');
    expect(commands[0]).toEqual([
      `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`,
      '--host',
      APPLE_VM_DAEMON_DOCKER_HOST,
      'image',
      'load',
      '--input',
      `${APPLE_VM_INNER_DOCKER_CATALOG_DIR}/base.tar`,
    ]);
    await expect(runtime.loadImageArchive('/trusted/catalog/subdir/base.tar')).rejects.toThrow(/direct child/u);
  });

  it('treats only an explicit image-not-found response as absence', async () => {
    const runtime = createAppleVmPrivateDockerRuntime({
      outerRuntime: execRuntime(() => ({ exitCode: 125, stdout: '', stderr: 'permission denied' })),
      containerId: 'outer-vm',
      hostCatalogDirectory: '/trusted/catalog',
      guestCatalogDirectory: APPLE_VM_INNER_DOCKER_CATALOG_DIR,
    });

    await expect(runtime.inspectImage('ironcurtain-base:latest')).rejects.toThrow(/image inspect failed/u);
  });

  it('rejects arbitrary commands, extra flags, and the wrong outer container', async () => {
    const runtime = createAppleVmPrivateDockerRuntime({
      outerRuntime: execRuntime(() => ({ exitCode: 0, stdout: '', stderr: '' })),
      containerId: 'outer-vm',
      hostCatalogDirectory: '/trusted/catalog',
      guestCatalogDirectory: APPLE_VM_INNER_DOCKER_CATALOG_DIR,
    });

    await expect(runtime.exec('outer-vm', ['docker', 'pull', 'alpine'])).rejects.toThrow(/exact client-toolchain/u);
    await expect(runtime.exec('outer-vm', ['docker', 'version', '--format', '{{json .}}', '--debug'])).rejects.toThrow(
      /exact client-toolchain/u,
    );
    await expect(runtime.exec('wrong-vm', ['docker', 'buildx', 'version'])).rejects.toThrow(/container ID mismatch/u);
  });
});

function createCatalogSource(): string {
  const source = resolve(tempDirectory, 'source');
  mkdirSync(source, { mode: 0o700 });
  for (const runtimeKind of ['apple-container', 'docker'] as const) {
    const target = resolve(source, preloadedCatalogFileName(runtimeKind));
    copyFileSync(getFrozenCatalogPath(runtimeKind), target);
    chmodSync(target, 0o400);
  }
  const dockerCatalog = loadPreloadedImageCatalog(resolve(source, preloadedCatalogFileName('docker')));
  for (const logicalName of IRONCURTAIN_AGENT_RUNTIME_IMAGES) {
    const entry = dockerCatalog.catalog.images.find((candidate) => candidate.logicalName === logicalName);
    if (entry === undefined) throw new Error(`test catalog is missing ${logicalName}`);
    writeFileSync(resolve(source, entry.archive.fileName), logicalName, { mode: 0o400 });
  }
  return source;
}

function execRuntime(
  respond: (argv: readonly string[]) => DockerExecResult | Promise<DockerExecResult>,
): Pick<ContainerRuntime, 'exec'> {
  return {
    exec: async (_containerId, argv) => respond(argv),
  };
}
