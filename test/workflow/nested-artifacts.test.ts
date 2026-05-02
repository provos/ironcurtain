import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeOutputHash } from '../../src/workflow/orchestrator.js';
import { buildAgentCommand, buildHandoffClause, buildStatusInstructions } from '../../src/workflow/prompt-builder.js';
import type {
  AgentStateDefinition,
  AgentTransitionDefinition,
  WorkflowContext,
  WorkflowDefinition,
} from '../../src/workflow/types.js';

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
    lastError: null,
    agentConversationsByState: {},
    previousAgentOutput: null,
    previousAgentNotes: null,
    previousStateName: null,
    visitCounts: {},
    ...overrides,
  };
}

/** Minimal workflow definition for tests that need the definition parameter. */
function makeDefinition(states: WorkflowDefinition['states'] = {}): WorkflowDefinition {
  return {
    name: 'test-workflow',
    description: 'A test workflow',
    initial: Object.keys(states)[0] ?? 'start',
    states,
  };
}

// ---------------------------------------------------------------------------
// buildStatusInstructions
// ---------------------------------------------------------------------------

describe('buildStatusInstructions', () => {
  it('returns minimal instructions for unconditional transitions', () => {
    const result = buildStatusInstructions([{ to: 'next' }]);
    expect(result).toContain('verdict: completed');
    expect(result).not.toContain('determines what happens next');
  });

  it('returns minimal instructions for empty transitions', () => {
    const result = buildStatusInstructions([]);
    expect(result).toContain('verdict: completed');
  });

  it('returns conditional instructions for when-clause transitions', () => {
    const result = buildStatusInstructions([
      { to: 'a', when: { verdict: 'approved' } },
      { to: 'b', when: { verdict: 'rejected' } },
    ]);
    expect(result).toContain('determines what happens next');
    expect(result).toContain('`approved`');
    expect(result).toContain('`rejected`');
  });

  it('returns conditional instructions for when clause transitions', () => {
    const result = buildStatusInstructions([
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'implement', when: { verdict: 'rejected' } },
    ]);
    expect(result).toContain('determines what happens next');
  });
});

// ---------------------------------------------------------------------------
// Worker vs Router prompt patterns
// ---------------------------------------------------------------------------

describe('buildAgentCommand with unconditional transitions', () => {
  it('puts task in Workflow Context before role prompt', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      description: 'Plans the project',
      persona: 'planner',
      prompt: 'You are a project planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [], // no verdict routing -> worker
    };

    const command = buildAgentCommand(
      'plan',
      stateConfig,
      makeContext({ taskDescription: 'Build a CLI tool' }),
      makeDefinition(),
    );

    // Worker pattern: Workflow Context (with task) before role prompt
    expect(command).toContain('## Workflow Context');
    expect(command).toContain('> Build a CLI tool');
    expect(command).toContain('## Your Role');
    expect(command).toContain('You are a project planner.');

    // Task description should appear BEFORE role prompt
    const contextIndex = command.indexOf('## Workflow Context');
    const roleIndex = command.indexOf('## Your Role');
    expect(contextIndex).toBeLessThan(roleIndex);
  });

  it('does not use ## Task heading for workers', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      description: 'Worker',
      persona: 'worker',
      prompt: 'You are a worker.',
      inputs: [],
      outputs: [],
      transitions: [{ to: 'next' }], // unconditional -> worker
    };

    const command = buildAgentCommand(
      'work',
      stateConfig,
      makeContext({ taskDescription: 'Do something' }),
      makeDefinition(),
    );

    expect(command).not.toContain('## Task');
    expect(command).toContain('## Workflow Context');
  });

  it('includes expected outputs and status block', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      description: 'Creates a plan',
      persona: 'planner',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [],
    };

    const command = buildAgentCommand(
      'plan',
      stateConfig,
      makeContext({ taskDescription: 'Build a CLI tool' }),
      makeDefinition(),
    );

    expect(command).toContain('## Expected Outputs');
    expect(command).toContain('`.workflow/plan/`');
    expect(command).toContain('agent_status');
  });
});

