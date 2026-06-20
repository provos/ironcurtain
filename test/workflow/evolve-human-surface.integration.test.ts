import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import type { SessionOptions } from '../../src/session/types.js';
import {
  approvedResponse,
  createDeps,
  MockSession,
  statusBlock,
  waitForCompletion,
  waitForGate,
} from './test-helpers.js';

const IMAGE = 'ironcurtain-claude-code:latest';
const TEST_HOME = `${REAL_TMP}/ironcurtain-evolve-human-surface-${process.pid}`;
const ROUND_COUNT = 3;
const TASK = 'write solve(xs) scoring higher the closer solve([1,2,3]) is to 6 over 3 rounds';

type Scenario = 'approve' | 'preflight-abort' | 'evaluator-force-revision' | 'final-force-revision';

interface EvolveNode {
  readonly id: number;
  readonly parent: readonly number[];
  readonly score: number;
  readonly analysis: string;
}

interface NodesFile {
  readonly next_id: number;
  readonly nodes: Record<string, EvolveNode>;
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
        maxSteps: 400,
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

function writePreflightRunSpec(workspacePath: string): void {
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
    's=ns["solve"]([1,2,3]);',
    'score=max(0.0, 6.0 - abs(float(s) - 6.0));',
    'json.dump({{"eval_score": score, "success": score >= 6.0}}, open({quoted_results_path}, "w"))',
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
      success_criteria: ['eval_score >= 1.0'],
    },
    budget: { max_rounds: ROUND_COUNT, patience: 2 },
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
  const seed = [
    '```json',
    '[',
    '  {',
    '    "content": "solve xs sum target evolve toward six by improving the candidate return value",',
    '    "source": "test",',
    '    "metadata": {"kind":"heuristic"}',
    '  }',
    ']',
    '```',
    '',
  ].join('\n');

  writeFileSync(resolve(runDir, 'run_spec.yaml'), JSON.stringify(runSpec, null, 2) + '\n');
  writeFileSync(resolve(runDir, 'preflight_summary.md'), '# Preflight Summary\n\n- Status: `READY`\n');
  writeFileSync(resolve(runDir, 'cognition_seed.md'), seed);

  mkdirSync(resolve(workspacePath, '.workflow', 'run_spec'), { recursive: true });
  mkdirSync(resolve(workspacePath, '.workflow', 'cognition_seed'), { recursive: true });
  writeFileSync(
    resolve(workspacePath, '.workflow', 'run_spec', 'run_spec.md'),
    JSON.stringify(runSpec, null, 2) + '\n',
  );
  writeFileSync(resolve(workspacePath, '.workflow', 'cognition_seed', 'cognition_seed.md'), seed);
}

function writeProvisionMarker(workspacePath: string): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(resolve(runDir, '.provisioned'), 'numpy\npyyaml\n');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

function writeCandidate(workspacePath: string, scenario: Scenario, researcherTurn: number): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  const context = readJson(resolve(runDir, 'current', 'context.json')) as { step_name: string };
  const stepDir = resolve(runDir, 'steps', context.step_name);
  mkdirSync(stepDir, { recursive: true });

  if (scenario === 'evaluator-force-revision' && researcherTurn === 1) {
    writeFileSync(resolve(stepDir, 'code'), 'x = 1\n');
    return;
  }

  const validTurn = scenario === 'evaluator-force-revision' ? researcherTurn - 1 : researcherTurn;
  const returnValues = [2, 5, 6, 6];
  const value = returnValues[Math.min(validTurn - 1, returnValues.length - 1)];
  writeFileSync(resolve(stepDir, 'code'), `def solve(xs):\n    return ${value}\n`);
}

function writeAnalysis(workspacePath: string, analyzerTurn: number): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  mkdirSync(resolve(runDir, 'current'), { recursive: true });
  writeFileSync(
    resolve(runDir, 'current', 'analysis.md'),
    `Round ${analyzerTurn} lesson: preserve deterministic progress toward the sum target.\n`,
  );
}

