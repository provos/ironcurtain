import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import { APPLE_VM_DAEMON_DOCKER_HOST } from '../../src/docker-workload/apple-vm-daemon.js';
import { APPLE_VM_DOCKER_WORKLOAD_NETWORK } from '../../src/docker-workload/apple-private-docker.js';
import { WorkflowOrchestrator } from '../../src/workflow/orchestrator.js';
import type { WorkflowId } from '../../src/workflow/types.js';
import { createDeps, waitForCompletion } from './test-helpers.js';

const PROBE_PATH = resolve(
  process.cwd(),
  'src',
  'workflow',
  'workflows',
  'nested-docker-live-smoke',
  'scripts',
  'nested_docker_probe.py',
);

function runProbeAssertion(source: string): void {
  const result = spawnSync('python3', ['-c', source, PROBE_PATH], { encoding: 'utf8' });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

describe('nested-docker-live-smoke workflow', () => {
  let tempDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'nested-docker-workflow-test-'));
    previousHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = resolve(tempDir, 'home');
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('mints a bundle for its deterministic first state and never creates an LLM session', async () => {
    const workspace = resolve(tempDir, 'workspace');
    const manifestPath = resolve(
      process.cwd(),
      'src',
      'workflow',
      'workflows',
      'nested-docker-live-smoke',
      'workflow.yaml',
    );
    const createSession = vi.fn(async () => {
      throw new Error('the deterministic smoke must not create an LLM session');
    });
    const exec = vi.fn(async () => {
      const resultPath = resolve(workspace, '.workflow', 'nested-docker-result.json');
      mkdirSync(resolve(resultPath, '..'), { recursive: true });
      writeFileSync(
        resultPath,
        JSON.stringify({ verdict: 'pass', passed: true, payload: { mode: 'public', checkCount: 1 } }),
      );
      return { exitCode: 0, stdout: '1 test passes\n', stderr: '' };
    });
    const bundle = {
      bundleId: 'bundle-deterministic-smoke',
      containerId: 'container-deterministic-smoke',
      docker: { exec },
    } as unknown as DockerInfrastructure;
    const createWorkflowInfrastructure = vi.fn(async () => bundle);
    const destroyWorkflowInfrastructure = vi.fn(async () => {});
    const startWorkflowControlServer = vi.fn(async () => {});
    const orchestrator = new WorkflowOrchestrator(
      createDeps(resolve(tempDir, 'runs'), {
        createSession,
        createWorkflowInfrastructure,
        destroyWorkflowInfrastructure,
        startWorkflowControlServer,
      }),
    );

    const workflowId: WorkflowId = await orchestrator.start(manifestPath, 'public', workspace);
    await waitForCompletion(orchestrator, workflowId);
    await orchestrator.shutdownAll();

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    expect(createSession).not.toHaveBeenCalled();
    expect(createWorkflowInfrastructure).toHaveBeenCalledTimes(1);
    expect(startWorkflowControlServer).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      'container-deterministic-smoke',
      ['python3', '/workflow-scripts/nested_docker_probe.py'],
      900_000,
      'codespace',
      '/workspace',
    );
    expect(destroyWorkflowInfrastructure).toHaveBeenCalledTimes(1);
    expect(existsSync(resolve(workspace, '.workflow', 'nested-docker-result.json'))).toBe(true);
  });

  it('pins the Python probe to the production nested-Docker environment constants', () => {
    const probe = readFileSync(PROBE_PATH, 'utf8');

    expect(probe).toContain(`EXPECTED_DOCKER_HOST = ${JSON.stringify(APPLE_VM_DAEMON_DOCKER_HOST)}`);
    expect(probe).toContain(`EXPECTED_NETWORK = ${JSON.stringify(APPLE_VM_DOCKER_WORKLOAD_NETWORK)}`);
  });

  it('requires explicit registry-policy denial instead of accepting connectivity failure', () => {
    runProbeAssertion(String.raw`
import runpy, subprocess, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
assert_denied = module["assert_registry_policy_denied"]
failure = module["ProbeFailure"]
assert_denied(subprocess.CompletedProcess([], 1, "", "unexpected status: 403 Forbidden"))
for output in ("lookup example.invalid: no such host", "pull access denied"):
    try:
        assert_denied(subprocess.CompletedProcess([], 1, "", output))
    except failure:
        pass
    else:
        raise AssertionError(f"accepted non-policy failure: {output}")
`);
  });

  it('never cleans through an unverified Docker endpoint', () => {
    runProbeAssertion(String.raw`
import os, runpy, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
probe = module["Probe"]()
calls = []
probe.docker = lambda *args, **kwargs: calls.append(args)
os.environ["DOCKER_HOST"] = "unix:///var/run/docker.sock"
try:
    probe.validate_common()
except module["ProbeFailure"]:
    pass
else:
    raise AssertionError("wrong endpoint unexpectedly validated")
probe.cleanup()
assert calls == [], calls
`);
  });

  it('captures an immutable container ID even when detached run stdout is empty', () => {
    runProbeAssertion(String.raw`
import runpy, subprocess, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
probe = module["Probe"]()
expected = "a" * 64
probe.docker = lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, expected + "\n", "")
created = subprocess.CompletedProcess([], 0, "", "")
assert probe._container_id(created, probe.server_name) == expected
`);
  });
});
