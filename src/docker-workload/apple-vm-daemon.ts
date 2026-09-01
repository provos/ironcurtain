/**
 * Nested Docker daemon bootstrap and readiness for the same-VM topology
 * (plan §4.4 variant 1) on the Apple `container` backend.
 *
 * The rootless daemon runs INSIDE the agent's own per-session VM and its API is
 * a VM-local UDS that is never published outside the VM (§5.3). Every command
 * this module issues is a frozen static argv run through the injected
 * {@link AppleVmDaemonExec} seam — the wiring layer adapts
 * `ContainerRuntime.exec` to it. No runtime value is ever interpolated into a
 * command string and this module never spawns a process itself.
 *
 * No step of the bootstrap requires root. The API directory the daemon binds
 * its socket in is provided by the base image already owned by the runtime user
 * — the agent VM's bounding set has no CAP_CHOWN, so a runtime `install -d -o`
 * is impossible — and the bootstrap mode-checks that it arrived (§5.3).
 *
 * Readiness is an adjudication, not a liveness check: a daemon that ANSWERS
 * `docker info` with anything but the required rootless/vfs configuration is
 * rejected fail-closed rather than retried, because a rootful or overlayfs
 * daemon is an unsupported configuration, not a slow one. An answer that did
 * not come from a daemon at all is the one retryable outcome.
 *
 * Every value `docker info` and the dockerd log report is written by a party
 * inside the agent VM, so all of it is bounded and sanitized here, at the point
 * it crosses into the host, rather than downstream where an oversized value
 * would already have been adjudicated as a successful readiness.
 *
 * Like `infrastructure.ts` it deliberately does NOT consult the temporary
 * implementation fuse in `config.ts`: the fuse gates session entry, not this
 * mechanism. A guard test enforces the non-import.
 */

import {
  PRIVATE_DOCKER_API_DIR,
  PRIVATE_DOCKER_CLIENT,
  PRIVATE_DOCKER_HOST,
  PRIVATE_DOCKER_READINESS_TEXT_BOUNDS,
  PRIVATE_DOCKER_SOCKET,
  PRIVATE_DOCKER_TOOLCHAIN_DIR,
  waitForPrivateDockerDaemonReady,
  type PrivateDockerClient,
  type PrivateDockerDaemonReadiness,
  type WaitForPrivateDockerDaemonReadyOptions,
} from './private-docker.js';
/** VM-local Docker API directory (plan §4.2), created 0700 by the base image and owned by the runtime user. */
export const APPLE_VM_DAEMON_API_DIR = PRIVATE_DOCKER_API_DIR;

/** VM-local Docker API socket. Never bound to TCP and never published out of the VM. */
export const APPLE_VM_DAEMON_SOCKET = PRIVATE_DOCKER_SOCKET;

/** The `DOCKER_HOST` value the in-VM agent process receives. */
export const APPLE_VM_DAEMON_DOCKER_HOST = PRIVATE_DOCKER_HOST;

/** Exact Apple file mount visible on both sides of rootlesskit's `/run` copy-up. */
export const APPLE_VM_REGISTRY_EGRESS_SOCKET = '/tmp/ironcurtain-registry-egress.sock';

/** Rootless-netns loopback proxy; reachable only by bundle members that join that netns. */
export const APPLE_VM_REGISTRY_EGRESS_PROXY_URL = 'http://127.0.0.1:18081';

/** Exact Apple file mount for strict package-registry HTTP/HTTPS egress. */
export const APPLE_VM_PACKAGE_EGRESS_SOCKET = '/tmp/ironcurtain-package-egress.sock';

/** Rootless-netns loopback proxy available bundle-wide only in package mode. */
export const APPLE_VM_PACKAGE_EGRESS_PROXY_URL = 'http://127.0.0.1:18082';

/** Public trust bundle already staged read-only in the outer orientation mount. */
export const APPLE_VM_REGISTRY_EGRESS_CA_BUNDLE = '/etc/ironcurtain/ca-bundle.pem';

/**
 * Pinned daemon toolchain staged by the base image. dockerd/rootlesskit/
 * containerd/runc live here and stay OFF the default PATH; only the `docker`
 * client is symlinked into a PATH directory.
 */
export const APPLE_VM_DAEMON_TOOLCHAIN_DIR = PRIVATE_DOCKER_TOOLCHAIN_DIR;

