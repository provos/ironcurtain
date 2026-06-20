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
const TEST_HOME = `${REAL_TMP}/ironcurtain-evolve-single-round-${process.pid}`;
const TASK = 'write solve(xs) returning the sum; the evaluator scores solve([1,2,3]) == 6';

type CandidateKind = 'sum' | 'low-score' | 'crash';

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
        maxSteps: 200,
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
    'json.dump({{"eval_score": float(s), "success": s == 6}}, open({quoted_results_path}, "w"))',
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
    budget: { max_rounds: 1, patience: 1 },
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
    cognition: { source_mode: 'none', seed_files: [], seed_notes: [] },
    approval: { confirmed: true },
  };
  writeFileSync(resolve(runDir, 'run_spec.yaml'), JSON.stringify(runSpec, null, 2) + '\n');
  writeFileSync(resolve(runDir, 'preflight_summary.md'), '# Preflight Summary\n\n- Status: `READY`\n');
  writeFileSync(resolve(runDir, 'cognition_seed.md'), '# Cognition Seed Draft\n');
  mkdirSync(resolve(workspacePath, '.workflow', 'run_spec'), { recursive: true });
  mkdirSync(resolve(workspacePath, '.workflow', 'cognition_seed'), { recursive: true });
  writeFileSync(
    resolve(workspacePath, '.workflow', 'run_spec', 'run_spec.md'),
    JSON.stringify(runSpec, null, 2) + '\n',
  );
  writeFileSync(resolve(workspacePath, '.workflow', 'cognition_seed', 'cognition_seed.md'), '# Cognition Seed Draft\n');
}

function writeParallelPreflightRunSpec(workspacePath: string): void {
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
    'json.dump({{"eval_score": float(s), "success": s >= 6}}, open({quoted_results_path}, "w"))',
    "'",
  ].join('');
  const runSpec = {
    objective: `${TASK}; parallel lane gate`,
    evaluation: {
      core_score: 'eval_score',
      secondary_metrics: [],
      command: evaluationCommand,
      script_path: '',
      timeout_secs: 30,
      success_criteria: ['eval_score >= 1.0'],
    },
    budget: { max_rounds: 6, patience: 6 },
    stop_conditions: ['max_rounds'],
    mutation_scope: {
      writable_paths: ['.evolve_runs'],
      primary_targets: ['candidate.py'],
    },
    sampling: {
      algorithm: 'island',
      sample_n: 1,
      feature_dimensions: [],
      feature_bins: 0,
      custom_sampler_path: '',
      custom_sampler_class: '',
    },
    cognition: { source_mode: 'none', seed_files: [], seed_notes: [] },
    approval: { confirmed: true },
  };
  writeFileSync(resolve(runDir, 'run_spec.yaml'), JSON.stringify(runSpec, null, 2) + '\n');
  writeFileSync(resolve(runDir, 'sampling_seed.txt'), '41\n');
  writeFileSync(resolve(runDir, 'preflight_summary.md'), '# Preflight Summary\n\n- Status: `READY`\n');
  writeFileSync(resolve(runDir, 'cognition_seed.md'), '# Cognition Seed Draft\n');
  writeFileSync(
    resolve(runDir, 'database_data', 'nodes.json'),
    JSON.stringify(
      {
        next_id: 3,
        nodes: Object.fromEntries(
          [0, 1, 2].map((id) => [
            String(id),
            {
              id,
              name: `seed-${id}`,
              created_at: `2026-01-01T00:00:0${id}.000Z`,
              parent: [],
              motivation: `seed parent ${id}`,
              code: `def solve(xs):\n    return ${id}\n`,
              results: { eval_score: id },
              analysis: `seed analysis ${id}`,
              meta_info: { step_name: `seed_${id}` },
              visit_count: 0,
              score: id,
            },
          ]),
        ),
      },
      null,
      2,
    ) + '\n',
  );
  mkdirSync(resolve(workspacePath, '.workflow', 'run_spec'), { recursive: true });
  mkdirSync(resolve(workspacePath, '.workflow', 'cognition_seed'), { recursive: true });
  writeFileSync(
    resolve(workspacePath, '.workflow', 'run_spec', 'run_spec.md'),
    JSON.stringify(runSpec, null, 2) + '\n',
  );
  writeFileSync(resolve(workspacePath, '.workflow', 'cognition_seed', 'cognition_seed.md'), '# Cognition Seed Draft\n');
}

