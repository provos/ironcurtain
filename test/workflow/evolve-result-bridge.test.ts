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
    expect(diagnostics.map((d) => d.code)).not.toContain('WF011');
    expect(diagnostics.map((d) => d.code)).not.toContain('WF012');
  });

  it('preflight prompt supplies the required confirmed run-spec fields', () => {
    const manifestPath = resolve(WORKFLOW_DIR, 'workflow.yaml');
    const raw = parseYaml(readFileSync(manifestPath, 'utf-8'), { maxAliasCount: 0 }) as {
      states: { preflight: { prompt: string } };
    };
    const prompt = raw.states.preflight.prompt;

    for (const flag of [
      '--workspace-root /workspace',
      '--run-name main',
      '--objective "OBJECTIVE"',
      '--core-score eval_score',
      '--evaluation-command "EVAL_CMD"',
      '--evaluation-timeout-secs 30',
      '--success-criterion "eval_score >= 1.0"',
      '--max-rounds 1',
      '--patience 1',
      '--stop-condition "max_rounds"',
      '--writable-path .evolve_runs',
      '--primary-target candidate.py',
      '--sampling-algorithm greedy',
      '--sample-n 1',
      '--cognition-source-mode none',
      '--confirmed true',
    ]) {
      expect(prompt).toContain(flag);
    }
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

  function writeHarness(opts: { evalStub?: string; dbStub?: string }): string {
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
});
