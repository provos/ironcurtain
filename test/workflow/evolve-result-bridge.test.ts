import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { validateDefinition } from '../../src/workflow/validate.js';
import { lintWorkflow } from '../../src/workflow/lint.js';

const PYTHON = process.env.PYTHON ?? 'python3';
const WORKFLOW_DIR = resolve(__dirname, '..', '..', 'src', 'workflow', 'workflows', 'evolve');
const BRIDGE_PATH = resolve(WORKFLOW_DIR, 'scripts', 'evolve_result.py');

describe('evolve workflow manifest', () => {
  it('validates and lints cleanly', () => {
    const manifestPath = resolve(WORKFLOW_DIR, 'workflow.yaml');
    const raw = parseYaml(readFileSync(manifestPath, 'utf-8'), { maxAliasCount: 0 });
    const def = validateDefinition(raw);
    const diagnostics = lintWorkflow(def, { personaExists: () => false, workflowFilePath: manifestPath });

    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(diagnostics).toEqual([]);
    expect(diagnostics.map((d) => d.code)).not.toContain('WF011');
    expect(diagnostics.map((d) => d.code)).not.toContain('WF012');
  });

  it('manifest wires the multi-round hub and confirmed run-spec fields', () => {
    const manifestPath = resolve(WORKFLOW_DIR, 'workflow.yaml');
    const raw = parseYaml(readFileSync(manifestPath, 'utf-8'), { maxAliasCount: 0 }) as {
      settings: { maxRounds: number };
      states: {
        preflight: {
          prompt: string;
          outputs: string[];
          transitions: Array<{ to: string; when?: { verdict?: string } }>;
        };
        orchestrator: {
          prompt: string;
          transitions: Array<{ to: string; guard?: string; when?: { verdict?: string } }>;
        };
        evaluate: { transitions: Array<{ to: string; when?: { verdict?: string } }> };
        researcher: { transitions: Array<{ to: string }> };
        analyzer: { transitions: Array<{ to: string }> };
        preflight_review: {
          type: string;
          present: string[];
          acceptedEvents: string[];
          transitions: Array<{ to: string; event: string }>;
        };
        human_escalation: {
          type: string;
          present: string[];
          acceptedEvents: string[];
          transitions: Array<{ to: string; event: string }>;
        };
        final_summary: { type: string; prompt: string; outputs: string[]; transitions: Array<{ to: string }> };
        final_review: {
          type: string;
          present: string[];
          acceptedEvents: string[];
          transitions: Array<{ to: string; event: string }>;
        };
        aborted: { type: string };
      };
    };
    const prompt = raw.states.preflight.prompt;

    expect(raw.settings.maxRounds).toBe(200);
    expect(raw.states.preflight.outputs).toEqual(['run_spec', 'cognition_seed']);
    expect(raw.states.preflight.transitions[0]).toMatchObject({ to: 'preflight_review', when: { verdict: 'ready' } });
    expect(raw.states.orchestrator.transitions[0]).toEqual({ to: 'failed', guard: 'isRoundLimitReached' });
    expect(raw.states.orchestrator.transitions.map((t) => t.when?.verdict).filter(Boolean)).toEqual([
      'design',
      'evaluate',
      'analyze',
      'record',
      'complete',
      'escalate',
    ]);
    expect(raw.states.orchestrator.transitions.find((t) => t.when?.verdict === 'complete')?.to).toBe('final_summary');
    expect(raw.states.orchestrator.transitions.find((t) => t.when?.verdict === 'escalate')?.to).toBe(
      'human_escalation',
    );
    expect(raw.states.evaluate.transitions.find((t) => t.when?.verdict === 'evaluator_blocked')?.to).toBe(
      'human_escalation',
    );
    expect(raw.states.researcher.transitions).toEqual([{ to: 'orchestrator' }]);
    expect(raw.states.analyzer.transitions).toEqual([{ to: 'orchestrator' }]);
    expect(raw.states.preflight_review).toMatchObject({
      type: 'human_gate',
      acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
      present: ['run_spec', 'cognition_seed'],
    });
    expect(raw.states.preflight_review.transitions.map((t) => [t.event, t.to])).toEqual([
      ['APPROVE', 'orchestrator'],
      ['FORCE_REVISION', 'preflight'],
      ['ABORT', 'aborted'],
    ]);
    expect(raw.states.human_escalation).toMatchObject({
      type: 'human_gate',
      acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
      present: ['run_spec'],
    });
    expect(raw.states.final_summary).toMatchObject({
      type: 'agent',
      outputs: ['final_report'],
      transitions: [{ to: 'final_review' }],
    });
    expect(raw.states.final_review).toMatchObject({
      type: 'human_gate',
      acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
      present: ['final_report'],
    });
    expect(raw.states.final_review.transitions.map((t) => [t.event, t.to])).toEqual([
      ['APPROVE', 'done'],
      ['FORCE_REVISION', 'orchestrator'],
      ['ABORT', 'aborted'],
    ]);
    expect(raw.states.aborted.type).toBe('terminal');

    for (const flag of [
      '--workspace-root /workspace',
      '--run-name main',
      '--objective "OBJECTIVE"',
      '--core-score eval_score',
      '--evaluation-command "EVAL_CMD"',
      '--evaluation-timeout-secs EVAL_TIMEOUT_SECS',
      '--success-criterion "SUCCESS_CRITERION"',
      '--max-rounds MAX_ROUNDS',
      '--patience 2',
      '--stop-condition "max_rounds"',
      '--writable-path .evolve_runs',
      '--primary-target PRIMARY_TARGET',
      '--sampling-algorithm greedy',
      '--sample-n 1',
      '--cognition-source-mode seed',
      '--confirmed true',
    ]) {
      expect(prompt).toContain(flag);
    }
    expect(prompt).toContain('runpy.run_path');
    expect(prompt).toContain('importlib.util.spec_from_file_location');
    expect(prompt).toContain('/workspace/.workflow/run_spec/run_spec.md');
    expect(prompt).toContain('/workspace/.workflow/cognition_seed/cognition_seed.md');
    expect(prompt).toContain('FIRST success_criteria entry');
    expect(prompt).toContain('canonical <core_score> <comparator> <number> form');
    expect(prompt).not.toContain('not a hard gate');
    expect(prompt).not.toContain('the run stops on max_rounds');
    expect(raw.states.orchestrator.prompt).toContain('stop_signals.json');
    expect(raw.states.orchestrator.prompt).toContain('precomputed stop_reason');
    expect(raw.states.final_summary.prompt).toContain('stop_signals.json');
    expect(raw.states.final_summary.prompt).toContain('The stop reason from stop_signals.json');
    // The seed consumes a node-count slot, so a seeded run must add 1 to max-rounds.
    expect(prompt).toContain('add 1 to MAX_ROUNDS');
  });
});

