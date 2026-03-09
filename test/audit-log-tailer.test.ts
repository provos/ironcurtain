/**
 * Tests for AuditLogTailer: incremental JSONL file reading,
 * offset tracking, diagnostic event emission, and preview building.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock watchFile/unwatchFile to prevent real filesystem watchers in tests.
// All other node:fs functions remain as real implementations.
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
  };
});

import { watchFile, unwatchFile } from 'node:fs';
import { AuditLogTailer } from '../src/docker/audit-log-tailer.js';
import type { DiagnosticEvent } from '../src/session/types.js';
import type { AuditEntry } from '../src/types/audit.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    requestId: 'req-1',
    serverName: 'filesystem',
    toolName: 'read_file',
    arguments: { path: '/tmp/test.txt' },
    policyDecision: { status: 'allow', rule: 'default-allow', reason: 'safe read' },
    result: { status: 'success', content: 'hello' },
    durationMs: 5,
    ...overrides,
  };
}

function appendEntry(logPath: string, entry: AuditEntry): void {
  appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AuditLogTailer', () => {
  let tempDir: string;
  let logPath: string;
  let events: DiagnosticEvent[];
  let tailer: AuditLogTailer;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'audit-tailer-test-'));
    logPath = join(tempDir, 'audit.jsonl');
    events = [];
    tailer = new AuditLogTailer(logPath, (event) => events.push(event));
    vi.clearAllMocks();
  });

  afterEach(() => {
    tailer.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── readNewEntries() ─────────────────────────────────────────────────────

  describe('readNewEntries()', () => {
    it('returns silently if the log file does not exist', () => {
      tailer.readNewEntries();
      expect(events).toHaveLength(0);
    });

    it('emits nothing when there is no new data since the last read', () => {
      writeFileSync(logPath, JSON.stringify(makeEntry()) + '\n', 'utf-8');
      tailer.readNewEntries(); // consume the initial entry
      const countAfterFirst = events.length;

      tailer.readNewEntries(); // second call — same file size
      expect(events).toHaveLength(countAfterFirst); // no new events
    });

    it('emits a tool_call event for a valid JSONL entry', () => {
      writeFileSync(logPath, JSON.stringify(makeEntry()) + '\n', 'utf-8');
      tailer.readNewEntries();

      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('tool_call');
    });

    it('formats toolName as "serverName.toolName"', () => {
      writeFileSync(logPath, JSON.stringify(makeEntry({ serverName: 'github', toolName: 'create_issue' })) + '\n', 'utf-8');
      tailer.readNewEntries();

      const ev = events[0] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      expect(ev.toolName).toBe('github.create_issue');
    });

    it('includes the result status in the preview', () => {
      writeFileSync(logPath, JSON.stringify(makeEntry({ result: { status: 'denied' } })) + '\n', 'utf-8');
      tailer.readNewEntries();

      const ev = events[0] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      expect(ev.preview).toMatch(/^\[denied\]/);
    });

    it('includes stringified arguments in the preview', () => {
      const entry = makeEntry({ arguments: { path: '/etc/hosts' } });
      writeFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
      tailer.readNewEntries();

      const ev = events[0] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      expect(ev.preview).toContain('/etc/hosts');
    });

    it('does not truncate preview when args JSON is 80 chars or fewer', () => {
      // Craft args whose JSON serialization is exactly short
      const entry = makeEntry({ arguments: { k: 'v' } });
      writeFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
      tailer.readNewEntries();

      const ev = events[0] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      expect(ev.preview).not.toContain('...');
    });

    it('truncates preview to 80 chars and appends "..." when args JSON is long', () => {
      // Build args whose JSON is > 80 characters
      const longValue = 'x'.repeat(100);
      const entry = makeEntry({ arguments: { data: longValue } });
      const argsJson = JSON.stringify(entry.arguments);
      expect(argsJson.length).toBeGreaterThan(80);

      writeFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
      tailer.readNewEntries();

      const ev = events[0] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      // Preview format: "[status] <first-80-chars>..."
      const argsPartOfPreview = ev.preview.replace(/^\[\w+\] /, '');
      expect(argsPartOfPreview).toHaveLength(83); // 80 chars + '...'
      expect(argsPartOfPreview.endsWith('...')).toBe(true);
      expect(argsPartOfPreview.slice(0, 80)).toBe(argsJson.slice(0, 80));
    });

    it('silently skips malformed JSON lines', () => {
      writeFileSync(logPath, 'not-valid-json\n', 'utf-8');
      expect(() => tailer.readNewEntries()).not.toThrow();
      expect(events).toHaveLength(0);
    });

    it('skips malformed lines and continues processing valid entries', () => {
      const valid = makeEntry({ toolName: 'list_dir' });
      writeFileSync(logPath, 'bad-json\n' + JSON.stringify(valid) + '\n', 'utf-8');
      tailer.readNewEntries();

      expect(events).toHaveLength(1);
      const ev = events[0] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      expect(ev.toolName).toContain('list_dir');
    });

    it('processes multiple entries appended in a single write', () => {
      const entry1 = makeEntry({ toolName: 'read_file' });
      const entry2 = makeEntry({ toolName: 'write_file' });
      writeFileSync(logPath, JSON.stringify(entry1) + '\n' + JSON.stringify(entry2) + '\n', 'utf-8');
      tailer.readNewEntries();

      expect(events).toHaveLength(2);
    });

    it('tracks file offset so previously-read entries are not re-emitted', () => {
      const entry1 = makeEntry({ toolName: 'read_file' });
      writeFileSync(logPath, JSON.stringify(entry1) + '\n', 'utf-8');
      tailer.readNewEntries();
      expect(events).toHaveLength(1);

      // Append a second entry
      const entry2 = makeEntry({ toolName: 'write_file' });
      appendEntry(logPath, entry2);
      tailer.readNewEntries();

      // Total should be 2, not 3 (first entry not re-read)
      expect(events).toHaveLength(2);
      const ev2 = events[1] as Extract<DiagnosticEvent, { kind: 'tool_call' }>;
      expect(ev2.toolName).toContain('write_file');
    });

    it('accumulates offset across multiple incremental reads', () => {
      // Write three entries one at a time, reading after each
      for (let i = 0; i < 3; i++) {
        appendEntry(logPath, makeEntry({ toolName: `tool_${i}` }));
        tailer.readNewEntries();
      }
      expect(events).toHaveLength(3);
    });
  });

  // ── start() / stop() ─────────────────────────────────────────────────────

  describe('start()', () => {
    it('registers a watchFile listener on the log path', () => {
      tailer.start();
      expect(watchFile).toHaveBeenCalledOnce();
      const [path] = (watchFile as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ...unknown[]];
      expect(path).toBe(logPath);
    });

    it('passes a callback to watchFile', () => {
      tailer.start();
      const args = (watchFile as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
      const callback = args[args.length - 1];
      expect(typeof callback).toBe('function');
    });
  });

  describe('stop()', () => {
    it('calls unwatchFile on the log path after start()', () => {
      tailer.start();
      tailer.stop();
      expect(unwatchFile).toHaveBeenCalledOnce();
      const [path] = (unwatchFile as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ...unknown[]];
      expect(path).toBe(logPath);
    });

    it('does nothing if called before start()', () => {
      tailer.stop(); // not watching yet
      expect(unwatchFile).not.toHaveBeenCalled();
    });

    it('is idempotent — a second stop() does not call unwatchFile again', () => {
      tailer.start();
      tailer.stop();
      tailer.stop();
      expect(unwatchFile).toHaveBeenCalledOnce();
    });
  });
});
