import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV3 } from 'ai/test';
import { verifyPolicy } from '../src/pipeline/policy-verifier.js';
import { getHandwrittenScenarios } from '../src/pipeline/handwritten-scenarios.js';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../src/pipeline/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

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

const SANDBOX_DIR = '/tmp/ironcurtain-sandbox';
const scenarios = getHandwrittenScenarios(SANDBOX_DIR);

const constitutionText = `# Constitution
1. Least privilege
2. No destruction
3. Containment
4. Transparency
5. Human oversight
6. Self-protection`;

/** Builds a mock V3 result with correct finishReason/usage shapes. */
function mockV3Result(responseJson: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(responseJson) }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: undefined, reasoning: undefined },
    },
    warnings: [] as never[],
    request: {},
    response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
  };
}

function createPassingJudge(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => mockV3Result({
      analysis: 'All scenarios pass. Policy correctly implements the constitution.',
      pass: true,
      additionalScenarios: [],
    }),
  });
}

function createMultiRoundJudge(): MockLanguageModelV3 {
  let callCount = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      callCount++;
      const isFirstRound = callCount === 1;

      const response = isFirstRound
        ? {
            analysis: 'Some scenarios pass but need to probe edge cases.',
            pass: false,
            additionalScenarios: [{
              description: 'Read file at sandbox boundary',
              request: {
                serverName: 'filesystem',
                toolName: 'read_file',
                arguments: { path: '/tmp/ironcurtain-sandbox/deep/nested/file.txt' },
              },
              expectedDecision: 'allow' as const,
              reasoning: 'Nested path within sandbox should be allowed',
            }],
          }
        : {
            analysis: 'All scenarios including probes pass. Policy is correct.',
            pass: true,
            additionalScenarios: [],
          };

      return mockV3Result(response);
    },
  });
}

describe('Policy Verifier', () => {
  it('reports pass when all scenarios match expected decisions', async () => {
    const judge = createPassingJudge();

    const result = await verifyPolicy(
      constitutionText,
      compiledPolicy,
      toolAnnotations,
      protectedPaths,
      scenarios,
      judge,
      3,
    );

    expect(result.pass).toBe(true);
    expect(result.rounds).toHaveLength(1);
    expect(result.summary).toContain('pass');
  });

  it('executes all scenarios against the real engine', async () => {
    const judge = createPassingJudge();

    const result = await verifyPolicy(
      constitutionText,
      compiledPolicy,
      toolAnnotations,
      protectedPaths,
      scenarios,
      judge,
      3,
    );

    const executionResults = result.rounds[0].executionResults;
    expect(executionResults).toHaveLength(scenarios.length);

    // All handwritten scenarios should match expected decisions
    for (const er of executionResults) {
      expect(er.pass).toBe(true);
    }
  });

  it('supports multi-round verification', async () => {
    const judge = createMultiRoundJudge();

    const result = await verifyPolicy(
      constitutionText,
      compiledPolicy,
      toolAnnotations,
      protectedPaths,
      scenarios,
      judge,
      3,
    );

    expect(result.pass).toBe(true);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].newScenarios).toHaveLength(1);
    expect(result.rounds[1].executionResults).toHaveLength(1);
  });

  it('detects failures with a bad policy (overly broad allow)', async () => {
    // Create a policy with a rule that allows ALL read operations unconditionally,
    // causing reads outside sandbox to be allowed instead of denied
    const badPolicy: CompiledPolicyFile = {
      ...compiledPolicy,
      rules: [
        {
          name: 'allow-all-reads',
          description: 'Overly broad: allow all read operations',
          principle: 'Broken rule',
          if: { roles: ['read-path'] },
          then: 'allow',
          reason: 'Allow all reads',
        },
        ...compiledPolicy.rules.filter(r => !r.name.includes('read')),
      ],
    };

    // Judge that reports failure
    const failJudge = new MockLanguageModelV3({
      doGenerate: async () => mockV3Result({
        analysis: 'Read-outside-sandbox scenarios fail -- reads are allowed everywhere.',
        pass: false,
        additionalScenarios: [],
      }),
    });

    const result = await verifyPolicy(
      constitutionText,
      badPolicy,
      toolAnnotations,
      protectedPaths,
      scenarios,
      failJudge,
      3,
    );

    expect(result.pass).toBe(false);
    expect(result.failedScenarios.length).toBeGreaterThan(0);

    // Read-outside-sandbox scenarios should fail: expected deny, got allow
    const readFailures = result.failedScenarios.filter(
      f => f.scenario.expectedDecision === 'deny' && f.actualDecision === 'allow',
    );
    expect(readFailures.length).toBeGreaterThan(0);
  });

  it('respects maxRounds limit', async () => {
    // Judge that always generates new scenarios
    let callCount = 0;
    const infiniteJudge = new MockLanguageModelV3({
      doGenerate: async () => {
        callCount++;
        return mockV3Result({
          analysis: `Round ${callCount}: generating more probes.`,
          pass: false,
          additionalScenarios: [{
            description: `Probe scenario ${callCount}`,
            request: {
              serverName: 'filesystem',
              toolName: 'read_file',
              arguments: { path: `/tmp/ironcurtain-sandbox/probe-${callCount}.txt` },
            },
            expectedDecision: 'allow' as const,
            reasoning: 'Read within sandbox',
          }],
        });
      },
    });

    const result = await verifyPolicy(
      constitutionText,
      compiledPolicy,
      toolAnnotations,
      protectedPaths,
      scenarios,
      infiniteJudge,
      2, // limit to 2 rounds
    );

    expect(result.rounds).toHaveLength(2);
  });
});
