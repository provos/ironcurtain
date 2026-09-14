import { describe, expect, it } from 'vitest';
import { isWsl2Host, resolveDockerWorkloadEnvironment } from '../../src/docker-workload/environment.js';
import { parseDockerServerFacts } from '../../src/docker/docker-probe.js';

const host = { platform: 'linux', release: '6.18.33.2-microsoft-standard-WSL2' } as const;
const server = parseDockerServerFacts({
  Architecture: 'x86_64',
  OperatingSystem: 'Docker Desktop',
  OSType: 'linux',
  ServerVersion: '29.4.1',
  KernelVersion: '6.18.33.2',
  CgroupVersion: '2',
  SecurityOptions: ['name=seccomp,profile=builtin', 'name=cgroupns'],
});

describe('nested Docker environment selection', () => {
  it('shares one WSL2 host detector across early and fact-based admission', () => {
    expect(isWsl2Host(host.platform, host.release)).toBe(true);
    expect(isWsl2Host('linux', '6.8.0-generic')).toBe(false);
    expect(isWsl2Host('darwin', host.release)).toBe(false);
  });

  it('selects WSL amd64 from server facts without exact version binding', () => {
    expect(resolveDockerWorkloadEnvironment('docker', server, host)).toMatchObject({
      profile: 'wsl-desktop',
      architecture: 'amd64',
      egressTransport: 'unix',
    });
    expect(
      resolveDockerWorkloadEnvironment(
        'docker',
        {
          ...server,
          serverVersion: '30.1.0',
          kernelVersion: '7.0.0',
        },
        host,
      ).profile,
    ).toBe('wsl-desktop');
  });

  it.each([
    [{ ...server, architecture: 'arm64' }, /amd64 only/],
    [{ ...server, operatingSystem: 'Ubuntu' }, /not Docker Desktop/],
    [{ ...server, cgroupVersion: '1' }, /cgroup v2/],
    [{ ...server, securityOptions: [] }, /seccomp/],
    [{ ...server, securityOptions: [...server.securityOptions, 'name=apparmor'] }, /enforcing security options/],
    [{ ...server, osType: 'windows' }, /Linux Docker server/],
  ] as const)('rejects unsupported server facts', (facts, message) => {
    expect(() => resolveDockerWorkloadEnvironment('docker', facts, host)).toThrow(message);
  });

  it('does not turn WSL evidence into native Linux admission', () => {
    expect(() =>
      resolveDockerWorkloadEnvironment('docker', server, {
        platform: 'linux',
        release: '6.8.0-generic',
      }),
    ).toThrow(/native Linux Engine is unqualified/);
  });

  it('preserves the macOS transport and explicit Apple arm64 placement', () => {
    expect(
      resolveDockerWorkloadEnvironment(
        'docker',
        { ...server, architecture: 'arm64' },
        {
          platform: 'darwin',
          release: '25.0.0',
        },
      ),
    ).toMatchObject({ architecture: 'arm64', egressTransport: 'tcp' });
    expect(resolveDockerWorkloadEnvironment('apple-container')).toMatchObject({
      architecture: 'arm64',
      egressTransport: 'unix',
    });
  });
});
