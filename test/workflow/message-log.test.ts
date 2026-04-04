import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageLog, type MessageLogEntry } from '../../src/workflow/message-log.js';

describe('MessageLog', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'msglog-test-'));
    logPath = resolve(tmpDir, 'messages.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEntry(overrides: Partial<MessageLogEntry> & { type: MessageLogEntry['type'] }): MessageLogEntry {
    const base = {
      ts: new Date().toISOString(),
      workflowId: 'test-wf-1',
      state: 'plan',
    };
    return { ...base, ...overrides } as MessageLogEntry;
  }

  it('round-trips a single entry through append and readAll', () => {
    const log = new MessageLog(logPath);
    const entry = makeEntry({
      type: 'agent_sent',
      role: 'planner',
      message: 'Do the thing',
    });

    log.append(entry);
    const entries = log.readAll();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(entry);
  });

  it('maintains order across multiple appended entries', () => {
    const log = new MessageLog(logPath);
    const entries: MessageLogEntry[] = [
      makeEntry({ type: 'agent_sent', role: 'planner', message: 'first' }),
      makeEntry({ type: 'agent_received', role: 'planner', message: 'resp', verdict: 'approved', confidence: 'high' }),
      makeEntry({ type: 'state_transition', from: 'plan', event: '-> gate' }),
    ];

    for (const e of entries) {
      log.append(e);
    }

    const read = log.readAll();
    expect(read).toHaveLength(3);
    expect(read[0].type).toBe('agent_sent');
    expect(read[1].type).toBe('agent_received');
    expect(read[2].type).toBe('state_transition');
  });

  it('returns empty array when log file does not exist', () => {
    const log = new MessageLog(resolve(tmpDir, 'nonexistent.jsonl'));
    expect(log.readAll()).toEqual([]);
  });

  it('produces valid JSONL where each line parses independently', () => {
    const log = new MessageLog(logPath);
    log.append(makeEntry({ type: 'agent_sent', role: 'coder', message: 'hello' }));
    log.append(makeEntry({ type: 'error', error: 'boom' }));
    log.append(makeEntry({ type: 'gate_raised', acceptedEvents: ['APPROVE', 'ABORT'] }));

    const raw = readFileSync(logPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('preserves all fields on complex entries', () => {
    const log = new MessageLog(logPath);
    const entry: MessageLogEntry = {
      ts: '2026-04-04T12:00:00.000Z',
      workflowId: 'wf-abc',
      state: 'implement',
      type: 'agent_retry',
      role: 'coder',
      reason: 'missing_artifacts',
      details: 'Missing: code',
      retryMessage: 'Please create the code/ directory',
    };

    log.append(entry);
    const [read] = log.readAll();

    expect(read).toEqual(entry);
  });
});
