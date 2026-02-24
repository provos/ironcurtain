import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import {
  generateScenarios,
  formatFeedbackMessage,
  ScenarioGeneratorSession,
} from '../src/pipeline/scenario-generator.js';
import { ConstitutionCompilerSession } from '../src/pipeline/constitution-compiler.js';
import { parseJsonWithSchema } from '../src/pipeline/generate-with-repair.js';
import { mergeReplacements } from '../src/pipeline/compile.js';
import type {
  ToolAnnotation,
  TestScenario,
  ScenarioFeedback,
  DiscardedScenario,
  RepairContext,
} from '../src/pipeline/types.js';
import { z } from 'zod';

const sampleAnnotations: ToolAnnotation[] = [
  {
    toolName: 'read_file',
    serverName: 'filesystem',
    comment: 'Reads the complete contents of a file from disk',
    sideEffects: true,
    args: { path: ['read-path'] },
  },
  {
    toolName: 'write_file',
    serverName: 'filesystem',
    comment: 'Creates or overwrites a file with new content',
    sideEffects: true,
    args: { path: ['write-path'] },
  },
];

const handwrittenScenarios: TestScenario[] = [
  {
    description: 'Read file inside sandbox',
    request: {
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: { path: '/tmp/sandbox/test.txt' },
    },
    expectedDecision: 'allow',
    reasoning: 'Within sandbox',
    source: 'handwritten',
  },
  {
    description: 'Read file outside sandbox',
    request: {
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: { path: '/etc/passwd' },
    },
    expectedDecision: 'deny',
    reasoning: 'Outside sandbox',
    source: 'handwritten',
  },
];

const llmGeneratedScenarios = [
  {
    description: 'Write file inside sandbox',
    request: {
      serverName: 'filesystem',
      toolName: 'write_file',
      arguments: { path: '/tmp/sandbox/output.txt', content: 'data' },
    },
    expectedDecision: 'allow' as const,
    reasoning: 'Within sandbox',
  },
  // This one duplicates a handwritten scenario
  {
    description: 'Read file outside sandbox (duplicate)',
    request: {
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: { path: '/etc/passwd' },
    },
    expectedDecision: 'deny' as const,
    reasoning: 'Outside sandbox',
  },
];

const sampleConstitution = '# Constitution\n1. Containment\n2. No destruction';
const SANDBOX_DIR = '/tmp/sandbox';

function createMockModel(response: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 50, text: undefined, reasoning: undefined },
      },
      warnings: [],
      request: {},
      response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
    }),
  });
}

