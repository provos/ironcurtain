/** Host-only, test-only observation of the live sidecar's exact leased state. */
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadDockerWorkloadLease, type DockerWorkloadLease } from '../src/docker-workload/bundle-lease.js';
import { createQualificationObserverContainer } from '../src/docker-workload/qualification-observer.js';
import { PRIVATE_DOCKER_API_DIR } from '../src/docker-workload/private-docker.js';
import { DOCKER_AGENT_VOLUME_SHADOW } from '../src/docker/docker-agent-volume-shadow.js';
import type { ContainerRuntime, DockerMount } from '../src/docker/types.js';

const TRUST_ROOT = '/ironcurtain-build-trust';
const PROBE_TARGET = '/probe.py';
const HELPER_STATE_TARGET = '/home/codespace/.local/share';
const MAX_OBSERVATION_MS = 315_000;
const TRUST_LEAVES = ['build-trust-contract.json', 'ca-cert.pem', 'ca-bundle.pem', 'apt.conf'] as const;
const SNAPSHOT_PROTOCOL = 'IRONCURTAIN_SNAPSHOT_SCAN_BEGIN/1\nIRONCURTAIN_SNAPSHOT_SCAN_OK/1\n';
type ObservationAction = 'public-trust' | 'snapshot';

export function parseHostObservationRequest(value: unknown): { action: ObservationAction; nonce: string } {
  const request = object(value, 'request');
  if (
    Object.keys(request).sort().join(',') !== 'action,nonce,schemaVersion' ||
    request.schemaVersion !== 1 ||
    (request.action !== 'public-trust' && request.action !== 'snapshot') ||
    typeof request.nonce !== 'string' ||
    !/^[0-9a-f]{32}$/.test(request.nonce)
  )
    throw new Error('invalid fixed host observation request');
  return { action: request.action, nonce: request.nonce };
}