describe('buildAgentCommand with conditional transitions', () => {
  it('uses Workflow Context and Your Role for verdict-routed states', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      description: 'Routes work',
      persona: 'orchestrator',
      prompt: 'You are an orchestrator.',
      inputs: [],
      outputs: ['journal'],
      transitions: [
        { to: 'analyze', when: { verdict: 'reanalyze' } },
        { to: 'validate', when: { verdict: 'validate' } },
      ],
    };

    const command = buildAgentCommand(
      'orchestrator',
      stateConfig,
      makeContext({ taskDescription: 'Find vulnerabilities' }),
      makeDefinition(),
    );

    // Universal pattern: Workflow Context (with task) before Your Role
    expect(command).toContain('## Workflow Context');
    expect(command).toContain('> Find vulnerabilities');
    expect(command).toContain('## Your Role');
    expect(command).toContain('You are an orchestrator.');
    expect(command).not.toContain('## Task');

    // Workflow Context should appear BEFORE role prompt
    const contextIndex = command.indexOf('## Workflow Context');
    const roleIndex = command.indexOf('## Your Role');
    expect(contextIndex).toBeLessThan(roleIndex);
  });

  it('uses conditional status instructions with verdict values', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      description: 'Routes work',
      persona: 'orchestrator',
      prompt: 'You are an orchestrator.',
      inputs: [],
      outputs: [],
      transitions: [
        { to: 'a', when: { verdict: 'approved' } },
        { to: 'b', when: { verdict: 'rejected' } },
      ],
    };

    const command = buildAgentCommand('orch', stateConfig, makeContext(), makeDefinition());

    expect(command).toContain('determines what happens next');
    expect(command).toContain('`approved`');
    expect(command).toContain('`rejected`');
  });
});

describe('buildAgentCommand first-visit mode (shared behavior)', () => {
  it('includes previous agent output when available', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      description: 'Creates a design',
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
      makeDefinition(),
    );

    expect(command).toContain('## Output from plan');
    expect(command).toContain('The planner created a 3-step plan.');
  });

  it('includes human feedback when present', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      description: 'Creates a plan',
      persona: 'planner',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [],
    };

    const command = buildAgentCommand(
      'plan',
      stateConfig,
      makeContext({ humanPrompt: 'Focus on testing' }),
      makeDefinition(),
    );

    expect(command).toContain('## Human Feedback');
    expect(command).toContain('Focus on testing');
  });

  it('omits previous output section when no previous agent output', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      description: 'Creates a plan',
      persona: 'planner',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: [],
      transitions: [],
    };

    const command = buildAgentCommand('plan', stateConfig, makeContext(), makeDefinition());

    expect(command).not.toContain('## Output from');
    expect(command).not.toContain('## New Input from');
  });

  it('includes handoff clause when definition has transitions', () => {
    const definition = makeDefinition({
      implement: {
        type: 'agent',
        description: 'Writes code',
        persona: 'coder',
        prompt: 'You are an implementation engineer.',
        inputs: [],
        outputs: ['code'],
        transitions: [{ to: 'review', when: { verdict: 'approved' } }],
      },
      review: {
        type: 'agent',
        description: 'Reviews code',
        persona: 'reviewer',
        prompt: 'You are a code reviewer.',
        inputs: ['code'],
        outputs: [],
        transitions: [],
      },
    });

    const stateConfig = definition.states['implement'] as AgentStateDefinition;
    const command = buildAgentCommand('implement', stateConfig, makeContext(), definition);

    expect(command).toContain('## What happens with your output');
    expect(command).toContain('verdict=approved');
    expect(command).toContain('review');
    // Handoff clause must appear before status block
    const handoffIndex = command.indexOf('## What happens with your output');
    const statusIndex = command.indexOf('agent_status');
    expect(handoffIndex).toBeLessThan(statusIndex);
  });

  it('omits handoff clause when transitions are empty', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      description: 'Creates a plan',
      persona: 'planner',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: [],
      transitions: [],
    };

    const command = buildAgentCommand('plan', stateConfig, makeContext(), makeDefinition());

    expect(command).not.toContain('## What happens with your output');
  });
});

