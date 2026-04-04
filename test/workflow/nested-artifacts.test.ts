import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeOutputHash } from '../../src/workflow/orchestrator.js';
import { buildAgentCommand } from '../../src/workflow/prompt-builder.js';
import type { AgentStateDefinition, WorkflowContext } from '../../src/workflow/types.js';

// ---------------------------------------------------------------------------
// computeOutputHash with nested directories
// ---------------------------------------------------------------------------

describe('computeOutputHash with nested directories', () => {
  let artifactDir: string;

  beforeEach(() => {
    artifactDir = resolve('/tmp', `ironcurtain-hash-test-${process.pid}-${Date.now()}`);
    mkdirSync(artifactDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('handles nested directory structures without EISDIR', () => {
    const codeDir = resolve(artifactDir, 'code');
    mkdirSync(resolve(codeDir, 'src'), { recursive: true });
    mkdirSync(resolve(codeDir, 'tests'), { recursive: true });
    writeFileSync(resolve(codeDir, 'index.ts'), 'export {}');
    writeFileSync(resolve(codeDir, 'src', 'main.ts'), 'console.log("hello")');
    writeFileSync(resolve(codeDir, 'tests', 'main.test.ts'), 'test("works", () => {})');

    // Should not throw EISDIR
    const hash = computeOutputHash(['code'], artifactDir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces deterministic hash for nested files', () => {
    const codeDir = resolve(artifactDir, 'code');
    mkdirSync(resolve(codeDir, 'src'), { recursive: true });
    writeFileSync(resolve(codeDir, 'src', 'main.ts'), 'content');

    const hash1 = computeOutputHash(['code'], artifactDir);
    const hash2 = computeOutputHash(['code'], artifactDir);
    expect(hash1).toBe(hash2);
  });

  it('detects changes in deeply nested files', () => {
    const codeDir = resolve(artifactDir, 'code');
    mkdirSync(resolve(codeDir, 'src', 'utils'), { recursive: true });
    writeFileSync(resolve(codeDir, 'src', 'utils', 'helper.ts'), 'version 1');

    const hash1 = computeOutputHash(['code'], artifactDir);

    writeFileSync(resolve(codeDir, 'src', 'utils', 'helper.ts'), 'version 2');
    const hash2 = computeOutputHash(['code'], artifactDir);

    expect(hash1).not.toBe(hash2);
  });

  it('handles mixed flat and nested files', () => {
    const codeDir = resolve(artifactDir, 'code');
    mkdirSync(resolve(codeDir, 'src'), { recursive: true });
    writeFileSync(resolve(codeDir, 'README.md'), 'readme');
    writeFileSync(resolve(codeDir, 'src', 'app.ts'), 'app');

    const hash = computeOutputHash(['code'], artifactDir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles empty subdirectories gracefully', () => {
    const codeDir = resolve(artifactDir, 'code');
    mkdirSync(resolve(codeDir, 'empty-subdir'), { recursive: true });
    writeFileSync(resolve(codeDir, 'file.ts'), 'content');

    const hash = computeOutputHash(['code'], artifactDir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// readArtifactContent via buildAgentCommand with nested directories
// ---------------------------------------------------------------------------

describe('buildAgentCommand with nested artifact directories', () => {
  let artifactDir: string;

  beforeEach(() => {
    artifactDir = resolve('/tmp', `ironcurtain-prompt-test-${process.pid}-${Date.now()}`);
    mkdirSync(artifactDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(artifactDir, { recursive: true, force: true });
  });

  it('reads files from nested directories without EISDIR', () => {
    const specDir = resolve(artifactDir, 'spec');
    mkdirSync(resolve(specDir, 'sections'), { recursive: true });
    writeFileSync(resolve(specDir, 'overview.md'), '# Overview');
    writeFileSync(resolve(specDir, 'sections', 'details.md'), '# Details');

    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      persona: 'test',
      inputs: ['spec'],
      outputs: ['code'],
    };
    const context: WorkflowContext = {
      taskDescription: 'Build something',
      artifacts: {},
      reviewHistory: [],
      sessionsByRole: {},
      stallCount: 0,
    };

    // Should not throw EISDIR
    const command = buildAgentCommand(stateConfig, context, artifactDir);
    expect(command).toContain('# Overview');
    expect(command).toContain('# Details');
  });

  it('labels nested files with relative paths', () => {
    const specDir = resolve(artifactDir, 'spec');
    mkdirSync(resolve(specDir, 'sub'), { recursive: true });
    writeFileSync(resolve(specDir, 'sub', 'file.md'), 'nested content');

    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      persona: 'test',
      inputs: ['spec'],
      outputs: [],
    };
    const context: WorkflowContext = {
      taskDescription: 'Task',
      artifacts: {},
      reviewHistory: [],
      sessionsByRole: {},
      stallCount: 0,
    };

    const command = buildAgentCommand(stateConfig, context, artifactDir);
    expect(command).toContain('### spec/sub/file.md');
  });
});
