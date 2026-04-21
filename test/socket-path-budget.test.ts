/**
 * Regression test for `sockaddr_un.sun_path` budget on per-bundle UDS endpoints.
 *
 * The OS bind limit is ~104 bytes on macOS (`SUN_LEN`) and ~108 bytes on
 * Linux (`UNIX_PATH_MAX`). When the bundle's MCP/MITM/control socket paths
 * overflow that cap, `bind(2)` fails with `EINVAL` and the whole bundle
 * cannot start — which is how Linux caught the original bug.
 *
 * This test asserts every assembled socket path stays well inside the
 * smaller (macOS) cap using representative identifiers. If a future change
 * reintroduces a UUID into these paths or moves them back under the deep
 * bundle directory, CI fails here before the path escapes to production.
 */

import { describe, it, expect } from 'vitest';
import {
  getBundleControlSocketPath,
  getBundleHostOnlyDir,
  getBundleMitmControlSocketPath,
  getBundleMitmProxySocketPath,
  getBundleProxySocketPath,
  getBundleRuntimeRoot,
  getBundleSocketsDir,
} from '../src/config/paths.js';
import type { BundleId } from '../src/session/types.js';

// macOS `sockaddr_un.sun_path` is 104 bytes including the terminating NUL.
// Picking 104 as the ceiling matches what `bind(2)` actually enforces on
// Darwin; Linux is more generous (108) so anything under 104 fits both.
const SUN_PATH_MACOS_LIMIT = 104;

// A full-length UUID is the worst case the helpers will ever see — smaller
// `BundleId` inputs can only shrink the assembled path.
const FULL_UUID_BUNDLE_ID = 'eaa0f084-feed-48c2-ab40-bed3600fe55a' as BundleId;

describe('per-bundle socket path budget', () => {
  it('every host-side UDS path stays under macOS sun_path cap with full-length UUIDs', () => {
    const paths = [
      getBundleProxySocketPath(FULL_UUID_BUNDLE_ID),
      getBundleMitmProxySocketPath(FULL_UUID_BUNDLE_ID),
      getBundleMitmControlSocketPath(FULL_UUID_BUNDLE_ID),
      getBundleControlSocketPath(FULL_UUID_BUNDLE_ID),
    ];

    for (const p of paths) {
      expect(p.length, `path exceeds macOS sun_path cap: ${p}`).toBeLessThanOrEqual(SUN_PATH_MACOS_LIMIT);
    }
  });

  it('bind-mount source dir does not expose the MITM control socket to the container', () => {
    // `getBundleSocketsDir` is the dir bind-mounted into the container as
    // `/run/ironcurtain/`. The MITM control socket must live OUTSIDE that
    // directory (in the sibling `host/` dir) so the container cannot reach
    // the control API via the bind mount.
    const socketsDir = getBundleSocketsDir(FULL_UUID_BUNDLE_ID);
    const hostDir = getBundleHostOnlyDir(FULL_UUID_BUNDLE_ID);
    const mitmControl = getBundleMitmControlSocketPath(FULL_UUID_BUNDLE_ID);

    expect(mitmControl.startsWith(hostDir + '/')).toBe(true);
    expect(mitmControl.startsWith(socketsDir + '/')).toBe(false);
    // Defensive: both subdirs share the same per-bundle runtime root, so
    // a single `rm -rf <runtimeRoot>` on teardown reclaims both (plus
    // the coordinator's `ctrl.sock` sibling).
    const runtimeRoot = getBundleRuntimeRoot(FULL_UUID_BUNDLE_ID);
    expect(socketsDir.startsWith(runtimeRoot + '/')).toBe(true);
    expect(hostDir.startsWith(runtimeRoot + '/')).toBe(true);
  });

  it('coordinator control socket is a sibling of sockets/ under the runtime root', () => {
    // The coordinator's `ctrl.sock` lives directly under the per-bundle
    // runtime root — not inside `sockets/` — so `rmSync(runtimeRoot)`
    // on teardown reclaims all four UDS endpoints with one call.
    const runtimeRoot = getBundleRuntimeRoot(FULL_UUID_BUNDLE_ID);
    const controlSocket = getBundleControlSocketPath(FULL_UUID_BUNDLE_ID);
    const socketsDir = getBundleSocketsDir(FULL_UUID_BUNDLE_ID);
    expect(controlSocket).toBe(`${runtimeRoot}/ctrl.sock`);
    expect(controlSocket.startsWith(socketsDir + '/')).toBe(false);
  });

  it('different BundleIds produce disjoint per-bundle directories', () => {
    const bidA = 'eaa0f084-feed-48c2-ab40-bed3600fe55a' as BundleId;
    const bidB = 'ceb97454-649d-4247-9966-e5445ff45369' as BundleId;
    expect(getBundleSocketsDir(bidA)).not.toBe(getBundleSocketsDir(bidB));
    expect(getBundleRuntimeRoot(bidA)).not.toBe(getBundleRuntimeRoot(bidB));
  });

  it('BundleIds sharing an 8-char prefix still produce distinct runtime roots', () => {
    // The old layout keyed runtime directories on 8 hex chars (16^8 ≈ 4e9),
    // giving a birthday-bound collision rate around 1e-4/day at 1k bundles/day.
    // A collision was fatal: `rmSync(runtimeRoot)` on one bundle's teardown
    // would wipe the other bundle's live sockets. The new 12-char slug pushes
    // the collision space to 16^12 ≈ 2.8e14, making it astronomical. This
    // test pins the expansion with a hand-crafted prefix collision.
    const sharedPrefix8 = 'abcdef01';
    const bidA = `${sharedPrefix8}-aaaa-4aaa-8aaa-aaaaaaaaaaaa` as BundleId;
    const bidB = `${sharedPrefix8}-bbbb-4bbb-8bbb-bbbbbbbbbbbb` as BundleId;
    // Both inputs share their first 8 chars but diverge within the first 12,
    // so the 12-char slug distinguishes them.
    expect(bidA.substring(0, 8)).toBe(bidB.substring(0, 8));
    expect(getBundleRuntimeRoot(bidA)).not.toBe(getBundleRuntimeRoot(bidB));
    expect(getBundleControlSocketPath(bidA)).not.toBe(getBundleControlSocketPath(bidB));
  });
});
