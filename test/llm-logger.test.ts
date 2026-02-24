import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { wrapLanguageModel, generateText, Output } from 'ai';
import { z } from 'zod';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLlmLoggingMiddleware, type LlmLogContext, type LlmLogEntry } from '../src/pipeline/llm-logger.js';

const TEST_DIR = resolve('/tmp', `llm-logger-test-${process.pid}`);
const LOG_PATH = resolve(TEST_DIR, 'test-interactions.jsonl');

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

function readLogEntries(): LlmLogEntry[] {
  const content = readFileSync(LOG_PATH, 'utf-8').trim();
  if (content === '') return [];
  return content.split('\n').map((line) => JSON.parse(line));
}

describe('LLM Logger Middleware', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates the log file on initialization', () => {
    const context: LlmLogContext = { stepName: 'test-step' };
    createLlmLoggingMiddleware(LOG_PATH, context);
    expect(existsSync(LOG_PATH)).toBe(true);
  });

  it('logs a single generateText call', async () => {
    const context: LlmLogContext = { stepName: 'annotate-filesystem' };
    const mockModel = createMockModel({ greeting: 'hello' });
    const wrappedModel = wrapLanguageModel({
      model: mockModel,
      middleware: createLlmLoggingMiddleware(LOG_PATH, context),
    });

    await generateText({
      model: wrappedModel,
      output: Output.object({ schema: z.object({ greeting: z.string() }) }),
      prompt: 'Say hello',
    });

    const entries = readLogEntries();
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.stepName).toBe('annotate-filesystem');
    expect(entry.modelId).toBe('mock-model-id');
    expect(entry.responseText).toBe(JSON.stringify({ greeting: 'hello' }));
    expect(entry.usage.inputTokens).toBe(100);
    expect(entry.usage.outputTokens).toBe(50);
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.timestamp).toBeTruthy();
    expect(entry.prompt).toBeTruthy();
    expect(entry.promptOffset).toBe(0);
  });

  it('logs multiple calls with different step names', async () => {
    const context: LlmLogContext = { stepName: 'step-1' };
    const mockModel = createMockModel({ result: 'ok' });
    const wrappedModel = wrapLanguageModel({
      model: mockModel,
      middleware: createLlmLoggingMiddleware(LOG_PATH, context),
    });

    const schema = z.object({ result: z.string() });

    await generateText({
      model: wrappedModel,
      output: Output.object({ schema }),
      prompt: 'First call',
    });

    context.stepName = 'step-2';
    await generateText({
      model: wrappedModel,
      output: Output.object({ schema }),
      prompt: 'Second call',
    });

    const entries = readLogEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0].stepName).toBe('step-1');
    expect(entries[1].stepName).toBe('step-2');
  });

  it('truncates log file on creation to avoid mixing with previous runs', async () => {
    const context: LlmLogContext = { stepName: 'old-step' };
    const mockModel = createMockModel({ value: 1 });
    const schema = z.object({ value: z.number() });

    // First run: write one entry
    const wrapped1 = wrapLanguageModel({
      model: mockModel,
      middleware: createLlmLoggingMiddleware(LOG_PATH, context),
    });
    await generateText({
      model: wrapped1,
      output: Output.object({ schema }),
      prompt: 'Old run',
    });
    expect(readLogEntries()).toHaveLength(1);

    // Second run: creating a new middleware truncates the file
    context.stepName = 'new-step';
    const wrapped2 = wrapLanguageModel({
      model: mockModel,
      middleware: createLlmLoggingMiddleware(LOG_PATH, context),
    });
    await generateText({
      model: wrapped2,
      output: Output.object({ schema }),
      prompt: 'New run',
    });

    const entries = readLogEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].stepName).toBe('new-step');
  });

  it('uses delta logging with promptOffset for growing message histories', async () => {
    const context: LlmLogContext = { stepName: 'agent' };
    const mockModel = createMockModel({ ok: true });
    const wrappedModel = wrapLanguageModel({
      model: mockModel,
      middleware: createLlmLoggingMiddleware(LOG_PATH, context, { deltaLogging: true }),
    });

    // Simulate the agent pattern: each call sends the full growing history,
    // but the logger should only record the new messages.
    const messages: Array<{ role: string; content: string }> = [];

    messages.push({ role: 'user', content: 'Hello' });
    await generateText({
      model: wrappedModel,
      messages: messages as Parameters<typeof generateText>[0]['messages'],
    });

    // Simulate assistant response + next user message being added
    messages.push({ role: 'assistant', content: 'Hi there' });
    messages.push({ role: 'user', content: 'What is 2+2?' });
    await generateText({
      model: wrappedModel,
      messages: messages as Parameters<typeof generateText>[0]['messages'],
    });

    const entries = readLogEntries();
    expect(entries).toHaveLength(2);

    // First entry: full prompt at offset 0
    expect(entries[0].promptOffset).toBe(0);

    // Second entry: only the new messages, offset past the first entry's messages
    expect(entries[1].promptOffset).toBeGreaterThan(0);

    // The second entry's prompt should NOT contain the first user message
    const secondPromptStr = JSON.stringify(entries[1].prompt);
    expect(secondPromptStr).not.toContain('Hello');
    expect(secondPromptStr).toContain('What is 2+2?');
  });

  it('captures prompt content in the log entry', async () => {
    const context: LlmLogContext = { stepName: 'test' };
    const mockModel = createMockModel({ ok: true });
    const wrappedModel = wrapLanguageModel({
      model: mockModel,
      middleware: createLlmLoggingMiddleware(LOG_PATH, context),
    });

    await generateText({
      model: wrappedModel,
      output: Output.object({ schema: z.object({ ok: z.boolean() }) }),
      prompt: 'Test prompt content',
    });

    const entries = readLogEntries();
    const promptStr = JSON.stringify(entries[0].prompt);
    expect(promptStr).toContain('Test prompt content');
  });
});
