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
import { approvedResponse, createDeps, MockSession, statusBlock, waitForCompletion } from './test-helpers.js';

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
        enabled: false,
        quarantineDays: 2,
        allowedPackages: [],
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
}

function writeCandidate(workspacePath: string, kind: CandidateKind): void {
  const stepDir = resolve(workspacePath, '.evolve_runs', 'main', 'steps', 'step_0001');
  mkdirSync(stepDir, { recursive: true });
  const candidates: Record<CandidateKind, string> = {
    sum: 'def solve(xs):\n    return sum(xs)\n',
    'low-score': 'def solve(xs):\n    return 0\n',
    crash: 'x = 1\n',
  };
  writeFileSync(resolve(stepDir, 'code'), candidates[kind]);
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

    let sessionCount = 0;
    const createSession = vi.fn(async (options: SessionOptions) => {
      const workspacePath = options.workspacePath;
      if (!workspacePath) throw new Error('workflow agent session missing workspacePath');
      sessionCount += 1;
      if (sessionCount === 1) {
        writePreflightRunSpec(workspacePath);
        return new MockSession({ responses: () => statusBlock('ready', 'preflight confirmed') });
      }
      if (sessionCount === 2) {
        writeCandidate(workspacePath, kind);
        return new MockSession({ responses: () => approvedResponse('candidate written') });
      }
      throw new Error(`unexpected extra agent session ${sessionCount}`);
    });

    const orchestrator = new WorkflowOrchestrator(
      createDeps(runDir, {
        createSession,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    const states: string[] = [];
    orchestrator.onEvent((event: WorkflowLifecycleEvent) => {
      if (event.kind === 'state_entered') states.push(event.state);
    });

    const manifestPath = resolve(process.cwd(), 'src', 'workflow', 'workflows', 'evolve', 'workflow.yaml');
    const workflowId = await orchestrator.start(manifestPath, TASK, workspaceDir);
    await waitForCompletion(orchestrator, workflowId, 150_000);
    await orchestrator.shutdownAll();
    expect(sessionCount).toBe(2);
    return { states, workspaceDir };
  }

  it('records a correct candidate and reaches done', async () => {
    const { states, workspaceDir } = await runEvolve('sum');
    const runDir = resolve(workspaceDir, '.evolve_runs', 'main');
    const candidate = 'def solve(xs):\n    return sum(xs)\n';

    expect(states.at(-1)).toBe('done');
    expect(states).not.toContain('failed');
    expect((readJson(resolve(runDir, 'steps', 'step_0001', 'result.json')) as { verdict: string }).verdict).toBe(
      'evaluated',
    );
    expect((readJson(resolve(runDir, 'steps', 'step_0001', 'record_result.json')) as { verdict: string }).verdict).toBe(
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
    const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as {
      nodes: Record<string, { score: number }>;
    };
    expect(Object.keys(nodes.nodes)).toEqual(['0']);
    expect(nodes.nodes['0'].score).toBe(0);
    expect((readJson(resolve(runDir, 'steps', 'step_0001', 'result.json')) as { verdict: string }).verdict).toBe(
      'evaluated',
    );
  }, 240_000);

  it('routes evaluator crashes to failed without recording a node', async () => {
    const { states, workspaceDir } = await runEvolve('crash');
    const runDir = resolve(workspaceDir, '.evolve_runs', 'main');

    expect(states.at(-1)).toBe('failed');
    expect(states).toContain('evaluate');
    expect(states).not.toContain('record_node');
    expect((readJson(resolve(runDir, 'steps', 'step_0001', 'result.json')) as { verdict: string }).verdict).toBe(
      'evaluator_blocked',
    );
    expect(existsSync(resolve(runDir, 'database_data', 'nodes.json'))).toBe(false);
  }, 240_000);
});
