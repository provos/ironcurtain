/**
 * Prompt caching strategies for multi-turn sessions.
 *
 * Anthropic models benefit from explicit cache-control markers on system
 * prompts, tool definitions, and conversation history breakpoints.
 * OpenAI and Google cache automatically, so they use the NoOp strategy.
 */

import type { ModelMessage, SystemModelMessage, ToolSet } from 'ai';
import { parseModelId } from '../config/model-provider.js';

const ANTHROPIC_CACHE_CONTROL = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
} as const;

/**
 * Strategy for applying provider-specific prompt caching hints.
 * Implementations are stateless — safe to share across turns.
 */
export interface PromptCacheStrategy {
  /** Wrap the system prompt with cache-control metadata (if supported). */
  wrapSystemPrompt(prompt: string): string | SystemModelMessage;

  /** Spread cache-control metadata onto each tool definition (if supported). */
  wrapTools(tools: ToolSet): ToolSet;

  /**
   * Add a cache breakpoint to the conversation history so the provider
   * can cache everything up to (but not including) the latest user message.
   * Returns a shallow copy — never mutates the input array or its elements.
   */
  applyHistoryBreakpoint(messages: readonly ModelMessage[]): ModelMessage[];
}

/**
 * Anthropic-specific strategy: marks system prompt, tools, and a history
 * breakpoint with `cacheControl: { type: 'ephemeral' }`.
 */
export class AnthropicCacheStrategy implements PromptCacheStrategy {
  wrapSystemPrompt(prompt: string): SystemModelMessage {
    return {
      role: 'system',
      content: prompt,
      providerOptions: ANTHROPIC_CACHE_CONTROL,
    };
  }

  wrapTools(tools: ToolSet): ToolSet {
    return Object.fromEntries(
      Object.entries(tools).map(([name, def]) => [name, { ...def, providerOptions: ANTHROPIC_CACHE_CONTROL }]),
    );
  }

  applyHistoryBreakpoint(messages: readonly ModelMessage[]): ModelMessage[] {
    const copy = [...messages];
    if (copy.length < 2) return copy;

    // Mark the second-to-last message (the one before the newest user message)
    // so everything up to that point is cached.
    const idx = copy.length - 2;
    copy[idx] = {
      ...copy[idx],
      providerOptions: {
        ...copy[idx].providerOptions,
        ...ANTHROPIC_CACHE_CONTROL,
      },
    };
    return copy;
  }
}

/**
 * No-op strategy for providers that cache automatically (OpenAI, Google)
 * or for unknown providers where we don't want to add metadata.
 */
export class NoOpCacheStrategy implements PromptCacheStrategy {
  wrapSystemPrompt(prompt: string): string {
    return prompt;
  }

  wrapTools(tools: ToolSet): ToolSet {
    return tools;
  }

  applyHistoryBreakpoint(messages: readonly ModelMessage[]): ModelMessage[] {
    return [...messages];
  }
}

/**
 * Factory: selects the right cache strategy based on the model's provider.
 */
export function createCacheStrategy(qualifiedModelId: string): PromptCacheStrategy {
  const { provider } = parseModelId(qualifiedModelId);
  if (provider === 'anthropic') {
    return new AnthropicCacheStrategy();
  }
  return new NoOpCacheStrategy();
}