function object(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${description}`);
  return value as Record<string, unknown>;
}

function readBoundedFile(path: string, maximumSize: number): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximumSize) {
    throw new Error(`observation input is not a bounded regular file: ${path}`);
  }
  const result = readFileSync(path, 'utf8');
  const after = lstatSync(path);
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    Buffer.byteLength(result) !== after.size
  ) {
    throw new Error('observation input changed while reading');
  }
  return result;
}

type HelperMountIdentity = {
  readonly type: 'bind' | 'volume';
  readonly source: string;
  readonly target: string;
  readonly readonly: boolean;
};

function sortedHelperMounts(mounts: readonly HelperMountIdentity[]): readonly HelperMountIdentity[] {
  return [...mounts].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function normalizedTmpfsOptions(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const options = value.split(',');
  if (options.some((option) => option.length === 0) || new Set(options).size !== options.length) return undefined;
  return options.sort().join(',');
}

function hasExactAgentVolumeShadow(hostConfig: Record<string, unknown>): boolean {
  if (hostConfig.Tmpfs === null || typeof hostConfig.Tmpfs !== 'object' || Array.isArray(hostConfig.Tmpfs))
    return false;
  const tmpfs = hostConfig.Tmpfs as Record<string, unknown>;
  return (
    Object.keys(tmpfs).length === 1 &&
    normalizedTmpfsOptions(tmpfs[DOCKER_AGENT_VOLUME_SHADOW.target]) ===
      normalizedTmpfsOptions(DOCKER_AGENT_VOLUME_SHADOW.options)
  );
}

export function assertAgentVolumeShadowPostcondition(value: unknown, apiVolumeName: string): void {
  const agent = object(value, 'agent inspect');
  const hostConfig = object(agent.HostConfig, 'agent host config');
  const volumeMounts = Array.isArray(agent.Mounts)
    ? agent.Mounts.map((value) => object(value, 'agent mount')).filter((mount) => mount.Type === 'volume')
    : undefined;
  if (
    !hasExactAgentVolumeShadow(hostConfig) ||
    volumeMounts === undefined ||
    volumeMounts.length !== 1 ||
    volumeMounts[0]!.Name !== apiVolumeName ||
    volumeMounts[0]!.Destination !== PRIVATE_DOCKER_API_DIR ||
    volumeMounts[0]!.RW !== false
  ) {
    throw new Error('workflow agent inherited-volume shadow postcondition failed');
  }
}

export function assertSnapshotHelperPostcondition(
  value: unknown,
  expected: {
    readonly helperId: string;
    readonly probeSource: string;
    readonly publicMounts: readonly DockerMount[];
    readonly apiVolumeName: string;
  },
): void {
  const helper = object(value, 'helper inspect');
  const hostConfig = object(helper.HostConfig, 'helper host config');
  const actualMounts = Array.isArray(helper.Mounts)
    ? helper.Mounts.map((value): HelperMountIdentity => {
        const mount = object(value, 'helper mount');
        const type = mount.Type;
        const source = type === 'bind' ? mount.Source : type === 'volume' ? mount.Name : undefined;
        if (typeof source !== 'string' || typeof mount.Destination !== 'string') {
          throw new Error('snapshot helper isolation/read-only postcondition failed');
        }
        return {
          type,
          source,
          target: mount.Destination,
          readonly: mount.RW === false,
        } as HelperMountIdentity;
      })
    : undefined;
  const expectedMounts = sortedHelperMounts([
    { type: 'bind', source: expected.probeSource, target: PROBE_TARGET, readonly: true },
    ...expected.publicMounts.map((mount) => ({
      type: 'bind' as const,
      source: mount.source,
      target: mount.target,
      readonly: true,
    })),
    {
      type: 'volume',
      source: expected.apiVolumeName,
      target: HELPER_STATE_TARGET,
      readonly: true,
    },
  ]);
  if (
    helper.Id !== expected.helperId ||
    hostConfig.NetworkMode !== 'none' ||
    hostConfig.ReadonlyRootfs !== true ||
    hostConfig.Privileged !== false ||
    !hasExactAgentVolumeShadow(hostConfig) ||
    actualMounts === undefined ||
    JSON.stringify(sortedHelperMounts(actualMounts)) !== JSON.stringify(expectedMounts)
  ) {
    throw new Error('snapshot helper isolation/read-only postcondition failed');
  }
}

/** No resource identity, path, executable, or arbitrary action is accepted from the workspace. */
export class WorkflowSmokeHostObserver {
  private stopped = false;
  private helperId: string | undefined;
  private generation: string | undefined;
  private readonly completed = new Set<ObservationAction>();
  private readonly nonces = new Set<string>();
  private readonly worker: Promise<void>;
  private failure: unknown;

  constructor(
    private readonly options: {
      readonly runtime: ContainerRuntime;
      readonly workspace: string;
      readonly probeSource: string;
      readonly getLeasePath: () => string;
      readonly getStagingRoot: (lease: DockerWorkloadLease) => string;
      readonly daemonExecUser: string;
      readonly onFailure: () => void;
    },
  ) {
    this.worker = this.run().catch((error: unknown) => {
      this.failure = error;
      this.options.onFailure();
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const cleanupFailures: unknown[] = [];
    try {
      await this.removeHelper();
    } catch (error) {
      cleanupFailures.push(error);
    }
    await this.worker;
    // A failed first removal retains its exact ID, including a helper created
    // while stop was waiting for the observer's current runtime operation.
    try {
      await this.removeHelper();
    } catch (error) {
      cleanupFailures.push(error);
    }
    const failures = this.failure === undefined ? cleanupFailures : [this.failure, ...cleanupFailures];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'host observation and exact helper cleanup failed', { cause: failures[0] });
  }

  assertComplete(): void {
    if (this.failure !== undefined) throw this.failure;
    if (!this.completed.has('public-trust') || !this.completed.has('snapshot')) {
      throw new Error('packages lacks independent host public-trust and snapshot proof');
    }
  }

  private async run(): Promise<void> {
    const requestPath = resolve(this.options.workspace, '.workflow/host-observation-request.json');
    while (!this.stopped) {
      let text: string;
      try {
        text = readBoundedFile(requestPath, 4096);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          await delay(200);
          continue;
        }
        throw error;
      }
      const request = parseHostObservationRequest(JSON.parse(text));
      if (this.nonces.has(request.nonce)) {
        await delay(200);
        continue;
      }
      if (this.completed.has(request.action)) throw new Error('repeated host observation action');
      this.nonces.add(request.nonce);
      const lease = loadDockerWorkloadLease(this.options.getLeasePath());
      if (lease.status !== 'active' || (this.generation !== undefined && this.generation !== lease.generation)) {
        throw new Error('host observation lease generation is no longer active');
      }
      this.generation = lease.generation;
      const observation = await this.observe(lease, request.action);
      if (this.stopped) return;
      const current = loadDockerWorkloadLease(this.options.getLeasePath());
      if (current.status !== 'active' || current.generation !== lease.generation)
        throw new Error('host observation generation changed');
      this.completed.add(request.action);
      const responsePath = resolve(this.options.workspace, '.workflow/host-observation-response.json');
      const temporaryPath = `${responsePath}.${randomUUID()}`;
      writeFileSync(
        temporaryPath,
        JSON.stringify({
          schemaVersion: 1,
          ...request,
          generation: lease.generation,
          passed: true,
          publicTrust: observation,
        }) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
      renameSync(temporaryPath, responsePath);
    }
  }

  private async observe(lease: DockerWorkloadLease, action: ObservationAction): Promise<Record<string, string>> {
    const { runtime } = this.options;
    if (runtime.inspectContainerRaw === undefined || runtime.inspectVolume === undefined)
      throw new Error('raw Docker observation unavailable');
    const resource = (role: string) => {
      const matches = lease.resources.filter(
        (entry) => entry.role === role && entry.removal === null && entry.observedId !== null,
      );
      if (matches.length !== 1) throw new Error(`expected one live leased ${role}`);
      return matches[0]!;
    };
    const daemon = resource('nested-daemon');
    const agent = resource('agent');
    const volume = resource('daemon-api');
    const raw = object(await runtime.inspectContainerRaw(daemon.observedId!), 'daemon inspect');
    const rawAgent = object(await runtime.inspectContainerRaw(agent.observedId!), 'agent inspect');
    for (const [entry, inspected] of [
      [daemon, raw],
      [agent, rawAgent],
    ] as const) {
      const labels = object(object(inspected.Config, 'container config').Labels, 'labels');
      if (
        inspected.Id !== entry.observedId ||
        labels[entry.ownershipLabelKey] !== lease.generation ||
        object(inspected.State, 'state').Running !== true
      ) {
        throw new Error('host observation container ownership mismatch');
      }
    }
    const volumeInfo = await runtime.inspectVolume(volume.observedId!);
    if (volumeInfo?.name !== volume.observedId || volumeInfo.labels[volume.ownershipLabelKey] !== lease.generation)
      throw new Error('host observation volume ownership mismatch');
    assertAgentVolumeShadowPostcondition(rawAgent, volume.observedId!);
    if (!Array.isArray(raw.Mounts)) throw new Error('daemon mounts unavailable');
    const mounts = raw.Mounts.map((value) => object(value, 'mount'));
    const stateMounts = mounts.filter((mount) => mount.Destination === '/home/codespace/.local/share');
    if (stateMounts.length !== 1 || stateMounts[0]!.Type !== 'volume' || stateMounts[0]!.Name !== volume.observedId)
      throw new Error('daemon state is not the exact leased volume');
    const publicMounts: DockerMount[] = [];
    const contents: Record<string, string> = {};
    const trustMounts = mounts.filter((mount) => mount.Destination === TRUST_ROOT);
    const trustMount = trustMounts[0];
    if (
      trustMounts.length !== 1 ||
      trustMount?.Type !== 'bind' ||
      trustMount.RW !== false ||
      trustMount.Source !== this.options.getStagingRoot(lease)
    ) {
      throw new Error('daemon public trust directory is not the exact protected lease staging');
    }
    for (const leaf of TRUST_LEAVES) {
      const source = resolve(this.options.getStagingRoot(lease), leaf);
      publicMounts.push({ source, target: `${TRUST_ROOT}/${leaf}`, readonly: true });
      contents[leaf] = readBoundedFile(source, 2 * 1024 * 1024);
    }
    const preflight = await runtime.exec(
      daemon.observedId!,
      ['/ironcurtain-build-trust/runc', '--ironcurtain-verify-protected-inputs-v2'],
      30_000,
      this.options.daemonExecUser,
    );
    if (
      preflight.exitCode !== 0 ||
      preflight.stdout.trim() !== 'ironcurtain-build-trust-inputs/2' ||
      preflight.stderr !== ''
    )
      throw new Error('daemon protected-input protocol failed');
    const publicTrust = {
      buildTrustContract: contents['build-trust-contract.json']!,
      caCertificate: contents['ca-cert.pem']!,
      aptConfig: contents['apt.conf']!,
    };
    if (action === 'public-trust') return publicTrust;
    if (typeof rawAgent.Image !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(rawAgent.Image))
      throw new Error('captured agent fixture image identity unavailable');
    let observationFailure: unknown;
    try {
      this.helperId = await createQualificationObserverContainer({
        runtime,
        leasePath: this.options.getLeasePath(),
        generation: lease.generation,
        config: {
          image: rawAgent.Image,
          name: `ic-wf-snapshot-${randomUUID()}`,
          user: '0:0',
          mounts: [{ source: this.options.probeSource, target: PROBE_TARGET, readonly: true }, ...publicMounts],
          network: 'none',
          extraHosts: [],
          ports: [],
          env: { PYTHONDONTWRITEBYTECODE: '1' },
          entrypoint: '/usr/bin/python3',
          command: ['-c', 'import time; time.sleep(1200)'],
          resources: { memoryMb: 512, cpus: 1 },
          capAdd: ['DAC_READ_SEARCH'],
          trustedCreateOptions: {
            readOnlyRootfs: true,
            pidsLimit: 32,
            securityOptions: ['no-new-privileges:true'],
            namedVolumeMounts: [
              { name: volume.observedId!, target: HELPER_STATE_TARGET, readonly: true, noCopy: true },
            ],
            // The agent image declares /var/lib/docker as a volume. Shadow it so Docker
            // cannot add an implicit writable anonymous volume to the snapshot helper.
            tmpfs: [DOCKER_AGENT_VOLUME_SHADOW.specification],
          },
        },
      });
      if (this.stopped) return publicTrust;
      assertSnapshotHelperPostcondition(await runtime.inspectContainerRaw(this.helperId), {
        helperId: this.helperId,
        probeSource: this.options.probeSource,
        publicMounts,
        apiVolumeName: volume.observedId!,
      });
      await runtime.start(this.helperId);
      const result = await runtime.exec(
        this.helperId,
        ['/usr/bin/python3', PROBE_TARGET, '--internal-snapshot-scan-v1'],
        MAX_OBSERVATION_MS,
        '0:0',
      );
      if (result.exitCode !== 0 || result.stdout !== SNAPSHOT_PROTOCOL || result.stderr !== '')
        throw new Error(`host snapshot scanner failed: ${JSON.stringify(result)}`);
      return publicTrust;
    } catch (error) {
      observationFailure = error;
      throw error;
    } finally {
      try {
        await this.removeHelper();
      } catch (cleanupError) {
        if (observationFailure !== undefined)
          throw new AggregateError(
            [observationFailure, cleanupError],
            'host snapshot scanner and exact helper cleanup failed',
            { cause: observationFailure },
          );
        throw cleanupError;
      }
    }
  }

  private async removeHelper(): Promise<void> {
    const id = this.helperId;
    if (id === undefined) return;
    await this.options.runtime.remove(id);
    if ((await this.options.runtime.inspectContainerRaw?.(id)) !== undefined)
      throw new Error(`snapshot helper survived exact removal: ${id}`);
    if (this.helperId === id) this.helperId = undefined;
  }
}
