/**
 * Tests for per-workflow and per-state model specifier support.
 *
 * Covers five layers of the feature:
 * 1. YAML validation accepts `settings.model` and state-level `model`
 *    and rejects malformed model strings.
 * 2. Orchestrator routing computes the effective model from state > workflow
 *    and forwards it as `agentModelOverride` to `createSession()`. The
 *    option is omitted entirely when neither level sets a model, so the
 *    factory's fallback (user config) is used.
 * 3. The session factory's precedence: CLI flag > per-call override >
 *    user config default.
 * 4. `SessionOptions.agentModelOverride` is plumbed into the model actually
 *    consumed by `AgentSession` (via the config's `agentModelId`).
 * 5. End-to-end composition: a YAML workflow string flows through parse,
 *    validate, orchestrator routing, and the real session factory, and
 *    the per-state model IDs reach `createSession` with the correct
 *    precedence preserved on a per-call basis.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateDefinition, WorkflowValidationError } from '../../src/workflow/validate.js';
import { WorkflowOrchestrator } from '../../src/workflow/orchestrator.js';
import { parseDefinitionFile } from '../../src/workflow/discovery.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import type { SessionOptions } from '../../src/session/types.js';
import {
  MockSession,
  approvedResponse,
  createArtifactAwareSession,
  writeDefinitionFile,
  createDeps,
  stubPersonasForTest,
  waitForCompletion,
} from './test-helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseWorkflow(): Record<string, unknown> {
  return {
    name: 'model-selection-test',
    description: 'Tests model selection plumbing',
    initial: 'plan',
    states: {
      plan: {
        type: 'agent',
        description: 'Plans',
        persona: 'planner',
        prompt: 'You are a planner.',
        inputs: [],
        outputs: ['plan'],
        transitions: [{ to: 'implement' }],
      },
      implement: {
        type: 'agent',
        description: 'Implements',
        persona: 'coder',
        prompt: 'You are a coder.',
        inputs: ['plan'],
        outputs: ['code'],
        transitions: [{ to: 'done' }],
      },
      done: { type: 'terminal', description: 'Done' },
    },
  };
}

// ---------------------------------------------------------------------------
// 1. YAML validation
// ---------------------------------------------------------------------------

describe('workflow model validation', () => {
  it('accepts workflow-level settings.model with a valid provider:model-name', () => {
    const def = baseWorkflow();
    def.settings = { model: 'anthropic:claude-sonnet-4-6' };
    expect(() => validateDefinition(def)).not.toThrow();
  });

  it('accepts state-level model with a valid provider:model-name', () => {
    const def = baseWorkflow();
    const states = def.states as Record<string, Record<string, unknown>>;
    states.plan.model = 'anthropic:claude-haiku-4-5';
    expect(() => validateDefinition(def)).not.toThrow();
  });

  it('accepts both workflow-level and state-level model simultaneously', () => {
    const def = baseWorkflow();
    def.settings = { model: 'anthropic:claude-sonnet-4-6' };
    const states = def.states as Record<string, Record<string, unknown>>;
    states.plan.model = 'anthropic:claude-opus-4-6';
    expect(() => validateDefinition(def)).not.toThrow();
  });

  it('accepts a bare model ID (no provider prefix)', () => {
    // parseModelId treats bare IDs as Anthropic by default; the validator
    // should accept them rather than forcing users to qualify every value.
    const def = baseWorkflow();
    def.settings = { model: 'claude-sonnet-4-6' };
    expect(() => validateDefinition(def)).not.toThrow();
  });

  it('rejects an empty-string model at workflow level', () => {
    const def = baseWorkflow();
    def.settings = { model: '' };
    expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
  });

  it('rejects a model with a known provider prefix but empty model name', () => {
    const def = baseWorkflow();
    def.settings = { model: 'anthropic:' };
    try {
      validateDefinition(def);
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as WorkflowValidationError;
      expect(err.issues.join('\n')).toMatch(/model/i);
    }
  });

  it('rejects a non-string model value', () => {
    const def = baseWorkflow();
    def.settings = { model: 42 };
    expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
  });

  it('rejects state-level model with invalid type', () => {
    const def = baseWorkflow();
    const states = def.states as Record<string, Record<string, unknown>>;
    states.plan.model = null;
    expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
  });
});

// ---------------------------------------------------------------------------
// 2. Orchestrator routing: state > workflow > undefined (fallback)
// ---------------------------------------------------------------------------

describe('orchestrator model routing', () => {
  let tmpDir: string;
  let activeOrchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'model-selection-'));
    activeOrchestrator = undefined;
  });

  afterEach(async () => {
    if (activeOrchestrator) await activeOrchestrator.shutdownAll();
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
    const baseName = resolve(tmpDir).split('/').pop() ?? '';
    const ckptDir = resolve(tmpDir, '..', `${baseName}-ckpt`);
    rmSync(ckptDir, { recursive: true, force: true });
  });

  /**
   * Drives a two-state workflow and returns the captured SessionOptions
   * passed to createSession for each state in visit order.
   */
  async function runAndCaptureOptions(definition: WorkflowDefinition): Promise<SessionOptions[]> {
    cleanupPersonas = stubPersonasForTest(tmpDir, definition);
    const defPath = writeDefinitionFile(tmpDir, definition);
    const capturedOpts: SessionOptions[] = [];

    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      capturedOpts.push(opts);
      const persona = opts.persona ?? 'unknown';
      const artifactName = persona === 'planner' ? 'plan' : 'code';
      return createArtifactAwareSession(
        [{ text: approvedResponse('done'), artifacts: [artifactName] }],
        tmpDir,
        `${persona}-session`,
      );
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'test task');
    await waitForCompletion(orchestrator, workflowId);
    return capturedOpts;
  }

  it('passes workflow-level model as agentModelOverride when no state override is set', async () => {
    const def: WorkflowDefinition = {
      name: 'wf-level-only',
      description: 'Workflow-level model only',
      initial: 'plan',
      settings: { mode: 'builtin', model: 'anthropic:claude-sonnet-4-6' },
      states: {
        plan: {
          type: 'agent',
          description: 'Plans',
          persona: 'planner',
          prompt: 'Plan.',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'implement' }],
        },
        implement: {
          type: 'agent',
          description: 'Implements',
          persona: 'coder',
          prompt: 'Code.',
          inputs: ['plan'],
          outputs: ['code'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };

    const opts = await runAndCaptureOptions(def);
    expect(opts).toHaveLength(2);
    expect(opts[0].agentModelOverride).toBe('anthropic:claude-sonnet-4-6');
    expect(opts[1].agentModelOverride).toBe('anthropic:claude-sonnet-4-6');
  });

  it('per-state model wins over workflow-level model', async () => {
    const def: WorkflowDefinition = {
      name: 'state-wins',
      description: 'State model wins',
      initial: 'plan',
      settings: { mode: 'builtin', model: 'anthropic:claude-sonnet-4-6' },
      states: {
        plan: {
          type: 'agent',
          description: 'Plans with opus',
          persona: 'planner',
          prompt: 'Plan.',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'implement' }],
          model: 'anthropic:claude-opus-4-6',
        },
        implement: {
          type: 'agent',
          description: 'Implements (inherits workflow default)',
          persona: 'coder',
          prompt: 'Code.',
          inputs: ['plan'],
          outputs: ['code'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };

    const opts = await runAndCaptureOptions(def);
    expect(opts).toHaveLength(2);
    // plan uses the state-level opus override
    expect(opts[0].agentModelOverride).toBe('anthropic:claude-opus-4-6');
    // implement falls back to the workflow-level sonnet default
    expect(opts[1].agentModelOverride).toBe('anthropic:claude-sonnet-4-6');
  });

  it('omits agentModelOverride when neither level sets a model (factory fallback)', async () => {
    const def: WorkflowDefinition = {
      name: 'no-override',
      description: 'Fallback to config default',
      initial: 'plan',
      settings: { mode: 'builtin' },
      states: {
        plan: {
          type: 'agent',
          description: 'Plans',
          persona: 'planner',
          prompt: 'Plan.',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'implement' }],
        },
        implement: {
          type: 'agent',
          description: 'Implements',
          persona: 'coder',
          prompt: 'Code.',
          inputs: ['plan'],
          outputs: ['code'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };

    const opts = await runAndCaptureOptions(def);
    expect(opts).toHaveLength(2);
    // agentModelOverride must be absent -- factory resolves via user config
    expect(opts[0].agentModelOverride).toBeUndefined();
    expect(opts[1].agentModelOverride).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Session factory precedence
// ---------------------------------------------------------------------------

describe('createWorkflowSessionFactory precedence', () => {
  // Dynamically import after each test resets modules, so the mock of
  // `createSession` is picked up by the factory under test.
  beforeEach(() => {
    vi.resetModules();
  });

  async function runFactoryCase(args: {
    modelOverride?: string;
    perCallOverride?: string;
    configModelId: string;
  }): Promise<{ capturedOptions: SessionOptions; capturedConfig: { agentModelId: string } }> {
    let capturedOptions: SessionOptions | undefined;
    let capturedConfig: { agentModelId: string } | undefined;

    vi.doMock('../../src/config/index.js', () => ({
      loadConfig: () => ({
        agentModelId: args.configModelId,
        userConfig: { agentModelId: args.configModelId },
      }),
    }));

    vi.doMock('../../src/session/index.js', () => ({
      createSession: async (opts: SessionOptions) => {
        capturedOptions = opts;
        capturedConfig = opts.config as unknown as { agentModelId: string };
        return new MockSession({ responses: ['ok'] });
      },
    }));

    const { createWorkflowSessionFactory } = await import('../../src/workflow/cli-support.js');
    const factory = createWorkflowSessionFactory(args.modelOverride);

    await factory({
      persona: 'global',
      ...(args.perCallOverride != null ? { agentModelOverride: args.perCallOverride } : {}),
    });

    if (!capturedOptions || !capturedConfig) {
      throw new Error('createSession mock never captured options');
    }
    return { capturedOptions, capturedConfig };
  }

  it('falls back to user config when no overrides are set', async () => {
    // When no override is in play, the factory passes the base config through
    // unchanged and leaves agentModelOverride unset. AgentSession then reads
    // from config.agentModelId on the fallback branch.
    const { capturedOptions, capturedConfig } = await runFactoryCase({
      configModelId: 'anthropic:claude-sonnet-4-6',
    });

    expect(capturedOptions.agentModelOverride).toBeUndefined();
    expect(capturedConfig.agentModelId).toBe('anthropic:claude-sonnet-4-6');
  });

  it('per-call agentModelOverride wins over user config', async () => {
    const { capturedOptions, capturedConfig } = await runFactoryCase({
      configModelId: 'anthropic:claude-sonnet-4-6',
      perCallOverride: 'anthropic:claude-opus-4-6',
    });

    expect(capturedOptions.agentModelOverride).toBe('anthropic:claude-opus-4-6');
    expect(capturedConfig.agentModelId).toBe('anthropic:claude-opus-4-6');
  });

  it('CLI flag (modelOverride) wins over both per-call override and user config', async () => {
    const { capturedOptions, capturedConfig } = await runFactoryCase({
      configModelId: 'anthropic:claude-sonnet-4-6',
      perCallOverride: 'anthropic:claude-opus-4-6',
      modelOverride: 'anthropic:claude-haiku-4-5',
    });

    expect(capturedOptions.agentModelOverride).toBe('anthropic:claude-haiku-4-5');
    expect(capturedConfig.agentModelId).toBe('anthropic:claude-haiku-4-5');
  });

  it('CLI flag overrides even when no per-call override is set', async () => {
    const { capturedOptions, capturedConfig } = await runFactoryCase({
      configModelId: 'anthropic:claude-sonnet-4-6',
      modelOverride: 'anthropic:claude-haiku-4-5',
    });

    expect(capturedOptions.agentModelOverride).toBe('anthropic:claude-haiku-4-5');
    expect(capturedConfig.agentModelId).toBe('anthropic:claude-haiku-4-5');
  });
});

// ---------------------------------------------------------------------------
// 4. SessionOptions.agentModelOverride plumbs through AgentSession
// ---------------------------------------------------------------------------

describe('AgentSession consumes agentModelOverride', () => {
  it('uses agentModelOverride to select the model when creating the language model', async () => {
    // Verify the resolution at the agent-session boundary without starting
    // a real sandbox. The override must take precedence over config.agentModelId
    // for the ResourceBudgetTracker, cache strategy, and model creation --
    // all three of which read the same private `agentModelId` field.
    const { AgentSession } = await import('../../src/session/agent-session.js');

    const fakeConfig = {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      allowedDirectory: '/tmp/noop',
      userConfig: {
        agentModelId: 'anthropic:claude-sonnet-4-6',
        resourceBudget: {
          maxTokens: null,
          maxSteps: null,
          maxSessionSeconds: null,
          maxCostUsd: null,
        },
        autoCompact: { enabled: false, threshold: 100000 },
      },
    } as never;

    // Construct the session with an override and confirm the internal
    // agentModelId field was set from options, not from config.
    const session = new AgentSession(fakeConfig, 'test-session' as never, '/tmp/noop-esc', '/tmp/noop-dir', {
      agentModelOverride: 'anthropic:claude-opus-4-6',
    });

    // Use reflection to confirm the private field routing. This is a test-only
    // peek; production code uses `this.agentModelId` in buildModel and the
    // constructor-level budget/cache initialization.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional white-box check
    const resolvedId = (session as any).agentModelId as string;
    expect(resolvedId).toBe('anthropic:claude-opus-4-6');
  });

  it('falls back to config.agentModelId when agentModelOverride is omitted', async () => {
    const { AgentSession } = await import('../../src/session/agent-session.js');

    const fakeConfig = {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      allowedDirectory: '/tmp/noop',
      userConfig: {
        agentModelId: 'anthropic:claude-sonnet-4-6',
        resourceBudget: {
          maxTokens: null,
          maxSteps: null,
          maxSessionSeconds: null,
          maxCostUsd: null,
        },
        autoCompact: { enabled: false, threshold: 100000 },
      },
    } as never;

    const session = new AgentSession(fakeConfig, 'test-session' as never, '/tmp/noop-esc', '/tmp/noop-dir', {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional white-box check
    const resolvedId = (session as any).agentModelId as string;
    expect(resolvedId).toBe('anthropic:claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// 5. End-to-end integration: YAML -> validate -> orchestrator -> real factory
//    -> createSession (captured) with correct per-state model precedence.
// ---------------------------------------------------------------------------

describe('model selection end-to-end (YAML through real session factory)', () => {
  let tmpDir: string;
  let activeOrchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'model-selection-e2e-'));
    activeOrchestrator = undefined;
    vi.resetModules();
  });

  afterEach(async () => {
    if (activeOrchestrator) await activeOrchestrator.shutdownAll();
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(`${tmpDir}-defs`, { recursive: true, force: true });
    const baseName = resolve(tmpDir).split('/').pop() ?? '';
    const ckptDir = resolve(tmpDir, '..', `${baseName}-ckpt`);
    rmSync(ckptDir, { recursive: true, force: true });
  });

  /**
   * Captures the model ID that actually reaches `createSession` via the
   * real `createWorkflowSessionFactory`. Records, per state visit:
   *   - `agentModelOverride` on SessionOptions
   *   - the rewritten `config.agentModelId` (used by AgentSession for
   *     budget tracking, cache strategy, and model creation)
   *   - the rewritten `config.userConfig.agentModelId` (used by the
   *     Docker Claude Code adapter's `buildCommand` per-turn override)
   *
   * This matters because the feature has two stages — the orchestrator
   * forwards a model per state, and the factory layers CLI flags and
   * user-config fallback on top. A per-boundary unit test can't confirm
   * that both stages compose correctly for a real YAML workflow.
   */
  async function runYamlAndCaptureResolved(
    yamlString: string,
    configModelId: string,
    cliModelOverride?: string,
  ): Promise<
    Array<{
      persona: string;
      agentModelOverride: string | undefined;
      configAgentModelId: string;
      userConfigAgentModelId: string;
    }>
  > {
    // Write YAML to a sibling directory, not inside tmpDir (the orchestrator's
    // baseDir). `findWorkflowDir` in test-helpers scans baseDir for non-JSON
    // entries, and a `.yaml` file sitting next to auto-generated workflow
    // subdirectories would be picked up as the workflow dir and break
    // artifact simulation.
    const defDir = `${tmpDir}-defs`;
    mkdirSync(defDir, { recursive: true });
    const defPath = resolve(defDir, 'wf.yaml');
    writeFileSync(defPath, yamlString);
    const parsed = parseDefinitionFile(defPath) as WorkflowDefinition;
    // validateDefinition throws if the YAML -> object shape is malformed.
    validateDefinition(parsed);

    cleanupPersonas = stubPersonasForTest(tmpDir, parsed);

    const captured: Array<{
      persona: string;
      agentModelOverride: string | undefined;
      configAgentModelId: string;
      userConfigAgentModelId: string;
    }> = [];

    // Mock `loadConfig` -- invoked synchronously when the factory closure
    // is built. Must be mocked BEFORE the factory module is imported.
    vi.doMock('../../src/config/index.js', () => ({
      loadConfig: () => ({
        agentModelId: configModelId,
        userConfig: { agentModelId: configModelId },
      }),
    }));

    // Mock `createSession` so we can observe what the real factory sends.
    // Drive a two-state workflow: each state gets one approved response
    // that creates the state's `outputs` artifact on disk, so orchestrator
    // artifact checks pass and the workflow progresses.
    vi.doMock('../../src/session/index.js', () => ({
      createSession: async (opts: SessionOptions) => {
        const persona = opts.persona ?? 'unknown';
        captured.push({
          persona,
          agentModelOverride: opts.agentModelOverride,
          configAgentModelId: (opts.config as { agentModelId: string }).agentModelId,
          userConfigAgentModelId: (opts.config as { userConfig: { agentModelId: string } }).userConfig.agentModelId,
        });
        const artifactName = persona === 'planner' ? 'plan' : 'code';
        return createArtifactAwareSession(
          [{ text: approvedResponse('done'), artifacts: [artifactName] }],
          tmpDir,
          `${persona}-session`,
        );
      },
    }));

    const { createWorkflowSessionFactory } = await import('../../src/workflow/cli-support.js');
    const sessionFactory = createWorkflowSessionFactory(cliModelOverride);

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'test task');
    await waitForCompletion(orchestrator, workflowId);
    return captured;
  }

  it('flows workflow-level YAML model through to createSession unchanged when no state override', async () => {
    const yaml = [
      'name: wf-yaml-only',
      'description: workflow-level only',
      'initial: plan',
      'settings:',
      '  mode: builtin',
      '  model: anthropic:claude-sonnet-4-6',
      'states:',
      '  plan:',
      '    type: agent',
      '    description: Plan',
      '    persona: planner',
      '    prompt: Plan.',
      '    inputs: []',
      '    outputs: [plan]',
      '    transitions:',
      '      - to: implement',
      '  implement:',
      '    type: agent',
      '    description: Implement',
      '    persona: coder',
      '    prompt: Code.',
      '    inputs: [plan]',
      '    outputs: [code]',
      '    transitions:',
      '      - to: done',
      '  done:',
      '    type: terminal',
      '    description: Done',
      '',
    ].join('\n');

    const captured = await runYamlAndCaptureResolved(yaml, 'anthropic:claude-haiku-4-5');

    expect(captured).toHaveLength(2);
    // Both states inherit the workflow-level sonnet override.
    expect(captured[0].agentModelOverride).toBe('anthropic:claude-sonnet-4-6');
    expect(captured[0].configAgentModelId).toBe('anthropic:claude-sonnet-4-6');
    expect(captured[0].userConfigAgentModelId).toBe('anthropic:claude-sonnet-4-6');
    expect(captured[1].agentModelOverride).toBe('anthropic:claude-sonnet-4-6');
    expect(captured[1].configAgentModelId).toBe('anthropic:claude-sonnet-4-6');
  });

  it('per-state YAML model wins over workflow-level default on a per-call basis', async () => {
    const yaml = [
      'name: wf-state-override',
      'description: per-state override',
      'initial: plan',
      'settings:',
      '  mode: builtin',
      '  model: anthropic:claude-sonnet-4-6',
      'states:',
      '  plan:',
      '    type: agent',
      '    description: Plan with opus',
      '    persona: planner',
      '    prompt: Plan.',
      '    inputs: []',
      '    outputs: [plan]',
      '    model: anthropic:claude-opus-4-6',
      '    transitions:',
      '      - to: implement',
      '  implement:',
      '    type: agent',
      '    description: Implement inherits workflow default',
      '    persona: coder',
      '    prompt: Code.',
      '    inputs: [plan]',
      '    outputs: [code]',
      '    transitions:',
      '      - to: done',
      '  done:',
      '    type: terminal',
      '    description: Done',
      '',
    ].join('\n');

    const captured = await runYamlAndCaptureResolved(yaml, 'anthropic:claude-haiku-4-5');

    expect(captured).toHaveLength(2);
    // Plan state uses the per-state opus model.
    expect(captured[0].persona).toBe('planner');
    expect(captured[0].agentModelOverride).toBe('anthropic:claude-opus-4-6');
    expect(captured[0].configAgentModelId).toBe('anthropic:claude-opus-4-6');
    expect(captured[0].userConfigAgentModelId).toBe('anthropic:claude-opus-4-6');
    // Implement state falls back to the workflow-level sonnet default.
    expect(captured[1].persona).toBe('coder');
    expect(captured[1].agentModelOverride).toBe('anthropic:claude-sonnet-4-6');
    expect(captured[1].configAgentModelId).toBe('anthropic:claude-sonnet-4-6');
    expect(captured[1].userConfigAgentModelId).toBe('anthropic:claude-sonnet-4-6');
    // Critically: the user-config default is NEVER what lands at createSession
    // when any model is set at the workflow or state level.
    expect(captured[0].configAgentModelId).not.toBe('anthropic:claude-haiku-4-5');
    expect(captured[1].configAgentModelId).not.toBe('anthropic:claude-haiku-4-5');
  });

  it('CLI --model flag overrides both per-state and workflow-level YAML models', async () => {
    const yaml = [
      'name: wf-cli-wins',
      'description: CLI flag beats all',
      'initial: plan',
      'settings:',
      '  mode: builtin',
      '  model: anthropic:claude-sonnet-4-6',
      'states:',
      '  plan:',
      '    type: agent',
      '    description: Plan',
      '    persona: planner',
      '    prompt: Plan.',
      '    inputs: []',
      '    outputs: [plan]',
      '    model: anthropic:claude-opus-4-6',
      '    transitions:',
      '      - to: implement',
      '  implement:',
      '    type: agent',
      '    description: Implement',
      '    persona: coder',
      '    prompt: Code.',
      '    inputs: [plan]',
      '    outputs: [code]',
      '    transitions:',
      '      - to: done',
      '  done:',
      '    type: terminal',
      '    description: Done',
      '',
    ].join('\n');

    const captured = await runYamlAndCaptureResolved(
      yaml,
      'anthropic:claude-sonnet-4-6',
      // CLI --model flag — beats both the per-state opus override and
      // the workflow-level sonnet default.
      'anthropic:claude-haiku-4-5',
    );

    expect(captured).toHaveLength(2);
    // Both states end up with the CLI flag value regardless of what YAML said.
    for (const entry of captured) {
      expect(entry.agentModelOverride).toBe('anthropic:claude-haiku-4-5');
      expect(entry.configAgentModelId).toBe('anthropic:claude-haiku-4-5');
      expect(entry.userConfigAgentModelId).toBe('anthropic:claude-haiku-4-5');
    }
  });
});
