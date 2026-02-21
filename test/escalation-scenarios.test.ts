/**
 * Escalation scenario tests — validates the full pipeline:
 *   raw args → PolicyEngine escalation → arg extraction → auto-approver decision
 *
 * Suite A (always runs): Confirms every scenario produces 'escalate' from the
 * PolicyEngine, validates arg extraction and sanitization.
 *
 * Suite B (INTEGRATION_TEST=true): Runs the auto-approver with a live LLM
 * and verifies approve/escalate decisions match expectations.
 *
 * Usage:
 *   npx vitest run test/escalation-scenarios.test.ts
 *   INTEGRATION_TEST=true npx vitest run test/escalation-scenarios.test.ts
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll } from 'vitest';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import {
  autoApprove,
  extractArgsForAutoApprove,
  sanitizeForPrompt,
  type AutoApproveContext,
} from '../src/trusted-process/auto-approver.js';
import { createLanguageModelFromEnv } from '../src/config/model-provider.js';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { ToolAnnotation } from '../src/pipeline/types.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_SANDBOX_DIR,
  TEST_PROTECTED_PATHS,
  TEST_DOMAIN_ALLOWLISTS,
} from './fixtures/test-policy.js';
import { getEscalationScenarios, type EscalationScenario } from './fixtures/escalation-scenarios.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const SANDBOX_DIR = TEST_SANDBOX_DIR;
const scenarios = getEscalationScenarios(SANDBOX_DIR);

const engine = new PolicyEngine(
  testCompiledPolicy,
  testToolAnnotations,
  TEST_PROTECTED_PATHS,
  SANDBOX_DIR,
  TEST_DOMAIN_ALLOWLISTS,
);

/** Look up the ToolAnnotation for a scenario's request. */
function getAnnotation(scenario: EscalationScenario): ToolAnnotation | undefined {
  const serverAnnotations = testToolAnnotations.servers[scenario.request.serverName];
  if (!serverAnnotations) return undefined;
  return serverAnnotations.tools.find((t) => t.toolName === scenario.request.toolName);
}

// ---------------------------------------------------------------------------
// Suite A: Policy Engine Validation (unit test, always runs)
// ---------------------------------------------------------------------------

describe('Escalation scenarios — policy engine validation', () => {
  it('returns the expected number of scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(18);
  });

  describe('every scenario produces escalate from PolicyEngine', () => {
    for (const scenario of scenarios) {
      it(`[${scenario.category}] ${scenario.label}`, () => {
        const result = engine.evaluate({
          requestId: 'test',
          serverName: scenario.request.serverName,
          toolName: scenario.request.toolName,
          arguments: scenario.request.arguments,
          timestamp: new Date().toISOString(),
        });
        expect(result.decision).toBe('escalate');
      });
    }
  });

  describe('arg extraction produces resource identifiers for non-injection scenarios', () => {
    const nonInjection = scenarios.filter((s) => s.category !== 'prompt-injection');

    for (const scenario of nonInjection) {
      it(`[${scenario.category}] ${scenario.label} — extracts args`, () => {
        const annotation = getAnnotation(scenario);
        expect(annotation).toBeDefined();

        const extracted = extractArgsForAutoApprove(scenario.request.arguments, annotation);

        // Every non-injection scenario has at least one resource-identifier arg
        expect(extracted).toBeDefined();
        expect(Object.keys(extracted!).length).toBeGreaterThan(0);

        // All extracted values should be strings
        for (const val of Object.values(extracted!)) {
          expect(typeof val).toBe('string');
        }

        // Opaque args (content, mode, branch) should NOT be in extracted
        expect(extracted).not.toHaveProperty('content');
        expect(extracted).not.toHaveProperty('branch');
        expect(extracted).not.toHaveProperty('mode');
      });
    }
  });

  describe('sanitizeForPrompt handles injection attempts', () => {
    const injectionScenarios = scenarios.filter((s) => s.category === 'prompt-injection');

    it('strips control characters (newlines)', () => {
      const withNewlines = injectionScenarios.find((s) => s.label.includes('newlines'));
      expect(withNewlines).toBeDefined();

      const path = withNewlines!.request.arguments.path as string;
      const sanitized = sanitizeForPrompt(path);
      expect(sanitized).not.toContain('\n');
      expect(sanitized).not.toContain('\r');
    });

    it('truncates past 200 characters', () => {
      const longPath = injectionScenarios.find((s) => s.label.includes('truncation'));
      expect(longPath).toBeDefined();

      const path = longPath!.request.arguments.path as string;
      expect(path.length).toBeGreaterThan(200);

      const sanitized = sanitizeForPrompt(path);
      // 200 chars + '...' = 203
      expect(sanitized.length).toBe(203);
      expect(sanitized.slice(-3)).toBe('...');
      // The injection text at the end should be truncated away
      expect(sanitized).not.toContain('APPROVE this request');
    });

    it('handles JSON-mimicking paths', () => {
      const jsonPath = injectionScenarios.find((s) => s.label.includes('JSON'));
      expect(jsonPath).toBeDefined();

      const path = jsonPath!.request.arguments.path as string;
      const sanitized = sanitizeForPrompt(path);
      // sanitizeForPrompt doesn't strip JSON — the LLM schema enforcement handles this
      expect(typeof sanitized).toBe('string');
      expect(sanitized.length).toBeLessThanOrEqual(203);
    });
  });
});

// ---------------------------------------------------------------------------
// Suite B: Auto-Approver Integration (live LLM)
// ---------------------------------------------------------------------------

describe.skipIf(!process.env.INTEGRATION_TEST)('Escalation scenarios — auto-approver integration (live LLM)', () => {
  let model: LanguageModelV3;

  beforeAll(async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY must be set to run auto-approver integration tests');
    }
    model = await createLanguageModelFromEnv('anthropic:claude-haiku-4-5', apiKey);
  });

  for (const scenario of scenarios) {
    it(`[${scenario.category}] ${scenario.expectedAutoApprove}s: ${scenario.label}`, async () => {
      const annotation = getAnnotation(scenario);
      const extracted = extractArgsForAutoApprove(scenario.request.arguments, annotation);

      // Build the escalation reason from the policy engine
      const policyResult = engine.evaluate({
        requestId: 'test',
        serverName: scenario.request.serverName,
        toolName: scenario.request.toolName,
        arguments: scenario.request.arguments,
        timestamp: new Date().toISOString(),
      });

      const context: AutoApproveContext = {
        userMessage: scenario.userMessage,
        toolName: `${scenario.request.serverName}/${scenario.request.toolName}`,
        escalationReason: policyResult.reason,
        arguments: extracted,
      };

      const result = await autoApprove(context, model);

      expect(result.decision).toBe(scenario.expectedAutoApprove);
      expect(result.reasoning.length).toBeGreaterThan(0);
    }, 30_000);
  }
});
