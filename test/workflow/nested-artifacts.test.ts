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
    const hash = computeOutputHash(['code'], artifactDir, artifactDir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces deterministic hash for nested files', () => {
    const codeDir = resolve(artifactDir, 'code');
    mkdirSync(resolve(codeDir, 'src'), { recursive: true });
    writeFileSync(resolve(codeDir, 'src', 'main.ts'), 'content');

    const hash1 = computeOutputHash(['code'], artifactDir, artifactDir);
    const hash2 = computeOutputHash(['code'], artifactDir, artifactDir);
    expect(hash1).toBe(hash2);
  });

  it('detects changes in deeply nested files', () => {
    const codeDir = resolve(artifactDir, 'code');
    mkdirSync(resolve(codeDir, 'src', 'utils'), { recursive: true });
    writeFileSync(resolve(codeDir, 'src', 'utils', 'helper.ts'), 'version 1');

    const hash1 = computeOutputHash(['code'], artifactDir, artifactDir);

    writeFileSync(resolve(codeDir, 'src', 'utils', 'helper.ts'), 'version 2');
    const hash2 = computeOutputHash(['code'], artifactDir, artifactDir);

    expect(hash1).not.toBe(hash2);
  });

  it('handles mixed flat and nested files', () => {
    const codeDir = resolve(artifactDir, 'code');
    mkdirSync(resolve(codeDir, 'src'), { recursive: true });
    writeFileSync(resolve(codeDir, 'README.md'), 'readme');
    writeFileSync(resolve(codeDir, 'src', 'app.ts'), 'app');

    const hash = computeOutputHash(['code'], artifactDir, artifactDir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles empty subdirectories gracefully', () => {
    const codeDir = resolve(artifactDir, 'code');
    mkdirSync(resolve(codeDir, 'empty-subdir'), { recursive: true });
    writeFileSync(resolve(codeDir, 'file.ts'), 'content');

    const hash = computeOutputHash(['code'], artifactDir, artifactDir);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// buildAgentCommand with artifact inputs (path references, no file I/O)
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    taskDescription: 'Build something',
    artifacts: {},
    round: 0,
    maxRounds: 4,
    previousOutputHashes: {},
    previousTestCount: null,
    humanPrompt: null,
    reviewHistory: [],
    parallelResults: {},
    worktreeBranches: [],
    totalTokens: 0,
    flaggedForReview: false,
    lastError: null,
    sessionsByRole: {},
    previousAgentOutput: null,
    previousStateName: null,
    visitCounts: {},
    ...overrides,
  };
}

describe('buildAgentCommand first-visit mode', () => {
  it('includes role prompt, task, expected outputs, and status block on first visit', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      persona: 'planner',
      prompt: 'You are a project planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [],
    };

    const command = buildAgentCommand('plan', stateConfig, makeContext({ taskDescription: 'Build a CLI tool' }));

    expect(command).toContain('You are a project planner.');
    expect(command).toContain('## Task');
    expect(command).toContain('Build a CLI tool');
    expect(command).toContain('## Expected Outputs');
    expect(command).toContain('`.workflow/plan/`');
    expect(command).toContain('agent_status');
  });

  it('includes previous agent output when available', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      persona: 'architect',
      prompt: 'You are an architect.',
      inputs: ['plan'],
      outputs: ['spec'],
      transitions: [],
    };

    const command = buildAgentCommand(
      'design',
      stateConfig,
      makeContext({
        previousAgentOutput: 'The planner created a 3-step plan.',
        previousStateName: 'plan',
      }),
    );

    expect(command).toContain('## Output from plan');
    expect(command).toContain('The planner created a 3-step plan.');
  });

  it('includes human feedback when present', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      persona: 'planner',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [],
    };

    const command = buildAgentCommand('plan', stateConfig, makeContext({ humanPrompt: 'Focus on testing' }));

    expect(command).toContain('## Human Feedback');
    expect(command).toContain('Focus on testing');
  });

  it('omits previous output section when no previous agent output', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      persona: 'planner',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: [],
      transitions: [],
    };

    const command = buildAgentCommand('plan', stateConfig, makeContext());

    expect(command).not.toContain('## Output from');
    expect(command).not.toContain('## New Input from');
  });
});

