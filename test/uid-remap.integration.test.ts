/**
 * Integration test: runtime UID/GID remap in the agent container entrypoint
 * (issue #232).
 *
 * The existing PTY/skills integration tests do NOT exercise the remap block:
 * they inherit `process.getuid()` from the host (typically 1000), which equals
 * the baked codespace UID, so the entrypoint guard
 *   if [ "$IRONCURTAIN_AGENT_UID" != "1000" ] || ... ; then
 * skips `usermod` / `groupmod` / `chown` entirely. Those tests prove `runuser`
 * drops correctly but not that the remap itself works.
 *
 * This file forces the remap by spawning the agent image with
 * `IRONCURTAIN_AGENT_UID` / `IRONCURTAIN_AGENT_GID` overridden to a synthetic
 * value not present in the universal devcontainer image (`/etc/passwd` of
 * `ironcurtain-claude-code:latest` was inspected to pick a conflict-free UID).
 * The test then asserts inside the live container that:
 *
 *   - the codespace account was renumbered to the synthetic UID,
 *   - `/home/codespace` is owned by the synthetic UID after `chown -R`,
 *   - `runuser -u codespace` (the same drop-privileges call the entrypoint
 *     makes before `exec "$@"`) lands on the synthetic UID, so the workspace
 *     bind mount is writable from the agent.
 *
 * The success path drives a direct `docker run` against the image rather than
 * `runPtySession`. Driving through `runPtySession` would require mocking
 * `process.getuid` to inject the synthetic UID, but `pty-session.ts` mounts a
 * host-side `socketsDir` (created with the *real* host UID) into the container
 * at `/run/ironcurtain`. After remap, the renumbered codespace user cannot
 * bind a PTY socket in that bind-mounted directory because its host-side
 * ownership doesn't match the mocked UID. In real deployments these match
 * (host UID == IRONCURTAIN_AGENT_UID by construction in `buildAgentUidRemap`)
 * and the bind mount works naturally; the mock is what creates the
 * divergence. A direct `docker run` keeps the test scope tight: we're
 * exercising the entrypoint's remap logic, not the PTY chain. The PTY chain
 * itself is already covered by `pty-entrypoint.integration.test.ts`.
 *
 * A separate test forces a UID collision (33 = `www-data`, present in the
 * base image) and asserts the entrypoint exits non-zero with the
 * `[ironcurtain] {usermod,groupmod} failed:` diagnostic added in commit
 * 2f463f3 — the regression guard for silent fall-through to a broken
 * UID mapping.
 *
 * Cleanup: the entrypoint's `chown -R $UID:$GID /workspace` propagates
 * through the bind mount, so after the run completes the host-side workspace
 * tempdir would be left owned by the synthetic UID. Before container
 * teardown the test re-chowns the workspace back to the original host UID
 * from inside the still-running container so `rmSync` can remove the tempdir
 * without leaking files.
 *
 * Linux-only (`!useTcpTransport()`): macOS uses Docker Desktop's VirtioFS,
 * which handles UID translation transparently. `buildAgentUidRemap` returns
 * an empty mapping there, so the entrypoint never enters the remap branch.
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

const IMAGE = 'ironcurtain-claude-code:latest';

/**
 * Synthetic UID/GID used to force the remap path. The universal devcontainer
 * image (`mcr.microsoft.com/devcontainers/universal:latest`) bakes users at
 * UIDs 0–101, 997–998, 1000, and 65534; 1500 has no collision. If a future
 * base-image update adds a user at 1500, swap to another conflict-free UID
 * (e.g. 1501, 1600) and update this constant — all assertions below reference
 * REMAP_UID so a single edit suffices.
 */
const REMAP_UID = 1500;

/** A UID known to collide with a baked image user (`www-data`). */
const COLLIDING_UID = 33;

/**
 * Polls until the entrypoint has finished running `usermod`/`groupmod`/`chown`
 * and has exec'd the CMD. The universal devcontainer image has a large
 * `/home/codespace` (Conda, NVM, Hugo, etc.) that `usermod -u` scans for
 * ownership references, so the remap can take ~25–30 seconds; a fixed
 * `setTimeout` would be either flaky or wasteful. Throws if the entrypoint
 * is still running after `timeoutMs` — that indicates a hang, not normal
 * slowness, and the test should fail loud rather than wait indefinitely.
 */
