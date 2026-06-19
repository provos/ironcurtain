import { execFile as execFileCb } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_TMP, testCompiledPolicy, testToolAnnotations } from './fixtures/test-policy.js';
import { isDockerAvailable, isDockerImageAvailable } from './helpers/docker-available.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import { createDockerManager } from '../src/docker/docker-manager.js';
import {
  createDockerInfrastructure,
  destroyDockerInfrastructure,
  type DockerInfrastructure,
} from '../src/docker/docker-infrastructure.js';
import { FileCheckpointStore } from '../src/workflow/checkpoint.js';
import { sweepContainerSnapshots } from '../src/workflow/container-snapshots.js';
import {
  WorkflowOrchestrator,
  type CreateWorkflowInfrastructureInput,
  type WorkflowLifecycleEvent,
} from '../src/workflow/orchestrator.js';
import type { WorkflowCheckpoint, WorkflowDefinition, WorkflowId } from '../src/workflow/types.js';
import { createDeps, waitForCompletion, writeDefinitionFile } from './workflow/test-helpers.js';

const execFileAsync = promisify(execFileCb);

const IMAGE = 'ironcurtain-claude-code:latest';
const TEST_HOME = `${REAL_TMP}/ironcurtain-workflow-snapshot-${process.pid}`;
const RESULT_FILE = '.workflow/snapshot-result.json';
const SETUP_SCRIPT = [
  'set -eu',
  'mkdir -p .workflow',
  'count="$(cat setup-count 2>/dev/null || printf 0)"',
  'count="$((count + 1))"',
  'printf "%s" "$count" > setup-count',
  'printf "snapshot-marker" > "$HOME/marker"',
  'touch abort-once',
].join('\n');
const DRIVER_SCRIPT = [
  'set -eu',
  'mkdir -p .workflow',
  `result=${JSON.stringify(RESULT_FILE)}`,
  'if [ -f abort-once ]; then',
  '  rm -f abort-once',
  '  printf \'{"verdict":"abort"}\' > "$result"',
  '  exit 0',
  'fi',
  'if [ -f force-abort ]; then',
  '  if [ -f "$HOME/marker" ]; then',
  '    printf \'{"verdict":"abort"}\' > "$result"',
  '  else',
  '    printf \'{"verdict":"missing"}\' > "$result"',
  '  fi',
  '  exit 0',
  'fi',
  'if [ -f "$HOME/marker" ]; then',
  '  cat "$HOME/marker" > restored-marker.txt',
  '  printf \'{"verdict":"restored"}\' > "$result"',
  'else',
  '  printf \'{"verdict":"missing"}\' > "$result"',
  'fi',
].join('\n');

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
      prefilterModelId: 'anthropic:claude-haiku-4-5',
      anthropicApiKey: 'test-fake-key-no-network',
      googleApiKey: '',
      openaiApiKey: '',
      anthropicBaseUrl: '',
      openaiBaseUrl: '',
      googleBaseUrl: '',
      escalationTimeoutSeconds: 300,
      resourceBudget: {
        maxTotalTokens: 1_000_000,
        maxSteps: 200,
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
      memory: { enabled: false, autoSave: false, llmBaseUrl: undefined, llmApiKey: undefined },
      webSearch: { provider: null, brave: null, tavily: null, serpapi: null },
      serverCredentials: {},
      signal: null,
      gooseProvider: 'anthropic',
      gooseModel: 'claude-sonnet-4-20250514',
      preferredDockerAgent: 'claude-code',
      preferredMode: 'docker',
      packageInstall: {
        enabled: true,
        quarantineDays: 2,
        allowedPackages: [],
        deniedPackages: [],
      },
      dockerResources: { memoryMb: null, cpus: null },
      snapshot: { enabled: true, maxAgeDays: 7, sweepIntervalHours: 24 },
    },
  } as IronCurtainConfig;
}

