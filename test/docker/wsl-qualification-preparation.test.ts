import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { prepareWslQualificationImages } from '../../scripts/prepare-wsl-qualification.js';
import type { ensureDockerImage } from '../../src/docker/docker-infrastructure.js';

const preparedWslEnvironment = {
  dockerWorkloadEnvironment: {
    profile: 'wsl-desktop',
    architecture: 'amd64',
    egressTransport: 'unix',
    server: {
      architecture: 'amd64',
      operatingSystem: 'Docker Desktop',
      osType: 'linux',
      serverVersion: '29.4.1',
      kernelVersion: '6.18.33.2',
      cgroupVersion: '2',
      securityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
    },
  },
} as Awaited<ReturnType<typeof ensureDockerImage>>;

describe('WSL qualification image preparation', () => {
  it('prepares every required UID-test adapter through admitted Offline source resolution', async () => {
    const previousHome = process.env.IRONCURTAIN_HOME;
    const homes: string[] = [];
    const ensure = vi.fn<typeof ensureDockerImage>().mockImplementation(async () => {
      const home = process.env.IRONCURTAIN_HOME!;
      homes.push(home);
      expect(existsSync(home)).toBe(true);
      return preparedWslEnvironment;
    });
    await prepareWslQualificationImages(ensure);
    expect(ensure.mock.calls.map(([id]) => id)).toEqual(['claude-code', 'goose', 'codex']);
    for (const [, config] of ensure.mock.calls) {
      expect(config.containerRuntime).toBe('docker');
      expect(config.dockerWorkload).toMatchObject({ enabled: true, networkAccess: 'offline' });
      expect(config.dockerResources).toEqual({ memoryMb: 4096, cpus: 2 });
    }
    expect(process.env.IRONCURTAIN_HOME).toBe(previousHome);
    expect(new Set(homes).size).toBe(1);
    expect(existsSync(homes[0])).toBe(false);
  });

  it('fails immediately if a required image cannot be prepared', async () => {
    const previousHome = process.env.IRONCURTAIN_HOME;
    let home: string | undefined;
    const ensure = vi.fn<typeof ensureDockerImage>().mockImplementation(async () => {
      home = process.env.IRONCURTAIN_HOME;
      throw new Error('required image build failed');
    });
    await expect(prepareWslQualificationImages(ensure)).rejects.toThrow('required image build failed');
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(process.env.IRONCURTAIN_HOME).toBe(previousHome);
    expect(home).toBeDefined();
    expect(existsSync(home!)).toBe(false);
  });

  it('requires every prepared image to carry the admitted WSL environment observation', async () => {
    const ensure = vi
      .fn<typeof ensureDockerImage>()
      .mockResolvedValueOnce(preparedWslEnvironment)
      .mockResolvedValueOnce({} as Awaited<ReturnType<typeof ensureDockerImage>>);

    await expect(prepareWslQualificationImages(ensure)).rejects.toThrow('admitted WSL Docker Desktop environment');
    expect(ensure).toHaveBeenCalledTimes(2);
  });
});
