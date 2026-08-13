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
 * bindings resolver — is mocked; the resolved-variant guard is mocked open exactly the
 * way the shipped seams are driven elsewhere (the fuse itself is covered by
 * test/docker/docker-workload-admission.test.ts and is untouched here).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import type {
  DockerWorkloadAdmissionOptions,
  DockerWorkloadBundleHandle,
} from '../../src/docker-workload/infrastructure.js';
import { loadDockerWorkloadLease } from '../../src/docker-workload/bundle-lease.js';
import { resolveDockerWorkloadConfig } from '../../src/docker-workload/config.js';
import type { BundleId } from '../../src/session/types.js';
import { createMockAdapter, createMockCA, createMockMitmProxy, createMockProxy } from '../helpers/docker-mocks.js';
import {
  ADMISSION_BINDINGS,
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
  bindings?: DockerWorkloadAdmissionOptions['bindings'];
  ca?: CertificateAuthority;
  handle?: DockerWorkloadBundleHandle;
  admissionOverrides: () => Partial<DockerWorkloadAdmissionOptions>;
  makeProxy: (socketPath: string) => DockerProxy;
  makeMitm: (options: MitmProxyOptions) => MitmProxy;
  stops: { proxy: number; mitm: number };
}

const seam = vi.hoisted<PrepareSeam>(() => ({
  admissionOverrides: () => ({}),
  makeProxy: () => {
    throw new Error('code-mode proxy double not installed');
  },
  makeMitm: () => {
    throw new Error('MITM proxy double not installed');
  },
  stops: { proxy: 0, mitm: 0 },
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

vi.mock('../../src/docker/code-mode-proxy.js', () => ({
  createCodeModeProxy: (options: { socketPath: string }) => seam.makeProxy(options.socketPath),
}));

vi.mock('../../src/docker/mitm-proxy.js', () => ({
  createMitmProxy: (options: MitmProxyOptions) => seam.makeMitm(options),
}));

// This test drives the post-admission seams with a qualifying Apple variant.
vi.mock('../../src/docker-workload/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker-workload/config.js')>()),
  assertDockerWorkloadVariantAdmitted: () => {},
  assertAdmittedDockerWorkloadRuntimeAvailable: async () => {},
}));

// The real resolver hashes the staged catalog + frozen profile ceiling, neither
// of which exists under the per-test IRONCURTAIN_HOME.
vi.mock('../../src/docker-workload/admission-bindings.js', () => ({
  resolveDockerWorkloadAdmissionBindings: () => seam.bindings,
}));

// This test fails before container assembly; use a path-only immutable-view
// double so it can focus on lease cleanup instead of catalog publication.
vi.mock('../../src/docker-workload/apple-private-docker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker-workload/apple-private-docker.js')>()),
  stageAppleVmDockerWorkloadBootstrap: () => ({
    hostCatalogDirectory: '/tmp/test-preloaded-catalog',
    guestCatalogDirectory: '/opt/ironcurtain/preloaded-catalog',
    outerAppleCatalogPath: '/tmp/test-preloaded-catalog/preloaded-catalog.apple-container.json',
    innerDockerCatalogPath: '/tmp/test-preloaded-catalog/preloaded-catalog.docker.json',
    selectedImageLogicalName: 'ironcurtain-claude-code:latest',
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
  seam.bindings = ADMISSION_BINDINGS;
  seam.ca = createMockCA(tempDir);
  seam.handle = undefined;
  seam.stops = { proxy: 0, mitm: 0 };
  seam.makeProxy = (socketPath: string): DockerProxy => ({
    ...createMockProxy(socketPath),
    async start() {
      // apple-container widens the socket mode after start(), so the path has
      // to exist on disk.
      writeFileSync(socketPath, '');
    },
    getHelpData() {
      throw new Error('scripted post-attestation failure');
    },
    async stop() {
      seam.stops.proxy += 1;
    },
  });
  seam.makeMitm = ({ socketPath, controlSocketPath }: MitmProxyOptions): MitmProxy => {
    return {
      ...createMockMitmProxy(),
      async start() {
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

async function prepare(imageIngress: 'preloaded-only' | 'public-registry' = 'preloaded-only'): Promise<unknown> {
  const workspaceDir = join(getHome(), 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  const config = {
    auditLogPath: join(tempDir, 'audit.jsonl'),
    mcpServers: {},
    userConfig: {
      modelProviders: { default: 'native', profiles: { native: { type: 'native' } } },
      dockerWorkload: resolveDockerWorkloadConfig({ enabled: true, imageIngress }),
      packageInstall: { enabled: false },
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
  );
}

describe('prepareDockerInfrastructure — Docker-workload lease teardown on failure (§8.3)', () => {
  it('stops the per-bundle registry listener when later preparation fails', async () => {
    const supervisor = installSupervisor(createFakeSupervisor({ clock: clock.clock, closeLeaseOnStop: true }));

    await expect(prepare('public-registry')).rejects.toThrow(/scripted post-attestation failure/u);

    expect(supervisor.calls.stopRequested).toBe(1);
    expect(loadDockerWorkloadLease(admittedHandle().leasePath).status).toBe('closed');
    expect(seam.stops).toEqual({ proxy: 1, mitm: 2 });
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
    expect(seam.stops).toEqual({ proxy: 1, mitm: 1 });
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
    expect(seam.stops).toEqual({ proxy: 1, mitm: 1 });
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
    expect(seam.stops).toEqual({ proxy: 1, mitm: 1 });
  });

  it('tears the lease down on attestation failure without masking the attestation error', async () => {
    // The launcher killed the rejected child, so the supervisor never answers
    // the stop request; teardown must close the lease as coordinator instead of
    // throwing over the original error.
    const supervisor = installSupervisor(createFakeSupervisor({ clock: clock.clock, launch: 'throw' }));

    await expect(prepare()).rejects.toThrow(/injected attestation failure/u);

    expect(supervisor.calls.launched).toBe(1);
    expect(loadDockerWorkloadLease(admittedHandle().leasePath).status).toBe('closed');
    expect(seam.stops).toEqual({ proxy: 1, mitm: 1 });
  });
});
