/**
 * Byte-fidelity unit tests for the OpenAI reassemblers in isolation:
 *
 *   - ChatCompletionsReassembler (api.openai.com /v1/chat/completions):
 *     untyped `data:` chunks, `[DONE]` terminal, synthesized
 *     chat.completion envelope. Critical path: fragmented
 *     function.arguments concatenated raw then re-encoded once
 *     (DIVERGES from Anthropic tool_use.input which splices a raw
 *     object); content null-vs-"" decision table; usage best-effort.
 *
 *   - ResponsesReassembler (chatgpt.com /backend-api/codex/responses):
 *     named `response.*` events, terminal `response.completed` carrying
 *     ONLY status + usage (output[] is empty). Body assembled from the
 *     streamed `response.output_item.done` items (spliced verbatim) with
 *     status/usage from response.completed. Driven against a trimmed
 *     slice of a REAL captured codex stream (test/docker/fixtures).
 *
 * Mirrors the Anthropic fidelity tests in
 * trajectory-streaming-fidelity.test.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { ChatCompletionsReassembler, ResponsesReassembler } from '../../src/docker/trajectory-reassembler.js';

const here = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURE = resolve(here, 'fixtures', 'codex-responses-stream.sse');

/** Build one untyped Chat Completions chunk event. */
function chunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function done(): string {
  return 'data: [DONE]\n\n';
}

function reassembleChat(sse: string): ReturnType<ChatCompletionsReassembler['finalize']> {
  const r = new ChatCompletionsReassembler();
  r.push(Buffer.from(sse, 'utf-8'));
  return r.finalize();
}

