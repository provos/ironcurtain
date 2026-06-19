import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REAL_TMP, testCompiledPolicy, testToolAnnotations } from '../fixtures/test-policy.js';
import { isDockerAvailable, isDockerImageAvailable } from '../helpers/docker-available.js';
import type { IronCurtainConfig } from '../../src/config/types.js';
import {
  createDockerInfrastructure,
  destroyDockerInfrastructure,
  type DockerInfrastructure,
} from '../../src/docker/docker-infrastructure.js';
import {
  WorkflowOrchestrator,
  type CreateWorkflowInfrastructureInput,
  type WorkflowLifecycleEvent,
} from '../../src/workflow/orchestrator.js';
import { FileCheckpointStore } from '../../src/workflow/checkpoint.js';
import type { SessionOptions } from '../../src/session/types.js';
import type { WorkflowId } from '../../src/workflow/types.js';
import {
  approvedResponse,
  createDeps,
  MockSession,
  statusBlock,
  waitForCompletion,
  waitForGate,
} from './test-helpers.js';

const IMAGE = 'ironcurtain-claude-code:latest';
const TEST_HOME = `${REAL_TMP}/ironcurtain-evolve-correctness-${process.pid}`;
const TASK = 'evolve a tiny deterministic score function until a stop signal fires';

interface NodesFile {
  readonly next_id: number;
  readonly nodes: Record<string, { id: number; score: number; meta_info?: { step_name?: string } }>;
}

function findHostCaDir(): string | null {
  const home = process.env.IRONCURTAIN_HOME ?? join(homedir(), '.ironcurtain');
  const ca = join(home, 'ca');
  return existsSync(ca) ? ca : null;
}

const hostCaDir = findHostCaDir();
const dockerReady =
  process.env.INTEGRATION_TEST === '1' && isDockerAvailable() && isDockerImageAvailable(IMAGE) && hostCaDir !== null;

function buildDockerSessionConfig(workspaceDir: string, generatedDir: string): IronCurtainConfig {
  return {
    auditLogPath: join(workspaceDir, 'audit.jsonl'),
    allowedDirectory: workspaceDir,
    mcpServers: {},
    protectedPaths: [],
    generatedDir,
    constitutionPath: join(generatedDir, 'constitution.md'),
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: 'test-fake-key-no-network',
      googleApiKey: '',
      openaiApiKey: '',
      escalationTimeoutSeconds: 300,
      resourceBudget: {
        maxTotalTokens: 1_000_000,
        maxSteps: 300,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      autoCompact: {
        enabled: false,
        thresholdTokens: 80_000,
        keepRecentMessages: 10,
        summaryModelId: 'anthropic:claude-haiku-4-5',
      },
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: false },
      memory: { enabled: false, llmBaseUrl: undefined, llmApiKey: undefined },
      packageInstall: {
        enabled: true,
        quarantineDays: 2,
        allowedPackages: ['numpy', 'pyyaml'],
        deniedPackages: [],
      },
      serverCredentials: {},
      dockerResources: { memoryMb: null, cpus: null },
    },
  } as unknown as IronCurtainConfig;
}

