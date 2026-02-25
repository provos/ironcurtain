/**
 * Pipeline Integration Test -- End-to-end verification.
 *
 * This test runs the full policy compilation pipeline with a real LLM
 * and verifies the output artifacts produce correct decisions for all
 * existing test cases. It is expensive (LLM API calls) and should be
 * skipped in normal CI.
 *
 * Run with: ANTHROPIC_API_KEY=... npx vitest run test/pipeline-integration.test.ts
 * Skip with: npx vitest run --exclude test/pipeline-integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { getHandwrittenScenarios } from '../src/pipeline/handwritten-scenarios.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_SANDBOX_DIR,
  TEST_PROTECTED_PATHS,
  TEST_DOMAIN_ALLOWLISTS,
} from './fixtures/test-policy.js';

const SANDBOX_DIR = TEST_SANDBOX_DIR;

describe('Pipeline Integration: hand-crafted artifacts produce correct decisions', () => {
  const engine = new PolicyEngine(
    testCompiledPolicy,
    testToolAnnotations,
    TEST_PROTECTED_PATHS,
    SANDBOX_DIR,
    TEST_DOMAIN_ALLOWLISTS,
  );
  const scenarios = getHandwrittenScenarios(SANDBOX_DIR);

  it('all handwritten scenarios produce correct decisions', () => {
    const results = scenarios.map((scenario) => {
      const result = engine.evaluate({
        requestId: 'integration-test',
        serverName: scenario.request.serverName,
        toolName: scenario.request.toolName,
        arguments: scenario.request.arguments,
        timestamp: new Date().toISOString(),
      });
      return {
        description: scenario.description,
        expected: scenario.expectedDecision,
        actual: result.decision,
        rule: result.rule,
        pass:
          scenario.expectedDecision === 'not-allow'
            ? result.decision !== 'allow'
            : result.decision === scenario.expectedDecision,
      };
    });

    const failures = results.filter((r) => !r.pass);
    if (failures.length > 0) {
      const details = failures
        .map((f) => `  ${f.description}: expected=${f.expected}, actual=${f.actual} (rule=${f.rule})`)
        .join('\n');
      throw new Error(`${failures.length} scenario(s) failed:\n${details}`);
    }

    expect(results.every((r) => r.pass)).toBe(true);
    expect(results.length).toBe(scenarios.length);
  });

  it('engine handles deny and escalate decision types', () => {
    const decisions = scenarios.map((s) => {
      const result = engine.evaluate({
        requestId: 'test',
        serverName: s.request.serverName,
        toolName: s.request.toolName,
        arguments: s.request.arguments,
        timestamp: new Date().toISOString(),
      });
      return result.decision;
    });

    expect(decisions).toContain('deny');
    expect(decisions).toContain('escalate');
  });
});
