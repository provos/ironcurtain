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
const TEST_HOME = `${REAL_TMP}/ironcurtain-evolve-search-quality-${process.pid}`;
const TASK = 'evolve a tiny score function with search-quality features';

interface EvolveNode {
  readonly id: number;
  readonly parent: readonly number[];
  readonly score: number;
  readonly created_at?: string;
}

interface NodesFile {
  readonly next_id: number;
  readonly nodes: Record<string, EvolveNode>;
}

interface ContextSnapshot {
  readonly parents: readonly { id: number }[];
  readonly cognition: { matches: readonly { content: string; source: string; metadata?: { kind?: string } }[] };
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

function writeRunSpec(
  workspacePath: string,
  opts: { rounds: number; algorithm: string; sampleN: number; seed?: number },
): void {
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
    objective: 'alpha beta promoted lesson recombination search',
    evaluation: {
      core_score: 'eval_score',
      secondary_metrics: [],
      command: evaluationCommand,
      script_path: '',
      timeout_secs: 30,
      success_criteria: ['eval_score >= 999'],
    },
    budget: { max_rounds: opts.rounds, patience: 0 },
    stop_conditions: ['max_rounds'],
    mutation_scope: {
      writable_paths: ['.evolve_runs'],
      primary_targets: ['candidate.py'],
    },
    sampling: {
      algorithm: opts.algorithm,
      sample_n: opts.sampleN,
      feature_dimensions: ['complexity', 'diversity'],
      feature_bins: 10,
      custom_sampler_path: '',
      custom_sampler_class: '',
    },
    cognition: { source_mode: 'seed', seed_files: [], seed_notes: [] },
    approval: { confirmed: true },
  };
  writeFileSync(resolve(runDir, 'run_spec.yaml'), JSON.stringify(runSpec, null, 2) + '\n');
  writeFileSync(
    resolve(runDir, 'cognition_seed.md'),
    ['```json', '[{"content":"seed heuristic","source":"seed","metadata":{"kind":"heuristic"}}]', '```', ''].join('\n'),
  );
  if (opts.algorithm !== 'greedy') {
    writeFileSync(resolve(runDir, 'sampling_seed.txt'), `${opts.seed ?? 0}\n`);
  }
  mkdirSync(resolve(workspacePath, '.workflow', 'run_spec'), { recursive: true });
  mkdirSync(resolve(workspacePath, '.workflow', 'cognition_seed'), { recursive: true });
  writeFileSync(resolve(workspacePath, '.workflow', 'run_spec', 'run_spec.md'), JSON.stringify(runSpec, null, 2));
  writeFileSync(resolve(workspacePath, '.workflow', 'cognition_seed', 'cognition_seed.md'), 'seed\n');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

function roundLogEvents(runDir: string): Array<{ event: string; payload: Record<string, unknown> }> {
  return readFileSync(resolve(runDir, 'round_log.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; payload: Record<string, unknown> });
}

function writeCandidate(workspacePath: string, turn: number, contexts: ContextSnapshot[]): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  const context = readJson(resolve(runDir, 'current', 'context.json')) as ContextSnapshot & { step_name: string };
  contexts.push(context);
  const stepDir = resolve(runDir, 'steps', context.step_name);
  mkdirSync(stepDir, { recursive: true });
  writeFileSync(resolve(stepDir, 'code'), `def score():\n    return ${turn}\n`);
}

function writeAnalysis(workspacePath: string, turn: number): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  mkdirSync(resolve(runDir, 'current'), { recursive: true });
  writeFileSync(
    resolve(runDir, 'current', 'analysis.md'),
    `alpha beta promoted lesson round ${turn}: recombine useful parent ideas.\n`,
  );
}

function writeFinalReport(workspacePath: string): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as NodesFile;
  const report = [
    '# Final Evolve Report',
    '',
    `Objective: ${TASK}`,
    `Rounds: ${Object.keys(nodes.nodes).length}`,
    '',
  ].join('\n');
  writeFileSync(resolve(runDir, 'final_report.md'), report);
  mkdirSync(resolve(workspacePath, '.workflow', 'final_report'), { recursive: true });
  writeFileSync(resolve(workspacePath, '.workflow', 'final_report', 'final_report.md'), report);
}

function stripCreatedAt(nodes: NodesFile): unknown {
  return {
    ...nodes,
    nodes: Object.fromEntries(
      Object.entries(nodes.nodes).map(([id, node]) => {
        const rest = { ...node };
        delete rest.created_at;
        return [id, rest];
      }),
    ),
  };
}

