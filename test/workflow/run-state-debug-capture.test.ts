import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { captureConversationLogs, resolveCapturePaths } from '../../src/workflow/run-state-debug-capture.js';
import { getSessionDir } from '../../src/config/paths.js';
import type { BundleId } from '../../src/session/types.js';

describe('resolveCapturePaths', () => {
  // A canonical UUIDv4 with hyphens at the standard offsets so the
  // 12-char short id is taken from the first 12 hex digits after stripping.
  const bundleId = '12345678-90ab-4cde-8123-456789abcdef' as BundleId;
  const outputDir = '/tmp/some-output-dir';

  it('places container-logs.txt and claude-session-logs/ under outputDir', () => {
    const paths = resolveCapturePaths(bundleId, outputDir);
    expect(paths.containerLogsPath).toBe(resolve(outputDir, 'container-logs.txt'));
    expect(paths.claudeLogsDir).toBe(resolve(outputDir, 'claude-session-logs'));
  });

  it('points claudeProjectsSrc at the bind-mounted projects/ tree under the session dir', () => {
    const paths = resolveCapturePaths(bundleId, outputDir);
    expect(paths.claudeProjectsSrc).toBe(resolve(getSessionDir(bundleId), 'claude-state', 'projects'));
  });

  it('produces the deterministic ironcurtain-<12hex> container name (hyphen-stripped)', () => {
    const paths = resolveCapturePaths(bundleId, outputDir);
    // First 12 hex digits of '12345678-90ab-4cde-8123-...' after stripping hyphens are '1234567890ab'.
    expect(paths.containerName).toBe('ironcurtain-1234567890ab');
  });

  it('does not collide between different sessions sharing an outputDir', () => {
    const a = resolveCapturePaths(bundleId, outputDir);
    const b = resolveCapturePaths('fedcba98-7654-4321-8000-000000000000' as BundleId, outputDir);
    // Same outputDir => same destination paths (per-run isolation comes from
    // the caller picking distinct outputDirs); but the source projects dir
    // and container name must differ across sessions.
    expect(a.claudeProjectsSrc).not.toBe(b.claudeProjectsSrc);
    expect(a.containerName).not.toBe(b.containerName);
  });
});

describe('captureConversationLogs', () => {
  function makePaths(
    srcRel: string | null,
    destRel: string,
  ): { dir: string; paths: ReturnType<typeof resolveCapturePaths> } {
    const dir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-cclogs-'));
    const claudeProjectsSrc = srcRel === null ? resolve(dir, '__missing__') : resolve(dir, srcRel);
    const claudeLogsDir = resolve(dir, destRel);
    return {
      dir,
      paths: {
        containerLogsPath: resolve(dir, 'unused.txt'),
        claudeLogsDir,
        claudeProjectsSrc,
        containerName: 'unused',
      },
    };
  }

  it('skips when the source projects dir does not exist (no destination created)', () => {
    const { dir, paths } = makePaths(null, 'claude-session-logs');
    try {
      captureConversationLogs(paths);
      expect(() => mkdirSync(paths.claudeLogsDir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips when the source projects dir is empty (no destination created)', () => {
    const { dir, paths } = makePaths('projects', 'claude-session-logs');
    mkdirSync(paths.claudeProjectsSrc, { recursive: true });
    try {
      captureConversationLogs(paths);
      // Destination must NOT exist; mkdirSync would otherwise throw EEXIST.
      expect(() => mkdirSync(paths.claudeLogsDir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('copies tree when source contains at least one file', () => {
    const { dir, paths } = makePaths('projects', 'claude-session-logs');
    mkdirSync(paths.claudeProjectsSrc, { recursive: true });
    writeFileSync(resolve(paths.claudeProjectsSrc, 'a.jsonl'), 'line\n', 'utf-8');
    try {
      captureConversationLogs(paths);
      // After successful copy, the destination exists; trying to mkdir it throws.
      expect(() => mkdirSync(paths.claudeLogsDir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
