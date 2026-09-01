import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBundleRuntimeRoot } from '../../src/config/paths.js';
import {
  buildDockerBuildShimMounts,
  removeBundleRuntimeRoot,
  stageDockerBuildShim,
  type DockerBuildShimStagedArtifact,
} from '../../src/docker/docker-infrastructure.js';
import {
  DOCKER_BUILD_SHIM_PATH,
  DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY,
  DOCKER_BUILD_TRUST_CONTRACT_PATH,
  DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
  DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
  DOCKER_BUILD_TRUST_CA_CERT_PATH,
  DOCKER_BUILD_TRUST_REAL_RUNC_PATH,
  DOCKER_BUILD_TRUST_REAL_RUNC_SHA256,
  DOCKER_BUILD_TRUST_REAL_RUNC_SIZE,
  DOCKER_BUILD_TRUST_WRAPPER_PATH,
  DOCKER_BUILD_TRUST_WRAPPER_SHA256,
  DOCKER_BUILDX_INSTANCES_DIRECTORY,
  DOCKER_BUILDX_STATE_DIRECTORY,
  getDockerBuildShimStagingContract,
} from '../../src/docker/docker-build-shim.js';
import type { BundleId } from '../../src/session/types.js';
import { preflightAppleVmDockerBuildShim } from '../../src/docker-workload/session-daemon.js';
import type { AppleVmDaemonExec } from '../../src/docker-workload/apple-vm-daemon.js';

const BUNDLE_ID = 'bundle-build-shim-lifecycle' as BundleId;
const CA_GENERATION = 'gen-00000000-0000-4000-8000-000000000000';
const APPLE_PACKAGE_PROXY_URL = 'http://127.0.0.1:18082';
const APPLE_REGISTRY_PROXY_URL = 'http://127.0.0.1:18081';
const BUILD_TRUST_CANARY = {
  caGeneration: CA_GENERATION,
  buildTrustContractSha256: '4'.repeat(64),
  caCertificateSha256: '1'.repeat(64),
  caBundleSha256: '2'.repeat(64),
  aptConfigSha256: '3'.repeat(64),
} as const;

const successfulBuildShimPreflightExec: AppleVmDaemonExec = async (argv) => {
  if (argv[0] === '/usr/bin/stat') {
    if (argv[2] === DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY) {
      return { exitCode: 0, stdout: 'directory:0:0:755\n' };
    }
    if (argv[2] === DOCKER_BUILD_TRUST_CONTRACT_PATH) {
      return { exitCode: 0, stdout: 'regular file:1000:1000:444:1\n' };
    }
    if (argv[2] === DOCKER_BUILD_TRUST_REAL_RUNC_PATH) {
      return { exitCode: 0, stdout: `regular file:0:0:755:1:${DOCKER_BUILD_TRUST_REAL_RUNC_SIZE}\n` };
    }
    return { exitCode: 0, stdout: 'directory:1000:1000:700\n' };
  }
  if (argv[0] === '/bin/sh') {
    return {
      exitCode: 0,
      stdout: argv[2] === 'command -v docker' ? `${DOCKER_BUILD_SHIM_PATH}\n` : `${DOCKER_BUILD_TRUST_WRAPPER_PATH}\n`,
    };
  }
  if (argv[0] === '/usr/bin/sha256sum') {
    if (argv[1] === DOCKER_BUILD_TRUST_CONTRACT_PATH) {
      return {
        exitCode: 0,
        stdout: `${BUILD_TRUST_CANARY.buildTrustContractSha256}  ${DOCKER_BUILD_TRUST_CONTRACT_PATH}\n`,
      };
    }
    if (argv[1] === DOCKER_BUILD_TRUST_REAL_RUNC_PATH) {
      return {
        exitCode: 0,
        stdout: `${DOCKER_BUILD_TRUST_REAL_RUNC_SHA256}  ${DOCKER_BUILD_TRUST_REAL_RUNC_PATH}\n`,
      };
    }
    return { exitCode: 0, stdout: `${DOCKER_BUILD_TRUST_WRAPPER_SHA256}  ${DOCKER_BUILD_TRUST_WRAPPER_PATH}\n` };
  }
  if (argv[0] === DOCKER_BUILD_TRUST_WRAPPER_PATH) return { exitCode: 0, stdout: 'runc version 1.3.4\n' };
  return { exitCode: 0, stdout: argv[0] === 'docker' ? '{"Version":"29.2.1"}\n' : '' };
};

