import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBundleRuntimeRoot } from '../../src/config/paths.js';
import {
  buildDockerBuildShimMounts,
  removeBundleRuntimeRoot,
  stageDockerBuildShim,
} from '../../src/docker/docker-infrastructure.js';
import {
  DOCKER_BUILD_SHIM_PATH,
  DOCKER_BUILD_TRUST_CONTRACT_PATH,
  DOCKER_BUILD_TRUST_CA_CERT_PATH,
  DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
  DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
  DOCKER_BUILD_TRUST_REAL_RUNC_PATH,
  DOCKER_BUILD_TRUST_WRAPPER_PATH,
  getDockerBuildShimStagingContract,
  type DockerBuildTrustCanaryContract,
} from '../../src/docker/docker-build-shim.js';
import {
  preflightDockerBuildTrust,
  preflightDockerBuildShimAgent,
  type DockerBuildShimExec,
} from '../../src/docker-workload/docker-build-shim-preflight.js';
import type { BundleId } from '../../src/session/types.js';

const BUNDLE_ID = 'bundle-build-shim-lifecycle' as BundleId;
const CA_GENERATION = 'gen-00000000-0000-4000-8000-000000000000';
const canary: DockerBuildTrustCanaryContract = {
  caGeneration: CA_GENERATION,
  buildTrustContract: 'fixture-contract\n',
  caCertificate: 'fixture-cert\n',
  caBundle: 'fixture-bundle\n',
  aptConfig: 'fixture-apt\n',
};
const publicInputs = new Map([
  [DOCKER_BUILD_TRUST_CONTRACT_PATH, canary.buildTrustContract],
  [DOCKER_BUILD_TRUST_CA_CERT_PATH, canary.caCertificate],
  [DOCKER_BUILD_TRUST_CA_BUNDLE_PATH, canary.caBundle],
  [DOCKER_BUILD_TRUST_APT_CONFIG_PATH, canary.aptConfig],
]);
const success: DockerBuildShimExec = async (argv) => ({
  exitCode: 0,
  stdout:
    argv[0] === '/bin/cat'
      ? publicInputs.get(argv[1])!
      : argv[1] === '--ironcurtain-verify-protected-inputs-v2'
        ? 'ironcurtain-build-trust-inputs/2\n'
        : argv[1] === '--version'
          ? 'runc version 1.3.4\n'
          : argv[2] === 'command -v docker'
            ? `${DOCKER_BUILD_SHIM_PATH}\n`
            : '',
});
function executable(architecture: 'amd64' | 'arm64'): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(architecture === 'amd64' ? 62 : 183, 18);
  return bytes;
}

