import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveWorkflowResourceBudget, legacyWorkflowBudget } from '../src/workflow/resource-budget.js';
import { validateDefinition } from '../src/workflow/validate.js';
import { WorkflowOrchestrator } from '../src/workflow/orchestrator.js';
import { FileCheckpointStore } from '../src/workflow/checkpoint.js';
import type { WorkflowDefinition } from '../src/workflow/types.js';
import type { SessionOptions } from '../src/session/types.js';
import { configDispatch } from '../src/web-ui/dispatch/config-dispatch.js';
import { workflowDispatch, type WorkflowDispatchContext } from '../src/web-ui/dispatch/workflow-dispatch.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import { USER_CONFIG_DEFAULTS } from '../src/config/user-config.js';
import {
  setupConfigEnv,
  teardownConfigEnv,
  seedConfig,
  readConfig,
  type ConfigTestEnv,
} from './helpers/config-test-setup.js';
import { MockSession, approvedResponse, createDeps, writeDefinitionFile } from './workflow/test-helpers.js';

const definition: WorkflowDefinition = {
  name: 'budget-test',
  description: 'Budget settings',
  initial: 'agent',
  settings: { mode: 'builtin' },
  states: {
    agent: {
      type: 'agent',
      description: 'Agent',
      persona: 'global',
      prompt: 'Work',
      inputs: [],
      outputs: [],
      transitions: [{ to: 'gate' }],
    },
    gate: {
      type: 'human_gate',
      description: 'Review',
      present: [],
      acceptedEvents: ['APPROVE'],
      transitions: [{ to: 'done', event: 'APPROVE' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

let env: ConfigTestEnv;
beforeEach(() => {
  env = setupConfigEnv('workflow-resource-budget');
});
afterEach(() => {
  teardownConfigEnv(env);
});

describe('workflow resource budget validation and resolution', () => {
  it('inherits only omitted fields and preserves numeric and disabled overrides', () => {
    const budget = resolveWorkflowResourceBudget(
      { resourceBudget: { maxEstimatedCostUsd: null, maxSteps: 12 } },
      { maxEstimatedCostUsd: 8, maxTotalTokens: 40 },
    );
    expect(budget.limits).toEqual({
      ...USER_CONFIG_DEFAULTS.resourceBudget,
      maxEstimatedCostUsd: null,
      maxSteps: 12,
      maxTotalTokens: 40,
    });
    expect(budget.sources).toEqual({
      maxEstimatedCostUsd: 'workflow',
      maxSteps: 'workflow',
      maxTotalTokens: 'global',
      maxSessionSeconds: 'default',
      warnThresholdPercent: 'default',
    });
  });

  it('accepts null for every limit including the legacy timeout alias', () => {
    const settings = {
      maxSessionSeconds: null,
      resourceBudget: { maxSteps: null, maxTotalTokens: null, maxEstimatedCostUsd: null },
    };
    expect(validateDefinition({ ...definition, settings }).settings).toEqual(settings);
    expect(resolveWorkflowResourceBudget(settings, {}).limits).toEqual({
      maxSteps: null,
      maxTotalTokens: null,
      maxEstimatedCostUsd: null,
      maxSessionSeconds: null,
      warnThresholdPercent: 80,
    });
  });

  it.each([
    { resourceBudget: { unknownLimit: 10 } },
    { resourceBudget: { maxSteps: 1.5 } },
    { resourceBudget: { maxTotalTokens: 0 } },
    { resourceBudget: { warnThresholdPercent: null } },
    { resourceBudget: { maxEstimatedCostUsd: -1 } },
    { maxSessionSeconds: 30, resourceBudget: { maxSessionSeconds: null } },
  ])('rejects invalid overrides %j', (settings) => {
    expect(() => validateDefinition({ ...definition, settings })).toThrow();
  });

  it('accepts matching timeout aliases and reports their workflow provenance', () => {
    const settings = { maxSessionSeconds: 30, resourceBudget: { maxSessionSeconds: 30 } };
    expect(() => validateDefinition({ ...definition, settings })).not.toThrow();
    expect(resolveWorkflowResourceBudget(settings, {}).sources.maxSessionSeconds).toBe('workflow');
  });

  it('marks legacy limits as current fallback and leaves usage unavailable', () => {
    seedConfig(env.testHome, { resourceBudget: { maxEstimatedCostUsd: 9 } });
    expect(legacyWorkflowBudget()).toMatchObject({
      recorded: false,
      limits: { maxEstimatedCostUsd: 9 },
      sources: { maxEstimatedCostUsd: 'global' },
    });
    expect(legacyWorkflowBudget().usage).toBeUndefined();
  });
});

describe('resource budget config APIs', () => {
  function context(allowPolicyMutation = false): WorkflowDispatchContext {
    return { allowPolicyMutation, eventBus: new WebEventBus() } as WorkflowDispatchContext;
  }

  it('reads defaults without creating config and saves only its own section with a change event', async () => {
    const ctx = context(true);
    const emit = vi.spyOn(ctx.eventBus, 'emit');
    expect(await configDispatch(ctx, 'config.getResourceBudget', {})).toEqual(USER_CONFIG_DEFAULTS.resourceBudget);
    seedConfig(env.testHome, {
      agentModelId: 'test-model',
      futureField: { untouched: true },
      resourceBudget: { maxSteps: 20 },
    });
    const limits = { ...USER_CONFIG_DEFAULTS.resourceBudget, maxEstimatedCostUsd: null, maxSteps: 55 };
    expect(await configDispatch(ctx, 'config.setResourceBudget', limits)).toEqual(limits);
    expect(readConfig(env.testHome)).toMatchObject({
      agentModelId: 'test-model',
      futureField: { untouched: true },
      resourceBudget: limits,
    });
    expect(emit).toHaveBeenCalledWith('config.changed', {});
  });

  it('rejects mutation before touching config and requires a complete strict DTO', async () => {
    seedConfig(env.testHome, { resourceBudget: { maxSteps: 20 } });
    const prior = readFileSync(resolve(env.testHome, 'config.json'), 'utf8');
    await expect(
      configDispatch(context(), 'config.setResourceBudget', USER_CONFIG_DEFAULTS.resourceBudget),
    ).rejects.toMatchObject({ code: 'POLICY_MUTATION_FORBIDDEN' });
    await expect(configDispatch(context(true), 'config.setResourceBudget', { maxSteps: 99 })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(
      configDispatch(context(true), 'config.setResourceBudget', { ...USER_CONFIG_DEFAULTS.resourceBudget, typo: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(readFileSync(resolve(env.testHome, 'config.json'), 'utf8')).toBe(prior);
  });

  it('previews discovered definitions without a manager and rejects arbitrary paths', async () => {
    const definitions = (await workflowDispatch(context(), 'workflows.listDefinitions', {})) as { path: string }[];
    const result = await workflowDispatch(context(), 'workflows.getBudgetPreview', {
      definitionPath: definitions[0].path,
    });
    expect(result).toMatchObject({ recorded: true, limits: { warnThresholdPercent: 80 } });
    await expect(
      workflowDispatch(context(), 'workflows.getBudgetPreview', { definitionPath: '/etc/passwd' }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_NOT_FOUND' });
  });

  it('preserves corrupt existing config instead of replacing unrelated settings', async () => {
    const path = resolve(env.testHome, 'config.json');
    writeFileSync(path, '{bad json');
    await expect(
      configDispatch(context(true), 'config.setResourceBudget', USER_CONFIG_DEFAULTS.resourceBudget),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(readFileSync(path, 'utf8')).toBe('{bad json');
  });
});

describe('workflow budget reads', () => {
  it.each([1, 3])('samples %i active sessions and preserves usage on abort', async (sessionCount) => {
    const sessions: MockSession[] = [];
    const baseDir = resolve(env.testHome, 'runs');
    const store = new FileCheckpointStore(baseDir);
    const orchestrator = new WorkflowOrchestrator(
      createDeps(baseDir, {
        checkpointStore: store,
        createSession: async () => {
          const session = new MockSession({ responses: async () => new Promise<never>(() => {}) });
          const status = session.getBudgetStatus();
          const index = sessions.length + 1;
          vi.spyOn(session, 'getBudgetStatus').mockReturnValue({
            ...status,
            cumulative: {
              totalInputTokens: 100 * index,
              totalOutputTokens: 0,
              totalTokens: 100 * index,
              stepCount: index,
              estimatedCostUsd: index,
              activeSeconds: 0,
            },
            tokenTrackingAvailable: true,
          });
          sessions.push(session);
          return session;
        },
      }),
    );
    const getDetail = vi.spyOn(orchestrator, 'getDetail').mockImplementation(() => {
      throw new Error('Budget polling must not read workflow detail');
    });
    const parallelDefinition: WorkflowDefinition = {
      ...definition,
      initial: 'workers',
      states: {
        ...definition.states,
        workers: {
          type: 'deterministic',
          description: 'Fan out',
          run: [],
          fanOut: { count: sessionCount, join: 'barrier' },
          segment: ['agent'],
          transitions: [{ to: 'gate' }],
        },
        agent: { ...definition.states.agent, fanOutMember: true } as WorkflowDefinition['states'][string],
      },
    };
    const id = await orchestrator.start(writeDefinitionFile(env.testHome, parallelDefinition), 'Task');
    try {
      await vi.waitFor(() =>
        expect(orchestrator.getBudget(id)?.activeSessionCount, JSON.stringify(orchestrator.getStatus(id))).toBe(
          sessionCount,
        ),
      );
      const ctx = { workflowManager: { getOrchestrator: () => orchestrator } } as unknown as WorkflowDispatchContext;
      expect(await workflowDispatch(ctx, 'workflows.getBudget', { workflowId: id })).toMatchObject({
        activeSessionCount: sessionCount,
        usage: { totalTokens: 100, estimatedCostUsd: 1, stepCount: 1 },
      });
      expect(getDetail).not.toHaveBeenCalled();
      expect(orchestrator.getBudget('missing' as typeof id)).toBeUndefined();
    } finally {
      await orchestrator.abort(id);
    }
    const stoppedBudget = {
      activeSessionCount: 0,
      usage: { totalTokens: 100, estimatedCostUsd: 1, stepCount: 1 },
    };
    expect(orchestrator.getBudget(id)).toMatchObject(stoppedBudget);
    expect(store.load(id)?.resourceBudget).toMatchObject(stoppedBudget);
  });

  it('returns saved run limits, marks legacy fallback, and reports missing runs', async () => {
    const budget = {
      ...resolveWorkflowResourceBudget({ resourceBudget: { maxEstimatedCostUsd: 30 } }, {}),
      activeSessionCount: 3,
      usage: { totalTokens: 100, estimatedCostUsd: 1, stepCount: 1, elapsedSeconds: 20, tokenTrackingAvailable: true },
    };
    const loadPastRun = vi.fn<() => unknown>(() => ({ definition, checkpoint: { resourceBudget: budget } }));
    const ctx = {
      workflowManager: { getOrchestrator: () => ({ getDetail: () => undefined }), loadPastRun },
    } as unknown as WorkflowDispatchContext;
    expect(await workflowDispatch(ctx, 'workflows.getBudget', { workflowId: 'run' })).toEqual({
      ...budget,
      activeSessionCount: 0,
    });
    loadPastRun.mockReturnValueOnce({ definition, checkpoint: {} });
    expect(await workflowDispatch(ctx, 'workflows.getBudget', { workflowId: 'legacy' })).toMatchObject({
      recorded: false,
      activeSessionCount: 0,
    });
    loadPastRun.mockReturnValueOnce({ error: 'not_found' });
    await expect(workflowDispatch(ctx, 'workflows.getBudget', { workflowId: 'missing' })).rejects.toMatchObject({
      code: 'WORKFLOW_NOT_FOUND',
    });
  });
});

describe('fixed workflow run budget snapshots', () => {
  it('keeps saved settings after global changes and explicitly refreshes on resume', async () => {
    seedConfig(env.testHome, { resourceBudget: { maxEstimatedCostUsd: 12, maxSteps: 90 } });
    const options: SessionOptions[] = [];
    const baseDir = resolve(env.testHome, 'runs');
    const store = new FileCheckpointStore(baseDir);
    const makeOrchestrator = () =>
      new WorkflowOrchestrator(
        createDeps(baseDir, {
          checkpointStore: store,
          createSession: async (opts) => {
            options.push(opts);
            return new MockSession({ responses: [approvedResponse()] });
          },
        }),
      );
    const first = makeOrchestrator();
    const path = writeDefinitionFile(env.testHome, {
      ...definition,
      settings: { mode: 'builtin', resourceBudget: { maxSteps: 40 } },
    });
    const id = await first.start(path, 'Task');
    await vi.waitFor(() => expect(first.getStatus(id)?.phase).toBe('waiting_human'));
    expect(store.load(id)?.resourceBudget).toMatchObject({
      recorded: true,
      limits: { maxEstimatedCostUsd: 12, maxSteps: 40 },
      sources: { maxSteps: 'workflow', maxEstimatedCostUsd: 'global' },
    });
    await first.abort(id);
    seedConfig(env.testHome, { resourceBudget: { maxEstimatedCostUsd: 25, maxSteps: 80 } });
    const resumed = makeOrchestrator();
    await resumed.resume(id);
    expect(resumed.getDetail(id)?.budget?.limits.maxEstimatedCostUsd).toBe(12);
    await resumed.abort(id);
    const refreshed = makeOrchestrator();
    await refreshed.resume(id, { useCurrentBudget: true });
    expect(refreshed.getDetail(id)?.budget).toMatchObject({
      recorded: true,
      limits: { maxEstimatedCostUsd: 25, maxSteps: 40 },
    });
    expect(options[0].resourceBudgetOverrides).toMatchObject({ maxEstimatedCostUsd: 12, maxSteps: 40 });
    expect(readFileSync(resolve(baseDir, id, 'messages.jsonl'), 'utf8')).toContain('"useCurrentBudget":true');
    await refreshed.abort(id);
  });
});
