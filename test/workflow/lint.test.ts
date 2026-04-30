import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
// WF008 — visit-cap guard must precede loop-continuing transitions
// ---------------------------------------------------------------------------

describe('WF008 — visit-cap transition ordering', () => {
  /**
   * Sentinel sharing the `| undefined` slot so a test can opt out of
   * `maxVisits` entirely. Default parameters in JS collapse an explicit
   * `undefined` into the default value, which would hide the "no
   * maxVisits" case.
   */
  const OMIT_MAX_VISITS = Symbol('omit-maxVisits');

  /**
   * Helper: builds a 3-state workflow where `review` is a bounded-loop
   * state whose transitions are supplied by the caller. Includes escalate
   * + approval terminals keyed off common transition targets so
   * reachability/terminal checks pass regardless of which transitions the
   * test supplies.
   */
  function withReviewTransitions(
    transitions: readonly unknown[],
    maxVisits: number | typeof OMIT_MAX_VISITS = 3,
  ): WorkflowDefinition {
    const reviewBase: Record<string, unknown> = {
      type: 'agent',
      description: 'review',
      persona: 'global',
      prompt: 'p',
      inputs: ['plan'],
      outputs: ['review'],
      transitions,
    };
    if (maxVisits !== OMIT_MAX_VISITS) reviewBase.maxVisits = maxVisits;

    return validateDefinition({
      name: 't',
      description: 'd',
      initial: 'plan',
      states: {
        // `plan` dispatches to `review` and also to `escalate_gate` so the
        // gate remains reachable even in tests where the review state has
        // no cap-guarded transition going there.
        plan: {
          type: 'agent',
          description: 'plan',
          persona: 'global',
          prompt: 'p',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'escalate_gate', when: { verdict: 'escalate' } }, { to: 'review' }],
        },
        review: reviewBase,
        escalate_gate: {
          type: 'human_gate',
          description: 'escalate',
          acceptedEvents: ['APPROVE', 'ABORT'],
          transitions: [
            { to: 'done', event: 'APPROVE' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        done: { type: 'terminal', description: 'd' },
        aborted: { type: 'terminal', description: 'a' },
      },
    });
  }

  it('errors when a non-approval when clause precedes the cap guard', () => {
    const def = withReviewTransitions([
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'plan', when: { verdict: 'rejected' } },
      { to: 'escalate_gate', guard: 'isStateVisitLimitReached' },
    ]);

    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF008');
    const d = result.find((x) => x.code === 'WF008');
    expect(d?.stateId).toBe('review');
    expect(d?.severity).toBe('error');
    expect(d?.message).toContain('position 3');
    expect(d?.message).toContain('position 2');
    expect(d?.message).toContain('rejected');
  });

  it('passes when the cap guard precedes all loop-continuing transitions', () => {
    const def = withReviewTransitions([
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'escalate_gate', guard: 'isStateVisitLimitReached' },
      { to: 'plan', when: { verdict: 'rejected' } },
    ]);
    expect(codes(lintWorkflow(def, stubCtx))).not.toContain('WF008');
  });

  it('passes when maxVisits is set but no cap-guarded transition is present', () => {
    // Without the guard, the cap is inert anyway — this rule is only
    // concerned with ordering, not with whether the cap is wired up.
    const def = withReviewTransitions([
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'plan', when: { verdict: 'rejected' } },
    ]);
    expect(codes(lintWorkflow(def, stubCtx))).not.toContain('WF008');
  });

  it('passes when the cap-guarded transition exists but maxVisits is absent', () => {
    // The guard on a state without maxVisits is inert — not WF008's concern.
    const def = withReviewTransitions(
      [
        { to: 'done', when: { verdict: 'approved' } },
        { to: 'plan', when: { verdict: 'rejected' } },
        { to: 'escalate_gate', guard: 'isStateVisitLimitReached' },
      ],
      OMIT_MAX_VISITS,
    );
    expect(codes(lintWorkflow(def, stubCtx))).not.toContain('WF008');
  });

  it('flags an unconditional transition preceding the cap guard', () => {
    // An unconditional `to:` transition matches every time, so it
    // short-circuits the cap just like a non-approval when clause.
    const def = withReviewTransitions([
      { to: 'done', when: { verdict: 'approved' } },
      { to: 'plan' }, // unconditional — always matches
      { to: 'escalate_gate', guard: 'isStateVisitLimitReached' },
    ]);
    const result = lintWorkflow(def, stubCtx);
    expect(codes(result)).toContain('WF008');
    const d = result.find((x) => x.code === 'WF008');
    expect(d?.message).toContain('unconditional');
  });

  it('accepts all approval-style exit verdicts before the cap', () => {
    // All five approval verdicts can legitimately precede the cap: on
    // the cap visit, if the agent emits an approval verdict we take the
    // success exit rather than escalating.
    const approvalVerdicts = ['approved', 'complete', 'done', 'success', 'passed'];
    const transitions = [
      ...approvalVerdicts.map((v) => ({ to: 'done', when: { verdict: v } })),
      { to: 'escalate_gate', guard: 'isStateVisitLimitReached' },
      { to: 'plan', when: { verdict: 'rejected' } },
    ];
    const def = withReviewTransitions(transitions);
    expect(codes(lintWorkflow(def, stubCtx))).not.toContain('WF008');
  });

  // Note on `when` clauses with non-`verdict` keys: validateDefinition
  // already rejects those (only `verdict` is supported for when-clause
  // routing), so they cannot reach lint in practice. The rule's
  // `isApprovalExitTransition` still treats them as loop-continuing for
  // defense-in-depth when multi-field `when` becomes a supported feature.

  it('flags the vuln-discovery workflow (regression sample)', () => {
    // Targeted check: the two bugs reported by the Copilot reviewer both
    // fire and report the right states. Kept separate from the "bundled
    // workflows lint clean" regression so that the intent of this check
    // is discoverable by greppers.
    const raw = parseYaml(
      readFileSync(
        resolve(__dirname, '..', '..', 'src', 'workflow', 'workflows', 'vuln-discovery', 'workflow.yaml'),
        'utf-8',
      ),
      { maxAliasCount: 0 },
    );
    const def = validateDefinition(raw);
    const diagnostics = lintWorkflow(def, stubCtx);
    const wf008 = diagnostics.filter((d) => d.code === 'WF008').map((d) => d.stateId);
    // After Step 3 reorders the YAML this list is empty; WF008 no longer
    // fires. (The bundled-workflows regression below asserts the same
    // thing more broadly.)
    expect(wf008).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WF010 — agent state references an invalid or missing skill
// ---------------------------------------------------------------------------

describe('WF010 — skill references', () => {
  let packageDir: string;
  let manifestPath: string;

  beforeEach(() => {
    // Each test gets its own package dir so we can write a workflow.yaml
    // alongside an optional `skills/` sidecar tree. The lint check
    // resolves `skills/` off the manifest's parent dir, mirroring what
    // `getWorkflowPackageDir(workflowFilePath)` does at runtime.
    packageDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-lint-skills-test-'));
    manifestPath = resolve(packageDir, 'workflow.yaml');
    writeFileSync(manifestPath, '# placeholder — lint reads only the package dir off this path\n');
  });

  afterEach(() => {
    rmSync(packageDir, { recursive: true, force: true });
  });

  function writeSkillManifest(name: string): void {
    const dir = resolve(packageDir, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`);
  }

  /** Builds a workflow whose `plan` agent state declares the given skill list. */
  function workflowWithSkills(skills: readonly string[]): WorkflowDefinition {
    return validateDefinition({
      name: 'lint-skills',
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
          skills,
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
  }

  function ctxWithPath(): LintContext {
    return { personaExists: () => true, workflowFilePath: manifestPath };
  }

  it('passes when every skill exists at <pkg>/skills/<name>/SKILL.md', () => {
    writeSkillManifest('fetcher');
    const def = workflowWithSkills(['fetcher']);
    expect(codes(lintWorkflow(def, ctxWithPath()))).not.toContain('WF010');
  });

  it('errors when a referenced skill manifest is missing', () => {
    const def = workflowWithSkills(['absent']);
    const result = lintWorkflow(def, ctxWithPath());
    expect(codes(result)).toContain('WF010');
    const d = result.find((x) => x.code === 'WF010');
    expect(d?.severity).toBe('error');
    expect(d?.stateId).toBe('plan');
    expect(d?.message).toContain('"absent"');
    expect(d?.message).toContain(resolve(packageDir, 'skills'));
    expect(d?.message).toMatch(/no skill with that frontmatter name was found/);
  });

  it('matches on frontmatter `name:`, not directory name', () => {
    // Dir is `dir-name/` but the SKILL.md frontmatter says
    // `name: frontmatter-name`. Lint matches on frontmatter name (so
    // `workflowSkillFilter` in the resolver agrees with the lint
    // surface): `frontmatter-name` passes, `dir-name` does not.
    const dir = resolve(packageDir, 'skills', 'dir-name');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'SKILL.md'), '---\nname: frontmatter-name\ndescription: x\n---\n');

    const passing = workflowWithSkills(['frontmatter-name']);
    expect(codes(lintWorkflow(passing, ctxWithPath()))).not.toContain('WF010');

    const failing = workflowWithSkills(['dir-name']);
    const result = lintWorkflow(failing, ctxWithPath());
    const d = result.find((x) => x.code === 'WF010');
    expect(d?.severity).toBe('error');
    expect(d?.message).toMatch(/no skill with that frontmatter name was found/);
    // Available list surfaces the real (frontmatter) identifier — what an
    // author should reference instead.
    expect(d?.message).toContain('frontmatter-name');
  });

  it('errors on an empty-string skill name', () => {
    const def = workflowWithSkills(['']);
    const result = lintWorkflow(def, ctxWithPath());
    const d = result.find((x) => x.code === 'WF010');
    expect(d?.severity).toBe('error');
    expect(d?.message).toMatch(/Invalid skill name/);
    expect(d?.message).toMatch(/empty/);
  });

  it('errors on a skill name containing a path separator', () => {
    const def = workflowWithSkills(['foo/bar']);
    const result = lintWorkflow(def, ctxWithPath());
    const d = result.find((x) => x.code === 'WF010');
    expect(d?.severity).toBe('error');
    expect(d?.message).toMatch(/path separator/);
  });

  it('errors on "." and ".."', () => {
    for (const bad of ['.', '..']) {
      const def = workflowWithSkills([bad]);
      const result = lintWorkflow(def, ctxWithPath());
      const d = result.find((x) => x.code === 'WF010');
      expect(d?.severity).toBe('error');
      expect(d?.message).toMatch(/Invalid skill name/);
    }
  });

  it('emits one diagnostic per offending entry (batched, not first-error-only)', () => {
    const def = workflowWithSkills(['', 'foo/bar', 'absent']);
    const result = lintWorkflow(def, ctxWithPath());
    const wf010 = result.filter((d) => d.code === 'WF010');
    expect(wf010).toHaveLength(3);
  });

  it('does not fire when ctx.workflowFilePath is omitted', () => {
    // Lint callers without a path on hand (e.g., tests that synthesize a
    // definition in memory, or `inspect` over a past run) should see the
    // rule skip cleanly rather than emit noise about non-existent
    // sidecars.
    const def = workflowWithSkills(['absent']);
    const noPathCtx: LintContext = { personaExists: () => true };
    expect(codes(lintWorkflow(def, noPathCtx))).not.toContain('WF010');
  });

  it('does not fire on agent states without a skills field', () => {
    const def = validateDefinition({
      name: 'no-skills',
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
          // skills omitted entirely
        },
        done: { type: 'terminal', description: 'd' },
      },
    });
    expect(codes(lintWorkflow(def, ctxWithPath()))).not.toContain('WF010');
  });

  // -------------------------------------------------------------------------
  // Package-scoped WF010: malformed SKILL.md surfaces even when no state
  // references it. Closes the gap that let typo'd frontmatter ship silently.
  // -------------------------------------------------------------------------

  /**
   * Writes a `SKILL.md` under `<packageDir>/skills/<dirName>/` with the
   * given exact body (no frontmatter wrapping). Lets tests construct
   * malformed manifests that `writeSkillManifest` cannot.
   */
  function writeRawSkillManifest(dirName: string, body: string): string {
    const dir = resolve(packageDir, 'skills', dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'SKILL.md'), body);
    return dir;
  }

  /** Definition with no `skills:` references — isolates the package walk. */
  function workflowWithoutSkills(): WorkflowDefinition {
    return validateDefinition({
      name: 'no-refs',
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
        done: { type: 'terminal', description: 'd' },
      },
    });
  }

  it('errors on a SKILL.md with malformed YAML even when no state references it', () => {
    // Closes the WF010 gap: pre-fix, a typo'd frontmatter under
    // `<pkg>/skills/<dir>/SKILL.md` produced zero diagnostics if no
    // state happened to reference it. Authors had no signal at all.
    const skillDir = writeRawSkillManifest('broken', '---\nname: "unterminated\n---\n');

    const result = lintWorkflow(workflowWithoutSkills(), ctxWithPath());
    const wf010 = result.filter((d) => d.code === 'WF010');
    expect(wf010).toHaveLength(1);
    expect(wf010[0].severity).toBe('error');
    expect(wf010[0].stateId).toBeUndefined();
    expect(wf010[0].message).toContain('Malformed SKILL.md');
    expect(wf010[0].message).toContain(skillDir);
  });

  it('errors on a SKILL.md missing the `name:` field', () => {
    const skillDir = writeRawSkillManifest('no-name', '---\ndescription: "x"\n---\n');

    const result = lintWorkflow(workflowWithoutSkills(), ctxWithPath());
    const wf010 = result.filter((d) => d.code === 'WF010');
    expect(wf010).toHaveLength(1);
    expect(wf010[0].severity).toBe('error');
    expect(wf010[0].stateId).toBeUndefined();
    expect(wf010[0].message).toContain(skillDir);
    expect(wf010[0].message).toContain('SKILL.md');
  });

  it('surfaces both a healthy and a broken SKILL.md alongside each other', () => {
    // Healthy manifest is discoverable for the reference check; broken
    // manifest produces a package-scoped diagnostic. The reference
    // check still passes for the healthy entry.
    writeSkillManifest('healthy');
    const brokenDir = writeRawSkillManifest('broken', '---\n\t- not: : a: mapping\n---\n');

    const def = workflowWithSkills(['healthy']);
    const result = lintWorkflow(def, ctxWithPath());
    const wf010 = result.filter((d) => d.code === 'WF010');
    // One package-scoped diagnostic for the broken file. The reference
    // to `healthy` resolves cleanly, so no state-scoped diagnostic.
    expect(wf010).toHaveLength(1);
    expect(wf010[0].stateId).toBeUndefined();
    expect(wf010[0].message).toContain(brokenDir);
  });

  it('does not fire on directories without a SKILL.md (legitimate sidecars)', () => {
    // A skills root may legitimately contain helper subdirs (READMEs,
    // fixtures, test artifacts). `missing-manifest` is intentionally
    // not surfaced — same reasoning as the runtime warning gate.
    const helperDir = resolve(packageDir, 'skills', 'shared-fixtures');
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(resolve(helperDir, 'README.md'), '# notes\n');

    expect(codes(lintWorkflow(workflowWithoutSkills(), ctxWithPath()))).not.toContain('WF010');
  });

  it('does not fire when `workflowFilePath` is omitted, even if a malformed manifest would exist', () => {
    // Without a manifest path the lint surface has no way to locate
    // the package dir; the rule must skip cleanly rather than guess.
    writeRawSkillManifest('broken', '---\nname: "unterminated\n---\n');

    const noPathCtx: LintContext = { personaExists: () => true };
    expect(codes(lintWorkflow(workflowWithoutSkills(), noPathCtx))).not.toContain('WF010');
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

  for (const name of ['vuln-discovery', 'design-and-code']) {
    it(`${name}: zero errors`, () => {
      const manifestPath = resolve(workflowsDir, name, 'workflow.yaml');
      const raw = parseYaml(readFileSync(manifestPath, 'utf-8'), { maxAliasCount: 0 });
      const def = validateDefinition(raw);
      // Pass `workflowFilePath` so WF010 (skill references) runs against
      // the real package directory — bundled workflows don't currently
      // reference skills, but if they ever do this regression catches a
      // missing manifest sidecar.
      const ctx: LintContext = { ...bundledCtx, workflowFilePath: manifestPath };
      const diagnostics = lintWorkflow(def, ctx);
      const errors = diagnostics.filter((d) => d.severity === 'error');
      if (errors.length > 0) {
        console.error('Unexpected errors:', errors);
      }
      expect(errors.length).toBe(0);
    });
  }
});