function writeRunSpec(workspacePath: string, opts: { criterion: string; maxRounds: number; patience: number }): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  mkdirSync(resolve(runDir, 'steps'), { recursive: true });
  mkdirSync(resolve(runDir, 'database_data'), { recursive: true });
  mkdirSync(resolve(runDir, 'cognition_data'), { recursive: true });
  mkdirSync(resolve(runDir, 'best'), { recursive: true });
  writeFileSync(resolve(runDir, 'round_log.jsonl'), '');
  const evaluationCommand = [
    "python3 -c '",
    'import json;',
    'ns={{}};',
    'exec(open({quoted_code_path}).read(), ns);',
    'value=float(ns["score"]());',
    'json.dump({{"eval_score": value, "valid": True}}, open({quoted_results_path}, "w"))',
    "'",
  ].join('');
  const runSpec = {
    objective: TASK,
    evaluation: {
      core_score: 'eval_score',
      secondary_metrics: [],
      command: evaluationCommand,
      script_path: '',
      timeout_secs: 30,
      success_criteria: [opts.criterion],
    },
    budget: { max_rounds: opts.maxRounds, patience: opts.patience },
    stop_conditions: ['max_rounds'],
    mutation_scope: {
      writable_paths: ['.evolve_runs'],
      primary_targets: ['candidate.py'],
    },
    sampling: {
      algorithm: 'greedy',
      sample_n: 1,
      feature_dimensions: [],
      feature_bins: 0,
      custom_sampler_path: '',
      custom_sampler_class: '',
    },
    cognition: { source_mode: 'seed', seed_files: [], seed_notes: [] },
    approval: { confirmed: true },
  };
  writeFileSync(resolve(runDir, 'run_spec.yaml'), JSON.stringify(runSpec, null, 2) + '\n');
  writeFileSync(
    resolve(runDir, 'cognition_seed.md'),
    [
      '```json',
      '[{"content":"Write score() as a deterministic numeric function.","source":"test","metadata":{"kind":"heuristic"}}]',
      '```',
      '',
    ].join('\n'),
  );
  mkdirSync(resolve(workspacePath, '.workflow', 'run_spec'), { recursive: true });
  mkdirSync(resolve(workspacePath, '.workflow', 'cognition_seed'), { recursive: true });
  writeFileSync(
    resolve(workspacePath, '.workflow', 'run_spec', 'run_spec.md'),
    JSON.stringify(runSpec, null, 2) + '\n',
  );
  writeFileSync(resolve(workspacePath, '.workflow', 'cognition_seed', 'cognition_seed.md'), 'seed\n');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

function routeFromStopSignals(workspacePath: string): string {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  const stopSignals = resolve(runDir, 'current', 'stop_signals.json');
  if (existsSync(stopSignals)) {
    const stop = readJson(stopSignals) as { stop_reason?: string | null };
    if (stop.stop_reason) return 'complete';
  }
  if (existsSync(resolve(runDir, 'current', 'analysis_record.json'))) return 'design';
  if (existsSync(resolve(runDir, 'current', 'analysis.md'))) return 'record';
  if (existsSync(resolve(runDir, 'current', 'result.json'))) return 'analyze';
  if (existsSync(resolve(runDir, 'current', 'context.json'))) return 'evaluate';
  return 'design';
}

function writeCandidate(workspacePath: string, score: number): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  const context = readJson(resolve(runDir, 'current', 'context.json')) as { step_name: string };
  const stepDir = resolve(runDir, 'steps', context.step_name);
  mkdirSync(stepDir, { recursive: true });
  writeFileSync(resolve(stepDir, 'code'), `def score():\n    return ${score}\n`);
}

function writeAnalysis(workspacePath: string, turn: number): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  mkdirSync(resolve(runDir, 'current'), { recursive: true });
  writeFileSync(resolve(runDir, 'current', 'analysis.md'), `Round ${turn} lesson.\n`);
}

function writeFinalReport(workspacePath: string): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  const signals = readJson(resolve(runDir, 'current', 'stop_signals.json')) as { stop_reason?: string };
  const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as NodesFile;
  const report = [
    '# Final Evolve Report',
    '',
    `Objective: ${TASK}`,
    `Rounds: ${Object.keys(nodes.nodes).length}`,
    `Stop reason: ${signals.stop_reason ?? 'unknown'}`,
    '',
  ].join('\n');
  writeFileSync(resolve(runDir, 'final_report.md'), report);
  mkdirSync(resolve(workspacePath, '.workflow', 'final_report'), { recursive: true });
  writeFileSync(resolve(workspacePath, '.workflow', 'final_report', 'final_report.md'), report);
}

function countStates(states: readonly string[], state: string): number {
  return states.filter((s) => s === state).length;
}

