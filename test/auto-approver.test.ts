import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  autoApprove,
  extractArgsForAutoApprove,
  readUserContext,
  sanitizeForPrompt,
  type AutoApproveContext,
} from '../src/trusted-process/auto-approver.js';
import type { ToolAnnotation } from '../src/pipeline/types.js';

// ---------------------------------------------------------------------------
// Mock model factory
// ---------------------------------------------------------------------------

function createMockModel(response: { decision: string; reasoning: string }): MockLanguageModelV3 {
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
// sanitizeForPrompt() tests
// ---------------------------------------------------------------------------

describe('sanitizeForPrompt', () => {
  it('passes through clean strings unchanged', () => {
    expect(sanitizeForPrompt('/home/user/Documents/notes.txt')).toBe('/home/user/Documents/notes.txt');
  });

  it('strips control characters', () => {
    expect(sanitizeForPrompt('hello\nworld\t!')).toBe('helloworld!');
    expect(sanitizeForPrompt('test\x00value')).toBe('testvalue');
  });

  it('strips C1 control characters', () => {
    expect(sanitizeForPrompt('a\x80b\x9fc')).toBe('abc');
  });

  it('truncates long values to 200 chars with ellipsis', () => {
    const long = 'a'.repeat(250);
    const result = sanitizeForPrompt(long);
    expect(result).toBe('a'.repeat(200) + '...');
    expect(result.length).toBe(203);
  });

  it('does not truncate values at exactly 200 chars', () => {
    const exact = 'x'.repeat(200);
    expect(sanitizeForPrompt(exact)).toBe(exact);
  });
});

// ---------------------------------------------------------------------------
// extractArgsForAutoApprove() tests
// ---------------------------------------------------------------------------

describe('extractArgsForAutoApprove', () => {
  const baseAnnotation: ToolAnnotation = {
    toolName: 'read_file',
    serverName: 'filesystem',
    comment: 'Reads a file',
    sideEffects: false,
    args: {
      path: ['read-path'],
    },
  };

  it('returns undefined when annotation is undefined', () => {
    expect(extractArgsForAutoApprove({ path: '/tmp/test' }, undefined)).toBeUndefined();
  });

  it('returns undefined when no resource-identifier args exist', () => {
    const annotation: ToolAnnotation = {
      ...baseAnnotation,
      args: { message: ['commit-message'] },
    };
    expect(extractArgsForAutoApprove({ message: 'fix bug' }, annotation)).toBeUndefined();
  });

  it('includes path args with their values', () => {
    const result = extractArgsForAutoApprove({ path: '/home/user/file.txt' }, baseAnnotation);
    expect(result).toEqual({ path: '/home/user/file.txt' });
  });

  it('includes write-path args', () => {
    const annotation: ToolAnnotation = {
      ...baseAnnotation,
      args: { destination: ['write-path'] },
    };
    const result = extractArgsForAutoApprove({ destination: '/home/user/output.txt' }, annotation);
    expect(result).toEqual({ destination: '/home/user/output.txt' });
  });

  it('excludes none role args', () => {
    const annotation: ToolAnnotation = {
      ...baseAnnotation,
      args: {
        path: ['read-path'],
        recursive: ['none'],
      },
    };
    const result = extractArgsForAutoApprove({ path: '/tmp/test', recursive: 'true' }, annotation);
    expect(result).toEqual({ path: '/tmp/test' });
  });

  it('excludes opaque roles (commit-message, branch-name)', () => {
    const annotation: ToolAnnotation = {
      ...baseAnnotation,
      args: {
        path: ['read-path'],
        message: ['commit-message'],
        branch: ['branch-name'],
      },
    };
    const result = extractArgsForAutoApprove(
      { path: '/tmp/repo', message: 'fix: something', branch: 'main' },
      annotation,
    );
    expect(result).toEqual({ path: '/tmp/repo' });
  });

  it('extracts domain for URL roles', () => {
    const annotation: ToolAnnotation = {
      ...baseAnnotation,
      toolName: 'fetch',
      serverName: 'fetch',
      args: { url: ['fetch-url'] },
    };
    const result = extractArgsForAutoApprove({ url: 'https://example.com/api/data' }, annotation);
    expect(result).toEqual({ url: 'example.com' });
  });

  it('handles string array values by joining with comma', () => {
    const annotation: ToolAnnotation = {
      ...baseAnnotation,
      args: { paths: ['read-path'] },
    };
    const result = extractArgsForAutoApprove({ paths: ['/tmp/a.txt', '/tmp/b.txt'] }, annotation);
    expect(result).toEqual({ paths: '/tmp/a.txt, /tmp/b.txt' });
  });

  it('sanitizes control characters in values', () => {
    const result = extractArgsForAutoApprove({ path: '/tmp/file\x00name.txt' }, baseAnnotation);
    expect(result).toEqual({ path: '/tmp/filename.txt' });
  });

  it('skips non-string, non-array values', () => {
    const result = extractArgsForAutoApprove({ path: 42 }, baseAnnotation);
    expect(result).toBeUndefined();
  });

  it('skips args not present in annotation', () => {
    const result = extractArgsForAutoApprove({ path: '/tmp/test', unknownArg: 'value' }, baseAnnotation);
    expect(result).toEqual({ path: '/tmp/test' });
  });

  it('skips empty string arrays', () => {
    const annotation: ToolAnnotation = {
      ...baseAnnotation,
      args: { paths: ['read-path'] },
    };
    const result = extractArgsForAutoApprove({ paths: [123, true] }, annotation);
    expect(result).toBeUndefined();
  });
});

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

      const result = await autoApprove({ ...baseContext, userMessage: 'fix the failing tests' }, model);

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

      const result = await autoApprove({ ...baseContext, userMessage: '' }, model);

      expect(result.decision).toBe('escalate');
      expect(result.reasoning).toContain('Empty user message');
    });

    it('returns escalate for whitespace-only message', async () => {
      const model = createMockModel({
        decision: 'approve',
        reasoning: 'should not reach here',
      });

      const result = await autoApprove({ ...baseContext, userMessage: '   \n\t  ' }, model);

      expect(result.decision).toBe('escalate');
      expect(result.reasoning).toContain('Empty user message');
    });
  });

  describe('with arguments', () => {
    it('includes arguments in the prompt when provided', async () => {
      let capturedPrompt = '';
      const model = new MockLanguageModelV3({
        doGenerate: async ({ prompt }) => {
          // Capture the prompt to verify arguments are included
          if (Array.isArray(prompt)) {
            for (const msg of prompt) {
              if (msg.role === 'user' && Array.isArray(msg.content)) {
                for (const part of msg.content) {
                  if ('text' in part) capturedPrompt += part.text;
                }
              }
            }
          }
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ decision: 'approve', reasoning: 'path matches' }) },
            ],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 50, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 20, text: undefined, reasoning: undefined },
            },
            warnings: [],
            request: {},
            response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
          };
        },
      });

      await autoApprove(
        {
          ...baseContext,
          arguments: { path: '/home/user/notes.txt' },
        },
        model,
      );

      expect(capturedPrompt).toContain('Tool arguments (resource identifiers only)');
      expect(capturedPrompt).toContain('path: /home/user/notes.txt');
    });

    it('works without arguments (backward compatible)', async () => {
      const model = createMockModel({
        decision: 'approve',
        reasoning: 'User explicitly requested push',
      });

      const result = await autoApprove(baseContext, model);
      expect(result.decision).toBe('approve');
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
    writeFileSync(resolve(tempDir, 'user-context.json'), JSON.stringify({ userMessage: 'push to origin' }));

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
    writeFileSync(resolve(tempDir, 'user-context.json'), JSON.stringify({ userMessage: 123 }));

    expect(readUserContext(tempDir)).toBeNull();
  });

  it('returns null when userMessage is missing', () => {
    writeFileSync(resolve(tempDir, 'user-context.json'), JSON.stringify({ otherField: 'value' }));

    expect(readUserContext(tempDir)).toBeNull();
  });

  it('returns null when userMessage is empty string', () => {
    writeFileSync(resolve(tempDir, 'user-context.json'), JSON.stringify({ userMessage: '' }));

    expect(readUserContext(tempDir)).toBeNull();
  });

  it('returns null when userMessage is whitespace only', () => {
    writeFileSync(resolve(tempDir, 'user-context.json'), JSON.stringify({ userMessage: '   ' }));

    expect(readUserContext(tempDir)).toBeNull();
  });
});
