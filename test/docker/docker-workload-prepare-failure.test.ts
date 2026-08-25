/**
 * §8.3 regression: `prepareDockerInfrastructure` must not leak an admitted
 * Docker-workload lease when preparation fails.
 *
 * The two failure windows are NOT symmetric. A failed watchdog attestation is
 * self-healing — the supervisor launcher kills the child it rejected, so the
 * lease goes stale and crash reconciliation collects it. A failure AFTER a
 * successful attestation is not: the detached supervisor survives coordinator
 * exit by design and keeps its status fresh, so reconciliation PRESERVES the
 * lease forever. Only the explicit teardown in the prepare catch closes it.
 *
 * Both windows are driven here through the real `admitDockerWorkloadBundle`
 * (with the harness's fake clock/supervisor/runtime injected) so the assertion
 * is the on-disk lease status, not a spy. Everything the prepare path would
 * otherwise touch — adapter, container runtime, CA, both proxies, and the
 * selected artifact — is mocked; the resolved-variant guard is mocked open exactly the
 * way the shipped seams are driven elsewhere (the fuse itself is covered by
 * test/docker/docker-workload-admission.test.ts and is untouched here).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IronCurtainConfig } from '../../src/config/types.js';
import type { AgentAdapter, AgentId } from '../../src/docker/agent-adapter.js';
import type { AuthMethod } from '../../src/docker/oauth-credentials.js';
import type { CertificateAuthority } from '../../src/docker/ca.js';
import type { DockerProxy } from '../../src/docker/code-mode-proxy.js';
import type { MitmProxy, MitmProxyOptions } from '../../src/docker/mitm-proxy.js';
import type { ContainerRuntime } from '../../src/docker/types.js';
import type { AgentImageResolution } from '../../src/docker/docker-infrastructure.js';
import type {
  DockerWorkloadAdmissionOptions,
  DockerWorkloadBundleHandle,
} from '../../src/docker-workload/infrastructure.js';
import type { SelectedAgentArtifact } from '../../src/docker/selected-agent-artifact.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import { resolveDockerWorkloadConfig } from '../../src/docker-workload/config.js';
import {
  getBundlePackageEgressSocketPath,
  getBundleRegistryEgressSocketPath,
  getBundleRuntimeRoot,
} from '../../src/config/paths.js';
import type { BundleId } from '../../src/session/types.js';
import { createMockAdapter, createMockCA, createMockMitmProxy, createMockProxy } from '../helpers/docker-mocks.js';
import {
  createEventRuntime,
  createFakeClock,
  createFakeSupervisor,
  useDockerWorkloadHome,
  type EventRuntime,
  type FakeClock,
  type FakeSupervisor,
} from '../docker-workload/helpers/infrastructure-harness.js';

/** Doubles the hoisted `vi.mock` factories read at call time (installed per test). */
interface PrepareSeam {
  adapter?: AgentAdapter;
  runtime?: ContainerRuntime;
  artifact: SelectedAgentArtifact;
  prepareArtifactCalls: number;
  ca?: CertificateAuthority;
  handle?: DockerWorkloadBundleHandle;
  admissionOverrides: () => Partial<DockerWorkloadAdmissionOptions>;
  makeProxy: (socketPath: string) => DockerProxy;
  makeMitm: (options: MitmProxyOptions) => MitmProxy;
  publicStartError?: Error;
  publicReturnedSocketPath?: string;
  publicCreateSocket: boolean;
  stops: { proxy: number; mitm: number; public: number };
  lifecycle: string[];
  registrySocketPath?: string;
  publicSocketPath?: string;
  registrySocketMode?: number;
  publicSocketMode?: number;
}