describe('Scenario Generator', () => {
  it('includes all handwritten scenarios first', async () => {
    const mockLLM = createMockModel({ scenarios: llmGeneratedScenarios });

    const result = await generateScenarios(
      sampleConstitution,
      sampleAnnotations,
      handwrittenScenarios,
      SANDBOX_DIR,
      mockLLM,
    );

    // Handwritten come first
    expect(result[0].source).toBe('handwritten');
    expect(result[1].source).toBe('handwritten');
    expect(result[0].description).toBe('Read file inside sandbox');
    expect(result[1].description).toBe('Read file outside sandbox');
  });

  it('marks LLM-generated scenarios with source "generated"', async () => {
    const mockLLM = createMockModel({ scenarios: llmGeneratedScenarios });

    const result = await generateScenarios(
      sampleConstitution,
      sampleAnnotations,
      handwrittenScenarios,
      SANDBOX_DIR,
      mockLLM,
    );

    const generated = result.filter((s) => s.source === 'generated');
    expect(generated.length).toBeGreaterThan(0);
    for (const s of generated) {
      expect(s.source).toBe('generated');
    }
  });

  it('deduplicates scenarios that match handwritten ones', async () => {
    const mockLLM = createMockModel({ scenarios: llmGeneratedScenarios });

    const result = await generateScenarios(
      sampleConstitution,
      sampleAnnotations,
      handwrittenScenarios,
      SANDBOX_DIR,
      mockLLM,
    );

    // 2 handwritten + 1 unique generated (the duplicate is removed)
    expect(result).toHaveLength(3);
  });

  it('preserves all scenarios when there are no duplicates', async () => {
    const uniqueGenerated = [llmGeneratedScenarios[0]]; // only the write scenario
    const mockLLM = createMockModel({ scenarios: uniqueGenerated });

    const result = await generateScenarios(
      sampleConstitution,
      sampleAnnotations,
      handwrittenScenarios,
      SANDBOX_DIR,
      mockLLM,
    );

    expect(result).toHaveLength(3); // 2 handwritten + 1 generated
  });

  it('handles empty LLM response', async () => {
    const mockLLM = createMockModel({ scenarios: [] });

    const result = await generateScenarios(
      sampleConstitution,
      sampleAnnotations,
      handwrittenScenarios,
      SANDBOX_DIR,
      mockLLM,
    );

    // Only handwritten scenarios remain
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.source === 'handwritten')).toBe(true);
  });

  it('all scenarios have required fields', async () => {
    const mockLLM = createMockModel({ scenarios: llmGeneratedScenarios });

    const result = await generateScenarios(
      sampleConstitution,
      sampleAnnotations,
      handwrittenScenarios,
      SANDBOX_DIR,
      mockLLM,
    );

    for (const s of result) {
      expect(s.description).toBeTruthy();
      expect(s.request.serverName).toBeTruthy();
      expect(s.request.toolName).toBeTruthy();
      expect(s.request.arguments).toBeDefined();
      expect(['allow', 'deny', 'escalate']).toContain(s.expectedDecision);
      expect(s.reasoning).toBeTruthy();
      expect(['generated', 'handwritten']).toContain(s.source);
    }
  });
});

// ---------------------------------------------------------------------------
// parseJsonWithSchema tests
// ---------------------------------------------------------------------------

