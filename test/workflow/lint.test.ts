import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { lintWorkflow, type Diagnostic, type LintContext } from '../../src/workflow/lint.js';
import { validateDefinition } from '../../src/workflow/validate.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub context that claims every persona exists. Phase 1 checks ignore it. */
const stubCtx: LintContext = { personaExists: () => true };

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

/** Returns a baseline valid definition that each test mutates as needed. */
function baseline(): WorkflowDefinition {
  return validateDefinition({
    name: 'lint-test',
    description: 'baseline for lint tests',
    initial: 'plan',
    states: {
      plan: {
        type: 'agent',
        description: 'Plan',
        persona: 'global',
        prompt: 'plan',
        inputs: [],
        outputs: ['plan'],
        transitions: [{ to: 'done' }],
      },
      done: {
        type: 'terminal',
        description: 'done',
        outputs: ['plan'],
      },
    },
  });
}

// ---------------------------------------------------------------------------
// WF001 — state cannot reach any terminal
// ---------------------------------------------------------------------------

describe('WF001 — unreachable terminal', () => {
  it('flags a self-looping non-terminal whose forward cone never hits a terminal', () => {
    // Initial -> either done (terminal) or stuck (self-loop with no exit).
    // Both branches are reachable; stuck's forward cone is {stuck}, no terminal.
    const def = validateDefinition({
      name: 't',
      description: 'd',
      initial: 'entry',
      states: {
        entry: {
          type: 'agent',
          description: 'entry',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['o'],
          transitions: [{ to: 'done', when: { verdict: 'ok' } }, { to: 'stuck' }],
        },
        stuck: {
          type: 'agent',
          description: 'stuck',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['s'],
          transitions: [{ to: 'stuck' }],
        },
        done: { type: 'terminal', description: 'done' },
      },
    });

    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF001');
    const wf001 = result.find((d) => d.code === 'WF001');
    expect(wf001?.stateId).toBe('stuck');
    expect(wf001?.severity).toBe('error');
  });

  it('does not flag states that reach a terminal through a cycle', () => {
    const def = validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'plan',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['o'],
          transitions: [{ to: 'review' }],
        },
        review: {
          type: 'agent',
          description: 'review',
          persona: 'global',
          prompt: 'p',
          inputs: ['o'],
          outputs: ['r'],
          transitions: [
            { to: 'plan', when: { verdict: 'rejected' } },
            { to: 'done', when: { verdict: 'approved' } },
          ],
        },
        done: { type: 'terminal', description: 'done' },
      },
    });
    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).not.toContain('WF001');
  });
});

// ---------------------------------------------------------------------------
// WF002 — unversionedArtifacts entry not produced
// ---------------------------------------------------------------------------

describe('WF002 — unversionedArtifacts not produced', () => {
  it('warns on an unversionedArtifacts name that no state outputs', () => {
    const def = validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      settings: { unversionedArtifacts: ['ghost'] },
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'd', outputs: ['plan'] },
      },
    });
    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF002');
    const d = result.find((x) => x.code === 'WF002');
    expect(d?.severity).toBe('warning');
    expect(d?.message).toContain('"ghost"');
  });

  it('passes when every entry matches a produced artifact', () => {
    const def = baseline();
    const withSettings: WorkflowDefinition = {
      ...def,
      settings: { ...(def.settings ?? {}), unversionedArtifacts: ['plan'] },
    };
    expect(codes(lintWorkflow(withSettings, stubCtx))).not.toContain('WF002');
  });
});

// ---------------------------------------------------------------------------
// WF003 — terminal.outputs not produced by reachable state
// ---------------------------------------------------------------------------

describe('WF003 — terminal output not produced', () => {
  it('warns when a terminal lists an output that nothing produces', () => {
    const def = validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'd', outputs: ['plan', 'phantom'] },
      },
    });
    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF003');
    const d = result.find((x) => x.code === 'WF003');
    expect(d?.stateId).toBe('done');
    expect(d?.severity).toBe('warning');
    expect(d?.message).toContain('"phantom"');
  });
});

// ---------------------------------------------------------------------------
// WF004 — human_gate present not produced
// ---------------------------------------------------------------------------

describe('WF004 — human_gate present artifact not produced', () => {
  it('errors when a human_gate presents an artifact no reachable state produces', () => {
    const def = validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'gate' }],
        },
        gate: {
          type: 'human_gate',
          description: 'gate',
          acceptedEvents: ['APPROVE', 'ABORT'],
          // `?` marker should be stripped the same way validateArtifactInputs does.
          present: ['missing-artifact?'],
          transitions: [
            { to: 'done', event: 'APPROVE' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        done: { type: 'terminal', description: 'd' },
        aborted: { type: 'terminal', description: 'a' },
      },
    });
    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF004');
    const d = result.find((x) => x.code === 'WF004');
    expect(d?.stateId).toBe('gate');
    expect(d?.severity).toBe('error');
    expect(d?.message).toContain('"missing-artifact"');
    expect(d?.message).not.toContain('?"');
  });
});