const seam = vi.hoisted<PrepareSeam>(() => ({
  artifact: {
    logicalName: 'ironcurtain-claude-code:latest',
    buildHash: 'a'.repeat(64),
    architecture: 'arm64',
    appleImageId: `sha256:${'b'.repeat(64)}`,
    dockerImageId: `sha256:${'c'.repeat(64)}`,
    manifestDigest: `sha256:${'d'.repeat(64)}`,
    archivePath: '/tmp/test-selected-agent-artifact/selected-agent.oci.tar',
    archiveSha256: 'e'.repeat(64),
    archiveSizeBytes: 1,
  },
  prepareArtifactCalls: 0,
  admissionOverrides: () => ({}),
  makeProxy: () => {
    throw new Error('code-mode proxy double not installed');
  },
  makeMitm: () => {
    throw new Error('MITM proxy double not installed');
  },
  stops: { proxy: 0, mitm: 0, public: 0 },
  lifecycle: [],
  publicCreateSocket: true,
}));

vi.mock('../../src/docker/agent-registry.js', () => ({
  registerBuiltinAdapters: async () => {},
  getAgent: () => seam.adapter,
}));

vi.mock('../../src/docker/container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/container-runtime.js')>()),
  // apple-container is the only backend the nested daemon is implemented on, so
  // it is the only one a bundle can be admitted for.
  resolveRuntimeKind: async () => 'apple-container' as const,
  createContainerRuntime: () => seam.runtime,
}));

vi.mock('../../src/docker/ca.js', () => ({ loadOrCreateCA: () => seam.ca }));

vi.mock('../../src/docker/runtime-trust.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/docker/runtime-trust.js')>();
  return {
    ...actual,
    stageRuntimeTrust: (orientationDir: string) => {
      for (const [name, contents] of [
        ['ca-cert.pem', 'fixture-ca\n'],
        ['ca-bundle.pem', 'fixture-bundle\n'],
      ] as const) {
        const path = join(orientationDir, name);
        writeFileSync(path, contents, { mode: 0o444 });
      }
      return {
        schemaVersion: 1,
        generation: `runtime-trust-v1:${'1'.repeat(64)}`,
        containerCertificatePath: '/etc/ironcurtain/ca-cert.pem',
        containerBundlePath: '/etc/ironcurtain/ca-bundle.pem',
        caCertificateSha256: '1'.repeat(64),
        publicRootsSha256: '2'.repeat(64),
        bundleSha256: '3'.repeat(64),
        publicRootCount: 1,
      };
    },
  };
});

vi.mock('../../src/docker/code-mode-proxy.js', () => ({
  createCodeModeProxy: (options: { socketPath: string }) => seam.makeProxy(options.socketPath),
}));

vi.mock('../../src/docker/mitm-proxy.js', () => ({
  createMitmProxy: (options: MitmProxyOptions) => seam.makeMitm(options),
}));

vi.mock('../../src/docker/package-egress-proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/package-egress-proxy.js')>()),
  createPackageEgressProxy: () => {
    seam.lifecycle.push('construct-package');
    return {
      snapshot: {},
      async start(socketPath: string) {
        seam.lifecycle.push('bind-package');
        seam.publicSocketPath = socketPath;
        if (seam.publicStartError !== undefined) throw seam.publicStartError;
        if (seam.publicCreateSocket) writeFileSync(socketPath, '');
        return { socketPath: seam.publicReturnedSocketPath ?? socketPath };
      },
      async stop() {
        seam.stops.public += 1;
      },
    };
  },
}));

// This test drives the post-admission seams with a qualifying Apple variant.
vi.mock('../../src/docker-workload/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker-workload/config.js')>()),
  assertDockerWorkloadVariantAdmitted: () => {},
  assertAdmittedDockerWorkloadRuntimeAvailable: async () => {},
}));

// Image construction/export is not relevant to the post-admission cleanup
// windows exercised here. Return one internally consistent prepared artifact.
vi.mock('../../src/docker/selected-agent-artifact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/selected-agent-artifact.js')>()),
  prepareSelectedAgentArtifact: async (options: { logicalName: string; buildHash: string }) => {
    seam.prepareArtifactCalls += 1;
    return { ...seam.artifact, logicalName: options.logicalName, buildHash: options.buildHash };
  },
}));