function writeProvisionMarker(workspacePath: string): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(resolve(runDir, '.provisioned'), 'numpy\npyyaml\n');
}

function writeCandidate(workspacePath: string, kind: CandidateKind): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  const context = readJson(resolve(runDir, 'current', 'context.json')) as { step_name: string };
  const stepDir = resolve(runDir, 'steps', context.step_name);
  mkdirSync(stepDir, { recursive: true });
  const candidates: Record<CandidateKind, string> = {
    sum: 'def solve(xs):\n    return sum(xs)\n',
    'low-score': 'def solve(xs):\n    return 0\n',
    crash: 'x = 1\n',
  };
  writeFileSync(resolve(stepDir, 'code'), candidates[kind]);
}

function writeAnalysis(workspacePath: string): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  mkdirSync(resolve(runDir, 'current'), { recursive: true });
  writeFileSync(resolve(runDir, 'current', 'analysis.md'), 'Single-round lesson.\n');
}

function laneFromPrompt(msg: string, fileName: string): number {
  const match = new RegExp(`/workspace/\\.evolve_runs/main/current/lane_(\\d+)/${fileName}`).exec(msg);
  if (!match) throw new Error(`prompt did not contain a lane-scoped ${fileName} path`);
  return Number(match[1]);
}

function writeParallelCandidate(workspacePath: string, msg: string): number {
  const lane = laneFromPrompt(msg, 'context\\.json');
  expect(msg).not.toContain('/workspace/.evolve_runs/main/current/context.json');
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  const context = readJson(resolve(runDir, 'current', `lane_${lane}`, 'context.json')) as {
    step_name: string;
    parents: Array<{ id: number }>;
  };
  expect(context.parents).toHaveLength(1);
  const stepDir = resolve(runDir, 'steps', context.step_name);
  mkdirSync(stepDir, { recursive: true });
  writeFileSync(resolve(stepDir, 'code'), `def solve(xs):\n    return sum(xs) + ${lane}\n`);
  return lane;
}

function writeParallelAnalysis(workspacePath: string, msg: string): number {
  const lane = laneFromPrompt(msg, 'context\\.json');
  expect(msg).toContain(`/workspace/.evolve_runs/main/current/lane_${lane}/result.json`);
  expect(msg).toContain(`/workspace/.evolve_runs/main/current/lane_${lane}/analysis.md`);
  expect(msg).not.toContain('/workspace/.evolve_runs/main/current/result.json');
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  mkdirSync(resolve(runDir, 'current', `lane_${lane}`), { recursive: true });
  writeFileSync(resolve(runDir, 'current', `lane_${lane}`, 'analysis.md'), `Parallel lane ${lane} lesson.\n`);
  return lane;
}

function writeFinalReport(workspacePath: string): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as {
    nodes: Record<string, { id: number; score: number; analysis: string }>;
  };
  const best = Object.values(nodes.nodes)[0];
  const report = [
    '# Final Evolve Report',
    '',
    `Objective: ${TASK}`,
    `Rounds: ${Object.keys(nodes.nodes).length} / 1`,
    `Best node: ${best.id}, score ${best.score}`,
    `Best lesson: ${best.analysis.trim()}`,
    `Score trajectory: ${best.id} -> ${best.score}`,
    'Recommendation: accept the candidate.',
    '',
  ].join('\n');
  writeFileSync(resolve(runDir, 'final_report.md'), report);
  mkdirSync(resolve(workspacePath, '.workflow', 'final_report'), { recursive: true });
  writeFileSync(resolve(workspacePath, '.workflow', 'final_report', 'final_report.md'), report);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

