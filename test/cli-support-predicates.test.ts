/**
 * Tests for shared predicates exported from `src/workflow/cli-support.ts`.
 * These cover the four checkpoint generations documented on
 * `isCheckpointResumable` — mid-run, terminal completed, terminal
 * non-completed, and legacy retained checkpoints without `finalStatus`.
 */

import { describe, it, expect } from 'vitest';
import { isCheckpointResumable } from '../src/workflow/cli-support.js';
import type { WorkflowCheckpoint, WorkflowStatus } from '../src/workflow/types.js';

function makeCheckpoint(finalStatus?: WorkflowStatus): WorkflowCheckpoint {
  return {
    machineState: 'coding',
    context: {
      taskDescription: 'test',
      artifacts: {},
      round: 1,
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
    },
    timestamp: new Date().toISOString(),
    transitionHistory: [],
    definitionPath: '/tmp/workflow.json',
    finalStatus,
  };
}

describe('isCheckpointResumable', () => {
  it('returns true for a mid-run checkpoint (no finalStatus)', () => {
    const cp = makeCheckpoint(undefined);
    expect(isCheckpointResumable(cp)).toBe(true);
  });

  it('returns false for a terminal completed checkpoint', () => {
    const cp = makeCheckpoint({
      phase: 'completed',
      result: { finalArtifacts: {} },
    });
    expect(isCheckpointResumable(cp)).toBe(false);
  });

  it('returns true for a terminal aborted checkpoint', () => {
    const cp = makeCheckpoint({
      phase: 'aborted',
      reason: 'user abort',
    });
    expect(isCheckpointResumable(cp)).toBe(true);
  });

  it('returns true for a terminal failed checkpoint', () => {
    const cp = makeCheckpoint({
      phase: 'failed',
      error: 'agent crashed',
      lastState: 'implement',
    });
    expect(isCheckpointResumable(cp)).toBe(true);
  });
});
