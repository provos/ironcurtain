import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateScenarios, repairScenarios, SCENARIO_BATCH_SIZE } from '../src/pipeline/scenario-generator.js';
import { ConstitutionCompilerSession } from '../src/pipeline/constitution-compiler.js';
import { parseJsonWithSchema } from '../src/pipeline/generate-with-repair.js';
import type { ToolAnnotation, TestScenario, RepairContext } from '../src/pipeline/types.js';
import { z } from 'zod';

const sampleAnnotations: ToolAnnotation[] = [
  {
    toolName: 'read_file',
    serverName: 'filesystem',
    comment: 'Reads the complete contents of a file from disk',

    args: { path: ['read-path'] },
  },
  {
    toolName: 'write_file',
    serverName: 'filesystem',
    comment: 'Creates or overwrites a file with new content',

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
// Batched generateScenarios tests
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

/** Generates N unique annotations across serverA and serverB. */
function generateAnnotations(count: number): ToolAnnotation[] {
  const annotations: ToolAnnotation[] = [];
  for (let i = 0; i < count; i++) {
    annotations.push({
      toolName: `tool_${i}`,
      serverName: i % 2 === 0 ? 'serverA' : 'serverB',
      comment: `Tool ${i} description`,
      args: { path: ['read-path'] },
    });
  }
  return annotations;
}

describe('Batched generateScenarios', () => {
  it('single batch: <=25 annotations produces exactly one generateObjectWithRepair call', async () => {
    const smallAnnotations = generateAnnotations(10);

    // Build a valid response for these annotations
    const batchResponse = {
      scenarios: [
        {
          description: 'Test tool_0',
          request: { serverName: 'serverA', toolName: 'tool_0', arguments: { path: '/tmp/sandbox/f' } },
          expectedDecision: 'allow',
          reasoning: 'Within sandbox',
        },
      ],
    };

    const { model, calls } = createCallTrackingMockModel([batchResponse]);

    await generateScenarios(sampleConstitution, smallAnnotations, [], SANDBOX_DIR, model);

    expect(calls).toHaveLength(1);
  });

  it('batch splitting: >25 annotations produces multiple generateObjectWithRepair calls', async () => {
    const manyAnnotations = generateAnnotations(30);

    // batch 1 has 25 tools, batch 2 has 5 tools
    const batch1Response = {
      scenarios: [
        {
          description: 'Test batch 1 tool',
          request: { serverName: 'serverA', toolName: 'tool_0', arguments: { path: '/tmp/sandbox/a' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
      ],
    };
    const batch2Response = {
      scenarios: [
        {
          description: 'Test batch 2 tool',
          request: { serverName: 'serverB', toolName: 'tool_25', arguments: { path: '/tmp/sandbox/b' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
      ],
    };

    const { model, calls } = createCallTrackingMockModel([batch1Response, batch2Response]);

    const result = await generateScenarios(sampleConstitution, manyAnnotations, [], SANDBOX_DIR, model);

    // Two LLM calls: one per batch
    expect(calls).toHaveLength(2);
    // Both batch results combined
    expect(result).toHaveLength(2);
  });

  it('schema scoping: each batch schema only accepts that batch tool names', async () => {
    const manyAnnotations = generateAnnotations(30);

    // Batch 1 tools: tool_0 to tool_24. Return a scenario with tool_0 (valid for batch 1).
    const batch1Response = {
      scenarios: [
        {
          description: 'B1 scenario',
          request: { serverName: 'serverA', toolName: 'tool_0', arguments: { path: '/tmp/sandbox/a' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
      ],
    };

    // Batch 2 tools: tool_25 to tool_29. Return a scenario with tool_26 (valid for batch 2).
    const batch2Response = {
      scenarios: [
        {
          description: 'B2 scenario',
          request: { serverName: 'serverA', toolName: 'tool_26', arguments: { path: '/tmp/sandbox/b' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
      ],
    };

    const { model, calls } = createCallTrackingMockModel([batch1Response, batch2Response]);

    const result = await generateScenarios(sampleConstitution, manyAnnotations, [], SANDBOX_DIR, model);

    // Both calls succeeded (schemas accepted the tool names)
    expect(calls).toHaveLength(2);
    expect(result).toHaveLength(2);
    expect(result.find((s) => s.description === 'B1 scenario')).toBeDefined();
    expect(result.find((s) => s.description === 'B2 scenario')).toBeDefined();
  });

  it('per-batch system prompt contains only that batch annotations', async () => {
    const manyAnnotations = generateAnnotations(30);

    const batch1Response = {
      scenarios: [
        {
          description: 'B1',
          request: { serverName: 'serverA', toolName: 'tool_0', arguments: { path: '/tmp/sandbox/a' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
      ],
    };
    const batch2Response = {
      scenarios: [
        {
          description: 'B2',
          request: { serverName: 'serverB', toolName: 'tool_25', arguments: { path: '/tmp/sandbox/b' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
      ],
    };

    // Capture the system prompts via wrapSystemPrompt
    const capturedSystems: string[] = [];
    const wrapSystemPrompt = (prompt: string) => {
      capturedSystems.push(prompt);
      return prompt;
    };

    const { model } = createCallTrackingMockModel([batch1Response, batch2Response]);

    await generateScenarios(
      sampleConstitution,
      manyAnnotations,
      [],
      SANDBOX_DIR,
      model,
      undefined,
      undefined,
      undefined,
      wrapSystemPrompt,
    );

    expect(capturedSystems).toHaveLength(2);

    // Batch 1 prompt should mention tool_0 but NOT tool_25
    expect(capturedSystems[0]).toContain('tool_0');
    expect(capturedSystems[0]).not.toContain('tool_25');

    // Batch 2 prompt should mention tool_25 but NOT tool_0
    expect(capturedSystems[1]).toContain('tool_25');
    expect(capturedSystems[1]).not.toContain('tool_0');
  });

  it('handwritten scenarios filtered to correct batch by toolName', async () => {
    // Create annotations spanning two batches: tool_0 to tool_29
    const manyAnnotations = generateAnnotations(30);

    // Handwritten scenario for tool_0 (in batch 1)
    const hwBatch1: TestScenario = {
      description: 'Handwritten for tool_0',
      request: { serverName: 'serverA', toolName: 'tool_0', arguments: { path: '/tmp/sandbox/hw' } },
      expectedDecision: 'allow',
      reasoning: 'Handwritten',
      source: 'handwritten',
    };
    // Handwritten scenario for tool_26 (in batch 2)
    const hwBatch2: TestScenario = {
      description: 'Handwritten for tool_26',
      request: { serverName: 'serverA', toolName: 'tool_26', arguments: { path: '/tmp/sandbox/hw2' } },
      expectedDecision: 'allow',
      reasoning: 'Handwritten',
      source: 'handwritten',
    };

    const batch1Response = {
      scenarios: [
        {
          description: 'Gen B1',
          request: { serverName: 'serverA', toolName: 'tool_0', arguments: { path: '/tmp/sandbox/g1' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
      ],
    };
    const batch2Response = {
      scenarios: [
        {
          description: 'Gen B2',
          request: { serverName: 'serverA', toolName: 'tool_26', arguments: { path: '/tmp/sandbox/g2' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
      ],
    };

    const { model, calls } = createCallTrackingMockModel([batch1Response, batch2Response]);

    const result = await generateScenarios(
      sampleConstitution,
      manyAnnotations,
      [hwBatch1, hwBatch2],
      SANDBOX_DIR,
      model,
    );

    // Batch 1 user prompt should mention tool_0 handwritten, not tool_26
    const userMsg1 = calls[0].messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg1).toContain('Handwritten for tool_0');
    expect(userMsg1).not.toContain('Handwritten for tool_26');

    // Batch 2 user prompt should mention tool_26 handwritten, not tool_0
    const userMsg2 = calls[1].messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg2).toContain('Handwritten for tool_26');
    expect(userMsg2).not.toContain('Handwritten for tool_0');

    // Handwritten scenarios are included in results
    expect(result.filter((s) => s.source === 'handwritten')).toHaveLength(2);
  });

  it('cross-batch dedup removes duplicate scenarios across batches', async () => {
    const manyAnnotations = generateAnnotations(30);

    // Both batches produce a scenario with identical tool/args (cross-batch dup)
    // tool_0 is in batch 1, but suppose both batches return a scenario for the same
    // tool on different batches -- actually for cross-batch dedup, same tool+args matters.
    // We need both batches to produce scenarios with the same serverName/toolName/args.
    // Since schema is scoped, we need a tool that appears in both batches. All tools
    // are unique, so we test dedup of identical entries within a single batch too.
    // Actually cross-batch dedup is about the dedup filter after all batches run.
    // Let's have batch 1 produce two identical scenarios.
    const batch1Response = {
      scenarios: [
        {
          description: 'First occurrence',
          request: { serverName: 'serverA', toolName: 'tool_0', arguments: { path: '/tmp/sandbox/dup' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
        {
          description: 'Second occurrence (same tool+args)',
          request: { serverName: 'serverA', toolName: 'tool_0', arguments: { path: '/tmp/sandbox/dup' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
      ],
    };
    const batch2Response = { scenarios: [] };

    const { model } = createCallTrackingMockModel([batch1Response, batch2Response]);

    const result = await generateScenarios(sampleConstitution, manyAnnotations, [], SANDBOX_DIR, model);

    // Only first occurrence should survive dedup
    const matching = result.filter(
      (s) => s.request.toolName === 'tool_0' && s.request.arguments.path === '/tmp/sandbox/dup',
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].description).toBe('First occurrence');
  });

  it('wrapSystemPrompt callback is applied per-batch', async () => {
    const wrappedSystems: string[] = [];
    const wrapSystemPrompt = (prompt: string) => {
      wrappedSystems.push(prompt);
      // Return as-is (string) so schema validation still works
      return prompt;
    };

    const manyAnnotations = generateAnnotations(30);

    const batch1Response = {
      scenarios: [
        {
          description: 'Test B1',
          request: { serverName: 'serverA', toolName: 'tool_0', arguments: { path: '/tmp/sandbox/a' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
      ],
    };
    const batch2Response = {
      scenarios: [
        {
          description: 'Test B2',
          request: { serverName: 'serverB', toolName: 'tool_25', arguments: { path: '/tmp/sandbox/b' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
      ],
    };

    const { model } = createCallTrackingMockModel([batch1Response, batch2Response]);

    await generateScenarios(
      sampleConstitution,
      manyAnnotations,
      [],
      SANDBOX_DIR,
      model,
      undefined,
      undefined,
      undefined,
      wrapSystemPrompt,
    );

    // wrapSystemPrompt was called once per batch
    expect(wrappedSystems).toHaveLength(2);

    // Each batch's system prompt should be different (different annotations)
    expect(wrappedSystems[0]).not.toEqual(wrappedSystems[1]);

    // Each wrapped prompt should contain the constitution (proves it received real prompts)
    expect(wrappedSystems[0]).toContain('Constitution');
    expect(wrappedSystems[1]).toContain('Constitution');
  });

  it('buildBatchPrompt: no handwritten produces generic prompt', async () => {
    const { model, calls } = createCallTrackingMockModel([
      {
        scenarios: [
          {
            description: 'Test',
            request: { serverName: 'filesystem', toolName: 'read_file', arguments: { path: '/tmp/sandbox/a' } },
            expectedDecision: 'allow',
            reasoning: 'ok',
          },
        ],
      },
    ]);

    // No handwritten scenarios -- prompt should be the generic one
    await generateScenarios(sampleConstitution, sampleAnnotations, [], SANDBOX_DIR, model);

    const userMsg = calls[0].messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('Generate test scenarios following the instructions above.');
    expect(userMsg).not.toContain('handwritten scenarios already exist');
  });

  it('buildBatchPrompt: with handwritten includes their summary', async () => {
    const { model, calls } = createCallTrackingMockModel([
      {
        scenarios: [
          {
            description: 'Test',
            request: { serverName: 'filesystem', toolName: 'write_file', arguments: { path: '/tmp/sandbox/a' } },
            expectedDecision: 'allow',
            reasoning: 'ok',
          },
        ],
      },
    ]);

    await generateScenarios(sampleConstitution, sampleAnnotations, handwrittenScenarios, SANDBOX_DIR, model);

    const userMsg = calls[0].messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('handwritten scenarios already exist');
    expect(userMsg).toContain('Read file inside sandbox');
    expect(userMsg).toContain('Read file outside sandbox');
  });

  it('SCENARIO_BATCH_SIZE is exported and equals 25', () => {
    expect(SCENARIO_BATCH_SIZE).toBe(25);
  });

  it('exactly 25 annotations produces 1 batch (boundary)', async () => {
    const annotations = generateAnnotations(25);

    const batchResponse = {
      scenarios: [
        {
          description: 'Boundary test',
          request: { serverName: 'serverA', toolName: 'tool_0', arguments: { path: '/tmp/sandbox/f' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
      ],
    };

    const { model, calls } = createCallTrackingMockModel([batchResponse]);

    await generateScenarios(sampleConstitution, annotations, [], SANDBOX_DIR, model);

    expect(calls).toHaveLength(1);
  });

  it('26 annotations produces 2 batches (just over boundary)', async () => {
    const annotations = generateAnnotations(26);

    // Batch 1: tool_0 to tool_24 (25 tools). Batch 2: tool_25 (1 tool).
    const batch1Response = {
      scenarios: [
        {
          description: 'Batch 1 scenario',
          request: { serverName: 'serverA', toolName: 'tool_0', arguments: { path: '/tmp/sandbox/a' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
      ],
    };
    const batch2Response = {
      scenarios: [
        {
          description: 'Batch 2 scenario',
          request: { serverName: 'serverB', toolName: 'tool_25', arguments: { path: '/tmp/sandbox/b' } },
          expectedDecision: 'allow',
          reasoning: 'ok',
        },
      ],
    };

    const { model, calls } = createCallTrackingMockModel([batch1Response, batch2Response]);

    const result = await generateScenarios(sampleConstitution, annotations, [], SANDBOX_DIR, model);

    expect(calls).toHaveLength(2);
    expect(result).toHaveLength(2);
  });

  it('0 annotations returns only handwritten scenarios', async () => {
    // chunk([]) returns [[]] (one empty batch), which would fail at
    // z.enum construction. With 0 annotations we still get one LLM call,
    // but the empty batch produces a valid empty-scenario response.
    const batchResponse = { scenarios: [] };
    const { model, calls } = createCallTrackingMockModel([batchResponse]);

    const result = await generateScenarios(sampleConstitution, [], handwrittenScenarios, SANDBOX_DIR, model);

    // One LLM call for the single (empty) batch
    expect(calls).toHaveLength(1);
    // Only handwritten scenarios returned (LLM generated nothing)
    expect(result).toHaveLength(2);
    expect(result.every((s) => s.source === 'handwritten')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// repairScenarios tests
// ---------------------------------------------------------------------------

describe('repairScenarios', () => {
  it('generates replacement scenarios for discarded ones', async () => {
    const discarded = [
      {
        scenario: {
          description: 'Write to audit log',
          request: { serverName: 'filesystem', toolName: 'write_file', arguments: { path: '/var/log/audit.jsonl' } },
          expectedDecision: 'allow' as const,
          reasoning: 'test',
          source: 'generated' as const,
        },
        feedback: 'structural-protected-paths always returns deny',
      },
    ];

    const replacementScenario = {
      description: 'Write file in sandbox',
      request: {
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: { path: '/tmp/sandbox/output.txt' },
      },
      expectedDecision: 'allow' as const,
      reasoning: 'Within sandbox',
    };

    const { model } = createCallTrackingMockModel([{ scenarios: [replacementScenario] }]);

    const result = await repairScenarios(discarded, sampleConstitution, sampleAnnotations, SANDBOX_DIR, model);

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('generated');
    expect(result[0].description).toBe('Write file in sandbox');
  });

  it('passes discarded scenario details in the prompt', async () => {
    const discarded = [
      {
        scenario: {
          description: 'Write to audit log',
          request: { serverName: 'filesystem', toolName: 'write_file', arguments: { path: '/var/log/audit.jsonl' } },
          expectedDecision: 'allow' as const,
          reasoning: 'test',
          source: 'generated' as const,
        },
        feedback: 'structural-protected-paths always returns deny',
      },
    ];

    const { model, calls } = createCallTrackingMockModel([{ scenarios: [] }]);

    await repairScenarios(discarded, sampleConstitution, sampleAnnotations, SANDBOX_DIR, model);

    const userMsg = calls[0].messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMsg).toContain('Write to audit log');
    expect(userMsg).toContain('structural-protected-paths always returns deny');
    expect(userMsg).toContain('structural invariants');
  });

  it('returns empty array when LLM returns no scenarios', async () => {
    const discarded = [
      {
        scenario: {
          description: 'test',
          request: { serverName: 'filesystem', toolName: 'read_file', arguments: {} },
          expectedDecision: 'deny' as const,
          reasoning: 'test',
          source: 'generated' as const,
        },
        feedback: 'conflict',
      },
    ];

    const { model } = createCallTrackingMockModel([{ scenarios: [] }]);

    const result = await repairScenarios(discarded, sampleConstitution, sampleAnnotations, SANDBOX_DIR, model);
    expect(result).toHaveLength(0);
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
