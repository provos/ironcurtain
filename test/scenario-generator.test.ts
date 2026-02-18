import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateScenarios } from '../src/pipeline/scenario-generator.js';
import type { ToolAnnotation, TestScenario } from '../src/pipeline/types.js';

const sampleAnnotations: ToolAnnotation[] = [
  {
    toolName: 'read_file', serverName: 'filesystem',
    comment: 'Reads the complete contents of a file from disk', sideEffects: true,
    args: { path: ['read-path'] },
  },
  {
    toolName: 'write_file', serverName: 'filesystem',
    comment: 'Creates or overwrites a file with new content', sideEffects: true,
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
const PROTECTED_PATHS = ['/home/test/config/constitution.md', '/home/test/config/generated'];

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
      PROTECTED_PATHS,
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
      PROTECTED_PATHS,
      mockLLM,
    );

    const generated = result.filter(s => s.source === 'generated');
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
      PROTECTED_PATHS,
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
      PROTECTED_PATHS,
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
      PROTECTED_PATHS,
      mockLLM,
    );

    // Only handwritten scenarios remain
    expect(result).toHaveLength(2);
    expect(result.every(s => s.source === 'handwritten')).toBe(true);
  });

  it('all scenarios have required fields', async () => {
    const mockLLM = createMockModel({ scenarios: llmGeneratedScenarios });

    const result = await generateScenarios(
      sampleConstitution,
      sampleAnnotations,
      handwrittenScenarios,
      SANDBOX_DIR,
      PROTECTED_PATHS,
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
