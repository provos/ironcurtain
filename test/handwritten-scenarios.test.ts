import { describe, it, expect } from 'vitest';
import { getHandwrittenScenarios } from '../src/pipeline/handwritten-scenarios.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_SANDBOX_DIR,
  TEST_PROTECTED_PATHS,
  TEST_DOMAIN_ALLOWLISTS,
} from './fixtures/test-policy.js';

const SANDBOX_DIR = TEST_SANDBOX_DIR;

describe('Handwritten Scenarios', () => {
  const scenarios = getHandwrittenScenarios(SANDBOX_DIR);

  it('returns the expected number of scenarios', () => {
    expect(scenarios.length).toBe(29);
  });

  it('all scenarios have source "handwritten"', () => {
    for (const s of scenarios) {
      expect(s.source).toBe('handwritten');
    }
  });

  it('all scenarios have required fields', () => {
    for (const s of scenarios) {
      expect(s.description).toBeTruthy();
      expect(s.request.serverName).toBeTruthy();
      expect(s.request.toolName).toBeTruthy();
      expect(s.request.arguments).toBeDefined();
      expect(['allow', 'deny', 'escalate']).toContain(s.expectedDecision);
      expect(s.reasoning).toBeTruthy();
    }
  });

  it('covers all expected decision types', () => {
    const decisions = new Set(scenarios.map((s) => s.expectedDecision));
    expect(decisions).toContain('allow');
    expect(decisions).toContain('deny');
    expect(decisions).toContain('escalate');
  });

  describe('scenarios produce correct decisions when run against PolicyEngine', () => {
    const engine = new PolicyEngine(
      testCompiledPolicy,
      testToolAnnotations,
      TEST_PROTECTED_PATHS,
      SANDBOX_DIR,
      TEST_DOMAIN_ALLOWLISTS,
    );

    for (const scenario of scenarios) {
      it(`${scenario.description} -> ${scenario.expectedDecision}`, () => {
        const result = engine.evaluate({
          requestId: 'test',
          serverName: scenario.request.serverName,
          toolName: scenario.request.toolName,
          arguments: scenario.request.arguments,
          timestamp: new Date().toISOString(),
        });
        expect(result.decision).toBe(scenario.expectedDecision);
      });
    }
  });
});