describe('buildAgentCommand re-visit mode', () => {
  it('omits role prompt and task on re-visit', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      freshSession: false,
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
      makeDefinition(),
    );

    // Re-visit should NOT include role prompt, task, or section headings
    expect(command).not.toContain('You are an implementation engineer.');
    expect(command).not.toContain('## Task');
    expect(command).not.toContain('## Workflow Context');
    expect(command).not.toContain('## Your Role');
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
      description: 'Writes code',
      persona: 'coder',
      freshSession: false,
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
      makeDefinition(),
    );

    expect(command).toContain('## Human Feedback');
    expect(command).toContain('Add error handling');
  });

  it('dispatches based on visitCounts, not global round', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      freshSession: false,
      prompt: 'You are a coder.',
      inputs: [],
      outputs: [],
      transitions: [],
    };

    // First visit (visitCounts[implement] = 0 or missing) -> includes prompt
    const def = makeDefinition();
    const firstVisit = buildAgentCommand('implement', stateConfig, makeContext({ visitCounts: {} }), def);
    expect(firstVisit).toContain('You are a coder.');

    // visitCounts[implement] = 1 means visited once, so still first visit semantics
    const afterFirstVisit = buildAgentCommand(
      'implement',
      stateConfig,
      makeContext({ visitCounts: { implement: 1 } }),
      def,
    );
    expect(afterFirstVisit).toContain('You are a coder.');

    // visitCounts[implement] = 2 means re-visit
    const reVisit = buildAgentCommand('implement', stateConfig, makeContext({ visitCounts: { implement: 2 } }), def);
    expect(reVisit).not.toContain('You are a coder.');
  });

  it('does not include handoff clause on re-visit even with definition', () => {
    const definition = makeDefinition({
      implement: {
        type: 'agent',
        description: 'Writes code',
        persona: 'coder',
        freshSession: false,
        prompt: 'You are a coder.',
        inputs: [],
        outputs: ['code'],
        transitions: [{ to: 'review', when: { verdict: 'approved' } }],
      },
      review: {
        type: 'agent',
        description: 'Reviews code',
        persona: 'reviewer',
        prompt: 'You are a reviewer.',
        inputs: ['code'],
        outputs: [],
        transitions: [],
      },
    });

    const stateConfig = definition.states['implement'] as AgentStateDefinition;
    const command = buildAgentCommand(
      'implement',
      stateConfig,
      makeContext({ visitCounts: { implement: 2 } }),
      definition,
    );

    expect(command).not.toContain('## What happens with your output');
  });
});

describe('buildAgentCommand with artifact inputs', () => {
  it('includes path references for input artifacts instead of file content', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      description: 'Tests things',
      persona: 'test',
      prompt: 'You are a test agent.',
      inputs: ['spec'],
      outputs: ['code'],
      transitions: [],
    };

    const command = buildAgentCommand('test', stateConfig, makeContext(), makeDefinition());

    // Should reference the directory path with .workflow/ prefix, not inline content
    expect(command).toContain('## Inputs');
    expect(command).toContain('`.workflow/<name>/`');
    expect(command).toContain('- `spec` (required)');
  });

  it('includes path references for multiple input artifacts', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      description: 'Tests things',
      persona: 'test',
      prompt: 'You are a test agent.',
      inputs: ['plan', 'spec'],
      outputs: [],
      transitions: [],
    };

    const command = buildAgentCommand('test', stateConfig, makeContext(), makeDefinition());

    expect(command).toContain('## Inputs');
    expect(command).toContain('- `plan` (required)');
    expect(command).toContain('- `spec` (required)');
    // All-required: should NOT include the optional-inputs sentence
    expect(command).not.toContain('Optional inputs');
  });

  it('handles optional inputs by stripping the ? suffix', () => {
    const stateConfig: AgentStateDefinition = {
      type: 'agent',
      description: 'Tests things',
      persona: 'test',
      prompt: 'You are a test agent.',
      inputs: ['feedback?'],
      outputs: [],
      transitions: [],
    };

    const command = buildAgentCommand('test', stateConfig, makeContext(), makeDefinition());

    expect(command).toContain('## Inputs');
    expect(command).toContain('- `feedback` (optional)');
    expect(command).toContain('Optional inputs');
    expect(command).not.toContain('feedback?');
  });
});

// ---------------------------------------------------------------------------
// buildHandoffClause
// ---------------------------------------------------------------------------

