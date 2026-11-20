import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTrajectoryCaptureWriter } from '../../src/docker/trajectory-capture.js';
import { createReassembler } from '../../src/docker/trajectory-reassembler.js';
import { beginCaptureExchange } from '../../src/docker/trajectory-tap.js';
import type { ExchangeRecord, ManifestEntry } from '../../src/docker/trajectory-types.js';
import type { SessionId } from '../../src/session/types.js';
import {
  encodeModelSse,
  modelAnthropicResponse,
  modelSseEvent,
  type ModelSseEvent,
} from '../helpers/trajectory-model-fixtures.js';

function modelResponses(nestedFieldsFirst: boolean) {
  const firstText = 'café 🚀';
  const secondText = ' says "hi"\n';
  const args = '{ "sample": "é", "weight": 1.50 }';
  const message = { type: 'message', id: 'msg_0', role: 'assistant' };
  const tool = { type: 'function_call', id: 'call_1', call_id: 'tool_1', name: 'Inspect' };
  const messageItem = { ...message, content: [{ type: 'output_text', text: firstText + secondText }] };
  const toolItem = { ...tool, arguments: args };
  const model = 'fixture';
  const metadata = { output: 'label', model: 'display-model' };
  const ordering = nestedFieldsFirst ? { metadata, model } : { model, metadata };
  const usage = { input_tokens: 6, output_tokens: 12, total_tokens: 18 };
  const status = 'completed';
  const response = { id: 'resp-1', object: 'response', status, usage };
  const envelope = (output: unknown[]) =>
    JSON.stringify(
      nestedFieldsFirst ? { ...response, metadata, model, output } : { ...response, model, output, metadata },
    );
  const bodyUtf8 = envelope([messageItem, toolItem]);
  const terminal = envelope([]);
  const events: ModelSseEvent[] = [
    modelSseEvent('response.created', { response: { id: response.id, status: 'in_progress', ...ordering } }),
    modelSseEvent('response.output_item.added', { output_index: 0, item: { ...message, content: [] } }),
    modelSseEvent('response.output_item.added', { output_index: 1, item: { ...tool, arguments: '' } }),
    modelSseEvent('response.output_text.delta', { output_index: 0, content_index: 0, delta: firstText }),
    modelSseEvent('response.function_call_arguments.delta', { output_index: 1, delta: args.slice(0, 12) }),
    modelSseEvent('response.output_text.delta', { output_index: 0, content_index: 0, delta: secondText }),
    modelSseEvent('response.function_call_arguments.delta', { output_index: 1, delta: args.slice(12) }),
    modelSseEvent('response.function_call_arguments.done', { output_index: 1, arguments: args }),
    modelSseEvent('response.output_item.done', { output_index: 1, item: toolItem }),
    modelSseEvent('response.output_item.done', { output_index: 0, item: messageItem }),
    { eventType: 'response.completed', dataUtf8: `{"type":"response.completed","response":${terminal}}` },
  ];
  return { events, bodyUtf8, stopReason: status, model, usage };
}

const anthropic = 'api.anthropic.com';
const openai = 'api.openai.com';
const fixtures = [
  { name: 'Anthropic text', host: anthropic, model: modelAnthropicResponse(0, false) },
  { name: 'Anthropic thinking and tools', host: anthropic, model: modelAnthropicResponse(2, true) },
  { name: 'Responses interleaved output', host: openai, model: modelResponses(false) },
  { name: 'Responses metadata before top-level fields', host: openai, model: modelResponses(true) },
] as const;

const layouts = ['whole', 'uneven', 'bytewise with empty chunks'] as const;
type Layout = (typeof layouts)[number];

function chunks(bytes: Buffer, layout: Layout): Buffer[] {
  if (layout === 'whole') return [bytes];
  const width = layout === 'uneven' ? 17 : 1;
  const empty = Buffer.alloc(0);
  const result: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += width) {
    result.push(bytes.subarray(i, i + width));
    if (width === 1) result.push(empty);
  }
  return result;
}

const wireCases = fixtures.flatMap((fixture) =>
  ['LF', 'CRLF'].flatMap((separator) => layouts.map((layout) => ({ ...fixture, separator, layout }))),
);

const terminals = ['end', 'close after terminal', 'close before terminal', 'malformed event'] as const;
const captureCases = [
  ...[fixtures[1], fixtures[2]].flatMap((fixture) => terminals.map((terminal) => ({ ...fixture, terminal }))),
  { ...fixtures[1], terminal: 'missing tool argument fragment' } as const,
  { ...fixtures[1], terminal: 'token limit during tool arguments' } as const,
  { ...fixtures[2], terminal: 'missing output item completion' } as const,
  { ...fixtures[2], terminal: 'recover item from terminal output' } as const,
  { ...fixtures[2], terminal: 'terminal output identifies a different item' } as const,
  {
    ...fixtures[2],
    name: 'Responses with a bare terminal',
    model: {
      ...fixtures[2].model,
      events: [...fixtures[2].model.events.slice(0, -1), modelSseEvent('response.completed')],
    },
    terminal: 'missing output item completion',
  } as const,
];

function assertEndManifest(dir: string, expected: Partial<Extract<ManifestEntry, { event: 'session-end' }>>) {
  const lastLine = readFileSync(join(dir, 'manifest.jsonl'), 'utf8').trimEnd().split('\n').at(-1);
  if (!lastLine) throw new Error('Missing capture manifest');
  expect(JSON.parse(lastLine) as ManifestEntry).toMatchObject({ event: 'session-end', ...expected });
}