describe('parseJsonWithSchema', () => {
  const schema = z.object({ value: z.number() });

  it('parses valid JSON from plain text', () => {
    const result = parseJsonWithSchema('{"value": 42}', schema);
    expect(result).toEqual({ value: 42 });
  });

  it('parses JSON inside markdown code fences', () => {
    const text = 'Here is the result:\n```json\n{"value": 99}\n```\nDone.';
    const result = parseJsonWithSchema(text, schema);
    expect(result).toEqual({ value: 99 });
  });

  it('parses JSON with surrounding prose', () => {
    const text = 'The answer is {"value": 7} and that is final.';
    const result = parseJsonWithSchema(text, schema);
    expect(result).toEqual({ value: 7 });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJsonWithSchema('not json at all', schema)).toThrow();
  });

  it('throws when JSON does not match schema', () => {
    expect(() => parseJsonWithSchema('{"value": "not-a-number"}', schema)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatFeedbackMessage tests
// ---------------------------------------------------------------------------

describe('formatFeedbackMessage', () => {
  it('includes corrections section when corrections are present', () => {
    const feedback: ScenarioFeedback = {
      corrections: [
        {
          scenarioDescription: 'Read /etc/passwd',
          correctedDecision: 'escalate',
          correctedReasoning: 'Not categorically forbidden',
        },
      ],
      discardedScenarios: [],
      probeScenarios: [],
    };

    const msg = formatFeedbackMessage(feedback);
    expect(msg).toContain('## Corrected Scenarios');
    expect(msg).toContain('Read /etc/passwd');
    expect(msg).toContain('escalate');
    expect(msg).toContain('Not categorically forbidden');
  });

  it('includes discarded section when discarded scenarios are present', () => {
    const feedback: ScenarioFeedback = {
      corrections: [],
      discardedScenarios: [
        {
          scenario: {
            description: 'Write to audit.jsonl',
            request: { serverName: 'filesystem', toolName: 'write_file', arguments: {} },
            expectedDecision: 'allow',
            reasoning: 'test',
            source: 'generated',
          },
          actual: 'deny',
          rule: 'structural-protected-paths',
        },
      ],
      probeScenarios: [],
    };

    const msg = formatFeedbackMessage(feedback);
    expect(msg).toContain('## Discarded Scenarios');
    expect(msg).toContain('Write to audit.jsonl');
    expect(msg).toContain('structural-protected-paths');
    expect(msg).toContain('deny');
  });

  it('includes probe section when probe scenarios are present', () => {
    const feedback: ScenarioFeedback = {
      corrections: [],
      discardedScenarios: [],
      probeScenarios: [
        {
          description: 'Read auth log',
          request: { serverName: 'filesystem', toolName: 'read_file', arguments: { path: '/var/log/auth.log' } },
          expectedDecision: 'escalate',
          reasoning: 'Coverage gap',
          source: 'generated',
        },
      ],
    };

    const msg = formatFeedbackMessage(feedback);
    expect(msg).toContain('## Coverage Gaps');
    expect(msg).toContain('filesystem/read_file');
    expect(msg).toContain('/var/log/auth.log');
    expect(msg).toContain('escalate');
  });

  it('includes all sections when all feedback types are present', () => {
    const feedback: ScenarioFeedback = {
      corrections: [{ scenarioDescription: 'test1', correctedDecision: 'deny', correctedReasoning: 'reason1' }],
      discardedScenarios: [
        {
          scenario: {
            description: 'test2',
            request: { serverName: 'filesystem', toolName: 'read_file', arguments: {} },
            expectedDecision: 'allow',
            reasoning: 'test',
            source: 'generated',
          },
          actual: 'deny',
          rule: 'structural-unknown-tool',
        },
      ],
      probeScenarios: [
        {
          description: 'test3',
          request: { serverName: 'filesystem', toolName: 'write_file', arguments: { path: '/tmp/test' } },
          expectedDecision: 'allow',
          reasoning: 'probe',
          source: 'generated',
        },
      ],
    };

    const msg = formatFeedbackMessage(feedback);
    expect(msg).toContain('## Corrected Scenarios');
    expect(msg).toContain('## Discarded Scenarios');
    expect(msg).toContain('## Coverage Gaps');
    expect(msg).toContain('Generate replacement scenarios');
  });

  it('includes replacement instruction even with empty feedback', () => {
    const feedback: ScenarioFeedback = {
      corrections: [],
      discardedScenarios: [],
      probeScenarios: [],
    };

    const msg = formatFeedbackMessage(feedback);
    expect(msg).toContain('Generate replacement scenarios');
  });
});

// ---------------------------------------------------------------------------
// ScenarioGeneratorSession tests
// ---------------------------------------------------------------------------

/** Creates a mock model that tracks calls and returns sequential responses. */
function createCallTrackingMockModel(responses: unknown[]) {
  let callIndex = 0;
  const calls: Array<{ system: unknown; messages: Array<{ role: string; content: string }> }> = [];

  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      // Capture system and messages at call time (messages mutate)
      const system = opts.prompt.filter((p) => p.role === 'system');
      const messages = opts.prompt
        .filter((p) => p.role === 'user' || p.role === 'assistant')
        .map((p) => ({
          role: p.role,
          content: p.content
            .filter((c): c is { type: 'text'; text: string } => 'type' in c && c.type === 'text')
            .map((c) => c.text)
            .join(''),
        }));
      calls.push({ system, messages });

      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response) }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 50, text: undefined, reasoning: undefined },
        },
        warnings: [],
        request: {},
        response: { id: `test-${callIndex}`, modelId: 'test-model', timestamp: new Date() },
      };
    },
  });

  return { model, calls };
}

