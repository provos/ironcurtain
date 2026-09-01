/** Backend-neutral agent-side initialization for the package-build shim. */

import type { DockerBuildShimStagingContract } from '../docker/docker-build-shim.js';
import type { ContainerRuntime } from '../docker/types.js';

export const DOCKER_BUILD_SHIM_PREFLIGHT_TIMEOUT_MS = 15_000;
export const DOCKER_BUILD_SHIM_EXEC_USER = 'codespace';
export const DOCKER_BUILD_SHIM_ROOT_USER = '0:0';
export const DOCKER_BUILD_SHIM_DIAGNOSTIC_MAX_BYTES = 512;

export interface DockerBuildShimExecResult {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

/** One explicit-user exec seam shared by Apple and Docker Desktop agents. */
export type DockerBuildShimExec = (
  argv: readonly string[],
  options: { readonly user: string | null; readonly timeoutMs: number },
) => Promise<DockerBuildShimExecResult>;

/** Bind package-build preflight commands to one already-started agent container. */
export function dockerBuildShimExecFor(
  runtime: Pick<ContainerRuntime, 'exec'>,
  containerId: string,
): DockerBuildShimExec {
  return (argv, options) => runtime.exec(containerId, argv, options.timeoutMs, options.user);
}

export function boundedBuildShimDiagnostic(value: string, maxBytes = DOCKER_BUILD_SHIM_DIAGNOSTIC_MAX_BYTES): string {
  const normalized = value.trim();
  const encoded = Buffer.from(normalized, 'utf8');
  if (encoded.byteLength <= maxBytes) return normalized;
  const suffix = '...';
  const clipped = encoded
    .subarray(0, maxBytes - Buffer.byteLength(suffix))
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
  return `${clipped}${suffix}`;
}

function boundedBuildShimFailureValue(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maxBytes) return value;

  const separator = ' ... ';
  const separatorBytes = Buffer.byteLength(separator);
  if (maxBytes <= separatorBytes) {
    return encoded
      .subarray(0, maxBytes)
      .toString('utf8')
      .replace(/\uFFFD$/u, '');
  }

  const contentBudget = maxBytes - separatorBytes;
  const headBudget = Math.floor(contentBudget / 3);
  const tailBudget = contentBudget - headBudget;
  const head = encoded
    .subarray(0, headBudget)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
  const tail = encoded
    .subarray(encoded.byteLength - tailBudget)
    .toString('utf8')
    .replace(/^\uFFFD+/u, '');
  return `${head}${separator}${tail}`;
}

/** Preserve trusted-preflight output channels without exposing unbounded diagnostics. */
export function boundedBuildShimFailureDiagnostic(
  stdout: string,
  stderr = '',
  annotations: readonly { readonly label: string; readonly value: string }[] = [],
): string {
  const streams = [{ label: 'stdout', value: stdout }, { label: 'stderr', value: stderr }, ...annotations].filter(
    ({ value }) => value.trim() !== '',
  );
  if (streams.length === 0) return '';

  const separator = '; ';
  const labelBytes = streams.reduce((total, { label }) => total + Buffer.byteLength(`[${label}] `), 0);
  const separatorBytes = Buffer.byteLength(separator) * (streams.length - 1);
  const valueBudget = Math.floor(
    (DOCKER_BUILD_SHIM_DIAGNOSTIC_MAX_BYTES - labelBytes - separatorBytes) / streams.length,
  );
  return streams
    .map(({ label, value }) => {
      const singleLine = value
        .trim()
        .replace(/\s+/gu, ' ')
        .replace(/\p{Cc}/gu, '?');
      return `[${label}] ${boundedBuildShimFailureValue(singleLine, valueBudget)}`;
    })
    .join(separator);
}

