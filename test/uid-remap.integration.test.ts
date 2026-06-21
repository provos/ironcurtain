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
 * A GID known to already exist in the base image as the `users` group:
 * GID 100 is `users` on both the x86 universal devcontainer image and the
 * Debian `node:22-trixie` arm64 base. This is the exact issue #291
 * scenario: on nixos/WSL and many Linux desktops the invoking user's
 * primary group is GID 100, so the host passes IRONCURTAIN_AGENT_GID=100.
 * A GID collision is benign — the entrypoint must reuse the existing group
 * (via `usermod -g`) rather than aborting with the old unconditional
 * `groupmod -g` which failed with "GID already exists". The reuse-branch
 * assertion below verifies the group name is the pre-existing one, so this
 * test fails loudly rather than silently routing through groupmod if a
 * future base image ever stops shipping `users:x:100`.
 */
const EXISTING_GID = 100;

/**
 * Polls until the entrypoint has finished running `usermod`/`groupmod`/`chown`
 * and has exec'd the CMD. The universal devcontainer image has a large
 * `/home/codespace` (Conda, NVM, Hugo, etc.) that `usermod -u` scans for
 * ownership references, so the remap can take ~25–30 seconds; a fixed
 * `setTimeout` would be either flaky or wasteful. Throws if the entrypoint
 * is still running after `timeoutMs` — that indicates a hang, not normal
 * slowness, and the test should fail loud rather than wait indefinitely.
 */