/** Exact legacy helper selected on the trusted daemon bootstrap's private PATH. */
export const APPLE_VM_DAEMON_IPTABLES = `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/iptables`;

/** In-VM dockerd log — the only diagnostic surface a readiness timeout can quote. */
export const APPLE_VM_DAEMON_LOG_PATH = `${APPLE_VM_DAEMON_API_DIR}/dockerd.log`;

const APPLE_VM_DAEMON_HOME = '/home/codespace';
const APPLE_VM_DAEMON_PATH = `/usr/bin:/bin:${APPLE_VM_DAEMON_TOOLCHAIN_DIR}`;
const APPLE_VM_DAEMON_PACKAGE_PATH = `/usr/local/sbin:${APPLE_VM_DAEMON_PATH}`;
const APPLE_VM_EGRESS_RELAY_NODE = '/usr/local/bin/node';
export const APPLE_VM_EGRESS_RELAY_PATH = '/usr/local/lib/ironcurtain-docker/apple-vm-egress-relay.mjs';

/**
 * VM-local dockerd state root, pinned explicitly rather than left to dockerd's
 * `$HOME`/`$XDG_DATA_HOME` derivation (plan §8.2.1/§8.3.4). Rootless dockerd
 * would derive exactly this path from the `HOME` the start script exports, so
 * naming it changes nothing at runtime and makes the daemon's state an exact
 * path that teardown can ledger and remove deterministically.
 */
export const APPLE_VM_DAEMON_DATA_ROOT = `${APPLE_VM_DAEMON_HOME}/.local/share/docker`;

const APPLE_VM_DOCKERD_COMMAND =
  `dockerd --host=${APPLE_VM_DAEMON_DOCKER_HOST} --data-root=${APPLE_VM_DAEMON_DATA_ROOT} ` +
  '--storage-driver=vfs --iptables=false --bridge=none';

/**
 * The upstream rootless-daemon wrapper enables forwarding inside RootlessKit's
 * private network namespace. Our staged toolchain intentionally omits that
 * wrapper, so the direct invocation must establish and verify the same
 * prerequisite. The namespace still has no uplink, host loopback, egress NAT,
 * or default bridge, and daemon-wide Docker iptables management remains off.
 * The reviewed helper is present only for Moby's per-sandbox embedded-DNS
 * loopback redirection.
 */
const APPLE_VM_DAEMON_NETWORK_PREREQUISITES = [
  'set -e',
  `[ "$(command -v iptables)" = "${APPLE_VM_DAEMON_IPTABLES}" ]`,
  'iptables --version | /bin/grep -Eq "^iptables v[0-9]+(\\.[0-9]+)* \\(legacy\\)$"',
  '/usr/bin/printf "1" > /proc/sys/net/ipv4/ip_forward',
  '[ "$(/bin/cat /proc/sys/net/ipv4/ip_forward)" = "1" ]',
];

const APPLE_VM_DAEMON_OFFLINE_INNER_SCRIPT = [
  ...APPLE_VM_DAEMON_NETWORK_PREREQUISITES,
  `exec ${APPLE_VM_DOCKERD_COMMAND}`,
].join('\n');

/**
 * The frozen rootlesskit + dockerd invocation. There is no
 * `dockerd-rootless.sh` in the 29.x toolchain. RootlessKit deliberately keeps
 * `--net=none`; the child shell establishes only the namespace-local forwarding
 * prerequisite above before replacing itself with dockerd.
 */
export const APPLE_VM_DAEMON_DOCKERD_COMMAND =
  `rootlesskit --net=none --disable-host-loopback --copy-up=/etc --copy-up=/run ` +
  `sh -c '${APPLE_VM_DAEMON_OFFLINE_INNER_SCRIPT}'`;

/**
 * Detach idiom: the shell replaces its own stdin/stdout/stderr with the log
 * file BEFORE forking, so the daemon never inherits the exec pipes and the
 * host-side exec returns instead of blocking on EOF.
 *
 * PATH ordering is load-bearing: `/usr/bin` MUST precede the toolchain dir so
 * the base image's privileged `/usr/bin/newuidmap` wins over the unprivileged
 * copy shipped in the toolchain — rootlesskit v2 hard-fails without a
 * newuidmap/newgidmap that can write a multi-range id map. The image grants
 * that through file capabilities and NOT setuid-root; a setuid-root helper
 * raises euid to 0, which forfeits the kernel's owner-of-the-userns capability
 * grant and then fails against the VM's clamped bounding set.
 */