function snapshotWorkflowDefinition(name: string): WorkflowDefinition {
  return {
    name,
    description: 'Snapshot-resume integration fixture',
    hidden: true,
    initial: 'setup_marker',
    settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true, snapshotOnStop: true },
    states: {
      setup_marker: {
        type: 'deterministic',
        description: 'Write marker outside workspace and checkpoint next state.',
        container: true,
        run: [['sh', '-lc', SETUP_SCRIPT]],
        transitions: [{ to: 'driver' }],
      },
      driver: {
        type: 'deterministic',
        description: 'Abort once, then prove marker restore or graceful fresh fallback.',
        container: true,
        resultFile: RESULT_FILE,
        run: [['sh', '-lc', DRIVER_SCRIPT]],
        transitions: [
          { to: 'done', when: { verdict: 'restored' } },
          { to: 'aborted', when: { verdict: 'abort' } },
          { to: 'aborted', when: { verdict: 'missing' } },
          { to: 'aborted' },
        ],
      },
      done: { type: 'terminal', description: 'Restored marker and completed.' },
      aborted: { type: 'terminal', description: 'Aborted for snapshot capture or graceful fallback.' },
    },
  };
}

async function waitForCheckpoint(
  store: FileCheckpointStore,
  workflowId: WorkflowId,
  predicate: (checkpoint: WorkflowCheckpoint) => boolean,
  timeoutMs = 90_000,
): Promise<WorkflowCheckpoint> {
  const start = Date.now();
  for (;;) {
    const checkpoint = store.load(workflowId);
    if (checkpoint && predicate(checkpoint)) return checkpoint;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for checkpoint condition for ${workflowId}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitForImageState(image: string, exists: boolean, timeoutMs = 90_000): Promise<void> {
  const docker = createDockerManager();
  const start = Date.now();
  for (;;) {
    if ((await docker.imageExists(image)) === exists) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for image ${image} exists=${exists}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!dockerReady)('workflow container snapshot and resume with real Docker', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalAuth: string | undefined;
  let originalApiKey: string | undefined;
  const liveBundles = new Set<DockerInfrastructure>();
  const trackedDigests = new Set<string>();

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

    const docker = createDockerManager();
    await Promise.allSettled([...trackedDigests].map((digest) => docker.removeImage(digest)));
    trackedDigests.clear();

    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    if (originalAuth === undefined) delete process.env.IRONCURTAIN_DOCKER_AUTH;
    else process.env.IRONCURTAIN_DOCKER_AUTH = originalAuth;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;

    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'workflow-snapshot-resume-'));
  });

  afterEach(async () => {
    for (const bundle of liveBundles) {
      await destroyDockerInfrastructure(bundle).catch(() => {});
    }
    liveBundles.clear();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createHarness(label: string): {
    readonly baseDir: string;
    readonly workspaceDir: string;
    readonly checkpointStore: FileCheckpointStore;
    readonly definitionPath: string;
    readonly createRecords: Array<{
      readonly workflowId: WorkflowId;
      readonly baseImageOverride?: string;
      readonly containerImage: string;
    }>;
    startRun: () => Promise<WorkflowId>;
    resumeRun: (workflowId: WorkflowId) => Promise<void>;
  } {
    const baseDir = resolve(tmpDir, `runs-${label}`);
    const workspaceDir = resolve(tmpDir, `workspace-${label}`);
    const generatedDir = resolve(TEST_HOME, `generated-${label}`);
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(resolve(generatedDir, 'compiled-policy.json'), JSON.stringify(testCompiledPolicy));
    writeFileSync(resolve(generatedDir, 'tool-annotations.json'), JSON.stringify(testToolAnnotations));

    const checkpointStore = new FileCheckpointStore(baseDir);
    const definitionPath = writeDefinitionFile(tmpDir, snapshotWorkflowDefinition(`snapshot-${label}`));
    const createRecords: Array<{
      readonly workflowId: WorkflowId;
      readonly baseImageOverride?: string;
      readonly containerImage: string;
    }> = [];

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      const config = buildDockerSessionConfig(input.workspacePath, generatedDir);
      const bundleDir = resolve(TEST_HOME, 'bundles', label, input.workflowId, input.bundleId);
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
        input.baseImageOverride ? { baseImageOverride: input.baseImageOverride } : undefined,
      );
      liveBundles.add(bundle);
      const { stdout } = await execFileAsync('docker', ['inspect', '-f', '{{.Config.Image}}', bundle.containerId], {
        timeout: 10_000,
      });
      createRecords.push({
        workflowId: input.workflowId,
        ...(input.baseImageOverride !== undefined ? { baseImageOverride: input.baseImageOverride } : {}),
        containerImage: stdout.trim(),
      });
      return bundle;
    });

    const destroyInfra = vi.fn(async (bundle: DockerInfrastructure) => {
      liveBundles.delete(bundle);
      await destroyDockerInfrastructure(bundle);
    });
    const createSession = vi.fn(async () => {
      throw new Error('snapshot integration workflow should not create agent sessions');
    });

    const makeOrchestrator = (): WorkflowOrchestrator => {
      const orchestrator = new WorkflowOrchestrator(
        createDeps(baseDir, {
          checkpointStore,
          createSession,
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: destroyInfra,
        }),
      );
      orchestrator.onEvent((event: WorkflowLifecycleEvent) => {
        if (event.kind === 'completed') {
          const checkpoint = checkpointStore.load(event.workflowId);
          for (const snapshot of Object.values(checkpoint?.containerSnapshots ?? {})) {
            trackedDigests.add(snapshot.image);
          }
        }
      });
      return orchestrator;
    };

    const runToTerminal = async (
      orchestrator: WorkflowOrchestrator,
      workflowId: WorkflowId,
      minCheckpointTimeMs: number,
    ): Promise<void> => {
      await waitForCompletion(orchestrator, workflowId, 180_000);
      await waitForCheckpoint(
        checkpointStore,
        workflowId,
        (checkpoint) => checkpoint.finalStatus !== undefined && Date.parse(checkpoint.timestamp) >= minCheckpointTimeMs,
      );
      for (const snapshot of Object.values(checkpointStore.load(workflowId)?.containerSnapshots ?? {})) {
        trackedDigests.add(snapshot.image);
      }
      await orchestrator.shutdownAll();
    };

    return {
      baseDir,
      workspaceDir,
      checkpointStore,
      definitionPath,
      createRecords,
      startRun: async () => {
        const orchestrator = makeOrchestrator();
        const startedAt = Date.now();
        const workflowId = await orchestrator.start(definitionPath, `task ${label}`, workspaceDir);
        await runToTerminal(orchestrator, workflowId, startedAt);
        return workflowId;
      },
      resumeRun: async (workflowId: WorkflowId) => {
        const orchestrator = makeOrchestrator();
        const startedAt = Date.now();
        await orchestrator.resume(workflowId);
        await runToTerminal(orchestrator, workflowId, startedAt);
      },
    };
  }

  async function snapshotDigest(harness: ReturnType<typeof createHarness>, workflowId: WorkflowId): Promise<string> {
    const checkpoint = await waitForCheckpoint(
      harness.checkpointStore,
      workflowId,
      (candidate) => typeof candidate.containerSnapshots?.primary.image === 'string',
    );
    const image = checkpoint.containerSnapshots?.primary.image;
    if (!image) throw new Error('checkpoint missing primary snapshot');
    trackedDigests.add(image);
    return image;
  }

  it('captures, restores, isolates identities, and garbage-collects snapshot images', async () => {
    const docker = createDockerManager();
    const runA = createHarness('A');
    const runB = createHarness('B');

    const [workflowA, workflowB] = await Promise.all([runA.startRun(), runB.startRun()]);
    const digestA1 = await snapshotDigest(runA, workflowA);
    const digestB1 = await snapshotDigest(runB, workflowB);
    expect(digestA1).toMatch(/^sha256:/);
    expect(digestB1).toMatch(/^sha256:/);
    expect(digestA1).not.toBe(digestB1);
    expect(await docker.imageExists(digestA1)).toBe(true);
    expect(await docker.imageExists(digestB1)).toBe(true);

    writeFileSync(resolve(runA.workspaceDir, 'force-abort'), 'again');
    await runA.resumeRun(workflowA);
    const digestA2 = await snapshotDigest(runA, workflowA);
    expect(digestA2).not.toBe(digestA1);
    expect(digestA2).not.toBe(digestB1);
    await waitForImageState(digestA1, false);
    expect(await docker.imageExists(digestA2)).toBe(true);

    await runA.resumeRun(workflowA);
    const digestA3 = await snapshotDigest(runA, workflowA);
    expect(digestA3).not.toBe(digestA2);
    expect(digestA3).not.toBe(digestB1);
    await waitForImageState(digestA2, false);
    expect(await docker.imageExists(digestA3)).toBe(true);

    const resumeRecordsA = runA.createRecords.filter((record) => record.baseImageOverride !== undefined);
    expect(resumeRecordsA.map((record) => record.baseImageOverride)).not.toContain(digestB1);
    expect(resumeRecordsA.every((record) => record.baseImageOverride?.startsWith('sha256:'))).toBe(true);
    expect(resumeRecordsA.every((record) => record.containerImage.startsWith('sha256:'))).toBe(true);

    rmSync(resolve(runA.workspaceDir, 'force-abort'), { force: true });
    await runA.resumeRun(workflowA);
    await waitForCheckpoint(
      runA.checkpointStore,
      workflowA,
      (checkpoint) => checkpoint.finalStatus?.phase === 'completed',
    );
    expect(readFileSync(resolve(runA.workspaceDir, 'setup-count'), 'utf-8')).toBe('1');
    expect(readFileSync(resolve(runA.workspaceDir, 'restored-marker.txt'), 'utf-8')).toBe('snapshot-marker');
    await waitForImageState(digestA3, false);
  }, 360_000);

  it('degrades gracefully when a snapshot image is missing and age-GCs referenced snapshots', async () => {
    const docker = createDockerManager();
    const missingRun = createHarness('missing');
    const workflowMissing = await missingRun.startRun();
    const missingDigest = await snapshotDigest(missingRun, workflowMissing);
    expect(await docker.removeImage(missingDigest)).toBe(true);
    await missingRun.resumeRun(workflowMissing);
    const missingCheckpoint = missingRun.checkpointStore.load(workflowMissing);
    expect(missingCheckpoint?.finalStatus?.phase).toBe('aborted');
    expect(missingCheckpoint?.machineState).toBe('driver');
    const missingResume = missingRun.createRecords.find((record) => record.baseImageOverride === missingDigest);
    expect(missingResume?.containerImage).toBe(IMAGE);

    const agedRun = createHarness('aged');
    const workflowAged = await agedRun.startRun();
    const agedDigest = await snapshotDigest(agedRun, workflowAged);
    const gcResult = await sweepContainerSnapshots({
      baseDir: agedRun.baseDir,
      checkpointStore: agedRun.checkpointStore,
      docker,
      now: new Date(Date.now() + 10 * 60 * 1000),
      userConfig: {
        ...buildDockerSessionConfig(agedRun.workspaceDir, resolve(TEST_HOME, 'generated-aged')).userConfig,
        snapshot: { enabled: true, maxAgeDays: 0.000001, sweepIntervalHours: 24 },
      },
    });
    expect(gcResult.agedImages).toContain(agedDigest);
    expect(agedRun.checkpointStore.load(workflowAged)?.containerSnapshots?.primary.image).toBe(agedDigest);
    expect(await docker.imageExists(agedDigest)).toBe(false);

    await agedRun.resumeRun(workflowAged);
    const agedCheckpoint = agedRun.checkpointStore.load(workflowAged);
    expect(agedCheckpoint?.finalStatus?.phase).toBe('aborted');
    const agedResume = agedRun.createRecords.find((record) => record.baseImageOverride === agedDigest);
    expect(agedResume?.containerImage).toBe(IMAGE);
  }, 360_000);
});