export async function execDockerBuildShimPreflight(
  exec: DockerBuildShimExec,
  argv: readonly string[],
  description: string,
  user = DOCKER_BUILD_SHIM_EXEC_USER,
): Promise<string> {
  const result = await exec(argv, {
    user,
    timeoutMs: DOCKER_BUILD_SHIM_PREFLIGHT_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    const detail = boundedBuildShimFailureDiagnostic(result.stdout, result.stderr);
    throw new Error(`${description} failed with exit code ${result.exitCode}${detail === '' ? '' : `: ${detail}`}`);
  }
  return boundedBuildShimDiagnostic(result.stdout);
}

const INITIALIZE_BUILD_STATE_SCRIPT = `
set -eu
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 4 ] || exit 64
  path=$1
  uid=$2
  gid=$3
  mode=$4
  shift 4
  [ ! -L "$path" ] || {
    printf 'nested-Docker build state path is a symlink: %s\n' "$path" >&2
    exit 1
  }
  /bin/mkdir --parents -- "$path"
  [ ! -L "$path" ] && [ -d "$path" ] || {
    printf 'nested-Docker build state path is not a real directory: %s\n' "$path" >&2
    exit 1
  }
  /bin/chown "$uid:$gid" -- "$path"
  /bin/chmod "$mode" -- "$path"
done
`;

const VERIFY_BUILD_STATE_SCRIPT = `
set -eu
export LC_ALL=C
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || exit 64
  path=$1
  expected=$2
  shift 2
  observed=$(/usr/bin/stat --format=%F:%u:%g:%a -- "$path")
  if [ "$observed" != "$expected" ]; then
    printf 'nested-Docker build state directory %s failed its owner/mode check: expected "%s", observed "%s"\n' \
      "$path" "$expected" "$observed" >&2
    exit 1
  fi
  probe=$path/.ironcurtain-write-preflight
  [ ! -e "$probe" ] && [ ! -L "$probe" ] || {
    printf 'nested-Docker build state write canary already exists: %s\n' "$probe" >&2
    exit 1
  }
  (umask 077; : > "$probe")
  [ ! -L "$probe" ] && [ -f "$probe" ] || {
    printf 'nested-Docker build state write canary is not a real file: %s\n' "$probe" >&2
    exit 1
  }
  /bin/rm -- "$probe"
  [ ! -e "$probe" ] && [ ! -L "$probe" ] || {
    printf 'nested-Docker build state write canary was not removed: %s\n' "$probe" >&2
    exit 1
  }
done
`;

interface QualifiedBuildStateDirectory {
  readonly path: string;
  readonly uid: string;
  readonly gid: string;
  readonly mode: string;
  readonly expected: string;
}

function qualifyBuildStateDirectories(
  contract: DockerBuildShimStagingContract,
): readonly QualifiedBuildStateDirectory[] {
  const paths = new Set<string>();
  return contract.writableDirectories.map((directory) => {
    if (!directory.path.startsWith('/') || directory.path.includes('\0') || paths.has(directory.path)) {
      throw new Error(`nested-Docker build state directory contract has an invalid path: ${directory.path}`);
    }
    paths.add(directory.path);
    if (
      !Number.isSafeInteger(directory.uid) ||
      directory.uid < 0 ||
      directory.uid > 0xffff_ffff ||
      !Number.isSafeInteger(directory.gid) ||
      directory.gid < 0 ||
      directory.gid > 0xffff_ffff ||
      !Number.isSafeInteger(directory.mode) ||
      directory.mode < 0 ||
      directory.mode > 0o7777
    ) {
      throw new Error(`nested-Docker build state directory contract is invalid for ${directory.path}`);
    }
    const uid = String(directory.uid);
    const gid = String(directory.gid);
    const mode = directory.mode.toString(8);
    return {
      path: directory.path,
      uid,
      gid,
      mode,
      expected: `directory:${uid}:${gid}:${mode}`,
    };
  });
}

/**
 * Create trusted writable state and prove the non-root agent owns it before
 * checking that PATH resolves the staged Docker shim. This runs before either
 * backend activates its lease, so the agent never needs sudo or a repair step.
 */
export async function preflightDockerBuildShimAgent(
  exec: DockerBuildShimExec,
  contract: DockerBuildShimStagingContract,
): Promise<void> {
  const directories = qualifyBuildStateDirectories(contract);
  if (directories.length > 0) {
    await execDockerBuildShimPreflight(
      exec,
      [
        '/bin/sh',
        '-c',
        INITIALIZE_BUILD_STATE_SCRIPT,
        'ironcurtain-build-state-init',
        ...directories.flatMap(({ path, uid, gid, mode }) => [path, uid, gid, mode]),
      ],
      'nested-Docker build state directory initialization',
      DOCKER_BUILD_SHIM_ROOT_USER,
    );
    await execDockerBuildShimPreflight(
      exec,
      [
        '/bin/sh',
        '-c',
        VERIFY_BUILD_STATE_SCRIPT,
        'ironcurtain-build-state-verify',
        ...directories.flatMap(({ path, expected }) => [path, expected]),
      ],
      'nested-Docker build state directory verification',
    );
  }

  const resolvedPath = await execDockerBuildShimPreflight(
    exec,
    ['/bin/sh', '-c', `command -v ${contract.preflight.executable}`],
    'nested-Docker build shim PATH resolution',
  );
  if (resolvedPath !== contract.preflight.expectedPath) {
    throw new Error(
      `nested-Docker build shim PATH resolution selected "${resolvedPath}"; ` +
        `expected "${contract.preflight.expectedPath}"`,
    );
  }
  if (contract.preflight.argv[0] !== contract.preflight.executable) {
    throw new Error('nested-Docker build shim preflight argv does not invoke the PATH-resolved executable');
  }
  await execDockerBuildShimPreflight(exec, contract.preflight.argv, 'nested-Docker build shim version preflight');
}
