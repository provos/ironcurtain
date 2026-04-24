/**
 * Tests for discoverWorkflowRuns — a pure directory-scan utility that both
 * the CLI and the daemon use as their single source of truth for "what
 * workflow-run directories exist on disk?". See `src/workflow/workflow-discovery.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverWorkflowRuns, discoverWorkspacePathFromContainers } from '../src/workflow/workflow-discovery.js';
import type { WorkflowId } from '../src/workflow/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function createTempDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'ironcurtain-wf-runs-test-'));
}

interface RunDirOptions {
  readonly checkpoint?: boolean;
  readonly definition?: boolean;
  readonly messageLog?: boolean;
}

function createRunDir(baseDir: string, id: string, opts: RunDirOptions = {}): string {
  const dir = resolve(baseDir, id);
  mkdirSync(dir, { recursive: true });
  if (opts.checkpoint) writeFileSync(resolve(dir, 'checkpoint.json'), '{}');
  if (opts.definition) writeFileSync(resolve(dir, 'definition.json'), '{}');
  if (opts.messageLog) writeFileSync(resolve(dir, 'messages.jsonl'), '');
  return dir;
}

beforeEach(() => {
  tempDir = createTempDir();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('discoverWorkflowRuns', () => {
  it('returns [] for an empty directory', () => {
    expect(discoverWorkflowRuns(tempDir)).toEqual([]);
  });

  it('returns [] when baseDir does not exist (does not throw)', () => {
    const missing = resolve(tempDir, 'does-not-exist');
    expect(() => discoverWorkflowRuns(missing)).not.toThrow();
    expect(discoverWorkflowRuns(missing)).toEqual([]);
  });

  it('throws when baseDir is a file, not a directory (matches FileCheckpointStore.listAll)', () => {
    // Precedent: `listAll()` (checkpoint.ts:62) uses `existsSync` → `readdirSync`.
    // A file passes `existsSync` but causes `readdirSync` to throw ENOTDIR.
    // We match that behavior rather than silently returning [].
    const filePath = resolve(tempDir, 'not-a-dir.txt');
    writeFileSync(filePath, 'hello');
    expect(() => discoverWorkflowRuns(filePath)).toThrow();
  });

  it('reports probe-file presence correctly across all combinations', () => {
    createRunDir(tempDir, 'all-three', { checkpoint: true, definition: true, messageLog: true });
    createRunDir(tempDir, 'checkpoint-only', { checkpoint: true });
    createRunDir(tempDir, 'definition-only', { definition: true });
    createRunDir(tempDir, 'messages-only', { messageLog: true });
    createRunDir(tempDir, 'empty-dir', {});

    const runs = discoverWorkflowRuns(tempDir);
    expect(runs).toHaveLength(5);

    const byId = new Map(runs.map((r) => [r.workflowId as string, r]));

    const all = byId.get('all-three');
    expect(all).toBeDefined();
    expect(all?.hasCheckpoint).toBe(true);
    expect(all?.hasDefinition).toBe(true);
    expect(all?.hasMessageLog).toBe(true);

    const cp = byId.get('checkpoint-only');
    expect(cp?.hasCheckpoint).toBe(true);
    expect(cp?.hasDefinition).toBe(false);
    expect(cp?.hasMessageLog).toBe(false);

    const def = byId.get('definition-only');
    expect(def?.hasCheckpoint).toBe(false);
    expect(def?.hasDefinition).toBe(true);
    expect(def?.hasMessageLog).toBe(false);

    const msg = byId.get('messages-only');
    expect(msg?.hasCheckpoint).toBe(false);
    expect(msg?.hasDefinition).toBe(false);
    expect(msg?.hasMessageLog).toBe(true);

    const empty = byId.get('empty-dir');
    expect(empty?.hasCheckpoint).toBe(false);
    expect(empty?.hasDefinition).toBe(false);
    expect(empty?.hasMessageLog).toBe(false);
  });

  it('filters out non-directory entries at the base', () => {
    createRunDir(tempDir, 'real-run', { checkpoint: true });
    writeFileSync(resolve(tempDir, 'stray-file.txt'), 'ignore me');
    writeFileSync(resolve(tempDir, 'another.json'), '{}');

    const runs = discoverWorkflowRuns(tempDir);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.workflowId).toBe('real-run');
  });

  it('sorts newest-first by mtime', () => {
    createRunDir(tempDir, 'oldest', { checkpoint: true });
    createRunDir(tempDir, 'middle', { checkpoint: true });
    createRunDir(tempDir, 'newest', { checkpoint: true });

    // Set deterministic mtimes (in seconds). Note: atime, mtime.
    const t1 = new Date('2024-01-01T00:00:00Z');
    const t2 = new Date('2024-06-01T00:00:00Z');
    const t3 = new Date('2025-01-01T00:00:00Z');
    utimesSync(resolve(tempDir, 'oldest'), t1, t1);
    utimesSync(resolve(tempDir, 'middle'), t2, t2);
    utimesSync(resolve(tempDir, 'newest'), t3, t3);

    const runs = discoverWorkflowRuns(tempDir);
    expect(runs.map((r) => r.workflowId as string)).toEqual(['newest', 'middle', 'oldest']);
    expect(runs[0]?.mtime.getTime()).toBe(t3.getTime());
    expect(runs[1]?.mtime.getTime()).toBe(t2.getTime());
    expect(runs[2]?.mtime.getTime()).toBe(t1.getTime());
  });

  it('applies the WorkflowId branded type to the directory name', () => {
    createRunDir(tempDir, 'branded-id', { checkpoint: true });

    const runs = discoverWorkflowRuns(tempDir);
    expect(runs).toHaveLength(1);
    const [first] = runs;
    // Compile-time check: `workflowId` is assignable to `WorkflowId` with
    // no cast. The inverse (plain string into `WorkflowId`) would require
    // a cast, confirming the brand is carried on the returned field.
    const id: WorkflowId = first.workflowId;
    expect(id).toBe('branded-id');
  });

  it('returns absolute directoryPath values', () => {
    createRunDir(tempDir, 'alpha', { checkpoint: true });
    createRunDir(tempDir, 'beta', { definition: true });

    const runs = discoverWorkflowRuns(tempDir);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(isAbsolute(run.directoryPath)).toBe(true);
      expect(run.directoryPath).toBe(resolve(tempDir, run.workflowId));
    }
  });
});

// ---------------------------------------------------------------------------
// discoverWorkspacePathFromContainers
//
// Recovery helper for checkpoint-less past runs: walks
// `<runDir>/containers/*/states/*/session-metadata.json` and returns the
// `workspacePath` from the entry with the latest `createdAt`.
// ---------------------------------------------------------------------------

interface SessionMetadata {
  readonly createdAt: string;
  readonly workspacePath?: string;
  readonly agentConversationId?: string;
}

function writeSessionMetadata(
  runDir: string,
  containerId: string,
  stateName: string,
  metadata: SessionMetadata | string,
): string {
  const dir = resolve(runDir, 'containers', containerId, 'states', stateName);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'session-metadata.json');
  const content = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
  writeFileSync(path, content, 'utf-8');
  return path;
}

describe('discoverWorkspacePathFromContainers', () => {
  it('returns undefined when the runDir has no containers/ subdir', () => {
    const runDir = resolve(tempDir, 'no-containers');
    mkdirSync(runDir, { recursive: true });
    expect(discoverWorkspacePathFromContainers(runDir)).toBeUndefined();
  });

  it('returns undefined when the runDir itself does not exist', () => {
    const runDir = resolve(tempDir, 'missing-run');
    expect(discoverWorkspacePathFromContainers(runDir)).toBeUndefined();
  });

  it('returns the workspacePath for a single-state, single-container run', () => {
    const runDir = resolve(tempDir, 'wf-1');
    writeSessionMetadata(runDir, 'container-a', 'planner', {
      createdAt: '2026-04-23T20:40:44.055Z',
      workspacePath: '/home/user/src/repo',
      agentConversationId: 'conv-1',
    });
    expect(discoverWorkspacePathFromContainers(runDir)).toBe('/home/user/src/repo');
  });

  it('returns the workspacePath of the entry with the newest createdAt across multiple states/containers', () => {
    const runDir = resolve(tempDir, 'wf-multi');
    writeSessionMetadata(runDir, 'container-a', 'planner', {
      createdAt: '2026-04-23T19:00:00.000Z',
      workspacePath: '/old/path',
    });
    writeSessionMetadata(runDir, 'container-a', 'reviewer', {
      createdAt: '2026-04-23T21:30:00.000Z',
      workspacePath: '/newest/path',
    });
    writeSessionMetadata(runDir, 'container-b', 'planner', {
      createdAt: '2026-04-23T20:15:00.000Z',
      workspacePath: '/middle/path',
    });
    expect(discoverWorkspacePathFromContainers(runDir)).toBe('/newest/path');
  });

  it('silently skips malformed JSON files and returns the next-best workspacePath', () => {
    const runDir = resolve(tempDir, 'wf-bad-json');
    writeSessionMetadata(runDir, 'container-a', 'planner', '{ this is not json');
    writeSessionMetadata(runDir, 'container-a', 'reviewer', {
      createdAt: '2026-04-23T20:00:00.000Z',
      workspacePath: '/recovered/path',
    });
    expect(discoverWorkspacePathFromContainers(runDir)).toBe('/recovered/path');
  });

  it('silently skips files missing workspacePath and returns the next-best entry', () => {
    const runDir = resolve(tempDir, 'wf-missing-ws');
    writeSessionMetadata(runDir, 'container-a', 'planner', {
      createdAt: '2026-04-23T22:00:00.000Z',
      // workspacePath omitted entirely
    });
    writeSessionMetadata(runDir, 'container-a', 'reviewer', {
      createdAt: '2026-04-23T20:00:00.000Z',
      workspacePath: '/fallback/path',
    });
    expect(discoverWorkspacePathFromContainers(runDir)).toBe('/fallback/path');
  });

  it('returns undefined when every metadata file is unreadable or missing workspacePath', () => {
    const runDir = resolve(tempDir, 'wf-all-bad');
    writeSessionMetadata(runDir, 'container-a', 'planner', '{ broken');
    writeSessionMetadata(runDir, 'container-a', 'reviewer', {
      createdAt: '2026-04-23T20:00:00.000Z',
      // no workspacePath
    });
    expect(discoverWorkspacePathFromContainers(runDir)).toBeUndefined();
  });
});
