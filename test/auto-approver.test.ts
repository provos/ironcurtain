import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  autoApprove,
  readUserContext,
  type AutoApproveContext,
} from '../src/trusted-process/auto-approver.js';

// ---------------------------------------------------------------------------
// Mock model factory
// ---------------------------------------------------------------------------

function createMockModel(
  response: { decision: string; reasoning: string },
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 50, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: undefined, reasoning: undefined },
      },
      warnings: [],
      request: {},
      response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
    }),
  });
}

function createErrorModel(errorMessage: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error(errorMessage);
    },
  });
}

// ---------------------------------------------------------------------------
// autoApprove() tests
// ---------------------------------------------------------------------------

describe('autoApprove', () => {
  const baseContext: AutoApproveContext = {
    userMessage: 'push my changes to origin',
    toolName: 'git/git_push',
    escalationReason: 'Push operations require explicit authorization',
  };

  describe('clear approval cases', () => {
    it('returns approve when LLM approves', async () => {
      const model = createMockModel({
        decision: 'approve',
        reasoning: 'User explicitly requested push to origin',
      });

      const result = await autoApprove(baseContext, model);

      expect(result.decision).toBe('approve');
      expect(result.reasoning).toBe('User explicitly requested push to origin');
    });
  });

  describe('clear escalation cases', () => {
    it('returns escalate when LLM escalates', async () => {
      const model = createMockModel({
        decision: 'escalate',
        reasoning: 'User message does not authorize this specific action',
      });

      const result = await autoApprove(
        { ...baseContext, userMessage: 'fix the failing tests' },
        model,
      );

      expect(result.decision).toBe('escalate');
      expect(result.reasoning).toBe('User message does not authorize this specific action');
    });
  });

  describe('empty user message', () => {
    it('returns escalate without calling the LLM', async () => {
      const model = createMockModel({
        decision: 'approve',
        reasoning: 'should not reach here',
      });

      const result = await autoApprove(
        { ...baseContext, userMessage: '' },
        model,
      );

      expect(result.decision).toBe('escalate');
      expect(result.reasoning).toContain('Empty user message');
    });

    it('returns escalate for whitespace-only message', async () => {
      const model = createMockModel({
        decision: 'approve',
        reasoning: 'should not reach here',
      });

      const result = await autoApprove(
        { ...baseContext, userMessage: '   \n\t  ' },
        model,
      );

      expect(result.decision).toBe('escalate');
      expect(result.reasoning).toContain('Empty user message');
    });
  });

  describe('LLM error handling', () => {
    it('returns escalate when LLM throws', async () => {
      const model = createErrorModel('Connection timeout');

      const result = await autoApprove(baseContext, model);

      expect(result.decision).toBe('escalate');
      expect(result.reasoning).toContain('Auto-approver error');
      expect(result.reasoning).toContain('Connection timeout');
    });
  });

  describe('malformed LLM response', () => {
    it('returns escalate when LLM returns unexpected decision value', async () => {
      // The Zod schema should reject 'deny' and fall through to error handling
      const model = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text' as const, text: JSON.stringify({ decision: 'deny', reasoning: 'bad' }) }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 50, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 20, text: undefined, reasoning: undefined },
          },
          warnings: [],
          request: {},
          response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
        }),
      });

      const result = await autoApprove(baseContext, model);

      // 'deny' is not in the enum, so Zod rejects it and experimental_output is null
      expect(result.decision).toBe('escalate');
    });

    it('returns escalate when LLM returns empty content', async () => {
      const model = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text' as const, text: '' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 50, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 0, text: undefined, reasoning: undefined },
          },
          warnings: [],
          request: {},
          response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
        }),
      });

      const result = await autoApprove(baseContext, model);

      expect(result.decision).toBe('escalate');
    });

    it('returns escalate when LLM returns non-JSON', async () => {
      const model = new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: 'text' as const, text: 'I approve this action.' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 50, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 20, text: undefined, reasoning: undefined },
          },
          warnings: [],
          request: {},
          response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
        }),
      });

      const result = await autoApprove(baseContext, model);

      expect(result.decision).toBe('escalate');
    });
  });

  describe('never denies', () => {
    it('decision is always approve or escalate', async () => {
      // Test that even with various inputs, the function never returns 'deny'
      const scenarios: AutoApproveContext[] = [
        { userMessage: 'push my code', toolName: 'git/git_push', escalationReason: 'push op' },
        { userMessage: 'fix tests', toolName: 'fs/read_file', escalationReason: 'outside sandbox' },
        { userMessage: '', toolName: 'fs/delete_file', escalationReason: 'destructive' },
      ];

      for (const ctx of scenarios) {
        const model = createMockModel({
          decision: 'escalate',
          reasoning: 'test',
        });
        const result = await autoApprove(ctx, model);
        expect(['approve', 'escalate']).toContain(result.decision);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// readUserContext() tests
// ---------------------------------------------------------------------------

describe('readUserContext', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'ironcurtain-autoapprove-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads user message from valid user-context.json', () => {
    writeFileSync(
      resolve(tempDir, 'user-context.json'),
      JSON.stringify({ userMessage: 'push to origin' }),
    );

    expect(readUserContext(tempDir)).toBe('push to origin');
  });

  it('returns null when file does not exist', () => {
    expect(readUserContext(tempDir)).toBeNull();
  });

  it('returns null when directory does not exist', () => {
    expect(readUserContext(resolve(tempDir, 'nonexistent'))).toBeNull();
  });

  it('returns null when JSON is malformed', () => {
    writeFileSync(resolve(tempDir, 'user-context.json'), '{ invalid json }');

    expect(readUserContext(tempDir)).toBeNull();
  });

  it('returns null when userMessage is not a string', () => {
    writeFileSync(
      resolve(tempDir, 'user-context.json'),
      JSON.stringify({ userMessage: 123 }),
    );

    expect(readUserContext(tempDir)).toBeNull();
  });

  it('returns null when userMessage is missing', () => {
    writeFileSync(
      resolve(tempDir, 'user-context.json'),
      JSON.stringify({ otherField: 'value' }),
    );

    expect(readUserContext(tempDir)).toBeNull();
  });

  it('returns null when userMessage is empty string', () => {
    writeFileSync(
      resolve(tempDir, 'user-context.json'),
      JSON.stringify({ userMessage: '' }),
    );

    expect(readUserContext(tempDir)).toBeNull();
  });

  it('returns null when userMessage is whitespace only', () => {
    writeFileSync(
      resolve(tempDir, 'user-context.json'),
      JSON.stringify({ userMessage: '   ' }),
    );

    expect(readUserContext(tempDir)).toBeNull();
  });
});
