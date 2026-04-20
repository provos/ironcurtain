/**
 * Tests for the generalized transition-actions mechanism and the
 * per-state visit-cap guard (`isStateVisitLimitReached`).
 *
 * These are integration-style tests driven through buildWorkflowMachine:
 * the guard and the resetVisitCounts action are both resolved inside the
 * machine builder (closure over per-state maxVisits; assign over
 * visitCounts), so unit-testing the stubs in `guards.ts` would not
 * exercise the real behavior.
 */

import { describe, it, expect } from 'vitest';
import { createActor, fromPromise } from 'xstate';
import { buildWorkflowMachine, type AgentInvokeInput } from '../../src/workflow/machine-builder.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import { validateDefinition, WorkflowValidationError } from '../../src/workflow/validate.js';
import { makeAgentResult, makeRejectedResult, makeVerdictResult, settle } from './machine-test-helpers.js';

// ---------------------------------------------------------------------------
// Feature 1: isStateVisitLimitReached
// ---------------------------------------------------------------------------

/**
 * Loop with a per-state cap on review. maxRounds is set high so the
 * workflow-level guard never fires — only the per-state cap can escalate.
 */
const visitCapDefinition: WorkflowDefinition = {
  name: 'visit-cap-test',
  description: 'Loop bounded by per-state maxVisits',
  initial: 'implement',
  settings: { maxRounds: 99 },
  states: {
    implement: {
      type: 'agent',
      description: 'Implements',
      persona: 'coder',
      prompt: 'Implement.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'agent',
      description: 'Reviews',
      persona: 'reviewer',
      prompt: 'Review.',
      inputs: ['code'],
      outputs: ['reviews'],
      maxVisits: 3,
      transitions: [
        { to: 'done', when: { verdict: 'approved' } },
        { to: 'escalated', guard: 'isStateVisitLimitReached' },
        { to: 'implement', when: { verdict: 'rejected' } },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    escalated: { type: 'terminal', description: 'Escalated: visit cap reached' },
  },
};

describe('isStateVisitLimitReached guard', () => {
  it('does not fire below the cap', async () => {
    const { machine } = buildWorkflowMachine(visitCapDefinition, 'task');
    let reviewCount = 0;

    const testMachine = machine.provide({
      actors: {
        agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
          if (input.stateId === 'review') {
            reviewCount++;
            // First review rejects, second approves — stays below cap=3.
            if (reviewCount === 1) return makeRejectedResult();
            return makeAgentResult();
          }
          return makeAgentResult();
        }),
      },
    });

    const actor = createActor(testMachine);
    actor.start();
    await settle(200);

    // Should reach done via the approved when-clause.
    expect(actor.getSnapshot().status).toBe('done');
    const finalState = String(actor.getSnapshot().value);
    expect(finalState).toBe('done');
    expect(actor.getSnapshot().context.visitCounts['review']).toBe(2);
  });

  it('fires at the cap and routes to the guarded transition', async () => {
    const { machine } = buildWorkflowMachine(visitCapDefinition, 'task');

    const testMachine = machine.provide({
      actors: {
        agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
          if (input.stateId === 'review') {
            // Always reject -> should loop until the cap fires.
            return makeRejectedResult();
          }
          return makeAgentResult();
        }),
      },
    });

    const actor = createActor(testMachine);
    actor.start();
    await settle(300);

    // Flow: implement(1) review(1,reject) implement(2) review(2,reject)
    //       implement(3) review(3) — cap reached, routes to escalated.
    expect(actor.getSnapshot().status).toBe('done');
    expect(String(actor.getSnapshot().value)).toBe('escalated');
    expect(actor.getSnapshot().context.visitCounts['review']).toBe(3);
    expect(actor.getSnapshot().context.visitCounts['implement']).toBe(3);
  });

  it('respects per-state thresholds (different caps on different states)', async () => {
    const multiCapDef: WorkflowDefinition = {
      name: 'multi-cap-test',
      description: 'Two agent states with different caps',
      initial: 'a',
      settings: { maxRounds: 99 },
      states: {
        a: {
          type: 'agent',
          description: 'A',
          persona: 'persona-a',
          prompt: 'A.',
          inputs: [],
          outputs: ['a'],
          maxVisits: 5,
          transitions: [
            // Would trigger if a ever hits 5; we never let it.
            { to: 'escalated_a', guard: 'isStateVisitLimitReached' },
            { to: 'b' },
          ],
        },
        b: {
          type: 'agent',
          description: 'B',
          persona: 'persona-b',
          prompt: 'B.',
          inputs: ['a'],
          outputs: ['b'],
          maxVisits: 2,
          transitions: [{ to: 'escalated_b', guard: 'isStateVisitLimitReached' }, { to: 'a' }],
        },
        escalated_a: { type: 'terminal', description: 'A cap' },
        escalated_b: { type: 'terminal', description: 'B cap' },
      },
    };

    const { machine } = buildWorkflowMachine(multiCapDef, 'task');
    const testMachine = machine.provide({
      actors: {
        agentService: fromPromise(async () => makeAgentResult()),
      },
    });

    const actor = createActor(testMachine);
    actor.start();
    await settle(200);

    // Flow: a(1) b(1) a(2) b(2, cap=2 -> escalated_b)
    expect(String(actor.getSnapshot().value)).toBe('escalated_b');
    expect(actor.getSnapshot().context.visitCounts['a']).toBe(2);
    expect(actor.getSnapshot().context.visitCounts['b']).toBe(2);
  });

  it('returns false for states without maxVisits (guard is inert)', async () => {
    // Same shape as the cap definition but without maxVisits on review.
    // The guarded transition (to escalated) should never fire.
    const noCapDef: WorkflowDefinition = {
      ...visitCapDefinition,
      states: {
        ...visitCapDefinition.states,
        review: {
          type: 'agent',
          description: 'Reviews',
          persona: 'reviewer',
          prompt: 'Review.',
          inputs: ['code'],
          outputs: ['reviews'],
          // No maxVisits.
          transitions: [
            { to: 'done', when: { verdict: 'approved' } },
            { to: 'escalated', guard: 'isStateVisitLimitReached' },
            { to: 'implement', when: { verdict: 'rejected' } },
          ],
        },
      },
    };

    const { machine } = buildWorkflowMachine(noCapDef, 'task');
    let reviewCount = 0;
    const testMachine = machine.provide({
      actors: {
        agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
          if (input.stateId === 'review') {
            reviewCount++;
            // Reject 4 times, then approve — if the guard mistakenly fired
            // we'd end in 'escalated' well before 5 rejections.
            if (reviewCount < 5) return makeRejectedResult();
            return makeAgentResult();
          }
          return makeAgentResult();
        }),
      },
    });

    const actor = createActor(testMachine);
    actor.start();
    await settle(400);

    expect(actor.getSnapshot().status).toBe('done');
    expect(String(actor.getSnapshot().value)).toBe('done');
    expect(actor.getSnapshot().context.visitCounts['review']).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Feature 2: transition actions (resetVisitCounts)
