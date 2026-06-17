import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { REAL_TMP, testCompiledPolicy, testToolAnnotations } from '../fixtures/test-policy.js';
import { isDockerAvailable, isDockerImageAvailable } from '../helpers/docker-available.js';
import type { IronCurtainConfig } from '../../src/config/types.js';
import {
  buildWorkflowExecCommand,
  createDockerInfrastructure,
  destroyDockerInfrastructure,
  type DockerInfrastructure,
} from '../../src/docker/docker-infrastructure.js';
import type { BundleId } from '../../src/session/types.js';
import type { WorkflowId } from '../../src/workflow/types.js';

const execFile = promisify(execFileCb);

const IMAGE = 'ironcurtain-claude-code:latest';
const TEST_HOME = `${REAL_TMP}/ironcurtain-workflow-runtime-deps-${process.pid}`;

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
        maxSteps: 100,
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
        allowedPackages: ['numpy', 'six'],
        deniedPackages: [],
      },
      serverCredentials: {},
      dockerResources: { memoryMb: null, cpus: null },
    },
  } as unknown as IronCurtainConfig;
}

async function workflowImageTags(): Promise<Set<string>> {
  const { stdout } = await execFile('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
  return new Set(stdout.split('\n').filter((line) => line.startsWith('ironcurtain-wf-')));
}

async function containerConfigImage(containerId: string): Promise<string> {
  const { stdout } = await execFile('docker', ['inspect', '-f', '{{.Config.Image}}', containerId]);
  return stdout.trim();
}

/** Lists the host-side workflow dependency cache dirs (one per content hash). */
function listDependencyCacheDirs(): string[] {
  const cacheRoot = join(TEST_HOME, 'workflow-deps');
  if (!existsSync(cacheRoot)) return [];
  return readdirSync(cacheRoot).sort();
}

/** Returns the provisioned-sentinel file path inside a python venv cache, or null. */
function findVenvSentinel(cacheKeyDir: string): string | null {
  const venvDir = join(TEST_HOME, 'workflow-deps', cacheKeyDir, 'python-venv');
  if (!existsSync(venvDir)) return null;
  const sentinel = readdirSync(venvDir).find((name) => name.startsWith('.ironcurtain-provisioned-'));
  return sentinel ? join(venvDir, sentinel) : null;
}

async function readPackageAudit(bundleDir: string): Promise<readonly Record<string, unknown>[]> {
  const auditPath = resolve(bundleDir, 'package-audit.jsonl');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(auditPath)) {
      const lines = readFileSync(auditPath, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length > 0) {
        return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      }
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
  }
  return [];
}

