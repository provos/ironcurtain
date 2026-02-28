import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readActiveRegistrations } from '../src/escalation/session-registry.js';
import type { PtySessionRegistration } from '../src/docker/pty-types.js';

describe('readActiveRegistrations', () => {
  let tempDir: string;
  let registryDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-registry-test-'));
    registryDir = join(tempDir, 'pty-registry');
    mkdirSync(registryDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function writeRegistration(sessionId: string, overrides: Partial<PtySessionRegistration> = {}): void {
    const registration: PtySessionRegistration = {
      sessionId,
      escalationDir: `/tmp/sessions/${sessionId}/escalations`,
      label: `Agent - task ${sessionId}`,
      startedAt: new Date().toISOString(),
      pid: process.pid, // Current process is alive
      ...overrides,
    };
    writeFileSync(join(registryDir, `session-${sessionId}.json`), JSON.stringify(registration, null, 2));
  }

  it('reads valid registration files', () => {
    writeRegistration('sess-1');
    writeRegistration('sess-2');

    const registrations = readActiveRegistrations(registryDir);

    expect(registrations).toHaveLength(2);
    const ids = registrations.map((r) => r.sessionId);
    expect(ids).toContain('sess-1');
    expect(ids).toContain('sess-2');
  });

  it('returns the full registration data', () => {
    writeRegistration('sess-1', {
      label: 'Claude Code - Fix the bug',
      escalationDir: '/home/user/.ironcurtain/sessions/sess-1/escalations',
    });

    const registrations = readActiveRegistrations(registryDir);

    expect(registrations).toHaveLength(1);
    expect(registrations[0].label).toBe('Claude Code - Fix the bug');
    expect(registrations[0].escalationDir).toBe('/home/user/.ironcurtain/sessions/sess-1/escalations');
    expect(registrations[0].pid).toBe(process.pid);
  });

  it('returns empty array for non-existent directory', () => {
    const result = readActiveRegistrations('/tmp/nonexistent-registry-dir');
    expect(result).toEqual([]);
  });

  it('returns empty array for empty directory', () => {
    const result = readActiveRegistrations(registryDir);
    expect(result).toEqual([]);
  });

  it('ignores non-registration files', () => {
    writeRegistration('sess-1');
    writeFileSync(join(registryDir, 'not-a-session.json'), '{}');
    writeFileSync(join(registryDir, 'session-.txt'), 'not json');

    const registrations = readActiveRegistrations(registryDir);

    expect(registrations).toHaveLength(1);
    expect(registrations[0].sessionId).toBe('sess-1');
  });

  it('skips malformed JSON files', () => {
    writeRegistration('sess-1');
    writeFileSync(join(registryDir, 'session-bad.json'), 'not valid json');

    const registrations = readActiveRegistrations(registryDir);

    expect(registrations).toHaveLength(1);
    expect(registrations[0].sessionId).toBe('sess-1');
  });

  it('skips files missing required fields', () => {
    writeRegistration('sess-1');
    // Missing required fields
    writeFileSync(join(registryDir, 'session-incomplete.json'), JSON.stringify({ sessionId: 'incomplete' }));

    const registrations = readActiveRegistrations(registryDir);

    expect(registrations).toHaveLength(1);
    expect(registrations[0].sessionId).toBe('sess-1');
  });

  it('removes stale registrations (dead PID)', () => {
    // Use a PID that is almost certainly not alive
    writeRegistration('stale-session', { pid: 999999999 });
    writeRegistration('alive-session');

    const registrations = readActiveRegistrations(registryDir);

    // Only the alive session should be returned
    expect(registrations).toHaveLength(1);
    expect(registrations[0].sessionId).toBe('alive-session');

    // The stale registration file should have been removed
    expect(existsSync(join(registryDir, 'session-stale-session.json'))).toBe(false);
    expect(existsSync(join(registryDir, 'session-alive-session.json'))).toBe(true);
  });

  it('handles files with wrong type for required fields', () => {
    writeRegistration('sess-1');
    // pid is a string instead of number
    writeFileSync(
      join(registryDir, 'session-wrongtype.json'),
      JSON.stringify({
        sessionId: 'wrongtype',
        escalationDir: '/tmp/esc',
        label: 'test',
        startedAt: '2026-01-01',
        pid: 'not-a-number',
      }),
    );

    const registrations = readActiveRegistrations(registryDir);

    expect(registrations).toHaveLength(1);
    expect(registrations[0].sessionId).toBe('sess-1');
  });
});
