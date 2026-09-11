/** Test-only environment selection and short Unix-socket paths. */
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ContainerRuntimeKind } from '../src/docker/container-runtime.js';
import type { BundleId } from '../src/session/types.js';
import {
  getBundleControlSocketPath,
  getBundleMitmControlSocketPath,
  getBundleMitmProxySocketPath,
  getBundlePackageEgressSocketPath,
  getBundleProxySocketPath,
  getBundleRegistryEgressSocketPath,
  getBundleSocketsDir,
} from '../src/config/paths.js';
import { PTY_SOCK_NAME } from '../src/docker/pty-types.js';

export type SmokeTarget = 'apple' | 'docker-desktop' | 'wsl-desktop';
const PROBE_BUNDLE = 'ffffffff-ffff-4fff-8fff-ffffffffffff' as BundleId;

export function parseSmokeTarget(argv: readonly string[]): {
  readonly target: SmokeTarget | undefined;
  readonly arguments: readonly string[];
} {
  let target: SmokeTarget | undefined;
  const arguments_: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument !== '--environment') {
      arguments_.push(argument);
      continue;
    }
    const value = argv[++index];
    if (target !== undefined || (value !== 'apple' && value !== 'docker-desktop' && value !== 'wsl-desktop')) {
      throw new Error('usage: --environment must occur once with apple, docker-desktop or wsl-desktop');
    }
    target = value;
  }
  return { target, arguments: arguments_ };
}

export function smokeRuntimeKind(target: SmokeTarget): ContainerRuntimeKind {
  return target === 'apple' ? 'apple-container' : 'docker';
}

/** Runtime/placement seam shared by the host workflow runner and its future sidecar probes. */
export function workflowSmokePlacement(target: SmokeTarget): {
  readonly runtimeKind: ContainerRuntimeKind;
  readonly daemonPlacement: 'same-vm' | 'sidecar';
} {
  return { runtimeKind: smokeRuntimeKind(target), daemonPlacement: target === 'apple' ? 'same-vm' : 'sidecar' };
}

/** Deliberately ignore TMPDIR: macOS login-session temp paths can exceed sun_path. */
export function createSmokeRoot(prefix: 'ic-na-' | 'ic-naw-', platform: NodeJS.Platform = process.platform): string {
  const parent = realpathSync(platform === 'darwin' ? '/private/tmp' : '/tmp');
  const root = realpathSync(mkdtempSync(join(parent, prefix)));
  try {
    chmodSync(root, 0o700);
    assertSmokeSocketPathBudget(resolve(root, 'home'), platform);
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function assertSmokeSocketPathBudget(home: string, platform: NodeJS.Platform = process.platform): void {
  const budget = platform === 'linux' ? 108 : 104;
  const paths = withIronCurtainHome(home, () => [
    getBundleControlSocketPath(PROBE_BUNDLE),
    getBundleProxySocketPath(PROBE_BUNDLE),
    getBundleMitmProxySocketPath(PROBE_BUNDLE),
    getBundleMitmControlSocketPath(PROBE_BUNDLE),
    getBundleRegistryEgressSocketPath(PROBE_BUNDLE),
    getBundlePackageEgressSocketPath(PROBE_BUNDLE),
    resolve(getBundleSocketsDir(PROBE_BUNDLE), PTY_SOCK_NAME),
  ]);
  for (const path of paths) {
    const bytes = Buffer.byteLength(path);
    if (bytes >= budget) {
      throw new Error(`smoke UDS path exceeds ${platform} sockaddr_un budget (${bytes} >= ${budget} bytes): ${path}`);
    }
  }
}

/** Only synchronous path getters may run while the process-wide override is installed. */
export function withIronCurtainHome<T>(home: string, operation: () => T): T {
  const previous = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = home;
  try {
    return operation();
  } finally {
    if (previous === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previous;
  }
}