// ---------------------------------------------------------------------------

describe('transition actions: resetVisitCounts', () => {
  /**
   * harness-style loop: design <-> design_review bounded by maxVisits=2;
   * on 'reset' verdict from the orchestrator, re-enter design with the
   * loop counters cleared (action: resetVisitCounts).
   */
  const resetLoopDef: WorkflowDefinition = {
    name: 'reset-loop-test',
    description: 'Bounded loop with an external reset',
    initial: 'orchestrator',
    settings: { maxRounds: 99 },
    states: {
      orchestrator: {
        type: 'agent',
        description: 'Routes to design or terminates',
        persona: 'orchestrator',
        prompt: 'Route.',
        inputs: [],
        outputs: ['plan'],
        transitions: [
          {
            to: 'design',
            when: { verdict: 'reset' },
            actions: [{ type: 'resetVisitCounts', stateIds: ['design', 'design_review'] }],
          },
          { to: 'design', when: { verdict: 'design' } },
          { to: 'done', when: { verdict: 'done' } },
        ],
      },
      design: {
        type: 'agent',
        description: 'Designs',
        persona: 'designer',
        prompt: 'Design.',
        inputs: ['plan'],
        outputs: ['design'],
        transitions: [{ to: 'design_review' }],
      },
      design_review: {
        type: 'agent',
        description: 'Reviews designs',
        persona: 'reviewer',
        prompt: 'Review.',
        inputs: ['design'],
        outputs: ['review'],
        maxVisits: 2,
        transitions: [
          { to: 'orchestrator', when: { verdict: 'approved' } },
          { to: 'orchestrator', guard: 'isStateVisitLimitReached' },
          { to: 'design', when: { verdict: 'rejected' } },
        ],
      },
      done: { type: 'terminal', description: 'Done' },
    },
  };

  it('clears only the named visit counts on a matching transition', async () => {
    const { machine } = buildWorkflowMachine(resetLoopDef, 'task');
    // Script the verdict sequence to exercise: two design_review cycles
    // hit the cap; orchestrator resets; another two cycles hit the cap
    // again (only reaches cap=2 if counters were actually cleared);
    // orchestrator terminates.
    const verdicts: string[] = [
      // 1st orchestrator: route into design
      'design',
      // design (no verdict needed — unconditional), review1 reject
      'rejected',
      // design, review2 -> cap fires -> orchestrator
      'rejected',
      // 2nd orchestrator: reset and re-enter design
      'reset',
      // design, review1 reject
      'rejected',
      // design, review2 -> cap fires -> orchestrator
      'rejected',
      // 3rd orchestrator: done
      'done',
    ];
    let idx = 0;
    const stateHits: string[] = [];

    const testMachine = machine.provide({
      actors: {
        agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
          stateHits.push(input.stateId);
          if (input.stateId === 'design') {
            // design has no verdict-based routing; return default result.
            return makeAgentResult();
          }
          if (idx >= verdicts.length) {
            throw new Error(`verdict script exhausted at call ${idx + 1} for state ${input.stateId}`);
          }
          return makeVerdictResult(verdicts[idx++]);
        }),
      },
    });

    const actor = createActor(testMachine);
    actor.start();
    await settle(500);

    expect(actor.getSnapshot().status).toBe('done');
    expect(String(actor.getSnapshot().value)).toBe('done');

    // Orchestrator ran 3 times (initial, after first cap, after reset+cap).
    expect(stateHits.filter((s) => s === 'orchestrator').length).toBe(3);
    // design / design_review each ran twice per loop, 4 total.
    expect(stateHits.filter((s) => s === 'design').length).toBe(4);
    expect(stateHits.filter((s) => s === 'design_review').length).toBe(4);

    // Final visit counts reflect only the second loop (counters were
    // cleared by resetVisitCounts). Without the reset, design_review
    // would show 4.
    const ctx = actor.getSnapshot().context;
    expect(ctx.visitCounts['design_review']).toBe(2);
    expect(ctx.visitCounts['design']).toBe(2);
    // orchestrator was never reset, so its counter reflects all 3 visits.
    expect(ctx.visitCounts['orchestrator']).toBe(3);
  });

  it('leaves non-named visit counts untouched', async () => {
    // Small fixture: a -> b (with reset of [a]) -> done.
    // Counts: a=1 before the reset; after the reset a=0; b is
    // untouched (still 1 from its own entry).
    const narrowResetDef: WorkflowDefinition = {
      name: 'narrow-reset-test',
      description: 'Narrow reset',
      initial: 'a',
      states: {
        a: {
          type: 'agent',
          description: 'A',
          persona: 'a',
          prompt: 'A.',
          inputs: [],
          outputs: ['a'],
          transitions: [{ to: 'b' }],
        },
        b: {
          type: 'agent',
          description: 'B',
          persona: 'b',
          prompt: 'B.',
          inputs: ['a'],
          outputs: ['b'],
          transitions: [
            {
              to: 'done',
              actions: [{ type: 'resetVisitCounts', stateIds: ['a'] }],
            },
          ],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };

    const { machine } = buildWorkflowMachine(narrowResetDef, 'task');
    const testMachine = machine.provide({
      actors: {
        agentService: fromPromise(async () => makeAgentResult()),
      },
    });

    const actor = createActor(testMachine);
    actor.start();
    await settle(100);

    expect(actor.getSnapshot().status).toBe('done');
    const ctx = actor.getSnapshot().context;
    expect(ctx.visitCounts['a']).toBe(0);
    expect(ctx.visitCounts['b']).toBe(1);

    // resetVisitCounts must only touch `visitCounts` — not `round` or
    // `previousOutputHashes`. These assertions pin the contract so a
    // future "fix" that broadens the reset's partial-context return value
    // (e.g. collaterally clearing these fields) fails loudly.
    //
    // Each agent completion increments `round` via
    // updateContextFromAgentResult (a -> 1, b -> 2), and each records its
    // outputHash under the state's id in previousOutputHashes.
    expect(ctx.round).toBe(2);
    expect(ctx.previousOutputHashes['a']).toBe('hash-1');
    expect(ctx.previousOutputHashes['b']).toBe('hash-1');
  });
});

