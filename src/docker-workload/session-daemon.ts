/**
 * Session-time wiring for the same-VM nested Docker daemon (plan §4.4 variant 1).
 *
 * On the Apple `container` backend the rootless daemon runs INSIDE the agent's
 * own per-session VM, so there is no separate daemon container: the agent
 * container create IS the §8.2 step-4 "daemon component" create, and the in-VM
 * bootstrap happens between that container's start and the agent process. This
 * module owns the Apple-specific consequences of that topology so neither
 * session mode has to re-derive them:
 *
 *  - selecting the same-VM topology only for Apple `container`,
 *  - the `ContainerRuntime.exec` -> {@link AppleVmDaemonExec} adaptation plus
 *    the bootstrap/adjudicate/record sequence,
 *  - the private socket and managed-network environment the agent receives.
 *
 * Everything here is inert for an ordinary session: with no admitted
 * Docker-workload bundle every entry point resolves to "absent" and callers
 * take exactly today's path.
 */

import type { ContainerRuntimeKind } from '../docker/container-runtime.js';
import type { ContainerRuntime } from '../docker/types.js';
import {
  APPLE_VM_DAEMON_DOCKER_HOST,
  APPLE_VM_DAEMON_TOOLCHAIN_DIR,
  bootstrapAppleVmDaemon,
  waitForAppleVmDaemonReady,
  type AppleVmDaemonExec,
} from './apple-vm-daemon.js';
import {
  APPLE_VM_DOCKER_WORKLOAD_NETWORK,
  APPLE_VM_DOCKER_WORKLOAD_NETWORK_ENV,
  createAppleVmDockerWorkloadNetwork,
  provisionAppleVmDockerWorkload,
  type AppleVmDockerWorkloadBootstrapConfig,
} from './apple-private-docker.js';
import type { DockerWorkloadBundleHandle } from './infrastructure.js';
import type { DockerWorkloadNetworkAccess } from './config.js';
import {
  DOCKER_BUILD_TRUST_FAILURE_ALLOWED_CODES,
  DOCKER_BUILD_TRUST_FAILURE_CLEAR_COMMAND,
  DOCKER_BUILD_TRUST_FAILURE_MAX_CODE_BYTES,
  DOCKER_BUILD_TRUST_FAILURE_READ_COMMAND,
  DOCKER_BUILD_TRUST_FAILURE_UNAVAILABLE_CODE,
  DOCKER_BUILD_TRUST_WRAPPER_PATH,
  type DockerBuildShimStagingContract,
  type DockerBuildTrustCanaryContract,
} from '../docker/docker-build-shim.js';
import type { RegistryEgressLedgerSnapshot } from '../docker/docker-workload-egress.js';
import type { PackageEgressLedgerSnapshot } from '../docker/package-egress-ledger.js';
import {
  DOCKER_BUILD_SHIM_EXEC_USER,
  DOCKER_BUILD_SHIM_PREFLIGHT_TIMEOUT_MS,
  DOCKER_BUILD_SHIM_ROOT_USER,
  boundedBuildShimDiagnostic,
  boundedBuildShimFailureDiagnostic,
  dockerBuildShimExecFor,
  execDockerBuildShimPreflight as execBuildShimPreflight,
  preflightDockerBuildShimAgent,
  preflightDockerBuildTrust,
} from './docker-build-shim-preflight.js';

/**
 * Readiness ceiling for the in-VM daemon: a generous upper bound on how long
 * rootless dockerd inside a fresh session VM may take to answer `docker info`.
 * Measured boot on the development host is a few seconds, so 90s is slack for a
 * cold or loaded machine, not a target. Exceeding it means the daemon is not
 * coming up and admission fails closed rather than waiting forever.
 *
 * An ordinary reviewed constant — change it by ordinary review.
 */