describe('trajectory reassembly model', () => {
  it.each(wireCases)(
    '$name preserves bytes with $separator and $layout input',
    ({ host, model, separator, layout }) => {
      const newline = separator === 'LF' ? '\n' : '\r\n';
      const reassembler = createReassembler(host);
      if (!reassembler) throw new Error(`Missing reassembler for ${host}`);
      const prefix = encodeModelSse(model.events.slice(0, -1), newline);
      for (const chunk of chunks(prefix, layout)) reassembler.push(chunk);
      expect(reassembler.canFinalize()).toBe(false);
      const ending = encodeModelSse(model.events.slice(-1), newline);
      for (const chunk of chunks(ending, layout)) reassembler.push(chunk);
      expect(reassembler.canFinalize()).toBe(true);

      const result = reassembler.finalize();
      expect(result.bodyUtf8).toBe(model.bodyUtf8);
      expect(result.stopReason).toBe(model.stopReason);
      expect(result.usage).toEqual(model.usage);
      if ('model' in model) expect(result.modelFingerprint).toBe(model.model);
      expect(result.events.map(({ eventType, dataUtf8 }) => ({ eventType, dataUtf8 }))).toEqual(model.events);
    },
  );

  it.each(captureCases)('$name capture handles $terminal', async ({ host, model, terminal }) => {
    const dir = mkdtempSync(join(tmpdir(), 'trajectory-reassembly-model-'));
    const writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sessionId = 'reassembly-session' as SessionId;
    try {
      writer.beginSession({ sessionId });
      async function capture(events: readonly ModelSseEvent[], close = false): Promise<void> {
        const exchange = beginCaptureExchange({
          writer,
          sessionId,
          host,
          path: host === anthropic ? '/v1/messages' : '/v1/responses',
          method: 'POST',
          requestHeaders: {},
          requestStartedAt: Date.now(),
        });
        exchange.setRequestBody(Buffer.from('{}'));
        const tap = exchange.attachResponse({ statusCode: 200, headers: { 'content-type': 'text/event-stream' } });
        const closed = once(tap, 'close');
        for (const chunk of chunks(encodeModelSse(events), 'uneven')) tap.write(chunk);
        if (close) tap.destroy();
        else tap.end();
        await closed;
      }
      const malformed =
        host === anthropic
          ? modelSseEvent('content_block_stop', { index: 99 })
          : modelSseEvent('response.output_item.done', { output_index: 99 });
      const prefix = model.events.slice(0, -1);
      let events =
        terminal === 'close before terminal'
          ? prefix
          : terminal === 'malformed event'
            ? [...prefix, malformed, ...model.events.slice(-1)]
            : model.events;
      if (terminal === 'missing tool argument fragment' || terminal === 'token limit during tool arguments') {
        const missing = events.filter(({ dataUtf8 }) => dataUtf8.includes('"type":"input_json_delta"')).at(-1);
        if (!missing) throw new Error('Fixture has no argument deltas');
        events = events.filter((event) => event !== missing);
        if (terminal === 'token limit during tool arguments') {
          const tokenLimit = modelSseEvent('message_delta', {
            delta: { stop_reason: 'max_tokens', stop_sequence: null },
            usage: model.usage,
          });
          events = events.map((event) => (event.eventType === 'message_delta' ? tokenLimit : event));
        }
      }
      if (
        terminal === 'missing output item completion' ||
        terminal === 'recover item from terminal output' ||
        terminal === 'terminal output identifies a different item'
      ) {
        const missing = events.find(
          ({ eventType, dataUtf8 }) =>
            eventType === 'response.output_item.done' && dataUtf8.includes('"type":"message"'),
        );
        if (!missing) throw new Error('Fixture has no completed message item');
        events = events.filter((event) => event !== missing);
        if (terminal !== 'missing output item completion') {
          const terminalBody =
            terminal === 'terminal output identifies a different item'
              ? model.bodyUtf8.replace('"id":"msg_0"', '"id":"unrelated_item"')
              : model.bodyUtf8;
          events = [
            ...events.slice(0, -1),
            { eventType: 'response.completed', dataUtf8: `{"type":"response.completed","response":${terminalBody}}` },
          ];
        }
      }
      const aborts =
        terminal === 'close before terminal' ||
        terminal === 'token limit during tool arguments' ||
        terminal === 'missing output item completion' ||
        terminal === 'terminal output identifies a different item';
      if (aborts) await capture(model.events);
      await capture(events, terminal === 'close after terminal' || terminal === 'close before terminal');
      if (aborts) await capture(model.events);
      await writer.endSession(sessionId);

      const poisoned = terminal === 'malformed event' || terminal === 'missing tool argument fragment';
      const abortedExchanges = aborts ? 1 : 0;
      const exchanges = poisoned ? 0 : aborts ? 2 : 1;
      expect(writer.stats()).toMatchObject({ written: exchanges, abortedExchanges, dropped: 0 });
      assertEndManifest(dir, {
        sessionId,
        exchanges,
        abortedExchanges,
        poisoned,
        ...(poisoned ? { poisonReason: 'reassembly-failure' } : {}),
      });
      if (terminal === 'recover item from terminal output') {
        const record = JSON.parse(readFileSync(join(dir, `${sessionId}.jsonl`), 'utf8')) as ExchangeRecord;
        expect(record.response.bodyUtf8).toBe(model.bodyUtf8);
      }
    } finally {
      await writer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
