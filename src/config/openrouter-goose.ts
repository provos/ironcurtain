/** Pinned Goose 1.26.1 formatting, applied after proxy-owned model selection. */
import { isPlainObject } from '../utils/is-plain-object.js';
import type { GatewayRequestContext, GatewayRequestFields } from './provider-definitions.js';

function cacheMessage(message: Record<string, unknown>): Record<string, unknown> {
  const content = message.content;
  if (typeof content === 'string')
    return { ...message, content: [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }] };
  return message;
}

/** Metadata survives Goose's OpenAI formatter as fields on each tool call. */
function reasoningDetails(message: Record<string, unknown>): unknown[] | undefined {
  if (!Array.isArray(message.tool_calls)) return undefined;
  for (const call of message.tool_calls) {
    if (isPlainObject(call) && Array.isArray(call.reasoning_details)) return call.reasoning_details as unknown[];
  }
  return undefined;
}

export function formatOpenRouterGooseRequest(
  body: Readonly<Record<string, unknown>>,
  context: GatewayRequestContext,
): GatewayRequestFields | undefined {
  if (context.agent !== 'goose' || context.protocol !== 'chat') return undefined;
  const cache = context.selectedModel.startsWith('anthropic/');
  const reasoning = context.selectedModel.startsWith('google/');
  if (!cache && !reasoning) return undefined;
  const fields: Record<string, unknown> = {};
  if (Array.isArray(body.messages)) {
    const originalMessages: unknown[] = body.messages;
    // Goose marks the first system message and the last two user messages.
    const cacheIndexes = new Set<number>();
    if (cache) {
      const system = originalMessages.findIndex((message) => isPlainObject(message) && message.role === 'system');
      if (system !== -1) cacheIndexes.add(system);
      let users = 0;
      for (let i = originalMessages.length - 1; i >= 0 && users < 2; i--) {
        const message = originalMessages[i];
        if (isPlainObject(message) && message.role === 'user') {
          cacheIndexes.add(i);
          users++;
        }
      }
    }
    const messages = originalMessages.map((value, index) => {
      if (!isPlainObject(value)) return value;
      let message = cache && cacheIndexes.has(index) ? cacheMessage(value) : value;
      if (reasoning && message.role === 'assistant' && message.reasoning_details === undefined) {
        const details = reasoningDetails(message);
        if (details !== undefined) message = { ...message, reasoning_details: details };
      }
      return message;
    });
    if (messages.some((message, index) => message !== originalMessages[index])) fields.messages = messages;
  }
  if (cache && Array.isArray(body.tools) && body.tools.length > 0) {
    const originalTools: unknown[] = body.tools;
    const last = originalTools[originalTools.length - 1];
    if (isPlainObject(last) && isPlainObject(last.function)) {
      let fn = last.function;
      if (fn.cache_control === undefined) fn = { ...fn, cache_control: { type: 'ephemeral' } };
      if (fn !== last.function) fields.tools = [...originalTools.slice(0, -1), { ...last, function: fn }];
    }
  }
  return Object.keys(fields).length
    ? { body: fields, auditLabels: { messages: 'goose:messages-format', tools: 'goose:tool-cache-control' } }
    : undefined;
}