describe.skipIf(!dockerReady)('workflow runtime dependency provisioning with real Docker', () => {
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
    tmpDir = mkdtempSync(join(tmpdir(), 'workflow-runtime-deps-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('installs requirements through the registry proxy into the mounted venv without a workflow image', async () => {
    const beforeImages = await workflowImageTags();
    const workspaceDir = resolve(tmpDir, 'workspace');
    const generatedDir = resolve(TEST_HOME, 'generated');
    const bundleDir = resolve(TEST_HOME, 'bundles', 'runtime-deps');
    const escalationDir = resolve(bundleDir, 'escalations');
    const scriptsDir = resolve(tmpDir, 'scripts');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(generatedDir, { recursive: true });
    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(escalationDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(resolve(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));
    writeFileSync(resolve(scriptsDir, 'requirements.txt'), 'numpy\n');

    const bundle = await createDockerInfrastructure(
      buildDockerSessionConfig(workspaceDir, generatedDir),
      { kind: 'docker', agent: 'claude-code' },
      bundleDir,
      workspaceDir,
      escalationDir,
      'runtime-deps-bundle' as BundleId,
      'runtime-deps-workflow' as WorkflowId,
      'primary',
      [],
      undefined,
      scriptsDir,
    );
    liveBundles.add(bundle);

    expect(bundle.image).toBe(IMAGE);
    expect(await containerConfigImage(bundle.containerId)).toBe(IMAGE);

    const importResult = await bundle.docker.exec(
      bundle.containerId,
      ['/opt/workflow-venv/bin/python', '-c', 'import numpy; print(numpy.__version__)'],
      60_000,
      'codespace',
      '/workspace',
    );
    expect(importResult.exitCode).toBe(0);
    expect(importResult.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

    const afterImages = await workflowImageTags();
    expect([...afterImages].filter((tag) => !beforeImages.has(tag))).toEqual([]);

    const audit = await readPackageAudit(bundleDir);
    expect(
      audit.some(
        (entry) =>
          entry.registry === 'pypi' &&
          entry.packageName === 'numpy' &&
          entry.decision === 'allow' &&
          (entry.source === 'metadata-filter' || entry.source === 'tarball-backstop'),
      ),
    ).toBe(true);

    // A bare `node` invocation must resolve from the container's real PATH
    // (the venv bin / node_modules .bin are prepended at exec time, the image
    // PATH is preserved). This guards the PATH-replacement regression.
    const nodeVersion = await bundle.docker.exec(
      bundle.containerId,
      buildWorkflowExecCommand(bundle, ['node', '--version']),
      30_000,
      'codespace',
      '/workspace',
    );
    expect(nodeVersion.exitCode).toBe(0);
    expect(nodeVersion.stdout.trim()).toMatch(/^v\d+/);
  }, 300_000);

  // Helper: stand up a bundle whose scripts carry the given requirements.txt.
  async function makeBundleWithRequirements(label: string, requirements: string): Promise<DockerInfrastructure> {
    const workspaceDir = resolve(tmpDir, `workspace-${label}`);
    const generatedDir = resolve(TEST_HOME, 'generated');
    const bundleDir = resolve(TEST_HOME, 'bundles', label);
    const escalationDir = resolve(bundleDir, 'escalations');
    const scriptsDir = resolve(tmpDir, `scripts-${label}`);
    for (const dir of [workspaceDir, generatedDir, bundleDir, escalationDir, scriptsDir]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(resolve(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));
    writeFileSync(resolve(scriptsDir, 'requirements.txt'), requirements);

    const bundle = await createDockerInfrastructure(
      buildDockerSessionConfig(workspaceDir, generatedDir),
      { kind: 'docker', agent: 'claude-code' },
      bundleDir,
      workspaceDir,
      escalationDir,
      `${label}-bundle` as BundleId,
      `${label}-workflow` as WorkflowId,
      'primary',
      [],
      undefined,
      scriptsDir,
    );
    liveBundles.add(bundle);
    return bundle;
  }

  it('reuses the content-keyed cache on identical deps and re-provisions on a deps change', async () => {
    // First run with numpy: installs into a fresh content-keyed cache.
    const first = await makeBundleWithRequirements('cache-reuse-a', 'numpy\n');
    const firstImport = await first.docker.exec(
      first.containerId,
      ['/opt/workflow-venv/bin/python', '-c', 'import numpy; print("ok")'],
      60_000,
      'codespace',
      '/workspace',
    );
    expect(firstImport.exitCode).toBe(0);

    // The numpy-only cache is content-keyed, so it is the single cache dir for
    // this requirements set (it may already exist from the prior test, which
    // also installs numpy into the same shared TEST_HOME — that is exactly the
    // cross-run reuse this test asserts).
    const cacheDirsAfterFirst = listDependencyCacheDirs();
    const numpyCacheDir = cacheDirsAfterFirst.find((dir) => findVenvSentinel(dir) !== null);
    expect(numpyCacheDir).toBeDefined();
    const sentinelPath = findVenvSentinel(numpyCacheDir as string);
    expect(sentinelPath).not.toBeNull();
    const sentinelMtimeBefore = statSync(sentinelPath as string).mtimeMs;

    // Second run with the SAME requirements: same content hash → same cache
    // dir. The sentinel short-circuits, so the venv is NOT rebuilt (sentinel
    // mtime unchanged) and no new cache dir appears.
    const second = await makeBundleWithRequirements('cache-reuse-b', 'numpy\n');
    expect(second.workflowPythonVenvMount?.hostDir).toBe(first.workflowPythonVenvMount?.hostDir);

    const cacheDirsAfterSecond = listDependencyCacheDirs();
    expect(cacheDirsAfterSecond).toEqual(cacheDirsAfterFirst);
    expect(statSync(sentinelPath as string).mtimeMs).toBe(sentinelMtimeBefore);
    // numpy is already importable in the reused venv.
    const secondImport = await second.docker.exec(
      second.containerId,
      ['/opt/workflow-venv/bin/python', '-c', 'import numpy; print("ok")'],
      60_000,
      'codespace',
      '/workspace',
    );
    expect(secondImport.exitCode).toBe(0);

    // Third run with CHANGED requirements: different content hash → a NEW cache
    // dir is created (re-provision), the original cache is left intact.
    const third = await makeBundleWithRequirements('cache-reuse-c', 'numpy\nsix\n');
    expect(third.workflowPythonVenvMount?.hostDir).not.toBe(first.workflowPythonVenvMount?.hostDir);
    const cacheDirsAfterThird = listDependencyCacheDirs();
    expect(cacheDirsAfterThird.length).toBe(cacheDirsAfterFirst.length + 1);
    expect(cacheDirsAfterThird).toEqual(expect.arrayContaining(cacheDirsAfterFirst));
    // The new venv really has the changed deps (six importable alongside numpy).
    const thirdImport = await third.docker.exec(
      third.containerId,
      ['/opt/workflow-venv/bin/python', '-c', 'import numpy, six; print("ok")'],
      60_000,
      'codespace',
      '/workspace',
    );
    expect(thirdImport.exitCode).toBe(0);
  }, 300_000);
});
