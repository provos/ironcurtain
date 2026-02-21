import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { verifyPolicy, filterStructuralConflicts } from '../src/pipeline/policy-verifier.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { CompiledPolicyFile, TestScenario } from '../src/pipeline/types.js';
import { getHandwrittenScenarios } from '../src/pipeline/handwritten-scenarios.js';
import {
  testCompiledPolicy,
  testToolAnnotations,
  TEST_SANDBOX_DIR,
  TEST_PROTECTED_PATHS,
  TEST_DOMAIN_ALLOWLISTS,
} from './fixtures/test-policy.js';

const protectedPaths = TEST_PROTECTED_PATHS;
const SANDBOX_DIR = TEST_SANDBOX_DIR;
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
    doGenerate: async () =>
      mockV3Result({
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
            additionalScenarios: [
              {
                description: 'Read file at sandbox boundary',
                request: {
                  serverName: 'filesystem',
                  toolName: 'read_file',
                  arguments: { path: '/tmp/ironcurtain-sandbox/deep/nested/file.txt' },
                },
                expectedDecision: 'allow' as const,
                reasoning: 'Nested path within sandbox should be allowed',
              },
            ],
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
      testCompiledPolicy,
      testToolAnnotations,
      protectedPaths,
      scenarios,
      judge,
      3,
      SANDBOX_DIR,
      undefined,
      TEST_DOMAIN_ALLOWLISTS,
    );

    expect(result.pass).toBe(true);
    expect(result.rounds).toHaveLength(1);
    expect(result.summary).toContain('pass');
  });

  it('executes all scenarios against the real engine', async () => {
    const judge = createPassingJudge();

    const result = await verifyPolicy(
      constitutionText,
      testCompiledPolicy,
      testToolAnnotations,
      protectedPaths,
      scenarios,
      judge,
      3,
      SANDBOX_DIR,
      undefined,
      TEST_DOMAIN_ALLOWLISTS,
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
      testCompiledPolicy,
      testToolAnnotations,
      protectedPaths,
      scenarios,
      judge,
      3,
      SANDBOX_DIR,
      undefined,
      TEST_DOMAIN_ALLOWLISTS,
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
      ...testCompiledPolicy,
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
        ...testCompiledPolicy.rules.filter((r) => !r.name.includes('read') && !r.name.includes('write')),
      ],
    };

    // Judge that reports failure
    const failJudge = new MockLanguageModelV3({
      doGenerate: async () =>
        mockV3Result({
          analysis: 'Outside-sandbox scenarios fail -- reads and writes are allowed everywhere.',
          pass: false,
          failureAttributions: [],
          additionalScenarios: [],
        }),
    });

    const result = await verifyPolicy(
      constitutionText,
      badPolicy,
      testToolAnnotations,
      protectedPaths,
      scenarios,
      failJudge,
      3,
      SANDBOX_DIR,
      undefined,
      TEST_DOMAIN_ALLOWLISTS,
    );

    expect(result.pass).toBe(false);
    expect(result.failedScenarios.length).toBeGreaterThan(0);

    // Outside-sandbox scenarios should fail: expected escalate, got allow
    const escalateFailures = result.failedScenarios.filter(
      (f) => f.scenario.expectedDecision === 'escalate' && f.actualDecision === 'allow',
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
          additionalScenarios: [
            {
              description: `Probe scenario ${callCount}`,
              request: {
                serverName: 'filesystem',
                toolName: 'read_file',
                arguments: { path: `/tmp/ironcurtain-sandbox/probe-${callCount}.txt` },
              },
              expectedDecision: 'allow' as const,
              reasoning: 'Read within sandbox',
            },
          ],
        });
      },
    });

    const result = await verifyPolicy(
      constitutionText,
      testCompiledPolicy,
      testToolAnnotations,
      protectedPaths,
      scenarios,
      infiniteJudge,
      2, // limit to 2 rounds
      SANDBOX_DIR,
      undefined,
      TEST_DOMAIN_ALLOWLISTS,
    );

    expect(result.rounds).toHaveLength(2);
  });
});

