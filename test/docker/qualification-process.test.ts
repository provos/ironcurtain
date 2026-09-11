import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { waitForQualificationProcess } from '../../src/docker-workload/qualification-process.js';

describe('qualification process ownership', () => {
  it('removes its signal handlers after a normal exit', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { detached: true, stdio: 'ignore' });
    await expect(waitForQualificationProcess(child, 5_000)).resolves.toEqual({
      code: 0,
      signal: null,
      timedOut: false,
    });
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  it('handles failed spawn without an unhandled error', async () => {
    const child = spawn('/ironcurtain-missing-qualification-executable', [], { detached: true, stdio: 'ignore' });
    const closed = new Promise<void>((resolvePromise) => child.once('close', () => resolvePromise()));
    await expect(waitForQualificationProcess(child, 5_000)).rejects.toThrow(/no process group ID/);
    await closed;
  });

  it.each(['timeout', 'SIGINT', 'SIGTERM'] as const)(
    'reaps the child and descendant after %s',
    async (cause) => {
      const coordinator = spawn(
        process.execPath,
        ['--import', 'tsx', resolve('test/docker/fixtures/qualification-process.ts'), cause],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      coordinator.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const closed = once(coordinator, 'close');
      let groupId: number | undefined;
      try {
        let stdout = '';
        const identities = await new Promise<{ childPid: number; descendantPid: number }>((resolvePromise, reject) => {
          coordinator.once('error', reject);
          coordinator.once('exit', () => reject(new Error(`coordinator exited before readiness: ${stderr}`)));
          coordinator.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
            if (stdout.includes('\n'))
              resolvePromise(JSON.parse(stdout.trim()) as { childPid: number; descendantPid: number });
          });
        });
        groupId = identities.childPid;
        if (cause !== 'timeout') coordinator.kill(cause);
        const [code] = await closed;
        expect(code, stderr).toBe(1);
        expect(stderr).toContain(cause === 'timeout' ? 'timed out' : `interrupted by ${cause}`);
        for (const pid of [identities.childPid, identities.descendantPid, -identities.childPid]) {
          expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
        }
      } finally {
        if (coordinator.exitCode === null && coordinator.signalCode === null) coordinator.kill('SIGKILL');
        if (groupId !== undefined) {
          try {
            process.kill(-groupId, 'SIGKILL');
          } catch {
            /* The asserted group normally is already absent. */
          }
        }
        await closed;
      }
    },
    15_000,
  );
});