describe('package build-trust staging', () => {
  let home: string;
  let orientationDir: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ic-build-trust-'));
    previousHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    orientationDir = join(home, 'orientation');
    mkdirSync(orientationDir);
    for (const name of ['ca-cert.pem', 'ca-bundle.pem']) {
      writeFileSync(join(orientationDir, name), `fixture-${name}\n`, { mode: 0o444 });
      chmodSync(join(orientationDir, name), 0o444);
    }
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const options = () => ({
    orientationDir,
    caGeneration: CA_GENERATION,
    architecture: 'amd64' as const,
    runtimeKind: 'docker' as const,
    packageProxyUrl: 'http://127.0.0.1:18082',
    registryProxyUrl: 'http://127.0.0.1:18081',
    uid: 1101,
    gid: 1202,
  });
  it.each(['amd64', 'arm64'] as const)(
    'stages selected %s wrapper and host-public input contents atomically',
    (architecture) => {
      const staged = stageDockerBuildShim(BUNDLE_ID, 'packages', { ...options(), architecture })!;
      expect(staged.contract.shimArtifact.content).toContain(
        'ADMITTED_DOCKER_HOST=unix:///run/ironcurtain-docker/docker/docker.sock',
      );
      expect(staged.contract.writableDirectories.every(({ uid, gid }) => uid === 1101 && gid === 1202)).toBe(true);
      expect(
        staged.artifacts.every(({ source }) =>
          source.startsWith(`${getBundleRuntimeRoot(BUNDLE_ID)}/package-build-runtime/`),
        ),
      ).toBe(true);
      for (const artifact of staged.artifacts.filter(({ kind }) => kind.startsWith('build-trust-')))
        expect(lstatSync(artifact.source).nlink).toBe(1);
      const wrapper = staged.artifacts.find(({ kind }) => kind === 'build-trust-wrapper')!;
      expect(readFileSync(wrapper.source).readUInt16LE(18)).toBe(architecture === 'amd64' ? 62 : 183);
      expect(lstatSync(wrapper.source).mode & 0o777).toBe(0o555);
      const contract = staged.artifacts.find(({ kind }) => kind === 'build-trust-contract')!;
      expect(readFileSync(contract.source, 'utf8')).toBe(staged.buildTrustCanary.buildTrustContract);
      expect(JSON.parse(staged.buildTrustCanary.buildTrustContract)).toMatchObject({
        schemaVersion: 2,
        caGeneration: CA_GENERATION,
        realRunc: { requiresEffectiveReadOnly: true, version: '1.3.4' },
      });
      expect(staged.buildTrustCanary.buildTrustContract).not.toMatch(/sha256|ownerPairs/u);
      expect(staged.buildTrustCanary.caCertificate).toBe('fixture-ca-cert.pem\n');
      const mounts = buildDockerBuildShimMounts({ runtimeKind: 'apple-container', dockerBuildShim: staged });
      expect(mounts).toContainEqual({
        source: join(getBundleRuntimeRoot(BUNDLE_ID), 'package-build-runtime'),
        target: '/ironcurtain-build-trust',
        readonly: true,
      });
      expect(mounts).toHaveLength(3);
    },
  );
  it('requires a protected selected runtime leaf for Apple package builds', () => {
    expect(() => stageDockerBuildShim(BUNDLE_ID, 'packages', { ...options(), runtimeKind: 'apple-container' })).toThrow(
      /host-staged read-only real-runc/u,
    );
    const staged = stageDockerBuildShim(BUNDLE_ID, 'packages', {
      ...options(),
      runtimeKind: 'apple-container',
      protectedRealRunc: executable('amd64'),
    })!;
    expect(staged.contract.admittedDockerHost).toBe('unix:///run/ironcurtain-docker/docker.sock');
    expect(staged.contract.shimArtifact.content).toContain(
      'ADMITTED_DOCKER_HOST=unix:///run/ironcurtain-docker/docker.sock',
    );
    expect(staged.artifacts.find(({ kind }) => kind === 'build-trust-real-runc')).toMatchObject({
      target: DOCKER_BUILD_TRUST_REAL_RUNC_PATH,
      readonly: true,
    });
  });
  it('does not publish a partial generation on invalid executable architecture', () => {
    expect(() =>
      stageDockerBuildShim(BUNDLE_ID, 'packages', { ...options(), protectedRealRunc: executable('arm64') }),
    ).toThrow(/architecture/u);
    expect(readdirSync(getBundleRuntimeRoot(BUNDLE_ID))).toEqual([]);
  });
  it('rejects public input symlinks without publishing authority', () => {
    rmSync(join(orientationDir, 'ca-cert.pem'));
    symlinkSync('ca-bundle.pem', join(orientationDir, 'ca-cert.pem'));
    expect(() => stageDockerBuildShim(BUNDLE_ID, 'packages', options())).toThrow();
    expect(readdirSync(getBundleRuntimeRoot(BUNDLE_ID))).toEqual([]);
  });
  it('refuses to replace an existing complete generation', () => {
    const staged = stageDockerBuildShim(BUNDLE_ID, 'packages', options())!;
    expect(() => stageDockerBuildShim(BUNDLE_ID, 'packages', options())).toThrow(/already exists/u);
    expect(readFileSync(staged.artifacts[0].source, 'utf8')).toBe(staged.contract.shimArtifact.content);
    expect(readdirSync(getBundleRuntimeRoot(BUNDLE_ID))).toEqual(['package-build-runtime']);
  });
  it('rejects invalid generation identifiers and is absent outside package mode', () => {
    expect(() => stageDockerBuildShim(BUNDLE_ID, 'packages', { ...options(), caGeneration: 'bad' })).toThrow(
      /CA generation/u,
    );
    expect(stageDockerBuildShim(BUNDLE_ID, 'none', options())).toBeUndefined();
  });
  it('removes staged authority with the bundle runtime root', () => {
    const staged = stageDockerBuildShim(BUNDLE_ID, 'packages', options())!;
    removeBundleRuntimeRoot(BUNDLE_ID);
    expect(() => lstatSync(staged.artifacts[0].source)).toThrow(/ENOENT/u);
  });
});

