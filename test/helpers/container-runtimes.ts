/**
 * Runtime-aware availability checks for matrixing container integration tests
 * over both the Docker and Apple `container` backends.
 *
 * Vitest's `describe.skipIf(...)` evaluates synchronously, so we shell out via
 * `execFileSync` and cache results for the test process lifetime. Each runtime
 * lane is gated independently: a host with only Docker runs the docker lane and
 * skips apple-container, and vice-versa, so the same suite is portable across
 * CI (Docker) and Apple-silicon dev machines (apple-container).
 */

import { execFileSync } from 'node:child_process';
import type { ContainerRuntimeKind } from '../../src/docker/container-runtime.js';

/** CLI binary for each runtime kind. */
const RUNTIME_CLI: Record<ContainerRuntimeKind, string> = {
  docker: 'docker',
  'apple-container': 'container',
};

/** Args that succeed only when the runtime's services are reachable. */
const RUNTIME_READY_ARGS: Record<ContainerRuntimeKind, readonly string[]> = {
  docker: ['info'],
  'apple-container': ['system', 'status'],
};

const runtimeReady = new Map<ContainerRuntimeKind, boolean>();
const imageReady = new Map<string, boolean>();

/** True when the runtime's CLI is installed and its services are reachable. */
export function isRuntimeAvailable(kind: ContainerRuntimeKind): boolean {
  const cached = runtimeReady.get(kind);
  if (cached !== undefined) return cached;
  try {
    execFileSync(RUNTIME_CLI[kind], [...RUNTIME_READY_ARGS[kind]], { timeout: 8_000, stdio: 'pipe' });
    runtimeReady.set(kind, true);
    return true;
  } catch {
    runtimeReady.set(kind, false);
    return false;
  }
}

/** True when `image` exists locally for the given runtime. */
export function isRuntimeImageAvailable(kind: ContainerRuntimeKind, image: string): boolean {
  const key = `${kind}:${image}`;
  const cached = imageReady.get(key);
  if (cached !== undefined) return cached;
  try {
    execFileSync(RUNTIME_CLI[kind], ['image', 'inspect', image], { timeout: 8_000, stdio: 'pipe' });
    imageReady.set(key, true);
    return true;
  } catch {
    imageReady.set(key, false);
    return false;
  }
}

/**
 * The runtime kinds an integration test should exercise: those whose CLI is
 * reachable AND have the agent `image` built. Returns `[]` when neither is
 * ready, so the matrix simply skips (e.g. on a CI runner without the image).
 */
export function readyRuntimesForImage(image: string): ContainerRuntimeKind[] {
  const all: ContainerRuntimeKind[] = ['docker', 'apple-container'];
  return all.filter((kind) => isRuntimeAvailable(kind) && isRuntimeImageAvailable(kind, image));
}
