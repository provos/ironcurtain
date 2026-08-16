import type { LlmProtocolAdapter, LlmProtocolId } from './types.js';
import { AnthropicMessagesAdapter } from './protocols/anthropic-messages.js';
import { GoogleGenerateContentAdapter } from './protocols/google-generate-content.js';
import { OpenAiChatCompletionsAdapter } from './protocols/openai-chat-completions.js';
import { OpenAiResponsesAdapter } from './protocols/openai-responses.js';

export class LlmProtocolRegistry {
  private readonly adapters = new Map<LlmProtocolId, LlmProtocolAdapter>();

  constructor(adapters: readonly LlmProtocolAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: LlmProtocolAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`LLM protocol adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: LlmProtocolId): LlmProtocolAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: LlmProtocolId): LlmProtocolAdapter {
    const adapter = this.get(id);
    if (!adapter) throw new Error(`No LLM protocol adapter registered: ${id}`);
    return adapter;
  }

  supports(id: LlmProtocolId): boolean {
    return this.adapters.has(id);
  }

  ids(): readonly LlmProtocolId[] {
    return [...this.adapters.keys()].sort();
  }
}

export function createBuiltInProtocolRegistry(): LlmProtocolRegistry {
  return new LlmProtocolRegistry([
    new AnthropicMessagesAdapter(),
    new OpenAiResponsesAdapter(),
    new OpenAiChatCompletionsAdapter(),
    new GoogleGenerateContentAdapter(),
  ]);
}