describe('package Docker build shim lifecycle staging', () => {
  let home: string;
  let orientationDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-build-shim-lifecycle-'));
    previousHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    orientationDir = join(home, 'orientation');
    mkdirSync(orientationDir, { recursive: true });
    for (const name of ['ca-cert.pem', 'ca-bundle.pem']) {
      const path = join(orientationDir, name);
      writeFileSync(path, `fixture-${name}\n`, { mode: 0o444 });
      chmodSync(path, 0o444);
    }
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('stages exact hardened files under the bundle runtime root and emits shared Apple mounts', () => {
    const staged = stageDockerBuildShim(BUNDLE_ID, 'packages', {
      orientationDir,
      caGeneration: CA_GENERATION,
      packageProxyUrl: APPLE_PACKAGE_PROXY_URL,
      registryProxyUrl: APPLE_REGISTRY_PROXY_URL,
    });
    const contract = getDockerBuildShimStagingContract('packages', APPLE_PACKAGE_PROXY_URL, APPLE_REGISTRY_PROXY_URL);
    expect(staged).toBeDefined();
    expect(contract).toBeDefined();
    const staging = staged!;
    const artifact = (kind: DockerBuildShimStagedArtifact['kind']) => {
      const found = staging.artifacts.find((candidate) => candidate.kind === kind);
      expect(found).toBeDefined();
      return found!;
    };
    const shim = artifact('docker-shim');
    const proxyConfig = artifact('proxy-config');
    const buildTrustContract = artifact('build-trust-contract');
    const caCertificate = artifact('build-trust-ca-cert');
    const caBundle = artifact('build-trust-ca-bundle');
    const aptConfig = artifact('build-trust-apt-config');
    expect(staging.artifacts.every(({ source }) => source.startsWith(`${getBundleRuntimeRoot(BUNDLE_ID)}/`))).toBe(
      true,
    );
    expect(
      staging.artifacts.every(({ source }) =>
        source.startsWith(join(getBundleRuntimeRoot(BUNDLE_ID), 'package-build-runtime')),
      ),
    ).toBe(true);
    expect(lstatSync(shim.source).mode & 0o777).toBe(0o555);
    expect(lstatSync(join(proxyConfig.source, 'config.json')).mode & 0o777).toBe(0o444);
    expect(lstatSync(proxyConfig.source).mode & 0o777).toBe(0o755);
    expect(lstatSync(buildTrustContract.source).mode & 0o777).toBe(0o444);
    expect(lstatSync(buildTrustContract.source).nlink).toBe(1);
    expect([caCertificate, caBundle, aptConfig].map(({ target }) => target)).toEqual([
      DOCKER_BUILD_TRUST_CA_CERT_PATH,
      DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
      DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
    ]);
    expect([caCertificate, caBundle, aptConfig].every(({ source }) => (lstatSync(source).mode & 0o777) === 0o444)).toBe(
      true,
    );
    expect(readFileSync(caCertificate.source, 'utf8')).toBe('fixture-ca-cert.pem\n');
    expect(readFileSync(caBundle.source, 'utf8')).toBe('fixture-ca-bundle.pem\n');
    expect(() => lstatSync(join(orientationDir, 'apt.conf'))).toThrow(/ENOENT/u);
    expect(readdirSync(proxyConfig.source)).toEqual(['config.json']);
    expect(readFileSync(shim.source, 'utf8')).toBe(contract!.shimArtifact.content);
    expect(readFileSync(join(proxyConfig.source, 'config.json'), 'utf8')).toBe(contract!.proxyConfigArtifact.content);
    expect(JSON.parse(readFileSync(buildTrustContract.source, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      caGeneration: CA_GENERATION,
    });
    expect(staging.buildTrustCanary).toMatchObject({
      caGeneration: CA_GENERATION,
      buildTrustContractSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(staging.buildTrustCanary.buildTrustContractSha256).toBe(
      createHash('sha256').update(readFileSync(buildTrustContract.source)).digest('hex'),
    );
    expect(buildDockerBuildShimMounts({ runtimeKind: 'apple-container', dockerBuildShim: staging })).toEqual(
      staging.artifacts.map(({ source, target, readonly }) => ({ source, target, readonly })),
    );
    const trustMounts = buildDockerBuildShimMounts({ runtimeKind: 'apple-container', dockerBuildShim: staging }).filter(
      ({ target }) => target.startsWith(`${DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY}/`),
    );
    expect(trustMounts).toHaveLength(4);
    expect(trustMounts.every(({ source, readonly }) => lstatSync(source).isFile() && readonly)).toBe(true);
  });

  it('is completely absent outside packages mode', () => {
    expect(stageDockerBuildShim(BUNDLE_ID, 'offline', { orientationDir, caGeneration: CA_GENERATION })).toBeUndefined();
    expect(stageDockerBuildShim(BUNDLE_ID, 'images', { orientationDir, caGeneration: CA_GENERATION })).toBeUndefined();
    expect(buildDockerBuildShimMounts({ runtimeKind: 'apple-container', dockerBuildShim: undefined })).toEqual([]);
  });

  it('emits the exact root and integrity schema accepted by the Go runtime fixture', () => {
    const staged = stageDockerBuildShim(BUNDLE_ID, 'packages', {
      orientationDir,
      caGeneration: CA_GENERATION,
      packageProxyUrl: APPLE_PACKAGE_PROXY_URL,
      registryProxyUrl: APPLE_REGISTRY_PROXY_URL,
    })!;
    const buildTrustContract = staged.artifacts.find(({ kind }) => kind === 'build-trust-contract');
    expect(buildTrustContract).toBeDefined();
    const generated = JSON.parse(readFileSync(buildTrustContract!.source, 'utf8')) as Record<string, unknown>;
    const fixture = JSON.parse(
      readFileSync(
        join(process.cwd(), 'docker/build-trust-runtime/testdata/synthetic-build-trust-contract.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;

    const schemaShape = (contract: Record<string, unknown>) => {
      const realRunc = contract.realRunc as Record<string, unknown>;
      const publicSources = contract.publicSources as readonly Record<string, unknown>[];
      return {
        root: Object.keys(contract).sort(),
        realRunc: Object.keys(realRunc).sort(),
        publicSources: publicSources.map((source) => Object.keys(source).sort()),
      };
    };
    expect(schemaShape(generated)).toEqual(schemaShape(fixture));
    expect(generated.caGeneration).toBe(fixture.caGeneration);

    const qualifiedValues = (contract: Record<string, unknown>) => {
      const realRunc = contract.realRunc as Record<string, unknown>;
      const publicSources = contract.publicSources as readonly Record<string, unknown>[];
      return {
        schemaVersion: contract.schemaVersion,
        realRunc: {
          path: realRunc.path,
          ownerPairs: realRunc.ownerPairs,
          nlink: realRunc.nlink,
          mode: realRunc.mode,
          version: realRunc.version,
        },
        publicSources: publicSources.map(({ path, destination, mode }) => ({
          path,
          destination,
          mode,
        })),
      };
    };
    expect(qualifiedValues(generated)).toEqual(qualifiedValues(fixture));
  });

  it('rejects an unauthenticated CA generation before staging package authority', () => {
    expect(() =>
      stageDockerBuildShim(BUNDLE_ID, 'packages', {
        orientationDir,
        caGeneration: 'legacy-flat-pair',
        packageProxyUrl: APPLE_PACKAGE_PROXY_URL,
        registryProxyUrl: APPLE_REGISTRY_PROXY_URL,
      }),
    ).toThrow(/authenticated CA generation/u);
  });

  it('is removed with the exact bundle runtime root', () => {
    const staged = stageDockerBuildShim(BUNDLE_ID, 'packages', {
      orientationDir,
      caGeneration: CA_GENERATION,
      packageProxyUrl: APPLE_PACKAGE_PROXY_URL,
      registryProxyUrl: APPLE_REGISTRY_PROXY_URL,
    });
    expect(staged).toBeDefined();
    removeBundleRuntimeRoot(BUNDLE_ID, 'test');
    expect(() => lstatSync(getBundleRuntimeRoot(BUNDLE_ID))).toThrow(/ENOENT/u);
  });
});

describe('package Docker build shim in-VM preflight', () => {
  it('fails before reading the contract when its trusted parent is not root-owned', async () => {
    const contract = getDockerBuildShimStagingContract('packages', APPLE_PACKAGE_PROXY_URL, APPLE_REGISTRY_PROXY_URL)!;
    const calls: string[][] = [];
    const exec: AppleVmDaemonExec = async (argv, options) => {
      calls.push([...argv]);
      if (argv[0] === '/usr/bin/stat' && argv[2] === DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY) {
        return { exitCode: 0, stdout: 'directory:1000:1000:755\n' };
      }
      return successfulBuildShimPreflightExec(argv, options);
    };

    await expect(preflightAppleVmDockerBuildShim(exec, contract, BUILD_TRUST_CANARY)).rejects.toThrow(
      /contract parent metadata was "directory:1000:1000:755"/u,
    );
    expect(calls).not.toContainEqual(['/usr/bin/stat', '--format=%F:%u:%g:%a:%h', DOCKER_BUILD_TRUST_CONTRACT_PATH]);
    expect(calls).not.toContainEqual([DOCKER_BUILD_TRUST_WRAPPER_PATH, '--version']);
  });

  it('treats namespace-translated trust-contract owners as bounded diagnostics only', async () => {
    const contract = getDockerBuildShimStagingContract('packages', APPLE_PACKAGE_PROXY_URL, APPLE_REGISTRY_PROXY_URL)!;
    for (const owner of ['0:0', '1000:1000', '65534:65534', '12345:54321']) {
      const calls: string[][] = [];
      const exec: AppleVmDaemonExec = async (argv, options) => {
        calls.push([...argv]);
        if (argv[0] === '/usr/bin/stat' && argv[2] === DOCKER_BUILD_TRUST_CONTRACT_PATH) {
          return { exitCode: 0, stdout: `regular file:${owner}:444:1\n` };
        }
        return successfulBuildShimPreflightExec(argv, options);
      };

      await expect(preflightAppleVmDockerBuildShim(exec, contract, BUILD_TRUST_CANARY)).resolves.toBeUndefined();
      expect(calls).toContainEqual([DOCKER_BUILD_TRUST_WRAPPER_PATH, '--version']);
    }
  });

  it('fails before wrapper handoff when trust-contract metadata authority drifts', async () => {
    const contract = getDockerBuildShimStagingContract('packages', APPLE_PACKAGE_PROXY_URL, APPLE_REGISTRY_PROXY_URL)!;
    const calls: string[][] = [];
    const exec: AppleVmDaemonExec = async (argv, options) => {
      calls.push([...argv]);
      if (argv[0] === '/usr/bin/stat' && argv[2] === DOCKER_BUILD_TRUST_CONTRACT_PATH) {
        return { exitCode: 0, stdout: 'regular file:12345:54321:644:1\n' };
      }
      return successfulBuildShimPreflightExec(argv, options);
    };

    await expect(preflightAppleVmDockerBuildShim(exec, contract, BUILD_TRUST_CANARY)).rejects.toThrow(
      /contract metadata was "regular file:12345:54321:644:1".*UID\/GID are diagnostic only/u,
    );
    expect(calls).not.toContainEqual([DOCKER_BUILD_TRUST_WRAPPER_PATH, '--version']);
  });

  it('fails before wrapper handoff when the mounted trust-contract digest drifts', async () => {
    const contract = getDockerBuildShimStagingContract('packages', APPLE_PACKAGE_PROXY_URL, APPLE_REGISTRY_PROXY_URL)!;
    const calls: string[][] = [];
    const exec: AppleVmDaemonExec = async (argv, options) => {
      calls.push([...argv]);
      if (argv[0] === '/usr/bin/sha256sum' && argv[1] === DOCKER_BUILD_TRUST_CONTRACT_PATH) {
        return { exitCode: 0, stdout: `${'0'.repeat(64)}  ${DOCKER_BUILD_TRUST_CONTRACT_PATH}\n` };
      }
      return successfulBuildShimPreflightExec(argv, options);
    };

    await expect(preflightAppleVmDockerBuildShim(exec, contract, BUILD_TRUST_CANARY)).rejects.toThrow(
      /contract failed its guest digest check/u,
    );
    expect(calls).not.toContainEqual([DOCKER_BUILD_TRUST_WRAPPER_PATH, '--version']);
  });

  it('assigns trusted state to codespace before resolving the exact Apple PATH and runtime', async () => {
    const contract = getDockerBuildShimStagingContract('packages', APPLE_PACKAGE_PROXY_URL, APPLE_REGISTRY_PROXY_URL)!;
    const calls: { argv: readonly string[]; options: Parameters<AppleVmDaemonExec>[1] }[] = [];
    const exec: AppleVmDaemonExec = async (argv, options) => {
      calls.push({ argv, options });
      if (argv[0] === '/usr/bin/stat') {
        if (argv[2] === DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY) {
          return { exitCode: 0, stdout: 'directory:0:0:755\n' };
        }
        if (argv[2] === DOCKER_BUILD_TRUST_CONTRACT_PATH) {
          return { exitCode: 0, stdout: 'regular file:1000:1000:444:1\n' };
        }
        if (argv[2] === DOCKER_BUILD_TRUST_REAL_RUNC_PATH) {
          return { exitCode: 0, stdout: `regular file:0:0:755:1:${DOCKER_BUILD_TRUST_REAL_RUNC_SIZE}\n` };
        }
        return { exitCode: 0, stdout: 'directory:1000:1000:700\n' };
      }
      if (argv[0] === '/bin/sh') {
        return {
          exitCode: 0,
          stdout:
            argv[2] === 'command -v docker' ? `${DOCKER_BUILD_SHIM_PATH}\n` : `${DOCKER_BUILD_TRUST_WRAPPER_PATH}\n`,
        };
      }
      if (argv[0] === '/usr/bin/sha256sum') {
        if (argv[1] === DOCKER_BUILD_TRUST_CONTRACT_PATH) {
          return {
            exitCode: 0,
            stdout: `${BUILD_TRUST_CANARY.buildTrustContractSha256}  ${DOCKER_BUILD_TRUST_CONTRACT_PATH}\n`,
          };
        }
        if (argv[1] === DOCKER_BUILD_TRUST_REAL_RUNC_PATH) {
          return {
            exitCode: 0,
            stdout: `${DOCKER_BUILD_TRUST_REAL_RUNC_SHA256}  ${DOCKER_BUILD_TRUST_REAL_RUNC_PATH}\n`,
          };
        }
        return { exitCode: 0, stdout: `${DOCKER_BUILD_TRUST_WRAPPER_SHA256}  ${DOCKER_BUILD_TRUST_WRAPPER_PATH}\n` };
      }
      if (argv[0] === DOCKER_BUILD_TRUST_WRAPPER_PATH) {
        return { exitCode: 0, stdout: 'runc version 1.3.4\n', stderr: 'ignored success diagnostic\n' };
      }
      return { exitCode: 0, stdout: argv[0] === 'docker' ? '{"Version":"29.2.1"}\n' : '' };
    };

    await preflightAppleVmDockerBuildShim(exec, contract, BUILD_TRUST_CANARY);

    expect(calls.map(({ argv }) => argv)).toEqual([
      [
        '/bin/sh',
        '-c',
        expect.stringMatching(/\[ ! -L "\$path" \].*mkdir.*\[ -d "\$path" \].*chown.*chmod/su),
        'ironcurtain-build-state-init',
        DOCKER_BUILDX_STATE_DIRECTORY,
        '1000',
        '1000',
        '700',
        DOCKER_BUILDX_INSTANCES_DIRECTORY,
        '1000',
        '1000',
        '700',
      ],
      [
        '/bin/sh',
        '-c',
        expect.stringMatching(/stat --format=%F:%u:%g:%a.*: > "\$probe".*rm -- "\$probe"/su),
        'ironcurtain-build-state-verify',
        DOCKER_BUILDX_STATE_DIRECTORY,
        'directory:1000:1000:700',
        DOCKER_BUILDX_INSTANCES_DIRECTORY,
        'directory:1000:1000:700',
      ],
      ['/bin/sh', '-c', 'command -v docker'],
      ['docker', 'version', '--format', '{{json .Client}}'],
      ['/bin/sh', '-c', 'command -v runc'],
      ['/usr/bin/sha256sum', DOCKER_BUILD_TRUST_WRAPPER_PATH],
      ['/usr/bin/stat', '--format=%F:%u:%g:%a', DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY],
      ['/usr/bin/stat', '--format=%F:%u:%g:%a:%h', DOCKER_BUILD_TRUST_CONTRACT_PATH],
      ['/usr/bin/sha256sum', DOCKER_BUILD_TRUST_CONTRACT_PATH],
      ['/usr/bin/stat', '--format=%F:%u:%g:%a:%h:%s', DOCKER_BUILD_TRUST_REAL_RUNC_PATH],
      ['/usr/bin/sha256sum', DOCKER_BUILD_TRUST_REAL_RUNC_PATH],
      [DOCKER_BUILD_TRUST_WRAPPER_PATH, '--version'],
    ]);
    expect(calls.map(({ options }) => options.user)).toEqual([
      '0:0',
      'codespace',
      'codespace',
      'codespace',
      'codespace',
      'codespace',
      'codespace',
      'codespace',
      'codespace',
      'codespace',
      'codespace',
      '0:0',
    ]);
    expect(calls.every(({ options }) => options.timeoutMs > 0)).toBe(true);
  });

  it('rejects a version failure after successful PATH identity without continuing', async () => {
    const contract = getDockerBuildShimStagingContract('packages', APPLE_PACKAGE_PROXY_URL, APPLE_REGISTRY_PROXY_URL)!;
    const exec: AppleVmDaemonExec = async (argv) => {
      if (argv[0] === '/usr/bin/stat') return { exitCode: 0, stdout: 'directory:1000:1000:700\n' };
      if (argv[0] === '/bin/sh') return { exitCode: 0, stdout: `${DOCKER_BUILD_SHIM_PATH}\n` };
      if (argv[0] === 'docker') {
        return { exitCode: 23, stdout: 'client unavailable', stderr: 'trusted client detail' };
      }
      return { exitCode: 0, stdout: '' };
    };

    await expect(preflightAppleVmDockerBuildShim(exec, contract, BUILD_TRUST_CANARY)).rejects.toThrow(
      /version preflight failed with exit code 23: \[stdout\] client unavailable; \[stderr\] trusted client detail/u,
    );
  });

  it('fails before wrapper handoff when selected-image real-runc metadata drifts', async () => {
    const contract = getDockerBuildShimStagingContract('packages', APPLE_PACKAGE_PROXY_URL, APPLE_REGISTRY_PROXY_URL)!;
    const calls: string[][] = [];
    const exec: AppleVmDaemonExec = async (argv) => {
      calls.push([...argv]);
      if (argv[0] === '/usr/bin/stat') {
        if (argv[2] === DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY) {
          return { exitCode: 0, stdout: 'directory:0:0:755\n' };
        }
        if (argv[2] === DOCKER_BUILD_TRUST_CONTRACT_PATH) {
          return { exitCode: 0, stdout: 'regular file:1000:1000:444:1\n' };
        }
        return {
          exitCode: 0,
          stdout:
            argv[2] === DOCKER_BUILD_TRUST_REAL_RUNC_PATH
              ? `regular file:1000:1000:755:1:${DOCKER_BUILD_TRUST_REAL_RUNC_SIZE}\n`
              : 'directory:1000:1000:700\n',
        };
      }
      if (argv[0] === '/bin/sh') {
        return {
          exitCode: 0,
          stdout:
            argv[2] === 'command -v docker' ? `${DOCKER_BUILD_SHIM_PATH}\n` : `${DOCKER_BUILD_TRUST_WRAPPER_PATH}\n`,
        };
      }
      if (argv[0] === '/usr/bin/sha256sum') {
        if (argv[1] === DOCKER_BUILD_TRUST_CONTRACT_PATH) {
          return {
            exitCode: 0,
            stdout: `${BUILD_TRUST_CANARY.buildTrustContractSha256}  ${DOCKER_BUILD_TRUST_CONTRACT_PATH}\n`,
          };
        }
        return { exitCode: 0, stdout: `${DOCKER_BUILD_TRUST_WRAPPER_SHA256}  ${DOCKER_BUILD_TRUST_WRAPPER_PATH}\n` };
      }
      return { exitCode: 0, stdout: '' };
    };

    await expect(preflightAppleVmDockerBuildShim(exec, contract, BUILD_TRUST_CANARY)).rejects.toThrow(
      /real-runc metadata was "regular file:1000:1000/u,
    );
    expect(calls).not.toContainEqual([DOCKER_BUILD_TRUST_WRAPPER_PATH, '--version']);
  });

  it('bounds combined failure output while retaining the head and tail of both channels', async () => {
    const contract = getDockerBuildShimStagingContract('packages', APPLE_PACKAGE_PROXY_URL, APPLE_REGISTRY_PROXY_URL)!;
    const exec: AppleVmDaemonExec = async (argv) => {
      if (argv[0] === '/usr/bin/stat') return { exitCode: 0, stdout: 'directory:1000:1000:700\n' };
      if (argv[0] === '/bin/sh') return { exitCode: 0, stdout: `${DOCKER_BUILD_SHIM_PATH}\n` };
      if (argv[0] === 'docker') {
        return {
          exitCode: 23,
          stdout: `STDOUT-MARKER-${'界'.repeat(2_000)}-UNBOUNDED-TAIL`,
          stderr: `STDERR-MARKER-${'🙂'.repeat(2_000)}-UNBOUNDED-TAIL`,
        };
      }
      return { exitCode: 0, stdout: '' };
    };

    const error = await preflightAppleVmDockerBuildShim(exec, contract, BUILD_TRUST_CANARY).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('[stdout] STDOUT-MARKER-');
    expect(message).toContain('[stderr] STDERR-MARKER-');
    expect(message.match(/UNBOUNDED-TAIL/gu)).toHaveLength(2);
    expect(message).not.toContain('\uFFFD');
    const diagnostic = message.slice(message.indexOf(': [') + 2);
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(message)).toBeLessThan(640);
  });
});