function renderDetachedDaemonStartScript(command: string, path = APPLE_VM_DAEMON_PATH): string {
  return [
    'set -e',
    `exec </dev/null >${APPLE_VM_DAEMON_LOG_PATH} 2>&1`,
    `export XDG_RUNTIME_DIR=${APPLE_VM_DAEMON_API_DIR} HOME=${APPLE_VM_DAEMON_HOME} PATH=${path}`,
    `exec nohup ${command} &`,
  ].join('\n');
}

const APPLE_VM_DAEMON_START_SCRIPT = renderDetachedDaemonStartScript(APPLE_VM_DAEMON_DOCKERD_COMMAND);

type AppleVmEgressRelayProfile = 'images' | 'packages';

function relayCommand(profile: AppleVmEgressRelayProfile, operation: 'serve' | 'probe'): string {
  return (
    `/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C ${APPLE_VM_EGRESS_RELAY_NODE} ` +
    `${APPLE_VM_EGRESS_RELAY_PATH} ${operation} ${profile}`
  );
}

function relayReadinessLines(profile: AppleVmEgressRelayProfile): readonly string[] {
  return [
    'relay_ready=0',
    'relay_attempt=0',
    'while [ "$relay_attempt" -lt 40 ]; do',
    '  /bin/kill -0 "$relay_pid"',
    `  if ${relayCommand(profile, 'probe')}; then relay_ready=1; break; fi`,
    '  relay_attempt=$((relay_attempt + 1))',
    '  /bin/sleep 0.05',
    'done',
    '[ "$relay_ready" -eq 1 ]',
  ];
}

const RELAY_SUPERVISOR_CLEANUP = [
  'cleanup() {',
  '  trap - EXIT INT TERM',
  '  if [ -n "$dockerd_pid" ]; then /bin/kill "$dockerd_pid" 2>/dev/null || true; fi',
  '  if [ -n "$relay_pid" ]; then /bin/kill "$relay_pid" 2>/dev/null || true; fi',
  '  cleanup_attempt=0',
  '  while [ "$cleanup_attempt" -lt 100 ]; do',
  '    dockerd_alive=0',
  '    relay_alive=0',
  '    if [ -n "$dockerd_pid" ] && /bin/kill -0 "$dockerd_pid" 2>/dev/null; then dockerd_alive=1; fi',
  '    if [ -n "$relay_pid" ] && /bin/kill -0 "$relay_pid" 2>/dev/null; then relay_alive=1; fi',
  '    if [ "$dockerd_alive" -eq 0 ] && [ "$relay_alive" -eq 0 ]; then break; fi',
  '    cleanup_attempt=$((cleanup_attempt + 1))',
  '    /bin/sleep 0.05',
  '  done',
  '  if [ -n "$dockerd_pid" ]; then /bin/kill -9 "$dockerd_pid" 2>/dev/null || true; fi',
  '  if [ -n "$relay_pid" ]; then /bin/kill -9 "$relay_pid" 2>/dev/null || true; fi',
  '  if [ -n "$dockerd_pid" ]; then wait "$dockerd_pid" 2>/dev/null || true; fi',
  '  if [ -n "$relay_pid" ]; then wait "$relay_pid" 2>/dev/null || true; fi',
  '}',
];

function renderEgressDaemonInnerScript(profile: AppleVmEgressRelayProfile): string {
  const includePackageRelay = profile === 'packages';
  return [
    ...APPLE_VM_DAEMON_NETWORK_PREREQUISITES,
    `test -S ${APPLE_VM_REGISTRY_EGRESS_SOCKET}`,
    ...(includePackageRelay ? [`test -S ${APPLE_VM_PACKAGE_EGRESS_SOCKET}`] : []),
    'unset ALL_PROXY all_proxy NO_PROXY no_proxy HTTP_PROXY HTTPS_PROXY http_proxy https_proxy SSL_CERT_FILE',
    `export HTTP_PROXY=${APPLE_VM_REGISTRY_EGRESS_PROXY_URL} HTTPS_PROXY=${APPLE_VM_REGISTRY_EGRESS_PROXY_URL}`,
    `export http_proxy=${APPLE_VM_REGISTRY_EGRESS_PROXY_URL} https_proxy=${APPLE_VM_REGISTRY_EGRESS_PROXY_URL}`,
    `export SSL_CERT_FILE=${APPLE_VM_REGISTRY_EGRESS_CA_BUNDLE}`,
    'relay_pid=',
    'dockerd_pid=',
    ...RELAY_SUPERVISOR_CLEANUP,
    'trap cleanup EXIT INT TERM',
    `${relayCommand(profile, 'serve')} &`,
    'relay_pid=$!',
    ...relayReadinessLines(profile),
    `${APPLE_VM_DOCKERD_COMMAND} &`,
    'dockerd_pid=$!',
    'wait -n "$relay_pid" "$dockerd_pid" || true',
    // Either long-lived child exiting is a daemon failure. The EXIT trap
    // terminates and reaps the sibling under a fixed five-second ceiling.
    'exit 1',
  ].join('\n');
}

