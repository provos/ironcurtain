/**
 * Integration test: runtime UID/GID remap in the Goose agent container
 * entrypoint (issue #232 — Goose mirror of `uid-remap.integration.test.ts`).
 *
 * Background. `docker/entrypoint-goose.sh` carries the same remap block as
 * `docker/entrypoint-claude-code.sh` (the block was copied to both
 * entrypoints when the issue #232 fix landed). PR #245 covers the Claude
 * Code adapter; this file is the Goose mirror so a future regression in
 * one entrypoint cannot pass CI by relying only on the other adapter's
 * coverage.
 *
 * Design. Identical to the Claude Code test:
 *
 *   - Direct `docker run` against the prebuilt `ironcurtain-goose:latest`
 *     image (not `runPtySession`). Rationale: `pty-session.ts` mounts a
 *     host-side `socketsDir` created with the real host UID into the
 *     container; once the entrypoint remaps codespace to a synthetic UID,
 *     the renumbered user cannot bind a socket in that bind-mounted
 *     directory because the host-side ownership is unchanged. In real
 *     deployments host UID == IRONCURTAIN_AGENT_UID by construction
 *     (`buildAgentUidRemap`) so the bind mount works; the mock is what
 *     creates the divergence. A direct `docker run` keeps the test
 *     scope tight: we exercise the entrypoint's remap logic, not the PTY
 *     chain. PTY coverage lives in `pty-entrypoint.integration.test.ts`.
 *
 *   - Synthetic UID/GID 1500 forces the remap path. The Goose image is
 *     built from `ironcurtain-base` (same `mcr.microsoft.com/devcontainers
 *     /universal:latest` lineage as Claude Code) and bakes users at
 *     UIDs 0–101, 997–998, 1000, and 65534. UID 1500 has no collision in
 *     either image. If a future base-image update adds a user at 1500,
 *     swap to another conflict-free UID and update `REMAP_UID` — all
 *     assertions reference the constant.
 *
 *   - UID 33 (`www-data`) is the collision case. Present in the base
 *     image; `groupmod -g 33 codespace` fails because gid 33 is already
 *     taken, so the entrypoint exits non-zero with the
 *     `[ironcurtain] groupmod failed:` (or `usermod failed:`) diagnostic
 *     added in commit 2f463f3. The hard-error contract guards against
 *     silent fall-through to a broken UID mapping.
 *
 *   - Cleanup. The entrypoint's `chown -R $UID:$GID /workspace`
 *     propagates through the bind mount, so the host-side workspace
 *     tempdir would be left owned by the synthetic UID. Before container
 *     teardown we re-chown `/workspace` back to the original host UID
 *     from inside the still-running container so `rmSync` can remove the
 *     tempdir without leaking files.
 *
 *   - CMD is `sleep 180`. We only care about the entrypoint's behaviour;
 *     keeping the container up long enough for `docker exec` to inspect
 *     post-remap state is sufficient.
 *
 * Linux-only (`!useTcpTransport()`): macOS uses Docker Desktop's VirtioFS
 * which translates UIDs transparently. `buildAgentUidRemap` returns an
 * empty mapping there, so the entrypoint never enters the remap branch.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { useTcpTransport } from '../src/docker/platform.js';
import { isDockerAvailable, isDockerImageAvailable } from './helpers/docker-available.js';

const execFile = promisify(execFileCb);

const IMAGE = 'ironcurtain-goose:latest';

/**
 * Synthetic UID/GID used to force the remap path. The Goose image inherits
 * `ironcurtain-base`, which is built on `mcr.microsoft.com/devcontainers/
 * universal:latest`; the base bakes users at UIDs 0–101, 997–998, 1000,
 * and 65534. 1500 has no collision. If a future image update adds a user
 * at 1500, swap to another conflict-free UID and update this constant.
 */
const REMAP_UID = 1500;

