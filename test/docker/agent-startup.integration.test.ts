import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prepareDockerAgentStartup } from '../../src/docker/agent-startup.js';
import { createDockerManager } from '../../src/docker/docker-manager.js';
import { DOCKER_AGENT_VOLUME_SHADOW } from '../../src/docker/docker-agent-volume-shadow.js';
import { isDockerAvailable, isDockerImageAvailable } from '../helpers/docker-available.js';

const dockerAvailable = process.platform === 'linux' && isDockerAvailable();
for (const adapter of ['claude-code', 'goose', 'codex']) {
  const image = `ironcurtain-${adapter}:latest`;
  describe.skipIf(!dockerAvailable || !isDockerImageAvailable(image))(`${adapter} non-1000 startup handoff`, () => {
    it('waits for the real entrypoint before named-user exec and the writable-storage probe', async () => {
      const docker = createDockerManager();
      const startup = prepareDockerAgentStartup(['sleep', 'infinity'], true);
      const id = await docker.create({
        name: `ic-startup-test-${randomUUID()}`,
        image,
        network: 'none',
        mounts: [],
        env: { IRONCURTAIN_AGENT_UID: '1101', IRONCURTAIN_AGENT_GID: '1102' },
        user: '0:0',
        command: [...startup.command],
        capAdd: ['SETUID', 'SETGID', 'CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'AUDIT_WRITE'],
        trustedCreateOptions: { tmpfs: [DOCKER_AGENT_VOLUME_SHADOW.specification] },
      });
      try {
        await docker.start(id);
        await startup.waitUntilReady(docker, id);
        const result = await docker.exec(id, [
          '/bin/sh',
          '-ec',
          'test "$(id -u)" = 1101; test "$(id -g)" = 1102; test "$HOME" = /home/codespace; ' +
            'test "$(stat -c %u:%g /home/codespace)" = 1101:1102; test "$(sudo -n id -u)" = 0; ' +
            'probe="${HOME:-/home/codespace}/.ironcurtain-write-probe-$$"; mkdir "$probe"; rmdir "$probe"; echo ready-ok',
        ]);
        expect(result).toMatchObject({ exitCode: 0, stdout: 'ready-ok\n' });
      } finally {
        await docker.remove(id);
      }
    }, 120_000);
  });
}
