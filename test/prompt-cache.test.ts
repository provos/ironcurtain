import { describe, it, expect } from 'vitest';
import { AnthropicCacheStrategy, NoOpCacheStrategy, createCacheStrategy } from '../src/session/prompt-cache.js';
import { tool, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';

const EXPECTED_CACHE_CONTROL = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
};

describe('createCacheStrategy', () => {
  it('returns AnthropicCacheStrategy for anthropic provider', () => {
    expect(createCacheStrategy('anthropic:claude-sonnet-4-6')).toBeInstanceOf(AnthropicCacheStrategy);
  });

  it('returns AnthropicCacheStrategy for bare model ID (defaults to anthropic)', () => {
    expect(createCacheStrategy('claude-sonnet-4-6')).toBeInstanceOf(AnthropicCacheStrategy);
  });

  it('returns NoOpCacheStrategy for openai provider', () => {
    expect(createCacheStrategy('openai:gpt-4o')).toBeInstanceOf(NoOpCacheStrategy);
  });

  it('returns NoOpCacheStrategy for google provider', () => {
    expect(createCacheStrategy('google:gemini-2.0-flash')).toBeInstanceOf(NoOpCacheStrategy);
  });
});

describe('AnthropicCacheStrategy', () => {
  const strategy = new AnthropicCacheStrategy();

  describe('wrapSystemPrompt', () => {
    it('returns a SystemModelMessage with cacheControl', () => {
      const result = strategy.wrapSystemPrompt('You are a helpful assistant.');
      expect(result).toEqual({
        role: 'system',
        content: 'You are a helpful assistant.',
        providerOptions: EXPECTED_CACHE_CONTROL,
      });
    });
  });

  describe('wrapTools', () => {
    it('adds providerOptions to each tool', () => {
      const tools: ToolSet = {
        execute_code: tool({
          description: 'Run code',
          inputSchema: z.object({ code: z.string() }),
        }),
      };

      const wrapped = strategy.wrapTools(tools);

      expect(wrapped.execute_code).toBeDefined();
      expect((wrapped.execute_code as Record<string, unknown>).providerOptions).toEqual(EXPECTED_CACHE_CONTROL);
      // Original is not mutated
      expect((tools.execute_code as Record<string, unknown>).providerOptions).toBeUndefined();
    });
  });

  describe('applyHistoryBreakpoint', () => {
    it('marks the second-to-last message with cacheControl', () => {
      const messages: ModelMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
        { role: 'user', content: 'How are you?' },
      ];

      const result = strategy.applyHistoryBreakpoint(messages);

      expect(result).toHaveLength(3);
      // Second-to-last (index 1) gets cacheControl
      expect(result[1].providerOptions).toEqual(EXPECTED_CACHE_CONTROL);
      // Others are unchanged
      expect(result[0].providerOptions).toBeUndefined();
      expect(result[2].providerOptions).toBeUndefined();
    });

    it('does not mutate the original messages array', () => {
      const messages: ModelMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
        { role: 'user', content: 'Bye' },
      ];
      const originalRef = messages[1];

      strategy.applyHistoryBreakpoint(messages);

      // Original array element is not mutated
      expect(originalRef.providerOptions).toBeUndefined();
      expect(messages).toHaveLength(3);
    });

    it('does not add breakpoint for a single message', () => {
      const messages: ModelMessage[] = [{ role: 'user', content: 'Hello' }];

      const result = strategy.applyHistoryBreakpoint(messages);

      expect(result).toHaveLength(1);
      expect(result[0].providerOptions).toBeUndefined();
    });

    it('returns a copy for empty array', () => {
      const messages: ModelMessage[] = [];

      const result = strategy.applyHistoryBreakpoint(messages);

      expect(result).toHaveLength(0);
      expect(result).not.toBe(messages);
    });

    it('merges with existing providerOptions on the target message', () => {
      const messages: ModelMessage[] = [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi!' }],
          providerOptions: { anthropic: { someOther: true } },
        },
        { role: 'user', content: 'Bye' },
      ];

      const result = strategy.applyHistoryBreakpoint(messages);

      // The anthropic key is overwritten by the cache-control spread
      expect(result[1].providerOptions).toEqual(EXPECTED_CACHE_CONTROL);
    });
  });
});

describe('NoOpCacheStrategy', () => {
  const strategy = new NoOpCacheStrategy();

  it('returns system prompt unchanged', () => {
    const prompt = 'You are a helpful assistant.';
    expect(strategy.wrapSystemPrompt(prompt)).toBe(prompt);
  });

  it('returns tools unchanged', () => {
    const tools: ToolSet = {
      execute_code: tool({
        description: 'Run code',
        inputSchema: z.object({ code: z.string() }),
      }),
    };
    expect(strategy.wrapTools(tools)).toBe(tools);
  });

  it('returns a copy of messages without modifications', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
    ];

    const result = strategy.applyHistoryBreakpoint(messages);

    expect(result).toHaveLength(2);
    expect(result).not.toBe(messages); // new array
    expect(result[0]).toBe(messages[0]); // same references (no mutation)
    expect(result[1]).toBe(messages[1]);
  });
});
