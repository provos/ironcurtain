/**
 * Functional tests for invalid-verdict re-prompting and hard failure.
 *
 * Validates that the orchestrator:
 * 1. Re-prompts when an agent returns a verdict not matching any transition
 * 2. Throws on double-invalid verdict (surfaces as workflow failure)
 * 3. Passes valid verdicts through without re-prompting
 * 4. Skips validation for states with unconditional transitions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import { WorkflowOrchestrator } from '../../src/workflow/orchestrator.js';
import {
  MockSession,
  statusBlock,
  simulateArtifacts,
  findWorkflowDir,
  writeDefinitionFile,
  createDeps,
  waitForCompletion,
  stubPersonasForTest,
} from './test-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function verdictResponse(verdict: string, notes = 'done'): string {
  return `I completed the work.\n${statusBlock(verdict, notes)}`;
}

// ---------------------------------------------------------------------------
// Workflow definitions
// ---------------------------------------------------------------------------

/**
 * Workflow with when-clause routing: orchestrator dispatches based on verdict.
 * This is the pattern that deadlocks when the verdict doesn't match.
 */
const whenRoutedDef: WorkflowDefinition = {
  name: 'when-routed',
  description: 'Orchestrator with when-clause verdict routing',
  initial: 'analyze',
  settings: { mode: 'builtin' },
  states: {
    analyze: {
      type: 'agent',
      description: 'Analyzes the problem',
      persona: 'analyst',
      prompt: 'Analyze the problem.',
      inputs: [],
      outputs: ['analysis'],
      transitions: [
        { to: 'implement', when: { verdict: 'implement' } },
        { to: 'research', when: { verdict: 'research' } },
        { to: 'done', when: { verdict: 'done' } },
      ],
    },
    implement: {
      type: 'agent',
      description: 'Implements the solution',
      persona: 'coder',
      prompt: 'Implement the solution.',
      inputs: ['analysis'],
      outputs: ['code'],
      transitions: [{ to: 'done' }],
    },
    research: {
      type: 'agent',
      description: 'Researches the problem',
      persona: 'researcher',
      prompt: 'Research the problem.',
      inputs: ['analysis'],
      outputs: ['research'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

/**
 * Workflow where the initial state has an unconditional transition.
 * Any verdict should be accepted without validation.
 */
const unconditionalDef: WorkflowDefinition = {
  name: 'unconditional',
  description: 'Workflow with unconditional transition',
  initial: 'work',
  settings: { mode: 'builtin' },
  states: {
    work: {
      type: 'agent',
      description: 'Does work',
      persona: 'worker',
      prompt: 'Do the work.',
      inputs: [],
      outputs: ['result'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

/**
 * Workflow with mixed when + guard transitions. The guard-only
 * transition cannot be pre-validated, so only when-clause verdicts
 * are checked.
 */
const mixedDef: WorkflowDefinition = {
  name: 'mixed-transitions',
  description: 'Workflow with mixed when and guard transitions',
  initial: 'review',
  settings: { mode: 'builtin', maxRounds: 4 },
  states: {
    review: {
      type: 'agent',
      description: 'Reviews work',
      persona: 'reviewer',
      prompt: 'Review the work.',
      inputs: [],
      outputs: ['reviews'],
      transitions: [
        { to: 'done', when: { verdict: 'approved' } },
        { to: 'escalated', guard: 'isRoundLimitReached' },
        { to: 'review', when: { verdict: 'rejected' } },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    escalated: { type: 'terminal', description: 'Escalated' },
  },
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let cleanupPersonas: () => void;

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'verdict-test-'));
  cleanupPersonas = stubPersonasForTest(tmpDir, whenRoutedDef, unconditionalDef, mixedDef);
});

afterEach(() => {
  cleanupPersonas();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verdict validation', () => {
  it('re-prompts on invalid verdict and succeeds on valid retry', async () => {
    const sentMessages: string[] = [];
    let callCount = 0;

    const deps = createDeps(tmpDir, {
      createSession: vi.fn(async () => {
        return new MockSession({
          responses: (msg: string) => {
            sentMessages.push(msg);
            callCount++;
            const workflowDir = findWorkflowDir(tmpDir);

            if (callCount === 1) {
              // First call: return invalid verdict
              simulateArtifacts(workflowDir, ['analysis']);
              return verdictResponse('no-vuln', 'nothing found');
            }
            if (callCount === 2) {
              // Second call (re-prompt): return valid verdict
              return verdictResponse('done', 'completed analysis');
            }
            // Downstream states (should not be reached for this test path)
            simulateArtifacts(workflowDir, ['code', 'research']);
            return verdictResponse('done');
          },
        });
      }),
    });

    const defPath = writeDefinitionFile(tmpDir, whenRoutedDef);
    const orchestrator = new WorkflowOrchestrator(deps);
    const workflowId = await orchestrator.start(defPath, 'Test task');
    await waitForCompletion(orchestrator, workflowId);

    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('completed');

    // Verify re-prompt was sent
    expect(callCount).toBeGreaterThanOrEqual(2);
    const retryMessage = sentMessages[1];
    expect(retryMessage).toContain('no-vuln');
    expect(retryMessage).toContain('not a valid routing option');
    expect(retryMessage).toContain('implement');
    expect(retryMessage).toContain('research');
    expect(retryMessage).toContain('done');
  });

  it('throws on double-invalid verdict and surfaces error', async () => {
    let callCount = 0;
    const lifecycleEvents: { kind: string; error?: string }[] = [];

    const deps = createDeps(tmpDir, {
      createSession: vi.fn(async () => {
        return new MockSession({
          responses: () => {
            callCount++;
            if (callCount === 1) {
              const workflowDir = findWorkflowDir(tmpDir);
              simulateArtifacts(workflowDir, ['analysis']);
            }

            // Both attempts return invalid verdicts
            return verdictResponse('no-vuln', 'nothing found');
          },
        });
      }),
    });

    const defPath = writeDefinitionFile(tmpDir, whenRoutedDef);
    const orchestrator = new WorkflowOrchestrator(deps);
    orchestrator.onEvent((e) => lifecycleEvents.push(e));
    const workflowId = await orchestrator.start(defPath, 'Test task');
    await waitForCompletion(orchestrator, workflowId);

    // The error goes through XState's onError -> storeError -> terminal state.
    // The machine completes but the error is surfaced via lifecycle events.
    expect(callCount).toBe(2);

    const failEvents = lifecycleEvents.filter((e) => e.kind === 'failed');
    expect(failEvents.length).toBeGreaterThanOrEqual(1);
    const errorMsg = failEvents[0].error ?? '';
    expect(errorMsg).toContain('invalid verdict');
    expect(errorMsg).toContain('no-vuln');
  });

  it('throws when verdict retry response is missing the status block', async () => {
    let callCount = 0;
    const lifecycleEvents: { kind: string; error?: string }[] = [];

    const deps = createDeps(tmpDir, {
      createSession: vi.fn(async () => {
        return new MockSession({
          responses: () => {
            callCount++;
            if (callCount === 1) {
              const workflowDir = findWorkflowDir(tmpDir);
              simulateArtifacts(workflowDir, ['analysis']);
              // First call: invalid verdict
              return verdictResponse('no-vuln', 'nothing found');
            }
            // Retry: respond without a status block at all
            return 'I revised my analysis but forgot the status block.';
          },
        });
      }),
    });

    const defPath = writeDefinitionFile(tmpDir, whenRoutedDef);
    const orchestrator = new WorkflowOrchestrator(deps);
    orchestrator.onEvent((e) => lifecycleEvents.push(e));
    const workflowId = await orchestrator.start(defPath, 'Test task');
    await waitForCompletion(orchestrator, workflowId);

    expect(callCount).toBe(2);

    const failEvents = lifecycleEvents.filter((e) => e.kind === 'failed');
    expect(failEvents.length).toBeGreaterThanOrEqual(1);
    const errorMsg = failEvents[0].error ?? '';
    expect(errorMsg).toContain('no-vuln');
    expect(errorMsg).toContain('did not include a status block');
  });

  it('passes valid verdicts through without re-prompting', async () => {
    let callCount = 0;

    const deps = createDeps(tmpDir, {
      createSession: vi.fn(async () => {
        return new MockSession({
          responses: () => {
            callCount++;
            const workflowDir = findWorkflowDir(tmpDir);

            if (callCount === 1) {
              // analyze state: valid verdict
              simulateArtifacts(workflowDir, ['analysis']);
              return verdictResponse('implement', 'needs implementation');
            }
            // implement state: unconditional, any verdict works
            simulateArtifacts(workflowDir, ['code']);
            return verdictResponse('done', 'code written');
          },
        });
      }),
    });

    const defPath = writeDefinitionFile(tmpDir, whenRoutedDef);
    const orchestrator = new WorkflowOrchestrator(deps);
    const workflowId = await orchestrator.start(defPath, 'Test task');
    await waitForCompletion(orchestrator, workflowId);

    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('completed');

    // Only 2 calls: analyze + implement (no re-prompts)
    expect(callCount).toBe(2);
  });

  it('skips validation for states with unconditional transitions', async () => {
    let callCount = 0;

    const deps = createDeps(tmpDir, {
      createSession: vi.fn(async () => {
        return new MockSession({
          responses: () => {
            callCount++;
            const workflowDir = findWorkflowDir(tmpDir);
            simulateArtifacts(workflowDir, ['result']);
            // Return an unusual verdict -- should still work
            return verdictResponse('banana', 'quirky verdict');
          },
        });
      }),
    });

    const defPath = writeDefinitionFile(tmpDir, unconditionalDef);
    const orchestrator = new WorkflowOrchestrator(deps);
    const workflowId = await orchestrator.start(defPath, 'Test task');
    await waitForCompletion(orchestrator, workflowId);

    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('completed');

    // Only 1 call, no re-prompt
    expect(callCount).toBe(1);
  });

  it('validates verdicts in mixed when + guard states', async () => {
    const sentMessages: string[] = [];
    let callCount = 0;

    const deps = createDeps(tmpDir, {
      createSession: vi.fn(async () => {
        return new MockSession({
          responses: (msg: string) => {
            sentMessages.push(msg);
            callCount++;
            const workflowDir = findWorkflowDir(tmpDir);

            if (callCount === 1) {
              // First call: invalid verdict
              simulateArtifacts(workflowDir, ['reviews']);
              return verdictResponse('maybe', 'not sure');
            }
            if (callCount === 2) {
              // Re-prompt: valid verdict
              return verdictResponse('approved', 'looks good');
            }
            return verdictResponse('approved');
          },
        });
      }),
    });

    const defPath = writeDefinitionFile(tmpDir, mixedDef);
    const orchestrator = new WorkflowOrchestrator(deps);
    const workflowId = await orchestrator.start(defPath, 'Test task');
    await waitForCompletion(orchestrator, workflowId);

    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('completed');

    // Re-prompt was sent for invalid "maybe" verdict
    expect(callCount).toBeGreaterThanOrEqual(2);
    const retryMessage = sentMessages[1];
    expect(retryMessage).toContain('maybe');
    expect(retryMessage).toContain('approved');
    expect(retryMessage).toContain('rejected');
  });
});
