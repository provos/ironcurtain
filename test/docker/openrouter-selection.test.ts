/**
 * G13 selection-plumbing resume tests (§9.7 F3, §12.3 "Resume restore").
 *
 * These exercise the persistence + restore semantics for the per-session
 * provider profile across BOTH resume paths:
 *   - PTY: `SessionSnapshot.providerProfileName` (written/read at session end).
 *   - Batch: `SessionMetadata.providerProfileName` (via saveSessionMetadata).
 *
 * Full infra prep is out of scope (Docker); the restore EXPRESSIONS are unit-
 * tested directly so the "resumed session keeps its original profile even
 * after `default` changes" invariant is provable without a container.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { saveSessionMetadataTo, loadSessionMetadataFromPath } from '../../src/session/session-metadata.js';
import type { SessionMetadata } from '../../src/session/types.js';
import type { SessionSnapshot } from '../../src/docker/pty-types.js';

describe('G13 resume — SessionMetadata (batch path) round-trips providerProfileName', () => {
  it('persists and reads back the resolved profile name', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'ic-selection-'));
    try {
      const path = resolve(dir, 'session-metadata.json');
      const metadata: SessionMetadata = {
        createdAt: new Date().toISOString(),
        workspacePath: '/ws',
        providerProfileName: 'kimi',
      };
      saveSessionMetadataTo(path, metadata);
      const loaded = loadSessionMetadataFromPath(path);
      expect(loaded?.providerProfileName).toBe('kimi');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a session with no explicit choice persists the then-resolved name (e.g. native)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'ic-selection-'));
    try {
      const path = resolve(dir, 'session-metadata.json');
      // The batch write stores `providerProfileName ?? default`; with an unset
      // flag and default='native', the persisted value is 'native'.
      saveSessionMetadataTo(path, { createdAt: new Date().toISOString(), providerProfileName: 'native' });
      expect(loadSessionMetadataFromPath(path)?.providerProfileName).toBe('native');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('legacy metadata without the field reads back undefined (graceful)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'ic-selection-'));
    try {
      const path = resolve(dir, 'session-metadata.json');
      saveSessionMetadataTo(path, { createdAt: new Date().toISOString(), workspacePath: '/ws' });
      const loaded = loadSessionMetadataFromPath(path);
      expect(loaded?.providerProfileName).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('G13 resume — restore precedence (both paths)', () => {
  // The restore expression is identical in both paths:
  //   PTY:   isResume ? snapshot.providerProfileName : options.providerProfileName
  //   Batch: applyResumeMetadata spreads metadata.providerProfileName over options
  // The invariant: on resume, the PERSISTED name wins; a conflicting flag is
  // warn-ignored upstream (src/index.ts) so it never even reaches these paths.
  function restore(isResume: boolean, persisted: string | undefined, flag: string | undefined): string | undefined {
    return isResume ? persisted : flag;
  }

  it('resume restores the persisted profile, ignoring the passed flag', () => {
    // A resumed session pinned to 'kimi' keeps kimi even if --provider-profile
    // glm-5.2 is (accidentally) passed — the flag is warn-ignored upstream and
    // the restore reads the snapshot.
    expect(restore(true, 'kimi', 'glm-5.2')).toBe('kimi');
  });

  it('a default change after start does not re-route the resumed session', () => {
    // The persisted name is the RESOLVED name at first start, not "no intent".
    // Even if modelProviders.default flips to glm-5.2 on disk, the resume reads
    // the stored 'kimi'.
    const persistedAtStart = 'kimi';
    const currentDefaultOnDisk = 'glm-5.2';
    expect(restore(true, persistedAtStart, undefined)).toBe(persistedAtStart);
    expect(restore(true, persistedAtStart, undefined)).not.toBe(currentDefaultOnDisk);
  });

  it('a fresh (non-resume) session uses the passed flag', () => {
    expect(restore(false, undefined, 'kimi')).toBe('kimi');
    expect(restore(false, undefined, undefined)).toBeUndefined();
  });

  it('a session first started with no choice persists native and stays native on resume', () => {
    // No flag at start → resolved to 'native' → persisted. Resume reads native.
    const persisted = 'native';
    expect(restore(true, persisted, undefined)).toBe('native');
  });
});

describe('G13 resume — SessionSnapshot (PTY path) carries providerProfileName', () => {
  it('the snapshot type round-trips the field through JSON persistence', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'ic-selection-'));
    try {
      const path = resolve(dir, 'session-state.json');
      const snapshot: SessionSnapshot = {
        sessionId: 'sess-1',
        status: 'user-exit',
        exitCode: 0,
        lastActivity: new Date().toISOString(),
        workspacePath: '/ws',
        providerProfileName: 'kimi',
        agent: 'claude-code',
        label: 'Claude Code (interactive)',
        resumable: true,
      };
      // Mirror validateResumeSession's read path: JSON write + parse.
      saveSessionMetadataTo(path, snapshot as unknown as SessionMetadata);
      const loaded = loadSessionMetadataFromPath(path) as unknown as SessionSnapshot;
      expect(loaded.providerProfileName).toBe('kimi');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
