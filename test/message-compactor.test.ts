import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ModelMessage } from 'ai';
import type { ResolvedAutoCompactConfig, ResolvedUserConfig } from '../src/config/user-config.js';

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => 'mock-summary-model')),
}));

import { generateText } from 'ai';
import { MessageCompactor } from '../src/session/message-compactor.js';

const mockGenerateText = generateText as unknown as ReturnType<typeof vi.fn>;

function createConfig(overrides: Partial<ResolvedAutoCompactConfig> = {}): ResolvedAutoCompactConfig {
  return {
    enabled: true,
    thresholdTokens: 80_000,
    keepRecentMessages: 10,
    summaryModelId: 'anthropic:claude-haiku-4-5',
    ...overrides,
  };
}

function createUserConfig(): ResolvedUserConfig {
  return {
    agentModelId: 'anthropic:claude-sonnet-4-6',
    policyModelId: 'anthropic:claude-sonnet-4-6',
    anthropicApiKey: 'test-key',
    googleApiKey: '',
    openaiApiKey: '',
    escalationTimeoutSeconds: 300,
    resourceBudget: {
      maxTotalTokens: 1_000_000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5.00,
      warnThresholdPercent: 80,
    },
    autoCompact: createConfig(),
  };
}

/** Builds a conversation of N user/assistant message pairs. */
function buildMessages(count: number): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({ role: 'user', content: `user message ${i}` });
    messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: `assistant response ${i}` }],
    });
  }
  return messages;
}

describe('MessageCompactor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateText.mockResolvedValue({ text: 'Summary of conversation.' });
  });

  describe('shouldCompact', () => {
    it('returns false when disabled', () => {
      const compactor = new MessageCompactor(createConfig({ enabled: false }));
      compactor.recordInputTokens(100_000);
      expect(compactor.shouldCompact()).toBe(false);
    });

    it('returns false below threshold', () => {
      const compactor = new MessageCompactor(createConfig({ thresholdTokens: 80_000 }));
      compactor.recordInputTokens(79_999);
      expect(compactor.shouldCompact()).toBe(false);
    });

    it('returns false at exactly the threshold', () => {
      const compactor = new MessageCompactor(createConfig({ thresholdTokens: 80_000 }));
      compactor.recordInputTokens(80_000);
      expect(compactor.shouldCompact()).toBe(false);
    });

    it('returns true above threshold', () => {
      const compactor = new MessageCompactor(createConfig({ thresholdTokens: 80_000 }));
      compactor.recordInputTokens(80_001);
      expect(compactor.shouldCompact()).toBe(true);
    });

    it('returns false initially (no tokens recorded)', () => {
      const compactor = new MessageCompactor(createConfig());
      expect(compactor.shouldCompact()).toBe(false);
    });
  });

  describe('recordInputTokens', () => {
    it('updates internal state so shouldCompact reflects latest value', () => {
      const compactor = new MessageCompactor(createConfig({ thresholdTokens: 1000 }));

      compactor.recordInputTokens(500);
      expect(compactor.shouldCompact()).toBe(false);

      compactor.recordInputTokens(1500);
      expect(compactor.shouldCompact()).toBe(true);
    });
  });

  describe('compact', () => {
    it('returns null when too few messages to summarize', async () => {
      const compactor = new MessageCompactor(createConfig({ keepRecentMessages: 10 }));
      // 6 messages total, keep 10 -> splitIndex=0, nothing to summarize
      const messages = buildMessages(3);
      const result = await compactor.compact(messages, createUserConfig());
      expect(result).toBeNull();
    });

    it('returns null when splitIndex < 4', async () => {
      const compactor = new MessageCompactor(createConfig({ keepRecentMessages: 10 }));
      // 13 messages, keep 10 -> splitIndex=3, < MIN_MESSAGES_TO_COMPACT
      const messages: ModelMessage[] = [];
      for (let i = 0; i < 13; i++) {
        messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}` });
      }
      const result = await compactor.compact(messages, createUserConfig());
      expect(result).toBeNull();
    });

    it('produces summary message + keeps recent messages', async () => {
      const compactor = new MessageCompactor(createConfig({ keepRecentMessages: 4 }));
      // 20 messages, keep 4 -> summarize 16
      const messages = buildMessages(10);
      expect(messages).toHaveLength(20);

      const result = await compactor.compact(messages, createUserConfig());

      expect(result).not.toBeNull();
      expect(result!.compacted).toBe(true);
      expect(result!.originalMessageCount).toBe(20);
      // 1 summary + 4 kept = 5
      expect(result!.newMessageCount).toBe(5);
      expect(messages).toHaveLength(5);
    });

    it('summary message has role user with conversation summary prefix', async () => {
      const compactor = new MessageCompactor(createConfig({ keepRecentMessages: 2 }));
      const messages = buildMessages(5);

      await compactor.compact(messages, createUserConfig());

      const summaryMsg = messages[0];
      expect(summaryMsg.role).toBe('user');
      expect(summaryMsg.content).toContain('[Conversation summary]');
      expect(summaryMsg.content).toContain('Summary of conversation.');
    });

    it('keeps the most recent messages intact', async () => {
      const compactor = new MessageCompactor(createConfig({ keepRecentMessages: 2 }));
      const messages = buildMessages(5);
      const lastTwo = messages.slice(-2);

      await compactor.compact(messages, createUserConfig());

      // messages[1] and messages[2] should be the original last two
      expect(messages[1]).toEqual(lastTwo[0]);
      expect(messages[2]).toEqual(lastTwo[1]);
    });

    it('resets lastInputTokens after compaction', async () => {
      const compactor = new MessageCompactor(createConfig({ keepRecentMessages: 2 }));
      compactor.recordInputTokens(100_000);
      expect(compactor.shouldCompact()).toBe(true);

      const messages = buildMessages(5);
      await compactor.compact(messages, createUserConfig());

      expect(compactor.shouldCompact()).toBe(false);
    });

    it('summaryPreview is truncated to 200 chars', async () => {
      const longSummary = 'A'.repeat(500);
      mockGenerateText.mockResolvedValue({ text: longSummary });

      const compactor = new MessageCompactor(createConfig({ keepRecentMessages: 2 }));
      const messages = buildMessages(5);
      const result = await compactor.compact(messages, createUserConfig());

      expect(result!.summaryPreview).toHaveLength(200);
    });

    it('passes toSummarize messages plus trigger message to generateText', async () => {
      const compactor = new MessageCompactor(createConfig({ keepRecentMessages: 2 }));
      const messages = buildMessages(5); // 10 messages, keep 2, summarize 8

      await compactor.compact(messages, createUserConfig());

      expect(mockGenerateText).toHaveBeenCalledOnce();
      const callArgs = mockGenerateText.mock.calls[0][0];
      // Should have 8 original + 1 trigger = 9 messages
      expect(callArgs.messages).toHaveLength(9);
      const lastMsg = callArgs.messages[callArgs.messages.length - 1];
      expect(lastMsg.role).toBe('user');
      expect(lastMsg.content).toContain('Summarize');
    });

    it('mutates the original messages array', async () => {
      const compactor = new MessageCompactor(createConfig({ keepRecentMessages: 2 }));
      const messages = buildMessages(5);
      const originalRef = messages;

      await compactor.compact(messages, createUserConfig());

      // Same reference, mutated in place
      expect(messages).toBe(originalRef);
      expect(messages).toHaveLength(3); // 1 summary + 2 kept
    });
  });
});