describe('ScenarioGeneratorSession', () => {
  const initialScenarios = [
    {
      description: 'Write file inside sandbox',
      request: {
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: { path: '/tmp/sandbox/out.txt', content: 'hello' },
      },
      expectedDecision: 'allow' as const,
      reasoning: 'Within sandbox',
    },
  ];

  const replacementScenarios = [
    {
      description: 'Read config file (escalate)',
      request: {
        serverName: 'filesystem',
        toolName: 'read_file',
        arguments: { path: '/etc/config.yaml' },
      },
      expectedDecision: 'escalate' as const,
      reasoning: 'Not categorically forbidden',
    },
  ];

  it('generate() returns handwritten + unique generated scenarios', async () => {
    const { model } = createCallTrackingMockModel([{ scenarios: initialScenarios }]);

    const session = new ScenarioGeneratorSession({
      system: 'Test system prompt',
      model,
      annotations: sampleAnnotations,
      handwrittenScenarios,
    });

    const result = await session.generate();

    // 2 handwritten + 1 generated
    expect(result).toHaveLength(3);
    expect(result[0].source).toBe('handwritten');
    expect(result[1].source).toBe('handwritten');
    expect(result[2].source).toBe('generated');
    expect(result[2].description).toBe('Write file inside sandbox');
  });

  it('generate() marks all LLM scenarios with source "generated"', async () => {
    const { model } = createCallTrackingMockModel([{ scenarios: initialScenarios }]);

    const session = new ScenarioGeneratorSession({
      system: 'Test system prompt',
      model,
      annotations: sampleAnnotations,
      handwrittenScenarios,
    });

    const result = await session.generate();
    const generated = result.filter((s) => s.source === 'generated');
    expect(generated).toHaveLength(1);
    expect(generated[0].source).toBe('generated');
  });

  it('regenerate() returns only replacement scenarios', async () => {
    const { model } = createCallTrackingMockModel([
      { scenarios: initialScenarios },
      { scenarios: replacementScenarios },
    ]);

    const session = new ScenarioGeneratorSession({
      system: 'Test system prompt',
      model,
      annotations: sampleAnnotations,
      handwrittenScenarios,
    });

    await session.generate();

    const feedback: ScenarioFeedback = {
      corrections: [
        { scenarioDescription: 'Write file inside sandbox', correctedDecision: 'deny', correctedReasoning: 'wrong' },
      ],
      discardedScenarios: [],
      probeScenarios: [],
    };

    const replacements = await session.regenerate(feedback);

    // Returns only replacement scenarios, NOT handwritten
    expect(replacements).toHaveLength(1);
    expect(replacements[0].description).toBe('Read config file (escalate)');
    expect(replacements[0].source).toBe('generated');
  });

  it('turnCount tracks the number of completed turns', async () => {
    const { model } = createCallTrackingMockModel([
      { scenarios: initialScenarios },
      { scenarios: replacementScenarios },
    ]);

    const session = new ScenarioGeneratorSession({
      system: 'Test system prompt',
      model,
      annotations: sampleAnnotations,
      handwrittenScenarios,
    });

    expect(session.turnCount).toBe(0);
    await session.generate();
    expect(session.turnCount).toBe(1);

    await session.regenerate({ corrections: [], discardedScenarios: [], probeScenarios: [] });
    expect(session.turnCount).toBe(2);
  });

  it('system prompt is identical across all turns', async () => {
    const { model, calls } = createCallTrackingMockModel([
      { scenarios: initialScenarios },
      { scenarios: replacementScenarios },
    ]);

    const session = new ScenarioGeneratorSession({
      system: 'Stable system prompt for caching',
      model,
      annotations: sampleAnnotations,
      handwrittenScenarios,
    });

    await session.generate();
    await session.regenerate({ corrections: [], discardedScenarios: [], probeScenarios: [] });

    // Both calls should have the same system prompt
    expect(calls).toHaveLength(2);
    expect(calls[0].system).toEqual(calls[1].system);
  });

  it('message history grows across turns', async () => {
    const { model, calls } = createCallTrackingMockModel([
      { scenarios: initialScenarios },
      { scenarios: replacementScenarios },
    ]);

    const session = new ScenarioGeneratorSession({
      system: 'Test prompt',
      model,
      annotations: sampleAnnotations,
      handwrittenScenarios,
    });

    await session.generate();
    // Turn 1: 1 user message
    expect(calls[0].messages).toHaveLength(1);
    expect(calls[0].messages[0].role).toBe('user');

    await session.regenerate({ corrections: [], discardedScenarios: [], probeScenarios: [] });
    // Turn 2: user + assistant (turn 1) + user (turn 2) = 3 messages
    expect(calls[1].messages).toHaveLength(3);
    expect(calls[1].messages[0].role).toBe('user');
    expect(calls[1].messages[1].role).toBe('assistant');
    expect(calls[1].messages[2].role).toBe('user');
  });

  it('regenerate feedback message includes corrections', async () => {
    const { model, calls } = createCallTrackingMockModel([
      { scenarios: initialScenarios },
      { scenarios: replacementScenarios },
    ]);

    const session = new ScenarioGeneratorSession({
      system: 'Test prompt',
      model,
      annotations: sampleAnnotations,
      handwrittenScenarios,
    });

    await session.generate();

    const feedback: ScenarioFeedback = {
      corrections: [
        {
          scenarioDescription: 'Read /etc/passwd',
          correctedDecision: 'escalate',
          correctedReasoning: 'Not categorically forbidden',
        },
      ],
      discardedScenarios: [],
      probeScenarios: [],
    };

    await session.regenerate(feedback);

    // The second call's last user message should contain the correction info
    const lastUserMsg = calls[1].messages[2].content;
    expect(lastUserMsg).toContain('Corrected Scenarios');
    expect(lastUserMsg).toContain('Read /etc/passwd');
    expect(lastUserMsg).toContain('escalate');
  });
});