describe('common protected build-trust preflight', () => {
  const contract = getDockerBuildShimStagingContract('packages', 'http://127.0.0.1:18082', 'http://127.0.0.1:18081', {
    architecture: 'arm64',
    dockerHost: 'unix:///run/ironcurtain-docker/docker.sock',
  })!;
  it('verifies exact public content, effective read-only inputs, then selected runtime compatibility', async () => {
    const calls: string[][] = [];
    await preflightDockerBuildTrust(
      async (argv, options) => {
        calls.push([...argv]);
        expect(options.user).toBe('0:0');
        return success(argv, options);
      },
      contract,
      canary,
    );
    expect(calls).toEqual(
      [...publicInputs.keys()]
        .map((path) => ['/bin/cat', path])
        .concat([
          [DOCKER_BUILD_TRUST_WRAPPER_PATH, '--ironcurtain-verify-protected-inputs-v2'],
          [DOCKER_BUILD_TRUST_WRAPPER_PATH, '--version'],
        ]),
    );
  });
  it.each([...publicInputs.keys()])('rejects mismatched %s before executing the wrapper', async (path) => {
    let executed = false;
    await expect(
      preflightDockerBuildTrust(
        async (argv, options) => {
          if (argv[0] === DOCKER_BUILD_TRUST_WRAPPER_PATH) executed = true;
          return argv[1] === path ? { exitCode: 0, stdout: 'wrong' } : success(argv, options);
        },
        contract,
        canary,
      ),
    ).rejects.toThrow(/differs from host staging/u);
    expect(executed).toBe(false);
  });
  it.each([
    [1, 'read-only verification failed', /effective read-only/u],
    [0, 'wrong protocol', /protocol mismatch/u],
  ] as const)('rejects failed protected-input protocol %s', async (exitCode, stdout, pattern) => {
    await expect(
      preflightDockerBuildTrust(
        async (argv, options) =>
          argv[1] === '--ironcurtain-verify-protected-inputs-v2' ? { exitCode, stdout } : success(argv, options),
        contract,
        canary,
      ),
    ).rejects.toThrow(pattern);
  });
  it('rejects incompatible selected runc', async () => {
    await expect(
      preflightDockerBuildTrust(
        async (argv, options) =>
          argv[1] === '--version' ? { exitCode: 0, stdout: 'runc version 0.1' } : success(argv, options),
        contract,
        canary,
      ),
    ).rejects.toThrow(/version mismatch/u);
  });
  it('bounds failure streams while retaining useful head and tail evidence', async () => {
    const error = await preflightDockerBuildShimAgent(
      async (argv, options) =>
        argv[0] === 'docker'
          ? { exitCode: 23, stdout: `STDOUT-${'界'.repeat(2000)}-TAIL`, stderr: `STDERR-${'🙂'.repeat(2000)}-TAIL` }
          : success(argv, options),
      contract,
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('[stdout] STDOUT-');
    expect(message).toContain('[stderr] STDERR-');
    expect(message.match(/-TAIL/gu)).toHaveLength(2);
    expect(message).not.toContain('\uFFFD');
    expect(Buffer.byteLength(message.slice(message.indexOf(': [') + 2))).toBeLessThanOrEqual(512);
  });
});