describe.skipIf(!dockerReady)('evolve search-quality workflow with real Docker container', () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), 'evolve-search-quality-'));
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

  async function runSearchQuality(
    label: string,
    opts: { rounds: number; algorithm: string; sampleN: number; seed?: number },
  ): Promise<{ states: readonly string[]; workspaceDir: string; contexts: readonly ContextSnapshot[] }> {
    const runDir = resolve(tmpDir, `run-${label}`);
    const workspaceDir = resolve(tmpDir, `workspace-${label}`);
    const generatedDir = resolve(TEST_HOME, `generated-${label}`);
    mkdirSync(runDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(resolve(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));

    const orchestratorScript = Array.from({ length: opts.rounds }, () => 'design');
    orchestratorScript.push('complete');
    let orchestratorTurns = 0;
    let researcherTurns = 0;
    let analyzerTurns = 0;
    const contexts: ContextSnapshot[] = [];
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
            writeRunSpec(workspacePath, opts);
            return statusBlock('ready', 'preflight confirmed');
          }
          if (msg.includes('You are the Evolve orchestrator')) {
            const verdict = orchestratorScript[orchestratorTurns];
            orchestratorTurns += 1;
            if (!verdict) throw new Error(`orchestrator script exhausted at ${orchestratorTurns}`);
            return statusBlock(verdict, `orchestrator ${orchestratorTurns}`);
          }
          if (msg.includes('Write exactly one candidate program for this round')) {
            researcherTurns += 1;
            writeCandidate(workspacePath, researcherTurns, contexts);
            return approvedResponse(`candidate ${researcherTurns}`);
          }
          if (msg.includes('write a SHORT transferable lesson')) {
            analyzerTurns += 1;
            writeAnalysis(workspacePath, analyzerTurns);
            return approvedResponse(`analysis ${analyzerTurns}`);
          }
          if (msg.includes('The Evolve run has reached a stop condition')) {
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
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator, workflowId, 180_000);
    await orchestrator.shutdownAll();

    return { states, workspaceDir, contexts };
  }

  it('promotes cognition, retrieves it later, records multi-parent lineage, and honors ucb1', async () => {
    const run = await runSearchQuality('ucb1-quality', { rounds: 3, algorithm: 'ucb1', sampleN: 3, seed: 17 });
    const runDir = resolve(run.workspaceDir, '.evolve_runs', 'main');
    const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as NodesFile;
    const cognition = readJson(resolve(runDir, 'cognition_data', 'cognition.json')) as {
      items: Record<string, { content: string; source: string; metadata: { kind?: string } }>;
    };
    const roundLessons = Object.values(cognition.items).filter((item) => item.metadata.kind === 'round_lesson');
    const sampleEvents = roundLogEvents(runDir).filter((event) => event.event === 'db_sample');

    expect(run.states.at(-1)).toBe('done');
    expect(Object.values(nodes.nodes).some((node) => node.parent.length > 1)).toBe(true);
    expect(roundLessons.length).toBeGreaterThanOrEqual(3);
    expect(
      run.contexts.some((context) =>
        context.cognition.matches.some((match) => match.metadata?.kind === 'round_lesson' && match.source !== 'seed'),
      ),
    ).toBe(true);
    expect(sampleEvents).toHaveLength(3);
    expect(sampleEvents.every((event) => event.payload.algorithm === 'ucb1')).toBe(true);
    expect(sampleEvents.every((event) => event.payload.n === 3)).toBe(true);
  }, 300_000);

  it('reproduces seeded stochastic lineage across independent runs and preserves greedy determinism', async () => {
    const sameA = await runSearchQuality('random-same-a', { rounds: 5, algorithm: 'random', sampleN: 2, seed: 101 });
    const sameB = await runSearchQuality('random-same-b', { rounds: 5, algorithm: 'random', sampleN: 2, seed: 101 });
    const diff = await runSearchQuality('random-diff', { rounds: 5, algorithm: 'random', sampleN: 2, seed: 202 });
    const greedyA = await runSearchQuality('greedy-a', { rounds: 4, algorithm: 'greedy', sampleN: 3 });
    const greedyB = await runSearchQuality('greedy-b', { rounds: 4, algorithm: 'greedy', sampleN: 3 });

    const sameNodesA = readJson(
      resolve(sameA.workspaceDir, '.evolve_runs', 'main', 'database_data', 'nodes.json'),
    ) as NodesFile;
    const sameNodesB = readJson(
      resolve(sameB.workspaceDir, '.evolve_runs', 'main', 'database_data', 'nodes.json'),
    ) as NodesFile;
    const diffNodes = readJson(
      resolve(diff.workspaceDir, '.evolve_runs', 'main', 'database_data', 'nodes.json'),
    ) as NodesFile;
    const greedyNodesA = readJson(
      resolve(greedyA.workspaceDir, '.evolve_runs', 'main', 'database_data', 'nodes.json'),
    ) as NodesFile;
    const greedyNodesB = readJson(
      resolve(greedyB.workspaceDir, '.evolve_runs', 'main', 'database_data', 'nodes.json'),
    ) as NodesFile;

    expect(stripCreatedAt(sameNodesA)).toEqual(stripCreatedAt(sameNodesB));
    expect(stripCreatedAt(sameNodesA)).not.toEqual(stripCreatedAt(diffNodes));
    expect(stripCreatedAt(greedyNodesA)).toEqual(stripCreatedAt(greedyNodesB));
  }, 420_000);
});