describe.skipIf(!dockerReady)('evolve correctness stop signals with real Docker container', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalAuth: string | undefined;
  let originalApiKey: string | undefined;
  const liveBundles = new Set<DockerInfrastructure>();

  beforeAll(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    originalAuth = process.env.IRONCURTAIN_DOCKER_AUTH;
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.IRONCURTAIN_HOME = TEST_HOME;
    process.env.IRONCURTAIN_DOCKER_AUTH = 'apikey';
    process.env.ANTHROPIC_API_KEY = 'test-fake-key-no-network';
    mkdirSync(TEST_HOME, { recursive: true });
    cpSync(hostCaDir as string, join(TEST_HOME, 'ca'), { recursive: true });
  });

  afterAll(async () => {
    for (const bundle of liveBundles) {
      await destroyDockerInfrastructure(bundle).catch(() => {});
    }
    liveBundles.clear();
    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    if (originalAuth === undefined) delete process.env.IRONCURTAIN_DOCKER_AUTH;
    else process.env.IRONCURTAIN_DOCKER_AUTH = originalAuth;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'evolve-correctness-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createInfrastructureFactory(generatedDir: string) {
    return vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      const config = buildDockerSessionConfig(input.workspacePath, generatedDir);
      const bundleDir = resolve(TEST_HOME, 'bundles', input.bundleId);
      const escalationDir = resolve(bundleDir, 'escalations');
      mkdirSync(bundleDir, { recursive: true });
      mkdirSync(escalationDir, { recursive: true });
      const bundle = await createDockerInfrastructure(
        config,
        { kind: 'docker', agent: 'claude-code' },
        bundleDir,
        input.workspacePath,
        escalationDir,
        input.bundleId,
        input.workflowId,
        input.scope,
        input.resolvedSkills,
        undefined,
        input.workflowScriptsDir,
      );
      liveBundles.add(bundle);
      return bundle;
    });
  }

  async function runUntilStop(
    label: string,
    opts: {
      scores: readonly number[];
      criterion: string;
      maxRounds: number;
      patience: number;
      extendWith?: string;
    },
  ) {
    const runDir = resolve(tmpDir, `run-${label}`);
    const workspaceDir = resolve(tmpDir, `workspace-${label}`);
    const generatedDir = resolve(TEST_HOME, `generated-${label}`);
    mkdirSync(runDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(resolve(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));

    let preflightTurns = 0;
    let researcherTurns = 0;
    let analyzerTurns = 0;
    let finalSummaryTurns = 0;
    const createSession = vi.fn(async (options: SessionOptions) => {
      const workspacePath = options.workspacePath;
      if (!workspacePath) throw new Error('workflow agent session missing workspacePath');
      return new MockSession({
        responses: (msg: string) => {
          if (msg.includes('provisioning the Python environment')) {
            mkdirSync(resolve(workspacePath, '.evolve_runs', 'main'), { recursive: true });
            writeFileSync(resolve(workspacePath, '.evolve_runs', 'main', '.provisioned'), 'numpy\npyyaml\n');
            return statusBlock('ready', 'provision confirmed');
          }
          if (msg.includes('configuring a multi-round Evolve experiment')) {
            preflightTurns += 1;
            writeRunSpec(workspacePath, opts);
            return statusBlock('ready', 'preflight confirmed');
          }
          if (msg.includes('You are the Evolve orchestrator')) {
            // A live human "run N more rounds" directive overrides a now-stale stop
            // signal — route `design` for the extension round. The directive is only
            // present on the first orchestrator turn after FORCE_REVISION (it resets
            // after one turn); thereafter the router falls back to the stop signal,
            // which `sample` must have cleared, or the extension re-stops prematurely.
            if (opts.extendWith && msg.includes(opts.extendWith)) {
              return statusBlock('design', 'human extension directive');
            }
            return statusBlock(routeFromStopSignals(workspacePath), 'router inspected stop signals');
          }
          if (msg.includes('Write exactly one candidate program for this round')) {
            const score = opts.scores[Math.min(researcherTurns, opts.scores.length - 1)];
            researcherTurns += 1;
            writeCandidate(workspacePath, score);
            return approvedResponse(`candidate ${researcherTurns}`);
          }
          if (msg.includes('write a SHORT transferable lesson')) {
            analyzerTurns += 1;
            writeAnalysis(workspacePath, analyzerTurns);
            return approvedResponse(`analysis ${analyzerTurns}`);
          }
          if (msg.includes('The Evolve run has reached a stop condition')) {
            finalSummaryTurns += 1;
            writeFinalReport(workspacePath);
            return approvedResponse('final report');
          }
          throw new Error(`unexpected agent prompt: ${msg.slice(0, 200)}`);
        },
      });
    });
    const raiseGate = vi.fn();
    const destroyInfra = vi.fn(async (bundle: DockerInfrastructure) => {
      liveBundles.delete(bundle);
      await destroyDockerInfrastructure(bundle);
    });
    const orchestrator = new WorkflowOrchestrator(
      createDeps(runDir, {
        createSession,
        createWorkflowInfrastructure: createInfrastructureFactory(generatedDir),
        destroyWorkflowInfrastructure: destroyInfra,
        raiseGate,
      }),
    );
    const states: string[] = [];
    orchestrator.onEvent((event: WorkflowLifecycleEvent) => {
      if (event.kind === 'state_entered') states.push(event.state);
    });

    const workflowId = await orchestrator.start(
      resolve(process.cwd(), 'src', 'workflow', 'workflows', 'evolve', 'workflow.yaml'),
      TASK,
      workspaceDir,
    );
    const firstGate = await waitForGate(raiseGate, 1, 180_000);
    expect(firstGate[0].stateName).toBe('preflight_review');
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });
    const gates = await waitForGate(raiseGate, 2, 180_000);
    expect(gates[1].stateName).toBe('final_review');
    if (opts.extendWith) {
      // Force one more round past the early stop. The extension must record an
      // extra node rather than re-stop on the stale stop_signals.json.
      orchestrator.resolveGate(workflowId, { type: 'FORCE_REVISION', prompt: opts.extendWith });
      const moreGates = await waitForGate(raiseGate, 3, 180_000);
      expect(moreGates[2].stateName).toBe('final_review');
    }
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator, workflowId, 180_000);
    await orchestrator.shutdownAll();

    expect(preflightTurns).toBe(1);
    expect(finalSummaryTurns).toBe(opts.extendWith ? 2 : 1);
    return { states, workspaceDir, researcherTurns, analyzerTurns };
  }

  it('stops early when the target score is reached', async () => {
    const run = await runUntilStop('target', {
      scores: [1, 3],
      criterion: 'eval_score >= 3',
      maxRounds: 5,
      patience: 4,
    });
    const runDir = resolve(run.workspaceDir, '.evolve_runs', 'main');
    const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as NodesFile;
    const signals = readJson(resolve(runDir, 'current', 'stop_signals.json')) as { stop_reason: string };

    expect(run.states.at(-1)).toBe('done');
    expect(Object.keys(nodes.nodes)).toEqual(['0', '1']);
    expect(signals.stop_reason).toBe('target_met');
    expect(countStates(run.states, 'analysis_record')).toBe(2);
    expect(run.researcherTurns).toBe(2);
    expect(run.analyzerTurns).toBe(2);
  }, 300_000);

  it('stops early when patience is exhausted', async () => {
    const run = await runUntilStop('patience', {
      scores: [1, 2, 2, 2],
      criterion: 'eval_score >= 99',
      maxRounds: 6,
      patience: 2,
    });
    const runDir = resolve(run.workspaceDir, '.evolve_runs', 'main');
    const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as NodesFile;
    const signals = readJson(resolve(runDir, 'current', 'stop_signals.json')) as {
      stop_reason: string;
      rounds_since_improvement: number;
    };

    expect(run.states.at(-1)).toBe('done');
    expect(Object.keys(nodes.nodes)).toEqual(['0', '1', '2', '3']);
    expect(signals.stop_reason).toBe('patience');
    expect(signals.rounds_since_improvement).toBe(2);
    expect(countStates(run.states, 'analysis_record')).toBe(4);
  }, 300_000);

  it('resumes analysis_record without duplicating an already-recorded node', async () => {
    const runDir = resolve(tmpDir, 'run-resume');
    const workflowId = 'resume-analysis-record' as WorkflowId;
    const workspaceDir = resolve(runDir, workflowId, 'workspace');
    const generatedDir = resolve(TEST_HOME, 'generated-resume');
    const runStateDir = resolve(workspaceDir, '.evolve_runs', 'main');
    mkdirSync(generatedDir, { recursive: true });
    mkdirSync(resolve(runDir, workflowId), { recursive: true });
    mkdirSync(resolve(runStateDir, 'current'), { recursive: true });
    mkdirSync(resolve(runStateDir, 'steps', 'step_0001'), { recursive: true });
    mkdirSync(resolve(runStateDir, 'database_data'), { recursive: true });
    writeFileSync(resolve(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));
    writeRunSpec(workspaceDir, { criterion: 'eval_score >= 1', maxRounds: 5, patience: 2 });
    writeFileSync(resolve(runStateDir, 'current', 'step_name'), 'step_0001\n');
    writeFileSync(
      resolve(runStateDir, 'current', 'context.json'),
      JSON.stringify({ step_name: 'step_0001', parents: [] }),
    );
    writeFileSync(
      resolve(runStateDir, 'current', 'result.json'),
      JSON.stringify({ verdict: 'evaluated', payload: { score: 1 } }),
    );
    writeFileSync(resolve(runStateDir, 'current', 'analysis.md'), 'resume lesson\n');
    writeFileSync(resolve(runStateDir, 'steps', 'step_0001', 'code'), 'def score():\n    return 1\n');
    writeFileSync(resolve(runStateDir, 'steps', 'step_0001', 'results.json'), JSON.stringify({ eval_score: 1 }) + '\n');
    writeFileSync(
      resolve(runStateDir, 'database_data', 'nodes.json'),
      JSON.stringify({
        next_id: 1,
        nodes: {
          '0': {
            id: 0,
            name: 'round-1',
            parent: [],
            score: 1,
            results: { eval_score: 1 },
            analysis: 'resume lesson',
            meta_info: { step_name: 'step_0001' },
          },
        },
      }) + '\n',
    );

    const checkpointStore = new FileCheckpointStore(runDir);
    checkpointStore.save(workflowId, {
      machineState: 'analysis_record',
      context: {
        taskDescription: TASK,
        artifacts: {},
        round: 0,
        maxRounds: 200,
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
        visitCounts: { analysis_record: 1 },
      },
      timestamp: new Date().toISOString(),
      transitionHistory: [],
      definitionPath: resolve(process.cwd(), 'src', 'workflow', 'workflows', 'evolve', 'workflow.yaml'),
      workspacePath: workspaceDir,
    });

    let finalSummaryTurns = 0;
    const createSession = vi.fn(async (options: SessionOptions) => {
      const workspacePath = options.workspacePath;
      if (!workspacePath) throw new Error('workflow agent session missing workspacePath');
      return new MockSession({
        responses: (msg: string) => {
          if (msg.includes('You are the Evolve orchestrator')) {
            return statusBlock(routeFromStopSignals(workspacePath), 'resume router inspected stop signals');
          }
          if (msg.includes('The Evolve run has reached a stop condition')) {
            finalSummaryTurns += 1;
            writeFinalReport(workspacePath);
            return approvedResponse('final report');
          }
          throw new Error(`unexpected resumed prompt: ${msg.slice(0, 200)}`);
        },
      });
    });
    const raiseGate = vi.fn();
    const destroyInfra = vi.fn(async (bundle: DockerInfrastructure) => {
      liveBundles.delete(bundle);
      await destroyDockerInfrastructure(bundle);
    });
    const orchestrator = new WorkflowOrchestrator(
      createDeps(runDir, {
        createSession,
        createWorkflowInfrastructure: createInfrastructureFactory(generatedDir),
        destroyWorkflowInfrastructure: destroyInfra,
        raiseGate,
        checkpointStore,
      }),
    );
    await orchestrator.resume(workflowId);
    const gates = await waitForGate(raiseGate, 1, 180_000);
    expect(gates[0].stateName).toBe('final_review');
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator, workflowId, 180_000);
    await orchestrator.shutdownAll();

    const nodes = readJson(resolve(runStateDir, 'database_data', 'nodes.json')) as NodesFile;
    const record = readJson(resolve(runStateDir, 'current', 'analysis_record.json')) as {
      payload: { node_id: number; idempotent_skip: boolean };
    };
    expect(Object.keys(nodes.nodes)).toEqual(['0']);
    expect(nodes.next_id).toBe(1);
    expect(record.payload).toMatchObject({ node_id: 0, idempotent_skip: true });
    expect(finalSummaryTurns).toBe(1);
  }, 300_000);

  it('continues a human extension past an early stop instead of re-stopping on a stale signal', async () => {
    // Target met at node 1 → the run stops at 2 nodes; a human FORCE_REVISION at
    // final_review then asks for one more round. The extension MUST record node 2
    // (3 nodes). Without `sample` clearing the stale stop_signals.json, the
    // orchestrator re-stops on the round-2 target_met signal and node 2 never records.
    const run = await runUntilStop('extend', {
      scores: [1, 3, 3],
      criterion: 'eval_score >= 3',
      maxRounds: 5,
      patience: 5,
      extendWith: 'run one more evolution round',
    });
    const runDir = resolve(run.workspaceDir, '.evolve_runs', 'main');
    const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as NodesFile;
    expect(Object.keys(nodes.nodes)).toEqual(['0', '1', '2']);
    expect(run.states.at(-1)).toBe('done');
  }, 300_000);
});
