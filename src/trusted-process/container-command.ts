/**
 * Container-CLI translation for Docker-based MCP server commands.
 *
 * Several bundled MCP servers run as containers via `docker run -i --rm
 * [-e VAR] <image>` (e.g. the GitHub MCP server). On machines using the
 * Apple `container` runtime instead of Docker (see
 * docs/designs/apple-container-runtime.md), the `docker` binary does not
 * exist — but the Apple CLI accepts the same `run -i --rm -e VAR <image>`
 * invocation, so the spawn can be translated by swapping the binary.
 *
 * The translation is deliberately narrow: only `docker run ...` commands
 * are rewritten, only when `docker` is absent AND `container` is present,
 * and only the binary name changes — the argument array passes through
 * untouched (no string assembly; see the Safe Coding rules).
 */

import { spawnSync } from 'node:child_process';

/** Probe cache: binary name → exists on PATH. One probe per process. */
const existsCache = new Map<string, boolean>();

/**
 * Returns true when `bin --version` can be spawned (the binary exists on
 * PATH). A non-zero exit still counts as existing — only a spawn error
 * (ENOENT et al.) counts as missing.
 */
export function commandExists(bin: string): boolean {
  const cached = existsCache.get(bin);
  if (cached !== undefined) return cached;
  const result = spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 10_000 });
  const exists = result.error === undefined;
  existsCache.set(bin, exists);
  return exists;
}

export interface ContainerSpawnSpec {
  readonly command: string;
  readonly args: string[];
  /** True when the spawn was rewritten from `docker` to `container`. */
  readonly translated: boolean;
}

/**
 * Rewrites a `docker run ...` MCP server spawn to the Apple `container`
 * CLI when Docker is unavailable but `container` is present. Everything
 * else passes through unchanged — including `docker run` on machines
 * that have Docker, and non-`run` docker subcommands (which have no
 * guaranteed CLI parity).
 */
export function resolveContainerSpawnCommand(
  command: string,
  args: readonly string[],
  binExists: (bin: string) => boolean = commandExists,
): ContainerSpawnSpec {
  if (command !== 'docker' || args[0] !== 'run') {
    return { command, args: [...args], translated: false };
  }
  if (binExists('docker') || !binExists('container')) {
    return { command, args: [...args], translated: false };
  }
  return { command: 'container', args: [...args], translated: true };
}
