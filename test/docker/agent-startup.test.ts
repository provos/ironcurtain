import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { prepareDockerAgentStartup } from '../../src/docker/agent-startup.js';
import type { ContainerRuntime } from '../../src/docker/types.js';

function runtime() {
  return {
    exec: vi.fn<ContainerRuntime['exec']>().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
    isRunning: vi.fn<ContainerRuntime['isRunning']>().mockResolvedValue(true),
    readContainerLogTail: vi
      .fn<NonNullable<ContainerRuntime['readContainerLogTail']>>()
      .mockResolvedValue('entrypoint failed'),
  };
}

describe('Docker agent startup handoff', () => {
  it('leaves non-remapped runtimes untouched', async () => {
    const command = ['sleep', 'infinity'];
    const startup = prepareDockerAgentStartup(command, false);
    const docker = runtime();
    expect(startup.command).toBe(command);
    await startup.waitUntilReady(docker, 'agent');
    expect(docker.exec).not.toHaveBeenCalled();
  });

  it('signals only when CMD runs, preserves argument boundaries and leaves umask unchanged', () => {
    const startup = prepareDockerAgentStartup(
      ['/bin/sh', '-c', 'printf "%s\\n" "$1"; umask', 'test', 'literal $value; *'],
      true,
    );
    const marker = startup.command[4];
    expect(existsSync(marker)).toBe(false);
    expect(prepareDockerAgentStartup(['true'], true).command[4]).not.toBe(marker);
    try {
      const output = execFileSync(startup.command[0], [...startup.command.slice(1)], { encoding: 'utf8' });
      expect(output.trim().split('\n')).toEqual(['literal $value; *', process.umask().toString(8).padStart(4, '0')]);
      expect(statSync(marker).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(marker, { force: true });
    }
  });

  it('waits as numeric root, never resolving codespace while its account is changing', async () => {
    const startup = prepareDockerAgentStartup(['sleep', 'infinity'], true);
    const docker = runtime();
    docker.exec.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
    await startup.waitUntilReady(docker, 'agent', { pollIntervalMs: 1 });
    expect(docker.exec).toHaveBeenCalledTimes(2);
    for (const call of docker.exec.mock.calls) {
      expect(call).toEqual([
        'agent',
        ['/bin/sh', '-c', 'test -f "$1"', 'ironcurtain-agent-startup', startup.command[4]],
        5000,
        '0:0',
      ]);
    }
  });

  it.each([true, false])('reports timeout or exit with entrypoint logs (running=%s)', async (running) => {
    const docker = runtime();
    docker.exec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    docker.isRunning.mockResolvedValue(running);
    const startup = prepareDockerAgentStartup(['sleep', 'infinity'], true);
    await expect(startup.waitUntilReady(docker, 'agent', { timeoutMs: 0 })).rejects.toThrow(
      running
        ? /did not become ready within 0ms[\s\S]*entrypoint failed/
        : /exited before becoming ready[\s\S]*entrypoint failed/,
    );
  });
});