function writeFinalReport(workspacePath: string): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as NodesFile;
  const nodeList = Object.keys(nodes.nodes)
    .sort()
    .map((id) => nodes.nodes[id]);
  const best = nodeList.reduce((current, node) => (node.score > current.score ? node : current), nodeList[0]);
  const trajectory = nodeList.map((node) => `${node.id} -> ${node.score}`).join(', ');
  const report = [
    '# Final Evolve Report',
    '',
    `Objective: ${TASK}`,
    `Rounds: ${nodeList.length} / ${ROUND_COUNT}`,
    `Best node: ${best.id}, score ${best.score}`,
    `Best lesson: ${best.analysis.trim()}`,
    `Score trajectory: ${trajectory}`,
    'Recommendation: accept if the best score satisfies the evaluator, otherwise request one more round.',
    '',
  ].join('\n');
  writeFileSync(resolve(runDir, 'final_report.md'), report);
  mkdirSync(resolve(workspacePath, '.workflow', 'final_report'), { recursive: true });
  writeFileSync(resolve(workspacePath, '.workflow', 'final_report', 'final_report.md'), report);
}

function countStates(states: readonly string[], state: string): number {
  return states.filter((s) => s === state).length;
}

function nodeScores(nodes: NodesFile): number[] {
  return Object.keys(nodes.nodes)
    .sort()
    .map((id) => nodes.nodes[id].score);
}

function expectParentLineage(nodes: NodesFile): void {
  for (const [rawId, node] of Object.entries(nodes.nodes)) {
    const id = Number(rawId);
    if (id === 0) {
      expect(node.parent).toEqual([]);
      continue;
    }
    expect(node.parent.length).toBeGreaterThan(0);
    expect(node.parent[0]).toBeLessThan(id);
    expect(nodes.nodes[String(node.parent[0])]).toBeDefined();
  }
}

