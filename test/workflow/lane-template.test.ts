import { describe, expect, it } from 'vitest';
import type { WorkflowContext } from '../../src/workflow/types.js';
import {
  applyLaneTemplate,
  laneScopeEvolveCurrentPath,
  templateLaneCommand,
} from '../../src/workflow/lane-template.js';

function contextWithLane(lane: number): WorkflowContext {
  return {
    taskDescription: 'task',
    lane: {
      id: lane,
      dir: `/workspace/.evolve_runs/main/current/lane_${lane}`,
      relativeDir: `.evolve_runs/main/current/lane_${lane}`,
    },
    artifacts: {},
    round: 0,
    maxRounds: 4,
    previousOutputHashes: {},
    previousTestCount: null,
    humanPrompt: null,
    reviewHistory: [],
    totalTokens: 0,
    lastError: null,
    agentConversationsByState: {},
    previousAgentOutput: null,
    previousAgentNotes: null,
    previousStateName: null,
    visitCounts: {},
  };
}

function contextWithoutLane(): WorkflowContext {
  const { lane, ...context } = contextWithLane(0);
  void lane;
  return context;
}

describe('lane-template helpers', () => {
  it('renders lane prompt placeholders and lane-scopes evolve current paths', () => {
    const context = contextWithLane(2);

    expect(applyLaneTemplate('Read {laneDir}/context.json for lane {laneId}', context)).toBe(
      'Read /workspace/.evolve_runs/main/current/lane_2/context.json for lane 2',
    );
    expect(laneScopeEvolveCurrentPath('.evolve_runs/main/current/result.json', context)).toBe(
      '.evolve_runs/main/current/lane_2/result.json',
    );
    expect(laneScopeEvolveCurrentPath('.evolve_runs/main/current/lane_${laneId}/result.json', context)).toBe(
      '.evolve_runs/main/current/lane_2/result.json',
    );
    expect(
      templateLaneCommand(
        [
          '/opt/workflow-venv/bin/python',
          '/workflow-scripts/evolve_result.py',
          'evaluate',
          '--run-dir',
          '/workspace/.evolve_runs/main',
          '--step-from-current',
          '--result-file',
          '/workspace/.evolve_runs/main/current/result.json',
        ],
        context,
      ),
    ).toEqual([
      '/opt/workflow-venv/bin/python',
      '/workflow-scripts/evolve_result.py',
      'evaluate',
      '--lane',
      '2',
      '--run-dir',
      '/workspace/.evolve_runs/main',
      '--step-from-current',
      '--result-file',
      '/workspace/.evolve_runs/main/current/lane_2/result.json',
    ]);
  });

  it('renders the legacy bare current directory when no lane is active', () => {
    const context = contextWithoutLane();

    expect(applyLaneTemplate('Read {laneDir}/context.json', context)).toBe(
      'Read /workspace/.evolve_runs/main/current/context.json',
    );
    expect(laneScopeEvolveCurrentPath('.evolve_runs/main/current/result.json', context)).toBe(
      '.evolve_runs/main/current/result.json',
    );
  });
});
