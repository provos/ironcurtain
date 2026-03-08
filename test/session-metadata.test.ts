/**
 * Unit tests for session metadata persistence (save/load).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { saveSessionMetadata, loadSessionMetadata } from '../src/session/session-metadata.js';
import { getSessionMetadataPath } from '../src/config/paths.js';
import type { SessionMetadata } from '../src/session/types.js';

const TEST_HOME = `/tmp/ironcurtain-metadata-test-${process.pid}`;
const TEST_SESSION_ID = 'test-session-001';

beforeEach(() => {
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  // Create the session directory so save has somewhere to write
  const sessionDir = resolve(TEST_HOME, 'sessions', TEST_SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });
});

afterEach(() => {
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('saveSessionMetadata', () => {
  it('writes metadata to session-metadata.json', () => {
    const metadata: SessionMetadata = {
      createdAt: '2026-03-08T12:00:00.000Z',
      persona: 'exec-assistant',
    };

    saveSessionMetadata(TEST_SESSION_ID, metadata);

    const path = getSessionMetadataPath(TEST_SESSION_ID);
    expect(existsSync(path)).toBe(true);

    const written = JSON.parse(readFileSync(path, 'utf-8'));
    expect(written.createdAt).toBe('2026-03-08T12:00:00.000Z');
    expect(written.persona).toBe('exec-assistant');
  });

  it('is idempotent — does not overwrite existing file', () => {
    const first: SessionMetadata = {
      createdAt: '2026-03-08T12:00:00.000Z',
      persona: 'first',
    };
    const second: SessionMetadata = {
      createdAt: '2026-03-08T13:00:00.000Z',
      persona: 'second',
    };

    saveSessionMetadata(TEST_SESSION_ID, first);
    saveSessionMetadata(TEST_SESSION_ID, second);

    const written = JSON.parse(readFileSync(getSessionMetadataPath(TEST_SESSION_ID), 'utf-8'));
    expect(written.persona).toBe('first');
  });

  it('omits optional fields when undefined', () => {
    const metadata: SessionMetadata = {
      createdAt: '2026-03-08T12:00:00.000Z',
    };

    saveSessionMetadata(TEST_SESSION_ID, metadata);

    const written = JSON.parse(readFileSync(getSessionMetadataPath(TEST_SESSION_ID), 'utf-8'));
    expect(written).toEqual({ createdAt: '2026-03-08T12:00:00.000Z' });
    expect('persona' in written).toBe(false);
    expect('workspacePath' in written).toBe(false);
    expect('policyDir' in written).toBe(false);
  });
});

describe('loadSessionMetadata', () => {
  it('round-trips: save then load returns same data', () => {
    const metadata: SessionMetadata = {
      createdAt: '2026-03-08T12:00:00.000Z',
      persona: 'coder',
      workspacePath: '/home/user/project',
      disableAutoApprove: true,
    };

    saveSessionMetadata(TEST_SESSION_ID, metadata);
    const loaded = loadSessionMetadata(TEST_SESSION_ID);

    expect(loaded).toEqual(metadata);
  });

  it('returns undefined for nonexistent session', () => {
    const result = loadSessionMetadata('nonexistent-session-xyz');
    expect(result).toBeUndefined();
  });

  it('returns undefined for corrupt JSON', () => {
    const path = getSessionMetadataPath(TEST_SESSION_ID);
    writeFileSync(path, '{ invalid json !!!', 'utf-8');

    const result = loadSessionMetadata(TEST_SESSION_ID);
    expect(result).toBeUndefined();
  });

  it('handles metadata with only createdAt', () => {
    const metadata: SessionMetadata = {
      createdAt: '2026-03-08T12:00:00.000Z',
    };

    saveSessionMetadata(TEST_SESSION_ID, metadata);
    const loaded = loadSessionMetadata(TEST_SESSION_ID);

    expect(loaded).toEqual({ createdAt: '2026-03-08T12:00:00.000Z' });
    expect(loaded?.persona).toBeUndefined();
    expect(loaded?.workspacePath).toBeUndefined();
    expect(loaded?.policyDir).toBeUndefined();
  });

  it('handles metadata with policyDir (no persona)', () => {
    const metadata: SessionMetadata = {
      createdAt: '2026-03-08T12:00:00.000Z',
      policyDir: '/home/user/.ironcurtain/jobs/daily/generated',
    };

    saveSessionMetadata(TEST_SESSION_ID, metadata);
    const loaded = loadSessionMetadata(TEST_SESSION_ID);

    expect(loaded?.policyDir).toBe('/home/user/.ironcurtain/jobs/daily/generated');
    expect(loaded?.persona).toBeUndefined();
  });
});
