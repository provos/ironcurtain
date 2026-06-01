/**
 * Seam test: WorkflowManager must forward the daemon's `--capture-traces`
 * opt-in (the `captureTraces` constructor option) into the orchestrator deps
 * as `captureTracesOverride`.
 *
 * Regression guard for the bug where `daemon --capture-traces` had no effect
 * on web-UI/daemon-launched workflows: the daemon constructed WorkflowManager
 * without the flag and createOrchestrator() never set captureTracesOverride,
 * so the trajectory writer was never built and no captures/ dir appeared.
 *
 * We mock the WorkflowOrchestrator constructor to capture the deps object the
 * manager builds — the seam under test is "manager option -> orchestrator
 * deps," upstream of the infrastructure factory that resolves the override
 * against userConfig. createWorkflowSessionFactory is mocked (as in
 * workflow-manager.test.ts) to avoid touching the user's real config.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { WorkflowOrchestratorDeps } from '../src/workflow/orchestrator.js';

// Captures the deps passed to the (mocked) WorkflowOrchestrator constructor.
let capturedDeps: WorkflowOrchestratorDeps | undefined;

vi.mock('../src/workflow/cli-support.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workflow/cli-support.js')>();
  return {
    ...actual,
    createWorkflowSessionFactory: () => () => Promise.reject(new Error('session factory not used in tests')),
  };
});

vi.mock('../src/workflow/orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/workflow/orchestrator.js')>();
  return {
    ...actual,
    WorkflowOrchestrator: class {
      constructor(deps: WorkflowOrchestratorDeps) {
        capturedDeps = deps;
      }
      onEvent(): void {}
      listActive(): string[] {
        return [];
      }
      async shutdownAll(): Promise<void> {}
    },
  };
});

import { WorkflowManager } from '../src/workflow/workflow-manager.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';

describe('WorkflowManager capture-traces seam', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let manager: WorkflowManager | undefined;

  beforeEach(() => {
    capturedDeps = undefined;
    tmpHome = resolve(tmpdir(), `ic-test-wfm-capture-${randomUUID()}`);
    mkdirSync(tmpHome, { recursive: true });
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = tmpHome;
  });

  afterEach(async () => {
    await manager?.shutdown();
    manager = undefined;
    if (originalHome === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = originalHome;
    }
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('forwards captureTraces:true to deps.captureTracesOverride', () => {
    manager = new WorkflowManager({ eventBus: new WebEventBus(), captureTraces: true });
    manager.getOrchestrator();
    expect(capturedDeps).toBeDefined();
    expect(capturedDeps?.captureTracesOverride).toBe(true);
  });

  it('forwards captureTraces:false to deps.captureTracesOverride', () => {
    // false is meaningfully distinct from undefined: it must NOT be coerced
    // away, so an explicit opt-out reaches the resolution point as false.
    manager = new WorkflowManager({ eventBus: new WebEventBus(), captureTraces: false });
    manager.getOrchestrator();
    expect(capturedDeps?.captureTracesOverride).toBe(false);
  });

  it('leaves deps.captureTracesOverride undefined when the option is omitted', () => {
    // Omitted -> the infrastructure factory falls back to userConfig, which is
    // the documented single resolution point.
    manager = new WorkflowManager({ eventBus: new WebEventBus() });
    manager.getOrchestrator();
    expect(capturedDeps?.captureTracesOverride).toBeUndefined();
  });
});
