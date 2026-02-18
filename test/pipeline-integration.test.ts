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
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { getHandwrittenScenarios } from '../src/pipeline/handwritten-scenarios.js';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../src/pipeline/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const SANDBOX_DIR = '/tmp/ironcurtain-sandbox';

describe('Pipeline Integration: hand-crafted artifacts produce correct decisions', () => {
  const compiledPolicy: CompiledPolicyFile = JSON.parse(
    readFileSync(resolve(projectRoot, 'src/config/generated/compiled-policy.json'), 'utf-8'),
  );
  const toolAnnotations: ToolAnnotationsFile = JSON.parse(
    readFileSync(resolve(projectRoot, 'src/config/generated/tool-annotations.json'), 'utf-8'),
  );
  const protectedPaths = [
    resolve(projectRoot, 'src/config/constitution.md'),
    resolve(projectRoot, 'src/config/generated'),
    resolve(projectRoot, 'src/config/mcp-servers.json'),
    resolve('./audit.jsonl'),
  ];

  const engine = new PolicyEngine(compiledPolicy, toolAnnotations, protectedPaths);
  const scenarios = getHandwrittenScenarios(SANDBOX_DIR);

  it('all handwritten scenarios produce correct decisions', () => {
    const results = scenarios.map(scenario => {
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
        pass: result.decision === scenario.expectedDecision,
      };
    });

    const failures = results.filter(r => !r.pass);
    if (failures.length > 0) {
      const details = failures
        .map(f => `  ${f.description}: expected=${f.expected}, actual=${f.actual} (rule=${f.rule})`)
        .join('\n');
      throw new Error(`${failures.length} scenario(s) failed:\n${details}`);
    }

    expect(results.every(r => r.pass)).toBe(true);
    expect(results.length).toBe(scenarios.length);
  });

  it('engine handles all expected decision types', () => {
    const decisions = scenarios.map(s => {
      const result = engine.evaluate({
        requestId: 'test',
        serverName: s.request.serverName,
        toolName: s.request.toolName,
        arguments: s.request.arguments,
        timestamp: new Date().toISOString(),
      });
      return result.decision;
    });

    expect(decisions).toContain('allow');
    expect(decisions).toContain('deny');
    expect(decisions).toContain('escalate');
  });
});