export const APPLE_VM_DAEMON_READINESS_TIMEOUT_MS = 90_000;
const APPLE_VM_BUILD_TRUST_CANARY_TIMEOUT_MS = 5 * 60_000;
const APPLE_VM_BUILD_TRUST_CANARY_ROOT = '/run/ironcurtain-docker/build-trust-canary';
const APPLE_VM_BUILD_TRUST_CANARY_DOCKERFILE = `${APPLE_VM_BUILD_TRUST_CANARY_ROOT}/Dockerfile`;
const APPLE_VM_BUILD_TRUST_CANARY_BASE_REPOSITORY = 'localhost/ironcurtain/build-trust-canary-base';
const APPLE_VM_BUILD_TRUST_CANARY_IMAGE_REPOSITORY = 'localhost/ironcurtain/build-trust-canary';
const APPLE_VM_BUILD_TRUST_CANARY_NONCE = 'IRONCURTAIN_BUILD_TRUST_CANARY_OK/1';
const CA_GENERATION_PATTERN = /^gen-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BUNDLE_GENERATION_TAG_SUFFIX_PATTERN =
  /^gen-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IMMUTABLE_IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface AppleVmDockerWorkloadEgressLedgers {
  readonly registry: () => RegistryEgressLedgerSnapshot;
  readonly packages: () => PackageEgressLedgerSnapshot;
}

/**
 * Both runtime kinds have a nested-daemon implementation. Apple runs the daemon
 * inside the agent VM; Docker Desktop on macOS or WSL2 uses a separate rootless
 * sidecar. This is an implementation check, not a qualification or enablement claim.
 */
export function assertNestedDaemonBackendImplemented(runtimeKind: ContainerRuntimeKind): void {
  switch (runtimeKind) {
    case 'apple-container':
    case 'docker':
      return;
    default: {
      const unsupported: never = runtimeKind;
      throw new Error(`nested Docker is not implemented for runtime ${String(unsupported)}`);
    }
  }
}

/**
 * The admitted bundle whose agent container IS the nested-daemon component, or
 * `undefined` for an ordinary session and for the separate Docker Desktop
 * sidecar topology. Returning the handle rather than a boolean keeps the
 * Apple same-VM wiring decision and the handle it needs from ever disagreeing.
 *
 * @throws when a bundle was admitted on a backend where the topology is not
 * implemented — a create that silently produced no daemon would be worse.
 */
export function resolveNestedDaemonBundle(
  dockerWorkload: DockerWorkloadBundleHandle | undefined,
  runtimeKind: ContainerRuntimeKind,
): DockerWorkloadBundleHandle | undefined {
  if (dockerWorkload === undefined) return undefined;
  assertNestedDaemonBackendImplemented(runtimeKind);
  return runtimeKind === 'apple-container' ? dockerWorkload : undefined;
}

/**
 * §8.2 step 6: the agent reaches the daemon over the VM-local socket, which is
 * never published outside the VM, and receives the fixed name of its managed
 * inner bridge. Empty for every ordinary session, so the container environment
 * is byte-identical to today when the feature is off.
 */
export function nestedDaemonAgentEnv(
  nestedDaemon: DockerWorkloadBundleHandle | undefined,
): Readonly<Record<string, string>> {
  return nestedDaemon === undefined
    ? {}
    : {
        DOCKER_HOST: APPLE_VM_DAEMON_DOCKER_HOST,
        [APPLE_VM_DOCKER_WORKLOAD_NETWORK_ENV]: APPLE_VM_DOCKER_WORKLOAD_NETWORK,
      };
}

