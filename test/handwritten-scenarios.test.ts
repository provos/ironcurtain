import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHandwrittenScenarios } from '../src/pipeline/handwritten-scenarios.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import { testCompiledPolicy, testToolAnnotations } from './fixtures/test-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const SANDBOX_DIR = '/tmp/ironcurtain-sandbox';

describe('Handwritten Scenarios', () => {
  const scenarios = getHandwrittenScenarios(SANDBOX_DIR);

  it('returns the expected number of scenarios', () => {
    expect(scenarios.length).toBe(15);
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
    const decisions = new Set(scenarios.map(s => s.expectedDecision));
    expect(decisions).toContain('allow');
    expect(decisions).toContain('deny');
    expect(decisions).toContain('escalate');
  });

  describe('scenarios produce correct decisions when run against PolicyEngine', () => {
    const protectedPaths = [
      resolve(projectRoot, 'src/config/constitution.md'),
      resolve(projectRoot, 'src/config/generated'),
      resolve(projectRoot, 'src/config/mcp-servers.json'),
      resolve('./audit.jsonl'),
    ];

    const engine = new PolicyEngine(testCompiledPolicy, testToolAnnotations, protectedPaths, SANDBOX_DIR);

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
