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

export function createContainerRuntime(kind: ContainerRuntimeKind = 'docker'): ContainerRuntime {
  switch (kind) {
    case 'docker':
      return createDockerManager();
    case 'apple-container':
      return createAppleContainerManager();
  }
}