describe('ChatCompletionsReassembler byte fidelity', () => {
  it('text-only: synthesized chat.completion body matches non-streaming', () => {
    const sse =
      chunk({
        id: 'chatcmpl-text',
        object: 'chat.completion.chunk',
        created: 100,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      }) +
      chunk({ choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: { content: 'world' }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      done();

    const res = reassembleChat(sse);
    expect(res.bodyUtf8).toBe(
      '{"id":"chatcmpl-text","object":"chat.completion","created":100,"model":"gpt-4o",' +
        '"choices":[{"index":0,"message":{"role":"assistant","content":"Hello world"},"finish_reason":"stop"}],' +
        '"usage":null}',
    );
    expect(res.stopReason).toBe('stop');
    expect(res.providerRequestId).toBe('chatcmpl-text');
  });

  it('fragmented tool arguments (>=3 deltas, escaped quotes/backslash/unicode) are byte-equal to the non-streaming arguments string', () => {
    // The non-streaming arguments STRING literal we must reproduce exactly.
    // It contains an escaped quote, an escaped backslash, and a unicode
    // escape decoded to é. The streaming form splits it across 3 deltas.
    const realArgs = '{"path":"a\\"b\\\\c","note":"café"}';

    const sse =
      chunk({
        id: 'chatcmpl-tool',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }],
      }) +
      // First tool-call delta: id/type/name + first args fragment.
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'edit', arguments: '{"path":"a\\"' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }) +
      // Second args fragment (backslash escape spans).
      chunk({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'b\\\\c","note":"caf' } }] } }],
      }) +
      // Third args fragment (unicode é written as the literal char on this wire).
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'é"}' } }] } }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
      done();

    const res = reassembleChat(sse);
    const parsed = JSON.parse(res.bodyUtf8) as {
      choices: { message: { content: string | null; tool_calls: { function: { arguments: string } }[] } }[];
    };
    // content is null on a pure tool-call turn whose opener carried content:null.
    expect(parsed.choices[0].message.content).toBeNull();
    // The reassembled arguments string is byte-equal to the real non-streaming form.
    expect(parsed.choices[0].message.tool_calls[0].function.arguments).toBe(realArgs);
    // And it decodes back to the intended object.
    expect(JSON.parse(parsed.choices[0].message.tool_calls[0].function.arguments)).toEqual({
      path: 'a"b\\c',
      note: 'café',
    });
    expect(res.stopReason).toBe('tool_calls');
  });

  it('parallel tool_calls: per-tool-call-index accumulation, sorted output', () => {
    const sse =
      chunk({
        id: 'chatcmpl-par',
        object: 'chat.completion.chunk',
        created: 2,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }],
      }) +
      // interleave the two tool calls' fragments
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'a', arguments: '{"x"' } }],
            },
          },
        ],
      }) +
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 1, id: 'c1', type: 'function', function: { name: 'b', arguments: '{"y"' } }],
            },
          },
        ],
      }) +
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: ':2}' } }] } }] }) +
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
      done();

    const res = reassembleChat(sse);
    const parsed = JSON.parse(res.bodyUtf8) as {
      choices: { message: { tool_calls: { id: string; function: { name: string; arguments: string } }[] } }[];
    };
    const tcs = parsed.choices[0].message.tool_calls;
    expect(tcs.map((t) => t.id)).toEqual(['c0', 'c1']);
    expect(tcs[0].function.arguments).toBe('{"x":1}');
    expect(tcs[1].function.arguments).toBe('{"y":2}');
  });

  it('content null vs "" decision: pure tool-call turn whose opener carries content:"" assembles content:null', () => {
    // The role-opener carries content:"" (empty string) but the turn is a
    // tool call. The discriminator is tool_calls presence, NOT the content
    // value: a pure tool-call turn must assemble content:null even though
    // the opener carried an empty-string content key.
    const sse =
      chunk({
        id: 'chatcmpl-null',
        object: 'chat.completion.chunk',
        created: 3,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      }) +
      chunk({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
          },
        ],
      }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
      done();

    const res = reassembleChat(sse);
    const parsed = JSON.parse(res.bodyUtf8) as { choices: { message: { content: string | null } }[] };
    expect(parsed.choices[0].message.content).toBeNull();
    expect(res.bodyUtf8).toContain('"content":null');
  });

  it('content "" decision: empty-string text turn assembles content:""', () => {
    const sse =
      chunk({
        id: 'chatcmpl-empty',
        object: 'chat.completion.chunk',
        created: 4,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      done();

    const res = reassembleChat(sse);
    expect(res.bodyUtf8).toContain('"content":""');
  });

  it('refusal turn: content:null and refusal text present', () => {
    const sse =
      chunk({
        id: 'chatcmpl-ref',
        object: 'chat.completion.chunk',
        created: 5,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant', refusal: '' }, finish_reason: null }],
      }) +
      chunk({ choices: [{ index: 0, delta: { refusal: 'I cannot' }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: { refusal: ' help' }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      done();

    const res = reassembleChat(sse);
    const parsed = JSON.parse(res.bodyUtf8) as { choices: { message: { content: string | null; refusal?: string } }[] };
    expect(parsed.choices[0].message.content).toBeNull();
    expect(parsed.choices[0].message.refusal).toBe('I cannot help');
  });

  it('include_usage chunk with choices:[] is routed to usage, not treated as a content choice', () => {
    const sse =
      chunk({
        id: 'chatcmpl-usage',
        object: 'chat.completion.chunk',
        created: 6,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
      }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      chunk({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 } }) +
      done();

    const res = reassembleChat(sse);
    const parsed = JSON.parse(res.bodyUtf8) as { choices: unknown[]; usage: { total_tokens: number } | null };
    // Exactly one choice (the usage chunk's empty choices[] did not add one).
    expect(parsed.choices.length).toBe(1);
    expect(parsed.usage?.total_tokens).toBe(8);
    expect(res.usage?.total_tokens).toBe(8);
  });

  it('usage stays null when no usage chunk was emitted (never fabricated)', () => {
    const sse =
      chunk({
        id: 'chatcmpl-nousage',
        object: 'chat.completion.chunk',
        created: 7,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'x' }, finish_reason: null }],
      }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      done();

    const res = reassembleChat(sse);
    expect(res.bodyUtf8).toContain('"usage":null');
    expect(res.usage).toBeUndefined();
  });

  it('non-null logprobs poison reassembly (fail-loud, never silently null)', () => {
    const sse =
      chunk({
        id: 'chatcmpl-lp',
        object: 'chat.completion.chunk',
        created: 8,
        model: 'gpt-4o',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'x' }, logprobs: { content: [] }, finish_reason: null },
        ],
      }) + done();

    const r = new ChatCompletionsReassembler();
    r.push(Buffer.from(sse, 'utf-8'));
    expect(() => r.finalize()).toThrow();
  });

  it('stream ending without [DONE] throws on finalize (truncation gate)', () => {
    const sse = chunk({
      id: 'chatcmpl-trunc',
      object: 'chat.completion.chunk',
      created: 9,
      model: 'gpt-4o',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'x' }, finish_reason: null }],
    });
    const r = new ChatCompletionsReassembler();
    r.push(Buffer.from(sse, 'utf-8'));
    expect(() => r.finalize()).toThrow();
  });

  it('unicode content split across feed() chunks survives (StringDecoder)', () => {
    const sse =
      chunk({
        id: 'chatcmpl-uni',
        object: 'chat.completion.chunk',
        created: 10,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      }) +
      chunk({ choices: [{ index: 0, delta: { content: 'hi 🎉 there' }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      done();

    const full = Buffer.from(sse, 'utf-8');
    const emojiStart = full.indexOf(Buffer.from('🎉', 'utf-8'));
    const splitAt = emojiStart + 2; // mid 4-byte sequence

    const r = new ChatCompletionsReassembler();
    r.push(full.subarray(0, splitAt));
    r.push(full.subarray(splitAt));
    const res = r.finalize();
    expect(res.bodyUtf8).toContain('🎉');
    expect(res.bodyUtf8).not.toContain('�');
  });
});

describe('ResponsesReassembler byte fidelity (real codex stream)', () => {
  const EXPECTED_TEXT = '17 * 23 = 17 * (20 + 3) = 340 + 51 = 391';

  function reassembleFixture(): ReturnType<ResponsesReassembler['finalize']> {
    const sse = readFileSync(FIXTURE, 'utf-8');
    const r = new ResponsesReassembler();
    r.push(Buffer.from(sse, 'utf-8'));
    return r.finalize();
  }

  it('assembles the body from output_item.done items (NOT the empty response.completed output[])', () => {
    const res = reassembleFixture();
    const body = JSON.parse(res.bodyUtf8) as {
      object: string;
      status: string;
      output: { type: string; content: { type: string; text: string }[] }[];
      usage: Record<string, unknown>;
    };
    // The terminal response.completed carries output:[] — assembly must
    // NOT use it. The body's output[] is sourced from output_item.done.
    expect(body.output.length).toBe(1);
    expect(body.output[0].type).toBe('message');
    expect(body.output[0].content[0].text).toBe(EXPECTED_TEXT);
    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
  });

  it('output_text is byte-for-byte present in the assembled body', () => {
    const res = reassembleFixture();
    expect(res.bodyUtf8).toContain(`"text":${JSON.stringify(EXPECTED_TEXT)}`);
  });

  it('the output_item.done item JSON is spliced VERBATIM (zero re-encode)', () => {
    const sse = readFileSync(FIXTURE, 'utf-8');
    // Pull the exact item substring the wire carried.
    const itemMatch = /"response\.output_item\.done","item":(\{.*?\}),"output_index"/.exec(sse);
    expect(itemMatch).not.toBeNull();
    const verbatimItem = itemMatch?.[1] ?? '';
    expect(verbatimItem.length).toBeGreaterThan(0);
    const res = reassembleFixture();
    // The verbatim item must appear unchanged inside output[].
    expect(res.bodyUtf8).toContain(verbatimItem);
  });

  it('usage and status come from response.completed; id/model from response.created', () => {
    const res = reassembleFixture();
    expect(res.stopReason).toBe('completed');
    expect(res.providerRequestId).toBe('resp_044409b8234111cf016a2e059444e481998de5fc1941e9ce57');
    expect(res.modelFingerprint).toBe('gpt-5.5');
    expect(res.usage).toEqual({
      input_tokens: 12047,
      input_tokens_details: { cached_tokens: 11648 },
      output_tokens: 27,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 12074,
    });
  });

  it('CROSS-CHECK: delta-accumulated text == output_text.done.text == output_item.done text', () => {
    const sse = readFileSync(FIXTURE, 'utf-8');
    // Accumulate deltas independently of the reassembler.
    let deltaText = '';
    let doneText: string | undefined;
    let itemText: string | undefined;
    for (const line of sse.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data.includes('"type":"response.output_text.delta"')) {
        deltaText += (JSON.parse(data) as { delta: string }).delta;
      } else if (data.includes('"type":"response.output_text.done"')) {
        doneText = (JSON.parse(data) as { text: string }).text;
      } else if (data.includes('"type":"response.output_item.done"')) {
        itemText = (JSON.parse(data) as { item: { content: { text: string }[] } }).item.content[0].text;
      }
    }
    expect(deltaText).toBe(EXPECTED_TEXT);
    expect(doneText).toBe(EXPECTED_TEXT);
    expect(itemText).toBe(EXPECTED_TEXT);
  });

  it('byte-faithful: terminal envelope is spliced verbatim with output[] populated (all fields preserved)', () => {
    // A richer response.completed envelope (mirrors the live ~35-field
    // shape) with empty output[]. The assembled body must be the VERBATIM
    // envelope with output[] replaced — every other field byte-preserved.
    const itemRaw =
      '{"id":"msg_x","type":"message","status":"completed","content":[{"type":"output_text","annotations":[],"text":"hi"}],"role":"assistant"}';
    const envelope =
      '{"id":"resp_x","object":"response","created_at":1781400980,"status":"completed",' +
      '"background":false,"error":null,"incomplete_details":null,"instructions":"sys prompt with \\"quotes\\"",' +
      '"model":"gpt-5.5","output":[],"temperature":1.0,"top_p":0.98,' +
      '"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7},"metadata":{}}';
    const sse =
      'event: response.created\n' +
      'data: {"type":"response.created","response":{"id":"resp_x","object":"response","status":"in_progress","model":"gpt-5.5"}}\n\n' +
      'event: response.output_item.added\n' +
      'data: {"type":"response.output_item.added","item":{"id":"msg_x","type":"message","content":[]},"output_index":0}\n\n' +
      'event: response.output_text.delta\n' +
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"hi"}\n\n' +
      'event: response.output_item.done\n' +
      `data: {"type":"response.output_item.done","item":${itemRaw},"output_index":0}\n\n` +
      'event: response.completed\n' +
      `data: {"type":"response.completed","response":${envelope}}\n\n`;

    const r = new ResponsesReassembler();
    r.push(Buffer.from(sse, 'utf-8'));
    const res = r.finalize();

    // The body is the envelope with "output":[] replaced by the verbatim item.
    const expected = envelope.replace('"output":[]', `"output":[${itemRaw}]`);
    expect(res.bodyUtf8).toBe(expected);
    // The verbatim item appears unchanged.
    expect(res.bodyUtf8).toContain(itemRaw);
    // Every envelope field is preserved (not synthesized away).
    expect(res.bodyUtf8).toContain('"created_at":1781400980');
    expect(res.bodyUtf8).toContain('"instructions":"sys prompt with \\"quotes\\""');
    expect(res.bodyUtf8).toContain('"temperature":1.0');
    expect(res.bodyUtf8).toContain('"metadata":{}');
    expect(res.stopReason).toBe('completed');
    expect(res.providerRequestId).toBe('resp_x');
  });

  it('stopReason: incomplete status prefers incomplete_details.reason', () => {
    const sse =
      'event: response.created\n' +
      'data: {"type":"response.created","response":{"id":"resp_i","model":"m"}}\n\n' +
      'event: response.incomplete\n' +
      'data: {"type":"response.incomplete","response":{"id":"resp_i","object":"response","status":"incomplete",' +
      '"incomplete_details":{"reason":"max_output_tokens"},"output":[],"usage":null}}\n\n';
    const r = new ResponsesReassembler();
    r.push(Buffer.from(sse, 'utf-8'));
    const res = r.finalize();
    expect(res.stopReason).toBe('max_output_tokens');
  });

  it('CROSS-CHECK: delta-join disagreeing with output_item.done text throws (poison)', () => {
    // Deltas spell "hi" but the item.done content text says "BYE" — the
    // reassembler must throw so the binary-session model poisons.
    const itemRaw =
      '{"id":"msg_x","type":"message","status":"completed","content":[{"type":"output_text","text":"BYE"}],"role":"assistant"}';
    const sse =
      'event: response.created\n' +
      'data: {"type":"response.created","response":{"id":"resp_x","model":"m"}}\n\n' +
      'event: response.output_item.added\n' +
      'data: {"type":"response.output_item.added","item":{"id":"msg_x"},"output_index":0}\n\n' +
      'event: response.output_text.delta\n' +
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"hi"}\n\n' +
      'event: response.output_item.done\n' +
      `data: {"type":"response.output_item.done","item":${itemRaw},"output_index":0}\n\n` +
      'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp_x","object":"response","status":"completed","output":[],"usage":null}}\n\n';
    const r = new ResponsesReassembler();
    r.push(Buffer.from(sse, 'utf-8'));
    expect(() => r.finalize()).toThrow(/delta\/item mismatch/);
  });

  it('CROSS-CHECK: delta-join disagreeing with output_text.done text throws (poison)', () => {
    const sse =
      'event: response.created\n' +
      'data: {"type":"response.created","response":{"id":"resp_x","model":"m"}}\n\n' +
      'event: response.output_text.delta\n' +
      'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"hi"}\n\n' +
      'event: response.output_text.done\n' +
      'data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"NOPE"}\n\n' +
      'event: response.completed\n' +
      'data: {"type":"response.completed","response":{"id":"resp_x","object":"response","status":"completed","output":[],"usage":null}}\n\n';
    const r = new ResponsesReassembler();
    r.push(Buffer.from(sse, 'utf-8'));
    expect(() => r.finalize()).toThrow(/delta\/done mismatch/);
  });

  it('canFinalize() is false until response.completed is parsed', () => {
    const r = new ResponsesReassembler();
    r.push(
      Buffer.from(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r","model":"m"}}\n\n',
        'utf-8',
      ),
    );
    expect(r.canFinalize()).toBe(false);
    r.push(
      Buffer.from(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[],"usage":null}}\n\n',
        'utf-8',
      ),
    );
    expect(r.canFinalize()).toBe(true);
  });

  it('stream ending without response.completed throws on finalize (truncation gate)', () => {
    const r = new ResponsesReassembler();
    r.push(
      Buffer.from(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r","model":"m"}}\n\n' +
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"hi"}\n\n',
        'utf-8',
      ),
    );
    expect(() => r.finalize()).toThrow();
  });
});
