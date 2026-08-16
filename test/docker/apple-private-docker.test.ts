import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
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
  APPLE_VM_DOCKER_WORKLOAD_NETWORK,
  APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR,
  createAppleVmDockerWorkloadNetwork,
  createAppleVmPrivateDockerRuntime,
  provisionAppleVmDockerWorkload,
  stageAppleVmDockerWorkloadBootstrap,
} from '../../src/docker-workload/apple-private-docker.js';
import {
  APPLE_VM_DAEMON_DOCKER_HOST,
  APPLE_VM_DAEMON_TOOLCHAIN_DIR,
} from '../../src/docker-workload/apple-vm-daemon.js';
import { loadClientToolchainManifest } from '../../src/docker-workload/client-toolchain.js';
import type { ContainerRuntime, DockerExecResult } from '../../src/docker/types.js';
import { writeOciArchiveFixture } from '../helpers/oci-archive-fixture.js';
import {
  TEST_CLIENT_TOOLCHAIN_MANIFEST_PATH,
  MANAGED_INNER_NETWORK_ID,
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

describe('bundle-immutable selected agent staging', () => {
  it('hard-links only the selected agent archive', () => {
    const source = createTestAppleVmDockerWorkloadBootstrap(tempDirectory);
    const leaseStagingRoot = resolve(tempDirectory, 'lease-staging');
    mkdirSync(leaseStagingRoot, { mode: 0o700 });

    const staged = stageAppleVmDockerWorkloadBootstrap({
      leaseStagingRoot,
      artifact: source.artifact,
    });

    expect(readdirSync(staged.hostArtifactDirectory)).toEqual(['fixture.oci.tar']);
    expect(staged.guestArtifactDirectory).toBe(APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR);
    const sourceStat = lstatSync(source.artifact.archivePath);
    const stagedStat = lstatSync(staged.artifact.archivePath);
    expect([stagedStat.dev, stagedStat.ino]).toEqual([sourceStat.dev, sourceStat.ino]);

    rmSync(source.hostArtifactDirectory, { recursive: true });
    expect(existsSync(staged.artifact.archivePath)).toBe(true);
  });

  it('fails closed if a required archive source is a symlink', () => {
    const source = createTestAppleVmDockerWorkloadBootstrap(tempDirectory);
    const leaseStagingRoot = resolve(tempDirectory, 'lease-staging');
    mkdirSync(leaseStagingRoot, { mode: 0o700 });
    const realArchive = resolve(source.hostArtifactDirectory, 'real.tar');
    writeFileSync(realArchive, 'replacement', { mode: 0o400 });
    rmSync(source.artifact.archivePath);
    symlinkSync(realArchive, source.artifact.archivePath);

    expect(() =>
      stageAppleVmDockerWorkloadBootstrap({
        leaseStagingRoot,
        artifact: source.artifact,
      }),
    ).toThrow(/owner-owned, non-writable regular file/u);
  });

  it('rejects an artifact made writable after it was resolved', () => {
    const source = createTestAppleVmDockerWorkloadBootstrap(tempDirectory);
    const leaseStagingRoot = resolve(tempDirectory, 'lease-staging');
    mkdirSync(leaseStagingRoot, { mode: 0o700 });
    chmodSync(source.artifact.archivePath, 0o600);

    expect(() =>
      stageAppleVmDockerWorkloadBootstrap({
        leaseStagingRoot,
        artifact: source.artifact,
      }),
    ).toThrow(/owner-owned, non-writable regular file/u);
  });
});

describe('private Docker Engine adapter and provisioning', () => {
  it('precreates and adjudicates one fixed local internal bridge with the pinned client', async () => {
    const commands: (readonly string[])[] = [];
    const network = await createAppleVmDockerWorkloadNetwork({
      outerRuntime: execRuntime((argv) => {
        commands.push([...argv]);
        return respondHealthyAppleVmDaemon(argv);
      }),
      containerId: 'outer-vm',
    });

    expect(network).toEqual({ name: 'ironcurtain', id: MANAGED_INNER_NETWORK_ID });
    expect(APPLE_VM_DOCKER_WORKLOAD_NETWORK).toBe('ironcurtain');
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual([
      `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`,
      '--host',
      APPLE_VM_DAEMON_DOCKER_HOST,
      'network',
      'create',
      '--driver',
      'bridge',
      '--internal',
      '--label',
      'com.ironcurtain.managed-workload=true',
      'ironcurtain',
    ]);
    expect(commands[1]?.slice(3)).toEqual(['network', 'inspect', '--format', '{{json .}}', 'ironcurtain']);
  });

  it('fails closed when the managed bridge does not inspect as internal', async () => {
    await expect(
      createAppleVmDockerWorkloadNetwork({
        outerRuntime: execRuntime((argv) => {
          if (argv.includes('network') && argv.includes('create')) {
            return { exitCode: 0, stdout: `${MANAGED_INNER_NETWORK_ID}\n`, stderr: '' };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Id: MANAGED_INNER_NETWORK_ID,
              Name: APPLE_VM_DOCKER_WORKLOAD_NETWORK,
              Driver: 'bridge',
              Scope: 'local',
              Internal: false,
            }),
            stderr: '',
          };
        }),
        containerId: 'outer-vm',
      }),
    ).rejects.toThrow(/required empty labeled internal bridge/u);
  });

  it.each([
    ['missing its exact label', {}, {}],
    ['already has an endpoint', { 'com.ironcurtain.managed-workload': 'true' }, { endpoint: { Name: 'unexpected' } }],
  ])('fails closed when the managed bridge %s', async (_case, labels, containers) => {
    await expect(
      createAppleVmDockerWorkloadNetwork({
        outerRuntime: execRuntime((argv) => {
          if (argv.includes('network') && argv.includes('create')) {
            return { exitCode: 0, stdout: `${MANAGED_INNER_NETWORK_ID}\n`, stderr: '' };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Id: MANAGED_INNER_NETWORK_ID,
              Name: APPLE_VM_DOCKER_WORKLOAD_NETWORK,
              Driver: 'bridge',
              Scope: 'local',
              Internal: true,
              Labels: labels,
              Containers: containers,
            }),
            stderr: '',
          };
        }),
        containerId: 'outer-vm',
      }),
    ).rejects.toThrow(/required empty labeled internal bridge/u);
  });

  it('binds every trusted command to the pinned client and private socket, preflighting before inspect', async () => {
    const commands: (readonly string[])[] = [];
    const outerRuntime = execRuntime((argv) => {
      commands.push([...argv]);
      return respondHealthyAppleVmDaemon(argv);
    });

    const config = createTestAppleVmDockerWorkloadBootstrap(tempDirectory);
    const selectedArchivePath = config.artifact.archivePath;
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
    ).rejects.toThrow(/selected agent inner Docker image mismatch/u);

    const operations = commands.map((argv) => argv.join(' ')).join('\n');
    expect(operations).not.toMatch(/\b(?:build|pull)\b/u);
    expect(operations).not.toContain('image load');
  });

  it('verifies and loads the selected archive through the exact guest path, then reinspects it', async () => {
    const manifest = loadClientToolchainManifest(TEST_CLIENT_TOOLCHAIN_MANIFEST_PATH);
    const logicalName = 'ironcurtain-claude-code:latest';
    const entry = writeOciArchiveFixture({
      directory: tempDirectory,
      logicalName,
      buildHash: 'a'.repeat(64),
      architecture: manifest.manifest.architecture,
    });
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
              Config: { Labels: entry.labels },
              Created: entry.createdAt,
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
          hostArtifactDirectory: tempDirectory,
          guestArtifactDirectory: APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR,
          artifact: {
            logicalName,
            buildHash: entry.buildHash,
            architecture: entry.architecture,
            appleImageId: `sha256:${'b'.repeat(64)}`,
            dockerImageId: entry.configDigest,
            manifestDigest: entry.manifestDigest,
            archivePath: resolve(tempDirectory, entry.archive.fileName),
            archiveSha256: entry.archive.sha256,
            archiveSizeBytes: entry.archive.sizeBytes,
          },
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
      `${APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR}/${entry.archive.fileName}`,
    ]);
  });

  it('translates only direct selected-artifact archive children to the read-only guest mount', async () => {
    const commands: (readonly string[])[] = [];
    const runtime = createAppleVmPrivateDockerRuntime({
      outerRuntime: execRuntime((argv) => {
        commands.push([...argv]);
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
      containerId: 'outer-vm',
      hostArtifactDirectory: '/trusted/artifact',
      guestArtifactDirectory: APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR,
    });

    await runtime.loadImageArchive('/trusted/artifact/base.tar');
    expect(commands[0]).toEqual([
      `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`,
      '--host',
      APPLE_VM_DAEMON_DOCKER_HOST,
      'image',
      'load',
      '--input',
      `${APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR}/base.tar`,
    ]);
    await expect(runtime.loadImageArchive('/trusted/artifact/subdir/base.tar')).rejects.toThrow(/direct child/u);
  });

  it('treats only an explicit image-not-found response as absence', async () => {
    const runtime = createAppleVmPrivateDockerRuntime({
      outerRuntime: execRuntime(() => ({ exitCode: 125, stdout: '', stderr: 'permission denied' })),
      containerId: 'outer-vm',
      hostArtifactDirectory: '/trusted/artifact',
      guestArtifactDirectory: APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR,
    });

    await expect(runtime.inspectImage('ironcurtain-base:latest')).rejects.toThrow(/image inspect failed/u);
  });

  it('rejects arbitrary commands, extra flags, and the wrong outer container', async () => {
    const runtime = createAppleVmPrivateDockerRuntime({
      outerRuntime: execRuntime(() => ({ exitCode: 0, stdout: '', stderr: '' })),
      containerId: 'outer-vm',
      hostArtifactDirectory: '/trusted/artifact',
      guestArtifactDirectory: APPLE_VM_SELECTED_AGENT_ARTIFACT_DIR,
    });

    await expect(runtime.exec('outer-vm', ['docker', 'pull', 'alpine'])).rejects.toThrow(/exact client-toolchain/u);
    await expect(runtime.exec('outer-vm', ['docker', 'version', '--format', '{{json .}}', '--debug'])).rejects.toThrow(
      /exact client-toolchain/u,
    );
    await expect(runtime.exec('wrong-vm', ['docker', 'buildx', 'version'])).rejects.toThrow(/container ID mismatch/u);
  });
});

function execRuntime(
  respond: (argv: readonly string[]) => DockerExecResult | Promise<DockerExecResult>,
): Pick<ContainerRuntime, 'exec'> {
  return {
    exec: async (_containerId, argv) => respond(argv),
  };
}
