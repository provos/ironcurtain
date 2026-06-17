import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { REAL_TMP, testCompiledPolicy, testToolAnnotations } from '../fixtures/test-policy.js';
import { isDockerAvailable, isDockerImageAvailable } from '../helpers/docker-available.js';
import type { IronCurtainConfig } from '../../src/config/types.js';
import {
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
        allowedPackages: ['numpy'],
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
  }, 300_000);
});
