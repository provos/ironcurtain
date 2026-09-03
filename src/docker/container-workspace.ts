import { isAbsolute, resolve } from 'node:path';
import type { DockerMount } from './types.js';

/** The workspace directory shared by host, agent, and nested Docker daemon. */
export const CONTAINER_WORKSPACE_DIR = '/workspace';

/** Build the one host-workspace mount shared by agent and nested-daemon containers. */
export function buildContainerWorkspaceMount(workspaceDir: string): DockerMount {
  // User-selected paths are physically canonicalized by workspace validation.
  // Keep the mount helper filesystem-independent, but reject a source Docker
  // could reinterpret as a named volume or normalize to a different path.
  if (!isAbsolute(workspaceDir) || resolve(workspaceDir) !== workspaceDir || workspaceDir === '/') {
    throw new Error('container workspace source must be a canonical absolute directory below root');
  }
  return { source: workspaceDir, target: CONTAINER_WORKSPACE_DIR, readonly: false };
}
