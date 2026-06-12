/**
 * Docker container resource limits: read configured ceilings, clamp them
 * against the host's actual capacity, and (optionally) probe the resolved
 * values against Docker before a real session tries to start.
 *
 * The flow has three layers, applied in order:
 *
 *   1. CONFIG     -- `userConfig.dockerResources` (or defaults). `null` = no
 *                    limit (omit the flag), `number` = ceiling.
 *   2. CLAMP      -- `clampDockerResources()` lowers any `number` that
 *                    exceeds the host's reported capacity. Nulls pass through.
 *   3. PROBE      -- `probeDockerResources()` actually invokes `docker run`
 *                    with the clamped values and parses any error from Docker
 *                    into a suggested set of lowered values.
 *
 * Steps 1 and 2 run on every Docker container creation. Step 3 is opt-in,
 * used by `ironcurtain doctor` and the first-start wizard.
 */

import * as os from 'node:os';
import * as logger from '../logger.js';
import { defaultExecFile, type ExecFileFn } from './docker-manager.js';
import type { ResolvedDockerResourcesConfig } from '../config/user-config.js';

export type { ExecFileFn };

/** Host capacity snapshot. Pure value object — no side effects on read. */
export interface HostResources {
  /** Number of logical CPUs visible to this process. Always >= 1. */
  readonly cpus: number;
  /** Total physical memory in megabytes (1 MB == 1,000,000 bytes per Docker's convention). */
  readonly memoryMb: number;
}

/**
 * Resolved limits ready to hand to `DockerContainerConfig.resources`.
 *
 * `undefined` (not `null`) is the wire format the docker-manager builder
 * expects when it should omit the flag. We translate config nulls into
 * undefined at this seam.
 */
export interface EffectiveDockerResources {
  readonly memoryMb: number | undefined;
  readonly cpus: number | undefined;
}

/** Result of clamping configured limits against host capacity. */
export interface ClampedDockerResources {
  readonly effective: EffectiveDockerResources;
  /** True if any clamp actually changed a value (for logging). */
  readonly clamped: boolean;
  /** The pre-clamp values (for diagnostics). */
  readonly requested: ResolvedDockerResourcesConfig;
  /** The host capacity snapshot used for clamping. */
  readonly host: HostResources;
}

/** Docker's documented absolute minimums for these flags. */
export const DOCKER_MIN_CPUS = 0.01;
export const DOCKER_MIN_MEMORY_MB = 6;

/**
 * Reads the host's CPU count and total memory in MB.
 *
 * Memory uses Docker's convention of 1 MB = 1,000,000 bytes so the value
 * lines up with what `docker info` reports and what the `--memory` flag
 * expects. Node's `os.totalmem()` returns bytes, hence the division.
 *
 * Caveat: on macOS, `os.cpus()` / `os.totalmem()` report the host machine,
 * not the Docker Desktop VM (which is typically smaller and user-
 * configurable). A clamp based on these values is necessary but NOT
 * sufficient — the VM may still reject a request the host could satisfy.
 * `probeDockerResources()` is the authoritative check when it matters.
 */
let cachedHost: HostResources | undefined;

export function getHostResources(): HostResources {
  if (cachedHost === undefined) {
    const cpus = Math.max(1, os.cpus().length);
    const memoryMb = Math.max(DOCKER_MIN_MEMORY_MB, Math.floor(os.totalmem() / 1_000_000));
    cachedHost = { cpus, memoryMb };
  }
  return cachedHost;
}

/**
 * Clamps configured Docker resource limits to fit the host's actual capacity.
 *
 * Rules:
 *   - `null` means "explicitly no limit": pass through as `undefined` (omit
 *     the flag). We do NOT clamp nulls.
 *   - `number` is treated as a user-supplied ceiling. We lower it if it
 *     exceeds what we can safely give the container:
 *       * cpus    -> hostCpus - 1 on multi-core hosts, DOCKER_MIN_CPUS on
 *                    single-core hosts (reserving a full core would leave
 *                    none for the container)
 *       * memoryMb-> floor(hostMemoryMb * 0.75)  // leave 25% headroom
 *   - The final value is also bounded below by Docker's own minimum so we
 *     never produce a request Docker would reject for being too small.
 */
export function clampDockerResources(
  configured: ResolvedDockerResourcesConfig,
  host: HostResources = getHostResources(),
): ClampedDockerResources {
  const cpus = configured.cpus === null ? undefined : clampCpus(configured.cpus, host);
  const memoryMb = configured.memoryMb === null ? undefined : clampMemory(configured.memoryMb, host);

  let clamped = false;
  if (cpus !== undefined && cpus !== configured.cpus) {
    clamped = true;
    logger.info(`Clamping container --cpus from ${configured.cpus} to ${cpus} (host has ${host.cpus} CPUs)`);
  }
  if (memoryMb !== undefined && memoryMb !== configured.memoryMb) {
    clamped = true;
    logger.info(
      `Clamping container --memory from ${configured.memoryMb}MB to ${memoryMb}MB (host has ${host.memoryMb}MB total)`,
    );
  }

  return {
    effective: { memoryMb, cpus },
    clamped,
    requested: configured,
    host,
  };
}

function clampCpus(configured: number, host: HostResources): number {
  // Reserve one core for the host on multi-core machines; on a single-core
  // host we still allow Docker its minimum (0.01).
  const ceiling = host.cpus > 1 ? host.cpus - 1 : DOCKER_MIN_CPUS;
  return clampNumber(configured, DOCKER_MIN_CPUS, ceiling);
}