describe('evolve_result.py bridge', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'evolve-result-bridge-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeHarness(opts: { evalStub?: string; dbStub?: string; cognitionStub?: string }): string {
    const scriptsDir = resolve(tmpDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    cpSync(BRIDGE_PATH, resolve(scriptsDir, 'evolve_result.py'));
    writeFileSync(
      resolve(scriptsDir, 'evolve-eval'),
      opts.evalStub ??
        [
          'import json, sys',
          'from pathlib import Path',
          "run_dir = Path(sys.argv[sys.argv.index('--run-dir') + 1])",
          "step = sys.argv[sys.argv.index('--step-name') + 1]",
          "result = run_dir / 'steps' / step / 'results.json'",
          'result.parent.mkdir(parents=True, exist_ok=True)',
          "result.write_text(json.dumps({'eval_score': 6, 'success': True}), encoding='utf-8')",
          "print(json.dumps({'results_path': str(result), 'return_code': 0, 'step_dir': str(result.parent), 'success': True}))",
        ].join('\n') + '\n',
    );
    writeFileSync(
      resolve(scriptsDir, 'evolve-db'),
      opts.dbStub ??
        ['import json', "print(json.dumps({'node_id': 0, 'best_updated': True, 'step_dir': '/tmp/step'}))"].join('\n') +
          '\n',
    );
    writeFileSync(
      resolve(scriptsDir, 'evolve-cognition'),
      opts.cognitionStub ??
        [
          'import json',
          "print(json.dumps({'matches': [{'content': 'sum solve heuristic', 'score': 1.0, 'source': 'seed'}]}))",
        ].join('\n') + '\n',
    );
    return scriptsDir;
  }

  function runBridge(
    scriptsDir: string,
    args: readonly string[],
  ): { status: number | null; result: Record<string, unknown> } {
    const resultFile = resolve(tmpDir, 'result.json');
    const completed = spawnSync(
      PYTHON,
      [resolve(scriptsDir, 'evolve_result.py'), ...args, '--result-file', resultFile],
      {
        encoding: 'utf-8',
      },
    );
    if (completed.error) throw completed.error;
    expect(completed.stderr).toBe('');
    expect(existsSync(resultFile)).toBe(true);
    return {
      status: completed.status,
      result: JSON.parse(readFileSync(resultFile, 'utf-8')) as Record<string, unknown>,
    };
  }

  function evalArgs(runDir = resolve(tmpDir, 'run')): string[] {
    return ['evaluate', '--run-dir', runDir, '--step-name', 'step_0001', '--code-path', 'candidate.py'];
  }

  function writeRunSpec(runDir: string, objective = 'solve sum target evolve'): void {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      resolve(runDir, 'run_spec.yaml'),
      JSON.stringify({
        objective,
        budget: { max_rounds: 3, patience: 2 },
      }) + '\n',
    );
  }

  function writeStopRunSpec(runDir: string, opts: { criterion: string; maxRounds: number; patience: number }): void {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      resolve(runDir, 'run_spec.yaml'),
      JSON.stringify({
        objective: 'pin stop signal behavior',
        evaluation: {
          core_score: 'eval_score',
          success_criteria: [opts.criterion],
        },
        budget: { max_rounds: opts.maxRounds, patience: opts.patience },
      }) + '\n',
    );
  }

  function writeNodes(runDir: string, scores: readonly number[], stepOffset = 1): void {
    mkdirSync(resolve(runDir, 'database_data'), { recursive: true });
    const nodes = Object.fromEntries(
      scores.map((score, index) => {
        const id = index;
        const stepName = `step_${String(index + stepOffset).padStart(4, '0')}`;
        return [
          String(id),
          {
            id,
            name: `round-${index + stepOffset}`,
            parent: index === 0 ? [] : [index - 1],
            score,
            results: { eval_score: score },
            analysis: `analysis ${id}`,
            meta_info: { step_name: stepName },
          },
        ];
      }),
    );
    writeFileSync(resolve(runDir, 'database_data', 'nodes.json'), JSON.stringify({ next_id: scores.length, nodes }));
  }

  function attachForExistingStep(scriptsDir: string, runDir: string, stepName: string): Record<string, unknown> {
    mkdirSync(resolve(runDir, 'current'), { recursive: true });
    const analysisFile = resolve(runDir, 'current', 'analysis.md');
    writeFileSync(analysisFile, 'existing analysis\n');
    return runBridge(scriptsDir, [
      'attach_analysis',
      '--run-dir',
      runDir,
      '--step-name',
      stepName,
      '--analysis-file',
      analysisFile,
    ]).result;
  }

  function readStopSignals(runDir: string): Record<string, unknown> {
    return JSON.parse(readFileSync(resolve(runDir, 'current', 'stop_signals.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
  }

  it('maps a numeric eval_score to verdict evaluated', () => {
    const scriptsDir = writeHarness({});
    const { status, result } = runBridge(scriptsDir, evalArgs());

    expect(status).toBe(0);
    expect(result).toMatchObject({
      verdict: 'evaluated',
      passed: true,
      payload: { score: 6, return_code: 0, success: true },
    });
  });

  it('lets evolve-eval read timeout_secs from run_spec unless --timeout is explicit', () => {
    const scriptsDir = writeHarness({
      evalStub:
        [
          'import json, sys',
          'from pathlib import Path',
          "run_dir = Path(sys.argv[sys.argv.index('--run-dir') + 1])",
          "step = sys.argv[sys.argv.index('--step-name') + 1]",
          "result = run_dir / 'steps' / step / 'results.json'",
          'result.parent.mkdir(parents=True, exist_ok=True)',
          "(run_dir / 'argv.json').write_text(json.dumps(sys.argv), encoding='utf-8')",
          "result.write_text(json.dumps({'eval_score': 6, 'success': True}), encoding='utf-8')",
          "print(json.dumps({'results_path': str(result), 'return_code': 0, 'step_dir': str(result.parent), 'success': True}))",
        ].join('\n') + '\n',
    });

    const defaultRunDir = resolve(tmpDir, 'default-run');
    const explicitRunDir = resolve(tmpDir, 'explicit-run');

    expect(runBridge(scriptsDir, evalArgs(defaultRunDir)).result.verdict).toBe('evaluated');
    expect(JSON.parse(readFileSync(resolve(defaultRunDir, 'argv.json'), 'utf-8'))).not.toContain('--timeout');

    expect(runBridge(scriptsDir, [...evalArgs(explicitRunDir), '--timeout', '77']).result.verdict).toBe('evaluated');
    const explicitArgv = JSON.parse(readFileSync(resolve(explicitRunDir, 'argv.json'), 'utf-8')) as string[];
    expect(explicitArgv.slice(explicitArgv.indexOf('--timeout'), explicitArgv.indexOf('--timeout') + 2)).toEqual([
      '--timeout',
      '77',
    ]);
  });

  it('keeps a low numeric score as evaluated, not evaluator_blocked', () => {
    const scriptsDir = writeHarness({
      evalStub:
        [
          'import json, sys',
          'from pathlib import Path',
          "run_dir = Path(sys.argv[sys.argv.index('--run-dir') + 1])",
          "step = sys.argv[sys.argv.index('--step-name') + 1]",
          "result = run_dir / 'steps' / step / 'results.json'",
          'result.parent.mkdir(parents=True, exist_ok=True)',
          "result.write_text(json.dumps({'eval_score': 0, 'success': False}), encoding='utf-8')",
          "print(json.dumps({'results_path': str(result), 'return_code': 0, 'step_dir': str(result.parent), 'success': True}))",
        ].join('\n') + '\n',
    });

    const { result } = runBridge(scriptsDir, evalArgs());
    expect(result).toMatchObject({ verdict: 'evaluated', passed: true, payload: { score: 0 } });
  });

  it('maps evaluator subprocess failure to evaluator_blocked while exiting successfully', () => {
    const scriptsDir = writeHarness({
      evalStub:
        [
          'import json, sys',
          'from pathlib import Path',
          "run_dir = Path(sys.argv[sys.argv.index('--run-dir') + 1])",
          "step = sys.argv[sys.argv.index('--step-name') + 1]",
          "result = run_dir / 'steps' / step / 'results.json'",
          'result.parent.mkdir(parents=True, exist_ok=True)',
          "result.write_text(json.dumps({'eval_score': 0, 'success': False, 'error': 'boom'}), encoding='utf-8')",
          "print(json.dumps({'results_path': str(result), 'return_code': 1, 'step_dir': str(result.parent), 'success': False}))",
        ].join('\n') + '\n',
    });

    const { status, result } = runBridge(scriptsDir, evalArgs());
    expect(status).toBe(0);
    expect(result.verdict).toBe('evaluator_blocked');
    expect(result.passed).toBe(false);
  });

  it('maps evolve-eval wrapper failure to evaluator_blocked while exiting successfully', () => {
    const scriptsDir = writeHarness({
      evalStub: "import sys\nprint('preflight is incomplete', file=sys.stderr)\nsys.exit(5)\n",
    });

    const { status, result } = runBridge(scriptsDir, evalArgs());
    expect(status).toBe(0);
    expect(result.verdict).toBe('evaluator_blocked');
    expect(result.passed).toBe(false);
  });

  it('maps missing or nonnumeric results to evaluator_blocked', () => {
    const missingScripts = writeHarness({
      evalStub:
        [
          'import json, sys',
          'from pathlib import Path',
          "run_dir = Path(sys.argv[sys.argv.index('--run-dir') + 1])",
          "step = sys.argv[sys.argv.index('--step-name') + 1]",
          "result = run_dir / 'steps' / step / 'results.json'",
          "print(json.dumps({'results_path': str(result), 'return_code': 0, 'step_dir': str(result.parent), 'success': True}))",
        ].join('\n') + '\n',
    });
    expect(runBridge(missingScripts, evalArgs(resolve(tmpDir, 'missing-run'))).result.verdict).toBe(
      'evaluator_blocked',
    );

    const nonnumericScripts = writeHarness({
      evalStub:
        [
          'import json, sys',
          'from pathlib import Path',
          "run_dir = Path(sys.argv[sys.argv.index('--run-dir') + 1])",
          "step = sys.argv[sys.argv.index('--step-name') + 1]",
          "result = run_dir / 'steps' / step / 'results.json'",
          'result.parent.mkdir(parents=True, exist_ok=True)',
          "result.write_text(json.dumps({'eval_score': 'six'}), encoding='utf-8')",
          "print(json.dumps({'results_path': str(result), 'return_code': 0, 'step_dir': str(result.parent), 'success': True}))",
        ].join('\n') + '\n',
    });
    expect(runBridge(nonnumericScripts, evalArgs(resolve(tmpDir, 'nonnumeric-run'))).result.verdict).toBe(
      'evaluator_blocked',
    );
  });

  it('maps record success and failure to recorded/needs_repair verdicts', () => {
    const successScripts = writeHarness({});
    const success = runBridge(successScripts, [
      'record',
      '--run-dir',
      resolve(tmpDir, 'run'),
      '--step-name',
      'step_0001',
      '--name',
      'round-1',
      '--code-path',
      'candidate.py',
      '--results-file',
      'results.json',
    ]);

    expect(success.status).toBe(0);
    expect(success.result).toMatchObject({
      verdict: 'recorded',
      passed: true,
      payload: { node_id: 0, best_updated: true },
    });

    const failureScripts = writeHarness({
      dbStub: "import sys\nprint('db failed', file=sys.stderr)\nsys.exit(7)\n",
    });
    const failure = runBridge(failureScripts, [
      'record',
      '--run-dir',
      resolve(tmpDir, 'run2'),
      '--step-name',
      'step_0001',
      '--name',
      'round-1',
      '--code-path',
      'candidate.py',
      '--results-file',
      'results.json',
    ]);

    expect(failure.status).toBe(0);
    expect(failure.result.verdict).toBe('needs_repair');
    expect(failure.result.passed).toBe(false);
  });

  it('computes target-met stop signals after the recorded node and gives target precedence', () => {
    const scriptsDir = writeHarness({});
    const runDir = resolve(tmpDir, 'target-stop-run');
    writeStopRunSpec(runDir, { criterion: 'eval_score >= 2', maxRounds: 3, patience: 1 });
    writeNodes(runDir, [1, 3, 3]);

    const result = attachForExistingStep(scriptsDir, runDir, 'step_0003');
    const signals = readStopSignals(runDir);

    expect(result).toMatchObject({
      verdict: 'recorded',
      passed: true,
      payload: { node_id: 2, idempotent_skip: true, stop_reason: 'target_met' },
    });
    expect(signals).toMatchObject({
      best_score: 3,
      best_node_id: 1,
      target_met: true,
      patience_exceeded: true,
      done_rounds: 3,
      max_rounds: 3,
      stop_reason: 'target_met',
    });
    expect(signals.target).toMatchObject({
      metric: 'eval_score',
      comparator: '>=',
      threshold: 2,
      raw: 'eval_score >= 2',
    });
  });

  it('rejects <= success criteria for maximize-only stop targets', () => {
    const scriptsDir = writeHarness({});
    const runDir = resolve(tmpDir, 'reject-target-run');
    writeStopRunSpec(runDir, { criterion: 'eval_score <= 2', maxRounds: 5, patience: 0 });
    writeNodes(runDir, [1]);

    attachForExistingStep(scriptsDir, runDir, 'step_0001');
    const signals = readStopSignals(runDir);

    expect(signals).toMatchObject({
      target: null,
      target_met: false,
      stop_reason: null,
    });
    expect(signals.target_parse_warning).toContain('unsupported maximize-only comparator');
  });

  it('counts patience plateaus from the node-0 baseline', () => {
    const scriptsDir = writeHarness({});
    const runDir = resolve(tmpDir, 'patience-stop-run');
    writeStopRunSpec(runDir, { criterion: 'eval_score >= 99', maxRounds: 10, patience: 2 });
    writeNodes(runDir, [1, 2, 2, 2]);

    attachForExistingStep(scriptsDir, runDir, 'step_0004');
    const signals = readStopSignals(runDir);

    expect(signals).toMatchObject({
      best_score: 2,
      best_node_id: 1,
      rounds_since_improvement: 2,
      target_met: false,
      patience_exceeded: true,
      stop_reason: 'patience',
    });
  });

  it('uses max_rounds only after target and patience do not stop the run', () => {
    const scriptsDir = writeHarness({});
    const runDir = resolve(tmpDir, 'max-rounds-stop-run');
    writeStopRunSpec(runDir, { criterion: 'eval_score >= 99', maxRounds: 3, patience: 0 });
    writeNodes(runDir, [1, 2, 3]);

    attachForExistingStep(scriptsDir, runDir, 'step_0003');
    const signals = readStopSignals(runDir);

    expect(signals).toMatchObject({
      target_met: false,
      patience_exceeded: false,
      done_rounds: 3,
      max_rounds: 3,
      stop_reason: 'max_rounds',
    });
  });

  it('finds an already-recorded analysis node by step_name instead of appending a duplicate', () => {
    const dbStub = [
      'import json, sys',
      'from pathlib import Path',
      "run_dir = Path(sys.argv[sys.argv.index('--run-dir') + 1])",
      "step_name = sys.argv[sys.argv.index('--step-name') + 1]",
      "results_file = Path(sys.argv[sys.argv.index('--results-file') + 1])",
      "results = json.loads(results_file.read_text(encoding='utf-8'))",
      "nodes_path = run_dir / 'database_data' / 'nodes.json'",
      'nodes_path.parent.mkdir(parents=True, exist_ok=True)',
      "data = json.loads(nodes_path.read_text(encoding='utf-8')) if nodes_path.exists() else {'next_id': 0, 'nodes': {}}",
      "node_id = int(data.get('next_id', 0))",
      'parents = []',
      'for index, value in enumerate(sys.argv):',
      "    if value == '--parent':",
      '        parents.append(int(sys.argv[index + 1]))',
      "node = {'id': node_id, 'name': 'round-1', 'parent': parents, 'score': float(results['eval_score']), 'results': results, 'analysis': 'lesson', 'meta_info': {'step_name': step_name}}",
      "data['nodes'][str(node_id)] = node",
      "data['next_id'] = node_id + 1",
      "nodes_path.write_text(json.dumps(data), encoding='utf-8')",
      "(run_dir / 'record-calls.txt').open('a', encoding='utf-8').write(step_name + '\\n')",
      "print(json.dumps({'node_id': node_id, 'best_updated': True, 'step_dir': str(run_dir / 'steps' / step_name)}))",
    ].join('\n');
    const scriptsDir = writeHarness({ dbStub: dbStub + '\n' });
    const runDir = resolve(tmpDir, 'dedup-run');
    writeStopRunSpec(runDir, { criterion: 'eval_score >= 99', maxRounds: 3, patience: 2 });
    mkdirSync(resolve(runDir, 'current'), { recursive: true });
    mkdirSync(resolve(runDir, 'steps', 'step_0001'), { recursive: true });
    const analysisFile = resolve(runDir, 'current', 'analysis.md');
    const resultsFile = resolve(runDir, 'steps', 'step_0001', 'results.json');
    writeFileSync(analysisFile, 'lesson\n');
    writeFileSync(resolve(runDir, 'steps', 'step_0001', 'code'), 'def score():\n    return 1\n');
    writeFileSync(resultsFile, JSON.stringify({ eval_score: 7 }) + '\n');

    const args = [
      'attach_analysis',
      '--run-dir',
      runDir,
      '--step-name',
      'step_0001',
      '--name',
      'round-1',
      '--parent',
      '0',
      '--code-path',
      'candidate.py',
      '--results-file',
      resultsFile,
      '--analysis-file',
      analysisFile,
    ];
    const first = runBridge(scriptsDir, args);
    const second = runBridge(scriptsDir, args);
    const nodes = JSON.parse(readFileSync(resolve(runDir, 'database_data', 'nodes.json'), 'utf-8')) as {
      nodes: Record<string, unknown>;
    };

    expect(first.result).toMatchObject({ verdict: 'recorded', payload: { node_id: 0 } });
    expect(second.result).toMatchObject({
      verdict: 'recorded',
      payload: { node_id: 0, idempotent_skip: true },
    });
    expect(Object.keys(nodes.nodes)).toEqual(['0']);
    expect(readFileSync(resolve(runDir, 'record-calls.txt'), 'utf-8').trim().split('\n')).toEqual(['step_0001']);
  });

  it('pins PYTHONHASHSEED for engine subprocesses', () => {
    const evalStub = [
      'import json, sys',
      'from pathlib import Path',
      "run_dir = Path(sys.argv[sys.argv.index('--run-dir') + 1])",
      "step = sys.argv[sys.argv.index('--step-name') + 1]",
      "result = run_dir / 'steps' / step / 'results.json'",
      'result.parent.mkdir(parents=True, exist_ok=True)',
      "score = hash('evolve')",
      "result.write_text(json.dumps({'eval_score': score, 'success': True}), encoding='utf-8')",
      "print(json.dumps({'results_path': str(result), 'return_code': 0, 'step_dir': str(result.parent), 'success': True}))",
    ].join('\n');
    const scriptsDir = writeHarness({ evalStub: evalStub + '\n' });

    const first = runBridge(scriptsDir, evalArgs(resolve(tmpDir, 'hash-run-1'))).result;
    const second = runBridge(scriptsDir, evalArgs(resolve(tmpDir, 'hash-run-2'))).result;
    expect((first.payload as { score: number }).score).toBe((second.payload as { score: number }).score);
  });

  it('fails loudly when neither flag of a resolver pair is supplied', () => {
    const scriptsDir = writeHarness({});
    // `evaluate` without --step-name and without --step-from-current: the resolver
    // must reject the misconfiguration with a clear message instead of dereferencing None.
    const completed = spawnSync(
      PYTHON,
      [
        resolve(scriptsDir, 'evolve_result.py'),
        'evaluate',
        '--run-dir',
        resolve(tmpDir, 'guard-run'),
        '--code-path',
        'candidate.py',
        '--result-file',
        resolve(tmpDir, 'guard-result.json'),
      ],
      { encoding: 'utf-8' },
    );
    expect(completed.status).not.toBe(0);
    expect(completed.stderr).toContain('--step-name or --step-from-current is required');
  });

  it('samples a parent, seeds cognition on first entry, and writes current context', () => {
    const runDir = resolve(tmpDir, 'sample-run');
    writeRunSpec(runDir);
    mkdirSync(resolve(runDir, 'database_data'), { recursive: true });
    writeFileSync(
      resolve(runDir, 'database_data', 'nodes.json'),
      JSON.stringify({
        next_id: 1,
        nodes: { '0': { id: 0, code: 'def solve(xs): return 3', score: 3, analysis: 'prior lesson' } },
      }),
    );
    writeFileSync(
      resolve(runDir, 'cognition_seed.md'),
      [
        '```json',
        '[{"content":"solve sum target evolve by moving toward six","source":"test","metadata":{"kind":"heuristic"}}]',
        '```',
        '',
      ].join('\n'),
    );
    const dbStub = [
      'import json, sys',
      'from pathlib import Path',
      "run_dir = Path(sys.argv[sys.argv.index('--run-dir') + 1])",
      "(run_dir / 'calls.txt').open('a', encoding='utf-8').write('db sample\\n')",
      "print(json.dumps({'nodes': [{'id': 0, 'code': 'def solve(xs): return 3', 'score': 3, 'analysis': 'prior lesson'}]}))",
    ].join('\n');
    const cognitionStub = [
      'import json, sys',
      'from pathlib import Path',
      "run_dir = Path(sys.argv[sys.argv.index('--run-dir') + 1])",
      'command = sys.argv[1]',
      "(run_dir / 'calls.txt').open('a', encoding='utf-8').write('cognition ' + command + '\\n')",
      "data = run_dir / 'cognition_data' / 'cognition.json'",
      'data.parent.mkdir(parents=True, exist_ok=True)',
      "if command == 'init':",
      "    data.write_text(json.dumps({'items': {'seed': {'content': 'solve sum target evolve', 'source': 'test'}}}), encoding='utf-8')",
      "    print(json.dumps({'items_added': 1, 'total_items': 1}))",
      'else:',
      "    print(json.dumps({'matches': [{'content': 'solve sum target evolve', 'score': 1.0, 'source': 'test'}]}))",
    ].join('\n');
    const scriptsDir = writeHarness({ dbStub: dbStub + '\n', cognitionStub: cognitionStub + '\n' });
    const contextFile = resolve(runDir, 'current', 'context.json');
    mkdirSync(resolve(runDir, 'current'), { recursive: true });
    writeFileSync(resolve(runDir, 'current', 'result.json'), '{"verdict":"old"}\n');
    writeFileSync(resolve(runDir, 'current', 'analysis.md'), 'old analysis\n');
    writeFileSync(resolve(runDir, 'current', 'analysis_record.json'), '{"verdict":"old"}\n');

    const { result } = runBridge(scriptsDir, [
      'sample',
      '--run-dir',
      runDir,
      '--query-from-spec',
      '--context-file',
      contextFile,
    ]);

    expect(result).toMatchObject({ verdict: 'sampled', passed: true });
    expect(readFileSync(resolve(runDir, 'calls.txt'), 'utf-8').trim().split('\n')).toEqual([
      'cognition init',
      'db sample',
      'cognition search',
    ]);
    const context = JSON.parse(readFileSync(contextFile, 'utf-8')) as {
      step_name: string;
      parent: { id: number };
      cognition: { matches: Array<{ content: string }> };
    };
    expect(context.step_name).toBe('step_0002');
    expect(context.parent.id).toBe(0);
    expect(context.cognition.matches).toHaveLength(1);
    expect(existsSync(resolve(runDir, 'current', 'result.json'))).toBe(false);
    expect(existsSync(resolve(runDir, 'current', 'analysis.md'))).toBe(false);
    expect(existsSync(resolve(runDir, 'current', 'analysis_record.json'))).toBe(false);
  });

  it('samples with an empty DB without reseeding a non-empty cognition store', () => {
    const runDir = resolve(tmpDir, 'empty-sample-run');
    writeRunSpec(runDir);
    mkdirSync(resolve(runDir, 'cognition_data'), { recursive: true });
    writeFileSync(
      resolve(runDir, 'cognition_data', 'cognition.json'),
      JSON.stringify({ items: { existing: { content: 'solve sum target evolve', source: 'test' } } }),
    );
    const dbStub = "import json\nprint(json.dumps({'nodes': []}))\n";
    const scriptsDir = writeHarness({ dbStub });
    const contextFile = resolve(runDir, 'current', 'context.json');

    const { result } = runBridge(scriptsDir, [
      'sample',
      '--run-dir',
      runDir,
      '--query-from-spec',
      '--context-file',
      contextFile,
    ]);

    expect(result).toMatchObject({ verdict: 'sampled', passed: true });
    const context = JSON.parse(readFileSync(contextFile, 'utf-8')) as { step_name: string; parent: unknown };
    expect(context.step_name).toBe('step_0001');
    expect(context.parent).toBeNull();
  });

  it('resolves current-round flags for evaluate', () => {
    const runDir = resolve(tmpDir, 'workspace', '.evolve_runs', 'main');
    mkdirSync(resolve(runDir, 'current'), { recursive: true });
    writeFileSync(resolve(runDir, 'current', 'step_name'), 'step_0003\n');
    const evalStub = [
      'import json, sys',
      'from pathlib import Path',
      "run_dir = Path(sys.argv[sys.argv.index('--run-dir') + 1])",
      "Path(run_dir / 'eval-argv.json').write_text(json.dumps(sys.argv), encoding='utf-8')",
      "step = sys.argv[sys.argv.index('--step-name') + 1]",
      "result = run_dir / 'steps' / step / 'results.json'",
      'result.parent.mkdir(parents=True, exist_ok=True)',
      "result.write_text(json.dumps({'eval_score': 4, 'success': True}), encoding='utf-8')",
      "print(json.dumps({'results_path': str(result), 'return_code': 0, 'step_dir': str(result.parent), 'success': True}))",
    ].join('\n');
    const scriptsDir = writeHarness({ evalStub: evalStub + '\n' });

    const { result } = runBridge(scriptsDir, [
      'evaluate',
      '--run-dir',
      runDir,
      '--step-from-current',
      '--code-from-current',
    ]);

    const capturedArgs = readFileSync(resolve(runDir, 'eval-argv.json'), 'utf-8');
    const argv = JSON.parse(capturedArgs) as string[];
    expect(result).toMatchObject({ verdict: 'evaluated', passed: true });
    expect(argv).toEqual(expect.arrayContaining(['--step-name', 'step_0003']));
    expect(argv).toEqual(expect.arrayContaining(['--code-path', '.evolve_runs/main/steps/step_0003/code']));
  });

  it('attaches analysis with the sampled parent and omits parent when context has none', () => {
    const dbStub = [
      'import json, sys',
      'from pathlib import Path',
      "run_dir = Path(sys.argv[sys.argv.index('--run-dir') + 1])",
      "Path(run_dir / 'record-argv.json').write_text(json.dumps(sys.argv), encoding='utf-8')",
      "print(json.dumps({'node_id': 1, 'best_updated': True, 'step_dir': '/tmp/step'}))",
    ].join('\n');
    const scriptsDir = writeHarness({ dbStub: dbStub + '\n' });

    const runDir = resolve(tmpDir, 'attach-run');
    mkdirSync(resolve(runDir, 'current'), { recursive: true });
    writeFileSync(resolve(runDir, 'current', 'step_name'), 'step_0002\n');
    writeFileSync(
      resolve(runDir, 'current', 'context.json'),
      JSON.stringify({ step_name: 'step_0002', parent: { id: 0 } }),
    );
    writeFileSync(resolve(runDir, 'current', 'analysis.md'), 'lesson\n');

    const recorded = runBridge(scriptsDir, [
      'attach_analysis',
      '--run-dir',
      runDir,
      '--step-from-current',
      '--name-from-current',
      '--parent-from-current',
      '--code-from-current',
      '--results-from-current',
      '--analysis-file',
      resolve(runDir, 'current', 'analysis.md'),
    ]);

    const argv = JSON.parse(readFileSync(resolve(runDir, 'record-argv.json'), 'utf-8')) as string[];
    expect(recorded.result).toMatchObject({ verdict: 'recorded', passed: true });
    expect(argv).toContain('--analysis-file');
    expect(argv).toContain('--parent');
    expect(argv).toContain('0');
    expect(argv).toContain('round-2');

    writeFileSync(resolve(runDir, 'current', 'context.json'), JSON.stringify({ step_name: 'step_0002', parent: null }));
    runBridge(scriptsDir, [
      'attach_analysis',
      '--run-dir',
      runDir,
      '--step-from-current',
      '--name-from-current',
      '--parent-from-current',
      '--code-from-current',
      '--results-from-current',
      '--analysis-file',
      resolve(runDir, 'current', 'analysis.md'),
    ]);
    const noParentArgv = JSON.parse(readFileSync(resolve(runDir, 'record-argv.json'), 'utf-8')) as string[];
    expect(noParentArgv).not.toContain('--parent');
  });
});
