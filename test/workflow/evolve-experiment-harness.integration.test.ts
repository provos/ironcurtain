import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const TEST_HOME = `${REAL_TMP}/ironcurtain-evolve-experiment-harness-${process.pid}`;
const TASK = 'evolve a tiny synthetic score function over 3 rounds';
const ROUND_COUNT = 3;

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
        allowedPackages: ['numpy', 'pyyaml', 'tabulate'],
        deniedPackages: [],
      },
      serverCredentials: {},
      dockerResources: { memoryMb: null, cpus: null },
    },
  } as unknown as IronCurtainConfig;
}

function writeSyntheticExperiment(workspaceDir: string): void {
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(resolve(workspaceDir, 'requirements.txt'), 'tabulate\n');
  writeFileSync(resolve(workspaceDir, 'input.md'), 'Maximize candidate.score() for a tiny synthetic benchmark.\n');
  writeFileSync(resolve(workspaceDir, 'initial_program'), 'def score():\n    return 1\n');
  writeFileSync(
    resolve(workspaceDir, 'evaluator.py'),
    [
      'import json',
      'import sys',
      'from tabulate import tabulate',
      '',
      'code_path, out_path = sys.argv[1], sys.argv[2]',
      'ns = {}',
      'with open(code_path, "r", encoding="utf-8") as handle:',
      '    exec(compile(handle.read(), code_path, "exec"), ns)',
      'value = float(ns["score"]())',
      'tabulate([["score", value]])',
      'with open(out_path, "w", encoding="utf-8") as handle:',
      '    json.dump({"eval_score": value, "valid": True, "used_dependency": "tabulate"}, handle)',
      '',
    ].join('\n'),
  );
}

function writePreflightRunSpec(workspacePath: string, rounds: number, experiment: boolean): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  mkdirSync(resolve(runDir, 'steps'), { recursive: true });
  mkdirSync(resolve(runDir, 'database_data'), { recursive: true });
  mkdirSync(resolve(runDir, 'cognition_data'), { recursive: true });
  mkdirSync(resolve(runDir, 'best'), { recursive: true });
  writeFileSync(resolve(runDir, 'round_log.jsonl'), '');

  const evaluationCommand = experiment
    ? '/opt/workflow-venv/bin/python /workspace/evaluator.py {quoted_code_path} {quoted_results_path}'
    : [
        "python3 -c '",
        'import json;',
        'ns={{}};',
        'exec(open({quoted_code_path}).read(), ns);',
        'value=float(ns["score"]());',
        'json.dump({{"eval_score": value, "valid": True}}, open({quoted_results_path}, "w"))',
        "'",
      ].join('');
  const runSpec = {
    objective: experiment ? 'Maximize candidate.score() for a tiny synthetic benchmark.' : TASK,
    evaluation: {
      core_score: 'eval_score',
      secondary_metrics: [],
      command: evaluationCommand,
      script_path: '',
      timeout_secs: 30,
      success_criteria: ['eval_score >= 1.0'],
    },
    budget: { max_rounds: rounds, patience: 2 },
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
    `    "content": "${experiment ? 'Use the workspace evaluator and improve score() monotonically.' : 'Write score() as a simple numeric function.'}",`,
    '    "source": "test",',
    '    "metadata": {"kind": "heuristic"}',
    '  }',
    ']',
    '```',
    '',
  ].join('\n');

  writeFileSync(resolve(runDir, 'run_spec.yaml'), JSON.stringify(runSpec, null, 2) + '\n');
  writeFileSync(resolve(runDir, 'cognition_seed.md'), seed);
  mkdirSync(resolve(workspacePath, '.workflow', 'run_spec'), { recursive: true });
  mkdirSync(resolve(workspacePath, '.workflow', 'cognition_seed'), { recursive: true });
  writeFileSync(
    resolve(workspacePath, '.workflow', 'run_spec', 'run_spec.md'),
    JSON.stringify(runSpec, null, 2) + '\n',
  );
  writeFileSync(resolve(workspacePath, '.workflow', 'cognition_seed', 'cognition_seed.md'), seed);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

