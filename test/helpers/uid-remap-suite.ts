/** Shared live entrypoint contract for every adapter using UID remapping. */
import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCKER_AGENT_VOLUME_SHADOW } from '../../src/docker/docker-agent-volume-shadow.js';
import { isDockerAvailable, isDockerImageAvailable } from './docker-available.js';

const execFile = promisify(execFileCallback);
const caps = ['SETUID', 'SETGID', 'CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'AUDIT_WRITE'];

export function runUidRemapSuite(image: string): void {
  const ready = process.platform === 'linux' && isDockerAvailable() && isDockerImageAvailable(image);
  describe.skipIf(!ready)(`${image} UID remap and sudo`, () => {
    it.each([
      { uid: 1500, gid: 1500 },
      { uid: 1500, gid: 100 },
      { uid: 1000, gid: 100 },
    ])(
      'preserves host ownership with UID$uid and GID$gid',
      async ({ uid, gid }) => {
        const directory = mkdtempSync(resolve(tmpdir(), 'ic-uid-'));
        const workspace = resolve(directory, 'workspace');
        const mountedState = resolve(directory, 'state');
        mkdirSync(workspace, { mode: 0o700 });
        mkdirSync(mountedState);
        writeFileSync(resolve(workspace, 'preserve-owner'), 'host fixture');
        writeFileSync(resolve(mountedState, 'preserve-owner'), 'host mounted state');
        const name = `ic-uid-test-${randomUUID()}`;
        const hostUid = process.getuid!();
        const hostGid = process.getgid!();
        const prepare = async (command: string) =>
          execFile(
            'docker',
            [
              'run',
              '--rm',
              '--network',
              'none',
              '--tmpfs',
              DOCKER_AGENT_VOLUME_SHADOW.specification,
              '--user',
              '0:0',
              '--entrypoint',
              '/bin/sh',
              '--mount',
              `type=bind,src=${directory},dst=/fixture`,
              image,
              '-c',
              command,
            ],
            { timeout: 30_000 },
          );
        try {
          // Emulate the already-owned private root of a different host identity.
          // The contained file deliberately retains another owner: startup must
          // preserve it, just as it must preserve a nested home bind mount.
          await prepare(`chown ${uid}:${gid} /fixture/workspace`);
          const { stdout } = await execFile(
            'docker',
            [
              'run',
              '--rm',
              '--name',
              name,
              '--network',
              'none',
              '--tmpfs',
              DOCKER_AGENT_VOLUME_SHADOW.specification,
              '--cap-drop',
              'ALL',
              ...caps.flatMap((cap) => ['--cap-add', cap]),
              '--user',
              '0:0',
              '-e',
              `IRONCURTAIN_AGENT_UID=${uid}`,
              '-e',
              `IRONCURTAIN_AGENT_GID=${gid}`,
              '--mount',
              `type=bind,src=${workspace},dst=/workspace`,
              '--mount',
              `type=bind,src=${mountedState},dst=/home/codespace/test-mounted-state[1]*?`,
              image,
              'sh',
              '-ec',
              `test "$(id -u)" = ${uid}; test "$(id -g)" = ${gid}; ` +
                `test "$(stat -c %u:%g /home/codespace)" = ${uid}:${gid}; ` +
                'test "$(sudo -n id -u)" = 0; printf roundtrip > /workspace/created; echo remap-ok',
            ],
            { timeout: 150_000 },
          );
          expect(stdout).toContain('remap-ok');
          expect(statSync(mountedState).uid).toBe(hostUid);
          expect(statSync(mountedState).gid).toBe(hostGid);
          expect(statSync(resolve(mountedState, 'preserve-owner')).uid).toBe(hostUid);
          expect(statSync(resolve(mountedState, 'preserve-owner')).gid).toBe(hostGid);
          // Examine the mode-0700 fixture through trusted test setup, not by
          // weakening permissions for the coordinator's original host account.
          const result = await prepare(
            'stat -c %u:%g /fixture/workspace /fixture/workspace/preserve-owner /fixture/workspace/created',
          );
          expect(result.stdout.trim().split('\n')).toEqual([`${uid}:${gid}`, `${hostUid}:${hostGid}`, `${uid}:${gid}`]);
        } finally {
          await execFile('docker', ['rm', '-f', name], { timeout: 10_000 }).catch(() => {});
          // Restore every owned fixture even when a broken entrypoint changed
          // the nested state bind's owner. Otherwise cleanup hides the original
          // assertion failure and leaves inaccessible host files behind.
          await prepare(`chown -R ${hostUid}:${hostGid} /fixture`);
          rmSync(directory, { recursive: true, force: true });
        }
      },
      180_000,
    );

    it.each([
      {
        reason: 'a UID collision',
        uid: 33,
        gid: 33,
        setup: ':',
        diagnostic: /\[ironcurtain\] usermod failed:/,
      },
      ...['mkdir /nonexistent', 'ln -s /missing-home /nonexistent'].map((setup) => ({
        reason: `an unsafe temporary account home (${setup})`,
        uid: 1500,
        gid: 1500,
        setup,
        diagnostic: /\[ironcurtain\] cannot remap codespace: temporary account home \/nonexistent must be absent/,
      })),
    ])('rejects $reason with a diagnostic', async ({ uid, gid, setup, diagnostic }) => {
      const name = `ic-uid-test-${randomUUID()}`;
      try {
        await expect(
          execFile(
            'docker',
            [
              'run',
              '--rm',
              '--name',
              name,
              '--network',
              'none',
              '--tmpfs',
              DOCKER_AGENT_VOLUME_SHADOW.specification,
              '--user',
              '0:0',
              '--entrypoint',
              '/bin/bash',
              '-e',
              `IRONCURTAIN_AGENT_UID=${uid}`,
              '-e',
              `IRONCURTAIN_AGENT_GID=${gid}`,
              image,
              '-ec',
              `${setup}; exec /usr/local/bin/entrypoint.sh true`,
            ],
            { timeout: 15_000 },
          ),
        ).rejects.toMatchObject({ stderr: expect.stringMatching(diagnostic) });
      } finally {
        // Killing a timed-out Docker CLI does not stop its container.
        await execFile('docker', ['rm', '-f', name], { timeout: 10_000 }).catch(() => {});
      }
    });
  });
}
