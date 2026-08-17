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

import { z } from 'zod';

/** VM-local Docker API directory (plan §4.2), created 0700 by the base image and owned by the runtime user. */
export const APPLE_VM_DAEMON_API_DIR = '/run/ironcurtain-docker';

/** VM-local Docker API socket. Never bound to TCP and never published out of the VM. */
export const APPLE_VM_DAEMON_SOCKET = `${APPLE_VM_DAEMON_API_DIR}/docker.sock`;

/** The `DOCKER_HOST` value the in-VM agent process receives. */
export const APPLE_VM_DAEMON_DOCKER_HOST = `unix://${APPLE_VM_DAEMON_SOCKET}`;

/** Exact Apple file mount visible on both sides of rootlesskit's `/run` copy-up. */
export const APPLE_VM_REGISTRY_EGRESS_SOCKET = '/tmp/ironcurtain-registry-egress.sock';

/** Rootless-netns loopback proxy; reachable only by bundle members that join that netns. */
export const APPLE_VM_REGISTRY_EGRESS_PROXY_URL = 'http://127.0.0.1:18081';

/** Public trust bundle already staged read-only in the outer orientation mount. */
export const APPLE_VM_REGISTRY_EGRESS_CA_BUNDLE = '/etc/ironcurtain/ca-bundle.pem';

/**
 * Pinned daemon toolchain staged by the base image. dockerd/rootlesskit/
 * containerd/runc live here and stay OFF the default PATH; only the `docker`
 * client is symlinked into a PATH directory.
 */
export const APPLE_VM_DAEMON_TOOLCHAIN_DIR = '/usr/local/lib/ironcurtain-docker/bin';

/** Exact legacy helper selected on the trusted daemon bootstrap's private PATH. */
export const APPLE_VM_DAEMON_IPTABLES = `${APPLE_VM_DAEMON_TOOLCHAIN_DIR}/iptables`;

/** In-VM dockerd log — the only diagnostic surface a readiness timeout can quote. */
export const APPLE_VM_DAEMON_LOG_PATH = `${APPLE_VM_DAEMON_API_DIR}/dockerd.log`;

const APPLE_VM_DAEMON_HOME = '/home/codespace';
const APPLE_VM_DAEMON_PATH = `/usr/bin:/bin:${APPLE_VM_DAEMON_TOOLCHAIN_DIR}`;

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
const APPLE_VM_DAEMON_START_SCRIPT = [
  'set -e',
  `exec </dev/null >${APPLE_VM_DAEMON_LOG_PATH} 2>&1`,
  `export XDG_RUNTIME_DIR=${APPLE_VM_DAEMON_API_DIR} HOME=${APPLE_VM_DAEMON_HOME} PATH=${APPLE_VM_DAEMON_PATH}`,
  `exec nohup ${APPLE_VM_DAEMON_DOCKERD_COMMAND} &`,
].join('\n');

const APPLE_VM_DAEMON_REGISTRY_EGRESS_INNER_SCRIPT = [
  ...APPLE_VM_DAEMON_NETWORK_PREREQUISITES,
  `test -S ${APPLE_VM_REGISTRY_EGRESS_SOCKET}`,
  'unset ALL_PROXY all_proxy NO_PROXY no_proxy HTTP_PROXY HTTPS_PROXY http_proxy https_proxy SSL_CERT_FILE',
  `export HTTP_PROXY=${APPLE_VM_REGISTRY_EGRESS_PROXY_URL} HTTPS_PROXY=${APPLE_VM_REGISTRY_EGRESS_PROXY_URL}`,
  `export http_proxy=${APPLE_VM_REGISTRY_EGRESS_PROXY_URL} https_proxy=${APPLE_VM_REGISTRY_EGRESS_PROXY_URL}`,
  `export SSL_CERT_FILE=${APPLE_VM_REGISTRY_EGRESS_CA_BUNDLE}`,
  `/usr/bin/socat TCP-LISTEN:18081,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${APPLE_VM_REGISTRY_EGRESS_SOCKET} &`,
  'relay_pid=$!',
  'trap "/bin/kill $relay_pid 2>/dev/null || true" EXIT',
  'relay_ready=0',
  'relay_attempt=0',
  'while [ "$relay_attempt" -lt 40 ]; do',
  '  /bin/kill -0 "$relay_pid"',
  '  if /usr/bin/printf "GET http://ironcurtain.invalid/__ironcurtain/health HTTP/1.1\\r\\nHost: ironcurtain.invalid\\r\\nConnection: close\\r\\n\\r\\n" | /usr/bin/socat -T1 - TCP:127.0.0.1:18081,connect-timeout=1 | /bin/grep -q "IRONCURTAIN_OK/1"; then relay_ready=1; break; fi',
  '  relay_attempt=$((relay_attempt + 1))',
  '  /bin/sleep 0.05',
  'done',
  '[ "$relay_ready" -eq 1 ]',
  'trap - EXIT',
  `exec ${APPLE_VM_DOCKERD_COMMAND}`,
].join('\n');