/** A UID known to collide with a baked image user (`www-data`). */
const COLLIDING_UID = 33;

/**
 * Polls until the entrypoint has finished running `usermod`/`groupmod`/`chown`
 * and has exec'd the CMD. The universal devcontainer image has a large
 * `/home/codespace` (Conda, NVM, Hugo, etc.) that `usermod -u` scans for
 * ownership references, so the remap can take ~25–30 seconds. Throws if
 * the entrypoint is still running after `timeoutMs` — that indicates a
 * hang, not normal slowness.
 */
async function waitForRemapComplete(containerId: string, expectedUid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Poll on `/workspace`'s owner UID rather than on the absence of
  // `usermod`/`groupmod` processes. The entrypoint runs `chown -R
  // "$UID:$GID" /home/codespace /workspace` after usermod/groupmod; a
  // process-presence poll could return while `chown -R` is still
  // walking the bind mount, and the `stat`-based assertions below
  // would flake. `/workspace` is processed last in the chown arg list
  // (after `/home/codespace`), so seeing its UID flip is a sufficient
  // signal that the full remap chain is done.
  while (Date.now() < deadline) {
    const result = await dockerExecAs(containerId, '0:0', 'stat', '-c', '%u', '/workspace');
    if (result.exitCode !== 0) {
      // Container gone or exec broken — bail so assertions produce a
      // meaningful error rather than silent looping.
      return;
    }
    if (result.stdout.trim() === String(expectedUid)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Entrypoint did not complete remap to UID ${expectedUid} within ${timeoutMs}ms`);
}

/** Runs `cmd` inside `containerId` as the given user. */
async function dockerExecAs(
  containerId: string,
  user: string,
  ...cmd: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFile('docker', ['exec', '--user', user, containerId, ...cmd], {
      timeout: 15_000,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
  }
}

/**
 * Same CA-discovery helper as the Claude Code remap test. The presence of
 * the developer's CA tells us the prebuilt image was built against it; if
 * not, we skip rather than force a multi-minute rebuild.
 */
function findHostCaDir(): string | null {
  const home = process.env.IRONCURTAIN_HOME ?? join(homedir(), '.ironcurtain');
  const ca = join(home, 'ca');
  return existsSync(ca) ? ca : null;
}

const hostCaDir = findHostCaDir();
const gooseDockerReady =
  !useTcpTransport() && isDockerAvailable() && isDockerImageAvailable(IMAGE) && hostCaDir !== null;

interface RemapObservations {
  idCodespaceUid?: string;
  idCodespaceGid?: string;
  passwdUid?: string;
  homeStatUid?: string;
  runuserUid?: string;
  runuserName?: string;
  workspaceStatUid?: string;
}

describe.skipIf(!gooseDockerReady)('Goose agent container UID/GID remap (issue #232)', () => {
  /**
   * Success path: a non-1000 UID forces the entrypoint to execute usermod /
   * groupmod / chown. Driven via a direct `docker run --user 0:0 -e
   * IRONCURTAIN_AGENT_UID=N` against the prebuilt Goose image — the
   * smallest exercise of the remap logic itself.
   */
  describe('forced remap to a non-baked UID', () => {
    let homeDir: string;
    let workspaceDir: string;
    let containerName: string;
    let originalUid: number;
    let originalGid: number;
    const observations: RemapObservations = {};

    beforeAll(async () => {
      // Capture the real UID/GID for the workspace chown-back during cleanup.
      originalUid = process.getuid?.() ?? 1000;
      originalGid = process.getgid?.() ?? 1000;

      homeDir = mkdtempSync(join(tmpdir(), 'ironcurtain-uidremap-goose-test-'));
      workspaceDir = join(homeDir, 'workspace');
      mkdirSync(workspaceDir, { recursive: true });
      containerName = `ironcurtain-uidremap-goose-success-${process.pid}-${Date.now()}`;

      // Run the entrypoint as root with the synthetic UID/GID. CMD is
      // `sleep 180` so the container stays up long enough for `docker
      // exec` to inspect the post-remap state.
      //
      // Mounting only `/workspace` (not `/run/ironcurtain` or the
      // orientation dir) is intentional: the entrypoint's remap touches
      // `/home/codespace` and `/workspace`. The other mounts are part of
      // the broader proxy/orientation plumbing and aren't relevant to
      // the remap contract.
      await execFile(
        'docker',
        [
          'run',
          '--rm',
          '-d',
          '--name',
          containerName,
          '--user',
          '0:0',
          '-e',
          `IRONCURTAIN_AGENT_UID=${REMAP_UID}`,
          '-e',
          `IRONCURTAIN_AGENT_GID=${REMAP_UID}`,
          '-v',
          `${workspaceDir}:/workspace`,
          IMAGE,
          // CMD must outlive the entrypoint remap (~25–30s on the
          // universal image) plus the test's `docker exec` calls.
          // 180s is comfortable.
          'sleep',
          '180',
        ],
        { timeout: 30_000 },
      );

      // Wait for the entrypoint to finish the full remap (including the
      // recursive chown of /workspace) before reading state. Polling on
      // /workspace ownership is strictly stronger than polling on the
      // usermod/groupmod processes: it observes the final post-condition
      // every subsequent assertion depends on.
      await waitForRemapComplete(containerName, REMAP_UID, 90_000);

      // `id codespace` reflects the renumbered passwd entry.
      const idOut = await dockerExecAs(containerName, '0:0', 'id', 'codespace');
      observations.idCodespaceUid = /uid=(\d+)\(codespace\)/.exec(idOut.stdout)?.[1];
      observations.idCodespaceGid = /gid=(\d+)\(codespace\)/.exec(idOut.stdout)?.[1];

      // /etc/passwd is the canonical source: if usermod silently failed,
      // `id codespace` could resolve via nsswitch but passwd would still
      // show 1000. We assert against passwd directly to catch that.
      const passwdOut = await dockerExecAs(containerName, '0:0', 'sh', '-c', 'getent passwd codespace | cut -d: -f3');
      observations.passwdUid = passwdOut.stdout.trim();

      // chown -R should have flipped /home/codespace to the new UID.
      const homeStat = await dockerExecAs(containerName, '0:0', 'stat', '-c', '%u', '/home/codespace');
      observations.homeStatUid = homeStat.stdout.trim();

      // chown -R should also have flipped /workspace (the bind mount).
      // This is the property issue #232 reports: without the remap, the
      // agent (UID 1000 in the container) cannot write to /workspace
      // owned by a non-1000 host UID.
      const wsStat = await dockerExecAs(containerName, '0:0', 'stat', '-c', '%u', '/workspace');
      observations.workspaceStatUid = wsStat.stdout.trim();

      // `--user codespace` resolves the name against the (renumbered)
      // passwd entry, so this is functionally equivalent to dropping
      // privileges via `runuser -u codespace` in the entrypoint.
      const runuserUid = await dockerExecAs(containerName, 'codespace', 'id', '-u');
      const runuserName = await dockerExecAs(containerName, 'codespace', 'whoami');
      observations.runuserUid = runuserUid.stdout.trim();
      observations.runuserName = runuserName.stdout.trim();
    }, 120_000);

    afterAll(async () => {
      if (containerName) {
        // Restore workspace ownership BEFORE the container is torn down.
        // The entrypoint's `chown -R ${REMAP_UID} /workspace` propagates
        // through the bind mount; without this restore, the host tempdir
        // would be left owned by UID 1500 and the `rmSync` below would
        // either EACCES or leak files. Best-effort: if `beforeAll` threw
        // before the chown landed, or the container is already gone,
        // there is nothing to restore.
        try {
          await dockerExecAs(containerName, '0:0', 'chown', '-R', `${originalUid}:${originalGid}`, '/workspace');
        } catch {
          /* container gone or chown failed */
        }
        try {
          await execFile('docker', ['rm', '-f', containerName], { timeout: 10_000 });
        } catch {
          /* container already gone */
        }
      }
      if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    });

    it(`renumbered codespace user to UID ${REMAP_UID} (usermod path)`, () => {
      expect(observations.idCodespaceUid).toBe(String(REMAP_UID));
      expect(observations.passwdUid).toBe(String(REMAP_UID));
    });

    it(`renumbered codespace group to GID ${REMAP_UID} (groupmod path)`, () => {
      expect(observations.idCodespaceGid).toBe(String(REMAP_UID));
    });

    it(`chown -R reset /home/codespace ownership to ${REMAP_UID}`, () => {
      expect(observations.homeStatUid).toBe(String(REMAP_UID));
    });

    it(`chown -R reset /workspace ownership to ${REMAP_UID}`, () => {
      // The property issue #232 is about: the workspace bind mount must
      // end up owned by the renumbered codespace user so the agent can
      // read/write it after `runuser -u codespace`.
      expect(observations.workspaceStatUid).toBe(String(REMAP_UID));
    });

    it('dropping privileges via runuser/--user codespace lands on the remapped UID', () => {
      expect(observations.runuserUid).toBe(String(REMAP_UID));
      expect(observations.runuserName).toBe('codespace');
    });
  });

  /**
   * Failure-diagnostic path: a UID collision (33 == `www-data` in the base
   * image) makes `groupmod`/`usermod` fail. The entrypoint must exit
   * non-zero and emit the `[ironcurtain] {usermod,groupmod} failed:`
   * diagnostic so operators see what went wrong instead of silently
   * running with a broken UID mapping.
   */
  describe('UID collision is reported as a hard error', () => {
    let containerName: string;

    beforeAll(() => {
      containerName = `ironcurtain-uidremap-goose-fail-${process.pid}-${Date.now()}`;
    });

    afterAll(async () => {
      // Best-effort: `docker run --rm` should have already removed it,
      // but belt-and-braces in case the run was interrupted.
      try {
        await execFile('docker', ['rm', '-f', containerName], { timeout: 10_000 });
      } catch {
        /* container already gone */
      }
    });

    it(`entrypoint exits non-zero and logs a diagnostic when UID ${COLLIDING_UID} collides with a baked user`, async () => {
      // Run the entrypoint as root (`--user 0:0`) with a colliding
      // IRONCURTAIN_AGENT_UID. `groupmod` runs first; gid 33 also
      // belongs to `www-data`, so the diagnostic will be `groupmod
      // failed:` (the entrypoint fails on the first collision). Either
      // error proves the hard-error contract: silent fall-through is
      // the regression we're guarding against.
      let result: { stdout: string; stderr: string; exitCode: number };
      try {
        const ok = await execFile(
          'docker',
          [
            'run',
            '--rm',
            '--name',
            containerName,
            '--user',
            '0:0',
            '-e',
            `IRONCURTAIN_AGENT_UID=${COLLIDING_UID}`,
            '-e',
            `IRONCURTAIN_AGENT_GID=${COLLIDING_UID}`,
            IMAGE,
            'true',
          ],
          { timeout: 30_000 },
        );
        result = { stdout: ok.stdout, stderr: ok.stderr, exitCode: 0 };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        result = { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
      }

      // Container must exit non-zero. The entrypoint script uses `exit 1`
      // explicitly on each failure branch.
      expect(result.exitCode).not.toBe(0);
      // Stderr must contain one of the diagnostic lines — we accept
      // either `usermod failed:` or `groupmod failed:` because groupmod
      // runs first and gid 33 also collides with www-data.
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toMatch(/\[ironcurtain\] (usermod|groupmod) failed:/);
    }, 60_000);
  });
});