function readPackageAudit(bundleDir: string): readonly Record<string, unknown>[] {
  const auditPath = resolve(bundleDir, 'package-audit.jsonl');
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function countTabulateAudit(bundleDir: string): number {
  return readPackageAudit(bundleDir).filter(
    (entry) => entry.registry === 'pypi' && entry.packageName === 'tabulate' && entry.decision === 'allow',
  ).length;
}

function writeCandidate(workspacePath: string, turn: number, experiment: boolean): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  const context = readJson(resolve(runDir, 'current', 'context.json')) as { step_name: string; parents: unknown[] };
  const stepDir = resolve(runDir, 'steps', context.step_name);
  mkdirSync(stepDir, { recursive: true });

  if (experiment && context.parents.length === 0 && existsSync(resolve(workspacePath, 'initial_program'))) {
    cpSync(resolve(workspacePath, 'initial_program'), resolve(stepDir, 'code'));
    return;
  }

  const value = experiment ? Math.min(turn, 3) : Math.min(turn, 2);
  writeFileSync(resolve(stepDir, 'code'), `def score():\n    return ${value}\n`);
}

function writeAnalysis(workspacePath: string, turn: number): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  mkdirSync(resolve(runDir, 'current'), { recursive: true });
  writeFileSync(resolve(runDir, 'current', 'analysis.md'), `Round ${turn} improves the synthetic score.\n`);
}

function writeFinalReport(workspacePath: string): void {
  const runDir = resolve(workspacePath, '.evolve_runs', 'main');
  const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as NodesFile;
  const nodeList = Object.keys(nodes.nodes)
    .sort()
    .map((id) => nodes.nodes[id]);
  const best = nodeList.reduce((current, node) => (node.score > current.score ? node : current), nodeList[0]);
  const report = [
    '# Final Evolve Report',
    '',
    `Objective: ${TASK}`,
    `Rounds: ${nodeList.length}`,
    `Best node: ${best.id}, score ${best.score}`,
    `Score trajectory: ${nodeList.map((node) => `${node.id} -> ${node.score}`).join(', ')}`,
    '',
  ].join('\n');
  writeFileSync(resolve(runDir, 'final_report.md'), report);
  mkdirSync(resolve(workspacePath, '.workflow', 'final_report'), { recursive: true });
  writeFileSync(resolve(workspacePath, '.workflow', 'final_report', 'final_report.md'), report);
}

function countStates(states: readonly string[], state: string): number {
  return states.filter((s) => s === state).length;
}

