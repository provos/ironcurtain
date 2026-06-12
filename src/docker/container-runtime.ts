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
import type { DockerAvailability } from '../session/preflight.js';
import type { ContainerRuntimeSetting } from '../config/user-config.js';
import { createDockerManager } from './docker-manager.js';
import { createAppleContainerManager, checkAppleContainerAvailable } from './apple-container-manager.js';
import * as logger from '../logger.js';

export const CONTAINER_RUNTIME_KINDS = ['docker', 'apple-container'] as const;
export type ContainerRuntimeKind = (typeof CONTAINER_RUNTIME_KINDS)[number];

function isContainerRuntimeKind(value: string): value is ContainerRuntimeKind {
  return (CONTAINER_RUNTIME_KINDS as readonly string[]).includes(value);
}

/**
 * Parses the `IRONCURTAIN_CONTAINER_RUNTIME` env override. Returns
 * undefined when unset; unknown values fail loudly rather than silently
 * running a different sandbox than the operator asked for.
 */
function parseEnvOverride(env: NodeJS.ProcessEnv): ContainerRuntimeKind | undefined {
  const requested = env.IRONCURTAIN_CONTAINER_RUNTIME;
  if (requested === undefined || requested === '') return undefined;
  if (!isContainerRuntimeKind(requested)) {
    throw new Error(
      `Unknown IRONCURTAIN_CONTAINER_RUNTIME value "${requested}" (expected one of: ${CONTAINER_RUNTIME_KINDS.join(', ')})`,
    );
  }
  return requested;
}

/**
 * Memoized result of the 'auto' probe. One process serves one machine,
 * so the answer cannot change mid-run, and memoizing keeps the three
 * resolution sites (session preflight, infrastructure setup, image
 * ensure) agreeing without re-probing the container apiserver.
 */
let autoResolution: ContainerRuntimeKind | undefined;

/** Test hook: clears the memoized 'auto' probe result. */
export function resetRuntimeKindResolutionForTests(): void {
  autoResolution = undefined;
}

/**
 * Resolves which runtime kind agent sessions should use.
 *
 * Precedence: `IRONCURTAIN_CONTAINER_RUNTIME` env override > the
 * `containerRuntime` config field > 'auto'. 'auto' picks apple-container
 * when its availability probe passes (Apple silicon, macOS 26+,
 * container CLI >= 1.0 with services running) and Docker otherwise.
 * See docs/designs/apple-container-runtime.md, design decision 6.
 */
export async function resolveRuntimeKind(
  configured: ContainerRuntimeSetting = 'auto',
  env: NodeJS.ProcessEnv = process.env,
  appleProbe: () => Promise<DockerAvailability> = checkAppleContainerAvailable,
): Promise<ContainerRuntimeKind> {
  const override = parseEnvOverride(env);
  if (override !== undefined) return override;
  if (configured !== 'auto') return configured;

  if (autoResolution === undefined) {
    const apple = await appleProbe();
    autoResolution = apple.available ? 'apple-container' : 'docker';
    logger.info(
      apple.available
        ? `containerRuntime=auto: using apple-container (probe passed)`
        : `containerRuntime=auto: using docker (apple-container unavailable: ${apple.reason})`,
    );
  }
  return autoResolution;
}

export function createContainerRuntime(kind: ContainerRuntimeKind = 'docker'): ContainerRuntime {
  switch (kind) {
    case 'docker':
      return createDockerManager();
    case 'apple-container':
      return createAppleContainerManager();
  }
}
