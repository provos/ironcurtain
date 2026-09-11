import { describe, expect, it, vi } from 'vitest';
import {
  bindDockerEndpointExec,
  dockerEndpointSchema,
  resolveDockerEndpoint,
} from '../../src/docker/docker-endpoint.js';
import type { ExecFileFn } from '../../src/docker/docker-manager.js';

describe('captured Docker endpoint', () => {
  it('resolves the named context before environment host and keeps its value across context changes', async () => {
    const env = { DOCKER_CONTEXT: 'desktop-linux', DOCKER_HOST: 'unix:///wrong.sock' };
    const exec = vi.fn<ExecFileFn>().mockResolvedValue({ stdout: '"unix:///selected.sock"', stderr: '' });
    const endpoint = await resolveDockerEndpoint(exec, env);
    expect(exec).toHaveBeenCalledWith(
      'docker',
      ['context', 'inspect', 'desktop-linux', '--format', '{{json .Endpoints.docker.Host}}'],
      expect.any(Object),
    );
    env.DOCKER_CONTEXT = 'elsewhere';
    env.DOCKER_HOST = 'unix:///changed.sock';
    const bound = bindDockerEndpointExec(endpoint, exec);
    await bound('docker', ['info'], {
      env: {
        ...env,
        DOCKER_TLS_VERIFY: '1',
        DOCKER_CERT_PATH: '/changed',
        DOCKER_DEFAULT_PLATFORM: 'linux/arm64',
        TOKEN: 'kept',
      },
    });
    expect(exec.mock.lastCall).toEqual([
      'docker',
      ['--host', 'unix:///selected.sock', 'info'],
      {
        env: { DOCKER_HOST: 'unix:///selected.sock', TOKEN: 'kept' },
      },
    ]);
    expect(env.DOCKER_HOST).toBe('unix:///changed.sock');
  });

  it('uses an explicit host without consulting mutable context configuration', async () => {
    const exec = vi.fn<ExecFileFn>();
    await expect(resolveDockerEndpoint(exec, { DOCKER_HOST: 'unix:///explicit.sock' })).resolves.toEqual({
      host: 'unix:///explicit.sock',
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('captures current context when no environment selection exists', async () => {
    const exec = vi
      .fn<ExecFileFn>()
      .mockResolvedValueOnce({ stdout: 'desktop-linux\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '"unix:///current.sock"\n', stderr: '' });
    await expect(resolveDockerEndpoint(exec, {})).resolves.toEqual({ host: 'unix:///current.sock' });
    expect(exec.mock.calls.map((call) => call[1].slice(0, 3))).toEqual([
      ['context', 'show'],
      ['context', 'inspect', 'desktop-linux'],
    ]);
  });

  it.each(['tcp://remote:2375', 'ssh://remote', 'unix:///tmp/../other.sock', 'unix:///tmp/a%2fb', 'unix:///'])(
    'rejects unqualified or ambiguous endpoint %s',
    (host) => {
      expect(() => dockerEndpointSchema.parse({ host })).toThrow();
    },
  );
});