export interface StartAppleVmDockerWorkloadOptions {
  readonly runtime: ContainerRuntime;
  /** The already-started agent container, i.e. the VM the daemon runs inside. */
  readonly containerId: string;
  readonly nestedDaemon: DockerWorkloadBundleHandle;
  /** Immutable per-lease selected-agent archive mounted into this VM. */
  readonly bootstrap: AppleVmDockerWorkloadBootstrapConfig;
  /** Selects the exact trusted RootlessKit relay set for this admitted bundle. */
  readonly networkAccess: DockerWorkloadNetworkAccess;
  /** Package-only staged shim contract. Absent in images/offline modes. */
  readonly dockerBuildShim?: DockerBuildShimStagingContract;
  /** Exact staged trust-file observations used by the no-network canary. */
  readonly dockerBuildTrustCanary?: DockerBuildTrustCanaryContract;
  /** Package and registry ledgers that the no-network canary must not change. */
  readonly egressLedgers?: AppleVmDockerWorkloadEgressLedgers;
  /** Defaults to {@link APPLE_VM_DAEMON_READINESS_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

async function clearBuildTrustFailureDiagnostic(exec: AppleVmDaemonExec): Promise<boolean> {
  try {
    const result = await exec([DOCKER_BUILD_TRUST_WRAPPER_PATH, DOCKER_BUILD_TRUST_FAILURE_CLEAR_COMMAND], {
      user: DOCKER_BUILD_SHIM_ROOT_USER,
      timeoutMs: DOCKER_BUILD_SHIM_PREFLIGHT_TIMEOUT_MS,
    });
    return result.exitCode === 0 && result.stdout === '' && result.stderr === '';
  } catch {
    return false;
  }
}

async function readBuildTrustFailureDiagnostic(exec: AppleVmDaemonExec): Promise<string> {
  try {
    const result = await exec([DOCKER_BUILD_TRUST_WRAPPER_PATH, DOCKER_BUILD_TRUST_FAILURE_READ_COMMAND], {
      user: DOCKER_BUILD_SHIM_ROOT_USER,
      timeoutMs: DOCKER_BUILD_SHIM_PREFLIGHT_TIMEOUT_MS,
    });
    if (result.exitCode !== 0 || result.stderr !== '') return DOCKER_BUILD_TRUST_FAILURE_UNAVAILABLE_CODE;
    const value = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
    if (
      Buffer.byteLength(value, 'utf8') > DOCKER_BUILD_TRUST_FAILURE_MAX_CODE_BYTES ||
      /[^\x20-\x7e]/u.test(value) ||
      (value !== DOCKER_BUILD_TRUST_FAILURE_UNAVAILABLE_CODE && !DOCKER_BUILD_TRUST_FAILURE_ALLOWED_CODES.has(value))
    ) {
      return DOCKER_BUILD_TRUST_FAILURE_UNAVAILABLE_CODE;
    }
    return value;
  } catch {
    return DOCKER_BUILD_TRUST_FAILURE_UNAVAILABLE_CODE;
  }
}

function sameSnapshot(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildTrustCanaryImageReferences(bundleGeneration: string): {
  readonly base: string;
  readonly output: string;
} {
  if (!BUNDLE_GENERATION_TAG_SUFFIX_PATTERN.test(bundleGeneration)) {
    throw new Error('nested-Docker build-trust canary received an invalid bundle generation');
  }
  return {
    base: `${APPLE_VM_BUILD_TRUST_CANARY_BASE_REPOSITORY}:${bundleGeneration}`,
    output: `${APPLE_VM_BUILD_TRUST_CANARY_IMAGE_REPOSITORY}:${bundleGeneration}`,
  };
}

async function inspectBuildTrustCanaryImage(exec: AppleVmDaemonExec, reference: string): Promise<string | undefined> {
  const result = await exec(
    [
      `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`,
      '--host',
      APPLE_VM_DAEMON_DOCKER_HOST,
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      reference,
    ],
    { user: DOCKER_BUILD_SHIM_EXEC_USER, timeoutMs: DOCKER_BUILD_SHIM_PREFLIGHT_TIMEOUT_MS },
  );
  if (result.exitCode === 0) {
    const observed = boundedBuildShimDiagnostic(result.stdout);
    if (!IMMUTABLE_IMAGE_ID_PATTERN.test(observed)) {
      throw new Error(`nested-Docker build-trust image inspect returned invalid ID for ${reference}`);
    }
    return observed;
  }
  if (result.exitCode === 1 && /(?:no such image|not found)/iu.test(`${result.stdout}\n${result.stderr ?? ''}`)) {
    return undefined;
  }
  const detail = boundedBuildShimFailureDiagnostic(result.stdout, result.stderr);
  throw new Error(
    `nested-Docker build-trust image inspect failed for ${reference} with exit code ${result.exitCode}` +
      (detail === '' ? '' : `: ${detail}`),
  );
}

async function removeBuildTrustCanaryImage(exec: AppleVmDaemonExec, reference: string): Promise<void> {
  const result = await exec(
    [
      `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`,
      '--host',
      APPLE_VM_DAEMON_DOCKER_HOST,
      'image',
      'rm',
      '--force',
      reference,
    ],
    { user: DOCKER_BUILD_SHIM_EXEC_USER, timeoutMs: DOCKER_BUILD_SHIM_PREFLIGHT_TIMEOUT_MS },
  );
  if (result.exitCode !== 0) {
    const detail = boundedBuildShimFailureDiagnostic(result.stdout, result.stderr);
    throw new Error(
      `nested-Docker build-trust image cleanup failed for ${reference} with exit code ${result.exitCode}` +
        (detail === '' ? '' : `: ${detail}`),
    );
  }
}

// Host preflight already compares exact protected source contents. The no-network
// canary checks that the runtime injects those sources into a build executor.
function buildTrustCanaryDockerfile(localBaseImage: string, canary: DockerBuildTrustCanaryContract): string {
  return (
    `FROM ${localBaseImage}\n` +
    'RUN set -eu; ' +
    '[ "$NODE_EXTRA_CA_CERTS" = "/dev/ironcurtain/ca-cert.pem" ]; ' +
    '[ "$SSL_CERT_FILE" = "/dev/ironcurtain/ca-bundle.pem" ]; ' +
    `[ "$APT_CONFIG" = "/dev/ironcurtain/apt.conf" ]; ` +
    `[ "$(/usr/bin/wc -c < /dev/ironcurtain/ca-cert.pem)" = "${Buffer.byteLength(canary.caCertificate)}" ]; ` +
    `[ "$(/usr/bin/wc -c < /dev/ironcurtain/ca-bundle.pem)" = "${Buffer.byteLength(canary.caBundle)}" ]; ` +
    `[ "$(/usr/bin/wc -c < /dev/ironcurtain/apt.conf)" = "${Buffer.byteLength(canary.aptConfig)}" ]; ` +
    '[ ! -e /dev/ironcurtain/ca-key.pem ]; ' +
    '[ ! -w /dev/ironcurtain/ca-cert.pem ]; ' +
    '[ ! -w /dev/ironcurtain/ca-bundle.pem ]; ' +
    '[ ! -w /dev/ironcurtain/apt.conf ]; ' +
    `printf '${APPLE_VM_BUILD_TRUST_CANARY_NONCE}\\n'\n`
  );
}

async function runAppleVmDockerBuildTrustCanary(
  exec: AppleVmDaemonExec,
  selectedLogicalName: string,
  immutableImageId: string,
  bundleGeneration: string,
  canary: DockerBuildTrustCanaryContract,
  ledgers: AppleVmDockerWorkloadEgressLedgers,
): Promise<void> {
  const beforeRegistry = ledgers.registry();
  const beforePackages = ledgers.packages();
  const failureDiagnosticWasCleared = await clearBuildTrustFailureDiagnostic(exec);
  const imageReferences = buildTrustCanaryImageReferences(bundleGeneration);
  let failure: unknown;
  const secondaryFailures: Error[] = [];
  let baseTagged = false;
  let outputImageId: string | undefined;
  try {
    if (!IMMUTABLE_IMAGE_ID_PATTERN.test(immutableImageId) || !CA_GENERATION_PATTERN.test(canary.caGeneration)) {
      throw new Error('nested-Docker build-trust canary received invalid image or CA generation metadata');
    }
    const selectedByName = await inspectBuildTrustCanaryImage(exec, selectedLogicalName);
    const selectedById = await inspectBuildTrustCanaryImage(exec, immutableImageId);
    if (selectedByName !== immutableImageId || selectedById !== immutableImageId) {
      throw new Error(
        'nested-Docker build-trust selected image was not present under its exact logical and immutable IDs',
      );
    }
    if (
      (await inspectBuildTrustCanaryImage(exec, imageReferences.base)) !== undefined ||
      (await inspectBuildTrustCanaryImage(exec, imageReferences.output)) !== undefined
    ) {
      throw new Error('nested-Docker build-trust reserved canary image tag already exists');
    }
    await execBuildShimPreflight(
      exec,
      [
        `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`,
        '--host',
        APPLE_VM_DAEMON_DOCKER_HOST,
        'image',
        'tag',
        immutableImageId,
        imageReferences.base,
      ],
      'nested-Docker build-trust local canary base tag',
    );
    baseTagged = true;
    const observedBaseImageId = await inspectBuildTrustCanaryImage(exec, imageReferences.base);
    if (observedBaseImageId !== immutableImageId) {
      throw new Error(
        `nested-Docker build-trust local canary base resolved to "${observedBaseImageId}"; ` +
          `expected "${immutableImageId}"`,
      );
    }
    await execBuildShimPreflight(
      exec,
      ['/bin/mkdir', '--parents', APPLE_VM_BUILD_TRUST_CANARY_ROOT],
      'nested-Docker build-trust canary context create',
    );
    const dockerfile = buildTrustCanaryDockerfile(imageReferences.base, canary);
    await execBuildShimPreflight(
      exec,
      [
        '/bin/sh',
        '-c',
        'umask 077; /usr/bin/printf %s "$1" > "$2"',
        'ironcurtain-build-trust-canary',
        dockerfile,
        APPLE_VM_BUILD_TRUST_CANARY_DOCKERFILE,
      ],
      'nested-Docker build-trust canary Dockerfile write',
    );
    const built = await exec(
      [
        `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`,
        '--host',
        APPLE_VM_DAEMON_DOCKER_HOST,
        'build',
        '--pull=false',
        '--network=none',
        '--no-cache',
        '--progress=plain',
        '--tag',
        imageReferences.output,
        '--file',
        APPLE_VM_BUILD_TRUST_CANARY_DOCKERFILE,
        APPLE_VM_BUILD_TRUST_CANARY_ROOT,
      ],
      { user: DOCKER_BUILD_SHIM_EXEC_USER, timeoutMs: APPLE_VM_BUILD_TRUST_CANARY_TIMEOUT_MS },
    );
    let buildFailure: Error | undefined;
    if (built.exitCode !== 0) {
      const wrapperCode = failureDiagnosticWasCleared
        ? await readBuildTrustFailureDiagnostic(exec)
        : DOCKER_BUILD_TRUST_FAILURE_UNAVAILABLE_CODE;
      const detail = boundedBuildShimFailureDiagnostic(built.stdout, built.stderr, [
        { label: 'wrapper', value: wrapperCode },
      ]);
      buildFailure = new Error(
        `nested-Docker build-trust canary failed with exit code ${built.exitCode}${detail === '' ? '' : `: ${detail}`}`,
      );
    }

    let observedOutputImageId: string | undefined;
    try {
      observedOutputImageId = await inspectBuildTrustCanaryImage(exec, imageReferences.output);
    } catch (error) {
      if (buildFailure === undefined) throw error;
      secondaryFailures.push(
        new Error('nested-Docker build-trust output image inspect failed after canary build failure', {
          cause: error,
        }),
      );
      throw buildFailure;
    }
    if (observedOutputImageId === immutableImageId) {
      const outputReuseFailure = new Error(
        'nested-Docker build-trust canary output reused the selected immutable image ID',
      );
      if (buildFailure === undefined) throw outputReuseFailure;
      secondaryFailures.push(outputReuseFailure);
      throw buildFailure;
    }
    outputImageId = observedOutputImageId;
    if (buildFailure !== undefined) throw buildFailure;
    if (outputImageId === undefined) {
      throw new Error('nested-Docker build-trust canary output did not resolve to a distinct immutable image ID');
    }
    if (!`${built.stdout}\n${built.stderr ?? ''}`.includes(APPLE_VM_BUILD_TRUST_CANARY_NONCE)) {
      throw new Error('nested-Docker build-trust canary did not emit its exact success nonce');
    }
  } catch (error) {
    failure = error;
  }

  const cleanupFailures: Error[] = [...secondaryFailures];
  const recordCleanup = async (description: string, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      cleanupFailures.push(new Error(description, { cause: error }));
    }
  };

  let currentOutputTagId: string | undefined;
  await recordCleanup('nested-Docker build-trust output tag ownership check failed', async () => {
    currentOutputTagId = await inspectBuildTrustCanaryImage(exec, imageReferences.output);
    if (currentOutputTagId !== undefined && currentOutputTagId !== outputImageId) {
      throw new Error('reserved output tag was replaced by an unknown image; refusing to delete it');
    }
  });
  if (outputImageId !== undefined) {
    const capturedOutputImageId = outputImageId;
    await recordCleanup('nested-Docker build-trust output image cleanup failed', async () => {
      const currentOutputImageId = await inspectBuildTrustCanaryImage(exec, capturedOutputImageId);
      if (currentOutputImageId !== undefined && currentOutputImageId !== capturedOutputImageId) {
        throw new Error('captured canary output image ID changed unexpectedly');
      }
      if (currentOutputImageId !== undefined) await removeBuildTrustCanaryImage(exec, capturedOutputImageId);
    });
  }

  await recordCleanup('nested-Docker build-trust base tag ownership check or cleanup failed', async () => {
    const currentBaseImageId = await inspectBuildTrustCanaryImage(exec, imageReferences.base);
    if (currentBaseImageId === undefined) return;
    if (!baseTagged || currentBaseImageId !== immutableImageId) {
      throw new Error('reserved base tag was replaced by an unknown image; refusing to delete it');
    }
    await removeBuildTrustCanaryImage(exec, imageReferences.base);
  });
  await recordCleanup('nested-Docker build-trust canary context cleanup failed', async () => {
    const contextCleanup = await exec(['/bin/rm', '-rf', APPLE_VM_BUILD_TRUST_CANARY_ROOT], {
      user: DOCKER_BUILD_SHIM_EXEC_USER,
      timeoutMs: DOCKER_BUILD_SHIM_PREFLIGHT_TIMEOUT_MS,
    });
    if (contextCleanup.exitCode !== 0) throw new Error(`context cleanup exited ${contextCleanup.exitCode}`);
  });

  await recordCleanup('nested-Docker build-trust canary residue or selected-image check failed', async () => {
    const [baseResidue, outputTagResidue, outputIdResidue, selectedByName, selectedById] = await Promise.all([
      inspectBuildTrustCanaryImage(exec, imageReferences.base),
      inspectBuildTrustCanaryImage(exec, imageReferences.output),
      outputImageId === undefined ? Promise.resolve(undefined) : inspectBuildTrustCanaryImage(exec, outputImageId),
      inspectBuildTrustCanaryImage(exec, selectedLogicalName),
      inspectBuildTrustCanaryImage(exec, immutableImageId),
    ]);
    if (baseResidue !== undefined || outputTagResidue !== undefined || outputIdResidue !== undefined) {
      throw new Error('reserved canary tag or captured output image remains after cleanup');
    }
    if (selectedByName !== immutableImageId || selectedById !== immutableImageId) {
      throw new Error('selected image was changed or removed during canary cleanup');
    }
  });

  await clearBuildTrustFailureDiagnostic(exec);

  const afterRegistry = ledgers.registry();
  const afterPackages = ledgers.packages();
  if (!sameSnapshot(beforeRegistry, afterRegistry) || !sameSnapshot(beforePackages, afterPackages)) {
    const priorFailures = [...(failure === undefined ? [] : [failure]), ...cleanupFailures];
    throw new AggregateError(priorFailures, 'nested-Docker no-network build-trust canary changed an egress ledger');
  }
  if (cleanupFailures.length > 0) {
    const primary = failure instanceof Error ? failure : undefined;
    const summary = [primary?.message, ...cleanupFailures.map((error) => error.message)].filter(Boolean).join('; ');
    throw new AggregateError(
      [...(failure === undefined ? [] : [failure]), ...cleanupFailures],
      `nested-Docker build-trust canary cleanup verification failed${summary === '' ? '' : `: ${summary}`}`,
    );
  }
  if (failure !== undefined) {
    throw failure instanceof Error ? failure : new Error('nested-Docker build-trust canary failed', { cause: failure });
  }
}

/**
 * Complete same-VM activation before the host attaches to the PTY: bootstrap and
 * adjudicate the rootless daemon, preflight the pinned Docker client/plugin
 * tuple, provision the selected prepared agent image, record the
 * transparent observations, and activate the lease.
 *
 * Any failure propagates unchanged. There is no degraded mode in which the
 * agent runs against an incomplete bootstrap, so the caller's
 * abort-and-teardown path is the only outcome of any failure.
 */
export async function startAppleVmDockerWorkload(options: StartAppleVmDockerWorkloadOptions): Promise<void> {
  const exec = dockerBuildShimExecFor(options.runtime, options.containerId);
  await bootstrapAppleVmDaemon(exec, { networkAccess: options.networkAccess });
  const readiness = await waitForAppleVmDaemonReady(exec, {
    timeoutMs: options.timeoutMs ?? APPLE_VM_DAEMON_READINESS_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs,
  });
  options.nestedDaemon.recordDaemonReady(readiness);
  const packageArtifactCount = [options.dockerBuildShim, options.dockerBuildTrustCanary, options.egressLedgers].filter(
    (value) => value !== undefined,
  ).length;
  if (
    (options.networkAccess === 'packages' && packageArtifactCount !== 3) ||
    (options.networkAccess !== 'packages' && packageArtifactCount !== 0)
  ) {
    throw new Error('nested-Docker package-build contracts do not match the admitted network access');
  }
  if (options.dockerBuildShim !== undefined && options.dockerBuildTrustCanary !== undefined) {
    await preflightDockerBuildShimAgent(exec, options.dockerBuildShim);
    await preflightDockerBuildTrust(exec, options.dockerBuildShim, options.dockerBuildTrustCanary);
  }
  const provisioning = await provisionAppleVmDockerWorkload({
    outerRuntime: options.runtime,
    containerId: options.containerId,
    config: options.bootstrap,
  });
  if (options.dockerBuildTrustCanary !== undefined && options.egressLedgers !== undefined) {
    await runAppleVmDockerBuildTrustCanary(
      exec,
      provisioning.image.logicalName,
      provisioning.image.innerImageId,
      options.nestedDaemon.generation,
      options.dockerBuildTrustCanary,
      options.egressLedgers,
    );
  }
  const network = await createAppleVmDockerWorkloadNetwork({
    outerRuntime: options.runtime,
    containerId: options.containerId,
  });
  options.nestedDaemon.recordPrivateDockerBootstrap({
    preflight: provisioning.preflight,
    image: provisioning.image,
    network,
  });
  await options.nestedDaemon.activate();
}