// ---------------------------------------------------------------------------
// mergeReplacements tests
// ---------------------------------------------------------------------------

describe('mergeReplacements', () => {
  const baseScenarios: TestScenario[] = [
    {
      description: 'Handwritten scenario',
      request: { serverName: 'filesystem', toolName: 'read_file', arguments: { path: '/sandbox/test' } },
      expectedDecision: 'allow',
      reasoning: 'ok',
      source: 'handwritten',
    },
    {
      description: 'Generated allow',
      request: { serverName: 'filesystem', toolName: 'write_file', arguments: { path: '/sandbox/out.txt' } },
      expectedDecision: 'allow',
      reasoning: 'within sandbox',
      source: 'generated',
    },
    {
      description: 'Generated deny',
      request: { serverName: 'filesystem', toolName: 'read_file', arguments: { path: '/etc/passwd' } },
      expectedDecision: 'deny',
      reasoning: 'categorically forbidden',
      source: 'generated',
    },
  ];

  it('removes corrected scenarios and adds replacements', () => {
    const replacements: TestScenario[] = [
      {
        description: 'Replacement escalate',
        request: { serverName: 'filesystem', toolName: 'read_file', arguments: { path: '/etc/config' } },
        expectedDecision: 'escalate',
        reasoning: 'not forbidden',
        source: 'generated',
      },
    ];

    const result = mergeReplacements(baseScenarios, replacements, [{ scenarioDescription: 'Generated deny' }], []);

    expect(result.map((s) => s.description)).toEqual([
      'Handwritten scenario',
      'Generated allow',
      'Replacement escalate',
    ]);
  });

  it('removes discarded scenarios (non-handwritten only)', () => {
    const discarded: DiscardedScenario[] = [
      {
        scenario: baseScenarios[2], // Generated deny
        actual: 'deny',
        rule: 'structural-protected-paths',
      },
    ];

    const result = mergeReplacements(baseScenarios, [], [], discarded);

    expect(result.map((s) => s.description)).toEqual(['Handwritten scenario', 'Generated allow']);
  });

  it('never removes handwritten scenarios via discarded', () => {
    const discarded: DiscardedScenario[] = [
      {
        scenario: baseScenarios[0], // Handwritten
        actual: 'deny',
        rule: 'structural-something',
      },
    ];

    const result = mergeReplacements(baseScenarios, [], [], discarded);

    // Handwritten should still be present
    expect(result.find((s) => s.description === 'Handwritten scenario')).toBeDefined();
  });

  it('deduplicates replacements against kept scenarios', () => {
    const replacements: TestScenario[] = [
      {
        // Same description as an existing kept scenario
        description: 'Generated allow',
        request: { serverName: 'filesystem', toolName: 'write_file', arguments: { path: '/other' } },
        expectedDecision: 'allow',
        reasoning: 'dup',
        source: 'generated',
      },
      {
        description: 'Unique replacement',
        request: { serverName: 'filesystem', toolName: 'read_file', arguments: { path: '/new' } },
        expectedDecision: 'escalate',
        reasoning: 'new',
        source: 'generated',
      },
    ];

    const result = mergeReplacements(baseScenarios, replacements, [], []);

    // Duplicate "Generated allow" replacement should be filtered out
    const descriptions = result.map((s) => s.description);
    expect(descriptions.filter((d) => d === 'Generated allow')).toHaveLength(1);
    expect(descriptions).toContain('Unique replacement');
  });

  it('handles empty corrections and discards gracefully', () => {
    const result = mergeReplacements(baseScenarios, [], [], []);
    expect(result).toEqual(baseScenarios);
  });
});

