/**
 * Synchronous Docker availability checks for use in `describe.skipIf(...)`.
 *
 * Vitest's `skipIf` evaluates synchronously, so we shell out via
 * `execFileSync` and cache the result for the test process lifetime.
 */

import { execFileSync } from 'node:child_process';

let dockerAvailable: boolean | undefined;
const imageAvailable = new Map<string, boolean>();

export function isDockerAvailable(): boolean {
  if (dockerAvailable !== undefined) return dockerAvailable;
  try {
    execFileSync('docker', ['info'], { timeout: 5_000, stdio: 'pipe' });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

export function isDockerImageAvailable(image: string): boolean {
  const cached = imageAvailable.get(image);
  if (cached !== undefined) return cached;
  try {
    execFileSync('docker', ['image', 'inspect', image], { timeout: 5_000, stdio: 'pipe' });
    imageAvailable.set(image, true);
    return true;
  } catch {
    imageAvailable.set(image, false);
    return false;
  }
}
