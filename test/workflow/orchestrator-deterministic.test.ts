import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DETERMINISTIC_RESULT_ERROR_VERDICT,
  type WorkflowDefinition,
  type WorkflowId,
} from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import type { DockerExecResult } from '../../src/docker/types.js';
import type { DeterministicInvokeInput, DeterministicInvokeResult } from '../../src/workflow/machine-builder.js';
import { WorkflowOrchestrator } from '../../src/workflow/orchestrator.js';
import { createDeps } from './test-helpers.js';

// ---------------------------------------------------------------------------
// Focused unit tests for the deterministic-execution dispatch in
// IronCurtainWorkflowOrchestrator. The methods under test
// (`executeDeterministicState`, `runDeterministicHost`,
// `runDeterministicInContainer`) are private; we drive them directly via
// bracket access on the orchestrator and register a synthetic
// WorkflowInstance into the private `workflows` map. This is the focused
// unit-test seam the design's §11 #3/#4/#10 prescribe — no full XState
// machine is spun up because the dispatch logic is independent of the FSM.
// ---------------------------------------------------------------------------

// A WorkflowId is a branded string; cast a plain string for tests.
const WF_ID = 'wf-deterministic-test' as WorkflowId;

const sharedContainerDef: WorkflowDefinition = {
  name: 'deterministic-dispatch',
  description: 'Docker shared-container workflow with a container deterministic state',
  initial: 'work',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    work: {
      type: 'agent',
      description: 'mints the bundle',
      persona: 'global',
      prompt: 'work',
      inputs: [],
      outputs: ['result'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

/**
 * Builds a stub DockerInfrastructure with a mocked `docker.exec`. The
 * orchestrator only touches `containerId` and `docker.exec` on the
 * deterministic-in-container path; everything else is irrelevant.
 */
function makeStubBundle(
  containerId: string,
  exec: (
    nameOrId: string,
    command: readonly string[],
    timeoutMs?: number,
    execUser?: string | null,
    workdir?: string,
  ) => Promise<DockerExecResult>,
): { bundle: DockerInfrastructure; exec: ReturnType<typeof vi.fn> } {
  const execMock = vi.fn(exec);
  const bundle = {
    containerId,
    docker: { exec: execMock },
  } as unknown as DockerInfrastructure;
  return { bundle, exec: execMock };
}

/**
 * Registers a minimal synthetic WorkflowInstance into the orchestrator's
 * private `workflows` map so `executeDeterministicState` can resolve it.
 * Only the fields the dispatch path reads are populated; the rest are
 * irrelevant for these focused unit tests.
 */
function registerInstance(
  orchestrator: WorkflowOrchestrator,
  definition: WorkflowDefinition,
  bundlesByScope: Map<string, DockerInfrastructure>,
  workspacePath: string,
): void {
  const instance = {
    id: WF_ID,
    definition,
    bundlesByScope,
    workspacePath,
    aborted: false,
  };
  // Private map; bracket access is the focused-unit-test seam.
  (orchestrator as unknown as { workflows: Map<WorkflowId, unknown> }).workflows.set(WF_ID, instance);
}

function callApplyResultFile(
  orchestrator: WorkflowOrchestrator,
  workspacePath: string,
  input: DeterministicInvokeInput,
  base: DeterministicInvokeResult,
): DeterministicInvokeResult {
  return (
    orchestrator as unknown as {
      applyResultFile: (
        instance: { workspacePath: string },
        input: DeterministicInvokeInput,
        base: DeterministicInvokeResult,
      ) => DeterministicInvokeResult;
    }
  ).applyResultFile({ workspacePath }, input, base);
}

/** Invokes the private executeDeterministicState through bracket access. */
function callExecuteDeterministicState(
  orchestrator: WorkflowOrchestrator,
  workflowId: WorkflowId,
  input: DeterministicInvokeInput,
): Promise<DeterministicInvokeResult> {
  return (
    orchestrator as unknown as {
      executeDeterministicState: (
        id: WorkflowId,
        input: DeterministicInvokeInput,
      ) => Promise<DeterministicInvokeResult>;
    }
  ).executeDeterministicState(workflowId, input);
}

describe('WorkflowOrchestrator deterministic execution dispatch', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'deterministic-dispatch-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // §11 #3 + #10 — host-branch dispatch + byte-identity backward-compat gate
  // -------------------------------------------------------------------------

  describe('host branch (container absent/false)', () => {
    it('routes to the host branch and never touches docker when container is absent', async () => {
      const exec = vi.fn(async (): Promise<DockerExecResult> => ({ exitCode: 0, stdout: '', stderr: '' }));
      const bundles = new Map<string, DockerInfrastructure>([['primary', makeStubBundle('cid', exec).bundle]]);
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, bundles, tmpDir);

      // A real host command that prints a stdout test-count line. `node -e`
      // exercises the actual execFileAsync path (no execFile mocking).
      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['node', '-e', "process.stdout.write('7 tests pass')"]],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        // container omitted entirely (the default backward-compat path)
      });

      expect(result).toEqual({ passed: true, testCount: 7, errors: undefined });
      expect(exec).not.toHaveBeenCalled();
    });

    it('host success path: passed true, no testCount when stdout lacks the regex', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['node', '-e', "process.stdout.write('all good')"]],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: false,
      });

      expect(result).toEqual({ passed: true, testCount: undefined, errors: undefined });
    });

    it('host failure path: non-zero exit captures stderr into errors and flips passed', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['node', '-e', "process.stderr.write('boom'); process.exit(1)"]],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: false,
      });

      expect(result.passed).toBe(false);
      expect(result.testCount).toBeUndefined();
      expect(result.errors).toContain('boom');
    });

    it('host test-count regex sums across commands', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map(), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [
          ['node', '-e', "process.stdout.write('3 tests pass')"],
          ['node', '-e', "process.stdout.write('4 specs pass')"],
        ],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: false,
      });

      expect(result).toEqual({ passed: true, testCount: 7, errors: undefined });
    });
  });

  // -------------------------------------------------------------------------
  // §11 #3 + #4 — container-branch dispatch + runDeterministicInContainer
  // -------------------------------------------------------------------------

  describe('container branch (container: true)', () => {
    it('routes to the live bundle and calls docker.exec with the verbatim argv, workdir, and user', async () => {
      const { bundle, exec } = makeStubBundle('container-xyz', async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
      }));
      const bundles = new Map<string, DockerInfrastructure>([['primary', bundle]]);
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, bundles, tmpDir);

      await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['python', '/workflow-scripts/run_eval.py', '--json']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
        timeoutMs: 4242,
      });

      expect(exec).toHaveBeenCalledTimes(1);
      // (containerId, verbatim argv, timeoutMs, 'codespace', '/workspace')
      expect(exec).toHaveBeenCalledWith(
        'container-xyz',
        ['python', '/workflow-scripts/run_eval.py', '--json'],
        4242,
        'codespace',
        '/workspace',
      );
      // No shell wrapper: the argv has no `sh`/`-c` tokens.
      const argv = exec.mock.calls[0][1] as string[];
      expect(argv[0]).toBe('python');
      expect(argv).not.toContain('-c');
      expect(argv).not.toContain('sh');
    });

    it('exit code 0 => passed true', async () => {
      const { bundle } = makeStubBundle('cid', async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['true']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      expect(result).toEqual({ passed: true, testCount: undefined, errors: undefined });
    });

    it('non-zero exit => passed false with stderr captured in errors', async () => {
      const { bundle } = makeStubBundle('cid', async () => ({
        exitCode: 2,
        stdout: 'partial out',
        stderr: 'something failed',
      }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['python', '/workflow-scripts/run_eval.py']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      expect(result.passed).toBe(false);
      expect(result.errors).toBe('something failed');
      expect(result.testCount).toBeUndefined();
    });

    it('falls back to stdout in errors when a failing command produces no stderr', async () => {
      const { bundle } = makeStubBundle('cid', async () => ({
        exitCode: 3,
        stdout: 'only-stdout',
        stderr: '',
      }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['python', 'x.py']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      expect(result.passed).toBe(false);
      expect(result.errors).toBe('only-stdout');
    });

    it('mines testCount from stdout on a passing container command', async () => {
      const { bundle } = makeStubBundle('cid', async () => ({
        exitCode: 0,
        stdout: 'running suite...\n7 tests pass\n',
        stderr: '',
      }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['python', '/workflow-scripts/run_eval.py']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      expect(result).toEqual({ passed: true, testCount: 7, errors: undefined });
    });

    it('skips empty [] commands without calling docker.exec', async () => {
      const { bundle, exec } = makeStubBundle('cid', async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, new Map([['primary', bundle]]), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [[], ['node', '/workflow-scripts/lint.js'], []],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      // Only the single non-empty command reaches docker.exec.
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec.mock.calls[0][1]).toEqual(['node', '/workflow-scripts/lint.js']);
      expect(result.passed).toBe(true);
    });

    it('targets the requested containerScope bundle', async () => {
      const primary = makeStubBundle('primary-cid', async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      const coder = makeStubBundle('coder-cid', async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      const bundles = new Map<string, DockerInfrastructure>([
        ['primary', primary.bundle],
        ['coder', coder.bundle],
      ]);
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      registerInstance(orchestrator, sharedContainerDef, bundles, tmpDir);

      await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['node', 'lint.js']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
        containerScope: 'coder',
      });

      expect(coder.exec).toHaveBeenCalledWith('coder-cid', ['node', 'lint.js'], undefined, 'codespace', '/workspace');
      expect(primary.exec).not.toHaveBeenCalled();
    });

    it('errors when container is requested but the workflow is not shared-container mode', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      const nonShared: WorkflowDefinition = {
        ...sharedContainerDef,
        settings: { mode: 'docker', dockerAgent: 'claude-code' },
      };
      registerInstance(orchestrator, nonShared, new Map(), tmpDir);

      const result = await callExecuteDeterministicState(orchestrator, WF_ID, {
        stateId: 'check',
        commands: [['node', 'lint.js']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      expect(result.passed).toBe(false);
      expect(result.errors).toContain('shared-container');
    });

    it('errors when the workflow id is unknown', async () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      // Note: no instance registered.

      const result = await callExecuteDeterministicState(orchestrator, 'missing' as WorkflowId, {
        stateId: 'check',
        commands: [['node', 'lint.js']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
      });

      expect(result.passed).toBe(false);
      expect(result.errors).toContain('not found');
    });
  });

  describe('resultFile contract', () => {
    it('returns the reducer result unchanged when resultFile is absent', () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      const base: DeterministicInvokeResult = { passed: true, testCount: 3, errors: undefined };

      const result = callApplyResultFile(
        orchestrator,
        tmpDir,
        {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
          container: true,
        },
        base,
      );

      expect(result).toBe(base);
    });

    it('reads verdict and payload from a well-formed result file after successful commands', () => {
      mkdirSync(join(tmpDir, '.workflow'), { recursive: true });
      writeFileSync(
        join(tmpDir, '.workflow', 'result.json'),
        JSON.stringify({ verdict: 'block', payload: { reason: 'policy' } }),
      );
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

      const result = callApplyResultFile(
        orchestrator,
        tmpDir,
        {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
          container: true,
          resultFile: '.workflow/result.json',
        },
        { passed: true, testCount: 2 },
      );

      expect(result).toEqual({
        passed: true,
        testCount: 2,
        verdict: 'block',
        payload: { reason: 'policy' },
      });
    });

    it('lets a boolean result-file passed field override command success', () => {
      mkdirSync(join(tmpDir, '.workflow'), { recursive: true });
      writeFileSync(join(tmpDir, '.workflow', 'result.json'), JSON.stringify({ verdict: 'failed', passed: false }));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

      const result = callApplyResultFile(
        orchestrator,
        tmpDir,
        {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
          container: true,
          resultFile: '.workflow/result.json',
        },
        { passed: true },
      );

      expect(result.passed).toBe(false);
      expect(result.verdict).toBe('failed');
    });

    it('maps a missing result file to the reserved routable verdict', () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

      const result = callApplyResultFile(
        orchestrator,
        tmpDir,
        {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
          container: true,
          resultFile: '.workflow/result.json',
        },
        { passed: true, errors: 'prior warning' },
      );

      expect(result.passed).toBe(false);
      expect(result.verdict).toBe(DETERMINISTIC_RESULT_ERROR_VERDICT);
      expect(result.errors).toContain('prior warning');
      expect(result.errors).toContain('not found');
    });

    it('maps malformed JSON and missing verdict to the reserved routable verdict', () => {
      mkdirSync(join(tmpDir, '.workflow'), { recursive: true });
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      const input: DeterministicInvokeInput = {
        stateId: 'check',
        commands: [['node', 'check.js']],
        context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
        container: true,
        resultFile: '.workflow/result.json',
      };

      writeFileSync(join(tmpDir, '.workflow', 'result.json'), '{');
      const malformed = callApplyResultFile(orchestrator, tmpDir, input, { passed: true });
      expect(malformed.passed).toBe(false);
      expect(malformed.verdict).toBe(DETERMINISTIC_RESULT_ERROR_VERDICT);
      expect(malformed.errors).toContain('not valid JSON');

      writeFileSync(join(tmpDir, '.workflow', 'result.json'), JSON.stringify({ payload: { ok: true } }));
      const missingVerdict = callApplyResultFile(orchestrator, tmpDir, input, { passed: true });
      expect(missingVerdict.passed).toBe(false);
      expect(missingVerdict.verdict).toBe(DETERMINISTIC_RESULT_ERROR_VERDICT);
      expect(missingVerdict.errors).toContain('missing verdict');
    });

    it('rejects a result file that escapes the workspace via a symlink (security)', () => {
      // A container can plant a symlink in the shared workspace; the host-side read
      // must not follow it off-workspace. The symlink points to a sibling of the
      // workspace, so canonical-path containment must reject it.
      const wsDir = join(tmpDir, 'ws');
      const secret = join(tmpDir, 'outside-secret.json');
      writeFileSync(secret, JSON.stringify({ verdict: 'leak' }));
      mkdirSync(join(wsDir, '.workflow'), { recursive: true });
      symlinkSync(secret, join(wsDir, '.workflow', 'result.json'));
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

      const result = callApplyResultFile(
        orchestrator,
        wsDir,
        {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
          container: true,
          resultFile: '.workflow/result.json',
        },
        { passed: true },
      );

      expect(result.passed).toBe(false);
      expect(result.verdict).toBe(DETERMINISTIC_RESULT_ERROR_VERDICT);
      expect(result.errors).toContain('escapes the workspace');
      expect(result.verdict).not.toBe('leak'); // never surfaced the symlinked-out verdict
    });

    it('reports a read error (not "not valid JSON") when resultFile is a directory', () => {
      // resultFile points at a directory -> readFileSync throws EISDIR, which must be
      // reported as a read failure rather than conflated with a JSON parse error.
      mkdirSync(join(tmpDir, '.workflow', 'result.json'), { recursive: true });
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

      const result = callApplyResultFile(
        orchestrator,
        tmpDir,
        {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
          container: true,
          resultFile: '.workflow/result.json',
        },
        { passed: true },
      );

      expect(result.passed).toBe(false);
      expect(result.verdict).toBe(DETERMINISTIC_RESULT_ERROR_VERDICT);
      expect(result.errors).toContain('could not be read');
      expect(result.errors).not.toContain('not valid JSON');
    });

    it('does not read resultFile when command reduction already failed', () => {
      const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
      const base: DeterministicInvokeResult = { passed: false, errors: 'command failed' };

      const result = callApplyResultFile(
        orchestrator,
        tmpDir,
        {
          stateId: 'check',
          commands: [['node', 'check.js']],
          context: { taskDescription: 'task' } as DeterministicInvokeInput['context'],
          container: true,
          resultFile: '.workflow/result.json',
        },
        base,
      );

      expect(result).toBe(base);
    });
  });
});
