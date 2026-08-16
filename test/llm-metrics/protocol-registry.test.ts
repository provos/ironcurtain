import { describe, expect, it } from 'vitest';
import { createBuiltInProtocolRegistry, LlmProtocolRegistry } from '../../src/llm-metrics/protocol-registry.js';
import { AnthropicMessagesAdapter } from '../../src/llm-metrics/protocols/anthropic-messages.js';

describe('LlmProtocolRegistry', () => {
  it('registers all built-in wire protocols', () => {
    const registry = createBuiltInProtocolRegistry();
    expect(registry.ids()).toEqual([
      'anthropic-messages',
      'google-generate-content',
      'openai-chat-completions',
      'openai-responses',
    ]);
    expect(registry.supports('openai-responses')).toBe(true);
    expect(registry.supports('custom-protocol')).toBe(false);
  });

  it('rejects duplicate IDs and fails explicitly for unsupported protocols', () => {
    const registry = new LlmProtocolRegistry([new AnthropicMessagesAdapter()]);
    expect(() => registry.register(new AnthropicMessagesAdapter())).toThrow('already registered');
    expect(() => registry.require('custom-protocol')).toThrow('No LLM protocol adapter registered');
  });
});
