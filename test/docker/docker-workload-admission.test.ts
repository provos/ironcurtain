import { describe, expect, it, vi } from 'vitest';
import type { ResolvedUserConfig } from '../../src/config/user-config.js';
import {
  assertDockerWorkloadImplementationAvailable,
  resolveDockerWorkloadConfig,
} from '../../src/docker-workload/config.js';

const registerBuiltinAdapters = vi.fn();
const resolveRuntimeKind = vi.fn();

vi.mock('../../src/docker/agent-registry.js', () => ({
  registerBuiltinAdapters,
  getAgent: vi.fn(() => {
    throw new Error('adapter lookup must not run');
  }),
}));
vi.mock('../../src/docker/container-runtime.js', () => ({
  createContainerRuntime: vi.fn(() => {
    throw new Error('runtime creation must not run');
  }),
  resolveRuntimeKind,
}));

describe('secure nested Docker admission fuse', () => {
  it('is a no-op for absent and explicitly disabled capability', () => {
    expect(() => assertDockerWorkloadImplementationAvailable(undefined)).not.toThrow();
    expect(() => assertDockerWorkloadImplementationAvailable(resolveDockerWorkloadConfig(undefined))).not.toThrow();
  });

  it('rejects opt-in before adapter, runtime, image, relay, or daemon work', async () => {
    const { ensureDockerImage } = await import('../../src/docker/docker-infrastructure.js');
    await expect(
      ensureDockerImage('claude-code', {
        dockerWorkload: resolveDockerWorkloadConfig({ enabled: true }),
      } as ResolvedUserConfig),
    ).rejects.toThrow(/not implementation-qualified.*no image, relay, or daemon action was performed/u);
    expect(registerBuiltinAdapters).not.toHaveBeenCalled();
    expect(resolveRuntimeKind).not.toHaveBeenCalled();
  });
});