describe.skipIf(!dockerReady)('evolve single-round workflow with real Docker container', () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), 'evolve-single-round-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runEvolve(kind: CandidateKind): Promise<{ states: readonly string[]; workspaceDir: string }> {
    const runDir = resolve(tmpDir, `run-${kind}`);
    const workspaceDir = resolve(tmpDir, `workspace-${kind}`);
    const generatedDir = resolve(TEST_HOME, `generated-${kind}`);
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

    const orchestratorScript = kind === 'crash' ? ['design'] : ['design', 'complete'];
    let provisionCount = 0;
    let preflightCount = 0;
    let orchestratorCount = 0;
    let researcherCount = 0;
    let analyzerCount = 0;
    let finalSummaryCount = 0;
    const createSession = vi.fn(async (options: SessionOptions) => {
      const workspacePath = options.workspacePath;
      if (!workspacePath) throw new Error('workflow agent session missing workspacePath');
      return new MockSession({
        responses: (msg: string) => {
          if (msg.includes('provisioning the Python environment')) {
            provisionCount += 1;
            writeProvisionMarker(workspacePath);
            return statusBlock('ready', 'provision confirmed');
          }
          if (msg.includes('configuring a multi-round Evolve experiment')) {
            preflightCount += 1;
            writePreflightRunSpec(workspacePath);
            return statusBlock('ready', 'preflight confirmed');
          }
          if (msg.includes('You are the Evolve orchestrator')) {
            const verdict = orchestratorScript[orchestratorCount];
            orchestratorCount += 1;
            if (!verdict) throw new Error(`orchestrator script exhausted at turn ${orchestratorCount}`);
            return statusBlock(verdict, `orchestrator turn ${orchestratorCount}`);
          }
          if (msg.includes('Write exactly one candidate program for this round')) {
            researcherCount += 1;
            writeCandidate(workspacePath, kind);
            return approvedResponse('candidate written');
          }
          if (msg.includes('write a SHORT transferable lesson')) {
            analyzerCount += 1;
            writeAnalysis(workspacePath);
            return approvedResponse('analysis written');
          }
          if (msg.includes('The Evolve run has reached a stop condition')) {
            finalSummaryCount += 1;
            writeFinalReport(workspacePath);
            return approvedResponse('final report written');
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

    const firstGate = await waitForGate(raiseGate, 1, 150_000);
    expect(firstGate[0].stateName).toBe('preflight_review');
    expect([...firstGate[0].presentedArtifacts.keys()].sort()).toEqual(['cognition_seed', 'run_spec']);
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });

    if (kind === 'crash') {
      const gates = await waitForGate(raiseGate, 2, 150_000);
      expect(gates[1].stateName).toBe('human_escalation');
      expect(gates[1].acceptedEvents).toEqual(['APPROVE', 'FORCE_REVISION', 'ABORT']);
      expect(gates[1].presentedArtifacts.has('run_spec')).toBe(true);
      orchestrator.resolveGate(workflowId, { type: 'ABORT' });
    } else {
      const gates = await waitForGate(raiseGate, 2, 150_000);
      expect(gates[1].stateName).toBe('final_review');
      expect(gates[1].presentedArtifacts.has('final_report')).toBe(true);
      orchestrator.resolveGate(workflowId, { type: 'APPROVE' });
    }

    await waitForCompletion(orchestrator, workflowId, 150_000);
    await orchestrator.shutdownAll();
    expect(provisionCount).toBe(1);
    expect(preflightCount).toBe(1);
    expect(researcherCount).toBe(1);
    expect(analyzerCount).toBe(kind === 'crash' ? 0 : 1);
    expect(finalSummaryCount).toBe(kind === 'crash' ? 0 : 1);
    return { states, workspaceDir };
  }

  it('records a correct candidate and reaches done', async () => {
    const { states, workspaceDir } = await runEvolve('sum');
    const runDir = resolve(workspaceDir, '.evolve_runs', 'main');
    const candidate = 'def solve(xs):\n    return sum(xs)\n';

    expect(states.at(-1)).toBe('done');
    expect(states).not.toContain('failed');
    expect(states[0]).toBe('provision');
    expect(states).toContain('preflight_review');
    expect(states).toContain('final_summary');
    expect(states).toContain('final_review');
    expect((readJson(resolve(runDir, 'current', 'result.json')) as { verdict: string }).verdict).toBe('evaluated');
    expect((readJson(resolve(runDir, 'current', 'analysis_record.json')) as { verdict: string }).verdict).toBe(
      'recorded',
    );

    const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as {
      next_id: number;
      nodes: Record<string, { score: number }>;
    };
    expect(nodes.next_id).toBe(1);
    expect(Object.keys(nodes.nodes)).toEqual(['0']);
    expect(nodes.nodes['0'].score).toBe(6);

    expect(readFileSync(resolve(runDir, 'best', 'step_0001', 'code'), 'utf-8')).toBe(candidate);
    expect((readJson(resolve(runDir, 'best', 'step_0001', 'results.json')) as { eval_score: number }).eval_score).toBe(
      6,
    );
  }, 240_000);

  it('records a low-score candidate and still reaches done', async () => {
    const { states, workspaceDir } = await runEvolve('low-score');
    const runDir = resolve(workspaceDir, '.evolve_runs', 'main');

    expect(states.at(-1)).toBe('done');
    expect(states[0]).toBe('provision');
    expect(states).toContain('final_review');
    const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as {
      nodes: Record<string, { score: number }>;
    };
    expect(Object.keys(nodes.nodes)).toEqual(['0']);
    expect(nodes.nodes['0'].score).toBe(0);
    expect((readJson(resolve(runDir, 'current', 'result.json')) as { verdict: string }).verdict).toBe('evaluated');
  }, 240_000);

  it('records three lane-scoped nodes and logs duplicate rate with workers: 3', async () => {
    const runDir = resolve(tmpDir, 'run-parallel');
    const workspaceDir = resolve(tmpDir, 'workspace-parallel');
    const generatedDir = resolve(TEST_HOME, 'generated-parallel');
    const workflowPackageDir = resolve(tmpDir, 'evolve-parallel-package');
    mkdirSync(runDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(generatedDir, { recursive: true });
    cpSync(resolve(process.cwd(), 'src', 'workflow', 'workflows', 'evolve'), workflowPackageDir, { recursive: true });
    const manifestPath = resolve(workflowPackageDir, 'workflow.yaml');
    writeFileSync(
      manifestPath,
      readFileSync(manifestPath, 'utf-8')
        .replace(/workers:\s*1/, 'workers: 3')
        .replace(
          'resultFile: .evolve_runs/main/current/sample.json',
          'resultFile: .evolve_runs/main/current/lane_${laneId}/sample.json',
        )
        .replace(
          'resultFile: .evolve_runs/main/current/result.json',
          'resultFile: .evolve_runs/main/current/lane_${laneId}/result.json',
        )
        .replace(
          'resultFile: .evolve_runs/main/current/analysis_record.json',
          'resultFile: .evolve_runs/main/current/lane_${laneId}/analysis_record.json',
        ),
    );
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

    let orchestratorCount = 0;
    const researcherLanes: number[] = [];
    const analyzerLanes: number[] = [];
    const createSession = vi.fn(async (options: SessionOptions) => {
      const sessionWorkspace = options.workspacePath;
      if (!sessionWorkspace) throw new Error('workflow agent session missing workspacePath');
      return new MockSession({
        responses: (msg: string) => {
          if (msg.includes('provisioning the Python environment')) {
            writeProvisionMarker(sessionWorkspace);
            return statusBlock('ready', 'provision confirmed');
          }
          if (msg.includes('configuring a multi-round Evolve experiment')) {
            writeParallelPreflightRunSpec(sessionWorkspace);
            return statusBlock('ready', 'preflight confirmed');
          }
          if (msg.includes('You are the Evolve orchestrator')) {
            orchestratorCount += 1;
            return statusBlock(orchestratorCount === 1 ? 'design' : 'complete', `orchestrator ${orchestratorCount}`);
          }
          if (msg.includes('Write exactly one candidate program for this round')) {
            researcherLanes.push(writeParallelCandidate(sessionWorkspace, msg));
            return approvedResponse('parallel candidate written');
          }
          if (msg.includes('write a SHORT transferable lesson')) {
            analyzerLanes.push(writeParallelAnalysis(sessionWorkspace, msg));
            return approvedResponse('parallel analysis written');
          }
          if (msg.includes('The Evolve run has reached a stop condition')) {
            writeFinalReport(sessionWorkspace);
            return approvedResponse('final report written');
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

    const workflowId = await orchestrator.start(manifestPath, TASK, workspaceDir);
    const firstGate = await waitForGate(raiseGate, 1, 180_000);
    expect(firstGate[0].stateName).toBe('preflight_review');
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });
    const finalGate = await waitForGate(raiseGate, 2, 180_000);
    expect(finalGate[1].stateName).toBe('final_review');
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator, workflowId, 180_000);
    await orchestrator.shutdownAll();

    const evolveRunDir = resolve(workspaceDir, '.evolve_runs', 'main');
    const nodes = readJson(resolve(evolveRunDir, 'database_data', 'nodes.json')) as {
      next_id: number;
      nodes: Record<string, { id: number; parent: number[]; code: string; meta_info?: { step_name?: string } }>;
    };
    const recorded = Object.values(nodes.nodes).filter((node) => node.id >= 3);
    expect(states.at(-1)).toBe('done');
    expect(states).not.toContain('failed');
    expect(states.filter((state) => state === 'workers')).toHaveLength(1);
    expect(researcherLanes.sort()).toEqual([0, 1, 2]);
    expect(analyzerLanes.sort()).toEqual([0, 1, 2]);
    expect(nodes.next_id).toBe(6);
    expect(recorded).toHaveLength(3);
    expect(recorded.map((node) => node.parent[0]).sort()).toEqual([0, 1, 2]);
    expect(recorded.map((node) => node.meta_info?.step_name).sort()).toEqual([
      'step_0001_lane_0',
      'step_0001_lane_1',
      'step_0001_lane_2',
    ]);
    expect(new Set(recorded.map((node) => node.code)).size).toBe(3);
    expect(existsSync(resolve(evolveRunDir, 'current', 'context.json'))).toBe(false);
    expect(existsSync(resolve(evolveRunDir, 'current', 'result.json'))).toBe(false);
    expect(existsSync(resolve(evolveRunDir, 'current', 'analysis.md'))).toBe(false);
    expect(existsSync(resolve(evolveRunDir, 'current', 'analysis_record.json'))).toBe(false);
    for (const lane of [0, 1, 2]) {
      expect(
        (readJson(resolve(evolveRunDir, 'current', `lane_${lane}`, 'result.json')) as { verdict: string }).verdict,
      ).toBe('evaluated');
      expect(
        (readJson(resolve(evolveRunDir, 'current', `lane_${lane}`, 'analysis_record.json')) as { verdict: string })
          .verdict,
      ).toBe('recorded');
    }

    const messages = readFileSync(resolve(runDir, workflowId, 'messages.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            workers?: number;
            duplicateRate?: number;
            duplicateCount?: number;
            candidateCount?: number;
            children?: Array<{ status: string }>;
          },
      );
    expect(messages.find((entry) => entry.type === 'fanout_join')).toMatchObject({
      workers: 3,
      duplicateRate: 0,
      duplicateCount: 0,
      candidateCount: 3,
      children: [{ status: 'recorded' }, { status: 'recorded' }, { status: 'recorded' }],
    });
  }, 240_000);

  it('routes evaluator crashes to human_escalation without recording a node', async () => {
    const { states, workspaceDir } = await runEvolve('crash');
    const runDir = resolve(workspaceDir, '.evolve_runs', 'main');

    expect(states.at(-1)).toBe('aborted');
    expect(states[0]).toBe('provision');
    expect(states).toContain('workers');
    expect(states).toContain('human_escalation');
    expect(states).not.toContain('failed');
    expect(states).not.toContain('evaluate');
    expect(states).not.toContain('analysis_record');
    expect((readJson(resolve(runDir, 'current', 'result.json')) as { verdict: string }).verdict).toBe(
      'evaluator_blocked',
    );
    const nodesPath = resolve(runDir, 'database_data', 'nodes.json');
    if (existsSync(nodesPath)) {
      const nodes = readJson(nodesPath) as { nodes: Record<string, unknown> };
      expect(Object.keys(nodes.nodes)).toEqual([]);
    }
  }, 240_000);
});