const APPLE_VM_DAEMON_REGISTRY_EGRESS_INNER_SCRIPT = renderEgressDaemonInnerScript('images');

const APPLE_VM_DAEMON_REGISTRY_EGRESS_START_SCRIPT = renderDetachedDaemonStartScript(
  `rootlesskit --net=none --disable-host-loopback --copy-up=/etc --copy-up=/run /bin/bash -c '${APPLE_VM_DAEMON_REGISTRY_EGRESS_INNER_SCRIPT}'`,
);

/*
 * The package profile binds the independently mounted registry and package
 * UDS endpoints in one all-or-rollback relay process. Dockerd retains the
 * registry-scoped proxy environment; bundle members reach strict package
 * egress explicitly through port 18082.
 */
const APPLE_VM_DAEMON_PACKAGE_EGRESS_INNER_SCRIPT = renderEgressDaemonInnerScript('packages');

const APPLE_VM_DAEMON_PACKAGE_EGRESS_START_SCRIPT = renderDetachedDaemonStartScript(
  `rootlesskit --net=none --disable-host-loopback --copy-up=/etc --copy-up=/run /bin/bash -c '${APPLE_VM_DAEMON_PACKAGE_EGRESS_INNER_SCRIPT}'`,
  APPLE_VM_DAEMON_PACKAGE_PATH,
);

/**
 * Precondition probe: the image-provided API directory is a real directory,
 * owned by the runtime user, with mode 0700 (plan §5.3 requires the socket root
 * to be mode-checked, not merely usable).
 *
 * A writability test is not sufficient. `test -w` follows symlinks, so an agent
 * that tampered with its own writable layer — it is root in its own container
 * via NOPASSWD sudo, and workflow snapshot-resume commits that layer — could
 * replace the API root with a symlink to a host-backed VirtioFS mount such as
 * `/workspace` and have the daemon create `docker.sock`/`dockerd.log` there.
 *
 * `stat` without `-L` reports the link itself, so a planted symlink yields
 * `symbolic link:0:0:777` instead of {@link APPLE_VM_DAEMON_API_DIR_EXPECTED_STAT}.
 * The absolute `/usr/bin/stat` removes the PATH-ordering degree of freedom, the
 * same reason the readiness probe names the toolchain client absolutely.
 */
export const APPLE_VM_DAEMON_API_DIR_STAT_ARGV: readonly string[] = Object.freeze([
  '/usr/bin/stat',
  '-c',
  '%F:%u:%g:%a',
  APPLE_VM_DAEMON_API_DIR,
]);

/**
 * The only accepted {@link APPLE_VM_DAEMON_API_DIR_STAT_ARGV} output:
 * `<file type>:<uid>:<gid>:<octal mode>`. uid/gid 1000 is the base image's
 * `codespace`, which the agent VM cannot renumber (no CAP_CHOWN) and which the
 * Linux uid-remap entrypoint never touches — that path is Docker-on-Linux only,
 * and the same-VM daemon is currently implemented on the Apple backend alone.
 */
export const APPLE_VM_DAEMON_API_DIR_EXPECTED_STAT = 'directory:1000:1000:700';

/** Runtime-user step: start the daemon detached under the frozen invocation. */
export const APPLE_VM_DAEMON_START_ARGV: readonly string[] = Object.freeze(['sh', '-c', APPLE_VM_DAEMON_START_SCRIPT]);

/** Registry-relay variant selected by trusted resolved `networkAccess: "images"`. */
export const APPLE_VM_DAEMON_REGISTRY_EGRESS_START_ARGV: readonly string[] = Object.freeze([
  'sh',
  '-c',
  APPLE_VM_DAEMON_REGISTRY_EGRESS_START_SCRIPT,
]);

