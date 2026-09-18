import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareDockerAgentStartup } from '../../src/docker/agent-startup.js';
import { createDockerManager } from '../../src/docker/docker-manager.js';
import { DOCKER_AGENT_VOLUME_SHADOW } from '../../src/docker/docker-agent-volume-shadow.js';
import { stageRuntimeTrust } from '../../src/docker/runtime-trust.js';
import { isDockerAvailable, isDockerImageAvailable } from '../helpers/docker-available.js';

const dockerAvailable = process.platform === 'linux' && isDockerAvailable();
for (const adapter of ['claude-code', 'goose', 'codex']) {
  const image = `ironcurtain-${adapter}:latest`;
  describe.skipIf(!dockerAvailable || !isDockerImageAvailable(image))(`${adapter} non-1000 startup handoff`, () => {
    it('waits for the real entrypoint before named-user exec and the writable-storage probe', async () => {
      const docker = createDockerManager();
      const startup = prepareDockerAgentStartup(['sleep', 'infinity'], true);
      const trustDirectory = mkdtempSync(join(tmpdir(), 'ic-startup-trust-'));
      let id: string | undefined;
      try {
        const previousUmask = process.umask(0o077);
        try {
          writeFileSync(join(trustDirectory, 'private-config'), 'private fixture', { mode: 0o600 });
          stageRuntimeTrust(trustDirectory, '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----', []);
        } finally {
          process.umask(previousUmask);
        }
        id = await docker.create({
          name: `ic-startup-test-${randomUUID()}`,
          image,
          network: 'none',
          mounts: [{ source: trustDirectory, target: '/run/startup-trust-test', readonly: true }],
          env: { IRONCURTAIN_AGENT_UID: '1101', IRONCURTAIN_AGENT_GID: '1102' },
          user: '0:0',
          command: [...startup.command],
          capAdd: ['SETUID', 'SETGID', 'CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'AUDIT_WRITE'],
          trustedCreateOptions: { tmpfs: [DOCKER_AGENT_VOLUME_SHADOW.specification] },
        });
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
        const otherUid = process.getuid?.() === 65534 ? '65533:65533' : '65534:65534';
        expect(
          await docker.exec(
            id,
            [
              '/bin/sh',
              '-ec',
              'test -r /run/startup-trust-test/ca-bundle.pem; test ! -r /run/startup-trust-test/private-config',
            ],
            5000,
            otherUid,
          ),
        ).toMatchObject({ exitCode: 0 });
        const previousMarker = await docker.exec(id, ['cat', startup.command[4]]);
        expect(previousMarker.exitCode).toBe(0);
        await docker.stop(id);
        await docker.start(id);
        // The writable-layer marker survives stop/start, but it must not
        // admit execs until CMD publishes the new init process identity.
        await startup.waitUntilReady(docker, id);
        const restartedMarker = await docker.exec(id, ['cat', startup.command[4]]);
        expect(restartedMarker.exitCode).toBe(0);
        expect(restartedMarker.stdout).not.toBe(previousMarker.stdout);
        expect(
          await docker.exec(id, ['/bin/sh', '-ec', 'test "$HOME" = /home/codespace; test "$(id -u)" = 1101']),
        ).toMatchObject({ exitCode: 0 });
      } finally {
        if (id !== undefined) await docker.remove(id);
        rmSync(trustDirectory, { recursive: true, force: true });
      }
    }, 240_000);
  });
}