// ---------------------------------------------------------------------------
// WF005 — parallelKey + worktree without gitRepoPath
// ---------------------------------------------------------------------------

describe('WF005 — parallel+worktree needs gitRepoPath', () => {
  it('errors when an agent state has parallelKey + worktree:true and gitRepoPath is missing', () => {
    const def = validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['spec'],
          transitions: [{ to: 'parallel' }],
        },
        parallel: {
          type: 'agent',
          description: 'parallel impl',
          persona: 'global',
          prompt: 'p',
          inputs: ['spec'],
          outputs: ['code'],
          parallelKey: 'spec.modules',
          worktree: true,
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF005');
    const d = result.find((x) => x.code === 'WF005');
    expect(d?.stateId).toBe('parallel');
    expect(d?.severity).toBe('error');
  });

  it('passes when gitRepoPath is set', () => {
    const def = validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      settings: { gitRepoPath: '/tmp/repo' },
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['spec'],
          transitions: [{ to: 'parallel' }],
        },
        parallel: {
          type: 'agent',
          description: 'parallel impl',
          persona: 'global',
          prompt: 'p',
          inputs: ['spec'],
          outputs: ['code'],
          parallelKey: 'spec.modules',
          worktree: true,
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
    expect(codes(lintWorkflow(def, stubCtx))).not.toContain('WF005');
  });
});

// ---------------------------------------------------------------------------
// WF006 — maxRounds without isRoundLimitReached guard
// ---------------------------------------------------------------------------

describe('WF006 — maxRounds with no guard', () => {
  it('warns when maxRounds is set but no transition uses isRoundLimitReached', () => {
    const def = validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      settings: { maxRounds: 4 },
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF006');
    const d = result.find((x) => x.code === 'WF006');
    expect(d?.severity).toBe('warning');
    expect(d?.message).toContain('maxRounds=4');
  });

  it('passes when some transition uses isRoundLimitReached', () => {
    const def = validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      settings: { maxRounds: 4 },
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done', guard: 'isRoundLimitReached' }, { to: 'plan' }],
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
    expect(codes(lintWorkflow(def, stubCtx))).not.toContain('WF006');
  });
});

// ---------------------------------------------------------------------------
// WF007 — persona not installed locally
// ---------------------------------------------------------------------------

describe('WF007 — persona not installed', () => {
  /** Baseline workflow that routes `persona` through to the state under test. */
  function withPersona(persona: string): WorkflowDefinition {
    return validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      states: {
        plan: {
          type: 'agent',
          description: 'p',
          persona,
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
  }

  it('warns when an agent state references a persona that does not exist', () => {
    const def = withPersona('nonexistent');
    const ctx: LintContext = { personaExists: () => false };

    const result = lintWorkflow(def, ctx);
    expect(codes(result)).toContain('WF007');
    const d = result.find((x) => x.code === 'WF007');
    expect(d?.stateId).toBe('plan');
    expect(d?.severity).toBe('warning');
    expect(d?.message).toContain('"nonexistent"');
  });

  it('does NOT fire on GLOBAL_PERSONA even when the stub claims it is missing', () => {
    // Stub returns false for everything — if WF007 fires here it means the
    // GLOBAL_PERSONA skip is not doing its job.
    const def = withPersona('global');
    const ctx: LintContext = { personaExists: () => false };

    const result = lintWorkflow(def, ctx);
    expect(codes(result)).not.toContain('WF007');
  });

  it('does NOT fire when personaExists returns true', () => {
    const def = withPersona('my-installed-persona');
    const ctx: LintContext = { personaExists: () => true };

    const result = lintWorkflow(def, ctx);
    expect(codes(result)).not.toContain('WF007');
  });
});

// ---------------------------------------------------------------------------
// Regression — bundled workflows must lint clean (zero errors)
// ---------------------------------------------------------------------------

describe('bundled workflows lint clean', () => {
  const workflowsDir = resolve(__dirname, '..', '..', 'src', 'workflow', 'workflows');

  // personaExists returns false unconditionally — both bundled workflows use
  // GLOBAL_PERSONA throughout, so WF007 must skip via the alias, not the stub.
  const bundledCtx: LintContext = { personaExists: () => false };

  for (const name of ['vuln-discovery.yaml', 'design-and-code.yaml']) {
    it(`${name}: zero errors`, () => {
      const raw = parseYaml(readFileSync(resolve(workflowsDir, name), 'utf-8'), {
        maxAliasCount: 0,
      });
      const def = validateDefinition(raw);
      const diagnostics = lintWorkflow(def, bundledCtx);
      const errors = diagnostics.filter((d) => d.severity === 'error');
      if (errors.length > 0) {
        console.error('Unexpected errors:', errors);
      }
      expect(errors.length).toBe(0);
    });
  }
});
