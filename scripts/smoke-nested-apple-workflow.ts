#!/usr/bin/env tsx

/** No-LLM, production-workflow acceptance for the admitted Apple nested-Docker runtime. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  assertCleanupInventoryGap,
  loadDockerWorkloadLease,
  type DockerWorkloadLease,
} from '../src/docker-workload/bundle-lease.js';
import { createContainerRuntime } from '../src/docker/container-runtime.js';
import { isSelectedAgentCaptureAlias } from '../src/docker/selected-agent-artifact.js';
import { appendBoundedOutput } from './smoke-nested-apple-tui.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const CLI_PATH = resolve(PACKAGE_ROOT, 'dist', 'cli.js');
const FAKE_API_KEY = 'sk-ant-api03-IRONCURTAIN-WORKFLOW-SMOKE-FAKE-ONLY';
const WORKFLOW_NAME = 'nested-docker-live-smoke';
const CHILD_TIMEOUT_MS = 30 * 60_000;
const CLEANUP_TIMEOUT_MS = 5 * 60_000;
const MAX_CAPTURED_OUTPUT_BYTES = 512 * 1024;

type SmokeMode = 'public' | 'offline';

interface WorkflowProbeResult {
  readonly verdict: string;
  readonly passed: boolean;
  readonly payload: {
    readonly mode: string;
    readonly checkCount: number;
    readonly checks: readonly string[];
  };
  readonly error?: string;
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
}

async function main(): Promise<void> {
  if (!existsSync(CLI_PATH)) throw new Error(`built CLI is missing: ${CLI_PATH}; run npm run build`);
  const modes = parseModes(process.argv.slice(2));
  const smokeRoot = realpathSync(mkdtempSync('/private/tmp/ic-naw-'));
  const smokeHome = resolve(smokeRoot, 'home');
  let succeeded = false;

  try {
    chmodSync(smokeRoot, 0o700);
    mkdirSync(smokeHome, { mode: 0o700 });
    const runtime = createContainerRuntime('apple-container');
    const captureTagsBefore = await listCaptureTags(runtime);

    for (const mode of modes) {
      await runMode({ mode, smokeRoot, smokeHome, runtime });
    }

    const captureTagsAfter = await listCaptureTags(runtime);
    const addedCaptureTags = [...captureTagsAfter].filter((tag) => !captureTagsBefore.has(tag));
    if (addedCaptureTags.length > 0) {
      throw new Error(`workflow smoke left selected-image capture aliases: ${addedCaptureTags.join(', ')}`);
    }
    assertNoProviderRequest(smokeHome);
    succeeded = true;
    process.stderr.write(`nested Apple workflow smoke passed (${modes.join(' + ')}, no LLM)\n`);
  } finally {
    if (succeeded) rmSync(smokeRoot, { recursive: true, force: true });
    else process.stderr.write(`nested Apple workflow smoke retained diagnostics at ${smokeRoot}\n`);
  }
}

async function runMode(options: {
  readonly mode: SmokeMode;
  readonly smokeRoot: string;
  readonly smokeHome: string;
  readonly runtime: ReturnType<typeof createContainerRuntime>;
}): Promise<void> {
  const { mode, smokeRoot, smokeHome, runtime } = options;
  const workspace = resolve(smokeRoot, `workspace-${mode}`);
  mkdirSync(workspace, { mode: 0o700 });
  writeConfig(smokeHome, mode);
  const leasesBefore = new Set(listLeasePaths(smokeHome));
  const argv = [CLI_PATH, 'workflow', 'start', WORKFLOW_NAME, mode, '--workspace', workspace, '--strict-lint'];
  process.stderr.write(`\n[${mode}] ${JSON.stringify([process.execPath, ...argv])}\n`);

  const child = spawn(process.execPath, argv, {
    cwd: smokeRoot,
    env: childEnvironment(smokeHome),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = appendBoundedOutput(stdout, chunk.toString('utf8'), MAX_CAPTURED_OUTPUT_BYTES);
    process.stderr.write(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = appendBoundedOutput(stderr, chunk.toString('utf8'), MAX_CAPTURED_OUTPUT_BYTES);
    process.stderr.write(chunk);
  });
  child.stdin.end();

  const exit = await waitForChild(child, CHILD_TIMEOUT_MS);
  const newLeasePaths = listLeasePaths(smokeHome).filter((path) => !leasesBefore.has(path));
  if (newLeasePaths.length !== 1) {
    throw new Error(
      `[${mode}] expected one new Docker-workload lease, found ${newLeasePaths.length}\n` +
        `stdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  const closedLease = await waitForClosedLease(newLeasePaths[0]!, CLEANUP_TIMEOUT_MS);
  await assertClosedLease(closedLease, runtime);
  const resultPath = resolve(workspace, '.workflow', 'nested-docker-result.json');
  const result = existsSync(resultPath) ? readProbeResult(resultPath) : undefined;

  if (exit.timedOut || exit.code !== 0 || exit.signal !== null) {
    throw new Error(
      `[${mode}] workflow CLI exited code=${String(exit.code)} signal=${String(exit.signal)} ` +
        `timedOut=${String(exit.timedOut)}\n` +
        `probe=${result === undefined ? 'missing' : JSON.stringify(result)}\n` +
        `stdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }

  if (result === undefined) throw new Error(`[${mode}] workflow result is missing: ${resultPath}`);
  if (result.verdict !== 'pass' || !result.passed || result.payload.mode !== mode) {
    throw new Error(`[${mode}] workflow probe did not pass: ${JSON.stringify(result)}`);
  }
  if (result.payload.checkCount !== result.payload.checks.length || result.payload.checkCount < 10) {
    throw new Error(`[${mode}] workflow probe returned an invalid check inventory: ${JSON.stringify(result.payload)}`);
  }
  process.stderr.write(
    `[${mode}] workflow passed ${result.payload.checkCount} deterministic checks and exact teardown proof\n`,
  );
}

function parseModes(args: readonly string[]): readonly SmokeMode[] {
  if (args.length === 0) return ['public', 'offline'];
  if (args.length === 1 && args[0] === '--public') return ['public'];
  if (args.length === 1 && args[0] === '--offline') return ['offline'];
  throw new Error('usage: smoke-nested-apple-workflow.ts [--public|--offline]');
}

function writeConfig(home: string, mode: SmokeMode): void {
  const dockerWorkload = mode === 'public' ? { enabled: true } : { enabled: true, imageIngress: 'preloaded-only' };
  const config = {
    anthropicApiKey: FAKE_API_KEY,
    preferredMode: 'container',
    preferredDockerAgent: 'claude-code',
    containerRuntime: 'apple-container',
    dockerResources: { memoryMb: 4096, cpus: 2 },
    dockerWorkload,
  };
  const path = resolve(home, 'config.json');
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function childEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    IRONCURTAIN_HOME: home,
    IRONCURTAIN_CONTAINER_RUNTIME: 'apple-container',
    IRONCURTAIN_DOCKER_AUTH: 'apikey',
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    NO_COLOR: '1',
  };
}

async function waitForChild(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<ChildExit> {
  const exitPromise = new Promise<ChildExit>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal, timedOut: false }));
  });
  const first = await Promise.race([exitPromise, delay(timeoutMs, undefined, { ref: false }).then(() => undefined)]);
  if (first !== undefined) return first;

  child.kill('SIGTERM');
  const afterTerm = await Promise.race([exitPromise, delay(60_000, undefined, { ref: false }).then(() => undefined)]);
  if (afterTerm !== undefined) return { ...afterTerm, timedOut: true };

  child.kill('SIGKILL');
  const afterKill = await Promise.race([exitPromise, delay(10_000, undefined, { ref: false }).then(() => undefined)]);
  if (afterKill === undefined) throw new Error(`workflow child survived SIGKILL after exceeding ${timeoutMs}ms`);
  return { ...afterKill, timedOut: true };
}

function listLeasePaths(home: string): readonly string[] {
  const root = resolve(home, 'docker-workload', 'leases');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((leaseId) => resolve(root, leaseId, 'lease.json'))
    .filter((path) => existsSync(path) && statSync(path).isFile())
    .sort();
}

async function waitForClosedLease(path: string, timeoutMs: number): Promise<DockerWorkloadLease> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lease = loadDockerWorkloadLease(path);
    if (lease.status === 'closed') return lease;
    if (lease.status === 'incident') {
      throw new Error(`Docker-workload cleanup entered incident: ${lease.incident?.detail}`);
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for closed Docker-workload lease: ${path}`);
}

async function assertClosedLease(
  lease: DockerWorkloadLease,
  runtime: ReturnType<typeof createContainerRuntime>,
): Promise<void> {
  if (lease.cleanup === null) throw new Error('closed lease lacks cleanup proof');
  if (!lease.cleanup.exactOuterResourcesAbsent || !lease.cleanup.stateRootAbsent) {
    throw new Error('closed lease lacks exact outer-resource/state-root absence proof');
  }
  if (lease.cleanup.inventories.length !== 2) throw new Error('closed lease lacks two cleanup inventories');
  if (lease.cleanup.inventories.some((inventory) => inventory.ownedResourceIds.length !== 0)) {
    throw new Error('closed lease retained generation-owned outer resources');
  }
  assertCleanupInventoryGap(lease.cleanup.inventories, lease.cleanupInventoryGapMs, 'workflow smoke');
  if (existsSync(lease.paths.stateRoot) || existsSync(lease.paths.runtimeRoot)) {
    throw new Error('closed lease retained a host-only state or runtime root');
  }

  for (const resource of lease.resources) {
    if (resource.observedId === null || resource.removal?.proof !== 'immutable-id-absent') {
      throw new Error(`closed lease lacks immutable-ID absence proof for ${resource.requestedName}`);
    }
    if (resource.removal.identity !== resource.observedId) {
      throw new Error(`closed lease removal identity changed for ${resource.requestedName}`);
    }
    if (resource.kind === 'container' && (await runtime.containerExists(resource.observedId))) {
      throw new Error(`exact outer Apple VM still exists: ${resource.observedId}`);
    }
  }

  if (runtime.listContainers === undefined) throw new Error('Apple runtime cannot inventory generation-owned VMs');
  const representative = lease.resources[0];
  if (representative === undefined) throw new Error('closed lease recorded no outer resources');
  const owned = await runtime.listContainers({
    labelFilter: `${representative.ownershipLabelKey}=${representative.ownershipLabelValue}`,
  });
  if (owned.length !== 0) throw new Error('generation-owned Apple VM inventory is not empty');
}

function readProbeResult(path: string): WorkflowProbeResult {
  if (!existsSync(path)) throw new Error(`workflow result is missing: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('workflow result is not a JSON object');
  }
  return parsed as WorkflowProbeResult;
}

async function listCaptureTags(runtime: ReturnType<typeof createContainerRuntime>): Promise<ReadonlySet<string>> {
  const images = await runtime.listImages();
  return new Set(images.flatMap((image) => image.repoTags).filter(isSelectedAgentCaptureAlias));
}

function assertNoProviderRequest(home: string): void {
  const sessionsRoot = resolve(home, 'sessions');
  if (!existsSync(sessionsRoot)) return;
  for (const sessionId of readdirSync(sessionsRoot)) {
    const auditPath = resolve(sessionsRoot, sessionId, 'audit.jsonl');
    if (!existsSync(auditPath)) continue;
    const audit = readFileSync(auditPath, 'utf8');
    if (/api\.anthropic\.com|\/v1\/messages/u.test(audit) || audit.includes(FAKE_API_KEY)) {
      throw new Error(`no-LLM workflow observed provider request or key material in ${auditPath}`);
    }
  }
}

await main();