// This test fails before container assembly; use a path-only immutable-view
// double so it can focus on lease cleanup instead of artifact publication.
vi.mock('../../src/docker-workload/apple-private-docker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker-workload/apple-private-docker.js')>()),
  stageAppleVmDockerWorkloadBootstrap: (options: { artifact: SelectedAgentArtifact }) => ({
    hostArtifactDirectory: '/tmp/test-selected-agent-artifact',
    guestArtifactDirectory: '/opt/ironcurtain/selected-agent-artifact',
    artifact: options.artifact,
    clientToolchainManifestPath: '/tmp/test-client-toolchain.json',
  }),
}));

// Real admission, real lease, real teardown — only the process-level injectables
// (clock, sleep, watchdog supervisor) are swapped for the harness fakes.
vi.mock('../../src/docker-workload/infrastructure.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/docker-workload/infrastructure.js')>();
  return {
    ...actual,
    admitDockerWorkloadBundle: async (options: DockerWorkloadAdmissionOptions) => {
      const handle = await actual.admitDockerWorkloadBundle({ ...options, ...seam.admissionOverrides() });
      seam.handle = handle;
      return handle;
    },
  };
});

const getHome = useDockerWorkloadHome();
const BUNDLE_ID = 'bundle-prepare-fail-1' as BundleId;

let tempDir: string;
let clock: FakeClock;
let runtime: EventRuntime;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'dw-prepare-fail-'));
  clock = createFakeClock();
  runtime = createEventRuntime();
  seam.adapter = failFastAdapter();
  seam.runtime = runtime.runtime;
  seam.ca = createMockCA(tempDir);
  seam.publicStartError = undefined;
  seam.publicReturnedSocketPath = undefined;
  seam.publicCreateSocket = true;
  seam.handle = undefined;
  seam.prepareArtifactCalls = 0;
  seam.stops = { proxy: 0, mitm: 0, public: 0 };
  seam.lifecycle = [];
  seam.registrySocketPath = undefined;
  seam.publicSocketPath = undefined;
  seam.registrySocketMode = undefined;
  seam.publicSocketMode = undefined;
  seam.makeProxy = (socketPath: string): DockerProxy => ({
    ...createMockProxy(socketPath),
    async start() {
      // apple-container widens the socket mode after start(), so the path has
      // to exist on disk.
      writeFileSync(socketPath, '');
    },
    getHelpData() {
      if (existsSync(getBundleRegistryEgressSocketPath(BUNDLE_ID))) {
        seam.registrySocketMode = statSync(getBundleRegistryEgressSocketPath(BUNDLE_ID)).mode & 0o777;
      }
      if (existsSync(getBundlePackageEgressSocketPath(BUNDLE_ID))) {
        seam.publicSocketMode = statSync(getBundlePackageEgressSocketPath(BUNDLE_ID)).mode & 0o777;
      }
      throw new Error('scripted post-attestation failure');
    },
    async stop() {
      seam.stops.proxy += 1;
    },
  });
  seam.makeMitm = ({ socketPath, controlSocketPath }: MitmProxyOptions): MitmProxy => {
    if (socketPath?.endsWith('/registry-egress.sock')) {
      seam.lifecycle.push('construct-registry');
      seam.registrySocketPath = socketPath;
    }
    return {
      ...createMockMitmProxy(),
      async start() {
        if (socketPath?.endsWith('/registry-egress.sock')) seam.lifecycle.push('bind-registry');
        if (socketPath !== undefined) writeFileSync(socketPath, '');
        return { socketPath, controlSocketPath };
      },
      async stop() {
        seam.stops.mitm += 1;
      },
    };
  };
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** Adapter that skips host credential detection and requests no providers. */
function failFastAdapter(): AgentAdapter {
  const apiKey: AuthMethod = { kind: 'apikey', key: 'sk-test' };
  return { ...createMockAdapter(), detectCredential: () => apiKey };
}

function installSupervisor(supervisor: FakeSupervisor): FakeSupervisor {
  seam.admissionOverrides = () => ({
    clock: clock.clock,
    sleep: clock.sleep,
    pidAlive: () => true,
    supervisor,
    startHeartbeat: false,
  });
  return supervisor;
}

function admittedHandle(): DockerWorkloadBundleHandle {
  const handle = seam.handle;
  if (handle === undefined) throw new Error('no Docker-workload bundle was admitted');
  return handle;
}

