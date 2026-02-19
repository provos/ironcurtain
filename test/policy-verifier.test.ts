import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV3 } from 'ai/test';
import { verifyPolicy } from '../src/pipeline/policy-verifier.js';
import { getHandwrittenScenarios } from '../src/pipeline/handwritten-scenarios.js';
import { testCompiledPolicy, testToolAnnotations } from './fixtures/test-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const compiledPolicy = testCompiledPolicy;
const toolAnnotations = testToolAnnotations;

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
      failureAttributions: [],
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
            failureAttributions: [],
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
            failureAttributions: [],
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
      SANDBOX_DIR,
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
      SANDBOX_DIR,
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
      SANDBOX_DIR,
    );

    expect(result.pass).toBe(true);
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0].newScenarios).toHaveLength(1);
    expect(result.rounds[1].executionResults).toHaveLength(1);
  });

  it('detects failures with a bad policy (overly broad allow)', async () => {
    // Create a policy where reads AND writes are allowed unconditionally.
    // This causes read-outside and write-outside scenarios (expected escalate)
    // to get allow instead. Per-role evaluation still correctly denies
    // move_file via the delete-path role, so we check escalate->allow flips.
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
        {
          name: 'allow-all-writes',
          description: 'Overly broad: allow all write operations',
          principle: 'Broken rule',
          if: { roles: ['write-path'] },
          then: 'allow',
          reason: 'Allow all writes',
        },
        ...compiledPolicy.rules.filter(r => !r.name.includes('read') && !r.name.includes('write')),
      ],
    };

    // Judge that reports failure
    const failJudge = new MockLanguageModelV3({
      doGenerate: async () => mockV3Result({
        analysis: 'Outside-sandbox scenarios fail -- reads and writes are allowed everywhere.',
        pass: false,
        failureAttributions: [],
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
      SANDBOX_DIR,
    );

    expect(result.pass).toBe(false);
    expect(result.failedScenarios.length).toBeGreaterThan(0);

    // Outside-sandbox scenarios should fail: expected escalate, got allow
    const escalateFailures = result.failedScenarios.filter(
      f => f.scenario.expectedDecision === 'escalate' && f.actualDecision === 'allow',
    );
    expect(escalateFailures.length).toBeGreaterThan(0);
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
          failureAttributions: [],
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
      SANDBOX_DIR,
    );

    expect(result.rounds).toHaveLength(2);
  });
});
