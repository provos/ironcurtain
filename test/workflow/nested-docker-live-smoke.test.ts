import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import {
  APPLE_VM_DAEMON_DOCKER_HOST,
  APPLE_VM_PACKAGE_EGRESS_PROXY_URL,
  APPLE_VM_PACKAGE_EGRESS_SOCKET,
  APPLE_VM_REGISTRY_EGRESS_PROXY_URL,
  APPLE_VM_REGISTRY_EGRESS_SOCKET,
} from '../../src/docker-workload/apple-vm-daemon.js';
import { APPLE_VM_DOCKER_WORKLOAD_NETWORK } from '../../src/docker-workload/apple-private-docker.js';
import {
  DOCKER_BUILD_PROXY_CONFIG_DIRECTORY,
  DOCKER_BUILD_PROXY_CONFIG_PATH,
  DOCKER_BUILD_SHIM_PATH,
  DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
  DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
  DOCKER_BUILD_TRUST_CA_CERT_PATH,
  DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY,
  DOCKER_BUILD_TRUST_CONTRACT_PATH,
  DOCKER_BUILD_TRUST_REAL_RUNC_PATH,
  DOCKER_BUILD_TRUST_REAL_RUNC_SHA256,
  DOCKER_BUILD_TRUST_WRAPPER_PATH,
  DOCKER_BUILD_TRUST_WRAPPER_SHA256,
  DOCKER_BUILDX_STATE_DIRECTORY,
  DOCKER_PACKAGE_BUILD_RUNTIME_DIRECTORY,
} from '../../src/docker/docker-build-shim.js';
import {
  PACKAGE_EGRESS_AUDIT_FILENAME,
  PACKAGE_EGRESS_AUDIT_SCHEMA_VERSION,
  type PackageEgressAuditRecord,
} from '../../src/docker/package-egress-proxy.js';
import { WorkflowOrchestrator } from '../../src/workflow/orchestrator.js';
import type { WorkflowId } from '../../src/workflow/types.js';
import {
  assertExactWorkflowCheckInventory,
  validatePackageBuildMounts,
  validatePackageEgressAudit,
  withSecondaryErrors,
  type PersistedOuterMount,
} from '../../scripts/smoke-nested-apple-workflow.js';
import { createDeps, waitForCompletion } from './test-helpers.js';

const WORKFLOW_ROOT = resolve(process.cwd(), 'src', 'workflow', 'workflows', 'nested-docker-live-smoke');
const PROBE_PATH = resolve(WORKFLOW_ROOT, 'scripts', 'nested_docker_probe.py');
const FIXTURE_ROOT = resolve(WORKFLOW_ROOT, 'scripts', 'fixtures', 'package-build');
const RUNNER_PATH = resolve(process.cwd(), 'scripts', 'smoke-nested-apple-workflow.ts');

