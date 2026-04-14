import { describe, it, expect } from 'vitest';
import { validateDefinition, WorkflowValidationError } from '../../src/workflow/validate.js';

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
});