describe('buildAgentCommand re-visit mode', () => {
  it('omits role prompt and task on re-visit', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      persona: 'coder',
      prompt: 'You are an implementation engineer.',
      inputs: ['spec'],
      outputs: ['code'],
      transitions: [],
    };

    const command = buildAgentCommand(
      'implement',
      stateConfig,
      makeContext({
        visitCounts: { implement: 2 },
        previousAgentOutput: 'Rejected: missing tests',
        previousStateName: 'review',
      }),
    );

    // Re-visit should NOT include role prompt or task
    expect(command).not.toContain('You are an implementation engineer.');
    expect(command).not.toContain('## Task');
    // Should include new input and round info
    expect(command).toContain('## New Input from review');
    expect(command).toContain('Rejected: missing tests');
    expect(command).toContain('## Round');
    expect(command).toContain('round 2');
    expect(command).toContain('agent_status');
  });

  it('includes human feedback on re-visit', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: ['code'],
      transitions: [],
    };

    const command = buildAgentCommand(
      'implement',
      stateConfig,
      makeContext({
        visitCounts: { implement: 3 },
        humanPrompt: 'Add error handling',
      }),
    );

    expect(command).toContain('## Human Feedback');
    expect(command).toContain('Add error handling');
  });

  it('dispatches based on visitCounts, not global round', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: [],
      transitions: [],
    };

    // First visit (visitCounts[implement] = 0 or missing) -> includes prompt
    const firstVisit = buildAgentCommand('implement', stateConfig, makeContext({ visitCounts: {} }));
    expect(firstVisit).toContain('You are a coder.');

    // visitCounts[implement] = 1 means visited once, so still first visit semantics
    const afterFirstVisit = buildAgentCommand('implement', stateConfig, makeContext({ visitCounts: { implement: 1 } }));
    expect(afterFirstVisit).toContain('You are a coder.');

    // visitCounts[implement] = 2 means re-visit
    const reVisit = buildAgentCommand('implement', stateConfig, makeContext({ visitCounts: { implement: 2 } }));
    expect(reVisit).not.toContain('You are a coder.');
  });
});

describe('buildAgentCommand with artifact inputs', () => {
  it('includes path references for input artifacts instead of file content', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      persona: 'test',
      prompt: 'You are a test agent.',
      inputs: ['spec'],
      outputs: ['code'],
      transitions: [],
    };

    const command = buildAgentCommand('test', stateConfig, makeContext());

    // Should reference the directory path with .workflow/ prefix, not inline content
    expect(command).toContain('`.workflow/spec/`');
    expect(command).toContain('Read the contents');
    expect(command).toContain('file reading tools');
  });

  it('includes path references for multiple input artifacts', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      persona: 'test',
      prompt: 'You are a test agent.',
      inputs: ['plan', 'spec'],
      outputs: [],
      transitions: [],
    };

    const command = buildAgentCommand('test', stateConfig, makeContext());

    expect(command).toContain('## Input: plan');
    expect(command).toContain('`.workflow/plan/`');
    expect(command).toContain('## Input: spec');
    expect(command).toContain('`.workflow/spec/`');
  });

  it('handles optional inputs by stripping the ? suffix', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      persona: 'test',
      prompt: 'You are a test agent.',
      inputs: ['feedback?'],
      outputs: [],
      transitions: [],
    };

    const command = buildAgentCommand('test', stateConfig, makeContext());

    expect(command).toContain('## Input: feedback');
    expect(command).toContain('`.workflow/feedback/`');
    expect(command).not.toContain('feedback?');
  });
});