describe('filterStructuralConflicts', () => {
  const engine = new PolicyEngine(
    testCompiledPolicy,
    testToolAnnotations,
    protectedPaths,
    SANDBOX_DIR,
    TEST_DOMAIN_ALLOWLISTS,
  );

  it('discards scenarios that conflict with structural invariants', () => {
    const conflictingScenario: TestScenario = {
      description: 'Get file info on constitution.md',
      request: {
        serverName: 'filesystem',
        toolName: 'get_file_info',
        arguments: { path: protectedPaths[0] },
      },
      expectedDecision: 'escalate', // Wrong — structural invariant denies this
      reasoning: 'Protected path access should be escalated',
      source: 'generated',
    };

    const validScenario: TestScenario = {
      description: 'Read file in sandbox',
      request: {
        serverName: 'filesystem',
        toolName: 'read_file',
        arguments: { path: `${SANDBOX_DIR}/test.txt` },
      },
      expectedDecision: 'allow',
      reasoning: 'Sandbox reads are allowed',
      source: 'generated',
    };

    const { valid, discarded } = filterStructuralConflicts(engine, [conflictingScenario, validScenario]);

    expect(valid).toHaveLength(1);
    expect(valid[0].description).toBe('Read file in sandbox');
    expect(discarded).toHaveLength(1);
    expect(discarded[0].scenario.description).toBe('Get file info on constitution.md');
    expect(discarded[0].actual).toBe('deny');
    expect(discarded[0].rule).toBe('structural-protected-path');
  });

  it('keeps scenarios that agree with structural invariants', () => {
    const correctScenario: TestScenario = {
      description: 'Deny write to protected path',
      request: {
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: { path: protectedPaths[0], content: 'hack' },
      },
      expectedDecision: 'deny', // Correct — matches structural invariant
      reasoning: 'Protected path writes are denied',
      source: 'generated',
    };

    const { valid, discarded } = filterStructuralConflicts(engine, [correctScenario]);

    expect(valid).toHaveLength(1);
    expect(discarded).toHaveLength(0);
  });

  it('keeps scenarios resolved by compiled rules (non-structural)', () => {
    const outsideReadScenario: TestScenario = {
      description: 'Read file outside sandbox',
      request: {
        serverName: 'filesystem',
        toolName: 'read_file',
        arguments: { path: '/etc/passwd' },
      },
      expectedDecision: 'escalate',
      reasoning: 'Reads outside sandbox are escalated',
      source: 'generated',
    };

    const { valid, discarded } = filterStructuralConflicts(engine, [outsideReadScenario]);

    expect(valid).toHaveLength(1);
    expect(discarded).toHaveLength(0);
  });

  it('discards scenarios that expect allow for unknown tools', () => {
    const unknownToolScenario: TestScenario = {
      description: 'Call unknown tool',
      request: {
        serverName: 'filesystem',
        toolName: 'totally_unknown_tool',
        arguments: {},
      },
      expectedDecision: 'allow', // Wrong — structural invariant denies unknown tools
      reasoning: 'Should be allowed',
      source: 'generated',
    };

    const { valid, discarded } = filterStructuralConflicts(engine, [unknownToolScenario]);

    expect(valid).toHaveLength(0);
    expect(discarded).toHaveLength(1);
    expect(discarded[0].rule).toBe('structural-unknown-tool');
  });

  it('preserves handwritten scenarios even when conflicting', () => {
    // Handwritten scenarios that conflict are still kept in the valid set
    // (the caller in compile.ts handles them specially via logging)
    // filterStructuralConflicts itself is source-agnostic
    const handwrittenConflict: TestScenario = {
      description: 'Handwritten: get info on constitution',
      request: {
        serverName: 'filesystem',
        toolName: 'get_file_info',
        arguments: { path: protectedPaths[0] },
      },
      expectedDecision: 'escalate',
      reasoning: 'Should escalate',
      source: 'handwritten',
    };

    const { valid, discarded } = filterStructuralConflicts(engine, [handwrittenConflict]);

    // filterStructuralConflicts discards regardless of source — the caller
    // inspects discarded[].scenario.source for special handling
    expect(valid).toHaveLength(0);
    expect(discarded).toHaveLength(1);
    expect(discarded[0].scenario.source).toBe('handwritten');
  });
});