describe.skipIf(!dockerReady)('evolve generic experiment harness with real Docker container', () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), 'evolve-experiment-harness-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runHarness(opts: {
    readonly label: string;
    readonly experiment: boolean;
    readonly explicitWorkspace: boolean;
  }): Promise<{
    readonly states: readonly string[];
    readonly workspaceDir: string;
    readonly bundleDir: string;
    readonly markerMtimeAfterProvision: number;
    readonly markerContentAfterProvision: string;
    readonly tabulateAuditAfterProvision: number;
    readonly provisionTurns: number;
  }> {
    const runDir = resolve(tmpDir, `run-${opts.label}`);
    const workspaceDir = resolve(tmpDir, `workspace-${opts.label}`);
    const generatedDir = resolve(TEST_HOME, `generated-${opts.label}`);
    mkdirSync(runDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(resolve(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));
    if (opts.experiment) writeSyntheticExperiment(workspaceDir);

    let currentBundle: DockerInfrastructure | undefined;
    let currentBundleDir = '';
    let observedWorkspaceDir = '';
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      observedWorkspaceDir = input.workspacePath;
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
      currentBundle = bundle;
      currentBundleDir = bundleDir;
      return bundle;
    });

    const destroyInfra = vi.fn(async (bundle: DockerInfrastructure) => {
      liveBundles.delete(bundle);
      await destroyDockerInfrastructure(bundle);
    });

    const orchestratorScript =
      opts.experiment && opts.explicitWorkspace
        ? [
            'design',
            'evaluate',
            'analyze',
            'record',
            'design',
            'evaluate',
            'analyze',
            'record',
            'design',
            'evaluate',
            'analyze',
            'record',
            'complete',
          ]
        : ['design', 'evaluate', 'analyze', 'record', 'complete'];
    let provisionTurns = 0;
    let preflightTurns = 0;
    let orchestratorTurns = 0;
    let researcherTurns = 0;
    let analyzerTurns = 0;
    let finalSummaryTurns = 0;
    const createSession = vi.fn(async (options: SessionOptions) => {
      const sessionWorkspace = options.workspacePath;
      if (!sessionWorkspace) throw new Error('workflow agent session missing workspacePath');
      observedWorkspaceDir = sessionWorkspace;
      return new MockSession({
        responses: async (msg: string) => {
          if (msg.includes('provisioning the Python environment')) {
            provisionTurns += 1;
            const runStateDir = resolve(sessionWorkspace, '.evolve_runs', 'main');
            mkdirSync(runStateDir, { recursive: true });
            if (opts.experiment) {
              if (!currentBundle) throw new Error('provision ran before bundle creation');
              const result = await currentBundle.docker.exec(
                currentBundle.containerId,
                [
                  '/bin/sh',
                  '-lc',
                  [
                    'set -eu',
                    'UV_NATIVE_TLS=1 VIRTUAL_ENV=/opt/workflow-venv uv pip install -r /workspace/requirements.txt',
                    "printf 'tabulate\\n' > /workspace/.evolve_runs/main/.provisioned",
                  ].join('\n'),
                ],
                180_000,
                'codespace',
                '/workspace',
              );
              if (result.exitCode !== 0) {
                throw new Error(`tabulate provision failed: ${result.stderr || result.stdout}`);
              }
            } else {
              writeFileSync(resolve(runStateDir, '.provisioned'), 'numpy\npyyaml\n');
            }
            return statusBlock('ready', `provision ${provisionTurns} confirmed`);
          }
          if (msg.includes('configuring a multi-round Evolve experiment')) {
            preflightTurns += 1;
            writePreflightRunSpec(sessionWorkspace, opts.experiment ? ROUND_COUNT : 1, opts.experiment);
            return statusBlock('ready', `preflight ${preflightTurns} confirmed`);
          }
          if (msg.includes('You are the Evolve orchestrator')) {
            const verdict = orchestratorScript[orchestratorTurns];
            orchestratorTurns += 1;
            if (!verdict) throw new Error(`orchestrator script exhausted at turn ${orchestratorTurns}`);
            return statusBlock(verdict, `orchestrator turn ${orchestratorTurns}`);
          }
          if (msg.includes('Write exactly one candidate program for this round')) {
            researcherTurns += 1;
            writeCandidate(sessionWorkspace, researcherTurns, opts.experiment);
            return approvedResponse(`candidate ${researcherTurns} written`);
          }
          if (msg.includes('write a SHORT transferable lesson')) {
            analyzerTurns += 1;
            writeAnalysis(sessionWorkspace, analyzerTurns);
            return approvedResponse(`analysis ${analyzerTurns} written`);
          }
          if (msg.includes('The Evolve run has reached a stop condition')) {
            finalSummaryTurns += 1;
            writeFinalReport(sessionWorkspace);
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
    const workflowId = opts.explicitWorkspace
      ? await orchestrator.start(manifestPath, TASK, workspaceDir)
      : await orchestrator.start(manifestPath, TASK);

    const [preflightGate] = await waitForGate(raiseGate, 1, 180_000);
    expect(preflightGate.stateName).toBe('preflight_review');
    expect([...preflightGate.presentedArtifacts.keys()].sort()).toEqual(['cognition_seed', 'run_spec']);
    const effectiveWorkspaceDir = opts.explicitWorkspace ? workspaceDir : observedWorkspaceDir;
    expect(effectiveWorkspaceDir).toBeTruthy();

    const markerPath = resolve(effectiveWorkspaceDir, '.evolve_runs', 'main', '.provisioned');
    const markerMtimeAfterProvision = statSync(markerPath).mtimeMs;
    const markerContentAfterProvision = readFileSync(markerPath, 'utf-8');
    const tabulateAuditAfterProvision = opts.experiment ? countTabulateAudit(currentBundleDir) : 0;
    if (opts.experiment) {
      expect(tabulateAuditAfterProvision).toBeGreaterThan(0);
      if (!currentBundle) throw new Error('missing bundle after provision');
      const importResult = await currentBundle.docker.exec(
        currentBundle.containerId,
        ['/opt/workflow-venv/bin/python', '-c', 'import tabulate'],
        60_000,
        'codespace',
        '/workspace',
      );
      expect(importResult.exitCode).toBe(0);
    }

    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });
    const gates = await waitForGate(raiseGate, 2, 180_000);
    expect(gates[1].stateName).toBe('final_review');
    expect(gates[1].presentedArtifacts.has('final_report')).toBe(true);
    orchestrator.resolveGate(workflowId, { type: 'APPROVE' });

    await waitForCompletion(orchestrator, workflowId, 180_000);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    await orchestrator.shutdownAll();

    expect(preflightTurns).toBe(1);
    expect(provisionTurns).toBe(1);
    expect(finalSummaryTurns).toBe(1);
    return {
      states,
      workspaceDir: effectiveWorkspaceDir,
      bundleDir: currentBundleDir,
      markerMtimeAfterProvision,
      markerContentAfterProvision,
      tabulateAuditAfterProvision,
      provisionTurns,
    };
  }

  it('provisions a synthetic experiment dependency, evaluates real candidates, improves, and reaches done', async () => {
    const run = await runHarness({ label: 'synthetic', experiment: true, explicitWorkspace: true });
    const runDir = resolve(run.workspaceDir, '.evolve_runs', 'main');
    const markerPath = resolve(runDir, '.provisioned');

    expect(run.states.at(-1)).toBe('done');
    expect(run.states[0]).toBe('provision');
    expect(run.states[1]).toBe('preflight');
    expect(run.states).toContain('final_review');
    expect(countStates(run.states, 'provision')).toBe(1);
    expect(run.provisionTurns).toBe(1);
    expect(readFileSync(markerPath, 'utf-8')).toBe(run.markerContentAfterProvision);
    expect(statSync(markerPath).mtimeMs).toBe(run.markerMtimeAfterProvision);
    expect(countTabulateAudit(run.bundleDir)).toBe(run.tabulateAuditAfterProvision);

    const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as NodesFile;
    expect(nodes.next_id).toBe(ROUND_COUNT);
    expect(Object.keys(nodes.nodes)).toEqual(['0', '1', '2']);
    const scores = Object.keys(nodes.nodes)
      .sort()
      .map((id) => nodes.nodes[id].score);
    expect(scores).toEqual([1, 2, 3]);
    expect(scores[2]).toBeGreaterThan(scores[0]);
    for (const node of Object.values(nodes.nodes)) {
      expect(Number.isFinite(node.score)).toBe(true);
      if (node.id > 0) {
        expect(node.parent.length).toBeGreaterThan(0);
        expect(node.parent[0]).toBeLessThan(node.id);
      }
    }
    const finalResult = readJson(resolve(runDir, 'current', 'result.json')) as {
      payload: { score: number };
    };
    expect(finalResult.payload.score).toBe(3);
  }, 300_000);

  it('still reaches done for a toy run with no explicit workspace experiment', async () => {
    const run = await runHarness({ label: 'toy', experiment: false, explicitWorkspace: false });
    const runDir = resolve(run.workspaceDir, '.evolve_runs', 'main');

    expect(run.states.at(-1)).toBe('done');
    expect(run.states[0]).toBe('provision');
    expect(run.states[1]).toBe('preflight');
    expect(countStates(run.states, 'provision')).toBe(1);
    const nodes = readJson(resolve(runDir, 'database_data', 'nodes.json')) as NodesFile;
    expect(Object.keys(nodes.nodes)).toEqual(['0']);
    expect(nodes.nodes['0'].score).toBe(1);
  }, 240_000);
});
