/**
 * Docker availability probe (leaf module).
 *
 * The single canonical "is Docker available?" check, extracted here so that
 * runtime modules (`docker-manager.ts`, `container-runtime.ts`,
 * `apple-container-manager.ts`) can depend on it without importing
 * `session/preflight.ts` — which itself lazily reaches back into the
 * container-runtime backends. Keeping the probe in a dependency-free leaf
 * breaks that import cycle.
 *
 * This module must stay a leaf: it may import only Node built-ins and
 * `utils/exec-error.js`. Do not add imports from `session/`, `docker/`
 * runtime modules, or any layer that could reach back here.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { isExecError, isExecTimeout } from '../utils/exec-error.js';

const execFile = promisify(execFileCb);

/**
 * Per-attempt timeout for `docker info`. The daemon call can be slow under
 * load (cold daemon, busy machine), so we use a generous timeout and retry
 * on timeout-class failures rather than tightening the bound.
 */
const DOCKER_PROBE_TIMEOUT_MS = 10_000;

/** Maximum number of additional attempts after the first one. */
const DOCKER_PROBE_MAX_RETRIES = 2;

const DOCKER_UNAVAILABLE_REASON = 'Docker not available';

/**
 * Function signature for `execFile` injection in tests. Matches the shape of
 * `promisify(child_process.execFile)` for the subset of options we use.
 */
export type ProbeExecFileFn = (
  cmd: string,
  args: readonly string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Result of a container-runtime availability probe. */
export type DockerAvailability = { available: true } | { available: false; reason: string; detailedMessage: string };

function describeProbeFailure(err: unknown, fallback: string): string {
  if (!isExecError(err)) return fallback;

  if (err.code === 'ENOENT') {
    return 'The "docker" command was not found in your PATH. Is Docker installed?';
  }

  const stderr = err.stderr.trim();
  if (stderr.length === 0) return fallback;
  if (stderr.includes('permission denied')) {
    return 'Permission denied while connecting to the Docker daemon socket.\nIs your user in the "docker" group?';
  }
  if (stderr.includes('Cannot connect to the Docker daemon')) {
    return (
      'Cannot connect to the Docker daemon.\n' +
      'Is the Docker service running? On macOS/Windows, ensure Docker Desktop is started.'
    );
  }
  return stderr;
}

/**
 * Single canonical "is Docker available?" probe for the entire codebase. Other
 * modules MUST call this rather than re-implementing `docker info`.
 *
 * `docker info` can blow past a tight timeout on a cold/busy daemon, so we use
 * a generous 10s per attempt and retry on timeout-class failures. We do NOT
 * retry on deterministic failures (ENOENT, permission denied, "Cannot connect
 * to the Docker daemon") — those won't change between attempts and the
 * user-visible failure path should be fast.
 *
 * @param execFileFn Optional `execFile` implementation for tests.
 */
export async function checkDockerAvailable(execFileFn: ProbeExecFileFn = execFile): Promise<DockerAvailability> {
  const totalAttempts = DOCKER_PROBE_MAX_RETRIES + 1;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      await execFileFn('docker', ['info'], { timeout: DOCKER_PROBE_TIMEOUT_MS });
      return { available: true };
    } catch (err: unknown) {
      lastErr = err;
      if (!isExecError(err) || !isExecTimeout(err)) {
        return {
          available: false,
          reason: DOCKER_UNAVAILABLE_REASON,
          detailedMessage: describeProbeFailure(err, err instanceof Error ? err.message : String(err)),
        };
      }
    }
  }

  const baseMessage = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const timeoutSeconds = DOCKER_PROBE_TIMEOUT_MS / 1000;
  return {
    available: false,
    reason: DOCKER_UNAVAILABLE_REASON,
    detailedMessage:
      `Docker daemon did not respond within ${timeoutSeconds}s after ${totalAttempts} attempts. ` +
      `The daemon may be overloaded or starting up. Original error: ${baseMessage}`,
  };
}