async function waitForRemapComplete(containerId: string, expectedUid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // We poll on `/workspace`'s owner UID rather than on the absence of
  // `usermod`/`groupmod` processes for two reasons. First, the entrypoint
  // also runs `chown -R "$UID:$GID" /home/codespace /workspace` after the
  // usermod/groupmod step; a process-presence poll could return as soon
  // as those two finish, while `chown -R` is still walking the bind
  // mount — and the assertions below `stat`-check ownership, so they'd
  // flake. Second, `/workspace` is processed last in the chown arg list
  // (after `/home/codespace`), so seeing its UID flip is a sufficient
  // signal that the full remap chain is done.
  while (Date.now() < deadline) {
    const result = await dockerExecAs(containerId, '0:0', 'stat', '-c', '%u', '/workspace');
    if (result.exitCode !== 0) {
      // Don't silently return: a non-zero exit here means the container
      // is gone, exec is broken, or /workspace doesn't exist yet. Bailing
      // with `return` would let the downstream assertions fail with
      // confusing "expected undefined toBe ..." messages that hide the
      // real cause. Throw with the captured stdio so the failure points
      // straight at the underlying problem.
      throw new Error(
        `docker exec failed while polling /workspace ownership ` +
          `(exit=${result.exitCode}); stdout=${JSON.stringify(result.stdout)} ` +
          `stderr=${JSON.stringify(result.stderr)}`,
      );
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
  idCodespaceGidName?: string;
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
      // and `usermod` scans it. We poll on `/workspace` ownership rather
      // than process names so `chown -R` completion is captured too.
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
    }, 120_000);

    afterAll(async () => {
      // Restore workspace ownership BEFORE removing the container. The
      // entrypoint's `chown -R ${REMAP_UID} /workspace` propagates
      // through the bind mount; without this restore, the host tempdir
      // is left owned by REMAP_UID and the rmSync below fails with
      // EACCES. Lives in afterAll (not at the end of beforeAll) so a
      // beforeAll failure after the entrypoint's chown -R still gets
      // the bind mount restored. Best-effort: if the container already
      // exited (e.g., the failure-diagnostic test case --rm'd it, or
      // beforeAll failed before the remap ran), the exec fails
      // harmlessly and we continue with teardown.
      if (containerName) {
        try {
          await dockerExecAs(containerName, '0:0', 'chown', '-R', `${originalUid}:${originalGid}`, '/workspace');
        } catch {
          /* container gone or chown failed — proceed with teardown */
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
   * Issue #291 success path: a GID collision is BENIGN and must NOT abort
   * startup. We force a remap to a free UID (1500) but to GID 100
   * (`users`), which the base image already bakes in. The old entrypoint
   * ran `groupmod -g 100 codespace` unconditionally and died with
   * "GID '100' already exists"; the fix detects the existing group and
   * reuses it as codespace's primary group via `usermod -g 100`. The
   * entrypoint must then chown /home/codespace and /workspace to
   * REMAP_UID:100 and `runuser -u codespace` must land on REMAP_UID with
   * primary group 100. Driven via a direct `docker run`, mirroring the
   * non-baked-UID success path above.
   */
  describe('forced remap with a colliding GID (issue #291)', () => {
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

      homeDir = mkdtempSync(join(tmpdir(), 'ironcurtain-uidremap-gid-test-'));
      workspaceDir = join(homeDir, 'workspace');
      mkdirSync(workspaceDir, { recursive: true });
      containerName = `ironcurtain-uidremap-gid-${process.pid}-${Date.now()}`;

      // Run the entrypoint as root with a free UID but a GID (100) that
      // already exists in the image. CMD is `sleep 180` so the container
      // stays up long enough for `docker exec` to inspect post-remap state.
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
          `IRONCURTAIN_AGENT_GID=${EXISTING_GID}`,
          '-v',
          `${workspaceDir}:/workspace`,
          IMAGE,
          'sleep',
          '180',
        ],
        { timeout: 30_000 },
      );

      // Wait for the entrypoint to finish the full remap (including the
      // recursive chown of /workspace) before reading state. Polling on
      // /workspace ownership observes the final post-condition the
      // assertions depend on.
      await waitForRemapComplete(containerName, REMAP_UID, 90_000);

      // `id codespace` reflects the renumbered passwd entry. Capture both
      // the numeric primary GID and the group NAME: after `usermod -g 100`
      // the name is the pre-existing group (`users`), whereas the old
      // `groupmod -g` path would have left it as `codespace`. Asserting the
      // name proves the reuse branch actually ran (see assertion below).
      const idOut = await dockerExecAs(containerName, '0:0', 'id', 'codespace');
      observations.idCodespaceUid = /uid=(\d+)\(codespace\)/.exec(idOut.stdout)?.[1];
      const gidMatch = /gid=(\d+)\((\w+)\)/.exec(idOut.stdout);
      observations.idCodespaceGid = gidMatch?.[1];
      observations.idCodespaceGidName = gidMatch?.[2];

      // /etc/passwd is the canonical source for the renumbered UID.
      const passwdOut = await dockerExecAs(containerName, '0:0', 'sh', '-c', 'getent passwd codespace | cut -d: -f3');
      observations.passwdUid = passwdOut.stdout.trim();

      // chown -R should have flipped /home/codespace to REMAP_UID.
      const homeStat = await dockerExecAs(containerName, '0:0', 'stat', '-c', '%u', '/home/codespace');
      observations.homeStatUid = homeStat.stdout.trim();

      // chown -R should also have flipped /workspace (the bind mount).
      const wsStat = await dockerExecAs(containerName, '0:0', 'stat', '-c', '%u', '/workspace');
      observations.workspaceStatUid = wsStat.stdout.trim();

      // `--user codespace` resolves the name against the renumbered passwd
      // entry, functionally equivalent to `runuser -u codespace`.
      const runuserUid = await dockerExecAs(containerName, 'codespace', 'id', '-u');
      const runuserName = await dockerExecAs(containerName, 'codespace', 'whoami');
      observations.runuserUid = runuserUid.stdout.trim();
      observations.runuserName = runuserName.stdout.trim();
    }, 120_000);

    afterAll(async () => {
      // Restore workspace ownership BEFORE removing the container; the
      // entrypoint's `chown -R ${REMAP_UID}:${EXISTING_GID} /workspace`
      // propagates through the bind mount, so without this restore the
      // host tempdir is left owned by REMAP_UID and rmSync fails EACCES.
      if (containerName) {
        try {
          await dockerExecAs(containerName, '0:0', 'chown', '-R', `${originalUid}:${originalGid}`, '/workspace');
        } catch {
          /* container gone or chown failed — proceed with teardown */
        }
        try {
          await execFile('docker', ['rm', '-f', containerName], { timeout: 10_000 });
        } catch {
          /* container already gone */
        }
      }
      if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    });

    it(`renumbered codespace user to UID ${REMAP_UID} despite the GID collision`, () => {
      expect(observations.idCodespaceUid).toBe(String(REMAP_UID));
      expect(observations.passwdUid).toBe(String(REMAP_UID));
    });

    it(`reused existing group: codespace primary GID is ${EXISTING_GID} (usermod -g path, not groupmod)`, () => {
      expect(observations.idCodespaceGid).toBe(String(EXISTING_GID));
      // The group NAME proves which branch ran. The `usermod -g` reuse path
      // points codespace at the pre-existing group (`users`); the free-GID
      // `groupmod -g` path would instead show `codespace`. Asserting it is
      // NOT `codespace` keeps this test honest if a future base image ever
      // drops `users:x:100` (which would silently route through groupmod and
      // otherwise still pass green, losing the regression's teeth).
      expect(observations.idCodespaceGidName).toBeDefined();
      expect(observations.idCodespaceGidName).not.toBe('codespace');
    });

    it(`chown -R reset /home/codespace ownership to ${REMAP_UID}`, () => {
      expect(observations.homeStatUid).toBe(String(REMAP_UID));
    });

    it(`chown -R reset /workspace ownership to ${REMAP_UID}`, () => {
      expect(observations.workspaceStatUid).toBe(String(REMAP_UID));
    });

    it('dropping privileges via runuser/--user codespace lands on the remapped UID', () => {
      expect(observations.runuserUid).toBe(String(REMAP_UID));
      expect(observations.runuserName).toBe('codespace');
    });
  });

  /**
   * Failure-diagnostic path: a UID collision (33 == `www-data` in the base
   * image) makes `usermod -u` fail. The entrypoint must exit non-zero and
   * emit the `[ironcurtain] usermod failed:` diagnostic so operators see
   * what went wrong instead of silently running with a broken UID mapping.
   * (GID 33 also belongs to www-data, but a GID collision is now benign —
   * the entrypoint reuses the group via `usermod -g` and proceeds to the
   * UID remap, which is where the hard failure surfaces.)
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
      // IRONCURTAIN_AGENT_UID. GID 33 (www-data) already exists, so the
      // entrypoint treats the GID as a benign collision and reuses the
      // group via `usermod -g 33`; the hard failure then surfaces on
      // `usermod -u 33 codespace`, which collides with the baked www-data
      // user. Either diagnostic proves the hard-error contract: silent
      // fall-through to a broken UID mapping is the regression we guard
      // against.
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
      // Stderr must contain one of the diagnostic lines added in 2f463f3.
      // With the issue #291 fix the UID collision surfaces as
      // `usermod failed:`; we keep the regex permissive (also matching
      // `groupmod failed:`) so the contract assertion is robust to future
      // ordering changes — silent fall-through is what we guard against.
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toMatch(/\[ironcurtain\] (usermod|groupmod) failed:/);
    }, 60_000);
  });
});