// ---------------------------------------------------------------------------
// ConstitutionCompilerSession tests
// ---------------------------------------------------------------------------

describe('ConstitutionCompilerSession', () => {
  const sampleRules = [
    {
      name: 'allow-sandbox-reads',
      description: 'Allow reads within sandbox',
      principle: 'Containment',
      if: { paths: { roles: ['read-path'], within: '/tmp/sandbox' } },
      then: 'allow',
      reason: 'Within sandbox',
    },
  ];

  const sampleListDefs = [
    {
      name: 'news-sites',
      type: 'domains',
      principle: 'Allow major news',
      generationPrompt: 'List major news sites',
      requiresMcp: false,
    },
  ];

  const compilerResponse = { rules: sampleRules, listDefinitions: sampleListDefs };
  const compilerResponseNoLists = { rules: sampleRules, listDefinitions: [] };

  it('compile() returns rules and listDefinitions', async () => {
    const { model } = createCallTrackingMockModel([compilerResponse]);

    const session = new ConstitutionCompilerSession({
      system: 'Test compiler system prompt',
      model,
      annotations: sampleAnnotations,
    });

    const result = await session.compile();

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].name).toBe('allow-sandbox-reads');
    expect(result.listDefinitions).toHaveLength(1);
    expect(result.listDefinitions[0].name).toBe('news-sites');
  });

  it('recompile() sends repair instructions in user message', async () => {
    const repairedRules = [
      ...sampleRules,
      {
        name: 'escalate-external-writes',
        description: 'Escalate writes outside sandbox',
        principle: 'Human oversight',
        if: { roles: ['write-path'] },
        then: 'escalate',
        reason: 'Writes outside sandbox require human approval',
      },
    ];

    const { model, calls } = createCallTrackingMockModel([
      compilerResponseNoLists,
      { rules: repairedRules, listDefinitions: [] },
    ]);

    const session = new ConstitutionCompilerSession({
      system: 'Test compiler system prompt',
      model,
      annotations: sampleAnnotations,
    });

    await session.compile();

    const repairContext: RepairContext = {
      failedScenarios: [
        {
          scenario: {
            description: 'Delete file outside sandbox',
            request: { serverName: 'filesystem', toolName: 'write_file', arguments: { path: '/etc/passwd' } },
            expectedDecision: 'deny',
            reasoning: 'Forbidden',
            source: 'generated' as const,
          },
          actualDecision: 'allow',
          matchingRule: 'allow-sandbox-reads',
          pass: false,
        },
      ],
      judgeAnalysis: 'Missing deny rule for deletes outside sandbox',
      attemptNumber: 1,
    };

    const result = await session.recompile(repairContext);

    expect(result.rules).toHaveLength(2);

    // The second call's last user message should contain repair instructions
    const lastUserMsg = calls[1].messages[2].content;
    expect(lastUserMsg).toContain('REPAIR INSTRUCTIONS');
    expect(lastUserMsg).toContain('Missing deny rule for deletes outside sandbox');
  });

  it('turnCount tracks the number of completed turns', async () => {
    const { model } = createCallTrackingMockModel([compilerResponseNoLists, compilerResponseNoLists]);

    const session = new ConstitutionCompilerSession({
      system: 'Test prompt',
      model,
      annotations: sampleAnnotations,
    });

    expect(session.turnCount).toBe(0);
    await session.compile();
    expect(session.turnCount).toBe(1);

    const repairContext: RepairContext = {
      failedScenarios: [],
      judgeAnalysis: 'Some failures',
      attemptNumber: 1,
    };
    await session.recompile(repairContext);
    expect(session.turnCount).toBe(2);
  });

  it('system prompt is identical across all turns', async () => {
    const { model, calls } = createCallTrackingMockModel([compilerResponseNoLists, compilerResponseNoLists]);

    const session = new ConstitutionCompilerSession({
      system: 'Stable compiler system prompt for caching',
      model,
      annotations: sampleAnnotations,
    });

    await session.compile();
    await session.recompile({
      failedScenarios: [],
      judgeAnalysis: 'test',
      attemptNumber: 1,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].system).toEqual(calls[1].system);
  });

  it('message history grows across turns', async () => {
    const { model, calls } = createCallTrackingMockModel([compilerResponseNoLists, compilerResponseNoLists]);

    const session = new ConstitutionCompilerSession({
      system: 'Test prompt',
      model,
      annotations: sampleAnnotations,
    });

    await session.compile();
    // Turn 1: 1 user message
    expect(calls[0].messages).toHaveLength(1);
    expect(calls[0].messages[0].role).toBe('user');

    await session.recompile({
      failedScenarios: [],
      judgeAnalysis: 'test',
      attemptNumber: 1,
    });
    // Turn 2: user + assistant (turn 1) + user (turn 2) = 3 messages
    expect(calls[1].messages).toHaveLength(3);
    expect(calls[1].messages[0].role).toBe('user');
    expect(calls[1].messages[1].role).toBe('assistant');
    expect(calls[1].messages[2].role).toBe('user');
  });

  it('schema repair retry recovers from invalid JSON on first attempt', async () => {
    let callIndex = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        callIndex++;
        const text = callIndex === 1 ? 'not valid json at all' : JSON.stringify(compilerResponseNoLists);

        return {
          content: [{ type: 'text' as const, text }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 50, text: undefined, reasoning: undefined },
          },
          warnings: [],
          request: {},
          response: { id: `test-${callIndex}`, modelId: 'test-model', timestamp: new Date() },
        };
      },
    });

    const session = new ConstitutionCompilerSession({
      system: 'Test prompt',
      model,
      annotations: sampleAnnotations,
    });

    const result = await session.compile();
    expect(result.rules).toHaveLength(1);
    expect(session.turnCount).toBe(1);
  });

  it('schema repair exhaustion throws', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: 'text' as const, text: 'not valid json' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 50, text: undefined, reasoning: undefined },
        },
        warnings: [],
        request: {},
        response: { id: 'test', modelId: 'test-model', timestamp: new Date() },
      }),
    });

    const session = new ConstitutionCompilerSession({
      system: 'Test prompt',
      model,
      annotations: sampleAnnotations,
    });

    await expect(session.compile()).rejects.toThrow();
  });
});