describe.skipIf(!dockerReady)('evolve human-surface workflow with real Docker container', () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), 'evolve-human-surface-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startScenario(scenario: Scenario): Promise<{
    orchestrator: WorkflowOrchestrator;
    workflowId: string;
    states: string[];
    workspaceDir: string;
    raiseGate: ReturnType<typeof vi.fn>;
  }> {
    const runDir = resolve(tmpDir, `run-${scenario}`);
    const workspaceDir = resolve(tmpDir, `workspace-${scenario}`);
    const generatedDir = resolve(TEST_HOME, `generated-${scenario}`);
    mkdirSync(runDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(resolve(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
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

    const destroyInfra = vi.fn(async (bundle: DockerInfrastructure) => {
      liveBundles.delete(bundle);
      await destroyDockerInfrastructure(bundle);
    });

    const scripts: Record<Scenario, string[]> = {
      approve: ['design', 'design', 'design', 'complete'],
      'preflight-abort': [],
      'evaluator-force-revision': ['design', 'design', 'design', 'design', 'complete'],
      'final-force-revision': ['design', 'design', 'design', 'complete', 'design', 'complete'],
    };

    let provisionTurns = 0;
    let preflightTurns = 0;
    let orchestratorTurns = 0;
    let researcherTurns = 0;
    let analyzerTurns = 0;
    let finalSummaryTurns = 0;
    const createSession = vi.fn(async (options: SessionOptions) => {
      const workspacePath = options.workspacePath;
      if (!workspacePath) throw new Error('workflow agent session missing workspacePath');
      return new MockSession({
        responses: (msg: string) => {
          if (msg.includes('provisioning the Python environment')) {
            provisionTurns += 1;
            writeProvisionMarker(workspacePath);
            return statusBlock('ready', `provision ${provisionTurns} confirmed`);
          }
          if (msg.includes('configuring a multi-round Evolve experiment')) {
            preflightTurns += 1;
            writePreflightRunSpec(workspacePath);
            return statusBlock('ready', `preflight ${preflightTurns} confirmed`);
          }
          if (msg.includes('You are the Evolve orchestrator')) {
            const verdict = scripts[scenario][orchestratorTurns];
            orchestratorTurns += 1;
            if (!verdict) throw new Error(`orchestrator script exhausted at turn ${orchestratorTurns}`);
            return statusBlock(verdict, `orchestrator turn ${orchestratorTurns}`);
          }
          if (msg.includes('Write exactly one candidate program for this round')) {
            researcherTurns += 1;
            writeCandidate(workspacePath, scenario, researcherTurns);
            return approvedResponse(`candidate ${researcherTurns} written`);
          }
          if (msg.includes('write a SHORT transferable lesson')) {
            analyzerTurns += 1;
            writeAnalysis(workspacePath, analyzerTurns);
            return approvedResponse(`analysis ${analyzerTurns} written`);
          }
          if (msg.includes('The Evolve run has reached a stop condition')) {
            finalSummaryTurns += 1;
            writeFinalReport(workspacePath);
            return approvedResponse(`final report ${finalSummaryTurns} written`);
          }
          throw new Error(`unexpected agent prompt: ${msg.slice(0, 200)}`);
        },
      });
    });
    const raiseGate = vi.fn();
    const orchestrator = new WorkflowOrchestrator(
      createDeps(runDir, {
        createSession,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
        raiseGate,
      }),
    );
    const states: string[] = [];
    orchestrator.onEvent((event: WorkflowLifecycleEvent) => {
      if (event.kind === 'state_entered') states.push(event.state);
    });

    const manifestPath = resolve(process.cwd(), 'src', 'workflow', 'workflows', 'evolve', 'workflow.yaml');
    const workflowId = await orchestrator.start(manifestPath, TASK, workspaceDir);
    return { orchestrator, workflowId, states, workspaceDir, raiseGate };
  }

  it('A: APPROVE reaches done through final_summary and final_review', async () => {
    const run = await startScenario('approve');
    const [preflightGate] = await waitForGate(run.raiseGate, 1, 180_000);
    expect(preflightGate.stateName).toBe('preflight_review');
    expect(preflightGate.acceptedEvents).toEqual(['APPROVE', 'FORCE_REVISION', 'ABORT']);
    expect([...preflightGate.presentedArtifacts.keys()].sort()).toEqual(['cognition_seed', 'run_spec']);
    run.orchestrator.resolveGate(run.workflowId, { type: 'APPROVE' });

    const gates = await waitForGate(run.raiseGate, 2, 180_000);
    const finalGate = gates[1];
    expect(finalGate.stateName).toBe('final_review');
    expect(finalGate.presentedArtifacts.has('final_report')).toBe(true);
    run.orchestrator.resolveGate(run.workflowId, { type: 'APPROVE' });

    await waitForCompletion(run.orchestrator, run.workflowId, 180_000);
    expect(run.orchestrator.getStatus(run.workflowId)?.phase).toBe('completed');
    await run.orchestrator.shutdownAll();

    expect(run.states.at(-1)).toBe('done');
    expect(run.states[0]).toBe('provision');
    expect(run.states).toEqual(expect.arrayContaining(['preflight_review', 'final_summary', 'final_review', 'done']));
    expect(run.states).not.toContain('failed');
    expect(run.states).not.toContain('aborted');
    const report = readFileSync(resolve(run.workspaceDir, '.workflow', 'final_report', 'final_report.md'), 'utf-8');
    expect(report).toContain('Best node');
    expect(report).toContain('Score trajectory');

    const nodes = readJson(
      resolve(run.workspaceDir, '.evolve_runs', 'main', 'database_data', 'nodes.json'),
    ) as NodesFile;
    expect(Object.keys(nodes.nodes)).toHaveLength(ROUND_COUNT);
    expectParentLineage(nodes);
  }, 300_000);

  it('B: preflight_review ABORT reaches aborted with zero nodes', async () => {
    const run = await startScenario('preflight-abort');
    const [preflightGate] = await waitForGate(run.raiseGate, 1, 180_000);
    expect(preflightGate.stateName).toBe('preflight_review');
    run.orchestrator.resolveGate(run.workflowId, { type: 'ABORT' });

    await waitForCompletion(run.orchestrator, run.workflowId, 180_000);
    expect(run.orchestrator.getStatus(run.workflowId)?.phase).toBe('aborted');
    await run.orchestrator.shutdownAll();

    expect(run.states.at(-1)).toBe('aborted');
    expect(run.states[0]).toBe('provision');
    expect(run.states).not.toContain('orchestrator');
    expect(run.states).not.toContain('sample');
    expect(run.states).not.toContain('evaluate');
    expect(run.states).not.toContain('done');
    expect(existsSync(resolve(run.workspaceDir, '.evolve_runs', 'main', 'database_data', 'nodes.json'))).toBe(false);
  }, 300_000);

  it('C: evaluator_blocked routes to human_escalation and FORCE_REVISION proceeds without a spurious node', async () => {
    const run = await startScenario('evaluator-force-revision');
    const [preflightGate] = await waitForGate(run.raiseGate, 1, 180_000);
    expect(preflightGate.stateName).toBe('preflight_review');
    run.orchestrator.resolveGate(run.workflowId, { type: 'APPROVE' });

    const gatesAfterBlock = await waitForGate(run.raiseGate, 2, 180_000);
    const escalationGate = gatesAfterBlock[1];
    expect(escalationGate.stateName).toBe('human_escalation');
    expect(escalationGate.acceptedEvents).toEqual(['APPROVE', 'FORCE_REVISION', 'ABORT']);
    expect(escalationGate.presentedArtifacts.has('run_spec')).toBe(true);
    // The orchestrator surfaces the deterministic verdict in the gate summary so a
    // reviewer sees why the round was escalated (buildGateRequest, the orchestrator.ts change).
    expect(escalationGate.summary).toContain('evaluator_blocked');
    run.orchestrator.resolveGate(run.workflowId, {
      type: 'FORCE_REVISION',
      prompt: 'fix the candidate to define solve(xs)',
    });

    const gatesAfterRevision = await waitForGate(run.raiseGate, 3, 180_000);
    expect(gatesAfterRevision[2].stateName).toBe('preflight_review');
    run.orchestrator.resolveGate(run.workflowId, { type: 'APPROVE' });

    const gatesAtFinal = await waitForGate(run.raiseGate, 4, 180_000);
    expect(gatesAtFinal[3].stateName).toBe('final_review');
    run.orchestrator.resolveGate(run.workflowId, { type: 'APPROVE' });

    await waitForCompletion(run.orchestrator, run.workflowId, 180_000);
    expect(run.orchestrator.getStatus(run.workflowId)?.phase).toBe('completed');
    await run.orchestrator.shutdownAll();

    expect(run.states.at(-1)).toBe('done');
    expect(run.states[0]).toBe('provision');
    expect(countStates(run.states, 'human_escalation')).toBe(1);
    expect(countStates(run.states, 'preflight_review')).toBe(2);
    const nodes = readJson(
      resolve(run.workspaceDir, '.evolve_runs', 'main', 'database_data', 'nodes.json'),
    ) as NodesFile;
    expect(nodes.next_id).toBe(ROUND_COUNT);
    expect(Object.keys(nodes.nodes)).toEqual(['0', '1', '2']);
    expectParentLineage(nodes);
    expect(nodeScores(nodes)).toEqual([2, 5, 6]);
  }, 300_000);

  it('D: final_review FORCE_REVISION runs exactly one extra round before APPROVE', async () => {
    const run = await startScenario('final-force-revision');
    const [preflightGate] = await waitForGate(run.raiseGate, 1, 180_000);
    expect(preflightGate.stateName).toBe('preflight_review');
    run.orchestrator.resolveGate(run.workflowId, { type: 'APPROVE' });

    const firstFinal = await waitForGate(run.raiseGate, 2, 180_000);
    expect(firstFinal[1].stateName).toBe('final_review');
    run.orchestrator.resolveGate(run.workflowId, { type: 'FORCE_REVISION', prompt: 'run 1 more round' });

    const secondFinal = await waitForGate(run.raiseGate, 3, 180_000);
    expect(secondFinal[2].stateName).toBe('final_review');
    run.orchestrator.resolveGate(run.workflowId, { type: 'APPROVE' });

    await waitForCompletion(run.orchestrator, run.workflowId, 180_000);
    expect(run.orchestrator.getStatus(run.workflowId)?.phase).toBe('completed');
    await run.orchestrator.shutdownAll();

    expect(run.states.at(-1)).toBe('done');
    expect(run.states[0]).toBe('provision');
    expect(countStates(run.states, 'final_summary')).toBe(2);
    const nodes = readJson(
      resolve(run.workspaceDir, '.evolve_runs', 'main', 'database_data', 'nodes.json'),
    ) as NodesFile;
    expect(nodes.next_id).toBe(ROUND_COUNT + 1);
    expect(Object.keys(nodes.nodes)).toEqual(['0', '1', '2', '3']);
    expectParentLineage(nodes);
    const scores = nodeScores(nodes);
    expect(scores).toEqual([2, 5, 6, 6]);
    expect(scores[0]).toBeLessThanOrEqual(scores[1]);
    expect(scores[1]).toBeLessThanOrEqual(scores[2]);
    expect(scores[2]).toBeLessThanOrEqual(scores[3]);
    expect(readFileSync(resolve(run.workspaceDir, '.workflow', 'final_report', 'final_report.md'), 'utf-8')).toContain(
      'Rounds: 4 / 3',
    );
  }, 300_000);
});
