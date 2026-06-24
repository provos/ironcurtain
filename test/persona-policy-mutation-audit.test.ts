/**
 * Unit tests for the tamper-evident persona policy-mutation audit log (Phase 1c).
 *
 * Exercises: append + monotonic seq + prevHash chaining, on-disk JSONL +
 * 0600 mode, and HMAC-chain tamper detection (content edit, reorder, deletion).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  PolicyMutationAuditLog,
  verifyAuditChain,
  type PolicyMutationRecord,
} from '../src/persona/policy-mutation-audit.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-audit-test-${process.pid}`);

function logPath(): string {
  return resolve(TEST_HOME, 'audit', 'policy-mutation.jsonl');
}

function readRecords(): PolicyMutationRecord[] {
  const raw = readFileSync(logPath(), 'utf-8').trim();
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PolicyMutationRecord);
}

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
});

afterEach(() => {
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('PolicyMutationAuditLog', () => {
  it('appends JSONL records with monotonic seq and chained prevHash', () => {
    const secret = randomBytes(32);
    const log = new PolicyMutationAuditLog(secret);

    log.append('cli', 'createPersona', 'p', { constitutionHash: 'aaa' });
    log.append('1.2.3.4#7', 'setPersonaMemory', 'p', { enabled: false });
    log.append('cli', 'deletePersona', 'p', { hardDelete: true });

    const records = readRecords();
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(records[0].prevHash).toBe('');
    expect(records[1].prevHash).toBe(records[0].hash);
    expect(records[2].prevHash).toBe(records[1].hash);
    expect(records[0].method).toBe('createPersona');
    expect(records[1].actor).toBe('1.2.3.4#7');
  });

  it('writes the log file with 0600 mode', () => {
    const log = new PolicyMutationAuditLog(randomBytes(32));
    log.append('cli', 'createPersona', 'p');
    expect(existsSync(logPath())).toBe(true);
    const mode = statSync(logPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('verifyAuditChain accepts an untampered chain', () => {
    const secret = randomBytes(32);
    const log = new PolicyMutationAuditLog(secret);
    log.append('cli', 'createPersona', 'a');
    log.append('cli', 'createPersona', 'b');
    log.append('cli', 'createPersona', 'c');
    expect(verifyAuditChain(readRecords(), secret)).toEqual({ ok: true });
  });

  it('rejects a chain verified under the wrong secret', () => {
    const log = new PolicyMutationAuditLog(randomBytes(32));
    log.append('cli', 'createPersona', 'a');
    const result = verifyAuditChain(readRecords(), randomBytes(32));
    expect(result.ok).toBe(false);
  });

  it('detects a post-hoc content edit (HMAC mismatch)', () => {
    const secret = randomBytes(32);
    const log = new PolicyMutationAuditLog(secret);
    log.append('cli', 'createPersona', 'a');
    log.append('cli', 'createPersona', 'b');

    const records = readRecords();
    // Tamper: change the actor on the first record without re-signing.
    const tampered = [{ ...records[0], actor: 'attacker' }, records[1]];
    const result = verifyAuditChain(tampered, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(0);
      expect(result.reason).toMatch(/HMAC mismatch/);
    }
  });

  it('detects a deleted record (seq gap / prevHash break)', () => {
    const secret = randomBytes(32);
    const log = new PolicyMutationAuditLog(secret);
    log.append('cli', 'createPersona', 'a');
    log.append('cli', 'createPersona', 'b');
    log.append('cli', 'createPersona', 'c');

    const records = readRecords();
    // Remove the middle record.
    const tampered = [records[0], records[2]];
    const result = verifyAuditChain(tampered, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAt).toBe(1);
  });

  it('detects a reordered chain', () => {
    const secret = randomBytes(32);
    const log = new PolicyMutationAuditLog(secret);
    log.append('cli', 'createPersona', 'a');
    log.append('cli', 'createPersona', 'b');

    const records = readRecords();
    const result = verifyAuditChain([records[1], records[0]], secret);
    expect(result.ok).toBe(false);
  });
});
