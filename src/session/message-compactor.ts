/**
 * MessageCompactor -- summarizes older conversation messages to keep
 * context within bounds during multi-turn sessions.
 *
 * Standalone and unit-testable. No dependency on AgentSession.
 */

import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import { createLanguageModel } from '../config/model-provider.js';
import type { ResolvedAutoCompactConfig, ResolvedUserConfig } from '../config/user-config.js';

const SUMMARIZER_SYSTEM_PROMPT = `You are summarizing a conversation between a user and an AI coding agent.
Provide a detailed but concise summary that preserves all context needed to continue the conversation naturally.

Include:
- What the user asked for and what has been accomplished
- Files created, modified, or being worked on (with paths)
- Current state: what's done, in progress, and planned next
- Key decisions, constraints, or requirements discussed
- Errors encountered and how they were resolved

Your summary will replace the older conversation history. Be comprehensive but concise.`;

/** Minimum messages in the toSummarize partition to bother compacting. */
const MIN_MESSAGES_TO_COMPACT = 4;

export interface CompactionResult {
  readonly compacted: true;
  readonly originalMessageCount: number;
  readonly newMessageCount: number;
  readonly summaryPreview: string;
}

export class MessageCompactor {
  private readonly config: ResolvedAutoCompactConfig;
  private summaryModel: LanguageModel | null = null;
  private lastInputTokens = 0;

  constructor(config: ResolvedAutoCompactConfig) {
    this.config = config;
  }

  /** Called after each turn with the last step's input token count. */
  recordInputTokens(tokens: number): void {
    this.lastInputTokens = tokens;
  }

  /** Returns true if compaction should run before the next turn. */
  shouldCompact(): boolean {
    if (!this.config.enabled) return false;
    return this.lastInputTokens > this.config.thresholdTokens;
  }

  /**
   * Compacts the message array in-place. Returns null if nothing to compact.
   *
   * Splits messages into toSummarize (older) and toKeep (recent).
   * Sends toSummarize to a summarization model and replaces the array
   * with [summaryMessage, ...toKeep].
   */
  async compact(
    messages: ModelMessage[],
    userConfig: ResolvedUserConfig,
  ): Promise<CompactionResult | null> {
    const keepCount = Math.min(this.config.keepRecentMessages, messages.length);
    const splitIndex = messages.length - keepCount;

    if (splitIndex < MIN_MESSAGES_TO_COMPACT) return null;

    const toSummarize = messages.slice(0, splitIndex);
    const toKeep = messages.slice(splitIndex);

    if (!this.summaryModel) {
      this.summaryModel = await createLanguageModel(
        this.config.summaryModelId,
        userConfig,
      );
    }

    const result = await generateText({
      model: this.summaryModel,
      system: SUMMARIZER_SYSTEM_PROMPT,
      messages: [
        ...toSummarize,
        { role: 'user', content: 'Summarize the conversation above.' },
      ],
    });

    const summary = result.text;
    const summaryMessage: ModelMessage = {
      role: 'user',
      content: `[Conversation summary]\n\n${summary}`,
    };

    const originalMessageCount = messages.length;
    messages.length = 0;
    messages.push(summaryMessage, ...toKeep);

    this.lastInputTokens = 0;

    return {
      compacted: true,
      originalMessageCount,
      newMessageCount: messages.length,
      summaryPreview: summary.substring(0, 200),
    };
  }
}
