import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IronCurtainConfig } from '../../src/config/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import type { AgentId } from '../../src/docker/agent-adapter.js';
import type { BundleId } from '../../src/session/types.js';
import type { WorkflowId } from '../../src/workflow/types.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import { resolveDockerWorkloadConfig } from '../../src/docker-workload/config.js';
import { createDeps, makeTestUserConfig } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  createDockerInfrastructure: vi.fn(),
}));

vi.mock('../../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/index.js')>()),
  loadConfig: mocks.loadConfig,
}));

vi.mock('../../src/docker/docker-infrastructure.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/docker-infrastructure.js')>()),
  createDockerInfrastructure: mocks.createDockerInfrastructure,
}));

type DefaultFactoryLoader = {
  loadDefaultInfrastructureFactory(): Promise<
    (input: CreateWorkflowInfrastructureInput) => Promise<DockerInfrastructure>
  >;
};

describe('workflow nested-Docker configuration', () => {
  let tempDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'workflow-docker-workload-'));
    previousHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = join(tempDir, 'home');
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes the global nested-Docker opt-in to each default workflow bundle', async () => {
    const config = {
      auditLogPath: join(tempDir, 'audit.jsonl'),
      allowedDirectory: join(tempDir, 'old-workspace'),
      mcpServers: {},
      protectedPaths: [],
      generatedDir: join(tempDir, 'generated'),
      constitutionPath: join(tempDir, 'constitution.md'),
      agentModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      userConfig: makeTestUserConfig({
        dockerWorkload: resolveDockerWorkloadConfig({ enabled: true }),
      }),
    } as IronCurtainConfig;
    const infrastructure = { bundleId: 'bundle-workflow-1' } as unknown as DockerInfrastructure;
    mocks.loadConfig.mockReturnValue(config);
    mocks.createDockerInfrastructure.mockResolvedValue(infrastructure);

    const orchestrator = new WorkflowOrchestrator(createDeps(tempDir));
    const factory = await (orchestrator as unknown as DefaultFactoryLoader).loadDefaultInfrastructureFactory();
    const input: CreateWorkflowInfrastructureInput = {
      workflowId: 'workflow-docker-1' as WorkflowId,
      bundleId: 'bundle-workflow-1' as BundleId,
      agentId: 'claude-code' as AgentId,
      controlSocketPath: join(tempDir, 'control.sock'),
      workspacePath: join(tempDir, 'workspace'),
      scope: 'default',
      requiredServers: new Set(),
    };

    await expect(factory(input)).resolves.toBe(infrastructure);
    expect(mocks.createDockerInfrastructure).toHaveBeenCalledOnce();
    const passedConfig = mocks.createDockerInfrastructure.mock.calls[0][0] as IronCurtainConfig;
    expect(passedConfig.userConfig.dockerWorkload).toEqual(resolveDockerWorkloadConfig({ enabled: true }));
    expect(passedConfig.allowedDirectory).toBe(input.workspacePath);
  });
});
