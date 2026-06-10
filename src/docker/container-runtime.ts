/**
 * Container runtime selection seam.
 *
 * Agent-session infrastructure obtains its ContainerRuntime through this
 * factory instead of constructing a specific implementation, so adding a
 * runtime is a new case here rather than a change at every call site.
 * Docker-specific host services (signal-cli container, daemon orphan
 * sweeps) intentionally keep using `createDockerManager()` directly.
 *
 * See docs/designs/apple-container-runtime.md.
 */

import type { ContainerRuntime } from './types.js';
import { createDockerManager } from './docker-manager.js';
import { createAppleContainerManager } from './apple-container-manager.js';

export const CONTAINER_RUNTIME_KINDS = ['docker', 'apple-container'] as const;
export type ContainerRuntimeKind = (typeof CONTAINER_RUNTIME_KINDS)[number];

function isContainerRuntimeKind(value: string): value is ContainerRuntimeKind {
  return (CONTAINER_RUNTIME_KINDS as readonly string[]).includes(value);
}

/**
 * Resolves which runtime kind agent sessions should use.
 *
 * Interim selector until the `containerRuntime` config field lands
 * (phase 4 of docs/designs/apple-container-runtime.md): the
 * `IRONCURTAIN_CONTAINER_RUNTIME` env var picks the backend, defaulting
 * to Docker. Unknown values fail loudly rather than silently running a
 * different sandbox than the operator asked for.
 */
export function resolveContainerRuntimeKind(env: NodeJS.ProcessEnv = process.env): ContainerRuntimeKind {
  const requested = env.IRONCURTAIN_CONTAINER_RUNTIME;
  if (requested === undefined || requested === '') return 'docker';
  if (!isContainerRuntimeKind(requested)) {
    throw new Error(
      `Unknown IRONCURTAIN_CONTAINER_RUNTIME value "${requested}" (expected one of: ${CONTAINER_RUNTIME_KINDS.join(', ')})`,
    );
  }
  return requested;
}

export function createContainerRuntime(kind: ContainerRuntimeKind = 'docker'): ContainerRuntime {
  switch (kind) {
    case 'docker':
      return createDockerManager();
    case 'apple-container':
      return createAppleContainerManager();
  }
}
