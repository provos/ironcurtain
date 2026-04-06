/**
 * WorkflowManager -- owns WorkflowOrchestrator instances for the web UI.
 *
 * Analogous to SessionManager: the daemon creates one WorkflowManager
 * at startup and passes it into the dispatch context. Lifecycle events
 * from the orchestrator are forwarded to the WebEventBus.
 */

import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  WorkflowOrchestrator,
  type WorkflowOrchestratorDeps,
  type WorkflowTabHandle,
  type WorkflowLifecycleEvent,
  type WorkflowController,
} from '../workflow/orchestrator.js';
import { FileCheckpointStore } from '../workflow/checkpoint.js';
import { createWorkflowSessionFactory } from '../workflow/cli-support.js';
import type { WebEventBus } from './web-event-bus.js';
import { type HumanGateRequestDto, toHumanGateRequestDto } from './web-ui-types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WorkflowManagerOptions {
  readonly eventBus: WebEventBus;
  /** Maximum concurrent Docker agent sessions across ALL workflows. Default: 4. */
  readonly maxConcurrentAgentSessions?: number;
}

// ---------------------------------------------------------------------------
// WorkflowManager
// ---------------------------------------------------------------------------

export class WorkflowManager {
  private orchestrator: WorkflowOrchestrator | null = null;
  private readonly eventBus: WebEventBus;
  private readonly maxConcurrentAgentSessions: number;

  constructor(options: WorkflowManagerOptions) {
    this.eventBus = options.eventBus;
    this.maxConcurrentAgentSessions = options.maxConcurrentAgentSessions ?? 4;
  }

  /** Lazily creates the orchestrator on first use. */
  getOrchestrator(): WorkflowController {
    if (!this.orchestrator) {
      this.orchestrator = this.createOrchestrator();
    }
    return this.orchestrator;
  }

  /** Clean shutdown of all workflows. */
  async shutdown(): Promise<void> {
    if (this.orchestrator) {
      await this.orchestrator.shutdownAll();
      this.orchestrator = null;
    }
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private createOrchestrator(): WorkflowOrchestrator {
    const baseDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-workflow-'));
    const checkpointStore = new FileCheckpointStore(baseDir);
    const sessionFactory = createWorkflowSessionFactory();

    const deps: WorkflowOrchestratorDeps = {
      createSession: sessionFactory,
      createWorkflowTab: () => this.createNoOpTab(),
      raiseGate: (gate) => {
        const dto: HumanGateRequestDto = toHumanGateRequestDto(gate);
        this.eventBus.emit('workflow.gate_raised', {
          workflowId: gate.workflowId,
          gate: dto,
        });
      },
      dismissGate: (gateId) => {
        // gateId format: `${workflowId}-${gateName}` where workflowId is a UUID.
        // UUIDs are 36 chars (8-4-4-4-12), so split after the UUID portion.
        const workflowId = gateId.length > 36 ? gateId.substring(0, 36) : gateId;
        this.eventBus.emit('workflow.gate_dismissed', { workflowId, gateId });
      },
      baseDir,
      checkpointStore,
    };

    const orchestrator = new WorkflowOrchestrator(deps);
    orchestrator.onEvent((event) => this.forwardLifecycleEvent(event));
    return orchestrator;
  }

  private createNoOpTab(): WorkflowTabHandle {
    return {
      write() {},
      setLabel() {},
      close() {},
    };
  }

  /** Maps WorkflowLifecycleEvent to WebEventBus events. */
  private forwardLifecycleEvent(event: WorkflowLifecycleEvent): void {
    switch (event.kind) {
      case 'state_entered':
        this.eventBus.emit('workflow.state_entered', {
          workflowId: event.workflowId,
          state: event.state,
        });
        break;
      case 'completed':
        this.eventBus.emit('workflow.completed', {
          workflowId: event.workflowId,
        });
        break;
      case 'failed':
        this.eventBus.emit('workflow.failed', {
          workflowId: event.workflowId,
          error: event.error,
        });
        break;
      case 'gate_raised':
        // Already emitted via raiseGate callback
        break;
      case 'gate_dismissed':
        // Already emitted via dismissGate callback
        break;
      case 'agent_started':
        this.eventBus.emit('workflow.agent_started', {
          workflowId: event.workflowId,
          stateId: event.state,
          persona: event.persona,
        });
        break;
      case 'agent_completed':
        this.eventBus.emit('workflow.agent_completed', {
          workflowId: event.workflowId,
          stateId: event.state,
          verdict: event.verdict,
        });
        break;
    }
  }
}
