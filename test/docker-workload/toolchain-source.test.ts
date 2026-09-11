import { describe, expect, it, vi } from 'vitest';
import { resolveDockerToolchainSource } from '../../src/docker-workload/toolchain-source.js';

const image = {
  id: `sha256:${'a'.repeat(64)}`,
  repoTags: ['docker:29.2.1-dind-rootless'],
  repoDigests: [`docker@sha256:${'b'.repeat(64)}`],
  architecture: 'amd64' as const,
  labels: {},
  created: '',
};

describe('shared Docker source selection', () => {
  it('uses the engine-returned immutable source, with no maintained digest inventory', async () => {
    const runtime = { inspectImage: vi.fn().mockResolvedValue(image), pullImage: vi.fn() };
    await expect(resolveDockerToolchainSource(runtime, 'amd64')).resolves.toEqual({
      architecture: 'amd64',
      imageId: image.id,
      reference: image.repoDigests[0],
    });
    expect(runtime.inspectImage).toHaveBeenCalledOnce();
    expect(runtime.pullImage).not.toHaveBeenCalled();
  });

  it('pulls a missing versioned source and captures the resulting identity', async () => {
    const runtime = {
      inspectImage: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(image),
      pullImage: vi.fn(),
    };
    await resolveDockerToolchainSource(runtime, 'amd64');
    expect(runtime.pullImage).toHaveBeenCalledWith('docker:29.2.1-dind-rootless');
  });

  it('rejects a source for the wrong execution architecture', async () => {
    await expect(
      resolveDockerToolchainSource(
        {
          inspectImage: vi.fn().mockResolvedValue(image),
          pullImage: vi.fn(),
        },
        'arm64',
      ),
    ).rejects.toThrow(/does not match execution platform/);
  });

  it('rejects a source whose execution architecture is missing', async () => {
    await expect(
      resolveDockerToolchainSource(
        {
          inspectImage: vi.fn().mockResolvedValue({ ...image, architecture: undefined }),
          pullImage: vi.fn(),
        },
        'amd64',
      ),
    ).rejects.toThrow(/platform \(missing\) does not match execution platform amd64/);
  });

  it('forms an OCI reference from an Apple index ID when RepoDigests is absent', async () => {
    await expect(
      resolveDockerToolchainSource(
        {
          inspectImage: vi
            .fn()
            .mockResolvedValue({ ...image, architecture: 'arm64', repoDigests: undefined, descriptorDigest: image.id }),
          pullImage: vi.fn(),
        },
        'arm64',
      ),
    ).resolves.toMatchObject({ reference: `docker:29.2.1-dind-rootless@${image.id}` });
  });
});