describe('buildHandoffClause', () => {
  it('returns undefined for empty transitions', () => {
    const result = buildHandoffClause([], makeDefinition());
    expect(result).toBeUndefined();
  });

  it('formats when conditions as key=value pairs', () => {
    const definition = makeDefinition({
      orchestrator: {
        type: 'agent',
        description: 'Investigation strategy and routing',
        persona: 'orchestrator',
        prompt: 'You are an investigation orchestrator.',
        inputs: [],
        outputs: [],
        transitions: [],
      },
      harness_critique: {
        type: 'agent',
        description: 'Diagnoses harness validation failures',
        persona: 'critic',
        prompt: 'You are a security tooling reviewer diagnosing harness validation failures.',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });

    const transitions: AgentTransitionDefinition[] = [
      { to: 'orchestrator', when: { verdict: 'approved' } },
      { to: 'harness_critique', when: { verdict: 'rejected' } },
    ];

    const result = buildHandoffClause(transitions, definition);

    expect(result).toContain('## What happens with your output');
    expect(result).toContain('verdict=approved');
    expect(result).toContain('orchestrator');
    expect(result).toContain('Investigation strategy and routing');
    expect(result).toContain('verdict=rejected');
    expect(result).toContain('harness_critique');
    expect(result).toContain('Diagnoses harness validation failures');
  });

  it('formats multiple when keys joined with commas', () => {
    const definition = makeDefinition({
      fast_track: {
        type: 'agent',
        description: 'Fast-track processing',
        persona: 'fast',
        prompt: 'You are a fast-track processor.',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });

    const transitions: AgentTransitionDefinition[] = [
      { to: 'fast_track', when: { verdict: 'approved', confidence: 'high' } },
    ];

    const result = buildHandoffClause(transitions, definition);

    expect(result).toContain('verdict=approved, confidence=high');
  });

  it('formats guard conditions with human-readable labels', () => {
    const definition = makeDefinition({
      done: { type: 'terminal', description: 'Workflow complete' },
      implement: {
        type: 'agent',
        description: 'Writes code',
        persona: 'coder',
        prompt: 'You are a coder.',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });

    const transitions: AgentTransitionDefinition[] = [
      { to: 'done', guard: 'isRoundLimitReached' },
      { to: 'implement', when: { verdict: 'rejected' } },
    ];

    const result = buildHandoffClause(transitions, definition);

    expect(result).toContain('round limit reached');
    expect(result).toContain('done');
    expect(result).toContain('Workflow complete');
    expect(result).toContain('verdict=rejected');
    expect(result).toContain('implement');
  });

  it('falls back to guard name for unknown guards', () => {
    const definition = makeDefinition({
      next: {
        type: 'agent',
        description: 'Next agent',
        persona: 'next',
        prompt: 'You are the next agent.',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });

    const transitions: AgentTransitionDefinition[] = [{ to: 'next', guard: 'customGuardName' }];

    const result = buildHandoffClause(transitions, definition);

    expect(result).toContain('customGuardName');
  });

  it('formats unconditional transitions as (default)', () => {
    const definition = makeDefinition({
      review: {
        type: 'agent',
        description: 'Reviews code for quality',
        persona: 'reviewer',
        prompt: 'You are a code reviewer.',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });

    const transitions: AgentTransitionDefinition[] = [{ to: 'review' }];

    const result = buildHandoffClause(transitions, definition);

    expect(result).toContain('(default)');
    expect(result).toContain('review');
    expect(result).toContain('Reviews code for quality');
  });

  it('handles mixed transition types', () => {
    const definition = makeDefinition({
      done: { type: 'terminal', description: 'Workflow complete' },
      review: {
        type: 'human_gate',
        description: 'Human review gate',
        acceptedEvents: ['APPROVE', 'FORCE_REVISION'],
        transitions: [
          { to: 'done', event: 'APPROVE' },
          { to: 'implement', event: 'FORCE_REVISION' },
        ],
      },
      validate: {
        type: 'deterministic',
        description: 'Automated checks',
        run: [['npm', 'test']],
        transitions: [],
      },
      fallback: {
        type: 'agent',
        description: 'Fallback handler',
        persona: 'fallback',
        prompt: 'You are a fallback handler.',
        inputs: [],
        outputs: [],
        transitions: [],
      },
    });

    const transitions: AgentTransitionDefinition[] = [
      { to: 'done', guard: 'isRoundLimitReached' },
      { to: 'review', when: { verdict: 'approved' } },
      { to: 'validate', when: { verdict: 'rejected' } },
      { to: 'fallback' },
    ];

    const result = buildHandoffClause(transitions, definition);

    expect(result).toContain('round limit reached');
    expect(result).toContain('Workflow complete');
    expect(result).toContain('verdict=approved');
    expect(result).toContain('Human review gate');
    expect(result).toContain('verdict=rejected');
    expect(result).toContain('Automated checks');
    expect(result).toContain('(default)');
    expect(result).toContain('Fallback handler');
  });
});