const COMMON_IDS = ['common.endpoint', 'common.daemon-profile', 'common.managed-network', 'common.fresh-inventory'];
const FINAL_IDS = ['cleanup.tracked-ids', 'cleanup.initial-image-inventory', 'cleanup.empty-container-network'];
const PACKAGE_IDS = [
  'packages.outer-tcp-absent',
  'packages.host-relay-matrix',
  'packages.relay-probe-inventory',
  'packages.artifacts',
  'packages.registry-pulls',
  'packages.registry-denial',
  'packages.authoritative-build',
  'packages.exact-results',
  'packages.sibling-network',
  'packages.compose-denial',
  'packages.selector-denials',
  'packages.direct-route-denial',
  'packages.outer-package-request',
  'packages.policy-denials',
  'packages.host-child-scope',
  'packages.supported-build-forms',
  'packages.cached-repeat',
  'packages.image-residue',
  'packages.snapshot-preflight',
  'packages.snapshot-residue',
];

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

  it('mints a deterministic package-mode bundle without creating an LLM session', async () => {
    const workspace = resolve(tempDir, 'workspace');
    const manifestPath = resolve(WORKFLOW_ROOT, 'workflow.yaml');
    const createSession = vi.fn(async () => {
      throw new Error('the deterministic smoke must not create an LLM session');
    });
    const exec = vi.fn(async () => {
      const resultPath = resolve(workspace, '.workflow', 'nested-docker-result.json');
      mkdirSync(resolve(resultPath, '..'), { recursive: true });
      writeFileSync(
        resultPath,
        JSON.stringify({
          schemaVersion: 1,
          verdict: 'pass',
          passed: true,
          payload: { mode: 'packages', checkCount: 1, checkIds: ['fixture'], cacheAuditSentinels: null },
        }),
      );
      return { exitCode: 0, stdout: '1 deterministic check passes\n', stderr: '' };
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

    const workflowId: WorkflowId = await orchestrator.start(manifestPath, 'packages', workspace);
    await waitForCompletion(orchestrator, workflowId);
    await orchestrator.shutdownAll();

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    expect(createSession).not.toHaveBeenCalled();
    expect(createWorkflowInfrastructure).toHaveBeenCalledTimes(1);
    expect(startWorkflowControlServer).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(
      'container-deterministic-smoke',
      ['python3', '/workflow-scripts/nested_docker_probe.py'],
      4_320_000,
      'codespace',
      '/workspace',
    );
    expect(destroyWorkflowInfrastructure).toHaveBeenCalledTimes(1);
    expect(existsSync(resolve(workspace, '.workflow', 'nested-docker-result.json'))).toBe(true);
  });

  it('pins the probe to every production package artifact and relay', () => {
    const probe = readFileSync(PROBE_PATH, 'utf8');
    for (const value of [
      APPLE_VM_DAEMON_DOCKER_HOST,
      APPLE_VM_DOCKER_WORKLOAD_NETWORK,
      APPLE_VM_REGISTRY_EGRESS_SOCKET,
      APPLE_VM_PACKAGE_EGRESS_SOCKET,
      APPLE_VM_REGISTRY_EGRESS_PROXY_URL,
      APPLE_VM_PACKAGE_EGRESS_PROXY_URL,
      DOCKER_BUILD_SHIM_PATH,
      DOCKER_BUILD_TRUST_WRAPPER_PATH,
      DOCKER_BUILD_PROXY_CONFIG_PATH,
      DOCKER_BUILD_TRUST_CONTRACT_DIRECTORY,
      DOCKER_BUILD_TRUST_CONTRACT_PATH,
      DOCKER_BUILD_TRUST_REAL_RUNC_PATH,
      DOCKER_BUILD_TRUST_REAL_RUNC_SHA256,
      DOCKER_BUILD_TRUST_APT_CONFIG_PATH,
      DOCKER_BUILD_TRUST_CA_CERT_PATH,
      DOCKER_BUILD_TRUST_CA_BUNDLE_PATH,
      DOCKER_BUILDX_STATE_DIRECTORY,
      DOCKER_BUILD_TRUST_WRAPPER_SHA256,
    ]) {
      expect(probe).toContain(value);
    }
    expect(probe).toContain('contract.get("caGeneration", "")');
    expect(probe).toContain('contract_parent_stat.st_uid == 0');
    expect(probe).toContain('contract_parent_stat.st_gid == 0');
    expect(probe).toContain('stat.S_IMODE(contract_parent_stat.st_mode) == 0o755');
    expect(probe).toContain('0 <= contract_stat.st_uid <= 0xFFFFFFFF');
    expect(probe).toContain('0 <= contract_stat.st_gid <= 0xFFFFFFFF');
    expect(probe).toContain('contract_stat.st_nlink == 1');
    expect(probe).toContain('filesystem.f_flag & os.ST_RDONLY');
    expect(probe).toContain('[{"uid": 0, "gid": 0}, {"uid": 65534, "gid": 65534}]');
    expect(probe).toContain('{"path", "destination", "sha256", "size", "mode"}');
    expect(probe).toContain('mode not in MODE_CHECK_IDS');
    expect(probe).not.toContain('"public"');
  });

  it('ships hash/version-pinned npm, PyPI, apt, and Cargo fixtures', () => {
    const dockerfile = readFileSync(resolve(FIXTURE_ROOT, 'Dockerfile'), 'utf8');
    const lockfile = JSON.parse(readFileSync(resolve(FIXTURE_ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    const requirements = readFileSync(resolve(FIXTURE_ROOT, 'requirements.txt'), 'utf8');
    const cargoLock = readFileSync(resolve(FIXTURE_ROOT, 'cargo', 'Cargo.lock'), 'utf8');
    const verify = readFileSync(resolve(FIXTURE_ROOT, 'verify.mjs'), 'utf8');

    expect(dockerfile).toContain('FROM node:22-bookworm-slim');
    expect(dockerfile).toContain('FROM python:3.13-slim-bookworm');
    expect(dockerfile).toContain('FROM rust:1.85-slim-bookworm');
    expect(dockerfile).toContain('apt-get download curl=7.88.1-10+deb12u15');
    expect(dockerfile).toContain('880d20cb636d2c36b2f57c58ab284b442a1680365b488d3e696c147c4d84ef25');
    expect(dockerfile).toContain('apt-get install -y --no-install-recommends ./curl_7.88.1-10+deb12u15_arm64.deb');
    expect(dockerfile).toContain('npm ci --ignore-scripts --no-audit --no-fund');
    expect(dockerfile).toContain('python -m pip install --disable-pip-version-check --no-cache-dir --require-hashes');
    expect(dockerfile).toContain('cargo build --locked --release');
    expect(dockerfile).not.toContain('example.com/');
    const compose = readFileSync(resolve(FIXTURE_ROOT, 'compose.yaml'), 'utf8');
    expect(compose).toContain('develop:');
    expect(compose).toContain('action: rebuild');
    expect(lockfile.packages['node_modules/is-number']).toEqual(
      expect.objectContaining({
        version: '7.0.0',
        integrity: 'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==',
      }),
    );
    expect(requirements).toContain(
      'idna==3.15 --hash=sha256:048adeaf8c2d788c40fee287673ccaa74c24ffd8dcf09ffa555a2fbb59f10ac8',
    );
    expect(cargoLock).toContain('checksum = "4a5f13b858c8d314ee3e8f639011f7ccefe71f97f96e50151fb991f267928e2c"');
    expect(verify).toContain("result.aptCurlVersion !== '7.88.1-10+deb12u15'");
    expect(verify).toContain("cargoOutput: execFileSync('/usr/local/bin/ironcurtain-cargo-smoke'");
  });

  it('uses exact versioned check IDs in both probe and host driver', () => {
    const expected = [...COMMON_IDS, ...PACKAGE_IDS, ...FINAL_IDS];
    runProbeAssertion(String.raw`
import runpy, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
expected = ${JSON.stringify(expected)}
assert list(module["expected_check_ids"]("packages")) == expected
assert len(expected) == len(set(expected))
try:
    module["expected_check_ids"]("public")
except module["ProbeFailure"]:
    pass
else:
    raise AssertionError("legacy public mode was accepted")
`);
    const runner = readFileSync(RUNNER_PATH, 'utf8');
    for (const id of expected) expect(runner).toContain(`'${id}'`);
    expect(runner).toContain('new Set(observedIds).size !== observedIds.length');
    expect(runner).not.toContain('checkCount < 10');
  });

  it('probes the exact four-mode host relay matrix before pulls without inventory residue', () => {
    runProbeAssertion(String.raw`
import json, runpy, subprocess, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
image_id = "sha256:" + "a" * 64

def observations(mode):
    expected = {18081: mode in {"packages", "images"}, 18082: mode == "packages"}
    return [
        {
            "body": marker,
            "outcome": "response",
            "port": port,
            "status": "HTTP/1.1 200 OK",
        } if expected[port] else {"outcome": "refused", "port": port}
        for port, _path, marker in module["HOST_RELAY_SPECS"]
    ]

for mode in ("packages", "images", "offline", "admission"):
    probe = module["Probe"](mode)
    probe.initial_image_ids = (image_id,)
    refused = []
    probe._assert_outer_tcp_refused = refused.append
    calls = []
    def docker(*args, **kwargs):
        calls.append((args, kwargs))
        if args[:3] == ("container", "run", "--rm"):
            return subprocess.CompletedProcess(args, 0, json.dumps(observations(mode)) + "\n", "")
        if args[:3] == ("container", "ls", "--all"):
            return subprocess.CompletedProcess(args, 0, "", "")
        if args[:3] == ("image", "ls", "--all"):
            return subprocess.CompletedProcess(args, 0, image_id + "\n", "")
        raise AssertionError(args)
    probe.docker = docker
    probe.validate_relay_topology(image_id)
    relay_args, relay_kwargs = calls[0]
    assert relay_args == (
        "container", "run", "--rm", "--pull", "never", "--network", "host",
        "--entrypoint", "/usr/bin/python3", image_id, "-c",
        module["HOST_RELAY_PROBE_SCRIPT"],
        json.dumps(module["HOST_RELAY_SPECS"], separators=(",", ":")),
    )
    assert relay_kwargs == {"timeout": module["HOST_RELAY_PROBE_TIMEOUT_SECONDS"]}
    assert refused == [18081, 18082]
    assert probe.checks == [
        f"{mode}.outer-tcp-absent",
        f"{mode}.host-relay-matrix",
        f"{mode}.relay-probe-inventory",
    ]
`);
    const runner = readFileSync(RUNNER_PATH, 'utf8');
    for (const mode of ['packages', 'images', 'offline', 'admission']) {
      for (const suffix of ['outer-tcp-absent', 'host-relay-matrix', 'relay-probe-inventory']) {
        expect(runner).toContain(`'${mode}.${suffix}'`);
      }
    }
    const probeSource = readFileSync(PROBE_PATH, 'utf8');
    expect(probeSource.indexOf('probe.validate_relay_topology(selected_image_id)')).toBeLessThan(
      probeSource.indexOf('probe.validate_packages()'),
    );
  });

  it('rejects wrong relay status or marker and requires refusal for expected absence', () => {
    runProbeAssertion(String.raw`
import copy, runpy, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
probe = module["Probe"]("packages")
valid = [
    {"body": marker, "outcome": "response", "port": port, "status": "HTTP/1.1 200 OK"}
    for port, _path, marker in module["HOST_RELAY_SPECS"]
]
probe._validate_host_relay_observations(valid, {18081: True, 18082: True})
broken = []
wrong_status = copy.deepcopy(valid)
wrong_status[0]["status"] = "HTTP/1.1 204 No Content"
broken.append((wrong_status, {18081: True, 18082: True}))
wrong_marker = copy.deepcopy(valid)
wrong_marker[1]["body"] = "WRONG\n"
broken.append((wrong_marker, {18081: True, 18082: True}))
timeout_absence = [valid[0], {"outcome": "timeout", "port": 18082}]
broken.append((timeout_absence, {18081: True, 18082: False}))
unexpected_response = [valid[0], valid[1]]
broken.append((unexpected_response, {18081: True, 18082: False}))
for observations, expected in broken:
    try:
        probe._validate_host_relay_observations(observations, expected)
    except module["ProbeFailure"]:
        pass
    else:
        raise AssertionError((observations, expected))
`);
  });

  it('strictly decodes bounded relay health response framing before marker comparison', () => {
    runProbeAssertion(String.raw`
import runpy, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
namespace = {"__name__": "probe_test"}
exec(module["HOST_RELAY_PROBE_SCRIPT"], namespace)
parse = namespace["parse_http_response"]
observe = namespace["response_observation"]
limit = namespace["MAX_RESPONSE"]
marker = b"IRONCURTAIN_OK/1\n"

content_length = (
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: "
    + str(len(marker)).encode("ascii")
    + b"\r\n\r\n"
    + marker
)
status, body = parse(content_length)
assert status == "HTTP/1.1 200 OK" and body == marker
assert module["Probe"]._exact_http_body(content_length, "GET", "HTTP/1.1 200 OK") == marker
chunked = (
    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    + format(len(marker), "x").encode("ascii")
    + b"\r\n"
    + marker
    + b"\r\n0\r\n\r\n"
)
status, body = parse(chunked)
assert status == "HTTP/1.1 200 OK" and body == marker
assert module["Probe"]._exact_http_body(chunked, "GET", "HTTP/1.1 200 OK") == marker
assert observe(18081, marker.decode(), status, body) == {
    "body": marker.decode(),
    "outcome": "response",
    "port": 18081,
    "status": "HTTP/1.1 200 OK",
}
assert observe(18081, "WRONG\n", status, body)["outcome"] == "wrong-response"
assert observe(18081, marker.decode(), "HTTP/1.1 204 No Content", body)["outcome"] == "wrong-response"

invalid = (
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\nContent-Length: 1\r\n\r\nx",
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n",
    b"HTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n",
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: gzip\r\n\r\n",
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n1;x=y\r\na\r\n0\r\n\r\n",
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\ng\r\na\r\n0\r\n\r\n",
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na0\r\n\r\n",
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n0\r\n",
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n0\r\nTrailer: no\r\n\r\n",
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n0\r\n\r\nresidue",
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\na",
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 1\r\n\r\nab",
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\n\r\n" + b"x" * limit,
)
for response in invalid:
    try:
        parse(response)
    except (UnicodeError, ValueError):
        pass
    else:
        raise AssertionError(response[:160])
for response in invalid[:-1]:
    try:
        module["Probe"]._exact_http_body(response, "GET", "HTTP/1.1 200 OK")
    except module["ProbeFailure"]:
        pass
    else:
        raise AssertionError(("outer decoder accepted", response[:160]))
`);
  });

  it('binds HEAD to an exact bodyless 404 without framing aliases', () => {
    runProbeAssertion(String.raw`
import runpy, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
decode = module["Probe"]._decode_exact_http_response
validate = module["Probe"]._validate_request_method

valid = b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"
assert decode(valid, "HEAD") == ("HTTP/1.1 404 Not Found", b"")
try:
    decode(valid, "GET")
except module["ProbeFailure"] as error:
    assert "lacks content length" in str(error)
else:
    raise AssertionError("GET inherited HEAD's bodyless EOF exception")

invalid = (
    b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n",
    b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n",
    b"HTTP/1.0 404 Not Found\r\nConnection: close\r\n\r\n",
    b"HTTP/1.1 100 Continue\r\nConnection: close\r\n\r\n",
    b"HTTP/1.1 nope\r\nConnection: close\r\n\r\n",
    b"HTTP/1.1 404 Not Found\r\nConnection: keep-alive\r\n\r\n",
    b"HTTP/1.1 404 Not Found\r\n\r\n",
    b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length:\r\n\r\n",
    b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 123456\r\n\r\n",
    b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 00\r\n\r\n",
    b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: -1\r\n\r\n",
    b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 9223372036854775808\r\n\r\n",
    b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",
    b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n",
    b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n",
    b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\nx",
    b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 1\r\n\r\nx",
)
for response in invalid:
    try:
        decode(response, "HEAD")
    except module["ProbeFailure"]:
        pass
    else:
        raise AssertionError(("HEAD accepted invalid framing/body", response))
try:
    decode(valid, "head")
except module["ProbeFailure"] as error:
    assert "unsupported HTTP request method" in str(error)
else:
    raise AssertionError("loosely inferred lowercase request method")

validate("GET", b"GET / HTTP/1.1\r\nHost: example.test\r\n\r\n")
validate("HEAD", b"HEAD /sentinel HTTP/1.1\r\nHost: example.test\r\n\r\n")
for method, request in (
    ("HEAD", b"GET /sentinel HTTP/1.1\r\n\r\n"),
    ("GET", b"HEAD / HTTP/1.1\r\n\r\n"),
    ("HEAD", b"HEAD /sentinel HTTP/1.0\r\n\r\n"),
    ("HEAD", b"HEAD  /sentinel HTTP/1.1\r\n\r\n"),
    ("HEAD", b"HEAD /sentinel HTTP/1.1"),
):
    try:
        validate(method, request)
    except module["ProbeFailure"] as error:
        assert "does not match exact HTTP/1.1 request line" in str(error)
    else:
        raise AssertionError(("accepted mismatched request method", method, request))

probe = module["Probe"]("packages")
def must_not_open(*_args):
    raise AssertionError("mismatched request reached transport setup")
probe._open_connect = must_not_open
probe._open_package_socket = must_not_open
for invoke in (
    lambda: probe._tls_package_request(
        "HEAD", "registry.npmjs.org", "registry.npmjs.org", b"GET / HTTP/1.1\r\n\r\n"
    ),
    lambda: probe._raw_package_proxy("GET", b"HEAD / HTTP/1.1\r\n\r\n"),
):
    try:
        invoke()
    except module["ProbeFailure"]:
        pass
    else:
        raise AssertionError("transport helper accepted a mismatched request method")
`);
  });

  it('requires actual EOF for outer UDS responses and rejects errors, overflow, and framed residue', () => {
    runProbeAssertion(String.raw`
import runpy, socket, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
probe = module["Probe"]("packages")
limit = module["OUTER_PACKAGE_RESPONSE_LIMIT"]
marker = b"IRONCURTAIN_PACKAGE_EGRESS_OK/1\n"
complete = (
    b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: "
    + str(len(marker)).encode("ascii")
    + b"\r\n\r\n"
    + marker
)

class ScriptedSocket:
    def __init__(self, events):
        self.events = list(events)
    def settimeout(self, timeout):
        assert timeout == 10
    def recv(self, size):
        assert 0 < size <= 16 * 1024
        event = self.events.pop(0)
        if isinstance(event, BaseException):
            raise event
        assert len(event) <= size
        return event

read = probe._read_response(ScriptedSocket([complete, b""]), "GET")
assert read == complete
assert probe._exact_http_body(read, "GET", "HTTP/1.1 200 OK") == marker

head = b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"
assert probe._read_response(ScriptedSocket([head, b""]), "HEAD") == head

for method, complete_response in (("GET", complete), ("HEAD", head)):
    for failure in (
        ScriptedSocket([complete_response, socket.timeout("late timeout")]),
        ScriptedSocket([complete_response[:24], ConnectionResetError("reset")]),
    ):
        try:
            probe._read_response(failure, method)
        except module["ProbeFailure"] as error:
            assert "before peer EOF" in str(error)
        else:
            raise AssertionError((method, "non-EOF termination was accepted"))

class OverflowSocket:
    def __init__(self):
        self.remaining = limit + 1
        self.read = 0
    def settimeout(self, timeout):
        assert timeout == 10
    def recv(self, size):
        assert 0 < size <= 16 * 1024
        count = min(size, self.remaining)
        self.remaining -= count
        self.read += count
        return b"x" * count

overflow = OverflowSocket()
try:
    probe._read_response(overflow, "GET")
except module["ProbeFailure"] as error:
    assert "exact byte limit" in str(error)
else:
    raise AssertionError("limit+1 response was accepted")
assert overflow.read == limit + 1 and overflow.remaining == 0

try:
    probe._read_response(ScriptedSocket([complete, b"x", b""]), "GET")
except module["ProbeFailure"] as error:
    assert "body length" in str(error)
else:
    raise AssertionError("bytes after the exact framed body were accepted")
`);
  });

  it('requires bounded outer TCP refusal and routes outer package calls only through AF_UNIX', () => {
    runProbeAssertion(String.raw`
import errno, inspect, runpy, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
probe = module["Probe"]("packages")
real_socket = module["socket"].socket

class OuterSocket:
    def __init__(self, outcome):
        self.outcome = outcome
    def settimeout(self, timeout):
        assert timeout == module["OUTER_RELAY_REFUSAL_TIMEOUT_SECONDS"]
    def connect(self, address):
        assert address == ("127.0.0.1", 18081)
        if self.outcome == "refused":
            raise ConnectionRefusedError(errno.ECONNREFUSED, "refused")
        if self.outcome == "timeout":
            raise module["socket"].timeout("timeout")
    def close(self):
        pass

for outcome, accepted in (("refused", True), ("timeout", False), ("reachable", False)):
    module["socket"].socket = lambda family, kind, value=outcome: OuterSocket(value)
    try:
        probe._assert_outer_tcp_refused(18081)
    except module["ProbeFailure"]:
        assert not accepted
    else:
        assert accepted

created = []
class UnixSocket:
    def __init__(self, response):
        self.response = [response, b""]
    def settimeout(self, timeout):
        assert timeout == 10
    def connect(self, path):
        assert path == str(module["PACKAGE_SOCKET"])
    def sendall(self, payload):
        assert payload
    def recv(self, _size):
        return self.response.pop(0)
    def close(self):
        pass

responses = [
    b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    b"HTTP/1.1 200 Connection Established\r\n\r\n",
]
def unix_socket(family, kind):
    assert family == module["socket"].AF_UNIX
    assert kind == module["socket"].SOCK_STREAM
    created.append(family)
    return UnixSocket(responses.pop(0))
module["socket"].socket = unix_socket
assert probe._raw_package_proxy("GET", b"GET / HTTP/1.1\r\n\r\n").startswith(b"HTTP/1.1 403")
probe._open_connect("registry.npmjs.org", 443).close()
assert created == [module["socket"].AF_UNIX, module["socket"].AF_UNIX]
module["socket"].socket = real_socket

source = open(sys.argv[1], encoding="utf-8").read()
assert "urllib.request" not in source
assert 'socket.create_connection(' in module["HOST_PACKAGE_CONNECT_DENIAL_SCRIPT"]
assert '127.0.0.1", 18082' in module["HOST_PACKAGE_CONNECT_DENIAL_SCRIPT"]
assert "create_connection" not in inspect.getsource(module["Probe"]._raw_package_proxy)
assert "create_connection" not in inspect.getsource(module["Probe"]._open_connect)
`);
  });

  it('uses the exact initial image for a held-open raw CONNECT denial and strictly requires EOF', () => {
    runProbeAssertion(String.raw`
import contextlib, io, runpy, socket, subprocess, sys, time
module = runpy.run_path(sys.argv[1], run_name="probe_test")
initial = "sha256:" + "a" * 64
fixture = "sha256:" + "b" * 64
sibling = "c" * 64
probe = module["Probe"]("packages")
probe.initial_image_ids = (initial,)
probe.image_ids = [fixture]
probe.container_ids = [sibling]
calls = []
def docker(*args, **kwargs):
    calls.append((args, kwargs))
    if args[:3] == ("container", "run", "--rm"):
        if args[-1] == "https://registry.npmjs.org/is-number":
            return subprocess.CompletedProcess(args, 0, '"7.0.0"', "")
        if args[-1] == "https://example.com/":
            return subprocess.CompletedProcess(args, 22, "", "403 Forbidden")
        if args[-1] == module["HOST_PACKAGE_CONNECT_DENIAL_SCRIPT"]:
            return subprocess.CompletedProcess(args, 0, "", "")
    if args == ("container", "ls", "--all", "--quiet", "--no-trunc"):
        return subprocess.CompletedProcess(args, 0, sibling + "\n", "")
    if args == ("container", "ls", "--quiet", "--no-trunc"):
        return subprocess.CompletedProcess(args, 0, sibling + "\n", "")
    if args == ("image", "ls", "--all", "--quiet", "--no-trunc"):
        return subprocess.CompletedProcess(args, 0, initial + "\n" + fixture + "\n", "")
    raise AssertionError((args, kwargs))
probe.docker = docker
probe._validate_host_network_child(fixture)
connect_calls = [
    call for call in calls
    if call[0][-1:] == (module["HOST_PACKAGE_CONNECT_DENIAL_SCRIPT"],)
]
assert connect_calls == [(
    (
        "container", "run", "--rm", "--pull", "never", "--network", "host",
        "--entrypoint", "/usr/bin/python3", initial, "-c",
        module["HOST_PACKAGE_CONNECT_DENIAL_SCRIPT"],
    ),
    {
        "expect_success": None,
        "timeout": module["HOST_PACKAGE_CONNECT_PROBE_TIMEOUT_SECONDS"],
    },
)]
assert [args for args, _kwargs in calls].count(
    ("container", "ls", "--all", "--quiet", "--no-trunc")
) == 2
assert [args for args, _kwargs in calls].count(
    ("container", "ls", "--quiet", "--no-trunc")
) == 2
assert [args for args, _kwargs in calls].count(
    ("image", "ls", "--all", "--quiet", "--no-trunc")
) == 2
assert [args for args, _kwargs in calls[:3]] == [
    ("container", "ls", "--all", "--quiet", "--no-trunc"),
    ("container", "ls", "--quiet", "--no-trunc"),
    ("image", "ls", "--all", "--quiet", "--no-trunc"),
]
assert [args for args, _kwargs in calls[-3:]] == [
    ("container", "ls", "--all", "--quiet", "--no-trunc"),
    ("container", "ls", "--quiet", "--no-trunc"),
    ("image", "ls", "--all", "--quiet", "--no-trunc"),
]
assert probe.checks == ["packages.host-child-scope"]

namespace = {"__name__": "probe_test"}
exec(module["HOST_PACKAGE_CONNECT_DENIAL_SCRIPT"], namespace)
read_outcome = namespace["read_connect_denial_outcome"]
expected = namespace["EXPECTED_RESPONSE"]
limit = namespace["MAX_RESPONSE"]
assert namespace["SOCKET_TIMEOUT_SECONDS"] == module["HOST_PACKAGE_CONNECT_SOCKET_TIMEOUT_SECONDS"]
assert module["HOST_PACKAGE_CONNECT_PROBE_TIMEOUT_SECONDS"] == 60
assert module["HOST_PACKAGE_CONNECT_EXIT_OUTCOMES"] == {
    namespace["EXIT_EXACT_EOF"]: "exact-eof",
    namespace["EXIT_DIAL_FAILURE"]: "dial-failure",
    namespace["EXIT_SEND_FAILURE"]: "send-failure",
    namespace["EXIT_TIMEOUT_EMPTY"]: "timeout-empty",
    namespace["EXIT_TIMEOUT_PARTIAL"]: "timeout-partial",
    namespace["EXIT_EXACT_BYTES_NO_EOF"]: "exact-bytes-no-eof",
    namespace["EXIT_TRANSPORT_RESET"]: "transport-reset",
    namespace["EXIT_OVERFLOW"]: "overflow",
    namespace["EXIT_CLEAN_NONEXACT_EOF"]: "clean-nonexact-eof",
    namespace["EXIT_UNEXPECTED_INTERNAL"]: "unexpected-internal",
}
assert sorted(module["HOST_PACKAGE_CONNECT_EXIT_OUTCOMES"]) == [0, *range(70, 79)]

class ScriptedSocket:
    def __init__(self, events):
        self.events = list(events)
        self.timeouts = []
    def settimeout(self, timeout):
        assert 0 < timeout <= module["HOST_PACKAGE_CONNECT_SOCKET_TIMEOUT_SECONDS"]
        self.timeouts.append(timeout)
    def recv(self, _size):
        event = self.events.pop(0)
        if isinstance(event, BaseException):
            raise event
        return event

def deadline():
    return time.monotonic() + module["HOST_PACKAGE_CONNECT_SOCKET_TIMEOUT_SECONDS"]

assert read_outcome(ScriptedSocket([expected[:17], expected[17:], b""]), deadline()) == namespace["EXIT_EXACT_EOF"]
wrong_responses = (
    expected.replace(b"HTTP/1.1 403", b"HTTP/1.1 200", 1),
    expected.replace(b"Connection: close", b"Connection: keep-alive", 1),
    expected.replace(b"Content-Length: 0", b"Transfer-Encoding: chunked", 1),
    expected + b"residue",
)
for response in wrong_responses:
    assert read_outcome(ScriptedSocket([response, b""]), deadline()) == namespace["EXIT_CLEAN_NONEXACT_EOF"]

for events, expected_exit in (
    ([socket.timeout("timeout")], namespace["EXIT_TIMEOUT_EMPTY"]),
    ([expected[:17], socket.timeout("partial")], namespace["EXIT_TIMEOUT_PARTIAL"]),
    ([expected, socket.timeout("no EOF")], namespace["EXIT_EXACT_BYTES_NO_EOF"]),
    ([ConnectionResetError("reset")], namespace["EXIT_TRANSPORT_RESET"]),
    ([expected, ConnectionResetError("reset")], namespace["EXIT_TRANSPORT_RESET"]),
    ([b"x" * limit, b"x"], namespace["EXIT_OVERFLOW"]),
    ([b""], namespace["EXIT_CLEAN_NONEXACT_EOF"]),
):
    assert read_outcome(ScriptedSocket(events), deadline()) == expected_exit

class SlowDripSocket(ScriptedSocket):
    def __init__(self, clock):
        super().__init__([])
        self.clock = clock
    def recv(self, _size):
        self.clock.now += 0.015
        return b"x"

class FakeTime:
    def __init__(self):
        self.now = 100.0
    def monotonic(self):
        return self.now

real_script_time = namespace["time"]
fake_time = FakeTime()
namespace["time"] = fake_time
try:
    slow_drip = SlowDripSocket(fake_time)
    assert read_outcome(slow_drip, fake_time.now + 0.025) == namespace["EXIT_TIMEOUT_PARTIAL"]
    assert len(slow_drip.timeouts) == 2
    assert 0 < slow_drip.timeouts[1] < slow_drip.timeouts[0]
finally:
    namespace["time"] = real_script_time

class MainSocket(ScriptedSocket):
    def __init__(self):
        super().__init__([expected, b""])
        self.sent = None
        self.closed = False
    def sendall(self, payload):
        self.sent = payload
    def close(self):
        self.closed = True

main_socket = MainSocket()
real_create_connection = namespace["socket"].create_connection
def create_connection(address, *, timeout):
    assert address == ("127.0.0.1", 18082)
    assert 0 < timeout <= module["HOST_PACKAGE_CONNECT_SOCKET_TIMEOUT_SECONDS"]
    return main_socket
namespace["socket"].create_connection = create_connection
try:
    assert namespace["main"]() == namespace["EXIT_EXACT_EOF"]
finally:
    namespace["socket"].create_connection = real_create_connection
assert main_socket.sent == namespace["REQUEST"]
assert main_socket.closed

def connect_failure(_address, *, timeout):
    assert 0 < timeout <= module["HOST_PACKAGE_CONNECT_SOCKET_TIMEOUT_SECONDS"]
    raise ConnectionRefusedError("fixed test failure")
namespace["socket"].create_connection = connect_failure
try:
    assert namespace["main"]() == namespace["EXIT_DIAL_FAILURE"]
finally:
    namespace["socket"].create_connection = real_create_connection

send_failure = MainSocket()
def fail_send(_payload):
    raise BrokenPipeError("fixed test failure")
send_failure.sendall = fail_send
namespace["socket"].create_connection = lambda _address, *, timeout: send_failure
try:
    assert namespace["main"]() == namespace["EXIT_SEND_FAILURE"]
finally:
    namespace["socket"].create_connection = real_create_connection
assert send_failure.closed

timeout_failure = MainSocket()
def fail_settimeout(_timeout):
    raise OSError("fixed test failure")
timeout_failure.settimeout = fail_settimeout
namespace["socket"].create_connection = lambda _address, *, timeout: timeout_failure
try:
    assert namespace["main"]() == namespace["EXIT_DIAL_FAILURE"]
finally:
    namespace["socket"].create_connection = real_create_connection
assert timeout_failure.closed

original_timeout = namespace["SOCKET_TIMEOUT_SECONDS"]
slow_send = MainSocket()
def send_past_deadline(_payload):
    time.sleep(0.03)
slow_send.sendall = send_past_deadline
namespace["SOCKET_TIMEOUT_SECONDS"] = 0.02
namespace["socket"].create_connection = lambda _address, *, timeout: slow_send
try:
    assert namespace["main"]() == namespace["EXIT_TIMEOUT_EMPTY"]
finally:
    namespace["socket"].create_connection = real_create_connection
    namespace["SOCKET_TIMEOUT_SECONDS"] = original_timeout
assert slow_send.closed

slow_dial = MainSocket()
def connect_past_deadline(_address, *, timeout):
    assert 0 < timeout <= 0.02
    time.sleep(0.03)
    return slow_dial
namespace["SOCKET_TIMEOUT_SECONDS"] = 0.02
namespace["socket"].create_connection = connect_past_deadline
try:
    assert namespace["main"]() == namespace["EXIT_DIAL_FAILURE"]
finally:
    namespace["socket"].create_connection = real_create_connection
    namespace["SOCKET_TIMEOUT_SECONDS"] = original_timeout
assert slow_dial.closed

def unexpected(_address, *, timeout):
    raise ValueError("must not escape or print")
namespace["socket"].create_connection = unexpected
stdout = io.StringIO()
stderr = io.StringIO()
try:
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        assert namespace["guarded_main"]() == namespace["EXIT_UNEXPECTED_INTERNAL"]
finally:
    namespace["socket"].create_connection = real_create_connection
assert stdout.getvalue() == "" and stderr.getvalue() == ""
`);
  });

  it('maps only quiet fixed raw CONNECT probe exits to low-cardinality outcomes', () => {
    runProbeAssertion(String.raw`
import runpy, subprocess, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
initial = "sha256:" + "a" * 64
fixture = "sha256:" + "b" * 64
sibling = "c" * 64

def observed(returncode, stdout="", stderr=""):
    probe = module["Probe"]("packages")
    probe.initial_image_ids = (initial,)
    probe.image_ids = [fixture]
    probe.container_ids = [sibling]
    probe._full_container_ids = lambda *, all_containers: [sibling]
    probe._all_image_ids = lambda: sorted((initial, fixture))
    def docker(*args, **kwargs):
        if args[-1] == "https://registry.npmjs.org/is-number":
            return subprocess.CompletedProcess(args, 0, '"7.0.0"', "")
        if args[-1] == "https://example.com/":
            return subprocess.CompletedProcess(args, 22, "", "403 Forbidden")
        if args[-1] == module["HOST_PACKAGE_CONNECT_DENIAL_SCRIPT"]:
            assert kwargs == {
                "expect_success": None,
                "timeout": module["HOST_PACKAGE_CONNECT_PROBE_TIMEOUT_SECONDS"],
            }
            return subprocess.CompletedProcess(args, returncode, stdout, stderr)
        raise AssertionError((args, kwargs))
    probe.docker = docker
    try:
        probe._validate_host_network_child(fixture)
    except module["ProbeFailure"] as error:
        return str(error)
    raise AssertionError("non-success raw CONNECT outcome passed")

for returncode, outcome in module["HOST_PACKAGE_CONNECT_EXIT_OUTCOMES"].items():
    if returncode == 0:
        continue
    assert observed(returncode) == f"host child held-open CONNECT denial outcome: {outcome}"
assert observed(19) == "host child held-open CONNECT denial returned an unknown status"
assert observed(0, stdout="unexpected") == "host child held-open CONNECT denial emitted output"
assert observed(0, stderr="unexpected") == "host child held-open CONNECT denial emitted output"
`);
  });

  it('rejects untracked, stopped, missing, replaced, or drifting host-child inventory', () => {
    runProbeAssertion(String.raw`
import runpy, subprocess, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
initial = "sha256:" + "a" * 64
fixture = "sha256:" + "b" * 64
extra_image = "sha256:" + "d" * 64
sibling = "c" * 64
other = "e" * 64

def output(ids):
    return "" if not ids else "\n".join(ids) + "\n"

def rejected(all_snapshots, running_snapshots, image_snapshots, *, tracked=(sibling,), tracked_images=(fixture,)):
    probe = module["Probe"]("packages")
    probe.initial_image_ids = (initial,)
    probe.container_ids = list(tracked)
    probe.image_ids = list(tracked_images)
    all_values = list(all_snapshots)
    running_values = list(running_snapshots)
    image_values = list(image_snapshots)
    def docker(*args, **kwargs):
        if args == ("container", "ls", "--all", "--quiet", "--no-trunc"):
            return subprocess.CompletedProcess(args, 0, output(all_values.pop(0)), "")
        if args == ("container", "ls", "--quiet", "--no-trunc"):
            return subprocess.CompletedProcess(args, 0, output(running_values.pop(0)), "")
        if args == ("image", "ls", "--all", "--quiet", "--no-trunc"):
            return subprocess.CompletedProcess(args, 0, output(image_values.pop(0)), "")
        if args[:3] == ("container", "run", "--rm"):
            if args[-1] == "https://registry.npmjs.org/is-number":
                return subprocess.CompletedProcess(args, 0, '"7.0.0"', "")
            if args[-1] == "https://example.com/":
                return subprocess.CompletedProcess(args, 22, "", "403 Forbidden")
            if args[-1] == module["HOST_PACKAGE_CONNECT_DENIAL_SCRIPT"]:
                return subprocess.CompletedProcess(args, 0, "", "")
        raise AssertionError((args, kwargs))
    probe.docker = docker
    try:
        probe._validate_host_network_child(fixture)
    except module["ProbeFailure"]:
        return True
    return False

baseline_images = ((initial, fixture),)
assert rejected(((sibling, other),), ((sibling, other),), baseline_images)  # untracked
assert rejected(((),), ((),), baseline_images)  # missing tracked
assert rejected(((sibling,),), ((),), baseline_images)  # stopped tracked
assert rejected(((sibling,),), ((sibling,),), ((initial, fixture, extra_image),))  # untracked image
assert rejected(((sibling, sibling),), ((sibling,),), baseline_images)  # duplicate full ID
assert rejected((("short",),), (("short",),), baseline_images)  # truncated ID
assert rejected((), (), (), tracked=("short",))  # malformed tracked ID
assert rejected((), (), (), tracked=(sibling, sibling))  # duplicate tracked container
assert rejected(((sibling,),), ((sibling,),), (), tracked_images=(initial, fixture))  # duplicate tracked image

for post_all, post_running in (
    ((sibling, other), (sibling, other)),  # added
    ((), ()),  # missing
    ((other,), (other,)),  # replaced
):
    assert rejected(
        ((sibling,), post_all),
        ((sibling,), post_running),
        ((initial, fixture), (initial, fixture)),
    )
assert rejected(
    ((sibling,), (sibling,)),
    ((sibling,), (sibling,)),
    ((initial, fixture), (initial, fixture, extra_image)),
)
assert not rejected(
    ((sibling,), (sibling,)),
    ((sibling,), (sibling,)),
    (
        (initial, initial, fixture, fixture),
        (fixture, initial, fixture, initial),
    ),
)
`);

    const source = readFileSync(PROBE_PATH, 'utf8');
    expect(source.indexOf('self._validate_sibling_dns(authoritative_id)')).toBeLessThan(
      source.indexOf('self._validate_host_network_child(authoritative_id)'),
    );
  });

  it('fails the relay probe when the disposable child changes initial inventory', () => {
    runProbeAssertion(String.raw`
import json, runpy, subprocess, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
image_id = "sha256:" + "a" * 64
extra_id = "sha256:" + "b" * 64
probe = module["Probe"]("offline")
probe.initial_image_ids = (image_id,)
probe._assert_outer_tcp_refused = lambda _port: None
def docker(*args, **kwargs):
    if args[:3] == ("container", "run", "--rm"):
        refused = [{"outcome": "refused", "port": port} for port, _path, _marker in module["HOST_RELAY_SPECS"]]
        return subprocess.CompletedProcess(args, 0, json.dumps(refused), "")
    if args[:3] == ("container", "ls", "--all"):
        return subprocess.CompletedProcess(args, 0, "", "")
    if args[:3] == ("image", "ls", "--all"):
        return subprocess.CompletedProcess(args, 0, image_id + "\n" + extra_id + "\n", "")
    raise AssertionError(args)
probe.docker = docker
try:
    probe.validate_relay_topology(image_id)
except module["ProbeFailure"] as error:
    assert "offline.relay-probe-inventory" in str(error)
else:
    raise AssertionError("relay inventory drift was accepted")
`);
  });

  it('normalizes repeated image-tag rows without weakening immutable ID validation', () => {
    runProbeAssertion(String.raw`
import runpy, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
first = "sha256:" + "a" * 64
second = "sha256:" + "b" * 64
parse_images = module["Probe"]._validated_image_id_inventory
assert parse_images(f"{second}\n{first}\n{second}\n{first}\n") == [first, second]
assert parse_images("") == []
for malformed in (
    f"\n{first}\n",
    f"{first}\n\n{first}\n",
    f"{first}\n{first}\nshort\n{first}\n",
    f"{first}\n {first}\n",
    f"{first}\nsha256:{'A' * 64}\n",
):
    try:
        parse_images(malformed)
    except module["ProbeFailure"] as error:
        assert str(error) == "Docker image inventory contains a malformed full ID"
    else:
        raise AssertionError(f"malformed image row passed: {malformed!r}")

try:
    module["Probe"]._validated_full_id_inventory(
        "c" * 64 + "\n" + "c" * 64 + "\n",
        module["CONTAINER_ID"],
        "Docker container inventory",
    )
except module["ProbeFailure"] as error:
    assert str(error) == "Docker container inventory contains duplicate full IDs"
else:
    raise AssertionError("duplicate container rows inherited image alias normalization")
`);
  });

  it('budgets aggregate package work and cleanup below finite state and child deadlines', () => {
    const workflow = readFileSync(resolve(WORKFLOW_ROOT, 'workflow.yaml'), 'utf8');
    const runner = readFileSync(RUNNER_PATH, 'utf8');
    const workflowTimeout = Number(/timeoutMs:\s*(\d+)/u.exec(workflow)?.[1]);
    expect(workflowTimeout).toBe(72 * 60_000);
    runProbeAssertion(String.raw`
import runpy, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
critical = (
    len(module["PUBLIC_IMAGES"]) * module["PACKAGE_IMAGE_PULL_TIMEOUT_SECONDS"]
    + module["PACKAGE_NETWORK_BUILD_TIMEOUT_SECONDS"]
    + len(module["PACKAGE_BUILD_FORMS"]) * module["PACKAGE_FORM_BUILD_TIMEOUT_SECONDS"]
    + module["PACKAGE_CACHE_BUILD_TIMEOUT_SECONDS"]
    + module["PACKAGE_DIRECT_DENIAL_BUILD_TIMEOUT_SECONDS"]
    + module["HOST_PACKAGE_CONNECT_PROBE_TIMEOUT_SECONDS"]
    + module["PACKAGE_IMAGE_SCAN_TIMEOUT_SECONDS"]
    + module["PACKAGE_SNAPSHOT_SCAN_PREFLIGHT_TIMEOUT_SECONDS"]
    + module["PACKAGE_SNAPSHOT_SCAN_TIMEOUT_SECONDS"]
)
assert critical == module["PACKAGE_CRITICAL_OPERATION_BUDGET_SECONDS"] == 2650
assert (critical + module["PACKAGE_WORKFLOW_RESERVE_SECONDS"]) * 1000 <= ${workflowTimeout}
`);
    expect(runner).toContain('const WORKFLOW_STATE_TIMEOUT_MS = 72 * 60_000;');
    expect(runner).toContain('const WORKFLOW_STARTUP_TEARDOWN_RESERVE_MS = 20 * 60_000;');
    expect(runner).toContain(
      'const CHILD_TIMEOUT_MS = WORKFLOW_STATE_TIMEOUT_MS + WORKFLOW_STARTUP_TEARDOWN_RESERVE_MS;',
    );
    expect(runner).toContain('const CLEANUP_TIMEOUT_MS = 10 * 60_000;');
  });

  it('routes all supported forms through trust checks and loads Buildx output', () => {
    runProbeAssertion(String.raw`
import json, runpy, subprocess, sys, tempfile
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name="probe_test")
assert module["PACKAGE_BUILD_FORMS"] == (
    ("image-build", ("image", "build")),
    ("builder-build", ("builder", "build")),
    ("buildx-build", ("buildx", "build", "--load")),
)
probe = module["Probe"]("packages")
with tempfile.TemporaryDirectory() as directory:
    def write_generated(name, dockerfile):
        context = Path(directory) / name
        context.mkdir()
        (context / "Dockerfile").write_text(dockerfile, encoding="utf-8")
        return context
    probe._write_generated_context = write_generated
    probe._write_form_context.__globals__["FIXTURE_DIR"] = Path(sys.argv[1]).parent / "fixtures" / "package-build"
    context = probe._write_form_context("buildx-build", "local-authoritative:latest")
    dockerfile = (context / "Dockerfile").read_text(encoding="utf-8")
    assert dockerfile.startswith("FROM local-authoritative:latest\n")
    assert module["form_check_run_command"]() in dockerfile
    assert sorted(path.name for path in context.iterdir()) == ["Dockerfile"]
    assert "/dev/ironcurtain" not in dockerfile
    assert "HTTP_PROXY" not in dockerfile
    command = json.loads(next(line.removeprefix("CMD ") for line in dockerfile.splitlines() if line.startswith("CMD ")))
    marker = subprocess.run(command, check=True, capture_output=True, text=True)
    assert json.loads(marker.stdout) == {"form": "buildx-build"}
`);
  });

  it('requires an executed form check and exactly one canonical empty diff layer', () => {
    runProbeAssertion(String.raw`
import hashlib, io, runpy, subprocess, sys, tarfile
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name="probe_test")
module["form_check_run_command"].__globals__["FIXTURE_DIR"] = Path(sys.argv[1]).parent / "fixtures" / "package-build"
empty = b"\0" * 1024
empty_diff = "sha256:" + hashlib.sha256(empty).hexdigest()
assert empty_diff == module["CANONICAL_EMPTY_LAYER_DIFF_ID"]
assert empty_diff == "sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef"

step = "#17 [2/2] " + module["form_check_run_command"]() + "\n"
probe = module["Probe"]("packages")
probe._assert_form_check_executed(
    subprocess.CompletedProcess([], 0, step + "#17 DONE 0.1s\n", ""),
    "image-build",
)
for terminal in ("#17 CACHED\n", ""):
    try:
        probe._assert_form_check_executed(
            subprocess.CompletedProcess([], 0, step + terminal, ""),
            "image-build",
        )
    except module["ProbeFailure"]:
        pass
    else:
        raise AssertionError(f"accepted unexecuted form check: {terminal!r}")

base_layers = ("sha256:" + "a" * 64,)
valid_id = "sha256:" + "b" * 64
probe.inspected_layers[valid_id] = (*base_layers, empty_diff)
probe._record_form_layer_inventory(base_layers, valid_id, "image-build")

authority_buffer = io.BytesIO()
with tarfile.open(fileobj=authority_buffer, mode="w") as authority_tar:
    payload = b"-----BEGIN CERTIFICATE-----\nauthority\n"
    member = tarfile.TarInfo("dev/ironcurtain/ca-cert.pem")
    member.size = len(payload)
    authority_tar.addfile(member, io.BytesIO(payload))
authority_diff = "sha256:" + hashlib.sha256(authority_buffer.getvalue()).hexdigest()

bad_layers = (
    (*base_layers, authority_diff),
    (*base_layers, empty_diff, authority_diff),
    ("sha256:" + "c" * 64, empty_diff),
)
for index, layers in enumerate(bad_layers):
    candidate = "sha256:" + str(index + 1) * 64
    rejected = module["Probe"]("packages")
    rejected.inspected_layers[candidate] = layers
    try:
        rejected._record_form_layer_inventory(base_layers, candidate, "image-build")
    except module["ProbeFailure"] as error:
        assert "observed" in str(error)
    else:
        raise AssertionError(f"accepted noncanonical/extra authority layer: {layers!r}")
`);
  });

  it('binds saved added layers to diff IDs and rejects only the matching CA private key', () => {
    runProbeAssertion(String.raw`
import hashlib, io, json, runpy, subprocess, sys, tarfile, tempfile, time
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name="probe_test")
empty = b"\0" * module["CANONICAL_EMPTY_LAYER_SIZE"]
empty_diff = module["CANONICAL_EMPTY_LAYER_DIFF_ID"]
base_path = "layers/base.tar"
produced_path = "layers/produced.tar"
empty_path = "layers/empty.tar"

def add_bytes(archive, name, contents):
    member = tarfile.TarInfo(name)
    member.size = len(contents)
    archive.addfile(member, io.BytesIO(contents))

def layer_bytes(name, contents):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as layer:
        add_bytes(layer, name, contents)
    return buffer.getvalue()

def link_layer_bytes(name, target, link_type):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as layer:
        member = tarfile.TarInfo(name)
        member.type = link_type
        member.linkname = target
        layer.addfile(member)
    return buffer.getvalue()

base_layer = layer_bytes("base.txt", b"base-layer-fixture")
base_diff = "sha256:" + hashlib.sha256(base_layer).hexdigest()

def write_archive(path, produced_layer):
    produced_diff = "sha256:" + hashlib.sha256(produced_layer).hexdigest()
    layer_ids = (base_diff, produced_diff, empty_diff)
    manifest = []
    configs = []
    expectations = {}
    for label, _prefix in module["PACKAGE_BUILD_FORMS"]:
        config = json.dumps(
            {"label": label, "rootfs": {"type": "layers", "diff_ids": layer_ids}},
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        image_id = "sha256:" + hashlib.sha256(config).hexdigest()
        config_path = f"configs/{image_id.removeprefix('sha256:')}.json"
        configs.append((config_path, config))
        manifest.append(
            {"Config": config_path, "RepoTags": [], "Layers": [base_path, produced_path, empty_path]}
        )
        expectations[image_id] = (label, layer_ids)
    with tarfile.open(path, mode="w") as archive:
        add_bytes(archive, "manifest.json", json.dumps(manifest).encode())
        for name, contents in configs:
            add_bytes(archive, name, contents)
        add_bytes(archive, base_path, base_layer)
        add_bytes(archive, produced_path, produced_layer)
        add_bytes(archive, empty_path, empty)
    return expectations

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    ca_key = root / "ca-private.pem"
    ca_key_pkcs1 = root / "ca-private-pkcs1.pem"
    ca_cert = root / "ca-cert.pem"
    unrelated_key = root / "unrelated-private.pem"
    unrelated_key_pkcs1 = root / "unrelated-private-pkcs1.pem"
    unrelated_cert = root / "unrelated-cert.pem"
    for key, key_pkcs1, cert, name in (
        (ca_key, ca_key_pkcs1, ca_cert, "ironcurtain-test"),
        (unrelated_key, unrelated_key_pkcs1, unrelated_cert, "unrelated-test"),
    ):
        subprocess.run(
            [
                "/usr/bin/openssl", "genpkey", "-algorithm", "RSA",
                "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(key),
            ],
            check=True,
            capture_output=True,
        )
        traditional = subprocess.run(
            [
                "/usr/bin/openssl", "rsa", "-in", str(key), "-traditional",
                "-out", str(key_pkcs1),
            ],
            capture_output=True,
        )
        if traditional.returncode != 0:
            subprocess.run(
                ["/usr/bin/openssl", "rsa", "-in", str(key), "-out", str(key_pkcs1)],
                check=True,
                capture_output=True,
            )
        assert key.read_bytes().startswith(b"-----BEGIN PRIVATE KEY-----")
        assert key_pkcs1.read_bytes().startswith(b"-----BEGIN RSA PRIVATE KEY-----")
        subprocess.run(
            [
                "/usr/bin/openssl", "req", "-x509", "-new", "-key", str(key),
                "-subj", f"/CN={name}", "-out", str(cert),
            ],
            check=True,
            capture_output=True,
        )
    module["Probe"]._ca_public_spki.__globals__["AGENT_CA_CERT"] = ca_cert
    archive = Path(directory) / "forms.tar"
    probe = module["Probe"]("packages")
    probe.build_base_layers = (base_diff,)
    probe.form_image_layers = write_archive(
        archive,
        layer_bytes(
            "unrelated-private.pem",
            unrelated_key.read_bytes() + b"\n" + unrelated_key_pkcs1.read_bytes(),
        ),
    )
    probe.inspected_layers = {
        image_id: layers for image_id, (_label, layers) in probe.form_image_layers.items()
    }
    probe._validate_saved_form_layers(
        archive, tuple(probe.form_image_layers), time.monotonic() + 30
    )

    for matching_key in (ca_key, ca_key_pkcs1):
        probe.form_image_layers = write_archive(
            archive, layer_bytes("nested/path/ca-private.pem", matching_key.read_bytes())
        )
        probe.inspected_layers = {
            image_id: layers for image_id, (_label, layers) in probe.form_image_layers.items()
        }
        try:
            probe._validate_saved_form_layers(
                archive, tuple(probe.form_image_layers), time.monotonic() + 30
            )
        except module["ProbeFailure"] as error:
            message = str(error)
            assert message == "build-produced layer contains the IronCurtain CA private key"
            assert "PRIVATE KEY" not in message and "sha256" not in message
            assert str(matching_key) not in message and "nested/path" not in message
        else:
            raise AssertionError("matching CA private key passed added-layer SPKI proof")

    nested_envelopes = (
        (
            b"-----BEGIN PRIVATE KEY-----\n"
            + ca_key_pkcs1.read_bytes()
            + b"-----END PRIVATE KEY-----\n"
        ),
        (
            b"-----BEGIN PRIVATE KEY-----\n"
            + ca_key.read_bytes()
            + b"-----END PRIVATE KEY-----\n"
        ),
    )
    for nested_envelope in nested_envelopes:
        probe.form_image_layers = write_archive(
            archive, layer_bytes("nested-envelope.pem", nested_envelope)
        )
        probe.inspected_layers = {
            image_id: layers for image_id, (_label, layers) in probe.form_image_layers.items()
        }
        try:
            probe._validate_saved_form_layers(
                archive, tuple(probe.form_image_layers), time.monotonic() + 30
            )
        except module["ProbeFailure"] as error:
            assert str(error) == "build-produced layer contains the IronCurtain CA private key"
        else:
            raise AssertionError("nested matching CA private key envelope passed residue proof")

    safe_link_cases = (
        ("etc/mtab", "/proc/mounts", tarfile.SYMTYPE),
        ("safe/link", "../../../../proc/mounts", tarfile.SYMTYPE),
        ("safe/link", "etc/passwd", tarfile.LNKTYPE),
    )
    for name, target, link_type in safe_link_cases:
        probe.form_image_layers = write_archive(
            archive, link_layer_bytes(name, target, link_type)
        )
        probe.inspected_layers = {
            image_id: layers for image_id, (_label, layers) in probe.form_image_layers.items()
        }
        probe._validate_saved_form_layers(
            archive, tuple(probe.form_image_layers), time.monotonic() + 30
        )

    link_cases = (
        ("safe/link", "../dev/ironcurtain/ca-cert.pem", tarfile.SYMTYPE,
         "build-produced layer link reaches an IronCurtain trust mount"),
        ("safe/link", "dev/ironcurtain/ca-cert.pem", tarfile.LNKTYPE,
         "build-produced layer link reaches an IronCurtain trust mount"),
        ("safe/link", "/dev/ironcurtain/ca-cert.pem", tarfile.SYMTYPE,
         "build-produced layer link reaches an IronCurtain trust mount"),
        ("safe/link", "/dev/./ironcurtain/ca-cert.pem", tarfile.SYMTYPE,
         "build-produced layer link reaches an IronCurtain trust mount"),
        ("safe/link", "/proc/self/root/dev/ironcurtain/ca-cert.pem", tarfile.SYMTYPE,
         "build-produced layer link reaches an IronCurtain trust mount"),
        ("safe/link", "/etc/passwd", tarfile.LNKTYPE,
         "hardlink target must be archive-root-relative"),
        ("safe/link", "../etc/passwd", tarfile.LNKTYPE,
         "hardlink target traverses outside the archive root"),
    )
    for name, target, link_type, expected_error in link_cases:
        probe.form_image_layers = write_archive(
            archive, link_layer_bytes(name, target, link_type)
        )
        probe.inspected_layers = {
            image_id: layers for image_id, (_label, layers) in probe.form_image_layers.items()
        }
        try:
            probe._validate_saved_form_layers(
                archive, tuple(probe.form_image_layers), time.monotonic() + 30
            )
        except module["ProbeFailure"] as error:
            assert str(error) == expected_error
        else:
            raise AssertionError(f"unsafe layer link passed structural proof: {target!r}")

    probe.form_image_layers = write_archive(
        archive, layer_bytes("dev/ironcurtain/ca-cert.pem", b"public mount residue")
    )
    probe.inspected_layers = {
        image_id: layers for image_id, (_label, layers) in probe.form_image_layers.items()
    }
    try:
        probe._validate_saved_form_layers(
            archive, tuple(probe.form_image_layers), time.monotonic() + 30
        )
    except module["ProbeFailure"] as error:
        assert str(error) == "build-produced layer contains an IronCurtain trust mount stub"
    else:
        raise AssertionError("dev/ironcurtain entry passed added-layer structural proof")
`);
  });

  it('dispatches the exact root-only internal snapshot scanner with fixed bounded output', () => {
    runProbeAssertion(String.raw`
import contextlib, io, runpy, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
globals = module["internal_snapshot_scan_main"].__globals__
internal_main = module["internal_snapshot_scan_main"]
internal_arg = module["INTERNAL_SNAPSHOT_SCAN_ARG"]
begin = module["INTERNAL_SNAPSHOT_SCAN_BEGIN"] + "\n"
error_prefix = module["INTERNAL_SNAPSHOT_SCAN_ERROR"] + " "

class RecordingStream(io.StringIO):
    def __init__(self):
        super().__init__()
        self.flush_count = 0
    def flush(self):
        self.flush_count += 1
        super().flush()

def capture(function, *args):
    stdout = RecordingStream()
    stderr = RecordingStream()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        status = function(*args)
    capture.flushes = (stdout.flush_count, stderr.flush_count)
    return status, stdout.getvalue(), stderr.getvalue()

calls = []
globals["internal_snapshot_scan_main"] = lambda: calls.append("internal") or 37
assert capture(module["entrypoint"], ["probe", internal_arg]) == (37, "", "")
assert calls == ["internal"]
assert capture(module["entrypoint"], ["probe", internal_arg, "extra"]) == (
    2, "", "snapshot-scan:argv\n"
)
assert calls == ["internal"]

globals["os"].geteuid = lambda: 1000
assert capture(internal_main) == (
    1, begin + error_prefix + "snapshot-scan:euid\n", ""
)
assert capture.flushes == (2, 0)

globals["os"].geteuid = lambda: 0
module["Probe"]._scan_snapshot_filesystems_core = lambda self: None
assert capture(internal_main) == (
    0, begin + module["INTERNAL_SNAPSHOT_SCAN_SUCCESS"] + "\n", ""
)
assert capture.flushes == (2, 0)

def residue(_self):
    raise module["ProbeFailure"]("snapshot contains the IronCurtain CA private key")
module["Probe"]._scan_snapshot_filesystems_core = residue
assert capture(internal_main) == (
    1, begin + error_prefix + "snapshot-scan:residue\n", ""
)
assert capture.flushes == (2, 0)

def private_error(_self):
    raise OSError(13, "private detail", "/secret/root/uid-1000/key.pem")
module["Probe"]._scan_snapshot_filesystems_core = private_error
status, stdout, stderr = capture(internal_main)
assert (status, stdout, stderr) == (
    1, begin + error_prefix + "snapshot-scan:internal\n", ""
)
assert capture.flushes == (2, 0)
for forbidden in ("/secret", "private detail", "uid-1000", "key.pem", "Traceback"):
    assert forbidden not in stdout + stderr
`);
  });

  it('invokes only the exact privileged scanner command and rejects noncanonical results', () => {
    runProbeAssertion(String.raw`
import runpy, subprocess, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
globals = module["Probe"]._invoke_privileged_snapshot_scan.__globals__
real_runner = globals["run_bounded_snapshot_subprocess"]
expected_command = (
    "/usr/bin/sudo", "-n", "--", "/usr/bin/env", "-i",
    "PATH=/usr/bin:/bin", "LC_ALL=C", "/usr/bin/python3", "-I", "-B",
    "/workflow-scripts/nested_docker_probe.py", "--internal-snapshot-scan-v1",
)
calls = []

def set_result(returncode, stdout, stderr):
    def fake_run(argv, timeout_seconds, per_stream_output_limit, aggregate_output_limit):
        calls.append((argv, timeout_seconds, per_stream_output_limit, aggregate_output_limit))
        return subprocess.CompletedProcess(argv, returncode, stdout, stderr)
    globals["run_bounded_snapshot_subprocess"] = fake_run

try:
    begin = (module["INTERNAL_SNAPSHOT_SCAN_BEGIN"] + "\n").encode("ascii")
    success = begin + (module["INTERNAL_SNAPSHOT_SCAN_SUCCESS"] + "\n").encode("ascii")
    def failure(code):
        return begin + (module["INTERNAL_SNAPSHOT_SCAN_ERROR"] + " " + code + "\n").encode("ascii")
    assert len(success) <= module["PRIVILEGED_SNAPSHOT_SCAN_PER_STREAM_OUTPUT_LIMIT"]
    assert all(
        len(failure(code)) <= module["PRIVILEGED_SNAPSHOT_SCAN_PER_STREAM_OUTPUT_LIMIT"]
        for code in module["SNAPSHOT_SCAN_FAILURE_CODES"]
    )
    set_result(0, success, b"")
    module["Probe"]._invoke_privileged_snapshot_scan()
    argv, timeout_seconds, per_stream_output_limit, aggregate_output_limit = calls[-1]
    assert argv == expected_command
    assert timeout_seconds == module["PRIVILEGED_SNAPSHOT_SCAN_TIMEOUT_SECONDS"]
    assert per_stream_output_limit == module["PRIVILEGED_SNAPSHOT_SCAN_PER_STREAM_OUTPUT_LIMIT"]
    assert aggregate_output_limit == module["PRIVILEGED_SNAPSHOT_SCAN_AGGREGATE_OUTPUT_LIMIT"]

    set_result(1, failure("snapshot-entry:enumerate:eacces"), b"")
    try:
        module["Probe"]._invoke_privileged_snapshot_scan()
    except module["ProbeFailure"] as error:
        assert str(error) == "snapshot-entry:enumerate:eacces"
    else:
        raise AssertionError("allowlisted scanner failure status passed")

    rejected = (
        (0, b"", b"", "snapshot-scan:bootstrap"),
        (0, b"wrong\n", b"", "snapshot-scan:bootstrap"),
        (0, b"\xff\n", b"", "snapshot-scan:bootstrap"),
        (1, b"", b"/secret/root/private detail\n", "snapshot-scan:bootstrap"),
        (1, begin, b"unexpected", "snapshot-scan:stderr"),
        (-9, b"", b"", "snapshot-scan:aborted"),
        (-9, begin, b"", "snapshot-scan:aborted"),
        (7, b"", b"", "snapshot-scan:unexpected-exit"),
        (7, begin, b"", "snapshot-scan:unexpected-exit"),
        (0, begin, b"", "snapshot-scan:protocol"),
        (0, success + b"residue", b"", "snapshot-scan:protocol"),
        (0, failure("snapshot-scan:residue"), b"", "snapshot-scan:protocol"),
        (1, begin, b"", "snapshot-scan:protocol"),
        (1, failure("snapshot-scan:residue") + b"residue", b"", "snapshot-scan:protocol"),
        (1, failure("snapshot-scan:residue") + b"extra\n", b"", "snapshot-scan:protocol"),
        (1, begin + module["INTERNAL_SNAPSHOT_SCAN_ERROR"].encode("ascii") + b" \xff\n", b"", "snapshot-scan:protocol"),
        (1, failure("snapshot-scan:not-allowlisted"), b"", "snapshot-scan:unknown-code"),
        (9, b"x" * (module["PRIVILEGED_SNAPSHOT_SCAN_PER_STREAM_OUTPUT_LIMIT"] + 1), b"", "snapshot-scan:stdout-overflow"),
        (9, begin, b"x" * (module["PRIVILEGED_SNAPSHOT_SCAN_PER_STREAM_OUTPUT_LIMIT"] + 1), "snapshot-scan:stderr-overflow"),
    )
    for returncode, stdout, stderr, expected in rejected:
        set_result(returncode, stdout, stderr)
        try:
            module["Probe"]._invoke_privileged_snapshot_scan()
        except module["ProbeFailure"] as error:
            assert str(error) == expected
            assert "/secret" not in str(error) and "private detail" not in str(error)
        else:
            raise AssertionError(f"rejected privileged scanner result passed: {expected}")

    def timeout(_argv, _timeout_seconds, _per_stream_output_limit, _aggregate_output_limit):
        raise module["ProbeFailure"]("snapshot-scan:timeout")
    globals["run_bounded_snapshot_subprocess"] = timeout
    try:
        module["Probe"]._invoke_privileged_snapshot_scan()
    except module["ProbeFailure"] as error:
        assert str(error) == "snapshot-scan:timeout"
        assert "/secret" not in str(error) and "private" not in str(error)
    else:
        raise AssertionError("privileged scanner timeout passed")

    # The bounded runner executes only inside the Linux workflow VM. Running
    # these pipe-selector integration cases on a Darwin host exercises kqueue
    # scheduling that production never uses and can collapse a specific bound
    # into the deliberately fail-closed snapshot-scan:protocol fallback.
    if sys.platform == "linux":
        bounded = real_runner(
            ("/usr/bin/python3", "-I", "-B", "-c", "import sys;sys.stdout.write('ok')"),
            5,
            2,
            4,
        )
        assert (bounded.returncode, bounded.stdout, bounded.stderr) == (0, b"ok", b"")
        for command, timeout_seconds, per_stream_output_limit, aggregate_output_limit, expected in (
            (("/usr/bin/python3", "-I", "-B", "-c", "print('x' * 129)"), 5, 128, 256, "snapshot-scan:stdout-overflow"),
            (("/usr/bin/python3", "-I", "-B", "-c", "import sys;sys.stderr.write('x' * 129)"), 5, 128, 256, "snapshot-scan:stderr-overflow"),
            (("/usr/bin/python3", "-I", "-B", "-c", "import sys,time;sys.stdout.write('x'*70);sys.stdout.flush();time.sleep(.05);sys.stderr.write('y'*70);sys.stderr.flush()"), 5, 128, 128, "snapshot-scan:output-overflow"),
            (("/usr/bin/python3", "-I", "-B", "-c", "import sys,time;sys.stderr.write('y'*70);sys.stderr.flush();time.sleep(.05);sys.stdout.write('x'*70);sys.stdout.flush()"), 5, 128, 128, "snapshot-scan:output-overflow"),
            (("/usr/bin/python3", "-I", "-B", "-c", "import time;time.sleep(5)"), 0.05, 128, 256, "snapshot-scan:timeout"),
            (("/definitely/missing/ironcurtain-snapshot-helper",), 5, 128, 256, "snapshot-scan:launch"),
        ):
            try:
                real_runner(command, timeout_seconds, per_stream_output_limit, aggregate_output_limit)
            except module["ProbeFailure"] as error:
                assert str(error) == expected
            else:
                raise AssertionError(f"bounded subprocess accepted {expected}")

        signaled = real_runner(
            (
                "/usr/bin/python3", "-I", "-B", "-c",
                "import os,signal;print('IRONCURTAIN_SNAPSHOT_SCAN_BEGIN/1',flush=True);os.kill(os.getpid(),signal.SIGTERM)",
            ),
            5,
            128,
            256,
        )
        assert signaled.returncode < 0 and signaled.stdout == begin and signaled.stderr == b""
        set_result(signaled.returncode, signaled.stdout, signaled.stderr)
        try:
            module["Probe"]._invoke_privileged_snapshot_scan()
        except module["ProbeFailure"] as error:
            assert str(error) == "snapshot-scan:aborted"
        else:
            raise AssertionError("real signaled helper passed protocol admission")
finally:
    globals["run_bounded_snapshot_subprocess"] = real_runner
`);
  });

  it('requires a bounded resolvable Apple hostname and silent sudo before privileged scanning', () => {
    runProbeAssertion(String.raw`
import runpy, subprocess, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
preflight = module["Probe"]._validate_privileged_snapshot_scan_preflight
globals = preflight.__globals__
hostname = "ic-dw-agent-0123456789abcdef"
getent = ("/usr/bin/getent", "ahosts", hostname)
sudo = (
    "/usr/bin/sudo", "-n", "--", "/usr/bin/env", "-i",
    "PATH=/usr/bin:/bin", "LC_ALL=C", "/usr/bin/true",
)

def completed(argv, returncode=0, stdout=b"", stderr=b""):
    return subprocess.CompletedProcess(argv, returncode, stdout, stderr)

def install(host, getent_result=None, sudo_result=None, raised=None, raised_argv=None):
    globals["socket"].gethostname = lambda: host
    calls = []
    def run(argv, timeout_seconds, per_stream_output_limit, aggregate_output_limit):
        calls.append((argv, timeout_seconds, per_stream_output_limit, aggregate_output_limit))
        assert timeout_seconds == module["SNAPSHOT_SCAN_PREFLIGHT_COMMAND_TIMEOUT_SECONDS"]
        if raised is not None and (raised_argv is None or argv == raised_argv):
            raise raised
        if argv == getent:
            assert per_stream_output_limit == module["SNAPSHOT_SCAN_HOSTNAME_RESOLUTION_OUTPUT_LIMIT"]
            assert aggregate_output_limit == module["SNAPSHOT_SCAN_HOSTNAME_RESOLUTION_AGGREGATE_OUTPUT_LIMIT"]
            return getent_result or completed(argv, stdout=b"127.0.0.2 STREAM local\n")
        if argv == sudo:
            assert per_stream_output_limit == module["PRIVILEGED_SNAPSHOT_SCAN_PER_STREAM_OUTPUT_LIMIT"]
            assert aggregate_output_limit == module["PRIVILEGED_SNAPSHOT_SCAN_AGGREGATE_OUTPUT_LIMIT"]
            return sudo_result or completed(argv)
        raise AssertionError(argv)
    globals["run_bounded_snapshot_subprocess"] = run
    return calls

calls = install(hostname)
preflight()
assert [call[0] for call in calls] == [getent, sudo]

for unsafe_hostname in (
    "ic-dw-agent-0123456789abcde",
    "ic-dw-agent-0123456789abcdef0",
    "ic-dw-agent-0123456789abcdeF",
    "ic-dw-agent-0123456789abcde\n",
    "ironcurtain-0123456789abcdef",
):
    calls = install(unsafe_hostname)
    try:
        preflight()
    except module["ProbeFailure"] as error:
        assert str(error) == "snapshot-scan:hostname"
        assert unsafe_hostname not in str(error)
        assert calls == []
    else:
        raise AssertionError("unsafe Apple hostname passed snapshot preflight")

bad_resolution = (
    completed(getent, returncode=1),
    completed(getent, stdout=b""),
    completed(getent, stdout=b"   \n"),
    completed(getent, stdout=b"safe\x00unsafe\n"),
    completed(getent, stdout=b"safe\xff\n"),
    completed(getent, stdout=b"x" * (module["SNAPSHOT_SCAN_HOSTNAME_RESOLUTION_OUTPUT_LIMIT"] + 1)),
    completed(getent, stdout=b"127.0.0.2 STREAM local\n", stderr=b"private hostname detail"),
)
for result in bad_resolution:
    calls = install(hostname, getent_result=result)
    try:
        preflight()
    except module["ProbeFailure"] as error:
        assert str(error) == "snapshot-scan:hostname-resolution"
        assert "private" not in str(error) and hostname not in str(error)
        assert len(calls) == 1
    else:
        raise AssertionError("invalid hostname resolution passed snapshot preflight")

for result in (
    completed(sudo, returncode=1),
    completed(sudo, stdout=b"unexpected"),
    completed(sudo, stderr=b"sudo: unable to resolve host private-host\n"),
):
    calls = install(hostname, sudo_result=result)
    try:
        preflight()
    except module["ProbeFailure"] as error:
        assert str(error) == "snapshot-scan:sudo"
        assert "private-host" not in str(error) and hostname not in str(error)
        assert [call[0] for call in calls] == [getent, sudo]
    else:
        raise AssertionError("noisy or failed sudo passed snapshot preflight")

for raised in (
    module["ProbeFailure"]("snapshot-scan:launch"),
    module["ProbeFailure"]("snapshot-scan:timeout"),
):
    install(hostname, raised=raised)
    try:
        preflight()
    except module["ProbeFailure"] as error:
        assert str(error) == "snapshot-scan:hostname-resolution"
        assert "private" not in str(error) and hostname not in str(error)
    else:
        raise AssertionError("failed hostname preflight subprocess passed")

install(
    hostname,
    raised=module["ProbeFailure"]("snapshot-scan:timeout"),
    raised_argv=sudo,
)
try:
    preflight()
except module["ProbeFailure"] as error:
    assert str(error) == "snapshot-scan:sudo"
    assert hostname not in str(error)
else:
    raise AssertionError("failed sudo preflight subprocess passed")
`);
  });

  it('brackets the privileged scanner with exact daemon and tracked inventories', () => {
    runProbeAssertion(String.raw`
import json, runpy, subprocess, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
module["Probe"]._validate_privileged_snapshot_scan_preflight = lambda _self: None
container_id = "a" * 64
image_id = "sha256:" + "b" * 64
daemon_root = str(module["DAEMON_DATA_ROOT"])
security_options = ("name=rootless", "name=seccomp,profile=builtin")

def completed(args, stdout):
    return subprocess.CompletedProcess(args, 0, stdout, "")

def stable_docker(*args, **kwargs):
    calls.append((args, kwargs))
    if args == ("info", "--format", "{{json .}}"):
        return completed(args, json.dumps({"ID": "daemon-id", "DockerRootDir": daemon_root, "Driver": "vfs", "SecurityOptions": list(security_options)}))
    if args == ("container", "ls", "--all", "--quiet", "--no-trunc"):
        return completed(args, container_id + "\n")
    if args == ("container", "ls", "--quiet", "--no-trunc"):
        return completed(args, container_id + "\n")
    if args == ("image", "ls", "--all", "--quiet", "--no-trunc"):
        return completed(args, image_id + "\n" + image_id + "\n")
    raise AssertionError(args)

probe = module["Probe"]("packages")
probe.container_ids = [container_id]
probe.initial_image_ids = (image_id,)
probe.admitted_daemon_identity = ("daemon-id", daemon_root, "vfs", security_options)
calls = []
probe.docker = stable_docker
invocations = []
probe._validate_privileged_snapshot_scan_preflight = lambda: invocations.append("preflight")
probe._invoke_privileged_snapshot_scan = lambda: invocations.append("scan")
probe._scan_snapshot_filesystems()
assert invocations == ["preflight", "scan"]
assert probe.checks == ["packages.snapshot-preflight", "packages.snapshot-residue"]
assert [args for args, _kwargs in calls] == [
    ("info", "--format", "{{json .}}"),
    ("container", "ls", "--all", "--quiet", "--no-trunc"),
    ("container", "ls", "--quiet", "--no-trunc"),
    ("image", "ls", "--all", "--quiet", "--no-trunc"),
] * 2
assert all(kwargs == {"timeout": 30} for args, kwargs in calls if args[0] == "info")

drift = module["Probe"]("packages")
drift.container_ids = [container_id]
drift.initial_image_ids = (image_id,)
drift.admitted_daemon_identity = ("daemon-id", daemon_root, "vfs", security_options)
drift_calls = {"running": 0}
def drifting_docker(*args, **kwargs):
    if args == ("info", "--format", "{{json .}}"):
        return completed(args, json.dumps({"ID": "daemon-id", "DockerRootDir": daemon_root, "Driver": "vfs", "SecurityOptions": list(security_options)}))
    if args == ("container", "ls", "--all", "--quiet", "--no-trunc"):
        return completed(args, container_id + "\n")
    if args == ("container", "ls", "--quiet", "--no-trunc"):
        drift_calls["running"] += 1
        return completed(args, container_id + "\n" if drift_calls["running"] == 1 else "")
    if args == ("image", "ls", "--all", "--quiet", "--no-trunc"):
        return completed(args, image_id + "\n" + image_id + "\n")
    raise AssertionError(args)
drift.docker = drifting_docker
drift._invoke_privileged_snapshot_scan = lambda: None
try:
    drift._scan_snapshot_filesystems()
except module["ProbeFailure"] as error:
    assert str(error).startswith(
        "privileged snapshot scan contains every and only running tracked container"
    )
else:
    raise AssertionError("post-scan container inventory drift passed")

daemon_failure = module["Probe"]("packages")
daemon_failure.container_ids = [container_id]
daemon_failure.initial_image_ids = (image_id,)
daemon_failure.admitted_daemon_identity = ("daemon-id", daemon_root, "vfs", security_options)
info_calls = {"count": 0}
def failing_daemon(*args, **kwargs):
    if args == ("info", "--format", "{{json .}}"):
        info_calls["count"] += 1
        if info_calls["count"] == 2:
            raise module["ProbeFailure"]("daemon info failed")
    return stable_docker(*args, **kwargs)
daemon_failure.docker = failing_daemon
daemon_failure._invoke_privileged_snapshot_scan = lambda: None
try:
    daemon_failure._scan_snapshot_filesystems()
except module["ProbeFailure"] as error:
    assert str(error) == "daemon info failed"
else:
    raise AssertionError("post-scan daemon failure passed")

for drift_kind, expected_prefix in (
    ("daemon", "privileged snapshot scan retains the admitted daemon identity"),
    ("security", "privileged snapshot scan retains the admitted daemon identity"),
    ("root", "nested Docker daemon identity is not exact"),
    ("image", "privileged snapshot scan contains every and only tracked image"),
):
    changed = module["Probe"]("packages")
    changed.container_ids = [container_id]
    changed.initial_image_ids = (image_id,)
    changed.admitted_daemon_identity = ("daemon-id", daemon_root, "vfs", security_options)
    observations = {"info": 0, "image": 0}
    def changed_docker(*args, **kwargs):
        if args == ("info", "--format", "{{json .}}"):
            observations["info"] += 1
            daemon_id = "daemon-id"
            if drift_kind == "daemon" and observations["info"] == 2:
                daemon_id = "replacement-daemon-id"
            observed_root = daemon_root
            if drift_kind == "root" and observations["info"] == 2:
                observed_root = "/wrong-daemon-root"
            observed_security = security_options
            if drift_kind == "security" and observations["info"] == 2:
                observed_security = ("name=rootless", "name=apparmor")
            return completed(args, json.dumps({"ID": daemon_id, "DockerRootDir": observed_root, "Driver": "vfs", "SecurityOptions": list(observed_security)}))
        if args == ("container", "ls", "--all", "--quiet", "--no-trunc"):
            return completed(args, container_id + "\n")
        if args == ("container", "ls", "--quiet", "--no-trunc"):
            return completed(args, container_id + "\n")
        if args == ("image", "ls", "--all", "--quiet", "--no-trunc"):
            observations["image"] += 1
            images = image_id + "\n" + image_id + "\n"
            if drift_kind == "image" and observations["image"] == 2:
                images += "sha256:" + "c" * 64 + "\n"
            return completed(args, images)
        raise AssertionError(args)
    changed.docker = changed_docker
    changed._invoke_privileged_snapshot_scan = lambda: None
    try:
        changed._scan_snapshot_filesystems()
    except module["ProbeFailure"] as error:
        assert str(error).startswith(expected_prefix)
    else:
        raise AssertionError(f"post-scan {drift_kind} drift passed")
`);
  });

  it('requires the exact graphdriver-backed VFS and BuildKit metadata topology', () => {
    runProbeAssertion(String.raw`
import os, runpy, sys, tempfile, time
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name="probe_test")
globals = module["Probe"]._validated_snapshot_roots.__globals__
assert tuple(module["BUILDKIT_EXECUTOR_ARTIFACT_LIMITS"]) == (
    "hosts", "resolv.conf", "resolv-host.conf", "runc-log.json",
)
assert module["BUILDKIT_EXECUTOR_ARTIFACT_LIMITS"]["resolv-host.conf"] == 64 * 1024

def make_vfs(daemon_root):
    root = daemon_root / "vfs" / "dir"
    root.mkdir(parents=True)
    return root

def make_buildkit(daemon_root):
    root = daemon_root / "buildkit"
    executor = root / "executor"
    executor.mkdir(parents=True)
    (root / "snapshots.db").write_bytes(b"bounded bolt metadata")
    (executor / "hosts").write_bytes(b"127.0.0.1 localhost buildkitsandbox\n")
    (executor / "resolv.conf").write_bytes(b"nameserver 127.0.0.11\n")
    (executor / "resolv-host.conf").write_bytes(b"nameserver 127.0.0.11\n")
    (executor / "runc-log.json").write_bytes(b"")
    return root

for root_class in ("vfs", "buildkit"):
    for shape in ("missing", "symlink", "type"):
        with tempfile.TemporaryDirectory() as directory:
            daemon_root = Path(directory) / "daemon"
            make_buildkit(daemon_root) if root_class == "vfs" else make_vfs(daemon_root)
            root = daemon_root / "vfs" / "dir" if root_class == "vfs" else daemon_root / "buildkit"
            root.parent.mkdir(parents=True, exist_ok=True)
            if shape == "symlink":
                backing = Path(directory) / "backing"
                backing.mkdir()
                root.symlink_to(backing, target_is_directory=True)
            elif shape == "type":
                root.write_bytes(b"not a directory")
            globals["DAEMON_DATA_ROOT"] = daemon_root
            try:
                module["Probe"]._validated_snapshot_roots(time.monotonic() + 5)
            except module["ProbeFailure"] as error:
                assert str(error) == f"snapshot-root:{root_class}:{shape}"
                assert module["snapshot_scan_failure_code"](error) == str(error)
                assert str(error) in module["SNAPSHOT_SCAN_FAILURE_CODES"]
                assert str(daemon_root) not in str(error)
            else:
                raise AssertionError(f"accepted {shape} {root_class} snapshot root")

with tempfile.TemporaryDirectory() as directory:
    daemon_root = Path(directory) / "daemon"
    make_vfs(daemon_root)
    buildkit = make_buildkit(daemon_root)
    globals["DAEMON_DATA_ROOT"] = daemon_root
    deadline = lambda: time.monotonic() + 5
    assert module["Probe"]._validated_snapshot_roots(deadline()) == (("vfs", daemon_root / "vfs" / "dir"),)

    unsupported = buildkit / "snapshots"
    unsupported.mkdir()
    try:
        module["Probe"]._validated_snapshot_roots(deadline())
    except module["ProbeFailure"] as error:
        assert str(error) == "buildkit-layout:snapshots-present"
    else:
        raise AssertionError("standalone BuildKit snapshot directory passed graphdriver topology")
    unsupported.rmdir()

    metadata = buildkit / "snapshots.db"
    for shape, expected in (
        ("missing", "buildkit-metadata:missing"),
        ("symlink", "buildkit-metadata:symlink"),
        ("type", "buildkit-metadata:type"),
        ("empty", "buildkit-metadata:empty"),
        ("links", "buildkit-metadata:links"),
        ("bounds", "buildkit-metadata:bounds"),
    ):
        original = metadata.read_bytes()
        metadata.unlink()
        cleanup = None
        if shape == "symlink":
            backing = buildkit / "metadata-backing"
            backing.write_bytes(original)
            metadata.symlink_to(backing)
            cleanup = backing
        elif shape == "type":
            metadata.mkdir()
        elif shape == "empty":
            metadata.write_bytes(b"")
        elif shape == "links":
            metadata.write_bytes(original)
            linked = buildkit / "metadata-link"
            os.link(metadata, linked)
            cleanup = linked
        elif shape == "bounds":
            with metadata.open("wb") as handle:
                handle.truncate(module["MAX_BUILDKIT_SNAPSHOT_METADATA_BYTES"] + 1)
        try:
            module["Probe"]._validated_snapshot_roots(deadline())
        except module["ProbeFailure"] as error:
            assert str(error) == expected
            assert str(error) in module["SNAPSHOT_SCAN_FAILURE_CODES"]
        else:
            raise AssertionError(f"accepted unsafe snapshots.db shape: {shape}")
        if metadata.is_dir():
            metadata.rmdir()
        else:
            metadata.unlink(missing_ok=True)
        if cleanup is not None:
            cleanup.unlink()
        metadata.write_bytes(original)

    real_read = globals["os"].read
    mutated = False
    def mutating_read(descriptor, size):
        global mutated
        chunk = real_read(descriptor, size)
        if not mutated:
            mutated = True
            with metadata.open("ab") as handle:
                handle.write(b"drift")
        return chunk
    globals["os"].read = mutating_read
    try:
        try:
            module["Probe"]._validated_snapshot_roots(deadline())
        except module["ProbeFailure"] as error:
            assert str(error) == "buildkit-metadata:unstable"
        else:
            raise AssertionError("changing snapshots.db passed stable descriptor proof")
    finally:
        globals["os"].read = real_read
        metadata.write_bytes(b"bounded bolt metadata")

    executor = buildkit / "executor"
    saved_executor = buildkit / "executor.saved"
    for shape, expected in (
        ("missing", "buildkit-executor:missing"),
        ("symlink", "buildkit-executor:symlink"),
        ("type", "buildkit-executor:type"),
    ):
        executor.rename(saved_executor)
        if shape == "symlink":
            executor.symlink_to(saved_executor, target_is_directory=True)
        elif shape == "type":
            executor.write_bytes(b"not a directory")
        try:
            module["Probe"]._validated_snapshot_roots(deadline())
        except module["ProbeFailure"] as error:
            assert str(error) == expected
        else:
            raise AssertionError(f"accepted unsafe executor root: {shape}")
        executor.unlink(missing_ok=True)
        saved_executor.rename(executor)

    bundle = executor / ("a" * 26)
    bundle.mkdir()
    try:
        module["Probe"]._validated_snapshot_roots(deadline())
    except module["ProbeFailure"] as error:
        assert str(error) == "buildkit-executor:entry"
    else:
        raise AssertionError("active executor bundle passed quiescence check")
    bundle.rmdir()

    artifact = executor / "hosts"
    artifact.unlink()
    artifact.symlink_to(executor / "resolv.conf")
    try:
        module["Probe"]._validated_snapshot_roots(deadline())
    except module["ProbeFailure"] as error:
        assert str(error) == "buildkit-executor:artifact:symlink"
    else:
        raise AssertionError("executor artifact symlink passed quiescence check")
    artifact.unlink()
    artifact.write_bytes(b"hosts")

    linked = buildkit / "hosts.link"
    os.link(artifact, linked)
    try:
        module["Probe"]._validated_snapshot_roots(deadline())
    except module["ProbeFailure"] as error:
        assert str(error) == "buildkit-executor:artifact:links"
    else:
        raise AssertionError("hardlinked executor artifact passed quiescence check")
    linked.unlink()

    artifact.unlink()
    os.mkfifo(artifact)
    try:
        module["Probe"]._validated_snapshot_roots(deadline())
    except module["ProbeFailure"] as error:
        assert str(error) == "buildkit-executor:artifact:type"
    else:
        raise AssertionError("executor FIFO passed quiescence check")
    artifact.unlink()
    artifact.write_bytes(b"hosts")

    for shape, expected in (
        ("empty", "buildkit-executor:artifact:empty"),
        ("bounds", "buildkit-executor:artifact:bounds"),
    ):
        if shape == "empty":
            artifact.write_bytes(b"")
        else:
            with artifact.open("wb") as handle:
                handle.truncate(module["BUILDKIT_EXECUTOR_ARTIFACT_LIMITS"]["hosts"] + 1)
        try:
            module["Probe"]._validated_snapshot_roots(deadline())
        except module["ProbeFailure"] as error:
            assert str(error) == expected
        else:
            raise AssertionError(f"accepted unsafe executor artifact: {shape}")
        artifact.write_bytes(b"hosts")
`);
  });

  it('captures the exact rootless daemon identity during initial admission', () => {
    runProbeAssertion(String.raw`
import json, os, runpy, subprocess, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
image_id = "sha256:" + "d" * 64
security_options = ["name=rootless", "name=seccomp,profile=builtin"]
daemon_info = {
    "ID": "admitted-daemon-id",
    "DockerRootDir": str(module["DAEMON_DATA_ROOT"]),
    "Driver": "vfs",
    "SecurityOptions": security_options,
}
probe = module["Probe"]("packages")
def completed(args, stdout):
    return subprocess.CompletedProcess(args, 0, stdout, "")
def docker(*args, **_kwargs):
    if args == ("version", "--format", "{{.Server.Version}}"):
        return completed(args, "28.0.0\n")
    if args == ("info", "--format", "{{json .}}"):
        return completed(args, json.dumps(daemon_info))
    if args == ("network", "inspect", module["EXPECTED_NETWORK"]):
        return completed(args, json.dumps([{
            "Name": module["EXPECTED_NETWORK"], "Driver": "bridge",
            "Internal": True, "Containers": {},
        }]))
    if args == ("container", "ls", "--all", "--quiet"):
        return completed(args, "")
    if args == ("image", "ls", "--all", "--quiet", "--no-trunc"):
        return completed(args, image_id + "\n" + image_id + "\n")
    raise AssertionError(args)
probe.docker = docker
os.environ["DOCKER_HOST"] = module["EXPECTED_DOCKER_HOST"]
os.environ["IRONCURTAIN_DOCKER_NETWORK"] = module["EXPECTED_NETWORK"]
assert probe.validate_common() == image_id
assert probe.initial_image_ids == (image_id,)
assert probe.admitted_daemon_identity == (
    "admitted-daemon-id", str(module["DAEMON_DATA_ROOT"]), "vfs", tuple(security_options)
)

for invalid in (
    {**daemon_info, "DockerRootDir": "/wrong-root"},
    {**daemon_info, "SecurityOptions": ["name=seccomp,profile=builtin"]},
    {**daemon_info, "SecurityOptions": ["name=rootless", 7]},
):
    try:
        module["Probe"]._daemon_identity(invalid)
    except module["ProbeFailure"] as error:
        assert str(error) == "nested Docker daemon identity is not exact"
    else:
        raise AssertionError(f"accepted invalid daemon identity: {invalid!r}")
`);
  });

  it('uses the production O_PATH pin and proc-fd reopen when the host supports it', () => {
    runProbeAssertion(String.raw`
import errno, os, runpy, stat, sys, tempfile
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name="probe_test")
Probe = module["Probe"]
ProbeFailure = module["ProbeFailure"]

try:
    Probe._require_snapshot_scan_capabilities()
except ProbeFailure as error:
    # Darwin and older Linux/Python runners may expose O_PATH without the full
    # descriptor API contract. Production must reject every such host before
    # traversal instead of selecting a weaker pathname fallback.
    assert str(error) == "snapshot-scan:capability"
else:
    assert sys.platform == "linux"
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        payload = b"production descriptor fixture"
        (root / "candidate").write_bytes(payload)
        parent_descriptor = -1
        try:
            parent_descriptor = os.open(
                root,
                os.O_RDONLY
                | os.O_DIRECTORY
                | os.O_NONBLOCK
                | os.O_NOFOLLOW
                | os.O_CLOEXEC,
            )
            expected = os.stat(
                b"candidate",
                dir_fd=parent_descriptor,
                follow_symlinks=False,
            )
            pin_descriptor, read_descriptor = Probe._open_pinned_snapshot_regular_file(
                parent_descriptor,
                b"candidate",
                expected,
            )
            try:
                assert pin_descriptor != read_descriptor
                pinned = os.fstat(pin_descriptor)
                opened = os.fstat(read_descriptor)
                assert stat.S_ISREG(pinned.st_mode) and stat.S_ISREG(opened.st_mode)
                assert Probe._snapshot_identity_is_exact(pinned, expected)
                assert Probe._snapshot_identity_is_exact(opened, pinned)
                try:
                    os.read(pin_descriptor, 1)
                except OSError as error:
                    assert error.errno == errno.EBADF
                else:
                    raise AssertionError("production pin descriptor was directly readable")
                assert os.read(read_descriptor, len(payload) + 1) == payload
                assert os.read(read_descriptor, 1) == b""
            finally:
                Probe._close_snapshot_descriptors(
                    (pin_descriptor, read_descriptor),
                    phase="file-close",
                    primary_error=None,
                )
            for descriptor in (pin_descriptor, read_descriptor):
                try:
                    os.fstat(descriptor)
                except OSError as error:
                    assert error.errno == errno.EBADF
                else:
                    raise AssertionError(f"successful snapshot descriptor leaked: {descriptor}")

            race_expected = os.stat(
                b"candidate",
                dir_fd=parent_descriptor,
                follow_symlinks=False,
            )
            opener_globals = Probe._open_pinned_snapshot_regular_file.__func__.__globals__
            real_open = opener_globals["os"].open
            race_descriptors = []
            reopen_paths = []
            def replace_path_before_reopen(path, *args, **kwargs):
                is_proc_reopen = isinstance(path, str) and path.startswith("/proc/self/fd/")
                if is_proc_reopen:
                    assert reopen_paths == []
                    (root / "candidate").rename(root / "pinned-original")
                    (root / "candidate").write_bytes(b"replacement pathname fixture")
                    reopen_paths.append(path)
                descriptor = real_open(path, *args, **kwargs)
                if path == b"candidate" or is_proc_reopen:
                    race_descriptors.append(descriptor)
                return descriptor
            fd_count_before = len(os.listdir("/proc/self/fd"))
            opener_globals["os"].open = replace_path_before_reopen
            try:
                try:
                    Probe._open_pinned_snapshot_regular_file(
                        parent_descriptor,
                        b"candidate",
                        race_expected,
                    )
                except ProbeFailure as error:
                    assert str(error) == "snapshot-scan:unstable"
                else:
                    raise AssertionError("pathname replacement passed the production opener")
            finally:
                opener_globals["os"].open = real_open
            assert len(os.listdir("/proc/self/fd")) == fd_count_before
            assert len(race_descriptors) == 2
            assert reopen_paths == [f"/proc/self/fd/{race_descriptors[0]}"]
            for descriptor in race_descriptors:
                try:
                    os.fstat(descriptor)
                except OSError as error:
                    assert error.errno == errno.EBADF
                else:
                    raise AssertionError(f"failed snapshot descriptor leaked: {descriptor}")
        finally:
            if parent_descriptor >= 0:
                os.close(parent_descriptor)

        try:
            os.fstat(parent_descriptor)
        except OSError as error:
            assert error.errno == errno.EBADF
        else:
            raise AssertionError(f"production parent descriptor leaked: {parent_descriptor}")
`);
  });

  it('screens every snapshot file by CA SPKI while accepting unrelated private keys', () => {
    runProbeAssertion(String.raw`
import errno, os, runpy, stat, subprocess, sys, tempfile
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name="probe_test")

# The focused production-opener test above covers the complete Linux
# descriptor-capability set and real O_PATH/proc-fd path.
# This host-side traversal test always supplies its own already-open regular
# descriptor plus dup so its result cannot depend on the CI runner's Python or
# kernel capability exposure.
module["Probe"]._require_snapshot_scan_capabilities = staticmethod(lambda: None)
def test_open_pinned(cls, parent_descriptor, component, expected):
    try:
        descriptor = os.open(
            component,
            os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=parent_descriptor,
        )
    except OSError as error:
        cls._raise_snapshot_operation_failure(
            "file-pin", error, replacement_possible=True
        )
    try:
        observed = os.fstat(descriptor)
        if not stat.S_ISREG(observed.st_mode) or not cls._snapshot_identity_is_exact(
            observed, expected
        ):
            raise module["ProbeFailure"]("snapshot-scan:unstable")
        return descriptor, os.dup(descriptor)
    except BaseException:
        os.close(descriptor)
        raise
module["Probe"]._open_pinned_snapshot_regular_file = classmethod(test_open_pinned)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    ca_key = root / "ca-private.pem"
    ca_key_pkcs1 = root / "ca-private-pkcs1.pem"
    ca_cert = root / "ca-cert.pem"
    unrelated_key = root / "unrelated-private.pem"
    unrelated_key_pkcs1 = root / "unrelated-private-pkcs1.pem"
    unrelated_cert = root / "unrelated-cert.pem"
    for key, key_pkcs1, cert, name in (
        (ca_key, ca_key_pkcs1, ca_cert, "ironcurtain-snapshot-test"),
        (unrelated_key, unrelated_key_pkcs1, unrelated_cert, "unrelated-snapshot-test"),
    ):
        subprocess.run(
            [
                "/usr/bin/openssl", "genpkey", "-algorithm", "RSA",
                "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(key),
            ],
            check=True,
            capture_output=True,
        )
        traditional = subprocess.run(
            [
                "/usr/bin/openssl", "rsa", "-in", str(key), "-traditional",
                "-out", str(key_pkcs1),
            ],
            capture_output=True,
        )
        if traditional.returncode != 0:
            subprocess.run(
                ["/usr/bin/openssl", "rsa", "-in", str(key), "-out", str(key_pkcs1)],
                check=True,
                capture_output=True,
            )
        assert key.read_bytes().startswith(b"-----BEGIN PRIVATE KEY-----")
        assert key_pkcs1.read_bytes().startswith(b"-----BEGIN RSA PRIVATE KEY-----")
        subprocess.run(
            [
                "/usr/bin/openssl", "req", "-x509", "-new", "-key", str(key),
                "-subj", f"/CN={name}", "-out", str(cert),
            ],
            check=True,
            capture_output=True,
        )
    apt = root / "apt.conf"
    contract = root / "contract.json"
    apt.write_text('Acquire::Retries "0";\n', encoding="utf-8")
    contract.write_text('{"schemaVersion":1}\n', encoding="utf-8")
    globals = module["Probe"]._scan_snapshot_filesystems.__globals__
    globals["AGENT_CA_CERT"] = ca_cert
    globals["PACKAGE_APT_CONFIG"] = apt
    globals["PACKAGE_CONTRACT"] = contract
    globals["DAEMON_DATA_ROOT"] = root / "daemon"
    snapshot = globals["DAEMON_DATA_ROOT"] / "vfs" / "dir" / "one" / "rootfs"
    snapshot.mkdir(parents=True)
    buildkit = globals["DAEMON_DATA_ROOT"] / "buildkit"
    executor = buildkit / "executor"
    executor.mkdir(parents=True)
    (buildkit / "snapshots.db").write_bytes(b"bounded bolt metadata")
    (executor / "hosts").write_bytes(b"127.0.0.1 localhost buildkitsandbox\n")
    (executor / "resolv.conf").write_bytes(b"nameserver 127.0.0.11\n")
    (executor / "resolv-host.conf").write_bytes(b"nameserver 127.0.0.11\n")
    (executor / "runc-log.json").write_bytes(b"")
    content = buildkit / "content" / "ingest"
    content.mkdir(parents=True)
    (content / "fixture-context").write_bytes(
        contract.read_bytes() + b"\n/dev/ironcurtain/ca-cert.pem\n"
    )
    candidate = snapshot / "candidate.pem"
    candidate.write_bytes(unrelated_key.read_bytes() + b"\n" + unrelated_key_pkcs1.read_bytes())

    accepted = module["Probe"]("packages")
    accepted._scan_snapshot_filesystems_core()
    assert accepted.checks == []

    # The selected agent image legitimately contains trust-path strings in its
    # implementation. Only an actual dev/ironcurtain path (checked structurally)
    # or exact per-session authority contents are VFS residue.
    candidate.write_bytes(b"/dev/ironcurtain/ca-cert.pem\nIRONCURTAIN_API_KEY\n")
    path_text_accepted = module["Probe"]("packages")
    path_text_accepted._scan_snapshot_filesystems_core()
    assert path_text_accepted.checks == []

    for matching_key in (ca_key, ca_key_pkcs1):
        candidate.write_bytes(matching_key.read_bytes())
        rejected = module["Probe"]("packages")
        try:
            rejected._scan_snapshot_filesystems_core()
        except module["ProbeFailure"] as error:
            message = str(error)
            assert message == "snapshot contains the IronCurtain CA private key"
            assert module["snapshot_scan_failure_code"](error) == "snapshot-scan:residue"
            assert "PRIVATE KEY" not in message and "sha256" not in message
            assert str(matching_key) not in message and str(candidate) not in message
        else:
            raise AssertionError("snapshot accepted the matching CA private key")

    candidate.write_bytes(contract.read_bytes())
    exact_rejected = module["Probe"]("packages")
    try:
        exact_rejected._scan_snapshot_filesystems_core()
    except module["ProbeFailure"] as error:
        message = str(error)
        assert message == "snapshot contains exact IronCurtain public trust residue"
        assert module["snapshot_scan_failure_code"](error) == "snapshot-scan:residue"
        assert str(candidate) not in message and contract.read_text(encoding="utf-8").strip() not in message
    else:
        raise AssertionError("snapshot accepted exact public trust contract residue")

    candidate.write_bytes(b"unrelated")
    safe = snapshot / "safe"
    safe.mkdir()
    link = safe / "innocent"
    for target in ("/proc/mounts", "../../../../proc/mounts"):
        link.symlink_to(target)
        safe_link = module["Probe"]("packages")
        safe_link._scan_snapshot_filesystems_core()
        link.unlink()
    link_cases = (
        ("../dev/ironcurtain/ca-cert.pem", "snapshot link reaches an IronCurtain trust mount"),
        ("/dev/ironcurtain/ca-cert.pem", "snapshot link reaches an IronCurtain trust mount"),
        ("/dev/./ironcurtain/ca-cert.pem", "snapshot link reaches an IronCurtain trust mount"),
        ("/proc/self/root/dev/ironcurtain/ca-cert.pem", "snapshot link reaches an IronCurtain trust mount"),
    )
    for target, expected_error in link_cases:
        link.symlink_to(target)
        path_rejected = module["Probe"]("packages")
        try:
            path_rejected._scan_snapshot_filesystems_core()
        except module["ProbeFailure"] as error:
            assert str(error) == expected_error
        else:
            raise AssertionError(f"snapshot accepted unsafe symlink target: {target!r}")
        link.unlink()

    hardlink = snapshot / "hardlink.pem"
    globals["os"].link(ca_key, hardlink)
    hardlink_rejected = module["Probe"]("packages")
    try:
        hardlink_rejected._scan_snapshot_filesystems_core()
    except module["ProbeFailure"] as error:
        assert str(error) == "snapshot contains the IronCurtain CA private key"
    else:
        raise AssertionError("snapshot hardlink contents bypassed private-key scanning")
    hardlink.unlink()

    real_scandir = globals["os"].scandir
    def unreadable_scandir(descriptor):
        if isinstance(descriptor, int):
            raise PermissionError(errno.EACCES, "private detail", "/secret/snapshot/subtree")
        return real_scandir(descriptor)
    globals["os"].scandir = unreadable_scandir
    try:
        unreadable = module["Probe"]("packages")
        try:
            unreadable._scan_snapshot_filesystems_core()
        except module["ProbeFailure"] as error:
            assert str(error) == "snapshot-entry:enumerate:eacces"
            assert "/secret/snapshot/subtree" not in str(error)
        else:
            raise AssertionError("snapshot scan ignored an unreadable subtree")
    finally:
        globals["os"].scandir = real_scandir

    candidate.unlink()
    try:
        module["Probe"]("packages")._scan_snapshot_filesystems_core()
    except module["ProbeFailure"] as error:
        assert str(error) == "snapshot-root:vfs:empty"
        assert module["snapshot_scan_failure_code"](error) == str(error)
        assert str(globals["DAEMON_DATA_ROOT"]) not in str(error)
    else:
        raise AssertionError("nonempty BuildKit root masked an empty VFS root")
`);
  });

  it('maps snapshot entry failures to fixed phase and errno classes without leaking details', () => {
    runProbeAssertion(String.raw`
import errno, runpy, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
cases = (
    ("enumerate", errno.EACCES, "snapshot-entry:enumerate:eacces"),
    ("file-read", errno.ESTALE, "snapshot-entry:file-read:estale"),
    ("metadata", errno.EPERM, "snapshot-entry:metadata:eacces"),
    ("file-open", errno.EIO, "snapshot-entry:file-open:other"),
)
for phase, error_number, expected in cases:
    source = OSError(error_number, "private detail", "/secret/root/uid-1000/key.pem")
    try:
        module["raise_snapshot_entry_failure"](phase, source)
    except module["ProbeFailure"] as error:
        observed = str(error)
        assert observed == expected
        assert observed.isascii() and len(observed.encode("ascii")) <= 48
        for forbidden in (
            "/secret/root/uid-1000/key.pem",
            "private detail",
            "uid-1000",
            "key.pem",
            "Traceback",
        ):
            assert forbidden not in observed
    else:
        raise AssertionError(f"snapshot entry error did not fail closed: {expected}")

try:
    module["raise_snapshot_entry_failure"](
        "not-a-production-phase", OSError(errno.EIO, "private detail", "/secret")
    )
except module["ProbeFailure"] as error:
    assert str(error) == "snapshot-scan:internal"
else:
    raise AssertionError("unknown snapshot phase escaped the internal-invariant class")
`);
  });

  it('traverses VFS through stable no-follow descriptors with aggregate bounds and no FD leaks', () => {
    runProbeAssertion(String.raw`
import errno, os, runpy, stat, sys, tempfile, time
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name="probe_test")
Probe = module["Probe"]
ProbeFailure = module["ProbeFailure"]
globals = Probe._scan_snapshot_filesystems_core.__globals__

# The production gate remains fail closed on a non-Linux runtime, independent
# of whichever descriptor capabilities this host happens to expose.
real_platform = globals["sys"].platform
globals["sys"].platform = "unsupported-test-host"
try:
    try:
        Probe._require_snapshot_scan_capabilities()
    except ProbeFailure as error:
        assert str(error) == "snapshot-scan:capability"
    else:
        raise AssertionError("snapshot scanner accepted a non-Linux host")
finally:
    globals["sys"].platform = real_platform

# Exercise traversal with deterministic test descriptors rather than making
# its result conditional on the host runner's full Linux capability matrix.
Probe._require_snapshot_scan_capabilities = staticmethod(lambda: None)
def test_open_pinned(cls, parent_descriptor, component, expected):
    descriptor = -1
    try:
        try:
            descriptor = os.open(
                component,
                os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=parent_descriptor,
            )
        except OSError as error:
            cls._raise_snapshot_operation_failure(
                "file-pin", error, replacement_possible=True
            )
        observed = os.fstat(descriptor)
        if not stat.S_ISREG(observed.st_mode) or not cls._snapshot_identity_is_exact(
            observed, expected
        ):
            raise ProbeFailure("snapshot-scan:unstable")
        return descriptor, os.dup(descriptor)
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        raise
Probe._open_pinned_snapshot_regular_file = classmethod(test_open_pinned)

public_spki = b"-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"
def probe_for(root):
    probe = Probe("packages")
    probe._validated_snapshot_roots = lambda _deadline: (("vfs", root),)
    probe._exact_authority_markers = lambda: ()
    probe._ca_public_spki = lambda _deadline: public_spki
    return probe

def expect_failure(probe, expected):
    try:
        probe._scan_snapshot_filesystems_core()
    except ProbeFailure as error:
        observed = module["snapshot_scan_failure_code"](error)
        assert observed == expected, (str(error), observed, expected)
        assert observed in module["SNAPSHOT_SCAN_FAILURE_CODES"]
        for forbidden in ("/secret", "uid-1000", "private detail", "Traceback"):
            assert forbidden not in observed
    else:
        raise AssertionError(f"snapshot traversal accepted {expected}")

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory) / "vfs"
    root.mkdir()
    seed = root / "seed"
    seed.write_bytes(b"safe")
    real_open = globals["os"].open
    real_dup = globals["os"].dup
    real_close = globals["os"].close
    live_descriptors = set()
    opened_components = []
    def tracking_open(path, *args, **kwargs):
        descriptor = real_open(path, *args, **kwargs)
        assert descriptor not in live_descriptors
        live_descriptors.add(descriptor)
        if isinstance(path, bytes):
            opened_components.append(path)
        return descriptor
    def tracking_dup(descriptor):
        duplicate = real_dup(descriptor)
        assert duplicate not in live_descriptors
        live_descriptors.add(duplicate)
        return duplicate
    def tracking_close(descriptor):
        assert descriptor in live_descriptors, (descriptor, live_descriptors)
        live_descriptors.remove(descriptor)
        return real_close(descriptor)
    globals["os"].open = tracking_open
    globals["os"].dup = tracking_dup
    globals["os"].close = tracking_close
    try:
        probe_for(root)._scan_snapshot_filesystems_core()
        assert live_descriptors == set()
        failing = probe_for(root)
        def fail_after_open(*_args, **_kwargs):
            raise ProbeFailure("snapshot contains exact IronCurtain public trust residue")
        failing._fingerprint_stream = fail_after_open
        try:
            failing._scan_snapshot_filesystems_core()
        except ProbeFailure as error:
            assert str(error) == "snapshot contains exact IronCurtain public trust residue"
        else:
            raise AssertionError("snapshot failure path unexpectedly passed")
        assert live_descriptors == set()
    finally:
        globals["os"].open = real_open
        globals["os"].dup = real_dup
        globals["os"].close = real_close
    assert b"seed" in opened_components

    original_opener = Probe._open_pinned_snapshot_regular_file
    opened_as_regular = []
    def recording_opener(cls, parent_descriptor, component, expected):
        opened_as_regular.append(component)
        return original_opener(parent_descriptor, component, expected)
    Probe._open_pinned_snapshot_regular_file = classmethod(recording_opener)
    try:
        fifo = root / "pipe"
        os.mkfifo(fifo)
        expect_failure(probe_for(root), "snapshot-scan:special-entry")
        assert b"pipe" not in opened_as_regular
        fifo.unlink()
        opened_as_regular.clear()

        socket_path = root / "socket"
        socket_path.write_bytes(b"test socket metadata fixture")
        real_stat = globals["os"].stat
        def socket_stat(path, *args, **kwargs):
            observed = real_stat(path, *args, **kwargs)
            if path != b"socket":
                return observed
            fields = list(observed)
            fields[0] = stat.S_IFSOCK | stat.S_IMODE(observed.st_mode)
            return os.stat_result(fields)
        globals["os"].stat = socket_stat
        try:
            expect_failure(probe_for(root), "snapshot-scan:special-entry")
            assert b"socket" not in opened_as_regular
        finally:
            globals["os"].stat = real_stat
            socket_path.unlink()
    finally:
        Probe._open_pinned_snapshot_regular_file = original_opener

    real_byte_limit = globals["MAX_SNAPSHOT_SCAN_LOGICAL_BYTES"]
    globals["MAX_SNAPSHOT_SCAN_LOGICAL_BYTES"] = 3
    try:
        expect_failure(probe_for(root), "snapshot-scan:logical-byte-bound")
    finally:
        globals["MAX_SNAPSHOT_SCAN_LOGICAL_BYTES"] = real_byte_limit

    real_limit = globals["MAX_SNAPSHOT_SCAN_ENTRIES"]
    globals["MAX_SNAPSHOT_SCAN_ENTRIES"] = 0
    try:
        expect_failure(probe_for(root), "snapshot-scan:entry-bound")
    finally:
        globals["MAX_SNAPSHOT_SCAN_ENTRIES"] = real_limit

    child = root / "child"
    child.mkdir()
    (child / "nested").write_bytes(b"safe")
    real_depth = globals["MAX_SNAPSHOT_DIRECTORY_DEPTH"]
    globals["MAX_SNAPSHOT_DIRECTORY_DEPTH"] = 0
    try:
        expect_failure(probe_for(root), "snapshot-scan:depth-bound")
    finally:
        globals["MAX_SNAPSHOT_DIRECTORY_DEPTH"] = real_depth
    (child / "nested").unlink()
    child.rmdir()

    real_scandir = globals["os"].scandir
    late_entry = root / "late-entry"
    class MutatingScan:
        def __init__(self, inner):
            self.inner = inner
        def __enter__(self):
            self.inner.__enter__()
            return self
        def __iter__(self):
            yield from self.inner
            late_entry.write_bytes(b"directory identity drift")
        def __exit__(self, *args):
            return self.inner.__exit__(*args)
    def mutating_scandir(descriptor):
        observed = real_scandir(descriptor)
        return MutatingScan(observed) if isinstance(descriptor, int) else observed
    globals["os"].scandir = mutating_scandir
    try:
        expect_failure(probe_for(root), "snapshot-scan:unstable")
    finally:
        globals["os"].scandir = real_scandir
        late_entry.unlink(missing_ok=True)

    for unsafe in ("", ".", "..", "/absolute", "nested/name", "bad\0name", "bad\udcff"):
        try:
            Probe._snapshot_component_bytes(unsafe)
        except ProbeFailure as error:
            assert str(error) == "snapshot-scan:entry-name"
        else:
            raise AssertionError(f"accepted unsafe snapshot component: {unsafe!r}")

    real_scandir = globals["os"].scandir
    class UnsafeEntry:
        name = "/must/not/be-passed-to-stat"
    class UnsafeScan:
        def __enter__(self): return iter((UnsafeEntry(),))
        def __exit__(self, *_args): return False
    globals["os"].scandir = lambda descriptor: (
        UnsafeScan() if isinstance(descriptor, int) else real_scandir(descriptor)
    )
    real_stat = globals["os"].stat
    stat_paths = []
    def reject_stat(*args, **kwargs):
        stat_paths.append(args[0])
        return real_stat(*args, **kwargs)
    globals["os"].stat = reject_stat
    try:
        expect_failure(probe_for(root), "snapshot-scan:entry-name")
        assert b"/must/not/be-passed-to-stat" not in stat_paths
        assert "/must/not/be-passed-to-stat" not in stat_paths
    finally:
        globals["os"].scandir = real_scandir
        globals["os"].stat = real_stat

    real_stat = globals["os"].stat
    def missing_stat(path, *args, **kwargs):
        if path == b"seed":
            raise FileNotFoundError(errno.ENOENT, "private detail", "/secret/seed")
        return real_stat(path, *args, **kwargs)
    globals["os"].stat = missing_stat
    try:
        expect_failure(probe_for(root), "snapshot-scan:unstable")
    finally:
        globals["os"].stat = real_stat

    growing = probe_for(root)
    real_fingerprint = growing._fingerprint_stream
    def growing_fingerprint(*args, **kwargs):
        result = real_fingerprint(*args, **kwargs)
        seed.write_bytes(b"changed-size")
        return result
    growing._fingerprint_stream = growing_fingerprint
    expect_failure(growing, "snapshot-scan:unstable")
    seed.write_bytes(b"safe")

    symlink = root / "safe-link"
    symlink.symlink_to("seed")
    real_readlink = globals["os"].readlink
    def changing_readlink(path, *args, **kwargs):
        target = real_readlink(path, *args, **kwargs)
        if path == b"safe-link":
            symlink.unlink()
            symlink.symlink_to("pipe")
        return target
    globals["os"].readlink = changing_readlink
    try:
        expect_failure(probe_for(root), "snapshot-scan:unstable")
    finally:
        globals["os"].readlink = real_readlink
        symlink.unlink()

    original_opener = Probe._open_pinned_snapshot_regular_file
    for replacement in ("symlink", "fifo"):
        seed.write_bytes(b"safe")
        changed = False
        def replacing_opener(cls, parent_descriptor, component, expected):
            global changed
            if component == b"seed" and not changed:
                changed = True
                seed.unlink()
                if replacement == "symlink":
                    seed.symlink_to("pipe")
                else:
                    os.mkfifo(seed)
            return original_opener(parent_descriptor, component, expected)
        Probe._open_pinned_snapshot_regular_file = classmethod(replacing_opener)
        try:
            expect_failure(probe_for(root), "snapshot-scan:unstable")
        finally:
            Probe._open_pinned_snapshot_regular_file = original_opener
            seed.unlink()
            seed.write_bytes(b"safe")

    read_error = probe_for(root)
    def fail_read(*_args, **_kwargs):
        raise OSError(errno.EIO, "private detail", "/secret/file")
    read_error._fingerprint_stream = fail_read
    expect_failure(read_error, "snapshot-entry:file-read:other")

    primary = probe_for(root)
    def fail_primary(*_args, **_kwargs):
        raise ProbeFailure("snapshot contains exact IronCurtain public trust residue")
    primary._fingerprint_stream = fail_primary
    real_close = globals["os"].close
    def close_then_fail(descriptor):
        real_close(descriptor)
        raise OSError(errno.EIO, "private close detail", "/secret/fd")
    globals["os"].close = close_then_fail
    try:
        try:
            primary._scan_snapshot_filesystems_core()
        except ProbeFailure as error:
            assert str(error) == "snapshot contains exact IronCurtain public trust residue"
        else:
            raise AssertionError("close failure replaced the expected primary error")
    finally:
        globals["os"].close = real_close
`);
  });

  it('freezes independent archive and evidence-backed VFS capacity ceilings', () => {
    runProbeAssertion(String.raw`
import runpy, sys, tempfile
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name="probe_test")
Probe = module["Probe"]
ProbeFailure = module["ProbeFailure"]

assert module["MAX_RESIDUE_SCAN_BYTES"] == 4 * 1024**3
assert module["MAX_SNAPSHOT_SCAN_LOGICAL_BYTES"] == 256 * 1024**3
assert module["MAX_SNAPSHOT_SCAN_ENTRIES"] == 4_000_000
assert module["MAX_SNAPSHOT_DIRECTORY_DEPTH"] == 256
assert module["MAX_PRIVATE_KEY_CANDIDATES_PER_SCAN"] == 256
assert module["PACKAGE_SNAPSHOT_SCAN_TIMEOUT_SECONDS"] == 300

retained_logical_bytes = 85_986_117_228
retained_entries = 1_489_147
retained_depth = 20
retained_candidates = 0
assert retained_logical_bytes < module["MAX_SNAPSHOT_SCAN_LOGICAL_BYTES"]
assert retained_entries < module["MAX_SNAPSHOT_SCAN_ENTRIES"]
assert retained_depth < module["MAX_SNAPSHOT_DIRECTORY_DEPTH"]
assert retained_candidates < module["MAX_PRIVATE_KEY_CANDIDATES_PER_SCAN"]

bound_codes = {
    "snapshot-scan:archive-byte-bound",
    "snapshot-scan:logical-byte-bound",
    "snapshot-scan:entry-bound",
    "snapshot-scan:depth-bound",
    "snapshot-scan:pem-candidate-bound",
}
assert bound_codes <= module["SNAPSHOT_SCAN_FAILURE_CODES"]
assert "snapshot-scan:bounds" not in module["SNAPSHOT_SCAN_FAILURE_CODES"]
for code in bound_codes:
    assert module["snapshot_scan_failure_code"](ProbeFailure(code)) == code
    assert all(token not in code for token in ("/secret", "PRIVATE KEY", "Traceback"))

with tempfile.TemporaryDirectory() as directory:
    archive = Path(directory) / "saved-image.tar"
    archive.write_bytes(b"four")
    try:
        Probe._scan_file(archive, (), 3)
    except ProbeFailure as error:
        assert str(error) == "snapshot-scan:archive-byte-bound"
    else:
        raise AssertionError("saved-image archive byte ceiling did not fail closed")
`);
  });

  it('bounds private-key candidate parsing by total count and deadline', () => {
    runProbeAssertion(String.raw`
import io, runpy, sys, time
module = runpy.run_path(sys.argv[1], run_name="probe_test")
candidate = b"-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"
public_spki = b"-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"
budget = module["PrivateKeyScanBudget"](remaining_candidates=1, deadline=time.monotonic() + 5)
try:
    module["Probe"]._fingerprint_stream(
        io.BytesIO(candidate + candidate),
        (),
        len(candidate) * 2,
        ca_public_spki=public_spki,
        key_scan_budget=budget,
    )
except module["ProbeFailure"] as error:
    assert str(error) == "snapshot-scan:pem-candidate-bound"
    assert module["snapshot_scan_failure_code"](error) == str(error)
    assert "/must/not/appear" not in str(error) and "BEGIN PRIVATE KEY" not in str(error)
else:
    raise AssertionError("private-key candidate total bound was not enforced")

expired = module["PrivateKeyScanBudget"](remaining_candidates=1, deadline=time.monotonic() - 1)
try:
    module["Probe"]._fingerprint_stream(
        io.BytesIO(candidate),
        (),
        len(candidate),
        ca_public_spki=public_spki,
        key_scan_budget=expired,
    )
except module["ProbeFailure"] as error:
    assert str(error) == "private-key residue scan exceeded its deadline"
    assert "/must/not/appear" not in str(error)
else:
    raise AssertionError("private-key candidate deadline was not enforced")

resynchronized = (
    b"-----BEGIN PRIVATE KEY-----\ninvalid outer\n"
    b"-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n"
    b"-----END PRIVATE KEY-----\n"
)
inner = b"-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n"
split = resynchronized.index(b"-----BEGIN RSA PRIVATE KEY-----") + 11
class Chunked:
    def __init__(self, chunks):
        self.chunks = list(chunks)
    def read(self, _size):
        return self.chunks.pop(0) if self.chunks else b""

resynchronized_budget = module["PrivateKeyScanBudget"](
    remaining_candidates=2, deadline=time.monotonic() + 5
)
real_matcher = module["Probe"]._private_key_candidate_matches_spki
module["Probe"]._private_key_candidate_matches_spki = staticmethod(
    lambda candidate, _spki, _timeout: candidate == inner
)
try:
    result = module["Probe"]._fingerprint_stream(
        Chunked((resynchronized[:split], resynchronized[split:])),
        (),
        len(resynchronized),
        ca_public_spki=public_spki,
        key_scan_budget=resynchronized_budget,
        deadline=time.monotonic() + 5,
    )
    assert result[3] is True
    assert resynchronized_budget.remaining_candidates == 1
finally:
    module["Probe"]._private_key_candidate_matches_spki = staticmethod(real_matcher)
`);
  });

  it('detects complete bounded matching PKCS forms across chunks and resynchronizes after noncandidates', () => {
    runProbeAssertion(String.raw`
import runpy, subprocess, sys, tempfile, time
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name="probe_test")
Probe = module["Probe"]

class Chunked:
    def __init__(self, contents):
        self.chunks = [contents[index:index + 7] for index in range(0, len(contents), 7)]
    def read(self, _size):
        return self.chunks.pop(0) if self.chunks else b""

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    keys = []
    for name in ("matching", "unrelated"):
        pkcs8 = root / f"{name}-pkcs8.pem"
        pkcs1 = root / f"{name}-pkcs1.pem"
        cert = root / f"{name}-cert.pem"
        subprocess.run(
            [
                "/usr/bin/openssl", "genpkey", "-algorithm", "RSA",
                "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(pkcs8),
            ],
            check=True,
            capture_output=True,
        )
        traditional = subprocess.run(
            [
                "/usr/bin/openssl", "rsa", "-in", str(pkcs8), "-traditional",
                "-out", str(pkcs1),
            ],
            capture_output=True,
        )
        if traditional.returncode != 0:
            subprocess.run(
                ["/usr/bin/openssl", "rsa", "-in", str(pkcs8), "-out", str(pkcs1)],
                check=True,
                capture_output=True,
            )
        subprocess.run(
            [
                "/usr/bin/openssl", "req", "-x509", "-new", "-key", str(pkcs8),
                "-subj", f"/CN={name}", "-out", str(cert),
            ],
            check=True,
            capture_output=True,
        )
        keys.append((pkcs8.read_bytes(), pkcs1.read_bytes(), cert.read_bytes()))

    matching_pkcs8, matching_pkcs1, matching_cert = keys[0]
    unrelated_pkcs8, unrelated_pkcs1, _unrelated_cert = keys[1]
    public_spki = subprocess.run(
        ["/usr/bin/openssl", "x509", "-pubkey", "-noout"],
        input=matching_cert,
        check=True,
        capture_output=True,
    ).stdout.strip()

    def scan(contents):
        budget = module["PrivateKeyScanBudget"](
            remaining_candidates=module["MAX_PRIVATE_KEY_CANDIDATES_PER_SCAN"],
            deadline=time.monotonic() + 10,
        )
        return Probe._fingerprint_stream(
            Chunked(contents),
            (),
            len(contents),
            ca_public_spki=public_spki,
            key_scan_budget=budget,
            deadline=time.monotonic() + 10,
        )[3]

    assert scan(unrelated_pkcs8) is False
    assert scan(unrelated_pkcs1) is False
    assert scan(matching_pkcs8) is True
    size, digest, found, contains_key = Probe._fingerprint_stream(
        Chunked(unrelated_pkcs8),
        (),
        len(unrelated_pkcs8),
        ca_public_spki=public_spki,
        key_scan_budget=module["PrivateKeyScanBudget"](
            remaining_candidates=module["MAX_PRIVATE_KEY_CANDIDATES_PER_SCAN"],
            deadline=time.monotonic() + 10,
        ),
        deadline=time.monotonic() + 10,
        compute_digest=False,
    )
    assert (size, digest, found, contains_key) == (len(unrelated_pkcs8), "", (), False)
    matching_pkcs1_crlf = matching_pkcs1.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    assert scan(matching_pkcs1_crlf) is True

    def without_footer(contents):
        lines = contents.splitlines(keepends=True)
        assert lines[-1].rstrip(b"\r\n").startswith(b"-----END ")
        return b"".join(lines[:-1])

    assert scan(without_footer(matching_pkcs8)) is True
    assert scan(without_footer(matching_pkcs1_crlf).rstrip(b"\r\n")) is True

    matching_lines = matching_pkcs8.splitlines(keepends=True)
    split_at = 1 + (len(matching_lines) - 2) // 2
    assert scan(b"".join(matching_lines[:split_at])) is False
    assert scan(b"".join(matching_lines[split_at:])) is False

    wrappers = (
        b"prose -----BEGIN PRIVATE KEY-----\n" + matching_pkcs8,
        b"-----BEGIN PRIVATE KEY-----\nAAAA\n" + matching_pkcs8,
        b"-----BEGIN PRIVATE KEY-----\n"
        + b"A" * (module["MAX_PRIVATE_KEY_PEM_BYTES"] + 1)
        + b"\n"
        + matching_pkcs8,
        b"-----BEGIN PRIVATE KEY-----\ninvalid outer\n"
        + matching_pkcs1
        + b"-----END PRIVATE KEY-----\n",
    )
    for wrapped in wrappers:
        assert scan(wrapped) is True
`);
  });

  it('classifies snapshot authority and PEM failures without exposing their inputs', () => {
    runProbeAssertion(String.raw`
import io, runpy, subprocess, sys, tempfile, time
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name="probe_test")
Probe = module["Probe"]
ProbeFailure = module["ProbeFailure"]
public_spki = b"-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"

def classify(function, expected):
    try:
        function()
    except ProbeFailure as error:
        observed = module["snapshot_scan_failure_code"](error)
        assert observed == expected, (str(error), observed, expected)
        assert observed in module["SNAPSHOT_SCAN_FAILURE_CODES"]
        for forbidden in ("/secret", "PRIVATE KEY", "private detail", "Traceback"):
            assert forbidden not in observed
    else:
        raise AssertionError(f"snapshot failure was not classified as {expected}")

def fingerprint(contents):
    budget = module["PrivateKeyScanBudget"](
        remaining_candidates=2, deadline=time.monotonic() + 5
    )
    return Probe._fingerprint_stream(
        io.BytesIO(contents),
        (),
        len(contents),
        ca_public_spki=public_spki,
        key_scan_budget=budget,
        deadline=time.monotonic() + 5,
    )

non_candidates = (
    b"-----BEGIN PRIVATE KEY-----\n",
    b"prose -----BEGIN PRIVATE KEY----- is not a standalone line\n",
    b"-----BEGIN PRIVATE KEY----- suffix\nAAAA\n-----END PRIVATE KEY-----\n",
    b"-----BEGIN PRIVATE KEY-----\nnot-base64\n-----END PRIVATE KEY-----\n",
    b"-----BEGIN PRIVATE KEY-----\nAAAA\n",
    b"-----BEGIN PRIVATE KEY-----\n"
    + b"A" * (module["MAX_PRIVATE_KEY_PEM_BYTES"] + 1)
    + b"\n-----END PRIVATE KEY-----\n",
)
for contents in non_candidates:
    result = fingerprint(contents)
    assert result[3] is False

calls = []
real_matcher = Probe._private_key_candidate_matches_spki
Probe._private_key_candidate_matches_spki = staticmethod(
    lambda candidate, _spki, _timeout: calls.append(candidate) or False
)
try:
    first_file = b"-----BEGIN PRIVATE KEY-----\nnot-base64\n"
    second_file = b"-----END PRIVATE KEY-----\n"
    assert fingerprint(first_file)[3] is False
    assert fingerprint(second_file)[3] is False
    assert calls == []
finally:
    Probe._private_key_candidate_matches_spki = staticmethod(real_matcher)

real_run = Probe._private_key_candidate_matches_spki.__globals__["subprocess"].run
def parser_timeout(*_args, **_kwargs):
    raise subprocess.TimeoutExpired(["/usr/bin/openssl"], 2)
Probe._private_key_candidate_matches_spki.__globals__["subprocess"].run = parser_timeout
try:
    classify(
        lambda: Probe._private_key_candidate_matches_spki(
            b"redacted candidate", public_spki, 2
        ),
        "snapshot-scan:pem-parser",
    )
finally:
    Probe._private_key_candidate_matches_spki.__globals__["subprocess"].run = real_run

class SignaledParser:
    returncode = -9
    stdout = b""
Probe._private_key_candidate_matches_spki.__globals__["subprocess"].run = (
    lambda *_args, **_kwargs: SignaledParser()
)
try:
    classify(
        lambda: Probe._private_key_candidate_matches_spki(
            b"redacted candidate", public_spki, 2
        ),
        "snapshot-scan:pem-parser",
    )
finally:
    Probe._private_key_candidate_matches_spki.__globals__["subprocess"].run = real_run

class InvalidSuccessfulSpki:
    returncode = 0
    stdout = b"not a bounded canonical SPKI"
Probe._private_key_candidate_matches_spki.__globals__["subprocess"].run = (
    lambda *_args, **_kwargs: InvalidSuccessfulSpki()
)
try:
    classify(
        lambda: Probe._private_key_candidate_matches_spki(
            b"redacted candidate", public_spki, 2
        ),
        "snapshot-scan:pem-parser",
    )
finally:
    Probe._private_key_candidate_matches_spki.__globals__["subprocess"].run = real_run

with tempfile.TemporaryDirectory() as directory:
    missing = Path(directory) / "secret-authority-that-does-not-exist"
    globals = Probe._exact_authority_markers.__globals__
    originals = (
        globals["AGENT_CA_CERT"],
        globals["PACKAGE_APT_CONFIG"],
        globals["PACKAGE_CONTRACT"],
    )
    globals["AGENT_CA_CERT"] = missing
    globals["PACKAGE_APT_CONFIG"] = missing
    globals["PACKAGE_CONTRACT"] = missing
    try:
        classify(
            lambda: Probe("packages")._exact_authority_markers(),
            "snapshot-scan:authority-input",
        )
        classify(
            lambda: Probe("packages")._ca_public_spki(time.monotonic() + 5),
            "snapshot-scan:authority-input",
        )
    finally:
        (
            globals["AGENT_CA_CERT"],
            globals["PACKAGE_APT_CONFIG"],
            globals["PACKAGE_CONTRACT"],
        ) = originals

for invariant in (
    "private-key scan authority and budget must be paired",
    "private-key scan budget is unavailable",
):
    assert module["snapshot_scan_failure_code"](ProbeFailure(invariant)) == (
        "snapshot-scan:internal"
    )
assert "snapshot-scan:pem-envelope" not in module["SNAPSHOT_SCAN_FAILURE_CODES"]
`);
  });

  it('uses one aggregate deadline for docker save and every image residue pass', () => {
    runProbeAssertion(String.raw`
import runpy, subprocess, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
probe = module["Probe"]("packages")
image_id = "sha256:" + "a" * 64
probe.fixture_image_ids = [image_id]
probe._inspect_image = lambda observed: () if observed == image_id else (_ for _ in ()).throw(AssertionError())
probe._exact_authority_markers = lambda: ()
observed = []
def docker(*args, **kwargs):
    observed.append(("save", args, kwargs["timeout"]))
    return subprocess.CompletedProcess(args, 0, "", "")
probe.docker = docker
probe._validate_saved_form_layers = lambda archive, images, deadline: observed.append(
    ("layers", tuple(images), deadline)
)
probe._scan_file = lambda archive, markers, limit, *, deadline: observed.append(
    ("exact", tuple(markers), limit, deadline)
)
real_monotonic = module["time"].monotonic
module["time"].monotonic = lambda: 100.0
try:
    probe._scan_fixture_images()
finally:
    module["time"].monotonic = real_monotonic
assert observed[0][0] == "save" and observed[0][2] == module["PACKAGE_IMAGE_SCAN_TIMEOUT_SECONDS"]
assert observed[1] == ("layers", (image_id,), 400.0)
assert observed[2][0] == "exact" and observed[2][3] == 400.0
assert probe.checks == ["packages.image-residue"]
`);
  });

  it('requires every build-capable Compose entrypoint to hit the exact shim denial', () => {
    runProbeAssertion(String.raw`
import runpy, subprocess, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
probe = module["Probe"]("packages")
calls = []
def docker(*args, **kwargs):
    calls.append(args)
    if args[:2] == ("image", "inspect"):
        return subprocess.CompletedProcess(args, 1, "", "No such image")
    if "--menu" in args:
        marker = "Compose navigation menus are unsupported"
    elif "watch" in args or "--watch" in args:
        marker = "Compose watch is unsupported"
    else:
        marker = "Compose builds are unsupported"
    return subprocess.CompletedProcess(
        args,
        64,
        "",
        f"IronCurtain Docker build: {marker}",
    )
probe.docker = docker
probe._validate_compose_rejection()
compose_calls = [call for call in calls if call and call[0] == "compose"]
suffixes = [call[call.index("-f") + 2:] for call in compose_calls]
assert suffixes == [
    ("build",),
    ("up",),
    ("up", "--build"),
    ("create",),
    ("run", "fixture"),
    ("watch",),
    ("up", "--no-build", "--watch"),
    ("up", "--no-build", "--menu"),
    ("create", "--no-build", "--watch"),
    ("create", "--no-build", "--menu"),
], suffixes
assert [call[:2] for call in calls].count(("image", "inspect")) == 2
assert probe.checks == ["packages.compose-denial"]
`);
  });

  it('makes images/offline prove a fixed package route fails and exact package artifacts are absent', () => {
    const probe = readFileSync(PROBE_PATH, 'utf8');
    expect(probe).toContain("fetch('https://registry.npmjs.org/is-number'");
    expect(probe).toMatch(
      /def _validate_fixed_package_build_failure[\s\S]*?build_args\s*=\s*\(\s*"build",\s*"--no-cache",\s*"--progress=plain"/u,
    );
    expect(probe).toMatch(
      /_validate_fixed_package_build_failure\(\s*PRIMARY_PUBLIC_IMAGE,\s*"images\.package-build-denied"/u,
    );
    expect(probe).toMatch(
      /selected_reference\s*=\s*self\._selected_image_reference\(selected_image_id\)[\s\S]*?_validate_fixed_package_build_failure\(\s*selected_reference,\s*"offline\.package-build-denied"/u,
    );
    expect(probe).toContain("writeFileSync('/tmp/ironcurtain-hermetic', 'hermetic-ok')");
    expect(probe).toContain("readFileSync('/tmp/ironcurtain-hermetic','utf8')");
    expect(probe).toMatch(/observed\s*==\s*\(\s*\(True,\) \* len\(package_paths\)/u);
  });

  it('requires exact BuildKit network absence for an uncached fixed-package build', () => {
    runProbeAssertion(String.raw`
import runpy, subprocess, sys
from pathlib import Path
module = runpy.run_path(sys.argv[1], run_name="probe_test")

def outcome(mode, build_output):
    probe = module["Probe"](mode)
    probe._write_generated_context = lambda *_args: Path("/bounded-context")
    calls = []
    def docker(*args, **kwargs):
        calls.append((args, kwargs))
        if args[0] == "build":
            assert kwargs["expect_success"] is False
            return subprocess.CompletedProcess(args, 1, "", build_output)
        if args[:2] == ("image", "inspect"):
            return subprocess.CompletedProcess(args, 1, "", "not found")
        raise AssertionError((args, kwargs))
    probe.docker = docker
    try:
        probe._validate_fixed_package_build_failure("sha256:" + "a" * 64, "denied")
    except module["ProbeFailure"] as error:
        return str(error), calls, probe.checks
    return "accepted", calls, probe.checks

for mode in ("images", "offline"):
    result, calls, checks = outcome(mode, "failed to solve: network bridge not found")
    assert result == "accepted" and checks == ["denied"]
    assert calls[0][0][:3] == ("build", "--no-cache", "--progress=plain")
    for output in ("package-status=403", "fetch failed", "unrelated build failure"):
        result, _calls, checks = outcome(mode, output)
        assert result == f"{mode} fixed-package build lacks exact network absence"
        assert checks == []
`);
  });

  it('uses the selected image single safe local reference as the offline BuildKit base', () => {
    runProbeAssertion(String.raw`
import json, runpy, subprocess, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
image_id = "sha256:" + "a" * 64
alias = "ironcurtain-claude-code:latest"
probe = module["Probe"]("offline")
probe.initial_image_ids = (image_id,)
def docker(*args, **_kwargs):
    if args[-1] == image_id:
        return subprocess.CompletedProcess(args, 0, json.dumps([alias]), "")
    if args[-1] == alias:
        return subprocess.CompletedProcess(args, 0, image_id + "\n", "")
    raise AssertionError(args)
probe.docker = docker
assert probe._selected_image_reference(image_id) == alias

for tags in ([], ["UPPERCASE:latest"], ["bad reference:latest"], [alias, "other:latest"]):
    rejected = module["Probe"]("offline")
    rejected.initial_image_ids = (image_id,)
    rejected.docker = lambda *args, tags=tags, **_kwargs: subprocess.CompletedProcess(
        args, 0, json.dumps(tags), ""
    )
    try:
        rejected._selected_image_reference(image_id)
    except module["ProbeFailure"] as error:
        assert str(error) == "offline selected image has one safe local reference"
    else:
        raise AssertionError(f"accepted invalid selected tags: {tags!r}")
`);
  });

  it('requires explicit registry denial instead of accepting connectivity failure', () => {
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

  it('cleans only captured immutable IDs in bounded bulk operations', () => {
    runProbeAssertion(String.raw`
import runpy, subprocess, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
probe = module["Probe"]("packages")
container_ids = ["a" * 64, "b" * 64]
image_ids = ["sha256:" + "c" * 64, "sha256:" + "d" * 64]
probe.cleanup_armed = True
probe.container_ids = list(container_ids)
probe.image_ids = list(image_ids)
calls = []
def docker(*args, **kwargs):
    calls.append((args, kwargs))
    return subprocess.CompletedProcess(args, 1 if args[1] == "inspect" else 0, "", "")
probe.docker = docker
probe.cleanup()
assert [args for args, _ in calls] == [
    ("container", "rm", "--force", container_ids[1], container_ids[0]),
    ("container", "inspect", container_ids[0]),
    ("container", "inspect", container_ids[1]),
    ("image", "rm", "--force", image_ids[1], image_ids[0]),
    ("image", "inspect", image_ids[0]),
    ("image", "inspect", image_ids[1]),
]
assert [kwargs["timeout"] for _, kwargs in calls] == [60, 30, 30, 180, 30, 30]
assert probe.container_ids == [] and probe.image_ids == []
probe.image_ids = ["mutable:tag"]
calls.clear()
try:
    probe.cleanup()
except module["ProbeFailure"]:
    pass
else:
    raise AssertionError("accepted a mutable cleanup target")
assert calls == []
`);
  });

  it('host driver requires package audit, ordered cache sentinels, and literal bundle-root absence', () => {
    const runner = readFileSync(RUNNER_PATH, 'utf8');
    expect(PACKAGE_EGRESS_AUDIT_FILENAME).toBe('package-egress-audit.jsonl');
    expect(PACKAGE_EGRESS_AUDIT_SCHEMA_VERSION).toBe(1);
    expect(runner).toContain("from '../src/docker/package-egress-proxy.js'");
    expect(runner).toContain("for (const ecosystem of ['npm', 'pypi', 'debian', 'cargo'] as const)");
    expect(runner).toContain("{ ecosystem: 'npm', name: 'is-number', version: '7.0.0' }");
    expect(runner).toContain("record.package?.name === 'is-odd'");
    expect(runner).toContain('after[0] !== before[0]! + 1');
    expect(runner).toContain("reasonCode === 'derived-metadata-fetched'");
    expect(runner).toContain("record.path === '/debian-security/dists/bookworm-security/InRelease'");
    expect(runner).toContain('getBundleRegistryEgressSocketPath(bundleId)');
    expect(runner).toContain('getBundlePackageEgressSocketPath(bundleId)');
    expect(runner).toContain('getBundleRuntimeRoot(bundleId)');
  });

  it('requires the exact public-only package-build mount allowlist in persisted outer-create evidence', () => {
    const home = '/private/tmp/ic-mount-proof/home';
    const runtimeRoot = `${home}/run/bundle123`;
    const packageRoot = `${runtimeRoot}/package-build-runtime`;
    const orientation: PersistedOuterMount = {
      source: `${home}/workflow-runs/run/container/bundle/orientation`,
      target: '/etc/ironcurtain',
      readonly: true,
    };
    const valid: PersistedOuterMount[] = [
      orientation,
      { source: `${packageRoot}/docker`, target: '/usr/local/sbin/docker', readonly: true },
      {
        source: `${packageRoot}/package-build-client`,
        target: DOCKER_BUILD_PROXY_CONFIG_DIRECTORY,
        readonly: true,
      },
      { source: `${packageRoot}/runc`, target: '/usr/local/sbin/runc', readonly: true },
      {
        source: `${packageRoot}/build-trust-contract.json`,
        target: '/opt/ironcurtain-build-trust/build-trust-contract.json',
        readonly: true,
      },
      {
        source: `${packageRoot}/ca-cert.pem`,
        target: '/opt/ironcurtain-build-trust/ca-cert.pem',
        readonly: true,
      },
      {
        source: `${packageRoot}/ca-bundle.pem`,
        target: '/opt/ironcurtain-build-trust/ca-bundle.pem',
        readonly: true,
      },
      {
        source: `${packageRoot}/apt.conf`,
        target: '/opt/ironcurtain-build-trust/apt.conf',
        readonly: true,
      },
    ];
    expect(() => validatePackageBuildMounts('packages', home, runtimeRoot, valid)).not.toThrow();
    expect(() =>
      validatePackageBuildMounts('packages', home, runtimeRoot, [
        ...valid,
        {
          source: `${home}/workflow-runs/run/container/.claude/`,
          target: '/home/codespace/.claude/',
          readonly: true,
        },
      ]),
    ).not.toThrow();
    expect(() => validatePackageBuildMounts('offline', home, runtimeRoot, [orientation])).not.toThrow();

    const mutations: PersistedOuterMount[][] = [
      valid.map((mount) =>
        mount.target === '/opt/ironcurtain-build-trust/ca-cert.pem' ? { ...mount, readonly: false } : mount,
      ),
      [
        ...valid,
        {
          source: `${packageRoot}/extra.pem`,
          target: '/opt/ironcurtain-build-trust/extra.pem',
          readonly: true,
        },
      ],
      valid.map((mount) =>
        mount.target === '/usr/local/sbin/docker' ? { ...mount, source: `${home}/ca/ca-cert.pem` } : mount,
      ),
      valid.map((mount) => (mount.target === '/usr/local/sbin/docker' ? { ...mount, source: `${home}/ca/` } : mount)),
      valid.map((mount) => (mount.target === '/usr/local/sbin/docker' ? { ...mount, source: home } : mount)),
      valid.map((mount) => (mount.target === '/usr/local/sbin/docker' ? { ...mount, source: '/' } : mount)),
      valid.map((mount) => (mount.target === '/usr/local/sbin/docker' ? { ...mount, source: runtimeRoot } : mount)),
      valid.map((mount) =>
        mount.target === '/usr/local/sbin/docker' ? { ...mount, source: `${packageRoot}/ca-key.pem` } : mount,
      ),
      valid.map((mount) =>
        mount.target === '/usr/local/sbin/docker' ? { ...mount, source: `${packageRoot}/docker/` } : mount,
      ),
      valid.map((mount) =>
        mount.target === '/opt/ironcurtain-build-trust/ca-cert.pem' ? { ...mount, target: '/opt' } : mount,
      ),
      valid.map((mount) =>
        mount.target === '/opt/ironcurtain-build-trust/ca-cert.pem' ? { ...mount, target: '/opt/' } : mount,
      ),
      valid.map((mount) =>
        mount.target === '/opt/ironcurtain-build-trust/ca-cert.pem' ? { ...mount, target: '/' } : mount,
      ),
      valid.map((mount) =>
        mount.target === '/opt/ironcurtain-build-trust/ca-cert.pem'
          ? { ...mount, target: '/opt/ironcurtain-build-trust/ca-cert.pem/' }
          : mount,
      ),
      valid.map((mount) =>
        mount.target === '/opt/ironcurtain-build-trust/ca-cert.pem' ? { ...mount, target: '/opt/../tmp' } : mount,
      ),
      valid.map((mount) =>
        mount.target === '/opt/ironcurtain-build-trust/ca-cert.pem'
          ? { ...mount, target: '/opt//ironcurtain-build-trust/ca-cert.pem' }
          : mount,
      ),
      valid.map((mount) =>
        mount.target === '/opt/ironcurtain-build-trust/ca-cert.pem'
          ? { ...mount, target: 'opt/ironcurtain-build-trust/ca-cert.pem' }
          : mount,
      ),
      valid.map((mount) =>
        mount.target === '/usr/local/sbin/docker' ? { ...mount, target: '/usr/local/sbin' } : mount,
      ),
      valid.map((mount) =>
        mount.target === DOCKER_BUILD_PROXY_CONFIG_DIRECTORY
          ? { ...mount, target: DOCKER_PACKAGE_BUILD_RUNTIME_DIRECTORY }
          : mount,
      ),
      [...valid, { source: `${packageRoot}/extra`, target: '/tmp/extra', readonly: true }],
      valid.map((mount) =>
        mount.target === '/etc/ironcurtain' ? { ...mount, source: `${packageRoot}/orientation` } : mount,
      ),
    ];
    for (const mounts of mutations) {
      expect(() => validatePackageBuildMounts('packages', home, runtimeRoot, mounts)).toThrow();
    }
    expect(() => validatePackageBuildMounts('offline', home, runtimeRoot, valid)).toThrow();
  });

  it('preserves a workflow failure ahead of independently collected evidence failures', () => {
    const primary = new Error('primary workflow snapshot failure');
    const mount = new Error('secondary mount evidence failure');
    const cleanup = new Error('secondary cleanup evidence failure');
    const combined = withSecondaryErrors(primary, [mount, cleanup]);
    expect(combined).toBeInstanceOf(AggregateError);
    expect((combined as AggregateError).errors).toEqual([primary, mount, cleanup]);
    expect(combined.cause).toBe(primary);
    expect(combined.message).toBe(primary.message);
    expect(withSecondaryErrors(primary, [])).toBe(primary);

    const runner = readFileSync(RUNNER_PATH, 'utf8');
    expect(runner).toMatch(
      /try \{\s*validatePersistedPackageBuildMountEvidence[\s\S]*?catch \(error\)[\s\S]*?try \{\s*await assertClosedLease/u,
    );
    expect(runner).toContain('throw withSecondaryErrors(workflowFailure, evidenceFailures)');
  });

  it('keeps lease-enumeration failure secondary to the primary workflow failure', () => {
    const primary = new Error('workflow probe failed');
    const leaseEnumeration = new Error('post-run lease enumeration failed');
    const combined = withSecondaryErrors(primary, [leaseEnumeration]) as AggregateError;
    expect(combined.errors).toEqual([primary, leaseEnumeration]);
    expect(combined.cause).toBe(primary);

    const runner = readFileSync(RUNNER_PATH, 'utf8');
    const runMode = runner.indexOf('async function runMode');
    const inventory = runner.indexOf('assertExactWorkflowCheckInventory(mode, result.payload)', runMode);
    const evidence = runner.indexOf('const evidenceFailures: Error[] = []', runMode);
    const leaseList = runner.indexOf('newLeasePaths = listLeasePaths(smokeHome)', evidence);
    expect(runMode).toBeGreaterThanOrEqual(0);
    expect(inventory).toBeGreaterThan(runMode);
    expect(evidence).toBeGreaterThan(inventory);
    expect(leaseList).toBeGreaterThan(evidence);
    expect(runner.slice(evidence, leaseList)).toContain('try {');
    expect(runner.slice(leaseList, runner.indexOf('if (newLeasePaths !== undefined', leaseList))).toContain(
      'evidenceFailures.push',
    );
  });

  it('keeps invalid deterministic check inventory primary over evidence failure', () => {
    let inventoryFailure: Error | undefined;
    try {
      assertExactWorkflowCheckInventory('packages', {
        mode: 'packages',
        checkCount: 1,
        checkIds: ['common.endpoint'],
        cacheAuditSentinels: null,
      });
    } catch (error) {
      inventoryFailure = error as Error;
    }
    expect(inventoryFailure?.message).toContain('invalid check inventory');
    const evidenceFailure = new Error('mount evidence failed');
    const combined = withSecondaryErrors(inventoryFailure!, [evidenceFailure]) as AggregateError;
    expect(combined.errors).toEqual([inventoryFailure, evidenceFailure]);
    expect(combined.cause).toBe(inventoryFailure);
  });

  it('accepts a host-ordered silent cache interval and exact derived metadata evidence', () => {
    const sentinels = cacheAuditSentinels();
    const path = writePackageEgressAudit(tempDir, validPackageAuditRecords(sentinels));
    expect(() => validatePackageEgressAudit('packages', [path], sentinels)).not.toThrow();
  });

  it('emits unique audited HEAD sentinels around the cached build without using guest time', () => {
    runProbeAssertion(String.raw`
import runpy, sys
module = runpy.run_path(sys.argv[1], run_name="probe_test")
probe = module["Probe"]("packages")
requests = []
def request(method, connect_host, sni, payload):
    requests.append((method, connect_host, sni, payload))
    return b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"
probe._tls_package_request = request
before = probe._record_cache_audit_sentinel("before")
after = probe._record_cache_audit_sentinel("after")
assert before == f"/ironcurtain-cache-before-{probe.nonce}"
assert after == f"/ironcurtain-cache-after-{probe.nonce}"
assert requests == [
    (
        "HEAD",
        "registry.npmjs.org",
        "registry.npmjs.org",
        f"HEAD {before} HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n".encode("ascii"),
    ),
    (
        "HEAD",
        "registry.npmjs.org",
        "registry.npmjs.org",
        f"HEAD {after} HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n".encode("ascii"),
    ),
]

probe._tls_package_request = lambda *_args: (
    b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n"
)
try:
    probe._record_cache_audit_sentinel("before")
except module["ProbeFailure"] as error:
    assert "not exact HTTP/1.1 404" in str(error)
else:
    raise AssertionError("cache sentinel accepted a bodyless non-404 status")
assert "utc_now" not in module
`);
  });

  it('rejects any package audit record sequenced between the cache sentinels', () => {
    const sentinels = cacheAuditSentinels();
    const records = validPackageAuditRecords(sentinels);
    const afterIndex = records.findIndex((record) => record.path === sentinels.afterPath);
    records.splice(
      afterIndex,
      0,
      packageAuditRecord({
        reasonCode: 'client-metadata-unfiltered',
        ecosystem: 'npm',
        host: 'registry.npmjs.org',
        path: '/interloper',
        routeKind: 'metadata',
        package: { name: 'interloper' },
      }),
    );
    const path = writePackageEgressAudit(tempDir, records);
    expect(() => validatePackageEgressAudit('packages', [path], sentinels)).toThrow(
      'cached repeat emitted package-egress audit between ordered sentinels',
    );
  });

  it('rejects missing exact npm, PyPI, or Cargo derived metadata evidence', () => {
    const sentinels = cacheAuditSentinels();
    for (const ecosystem of ['npm', 'pypi', 'cargo'] as const) {
      const records = validPackageAuditRecords(sentinels).filter(
        (record) => !(record.source === 'derived' && record.ecosystem === ecosystem),
      );
      const path = writePackageEgressAudit(resolve(tempDir, ecosystem), records);
      expect(() => validatePackageEgressAudit('packages', [path], sentinels)).toThrow(
        'package-egress audit lacks exact derived metadata',
      );
    }
  });

  it('rejects missing exact Debian security InRelease audit evidence', () => {
    const sentinels = cacheAuditSentinels();
    const records = validPackageAuditRecords(sentinels).filter(
      (record) => record.path !== '/debian-security/dists/bookworm-security/InRelease',
    );
    const path = writePackageEgressAudit(tempDir, records);
    expect(() => validatePackageEgressAudit('packages', [path], sentinels)).toThrow(
      'package-egress audit lacks exact Debian security InRelease',
    );
  });
});

function cacheAuditSentinels(): { readonly beforePath: string; readonly afterPath: string } {
  const nonce = 'a'.repeat(32);
  return {
    beforePath: `/ironcurtain-cache-before-${nonce}`,
    afterPath: `/ironcurtain-cache-after-${nonce}`,
  };
}

function packageAuditRecord(
  overrides: Partial<PackageEgressAuditRecord> &
    Pick<PackageEgressAuditRecord, 'ecosystem' | 'host' | 'path' | 'routeKind'>,
): PackageEgressAuditRecord {
  return {
    schemaVersion: PACKAGE_EGRESS_AUDIT_SCHEMA_VERSION,
    timestamp: '2026-08-22T12:00:00.000Z',
    decision: 'allow',
    reasonCode: 'policy-allow',
    reason: 'fixture',
    method: 'GET',
    source: 'client',
    ...overrides,
  };
}

function validPackageAuditRecords(sentinels: {
  readonly beforePath: string;
  readonly afterPath: string;
}): PackageEgressAuditRecord[] {
  const artifactRecords: PackageEgressAuditRecord[] = [
    packageAuditRecord({
      ecosystem: 'npm',
      host: 'registry.npmjs.org',
      path: '/is-number/-/is-number-7.0.0.tgz',
      routeKind: 'artifact',
      package: { name: 'is-number', version: '7.0.0' },
    }),
    packageAuditRecord({
      ecosystem: 'pypi',
      host: 'files.pythonhosted.org',
      path: '/packages/aa/bb/0123456789abcdef/idna-3.15.tar.gz',
      routeKind: 'artifact',
      package: { name: 'idna', version: '3.15' },
    }),
    packageAuditRecord({
      reasonCode: 'debian-curated-epoch',
      ecosystem: 'debian',
      host: 'deb.debian.org',
      path: '/debian-security/pool/updates/main/c/curl/curl_7.88.1-10%2bdeb12u15_arm64.deb',
      routeKind: 'artifact',
      package: { name: 'curl', version: '7.88.1-10+deb12u15' },
    }),
    packageAuditRecord({
      ecosystem: 'cargo',
      host: 'static.crates.io',
      path: '/crates/itoa/itoa-1.0.15.crate',
      routeKind: 'artifact',
      package: { name: 'itoa', version: '1.0.15' },
    }),
  ];
  const debianSecurityMetadata = packageAuditRecord({
    reasonCode: 'client-metadata-unfiltered',
    ecosystem: 'debian',
    host: 'deb.debian.org',
    path: '/debian-security/dists/bookworm-security/InRelease',
    routeKind: 'metadata',
  });
  const derivedRecords: PackageEgressAuditRecord[] = [
    packageAuditRecord({
      reasonCode: 'derived-metadata-fetched',
      source: 'derived',
      ecosystem: 'npm',
      host: 'registry.npmjs.org',
      path: '/is-number',
      routeKind: 'metadata',
      package: { name: 'is-number', version: '7.0.0' },
    }),
    packageAuditRecord({
      reasonCode: 'derived-metadata-fetched',
      source: 'derived',
      ecosystem: 'pypi',
      host: 'pypi.org',
      path: '/pypi/idna/json',
      routeKind: 'metadata',
      package: { name: 'idna', version: '3.15' },
    }),
    packageAuditRecord({
      reasonCode: 'derived-metadata-fetched',
      source: 'derived',
      ecosystem: 'cargo',
      host: 'index.crates.io',
      path: '/it/oa/itoa',
      routeKind: 'metadata',
      package: { name: 'itoa', version: '1.0.15' },
    }),
  ];
  const denial = packageAuditRecord({
    decision: 'deny',
    reasonCode: 'policy-deny',
    ecosystem: 'npm',
    host: 'registry.npmjs.org',
    path: '/is-odd/-/is-odd-3.0.1.tgz',
    routeKind: 'artifact',
    package: { name: 'is-odd', version: '3.0.1' },
  });
  const sentinelRecord = (path: string): PackageEgressAuditRecord =>
    packageAuditRecord({
      reasonCode: 'client-metadata-unfiltered',
      method: 'HEAD',
      ecosystem: 'npm',
      host: 'registry.npmjs.org',
      path,
      routeKind: 'metadata',
      package: { name: path.slice(1) },
    });
  return [
    ...artifactRecords,
    debianSecurityMetadata,
    ...derivedRecords,
    denial,
    sentinelRecord(sentinels.beforePath),
    sentinelRecord(sentinels.afterPath),
  ];
}

function writePackageEgressAudit(directory: string, records: readonly PackageEgressAuditRecord[]): string {
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, PACKAGE_EGRESS_AUDIT_FILENAME);
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
  return path;
}