function clampMemory(configured: number, host: HostResources): number {
  const ceiling = Math.max(DOCKER_MIN_MEMORY_MB, Math.floor(host.memoryMb * 0.75));
  return clampNumber(configured, DOCKER_MIN_MEMORY_MB, ceiling);
}

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// ─── Probe ──────────────────────────────────────────────────────

/** Outcome of `probeDockerResources()`. */
export type ProbeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly stderr: string;
      /**
       * Best-guess lowered values parsed from the stderr message. Present
       * fields should be tried by the caller; missing fields mean we
       * couldn't extract a suggestion for that dimension.
       */
      readonly suggested?: { readonly cpus?: number; readonly memoryMb?: number };
    };

/** Wall-clock cap for the probe. Docker run + image inspect should be well under 30s. */
const PROBE_TIMEOUT_MS = 30_000;

/** Wall-clock cap for `docker image inspect`. Should be near-instant on a healthy daemon. */
const IMAGE_INSPECT_TIMEOUT_MS = 10_000;

/**
 * CLI binary the probes exec. The `docker` and Apple `container` CLIs
 * share the `image inspect` / `run --rm --cpus --memory` surface these
 * probes need (verified against container 1.0.0); only the memory-suffix
 * case differs.
 */
export type ResourceProbeBin = 'docker' | 'container';

/**
 * Returns true iff `<bin> image inspect <image>` exits 0 — i.e. the image
 * is present locally and the probe can run without pulling.
 *
 * Doctor MUST NOT pull images during diagnostics; this is the gate.
 */
export async function isImagePresent(
  image: string,
  execFile: ExecFileFn = defaultExecFile,
  bin: ResourceProbeBin = 'docker',
): Promise<boolean> {
  try {
    await execFile(bin, ['image', 'inspect', image], { timeout: IMAGE_INSPECT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `<bin> run --rm [--cpus N] [--memory Nm] <image> /usr/bin/true`
 * with the supplied effective resource limits. Returns `{ ok: true }` if
 * the container created and exited cleanly; otherwise returns the captured
 * stderr along with any value suggestions parsed from it (the suggestion
 * parser knows Docker's error phrasing; Apple container failures fall
 * through to the generic stderr rendering).
 *
 * NOTE on `/usr/bin/true`: every Linux base image we ship (including
 * `alpine/socat`) has this at this path. We prefer the absolute path over
 * the shell builtin `true` so we don't depend on the image setting a
 * particular SHELL.
 */
export async function probeDockerResources(
  image: string,
  resources: EffectiveDockerResources,
  execFile: ExecFileFn = defaultExecFile,
  bin: ResourceProbeBin = 'docker',
): Promise<ProbeResult> {
  const args: string[] = ['run', '--rm'];
  if (resources.cpus !== undefined) {
    args.push('--cpus', String(resources.cpus));
  }
  if (resources.memoryMb !== undefined) {
    // The Apple container CLI documents uppercase suffixes (K/M/G/...).
    args.push('--memory', `${resources.memoryMb}${bin === 'container' ? 'M' : 'm'}`);
  }
  args.push(image, '/usr/bin/true');

  try {
    await execFile(bin, args, { timeout: PROBE_TIMEOUT_MS });
    return { ok: true };
  } catch (err) {
    const stderr = extractStderr(err);
    const suggested = parseDockerResourceError(stderr);
    return { ok: false, stderr, ...(suggested ? { suggested } : {}) };
  }
}

/**
 * Pulls a usable stderr string from whatever `execFile` throws. Both
 * `child_process.exec`-style errors and `AbortError`s land here.
 */
function extractStderr(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === 'string' && e.stderr.length > 0) return e.stderr;
    if (typeof e.message === 'string') return e.message;
  }
  return String(err);
}

/**
 * Parses a Docker stderr message into a suggested set of lowered values.
 *
 * Known patterns (case-insensitive matching, real-world examples):
 *
 *   1. "range of CPUs is from 0.01 to 2.00, as there are only 2 CPUs
 *      available" -- suggests `--cpus = upperBound - 1` on multi-core hosts
 *      (leaving a core for the host) or DOCKER_MIN_CPUS on single-core hosts.
 *
 *   2. "Minimum memory limit allowed is 6 MB" -- the user passed something
 *      below 6 MB; suggest the minimum.
 *
 * Returns undefined when no pattern matches (caller will surface stderr
 * verbatim so the user can investigate).
 *
 * Exported for unit testing.
 */
export function parseDockerResourceError(stderr: string): { cpus?: number; memoryMb?: number } | undefined {
  const suggested: { cpus?: number; memoryMb?: number } = {};

  // Pattern 1: "range of CPUs is from <low> to <high>" — Docker's exact upper
  // bound. Leave one core for the host so we don't starve it.
  const cpuUpper = parseNumericGroup(stderr, /range of CPUs is from\s+[0-9.]+\s+to\s+([0-9.]+)/i, DOCKER_MIN_CPUS);
  if (cpuUpper !== undefined) {
    suggested.cpus = cpuUpper > 1 ? cpuUpper - 1 : DOCKER_MIN_CPUS;
  }

  // Pattern 2: "Minimum memory limit allowed is N MB".
  const memMin = parseNumericGroup(stderr, /Minimum memory limit allowed is\s+(\d+)\s*MB/i, DOCKER_MIN_MEMORY_MB);
  if (memMin !== undefined) {
    suggested.memoryMb = memMin;
  }

  return Object.keys(suggested).length > 0 ? suggested : undefined;
}

function parseNumericGroup(stderr: string, pattern: RegExp, min: number): number | undefined {
  const match = pattern.exec(stderr);
  if (!match || !match[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= min ? value : undefined;
}
