/**
 * Byte-fidelity unit tests for the OpenAI Responses reassembler in isolation.
 *
 * ResponsesReassembler (chatgpt.com /backend-api/codex/responses): named
 * `response.*` events, terminal `response.completed` carrying ONLY status +
 * usage (output[] is empty). The body is assembled from the streamed
 * `response.output_item.done` items (spliced verbatim) with status/usage from
 * response.completed. Driven against a trimmed slice of a REAL captured codex
 * stream (test/docker/fixtures).
 *
 * Mirrors the Anthropic fidelity tests in trajectory-streaming-fidelity.test.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { ResponsesReassembler } from '../../src/docker/trajectory-reassembler.js';

const here = resolve(fileURLToPath(import.meta.url), '..');
const FIXTURE = resolve(here, 'fixtures', 'codex-responses-stream.sse');

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