const APPLE_VM_DAEMON_REGISTRY_EGRESS_START_SCRIPT = [
  'set -e',
  `exec </dev/null >${APPLE_VM_DAEMON_LOG_PATH} 2>&1`,
  `export XDG_RUNTIME_DIR=${APPLE_VM_DAEMON_API_DIR} HOME=${APPLE_VM_DAEMON_HOME} PATH=${APPLE_VM_DAEMON_PATH}`,
  `exec nohup rootlesskit --net=none --disable-host-loopback --copy-up=/etc --copy-up=/run sh -c '${APPLE_VM_DAEMON_REGISTRY_EGRESS_INNER_SCRIPT}' &`,
].join('\n');

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

/** Proxy-aware variant selected only by trusted resolved `public-registry` configuration. */
export const APPLE_VM_DAEMON_REGISTRY_EGRESS_START_ARGV: readonly string[] = Object.freeze([
  'sh',
  '-c',
  APPLE_VM_DAEMON_REGISTRY_EGRESS_START_SCRIPT,
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
export const APPLE_VM_DAEMON_READINESS_TEXT_BOUNDS = Object.freeze({
  driverLength: 128,
  serverVersionLength: 128,
  securityOptionLength: 256,
  securityOptionCount: 64,
});

const RUNTIME_EXEC_USER = 'codespace';
const REQUIRED_STORAGE_DRIVER = 'vfs';
const ROOTLESS_SECURITY_OPTION = 'name=rootless';
const BOOTSTRAP_EXEC_TIMEOUT_MS = 30_000;
const INFO_PROBE_EXEC_TIMEOUT_MS = 15_000;
const LOG_TAIL_EXEC_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

/** One `stat` line; anything longer is a tampered `stat`, not an observation. */
const STAT_OBSERVATION_MAX_BYTES = 256;

/**
 * Byte budget for the dockerd log tail quoted into a readiness timeout.
 * `tail -n 80` bounds lines but not bytes, and the exec adapter's `maxBuffer`
 * is 50 MB, so without this an in-VM party chooses the size of an
 * `Error.message`. Sized to leave headroom under the 8192-character
 * `incident.detail` bound should a caller record the timeout as evidence.
 */
const LOG_TAIL_MAX_BYTES = 4096;

/** C0/C1 controls and DEL, except the tab and newline a log tail legitimately carries. */
const CONTROL_CHARACTERS = /[^\P{Cc}\n\t]/gu;

export interface AppleVmDaemonExecResult {
  readonly stdout: string;
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
export interface AppleVmDaemonReadiness {
  readonly driver: string;
  readonly securityOptions: readonly string[];
  readonly serverVersion: string;
  readonly readinessMs: number;
}

export interface WaitForAppleVmDaemonReadyOptions {
  /** Readiness ceiling; supplied by the wiring layer (`APPLE_VM_DAEMON_READINESS_TIMEOUT_MS`). */
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const dockerInfoSchema = z.object({
  Driver: z.string().min(1),
  SecurityOptions: z.array(z.string().min(1)).nullish(),
  ServerVersion: z.string().min(1),
});

type AdjudicatedReadiness = Omit<AppleVmDaemonReadiness, 'readinessMs'>;

/**
 * One `docker info` answer, classified before it is adjudicated. `daemon-silent`
 * means the client answered but the daemon did not, which is a liveness signal
 * and therefore the retryable outcome.
 */
type DockerInfoAnswer =
  | { readonly kind: 'daemon-silent' }
  | { readonly kind: 'daemon-answered'; readonly readiness: AdjudicatedReadiness };

/**
 * Assert the image-provided API directory is usable, then start the rootless
 * daemon. Both steps run as the runtime user and both fail closed; the daemon
 * must never create its own API directory, or its ownership and mode would be
 * whatever umask happened to apply.
 */
export async function bootstrapAppleVmDaemon(
  exec: AppleVmDaemonExec,
  options: { readonly registryEgress?: boolean } = {},
): Promise<void> {
  await assertApiDirectoryProvided(exec);
  await execOrThrow(
    exec,
    options.registryEgress === true ? APPLE_VM_DAEMON_REGISTRY_EGRESS_START_ARGV : APPLE_VM_DAEMON_START_ARGV,
    RUNTIME_EXEC_USER,
    'apple-vm daemon start',
  );
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
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const startedAtMs = now();
  const deadlineMs = startedAtMs + options.timeoutMs;

  for (;;) {
    const probe = await exec(APPLE_VM_DAEMON_INFO_ARGV, {
      user: RUNTIME_EXEC_USER,
      timeoutMs: INFO_PROBE_EXEC_TIMEOUT_MS,
    });
    if (probe.exitCode === 0) {
      const answer = readDockerInfoAnswer(probe.stdout);
      if (answer.kind === 'daemon-answered') {
        return { ...answer.readiness, readinessMs: now() - startedAtMs };
      }
    }
    if (now() >= deadlineMs) {
      throw new Error(
        `apple-vm daemon did not become ready within ${options.timeoutMs}ms; dockerd log tail:\n${await readDockerdLogTail(exec)}`,
      );
    }
    await sleep(pollIntervalMs);
  }
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

/** Parse one successful probe, adjudicating only an answer the daemon produced. */
function readDockerInfoAnswer(stdout: string): DockerInfoAnswer {
  const parsed = parseDockerInfoJson(stdout);
  if (!daemonAnswered(parsed)) return { kind: 'daemon-silent' };
  return { kind: 'daemon-answered', readiness: adjudicateDockerInfo(parsed) };
}

/**
 * Whether the reply carries a server block at all.
 *
 * `docker info` reports the client's own view when it cannot reach a daemon:
 * `ServerErrors` lists the connection failure and the server fields come back
 * empty. Treating that as an unsupported configuration would fail a session for
 * a daemon that simply had not finished starting.
 */
function daemonAnswered(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const info = parsed as Record<string, unknown>;
  if (Array.isArray(info.ServerErrors) && info.ServerErrors.length > 0) return false;
  return isNonEmptyString(info.Driver) && isNonEmptyString(info.ServerVersion);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function adjudicateDockerInfo(parsed: unknown): AdjudicatedReadiness {
  const info = validateDockerInfoShape(parsed);
  assertBoundedDockerInfoText(info);
  const securityOptions = info.SecurityOptions ?? [];
  if (info.Driver !== REQUIRED_STORAGE_DRIVER) {
    throw new Error(
      `apple-vm daemon readiness rejected an unsupported storage driver: expected ${REQUIRED_STORAGE_DRIVER}, received ${info.Driver}`,
    );
  }
  if (!securityOptions.includes(ROOTLESS_SECURITY_OPTION)) {
    throw new Error(
      `apple-vm daemon readiness rejected a non-rootless daemon: ${ROOTLESS_SECURITY_OPTION} missing from [${securityOptions.join(', ')}]`,
    );
  }
  return { driver: info.Driver, securityOptions, serverVersion: info.ServerVersion };
}

function parseDockerInfoJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('apple-vm daemon readiness could not parse the docker info JSON');
  }
}

function validateDockerInfoShape(parsed: unknown): z.infer<typeof dockerInfoSchema> {
  const result = dockerInfoSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('apple-vm daemon readiness received docker info JSON without Driver/SecurityOptions/ServerVersion');
  }
  return result.data;
}

/**
 * Reject in-VM text that exceeds what the evidence record can hold, BEFORE the
 * configuration checks quote it and before the caller records it. Failing here
 * keeps an oversized value from being adjudicated as a successful readiness and
 * then rejected by the audit schema, which reads as a host bug rather than the
 * fail-closed decision it is.
 */
function assertBoundedDockerInfoText(info: z.infer<typeof dockerInfoSchema>): void {
  const bounds = APPLE_VM_DAEMON_READINESS_TEXT_BOUNDS;
  assertBoundedField('Driver', info.Driver, bounds.driverLength);
  assertBoundedField('ServerVersion', info.ServerVersion, bounds.serverVersionLength);
  const securityOptions = info.SecurityOptions ?? [];
  if (securityOptions.length > bounds.securityOptionCount) {
    throw new Error(
      `apple-vm daemon readiness rejected oversized docker info text: SecurityOptions has ${securityOptions.length} entries, bound is ${bounds.securityOptionCount}`,
    );
  }
  securityOptions.forEach((option, index) =>
    assertBoundedField(`SecurityOptions[${index}]`, option, bounds.securityOptionLength),
  );
}

function assertBoundedField(field: string, value: string, maxLength: number): void {
  if (value.length > maxLength) {
    throw new Error(
      `apple-vm daemon readiness rejected oversized docker info text: ${field} is ${value.length} characters, bound is ${maxLength}`,
    );
  }
}

/** One extra exec, itself failure-tolerant: a missing log must not mask the timeout. */
async function readDockerdLogTail(exec: AppleVmDaemonExec): Promise<string> {
  try {
    const tail = await exec(APPLE_VM_DAEMON_LOG_TAIL_ARGV, {
      user: RUNTIME_EXEC_USER,
      timeoutMs: LOG_TAIL_EXEC_TIMEOUT_MS,
    });
    if (tail.exitCode !== 0) return '(dockerd log unavailable)';
    const text = boundedDiagnostic(tail.stdout, LOG_TAIL_MAX_BYTES);
    return text.length > 0 ? text : '(dockerd log is empty)';
  } catch {
    return '(dockerd log unavailable)';
  }
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

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