async function prepare(
  networkAccess: 'offline' | 'images' | 'packages' = 'offline',
  preparedImageResolution?: AgentImageResolution,
): Promise<unknown> {
  const workspaceDir = join(getHome(), 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  const config = {
    auditLogPath: join(tempDir, 'audit.jsonl'),
    mcpServers: {},
    userConfig: {
      modelProviders: { default: 'native', profiles: { native: { type: 'native' } } },
      dockerWorkload: resolveDockerWorkloadConfig({ enabled: true, networkAccess }),
      packageInstall: { enabled: false },
      statistics: { enabled: true, retentionDays: 90 },
      containerRuntime: 'auto',
    },
  } as unknown as IronCurtainConfig;

  const { prepareDockerInfrastructure } = await import('../../src/docker/docker-infrastructure.js');
  return prepareDockerInfrastructure(
    config,
    { kind: 'docker', agent: 'test-agent' as AgentId },
    join(tempDir, 'bundle'),
    workspaceDir,
    join(tempDir, 'escalations'),
    BUNDLE_ID,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { preparedImageResolution },
  );
}

describe('prepareDockerInfrastructure — Docker-workload lease teardown on failure (§8.3)', () => {
  it('threads the exact CLI-prepared artifact without resolving or exporting it again', async () => {
    const supervisor = installSupervisor(createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true }));
    const { computeAgentImageBuildHash } = await import('../../src/docker/docker-infrastructure.js');
    const buildHash = computeAgentImageBuildHash(seam.artifact.logicalName);
    const artifact = { ...seam.artifact, buildHash };

    await expect(
      prepare('offline', {
        mode: 'selected-agent-artifact',
        logicalName: artifact.logicalName,
        imageRef: artifact.logicalName,
        buildHash,
        immutableImageId: artifact.appleImageId,
        artifact,
      }),
    ).rejects.toThrow(/scripted post-attestation failure/u);

    expect(seam.prepareArtifactCalls).toBe(0);
    expect(supervisor.calls.stopRequested).toBe(1);
  });

  it('stops the per-bundle registry listener when later preparation fails', async () => {
    const supervisor = installSupervisor(createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true }));

    await expect(prepare('images')).rejects.toThrow(/scripted post-attestation failure/u);

    expect(supervisor.calls.stopRequested).toBe(1);
    expect(loadDockerWorkloadLease(admittedHandle().leasePath).status).toBe('closed');
    expect(seam.stops).toEqual({ proxy: 1, mitm: 2, public: 0 });
  });

  it('stops both constructed listeners when package listener binding fails', async () => {
    const supervisor = installSupervisor(createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true }));
    seam.publicStartError = new Error('scripted public listener bind failure');

    await expect(prepare('packages')).rejects.toThrow(/scripted public listener bind failure/u);

    expect(supervisor.calls.launched).toBe(0);
    expect(loadDockerWorkloadLease(admittedHandle().leasePath).status).toBe('closed');
    expect(seam.stops).toEqual({ proxy: 1, mitm: 1, public: 1 });
  });

  it('stops both listeners when package binding reports a different socket', async () => {
    installSupervisor(createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true }));
    seam.publicReturnedSocketPath = join(tempDir, 'wrong-public.sock');

    await expect(prepare('packages')).rejects.toThrow(/did not bind its exact per-bundle socket/u);

    expect(loadDockerWorkloadLease(admittedHandle().leasePath).status).toBe('closed');
    expect(seam.stops).toEqual({ proxy: 1, mitm: 1, public: 1 });
  });

  it('stops both listeners when the package socket cannot receive its guest mode', async () => {
    installSupervisor(createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true }));
    seam.publicCreateSocket = false;

    await expect(prepare('packages')).rejects.toThrow(/ENOENT|no such file/iu);

    expect(loadDockerWorkloadLease(admittedHandle().leasePath).status).toBe('closed');
    expect(seam.stops).toEqual({ proxy: 1, mitm: 1, public: 1 });
  });

  it('stops registry and package listeners when later packages-mode preparation fails', async () => {
    const supervisor = installSupervisor(createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true }));

    await expect(prepare('packages')).rejects.toThrow(/scripted post-attestation failure/u);

    expect(supervisor.calls.stopRequested).toBe(1);
    expect(loadDockerWorkloadLease(admittedHandle().leasePath).status).toBe('closed');
    expect(seam.stops).toEqual({ proxy: 1, mitm: 2, public: 1 });
    expect(seam.lifecycle.slice(0, 4)).toEqual([
      'construct-registry',
      'construct-package',
      'bind-registry',
      'bind-package',
    ]);
    expect(seam.registrySocketPath).toBe(getBundleRegistryEgressSocketPath(BUNDLE_ID));
    expect(seam.publicSocketPath).toBe(getBundlePackageEgressSocketPath(BUNDLE_ID));
    expect(seam.registrySocketMode).toBe(0o666);
    expect(seam.publicSocketMode).toBe(0o666);
    expect(existsSync(getBundleRuntimeRoot(BUNDLE_ID))).toBe(false);
  });

  it('tears down the staged lease when MITM startup fails before watchdog attestation', async () => {
    const supervisor = installSupervisor(createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true }));
    seam.makeMitm = (): MitmProxy => ({
      ...createMockMitmProxy(),
      async start() {
        throw new Error('scripted MITM pre-start failure');
      },
      async stop() {
        seam.stops.mitm += 1;
      },
    });

    await expect(prepare()).rejects.toThrow(/scripted MITM pre-start failure/u);

    expect(supervisor.calls.launched).toBe(0);
    expect(loadDockerWorkloadLease(admittedHandle().leasePath).status).toBe('closed');
    expect(seam.stops).toEqual({ proxy: 1, mitm: 1, public: 0 });
  });

  it('stops the started MITM and tears down the lease when Code Mode proxy startup fails', async () => {
    const supervisor = installSupervisor(createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true }));
    seam.makeProxy = (socketPath: string): DockerProxy => ({
      ...createMockProxy(socketPath),
      async start() {
        throw new Error('scripted Code Mode proxy startup failure');
      },
      async stop() {
        seam.stops.proxy += 1;
      },
    });

    await expect(prepare()).rejects.toThrow(/scripted Code Mode proxy startup failure/u);

    expect(supervisor.calls.launched).toBe(0);
    expect(loadDockerWorkloadLease(admittedHandle().leasePath).status).toBe('closed');
    expect(seam.stops).toEqual({ proxy: 1, mitm: 1, public: 0 });
  });

  it('tears the admitted lease down when a step AFTER attestation throws', async () => {
    // closeLeaseOnStop mirrors the live supervisor accepting the coordinator's
    // stop proof: a supervisor that is still healthy is exactly the case crash
    // reconciliation would NOT reclaim.
    const supervisor = installSupervisor(createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true }));

    await expect(prepare()).rejects.toThrow(/scripted post-attestation failure/u);

    // The failure really did land after a successful attestation.
    expect(supervisor.calls.launched).toBe(1);
    // Teardown ran the stop handshake and the lease is closed, not left
    // `admitting` for a reconciliation pass that would preserve it.
    expect(supervisor.calls.stopRequested).toBe(1);
    expect(loadDockerWorkloadLease(admittedHandle().leasePath).status).toBe('closed');
    // The proxy cleanup that already existed still runs.
    expect(seam.stops).toEqual({ proxy: 1, mitm: 1, public: 0 });
  });

  it('tears the lease down on attestation failure without masking the attestation error', async () => {
    // The launcher killed the rejected child, so the supervisor never answers
    // the stop request; teardown must close the lease as coordinator instead of
    // throwing over the original error.
    const supervisor = installSupervisor(createFakeSupervisor({ clock: clock.clock, launch: 'throw' }));

    await expect(prepare()).rejects.toThrow(/injected attestation failure/u);

    expect(supervisor.calls.launched).toBe(1);
    expect(loadDockerWorkloadLease(admittedHandle().leasePath).status).toBe('closed');
    expect(seam.stops).toEqual({ proxy: 1, mitm: 1, public: 0 });
  });
});