async function waitForEntrypointHandoff(containerId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Run pgrep inside a shell that always exits 0; we read counts from
    // stdout. `pgrep -c X` prints the count and exits non-zero when 0,
    // which would make `dockerExecAs` report failure; the explicit
    // `; true` here neutralises that.
    const result = await dockerExecAs(
      containerId,
      '0:0',
      'sh',
      '-c',
      'pgrep -c usermod || true; pgrep -c groupmod || true',
    );
    if (result.exitCode !== 0) {
      // The container is gone or exec is broken — bail so the assertions
      // below produce a meaningful error rather than us looping silently.
      return;
    }
    const counts = result.stdout.trim().split(/\s+/);
    if (counts.length >= 2 && counts.every((c) => c === '0')) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Entrypoint did not finish remap within ${timeoutMs}ms`);
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
 * Same CA-discovery helper as `pty-entrypoint.integration.test.ts`. The
 * presence of the developer's CA tells us the prebuilt image was built
 * against it; if not, we skip rather than force a multi-minute rebuild.
 */
function findHostCaDir(): string | null {
  const home = process.env.IRONCURTAIN_HOME ?? join(homedir(), '.ironcurtain');
  const ca = join(home, 'ca');
  return existsSync(ca) ? ca : null;
}

const hostCaDir = findHostCaDir();
const dockerReady = !useTcpTransport() && isDockerAvailable() && isDockerImageAvailable(IMAGE) && hostCaDir !== null;

interface RemapObservations {
  idCodespaceUid?: string;
  idCodespaceGid?: string;
  passwdUid?: string;
  homeStatUid?: string;
  runuserUid?: string;
  runuserName?: string;
  workspaceStatUid?: string;
}

describe.skipIf(!dockerReady)('Agent container UID/GID remap (issue #232)', () => {
  /**
   * Success path: a non-1000 UID forces the entrypoint to execute usermod /
   * groupmod / chown. Driven via a direct `docker run --user 0:0 -e
   * IRONCURTAIN_AGENT_UID=N` against the same image used by `runPtySession`,
   * which is the smallest exercise of the remap logic itself.
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

      homeDir = mkdtempSync(join(tmpdir(), 'ironcurtain-uidremap-test-'));
      workspaceDir = join(homeDir, 'workspace');
      mkdirSync(workspaceDir, { recursive: true });
      containerName = `ironcurtain-uidremap-success-${process.pid}-${Date.now()}`;

      // Run the entrypoint as root with the synthetic UID/GID. CMD is
      // `sleep 30` so the container stays up long enough for `docker exec`
      // to inspect the post-remap state.
      //
      // Mounting only `/workspace` (not `/run/ironcurtain` or the
      // orientation dir) is intentional: the entrypoint's remap touches
      // `/home/codespace` and `/workspace`. The other mounts are part of
      // the broader PTY plumbing and aren't relevant to the remap contract.
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
          // CMD must outlive the entrypoint remap (~25–30s on the universal
          // image) plus the test's `docker exec` calls. 180s is comfortable.
          'sleep',
          '180',
        ],
        { timeout: 30_000 },
      );

      // Wait for the entrypoint to finish the remap before reading state.
      // `usermod -u N codespace` on the universal devcontainer image takes
      // ~25s because the home directory is massive (Conda, NVM, Hugo, ...)
      // and `usermod` scans it. We poll on the entrypoint having exec'd
      // away — once `pgrep usermod` reports no match AND CMD `sleep` is
      // the running PID 1 child, the remap is complete.
      await waitForEntrypointHandoff(containerName, 90_000);

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

      // chown -R should also have flipped /workspace (the bind mount). This
      // is the property issue #232 reports: without the remap, the agent
      // (UID 1000 in the container) cannot write to /workspace owned by a
      // non-1000 host UID. The remap fixes that by aligning the container
      // codespace UID with the host UID.
      const wsStat = await dockerExecAs(containerName, '0:0', 'stat', '-c', '%u', '/workspace');
      observations.workspaceStatUid = wsStat.stdout.trim();

      // `--user codespace` resolves the name against the (renumbered) passwd
      // entry, so this is functionally equivalent to dropping privileges via
      // `runuser -u codespace` in the entrypoint.
      const runuserUid = await dockerExecAs(containerName, 'codespace', 'id', '-u');
      const runuserName = await dockerExecAs(containerName, 'codespace', 'whoami');
      observations.runuserUid = runuserUid.stdout.trim();
      observations.runuserName = runuserName.stdout.trim();

      // Restore workspace ownership BEFORE the container is torn down. The
      // entrypoint's `chown -R ${REMAP_UID} /workspace` propagates through
      // the bind mount; without this restore, the host tempdir would be
      // left owned by UID 1500 and the afterAll `rmSync` would either
      // EACCES or leak files.
      await dockerExecAs(containerName, '0:0', 'chown', '-R', `${originalUid}:${originalGid}`, '/workspace');
    }, 120_000);

    afterAll(async () => {
      try {
        await execFile('docker', ['rm', '-f', containerName], { timeout: 10_000 });
      } catch {
        /* container already gone */
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
      // This is the property issue #232 is about: the workspace bind mount
      // must end up owned by the renumbered codespace user so the agent
      // can read/write it after `runuser -u codespace`.
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
   * diagnostic added in commit 2f463f3 so operators see what went wrong
   * instead of silently running with a broken UID mapping.
   */
  describe('UID collision is reported as a hard error', () => {
    let containerName: string;

    beforeAll(() => {
      containerName = `ironcurtain-uidremap-fail-${process.pid}-${Date.now()}`;
    });

    afterAll(async () => {
      // Best-effort: `docker run --rm` should have already removed it, but
      // belt-and-braces in case the run was interrupted.
      try {
        await execFile('docker', ['rm', '-f', containerName], { timeout: 10_000 });
      } catch {
        /* container already gone */
      }
    });

    it(`entrypoint exits non-zero and logs a diagnostic when UID ${COLLIDING_UID} collides with a baked user`, async () => {
      // Run the entrypoint as root (`--user 0:0`) with a colliding
      // IRONCURTAIN_AGENT_UID. `groupmod` runs first; gid 33 also belongs to
      // `www-data`, so the diagnostic will be `groupmod failed:` (the
      // entrypoint fails on the first collision). Either error proves the
      // hard-error contract: silent fall-through is the regression we're
      // guarding against.
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
      // Stderr must contain one of the diagnostic lines added in 2f463f3 —
      // we accept either `usermod failed:` or `groupmod failed:` because
      // groupmod runs first and gid 33 also collides with www-data.
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toMatch(/\[ironcurtain\] (usermod|groupmod) failed:/);
    }, 60_000);
  });
});
