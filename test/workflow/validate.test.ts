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
        persona: 'planner',
        inputs: [],
        outputs: ['plan'],
        transitions: [{ to: 'review' }],
      },
      review: {
        type: 'agent',
        persona: 'reviewer',
        inputs: ['plan'],
        outputs: ['review'],
        transitions: [
          { to: 'gate', guard: 'isApproved' },
          { to: 'plan', guard: 'isRejected' },
        ],
      },
      gate: {
        type: 'human_gate',
        acceptedEvents: ['APPROVE', 'ABORT'],
        present: ['review'],
        transitions: [
          { to: 'done', event: 'APPROVE' },
          { to: 'aborted', event: 'ABORT' },
        ],
      },
      done: {
        type: 'terminal',
        outputs: ['review'],
      },
      aborted: {
        type: 'terminal',
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
            persona: 'worker',
            inputs: [],
            outputs: ['result'],
            transitions: [{ to: 'done' }],
          },
          done: {
            type: 'terminal',
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
        { to: 'test', guard: 'isApproved' },
        { to: 'plan', guard: 'isRejected' },
      ];
      states.test = {
        type: 'deterministic',
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
            persona: 'worker',
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
        persona: 'orphan',
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
});
