import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  validateDefinition,
  validateWorkflowSkillReferences,
  WorkflowValidationError,
} from '../../src/workflow/validate.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validDefinition(): Record<string, unknown> {
  return {
    name: 'test-workflow',
    description: 'A test workflow',
    initial: 'plan',
    settings: { mode: 'builtin', maxRounds: 4 },
    states: {
      plan: {
        type: 'agent',
        description: 'Creates a plan',
        persona: 'planner',
        prompt: 'You are a planner. Create a plan.',
        inputs: [],
        outputs: ['plan'],
        transitions: [{ to: 'review' }],
      },
      review: {
        type: 'agent',
        description: 'Reviews the plan',
        persona: 'reviewer',
        prompt: 'You are a reviewer. Review the plan.',
        inputs: ['plan'],
        outputs: ['review'],
        transitions: [
          { to: 'gate', when: { verdict: 'approved' } },
          { to: 'plan', when: { verdict: 'rejected' } },
        ],
      },
      gate: {
        type: 'human_gate',
        description: 'Human review gate',
        acceptedEvents: ['APPROVE', 'ABORT'],
        present: ['review'],
        transitions: [
          { to: 'done', event: 'APPROVE' },
          { to: 'aborted', event: 'ABORT' },
        ],
      },
      done: {
        type: 'terminal',
        description: 'Workflow complete',
        outputs: ['review'],
      },
      aborted: {
        type: 'terminal',
        description: 'Workflow aborted',
      },
    },
  };
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateDefinition', () => {
  describe('valid definitions', () => {
    it('accepts a valid multi-state workflow', () => {
      const def = validateDefinition(validDefinition());
      expect(def.name).toBe('test-workflow');
      expect(Object.keys(def.states)).toHaveLength(5);
    });

    it('accepts a minimal two-state workflow', () => {
      const minimal = {
        name: 'minimal',
        description: 'Minimal workflow',
        initial: 'start',
        states: {
          start: {
            type: 'agent',
            description: 'Does work',
            persona: 'worker',
            prompt: 'You are a worker.',
            inputs: [],
            outputs: ['result'],
            transitions: [{ to: 'done' }],
          },
          done: {
            type: 'terminal',
            description: 'Done',
          },
        },
      };
      const def = validateDefinition(minimal);
      expect(def.initial).toBe('start');
    });

    it('accepts optional artifact inputs (trailing ?)', () => {
      const def = deepClone(validDefinition());
      (def.states as Record<string, Record<string, unknown>>).review.inputs = ['plan', 'feedback?'];
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('accepts a workflow with deterministic states', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;

      // Insert a deterministic state between review and gate
      states.review.transitions = [
        { to: 'test', when: { verdict: 'approved' } },
        { to: 'plan', when: { verdict: 'rejected' } },
      ];
      states.test = {
        type: 'deterministic',
        description: 'Runs tests',
        run: [['npm', 'test']],
        transitions: [{ to: 'gate', guard: 'isPassed' }, { to: 'plan' }],
      };

      expect(() => validateDefinition(def)).not.toThrow();
    });
  });

  describe('structural validation (Zod)', () => {
    it('rejects empty input', () => {
      expect(() => validateDefinition({})).toThrow(WorkflowValidationError);
    });

    it('rejects missing required fields', () => {
      expect(() => validateDefinition({ name: 'test' })).toThrow(WorkflowValidationError);
    });

    it('rejects invalid state type', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.plan.type = 'invalid';
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
    });

    it('rejects invalid settings values', () => {
      const def = deepClone(validDefinition());
      def.settings = { maxRounds: -1 };
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
    });

    it('rejects agent state with empty transitions array', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.plan.transitions = [];
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
    });
  });

  describe('semantic validation', () => {
    it('rejects definition with missing initial state', () => {
      const def = deepClone(validDefinition());
      def.initial = 'nonexistent';
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (e) {
        expect((e as WorkflowValidationError).issues).toEqual(
          expect.arrayContaining([expect.stringContaining('nonexistent')]),
        );
      }
    });

    it('rejects definition with no terminal state', () => {
      const def = {
        name: 'no-terminal',
        description: 'Missing terminal',
        initial: 'start',
        states: {
          start: {
            type: 'agent',
            description: 'Does work',
            persona: 'worker',
            prompt: 'You are a worker.',
            inputs: [],
            outputs: [],
            transitions: [{ to: 'start' }],
          },
        },
      };
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (e) {
        expect((e as WorkflowValidationError).issues).toEqual(
          expect.arrayContaining([expect.stringContaining('terminal')]),
        );
      }
    });

    it('rejects unregistered guard name', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      (states.review.transitions as Array<Record<string, unknown>>)[0].guard = 'doesNotExist';
      expect(() => validateDefinition(def)).toThrow(/guard/);
    });

    it('rejects transition to unknown state', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      (states.plan.transitions as Array<Record<string, unknown>>)[0].to = 'nowhere';
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (e) {
        expect((e as WorkflowValidationError).issues).toEqual(
          expect.arrayContaining([expect.stringContaining('nowhere')]),
        );
      }
    });

    it('rejects unreachable states', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.orphan = {
        type: 'agent',
        description: 'Orphan state',
        persona: 'orphan',
        prompt: 'You are orphaned.',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'done' }],
      };
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (e) {
        expect((e as WorkflowValidationError).issues).toEqual(
          expect.arrayContaining([expect.stringContaining('orphan')]),
        );
      }
    });

    it('rejects missing required artifact input', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.inputs = ['nonexistent_artifact'];
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (e) {
        expect((e as WorkflowValidationError).issues).toEqual(
          expect.arrayContaining([expect.stringContaining('nonexistent_artifact')]),
        );
      }
    });

    it('rejects human gate with no transitions', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.gate.transitions = [];
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
    });

    it('rejects gate transition event not in acceptedEvents', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.gate.transitions = [
        { to: 'done', event: 'APPROVE' },
        { to: 'plan', event: 'REPLAN' }, // REPLAN not in acceptedEvents
      ];
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (e) {
        expect((e as WorkflowValidationError).issues).toEqual(
          expect.arrayContaining([expect.stringContaining('REPLAN')]),
        );
      }
    });

    it('collects multiple issues in a single error', () => {
      const def = deepClone(validDefinition());
      def.initial = 'nonexistent';
      const states = def.states as Record<string, Record<string, unknown>>;
      (states.review.transitions as Array<Record<string, unknown>>)[0].guard = 'badGuard';
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('when clause validation', () => {
    it('accepts when with valid verdict on agent transition', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [
        { to: 'gate', when: { verdict: 'approved' } },
        { to: 'plan', when: { verdict: 'rejected' } },
      ];
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('rejects multi-field when clause with non-verdict key', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { verdict: 'approved', confidence: 'high' } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringContaining('only "verdict" is currently supported for when-clause routing'),
          ]),
        );
        expect(err.issues).toEqual(expect.arrayContaining([expect.stringContaining('"confidence"')]));
      }
    });

    it('rejects when + guard on same transition', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [
        { to: 'gate', guard: 'isRoundLimitReached', when: { verdict: 'approved' } },
        { to: 'plan' },
      ];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(expect.arrayContaining([expect.stringContaining('mutually exclusive')]));
      }
    });

    it('rejects when on deterministic state', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      // Replace review with a deterministic state that uses when
      states.review.transitions = [{ to: 'test' }];
      states.test = {
        type: 'deterministic',
        description: 'Runs tests',
        run: [['npm', 'test']],
        transitions: [{ to: 'gate', when: { verdict: 'approved' } }, { to: 'plan' }],
      };
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(expect.arrayContaining([expect.stringContaining('deterministic')]));
      }
    });

    it('rejects when with unknown key', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { mood: 'happy' } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(expect.arrayContaining([expect.stringContaining('not a valid AgentOutput field')]));
      }
    });

    it('accepts custom verdict values (free-form string)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { verdict: 'thesis_validate' } }, { to: 'plan' }];
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('rejects invalid confidence value (and non-verdict key)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { confidence: 'very_high' } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringContaining('"confidence" — only "verdict" is currently supported'),
            expect.stringContaining('invalid confidence value'),
          ]),
        );
      }
    });

    it('rejects non-verdict AgentOutput fields in when clause', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      // All non-verdict AgentOutput fields should be rejected
      for (const [key, value] of [
        ['completed', true],
        ['testCount', 42],
        ['escalation', null],
      ] as const) {
        states.review.transitions = [{ to: 'gate', when: { [key]: value } }, { to: 'plan' }];
        try {
          validateDefinition(def);
          expect.fail(`should have thrown for key "${key}"`);
        } catch (e) {
          const err = e as WorkflowValidationError;
          expect(err.issues).toEqual(
            expect.arrayContaining([expect.stringContaining(`"${key}" — only "verdict" is currently supported`)]),
          );
        }
      }
    });

    it('collects multiple when issues in one error', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [
        { to: 'gate', when: { mood: 'happy' } },
        { to: 'plan', when: { confidence: 'super_high' } },
      ];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues.length).toBeGreaterThanOrEqual(3);
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringContaining('not a valid AgentOutput field'),
            expect.stringContaining('"confidence" — only "verdict" is currently supported'),
            expect.stringContaining('invalid confidence value'),
          ]),
        );
      }
    });

    it('rejects empty when clause', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: {} }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(expect.arrayContaining([expect.stringContaining('empty "when"')]));
      }
    });

    it('rejects when with wrong type for completed (string instead of boolean)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { completed: 'true' } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringContaining('"completed" — only "verdict" is currently supported'),
            expect.stringMatching(/'when' key 'completed' with wrong type: expected boolean, got string/),
          ]),
        );
      }
    });

    it('rejects when with wrong type for completed (number instead of boolean)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { completed: 1 } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringContaining('"completed" — only "verdict" is currently supported'),
            expect.stringMatching(/'when' key 'completed' with wrong type: expected boolean, got number/),
          ]),
        );
      }
    });

    it('rejects when with wrong type for verdict (number instead of string)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { verdict: 1 } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/'when' key 'verdict' with wrong type: expected string, got number/),
          ]),
        );
        // Type check runs first -- verdict accepts any string but a number
        // is still the wrong type.
        expect(err.issues.every((issue) => issue.includes('wrong type'))).toBe(true);
      }
    });

    it('rejects when with wrong type for testCount (string instead of number)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { testCount: 'five' } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([
            expect.stringContaining('"testCount" — only "verdict" is currently supported'),
            expect.stringMatching(/'when' key 'testCount' with wrong type: expected number or null, got string/),
          ]),
        );
      }
    });

    it('rejects when with numeric testCount (non-verdict key)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { testCount: 5 } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([expect.stringContaining('"testCount" — only "verdict" is currently supported')]),
        );
      }
    });

    it('rejects when with null testCount (non-verdict key)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { testCount: null } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([expect.stringContaining('"testCount" — only "verdict" is currently supported')]),
        );
      }
    });

    it('rejects when with string escalation (non-verdict key)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { escalation: 'blocked_on_dependency' } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([expect.stringContaining('"escalation" — only "verdict" is currently supported')]),
        );
      }
    });

    it('rejects when with null escalation (non-verdict key)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { escalation: null } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([expect.stringContaining('"escalation" — only "verdict" is currently supported')]),
        );
      }
    });

    it('rejects when with string notes (non-verdict key)', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.review.transitions = [{ to: 'gate', when: { notes: 'some note' } }, { to: 'plan' }];
      try {
        validateDefinition(def);
        expect.fail('should have thrown');
      } catch (e) {
        const err = e as WorkflowValidationError;
        expect(err.issues).toEqual(
          expect.arrayContaining([expect.stringContaining('"notes" — only "verdict" is currently supported')]),
        );
      }
    });

    it('accepts freshSession: true on agent state', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.plan.freshSession = true;
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('accepts freshSession: false on agent state', () => {
      const def = deepClone(validDefinition());
      const states = def.states as Record<string, Record<string, unknown>>;
      states.plan.freshSession = false;
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('accepts custom verdicts for direct routing in when clauses', () => {
      const def = {
        name: 'custom-verdict-workflow',
        description: 'Workflow with custom verdict routing',
        initial: 'orchestrator',
        states: {
          orchestrator: {
            type: 'agent',
            description: 'Routes to different states via custom verdicts',
            persona: 'router',
            prompt: 'You are a router.',
            inputs: [],
            outputs: ['journal'],
            transitions: [
              { to: 'analyze', when: { verdict: 'reanalyze' } },
              { to: 'validate', when: { verdict: 'thesis_validate' } },
              { to: 'escalate', when: { verdict: 'escalate' } },
              { to: 'done', guard: 'isRoundLimitReached' },
            ],
          },
          analyze: {
            type: 'agent',
            description: 'Analyzes',
            persona: 'analyst',
            prompt: 'Analyze.',
            inputs: ['journal'],
            outputs: ['analysis'],
            transitions: [{ to: 'orchestrator' }],
          },
          validate: {
            type: 'agent',
            description: 'Validates',
            persona: 'validator',
            prompt: 'Validate.',
            inputs: ['journal'],
            outputs: ['results'],
            transitions: [{ to: 'orchestrator' }],
          },
          escalate: {
            type: 'human_gate',
            description: 'Human escalation',
            acceptedEvents: ['APPROVE', 'ABORT'],
            transitions: [
              { to: 'orchestrator', event: 'APPROVE' },
              { to: 'done', event: 'ABORT' },
            ],
          },
          done: {
            type: 'terminal',
            description: 'Done',
            outputs: ['journal'],
          },
        },
      };
      expect(() => validateDefinition(def)).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // containerScope validation
  // ---------------------------------------------------------------------------

  describe('containerScope', () => {
    function sharedContainerDef(overrides: {
      stateContainerScopes?: Partial<Record<string, string>>;
      personas?: Partial<Record<string, string>>;
    }): Record<string, unknown> {
      const { stateContainerScopes = {}, personas = {} } = overrides;
      return {
        name: 'scoped',
        description: 'Scoped workflow',
        initial: 'plan',
        settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
        states: {
          plan: {
            type: 'agent',
            description: 'Plan',
            persona: personas.plan ?? 'global',
            prompt: 'Plan.',
            inputs: [],
            outputs: ['plan'],
            transitions: [{ to: 'review' }],
            ...(stateContainerScopes.plan !== undefined ? { containerScope: stateContainerScopes.plan } : {}),
          },
          review: {
            type: 'agent',
            description: 'Review',
            persona: personas.review ?? 'global',
            prompt: 'Review.',
            inputs: ['plan'],
            outputs: ['review'],
            transitions: [{ to: 'done' }],
            ...(stateContainerScopes.review !== undefined ? { containerScope: stateContainerScopes.review } : {}),
          },
          done: { type: 'terminal', description: 'Done' },
        },
      };
    }

    it('rejects containerScope when sharedContainer is not true', () => {
      const def = sharedContainerDef({ stateContainerScopes: { plan: 'env-a' } });
      // Override settings to remove sharedContainer.
      (def.settings as Record<string, unknown>) = { mode: 'docker', dockerAgent: 'claude-code' };
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
      try {
        validateDefinition(def);
      } catch (err) {
        if (!(err instanceof WorkflowValidationError)) throw err;
        expect(err.issues.some((i) => /containerScope.*sharedContainer/.test(i))).toBe(true);
      }
    });

    it('rejects containerScope values that violate the charset', () => {
      const def = sharedContainerDef({ stateContainerScopes: { plan: 'env a' } });
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
    });

    it('accepts legacy workflows (no containerScope, sharedContainer: true) with homogeneous persona', () => {
      const def = sharedContainerDef({});
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('accepts two states with different personas on the same scope', () => {
      // Scope governs container lifecycle; persona governs the active
      // policy. cyclePolicy hot-swaps the policy at each state entry,
      // so mixing personas on one bundle is fine.
      const def = sharedContainerDef({
        personas: { plan: 'global', review: 'reviewer' },
      });
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('accepts distinct scopes with different personas', () => {
      const def = sharedContainerDef({
        stateContainerScopes: { review: 'reviewer-scope' },
        personas: { plan: 'global', review: 'reviewer' },
      });
      expect(() => validateDefinition(def)).not.toThrow();
    });

    it('rejects containerScope on non-agent states via the raw-input check', () => {
      // The raw-input validator catches `containerScope` on non-agent
      // states (same mechanism as `maxVisits`) and throws before Zod
      // would silently strip the field.
      const def = {
        name: 'non-agent-scope',
        description: 'Bad scope placement',
        initial: 'plan',
        settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
        states: {
          plan: {
            type: 'agent',
            description: 'Plan',
            persona: 'global',
            prompt: 'Plan.',
            inputs: [],
            outputs: ['plan'],
            transitions: [{ to: 'done' }],
          },
          done: {
            type: 'terminal',
            description: 'Done',
            containerScope: 'not-allowed-here',
          },
        },
      };
      expect(() => validateDefinition(def)).toThrow(WorkflowValidationError);
    });
  });
});

// ---------------------------------------------------------------------------
// validateWorkflowSkillReferences — name shape + manifest existence
// ---------------------------------------------------------------------------

describe('validateWorkflowSkillReferences', () => {
  let packageDir: string;

  beforeEach(() => {
    packageDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-skill-refs-test-'));
  });

  afterEach(() => {
    rmSync(packageDir, { recursive: true, force: true });
  });

  /**
   * Builds a minimal workflow whose `plan` agent state references the
   * given list of skills. The workflow itself is structurally valid;
   * tests vary only the `skills:` slot.
   */
  function workflowWithSkills(skills: readonly string[]) {
    return validateDefinition({
      name: 'skills-test',
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

  /** Writes a SKILL.md sidecar so existsSync returns true for `<pkg>/skills/<name>/SKILL.md`. */
  function writeSkillManifest(name: string): void {
    const dir = resolve(packageDir, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\nbody\n`);
  }

  it('passes when every skill name is valid and has a manifest', () => {
    writeSkillManifest('fetcher');
    writeSkillManifest('parser');
    const def = workflowWithSkills(['fetcher', 'parser']);
    expect(() => validateWorkflowSkillReferences(def, packageDir)).not.toThrow();
  });

  it('rejects an empty-string skill name', () => {
    const def = workflowWithSkills(['']);
    expect(() => validateWorkflowSkillReferences(def, packageDir)).toThrow(WorkflowValidationError);
    try {
      validateWorkflowSkillReferences(def, packageDir);
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/invalid skill name/i);
      expect(issues[0]).toMatch(/empty/);
    }
  });

  it('rejects a skill name with a forward slash', () => {
    const def = workflowWithSkills(['foo/bar']);
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/path separator/);
    }
  });

  it('rejects a parent-traversal skill name', () => {
    const def = workflowWithSkills(['../escaped']);
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      // `../escaped` contains `/`, which trips the separator check
      // before traversal detection — both rejections are valid.
      expect(issues[0]).toMatch(/path separator|valid directory name/);
    }
  });

  it('rejects "."', () => {
    const def = workflowWithSkills(['.']);
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      expect(issues[0]).toMatch(/valid directory name/);
    }
  });

  it('rejects ".."', () => {
    const def = workflowWithSkills(['..']);
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      expect(issues[0]).toMatch(/valid directory name/);
    }
  });

  it('reports shape errors and missing manifests in one batch', () => {
    // Three problems, one call: authors should see all of them rather than
    // chasing them one at a time.
    const def = workflowWithSkills(['', 'foo/bar', 'absent']);
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      expect(issues).toHaveLength(3);
      expect(issues[0]).toMatch(/empty/);
      expect(issues[1]).toMatch(/path separator/);
      expect(issues[2]).toMatch(/no skill with that frontmatter name was found/);
    }
  });

  it('skips the discovery check when the shape check fails', () => {
    // `..` would normally trigger filesystem probing — but we should
    // report the shape error and skip the discovery branch entirely.
    const def = workflowWithSkills(['..']);
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      expect(issues).toHaveLength(1);
      expect(issues[0]).not.toMatch(/no skill with that frontmatter name was found/);
    }
  });

  it('reports missing skill with the skills-root path the resolver scans', () => {
    const def = workflowWithSkills(['absent']);
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      const issues = (err as WorkflowValidationError).issues;
      expect(issues[0]).toContain(resolve(packageDir, 'skills'));
    }
  });

  it('matches on frontmatter `name:`, not directory name', () => {
    // The dir is `dir-name/`, but the SKILL.md frontmatter says
    // `name: frontmatter-name`. The resolver matches on frontmatter
    // name (see `workflowSkillFilter` in src/skills/discovery.ts), so
    // the validator must agree: `frontmatter-name` passes,
    // `dir-name` does not.
    const dir = resolve(packageDir, 'skills', 'dir-name');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'SKILL.md'), '---\nname: frontmatter-name\ndescription: x\n---\nbody\n');

    const passing = workflowWithSkills(['frontmatter-name']);
    expect(() => validateWorkflowSkillReferences(passing, packageDir)).not.toThrow();

    const failing = workflowWithSkills(['dir-name']);
    try {
      validateWorkflowSkillReferences(failing, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowValidationError);
      const issues = (err as WorkflowValidationError).issues;
      expect(issues[0]).toMatch(/no skill with that frontmatter name was found/);
      // The available list should surface the real (frontmatter) name so
      // an author hunting a typo gets pointed at the right identifier.
      expect(issues[0]).toContain('frontmatter-name');
    }
  });

  it('lists available frontmatter names in the error to help typo recovery', () => {
    writeSkillManifest('fetcher');
    writeSkillManifest('parser');
    const def = workflowWithSkills(['fetchr']); // typo
    try {
      validateWorkflowSkillReferences(def, packageDir);
      throw new Error('expected throw');
    } catch (err) {
      const issues = (err as WorkflowValidationError).issues;
      expect(issues[0]).toContain('Available: fetcher, parser');
    }
  });
});