/** Registry-scoped dockerd plus an independent strict package relay and build-trust PATH. */
export const APPLE_VM_DAEMON_PACKAGE_EGRESS_START_ARGV: readonly string[] = Object.freeze([
  'sh',
  '-c',
  APPLE_VM_DAEMON_PACKAGE_EGRESS_START_SCRIPT,
]);

/** Readiness probe, through the pinned toolchain client rather than whatever is on PATH. */
export const APPLE_VM_DAEMON_INFO_ARGV: readonly string[] = Object.freeze([
  `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/docker`,
  '--host',
  APPLE_VM_DAEMON_DOCKER_HOST,
  'info',
  '--format',
  '{{json .}}',
]);

/** Best-effort diagnostic quoted into a readiness timeout. */
export const APPLE_VM_DAEMON_LOG_TAIL_ARGV: readonly string[] = Object.freeze([
  'tail',
  '-n',
  '80',
  APPLE_VM_DAEMON_LOG_PATH,
]);

/**
 * Maximum sizes for the in-VM text the readiness probe reports upward.
 *
 * `lifecycle-evidence.ts` derives the `daemon-ready` event's zod `.max()`
 * bounds from this object, so the two can never disagree: without that, an
 * oversized `serverVersion` passes adjudication as a successful readiness and
 * then throws a confusing schema exception at the audit emit instead of failing
 * closed here, where the value entered the host.
 */
export const APPLE_VM_DAEMON_READINESS_TEXT_BOUNDS = PRIVATE_DOCKER_READINESS_TEXT_BOUNDS;

const RUNTIME_EXEC_USER = 'codespace';
const BOOTSTRAP_EXEC_TIMEOUT_MS = 30_000;
const LOG_TAIL_EXEC_TIMEOUT_MS = 5_000;

/** One `stat` line; anything longer is a tampered `stat`, not an observation. */
const STAT_OBSERVATION_MAX_BYTES = 256;

/**
 * Byte budget for the dockerd log tail quoted into a readiness timeout.
 * `tail -n 80` bounds lines but not bytes, and the exec adapter's `maxBuffer`
 * is 50 MB, so without this an in-VM party chooses the size of an
 * `Error.message`. Sized to leave headroom under the 8192-character
 * `incident.detail` bound should a caller record the timeout as evidence.
 */
/** C0/C1 controls and DEL, except the tab and newline a log tail legitimately carries. */
const CONTROL_CHARACTERS = /[^\P{Cc}\n\t]/gu;

export interface AppleVmDaemonExecResult {
  readonly stdout: string;
  /** Runtime adapters may preserve stderr for bounded bootstrap diagnostics. */
  readonly stderr?: string;
  readonly exitCode: number;
}

/**
 * The single command seam over the agent VM. `user` is always explicit — every
 * command here runs as the runtime user, and none may silently inherit the
 * runtime's default exec identity.
 */
export type AppleVmDaemonExec = (
  argv: readonly string[],
  options: { readonly user: string | null; readonly timeoutMs: number },
) => Promise<AppleVmDaemonExecResult>;

/** The adjudicated daemon configuration; the field set the `daemon-ready` evidence event records. */
export type AppleVmDaemonReadiness = PrivateDockerDaemonReadiness;

/** Bind the common private-Docker client to the Apple VM command seam once. */
export function createAppleVmDaemonPrivateDockerClient(
  exec: AppleVmDaemonExec,
  containerId = 'apple-vm',
): PrivateDockerClient {
  return {
    containerId,
    execute: async (args, timeoutMs) => {
      const result = await exec([PRIVATE_DOCKER_CLIENT, '--host', APPLE_VM_DAEMON_DOCKER_HOST, ...args], {
        user: RUNTIME_EXEC_USER,
        timeoutMs: timeoutMs ?? 15_000,
      });
      return { ...result, stderr: result.stderr ?? '' };
    },
  };
}

/** Readiness ceiling and test seams retained under the Apple compatibility API. */
export type WaitForAppleVmDaemonReadyOptions = Pick<
  WaitForPrivateDockerDaemonReadyOptions,
  'timeoutMs' | 'pollIntervalMs' | 'now' | 'sleep'
>;

