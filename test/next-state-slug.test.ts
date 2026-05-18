/**
 * Unit tests for `nextStateSlug` — the helper that picks the next
 * available `{stateId}.{N}` dir name by scanning the states dir on disk.
 *
 * Used by the orchestrator so true logical re-visits AND resume legs
 * each get their own forensic dir under the bundle. The behavior is
 * filesystem-driven (no FSM context dependency), so the unit tests
 * just pre-populate a temp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nextStateSlug } from '../src/config/paths.js';

describe('nextStateSlug', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'next-state-slug-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns `.1` when the states dir does not exist', () => {
    expect(nextStateSlug(join(dir, 'does-not-exist'), 'fetch')).toBe('fetch.1');
  });

  it('returns `.1` when the states dir is empty', () => {
    expect(nextStateSlug(dir, 'fetch')).toBe('fetch.1');
  });

  it('returns `.2` when only `.1` exists', () => {
    mkdirSync(join(dir, 'fetch.1'));
    expect(nextStateSlug(dir, 'fetch')).toBe('fetch.2');
  });

  it('returns max+1 when several legs exist', () => {
    mkdirSync(join(dir, 'fetch.1'));
    mkdirSync(join(dir, 'fetch.2'));
    mkdirSync(join(dir, 'fetch.3'));
    expect(nextStateSlug(dir, 'fetch')).toBe('fetch.4');
  });

  it('fills gaps by picking strictly above the current max', () => {
    mkdirSync(join(dir, 'fetch.1'));
    mkdirSync(join(dir, 'fetch.3'));
    expect(nextStateSlug(dir, 'fetch')).toBe('fetch.4');
  });

  it('ignores entries for other state ids', () => {
    mkdirSync(join(dir, 'fetch.1'));
    mkdirSync(join(dir, 'other.5'));
    mkdirSync(join(dir, 'fetch_plan.9'));
    expect(nextStateSlug(dir, 'fetch')).toBe('fetch.2');
  });

  it('ignores non-numeric suffixes', () => {
    mkdirSync(join(dir, 'fetch.1'));
    mkdirSync(join(dir, 'fetch.abc'));
    mkdirSync(join(dir, 'fetch.2x'));
    expect(nextStateSlug(dir, 'fetch')).toBe('fetch.2');
  });

  it('ignores stray files (e.g., .DS_Store, editor swap files)', () => {
    writeFileSync(join(dir, 'fetch.1'), 'stray');
    writeFileSync(join(dir, 'fetch.99'), 'stray');
    mkdirSync(join(dir, 'fetch.2'));
    expect(nextStateSlug(dir, 'fetch')).toBe('fetch.3');
  });

  it('rejects path-unsafe state ids', () => {
    expect(() => nextStateSlug(dir, '../escape')).toThrow(/Invalid state ID/);
    expect(() => nextStateSlug(dir, 'foo/bar')).toThrow(/Invalid state ID/);
    expect(() => nextStateSlug(dir, '')).toThrow(/Invalid state ID/);
  });
});