// ---------------------------------------------------------------------------
// Feature 3: transition actions on human gate transitions
// ---------------------------------------------------------------------------

describe('human gate transition actions: resetVisitCounts', () => {
  /**
   * Mirrors the vuln-discovery shape: a bounded agent loop escalates to
   * a human gate on cap-reached; APPROVE routes back into the loop and
   * carries a resetVisitCounts action so the loop does not immediately
   * re-escalate. Also asserts the hardcoded gate actions (storeHumanPrompt,
   * clearError) still run alongside the user-declared action.
   */
  const gateResetDef: WorkflowDefinition = {
    name: 'gate-reset-test',
    description: 'Human gate APPROVE resets loop counters',
    initial: 'build',
    settings: { maxRounds: 99 },
    states: {
      build: {
        type: 'agent',
        description: 'Builds',
        persona: 'builder',
        prompt: 'Build.',
        inputs: [],
        outputs: ['build'],
        transitions: [{ to: 'validate' }],
      },
      validate: {
        type: 'agent',
        description: 'Validates',
        persona: 'validator',
        prompt: 'Validate.',
        inputs: ['build'],
        outputs: ['validate'],
        maxVisits: 2,
        transitions: [
          { to: 'done', when: { verdict: 'approved' } },
          { to: 'review_gate', guard: 'isStateVisitLimitReached' },
          { to: 'build', when: { verdict: 'rejected' } },
        ],
      },
      review_gate: {
        type: 'human_gate',
        description: 'Human review after cap',
        acceptedEvents: ['APPROVE', 'ABORT'],
        transitions: [
          {
            to: 'build',
            event: 'APPROVE',
            actions: [{ type: 'resetVisitCounts', stateIds: ['build', 'validate'] }],
          },
          { to: 'aborted', event: 'ABORT' },
        ],
      },
      done: { type: 'terminal', description: 'Done' },
      aborted: { type: 'terminal', description: 'Aborted' },
    },
  };

  it('clears named visit counts on HUMAN_APPROVE while preserving hardcoded gate actions', async () => {
    const { machine } = buildWorkflowMachine(gateResetDef, 'task');

    // A gate holds a promise we control so we can assert the context
    // immediately after the HUMAN_APPROVE transition fires — before the
    // next agent invocation runs and overwrites humanPrompt via
    // updateContextFromAgentResult.
    let resolveBuild: (v: ReturnType<typeof makeAgentResult>) => void = () => {};
    const buildGate = new Promise<ReturnType<typeof makeAgentResult>>((resolve) => {
      resolveBuild = resolve;
    });

    let buildCalls = 0;
    const testMachine = machine.provide({
      actors: {
        agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
          if (input.stateId === 'build') {
            buildCalls++;
            // First two build calls resolve normally (feed the loop into the
            // gate). The third (post-APPROVE) waits on the gate so the test
            // can assert the context right after the APPROVE transition.
            if (buildCalls < 3) return makeAgentResult();
            return buildGate;
          }
          if (input.stateId === 'validate') {
            // Always reject on the first pass to hit the cap; after the
            // reset, approve so the run ends cleanly.
            return buildCalls <= 2 ? makeRejectedResult() : makeAgentResult();
          }
          return makeAgentResult();
        }),
      },
    });

    const actor = createActor(testMachine);
    actor.start();
    await settle(200);

    expect(actor.getSnapshot().matches('review_gate')).toBe(true);
    expect(actor.getSnapshot().context.visitCounts['validate']).toBe(2);
    expect(actor.getSnapshot().context.visitCounts['build']).toBe(2);

    actor.send({ type: 'HUMAN_APPROVE', prompt: 'Reset and continue' });
    // Let the transition fire and the third `build` invocation start, but
    // it's now pending on `buildGate` — so updateContextFromAgentResult
    // hasn't fired yet and we can see the gate's action side-effects.
    await settle(50);

    const gateCtx = actor.getSnapshot().context;
    // Hardcoded gate action storeHumanPrompt still ran.
    expect(gateCtx.humanPrompt).toBe('Reset and continue');
    // Hardcoded clearError ran (observable as null).
    expect(gateCtx.lastError).toBeNull();
    // User-declared resetVisitCounts cleared the two named states BEFORE
    // the third build entry incremented build's counter.
    expect(gateCtx.visitCounts['validate']).toBe(0);
    // build was re-entered once on the post-reset pass.
    expect(gateCtx.visitCounts['build']).toBe(1);

    // Let the workflow finish.
    resolveBuild(makeAgentResult());
    await settle(200);

    expect(actor.getSnapshot().status).toBe('done');
    expect(String(actor.getSnapshot().value)).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Validation tests for the new fields
// ---------------------------------------------------------------------------

describe('validateDefinition: maxVisits and actions', () => {
  function validBase(): Record<string, unknown> {
    return {
      name: 'base',
      description: 'base',
      initial: 'a',
      states: {
        a: {
          type: 'agent',
          description: 'A',
          persona: 'a',
          prompt: 'A.',
          inputs: [],
          outputs: ['a'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
  }

  it('accepts positive integer maxVisits on agent state', () => {
    const def = validBase();
    (def.states as Record<string, Record<string, unknown>>).a.maxVisits = 3;
    expect(() => validateDefinition(def)).not.toThrow();
  });

  it('rejects zero or negative maxVisits', () => {
    const def = validBase();
    (def.states as Record<string, Record<string, unknown>>).a.maxVisits = 0;
    expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
    (def.states as Record<string, Record<string, unknown>>).a.maxVisits = -1;
    expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
  });

  it('rejects non-integer maxVisits', () => {
    const def = validBase();
    (def.states as Record<string, Record<string, unknown>>).a.maxVisits = 2.5;
    expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
  });

  it('accepts a valid actions array with resetVisitCounts', () => {
    const def = validBase();
    const states = def.states as Record<string, Record<string, unknown>>;
    (states.a.transitions as Array<Record<string, unknown>>)[0].actions = [
      { type: 'resetVisitCounts', stateIds: ['a'] },
    ];
    expect(() => validateDefinition(def)).not.toThrow();
  });

  it('rejects an unknown action type with a helpful error', () => {
    const def = validBase();
    const states = def.states as Record<string, Record<string, unknown>>;
    (states.a.transitions as Array<Record<string, unknown>>)[0].actions = [{ type: 'nukeWorld' }];
    try {
      validateDefinition(def);
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as WorkflowValidationError;
      // Zod's discriminated-union error names the offending type.
      expect(err.issues.join('\n')).toMatch(/type|discriminat|invalid/i);
    }
  });

  it('rejects resetVisitCounts with no stateIds', () => {
    const def = validBase();
    const states = def.states as Record<string, Record<string, unknown>>;
    (states.a.transitions as Array<Record<string, unknown>>)[0].actions = [{ type: 'resetVisitCounts', stateIds: [] }];
    expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
  });

  it('rejects resetVisitCounts referencing an unknown state', () => {
    const def = validBase();
    const states = def.states as Record<string, Record<string, unknown>>;
    (states.a.transitions as Array<Record<string, unknown>>)[0].actions = [
      { type: 'resetVisitCounts', stateIds: ['ghost'] },
    ];
    try {
      validateDefinition(def);
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as WorkflowValidationError;
      expect(err.issues).toEqual(expect.arrayContaining([expect.stringContaining('ghost')]));
      expect(err.issues).toEqual(expect.arrayContaining([expect.stringContaining('resetVisitCounts')]));
    }
  });

  it('accepts isStateVisitLimitReached as a registered guard', () => {
    const def = validBase();
    const states = def.states as Record<string, Record<string, unknown>>;
    states.a.maxVisits = 2;
    states.a.transitions = [{ to: 'done', guard: 'isStateVisitLimitReached' }, { to: 'done' }];
    expect(() => validateDefinition(def)).not.toThrow();
  });

  // ---- human gate transition actions ---------------------------------------

  function baseWithHumanGate(): Record<string, unknown> {
    return {
      name: 'gate-base',
      description: 'gate-base',
      initial: 'a',
      states: {
        a: {
          type: 'agent',
          description: 'A',
          persona: 'a',
          prompt: 'A.',
          inputs: [],
          outputs: ['a'],
          transitions: [{ to: 'gate' }],
        },
        gate: {
          type: 'human_gate',
          description: 'Gate',
          acceptedEvents: ['APPROVE'],
          transitions: [{ to: 'done', event: 'APPROVE' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
  }

  it('accepts actions on a human gate transition', () => {
    const def = baseWithHumanGate();
    const states = def.states as Record<string, Record<string, unknown>>;
    (states.gate.transitions as Array<Record<string, unknown>>)[0].actions = [
      { type: 'resetVisitCounts', stateIds: ['a'] },
    ];
    expect(() => validateDefinition(def)).not.toThrow();
  });

  it('rejects an unknown action type on a human gate transition', () => {
    const def = baseWithHumanGate();
    const states = def.states as Record<string, Record<string, unknown>>;
    (states.gate.transitions as Array<Record<string, unknown>>)[0].actions = [{ type: 'nukeWorld' }];
    try {
      validateDefinition(def);
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as WorkflowValidationError;
      // Zod's discriminated-union error names the offending type.
      expect(err.issues.join('\n')).toMatch(/type|discriminat|invalid/i);
    }
  });

  it('rejects resetVisitCounts referencing an unknown state on a human gate transition', () => {
    const def = baseWithHumanGate();
    const states = def.states as Record<string, Record<string, unknown>>;
    (states.gate.transitions as Array<Record<string, unknown>>)[0].actions = [
      { type: 'resetVisitCounts', stateIds: ['ghost'] },
    ];
    try {
      validateDefinition(def);
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as WorkflowValidationError;
      expect(err.issues).toEqual(expect.arrayContaining([expect.stringContaining('ghost')]));
      expect(err.issues).toEqual(expect.arrayContaining([expect.stringContaining('resetVisitCounts')]));
    }
  });

  // ---- Fix 1: maxVisits is rejected on non-agent states ---------------------

  it('rejects maxVisits on a terminal state with a message naming the state', () => {
    const def = validBase();
    const states = def.states as Record<string, Record<string, unknown>>;
    states.done.maxVisits = 3;
    try {
      validateDefinition(def);
      expect.fail('should have thrown');
    } catch (e) {
      const err = e as WorkflowValidationError;
      expect(err.issues.join('\n')).toMatch(/"done"/);
      expect(err.issues.join('\n')).toMatch(/maxVisits/);
      expect(err.issues.join('\n')).toMatch(/agent/);
    }
  });

  it('rejects maxVisits on a deterministic state', () => {
    const def = validBase();
    const states = def.states as Record<string, Record<string, unknown>>;
    states.det = {
      type: 'deterministic',
      description: 'Det',
      run: [['true']],
      transitions: [{ to: 'done' }],
      maxVisits: 2,
    };
    // Keep 'det' reachable so unrelated errors don't mask the one we care about.
    states.a.transitions = [{ to: 'det' }];
    expect(() => validateDefinition(def)).toThrow(/maxVisits/);
  });

  it('rejects maxVisits on a human_gate state', () => {
    const def = validBase();
    const states = def.states as Record<string, Record<string, unknown>>;
    states.gate = {
      type: 'human_gate',
      description: 'Gate',
      acceptedEvents: ['APPROVE'],
      transitions: [{ to: 'done', event: 'APPROVE' }],
      maxVisits: 5,
    };
    states.a.transitions = [{ to: 'gate' }];
    expect(() => validateDefinition(def)).toThrow(/maxVisits/);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: State IDs must be identifier-shaped
// ---------------------------------------------------------------------------

describe('validateDefinition: state ID character rules', () => {
  function defWithStateId(id: string): Record<string, unknown> {
    return {
      name: 'sid',
      description: 'sid',
      initial: id,
      states: {
        [id]: {
          type: 'agent',
          description: 'X',
          persona: 'x',
          prompt: 'x.',
          inputs: [],
          outputs: ['x'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
  }

  it.each([
    ['foo.bar', 'dot'],
    ['foo bar', 'space'],
    ['foo-bar', 'hyphen'],
    ['1foo', 'leading digit'],
    ['', 'empty'],
  ])('rejects state ID %p (%s) with a message naming the bad ID', (bad) => {
    const def = defWithStateId(bad);
    try {
      validateDefinition(def);
      expect.fail(`should have rejected state id "${bad}"`);
    } catch (e) {
      const err = e as WorkflowValidationError;
      expect(err.issues.join('\n')).toContain(`"${bad}"`);
    }
  });

  it.each([['foo'], ['foo_bar'], ['_private'], ['foo1'], ['foo_BAR_2']])(
    'accepts identifier-shaped state ID %p',
    (ok) => {
      const def = defWithStateId(ok);
      expect(() => validateDefinition(def)).not.toThrow();
    },
  );
});