/**
 * Assert the image-provided API directory is usable, then start the rootless
 * daemon. Both steps run as the runtime user and both fail closed; the daemon
 * must never create its own API directory, or its ownership and mode would be
 * whatever umask happened to apply.
 */
export async function bootstrapAppleVmDaemon(
  exec: AppleVmDaemonExec,
  options: { readonly networkAccess?: 'offline' | 'images' | 'packages' } = {},
): Promise<void> {
  await assertApiDirectoryProvided(exec);
  const startArgv =
    options.networkAccess === 'packages'
      ? APPLE_VM_DAEMON_PACKAGE_EGRESS_START_ARGV
      : options.networkAccess === 'images'
        ? APPLE_VM_DAEMON_REGISTRY_EGRESS_START_ARGV
        : APPLE_VM_DAEMON_START_ARGV;
  await execOrThrow(exec, startArgv, RUNTIME_EXEC_USER, 'apple-vm daemon start');
}

/**
 * Poll `docker info` until the DAEMON answers, then adjudicate its
 * configuration exactly once.
 *
 * "Did the daemon answer at all" is the retry discriminator, not the CLI's exit
 * code: the client exits nonzero against an unreachable socket today, but it
 * can also exit 0 with a client-only skeleton (empty `Driver`/`ServerVersion`,
 * `ServerErrors` populated). Both mean the daemon is still starting, so both
 * retry until the deadline. A populated-but-wrong configuration is a different
 * thing entirely and fails closed on the spot.
 */
export async function waitForAppleVmDaemonReady(
  exec: AppleVmDaemonExec,
  options: WaitForAppleVmDaemonReadyOptions,
): Promise<AppleVmDaemonReadiness> {
  return waitForPrivateDockerDaemonReady(createAppleVmDaemonPrivateDockerClient(exec), {
    ...options,
    label: 'apple-vm daemon',
    readLogTail: async () =>
      exec(APPLE_VM_DAEMON_LOG_TAIL_ARGV, {
        user: RUNTIME_EXEC_USER,
        timeoutMs: LOG_TAIL_EXEC_TIMEOUT_MS,
      }),
  });
}

/**
 * The base image owns this directory because the agent VM cannot create it:
 * without CAP_CHOWN in the VM's bounding set, `install -d -o 1000` fails. Name
 * the image requirement in the error — the alternative symptom is a readiness
 * timeout that blames the daemon for a missing directory.
 */
async function assertApiDirectoryProvided(exec: AppleVmDaemonExec): Promise<void> {
  const result = await exec(APPLE_VM_DAEMON_API_DIR_STAT_ARGV, {
    user: RUNTIME_EXEC_USER,
    timeoutMs: BOOTSTRAP_EXEC_TIMEOUT_MS,
  });
  const observed =
    result.exitCode === 0
      ? boundedDiagnostic(result.stdout, STAT_OBSERVATION_MAX_BYTES)
      : `(stat exited ${result.exitCode})`;
  if (observed !== APPLE_VM_DAEMON_API_DIR_EXPECTED_STAT) {
    throw new Error(
      `apple-vm daemon API directory ${APPLE_VM_DAEMON_API_DIR} failed its mode check: ` +
        `expected "${APPLE_VM_DAEMON_API_DIR_EXPECTED_STAT}", observed "${observed}"; ` +
        'the agent base image must provide it as a real directory owned by the runtime user with mode 0700',
    );
  }
}

async function execOrThrow(
  exec: AppleVmDaemonExec,
  argv: readonly string[],
  user: string,
  description: string,
): Promise<void> {
  const result = await exec(argv, { user, timeoutMs: BOOTSTRAP_EXEC_TIMEOUT_MS });
  if (result.exitCode !== 0) throw new Error(`${description} failed with exit code ${result.exitCode}`);
}

/**
 * Make in-VM text safe to embed in a host-side error: drop control characters
 * (so a log line cannot inject terminal escapes into an operator's console) and
 * truncate to a byte budget the writer does not choose. Truncation can split a
 * multi-byte sequence, which decodes to U+FFFD — acceptable for a diagnostic.
 */
function boundedDiagnostic(text: string, maxBytes: number): string {
  const sanitized = text.replace(CONTROL_CHARACTERS, '').trim();
  const bytes = Buffer.from(sanitized, 'utf8');
  if (bytes.byteLength <= maxBytes) return sanitized;
  return `${bytes.subarray(0, maxBytes).toString('utf8')}… (truncated)`;
}
