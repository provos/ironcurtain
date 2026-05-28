/**
 * Trajectory-capture streaming-vs-non-streaming byte fidelity test.
 *
 * Feeds known SSE byte sequences through `AnthropicReassembler` and
 * asserts that `finalize().bodyUtf8` is byte-equal to the equivalent
 * non-streaming response body, as required by §6 invariant #1 of
 * docs/designs/mitm-token-trajectory-capture.md.
 *
 * Three fixtures (per §12 test #1):
 *   - text-only
 *   - text + tool_use (with input_json_delta concatenation)
 *   - thinking + text + tool_use
 *
 * The contract is byte-level equality of `bodyUtf8`. The assembled
 * body must match exactly what a non-streaming response from the same
 * upstream would have returned.
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import * as zlib from 'node:zlib';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { AnthropicReassembler } from '../../src/docker/trajectory-reassembler.js';
import { beginCaptureExchange, createResponseCaptureInlet } from '../../src/docker/trajectory-tap.js';
import { createTrajectoryCaptureWriter, type TrajectoryCaptureWriter } from '../../src/docker/trajectory-capture.js';
import type { ExchangeRecord, ManifestEntry } from '../../src/docker/trajectory-types.js';
import type { SessionId } from '../../src/session/types.js';

/**
 * Build a single SSE event block (event line + data line + blank).
 */
function sseEvent(eventType: string, dataJson: string): string {
  return `event: ${eventType}\ndata: ${dataJson}\n\n`;
}

/** Feed a complete SSE stream into the reassembler and finalize. */
function reassemble(sse: string): string {
  const r = new AnthropicReassembler();
  r.push(Buffer.from(sse, 'utf-8'));
  return r.finalize().bodyUtf8;
}

describe('Trajectory streaming fidelity (Anthropic SSE)', () => {
  it('text-only: reassembled body matches the non-streaming equivalent', () => {
    // Non-streaming equivalent: one message with a single text block of
    // "Hello world".
    const messageEnvelope =
      '{"id":"msg_01","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}}';

    const sse =
      sseEvent('message_start', `{"type":"message_start","message":${messageEnvelope}}`) +
      sseEvent(
        'content_block_start',
        '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}',
      ) +
      sseEvent('content_block_stop', '{"type":"content_block_stop","index":0}') +
      sseEvent(
        'message_delta',
        '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
      ) +
      sseEvent('message_stop', '{"type":"message_stop"}');

    const assembled = reassemble(sse);

    // Byte-equal to a non-streaming response with content=[text("Hello world")],
    // stop_reason="end_turn", final usage.
    const expected =
      '{"id":"msg_01","type":"message","role":"assistant","model":"claude","content":[{"type":"text","text":"Hello world"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"output_tokens":5}}';
    expect(assembled).toBe(expected);
  });

  it('text + tool_use: partial_json chunks are concatenated as raw wire bytes', () => {
    // Critical: partial_json deltas must be concatenated as RAW substrings,
    // not parse-restringified. The two halves below would lose ordering /
    // whitespace if round-tripped through JSON.parse.
    const messageEnvelope =
      '{"id":"msg_02","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}}';

    const sse =
      sseEvent('message_start', `{"type":"message_start","message":${messageEnvelope}}`) +
      sseEvent(
        'content_block_start',
        '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check."}}',
      ) +
      sseEvent('content_block_stop', '{"type":"content_block_stop","index":0}') +
      sseEvent(
        'content_block_start',
        '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"read_file","input":{}}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"/etc/hosts\\"}"}}',
      ) +
      sseEvent('content_block_stop', '{"type":"content_block_stop","index":1}') +
      sseEvent(
        'message_delta',
        '{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":12}}',
      ) +
      sseEvent('message_stop', '{"type":"message_stop"}');

    const assembled = reassemble(sse);

    const expected =
      '{"id":"msg_02","type":"message","role":"assistant","model":"claude","content":[' +
      '{"type":"text","text":"Let me check."},' +
      '{"type":"tool_use","id":"toolu_01","name":"read_file","input":{"path":"/etc/hosts"}}' +
      '],"stop_reason":"tool_use","stop_sequence":null,"usage":{"output_tokens":12}}';
    expect(assembled).toBe(expected);
  });

  it('thinking + text + tool_use: all three block kinds reassemble in wire order', () => {
    const messageEnvelope =
      '{"id":"msg_03","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":20,"output_tokens":10}}';

    const sse =
      sseEvent('message_start', `{"type":"message_start","message":${messageEnvelope}}`) +
      // Block 0: thinking
      sseEvent(
        'content_block_start',
        '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Considering..."}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_xyz"}}',
      ) +
      sseEvent('content_block_stop', '{"type":"content_block_stop","index":0}') +
      // Block 1: text
      sseEvent(
        'content_block_start',
        '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Reading the file."}}',
      ) +
      sseEvent('content_block_stop', '{"type":"content_block_stop","index":1}') +
      // Block 2: tool_use
      sseEvent(
        'content_block_start',
        '{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_02","name":"read_file","input":{}}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/x\\"}"}}',
      ) +
      sseEvent('content_block_stop', '{"type":"content_block_stop","index":2}') +
      sseEvent(
        'message_delta',
        '{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":15}}',
      ) +
      sseEvent('message_stop', '{"type":"message_stop"}');

    const assembled = reassemble(sse);

    const expected =
      '{"id":"msg_03","type":"message","role":"assistant","model":"claude","content":[' +
      '{"type":"thinking","thinking":"Considering...","signature":"sig_xyz"},' +
      '{"type":"text","text":"Reading the file."},' +
      '{"type":"tool_use","id":"toolu_02","name":"read_file","input":{"path":"/x"}}' +
      '],"stop_reason":"tool_use","stop_sequence":null,"usage":{"output_tokens":15}}';
    expect(assembled).toBe(expected);
  });

  it('rejects an incomplete stream (no message_stop) with a throw', () => {
    const messageEnvelope =
      '{"id":"msg_x","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{}}';
    const sse =
      sseEvent('message_start', `{"type":"message_start","message":${messageEnvelope}}`) +
      sseEvent(
        'content_block_start',
        '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      );
    const r = new AnthropicReassembler();
    r.push(Buffer.from(sse, 'utf-8'));
    expect(() => r.finalize()).toThrow();
  });

  it('numeric encoding 1.50 is preserved (no JSON.parse → JSON.stringify round-trip on tool_use.input)', () => {
    // Critical byte-fidelity gate (§12 #1, §6 invariant #1): a tool_use
    // input carrying a numeric value with trailing zeros must reach
    // the reassembled body byte-for-byte. If the reassembler ever
    // round-tripped through JSON.parse → JSON.stringify, "1.50" would
    // collapse to "1.5".
    const messageEnvelope =
      '{"id":"msg_num","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":5}}';

    const sse =
      sseEvent('message_start', `{"type":"message_start","message":${messageEnvelope}}`) +
      sseEvent(
        'content_block_start',
        '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_x","name":"price","input":{}}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"price\\":1.50}"}}',
      ) +
      sseEvent('content_block_stop', '{"type":"content_block_stop","index":0}') +
      sseEvent(
        'message_delta',
        '{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":3}}',
      ) +
      sseEvent('message_stop', '{"type":"message_stop"}');

    const assembled = reassemble(sse);
    expect(assembled).toContain('"price":1.50');
    expect(assembled).not.toContain('"price":1.5,');
    expect(assembled).not.toContain('"price":1.5}');
  });

  it('text_delta preserves unicode, JSON escapes, and emoji byte-for-byte', () => {
    // Text deltas arrive as JSON string literals on the wire. The
    // reassembler decodes them (so the inner buffer holds the raw
    // characters) and re-encodes once via JSON.stringify when assembling
    // the final body. Round-trip on a single string is byte-faithful so
    // the assembled body's JSON-encoded text matches the equivalent
    // non-streaming response.
    const messageEnvelope =
      '{"id":"msg_uni","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":5}}';

    // The wire payload uses JSON escapes for \u00e9, \", \\. On the
    // assembled side we expect JSON.stringify of the decoded characters,
    // which for é becomes the literal é (not the \u00e9 escape) — but
    // \" stays \", \\ stays \\, and emoji stay as their literal UTF-8
    // bytes. We compare against the non-streaming equivalent shape.
    const sse =
      sseEvent('message_start', `{"type":"message_start","message":${messageEnvelope}}`) +
      sseEvent(
        'content_block_start',
        '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"caf\\u00e9 \\"q\\" \\\\ 🎉"}}',
      ) +
      sseEvent('content_block_stop', '{"type":"content_block_stop","index":0}') +
      sseEvent(
        'message_delta',
        '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
      ) +
      sseEvent('message_stop', '{"type":"message_stop"}');

    const assembled = reassemble(sse);

    // The equivalent non-streaming response: the text field holds the
    // decoded characters, with JSON.stringify producing the canonical
    // escape form: literal é, escaped \", escaped \\, literal 🎉.
    const expectedText = JSON.stringify('café "q" \\ 🎉');
    expect(assembled).toContain(`"text":${expectedText}`);
    // Sanity: the emoji bytes survive into the assembled buffer
    expect(assembled).toContain('🎉');
  });

  it('multibyte UTF-8 split across feed() chunks survives (StringDecoder)', () => {
    // zlib emits chunks on arbitrary byte boundaries, so a multibyte
    // sequence can land split across two reassembler.push() calls. Without
    // a StringDecoder, each half decodes independently to U+FFFD and
    // corrupts the captured body. Deliberately split a 4-byte emoji
    // (🎉 = F0 9F 8E 89) down the middle and assert it survives intact.
    const messageEnvelope =
      '{"id":"msg_split","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":5}}';
    const sse =
      sseEvent('message_start', `{"type":"message_start","message":${messageEnvelope}}`) +
      sseEvent(
        'content_block_start',
        '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi 🎉 there"}}',
      ) +
      sseEvent('content_block_stop', '{"type":"content_block_stop","index":0}') +
      sseEvent(
        'message_delta',
        '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
      ) +
      sseEvent('message_stop', '{"type":"message_stop"}');

    const full = Buffer.from(sse, 'utf-8');
    const emojiStart = full.indexOf(Buffer.from('🎉', 'utf-8'));
    expect(emojiStart).toBeGreaterThan(0);
    const splitAt = emojiStart + 2; // mid-sequence: first push ends F0 9F, second starts 8E 89

    const r = new AnthropicReassembler();
    r.push(full.subarray(0, splitAt));
    r.push(full.subarray(splitAt));
    const assembled = r.finalize().bodyUtf8;

    expect(assembled).toContain('🎉');
    expect(assembled).not.toContain('�');
    expect(assembled).toContain(`"text":${JSON.stringify('hi 🎉 there')}`);
  });

  it('redacted_thinking survives reassembly opaquely (content_block payload preserved)', () => {
    // A redacted_thinking block carries only a base64 `data` field; no
    // deltas. The reassembler must emit it as-is. We assert the assembled
    // body contains the redacted_thinking block with its base64 data
    // preserved byte-for-byte from the original content_block.
    const messageEnvelope =
      '{"id":"msg_red","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":5}}';

    const blockPayload = '{"type":"redacted_thinking","data":"AAABBBCCC=="}';
    const sse =
      sseEvent('message_start', `{"type":"message_start","message":${messageEnvelope}}`) +
      sseEvent('content_block_start', `{"type":"content_block_start","index":0,"content_block":${blockPayload}}`) +
      sseEvent('content_block_stop', '{"type":"content_block_stop","index":0}') +
      sseEvent(
        'message_delta',
        '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
      ) +
      sseEvent('message_stop', '{"type":"message_stop"}');

    const assembled = reassemble(sse);
    // The block's raw substring from content_block_start must be in the
    // assembled content array verbatim.
    expect(assembled).toContain(blockPayload);
    expect(assembled).toContain('"data":"AAABBBCCC=="');
  });

  it('message_delta arriving after the final content_block_stop is still consumed for usage', () => {
    // The Anthropic SDK occasionally orders message_delta AFTER the last
    // content_block_stop. The reassembler must still pick up usage and
    // stop_reason from it. (Previously this could be silently dropped
    // if the implementation tied message_delta consumption to block
    // state.)
    const messageEnvelope =
      '{"id":"msg_ord","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}}';

    const sse =
      sseEvent('message_start', `{"type":"message_start","message":${messageEnvelope}}`) +
      sseEvent(
        'content_block_start',
        '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
      ) +
      sseEvent('content_block_stop', '{"type":"content_block_stop","index":0}') +
      // message_delta AFTER the final content_block_stop — the unusual ordering
      sseEvent(
        'message_delta',
        '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":17}}',
      ) +
      sseEvent('message_stop', '{"type":"message_stop"}');

    const r = new AnthropicReassembler();
    r.push(Buffer.from(sse, 'utf-8'));
    const result = r.finalize();
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toBeDefined();
    expect(result.usage?.output_tokens).toBe(17);
    // Body must include the final usage
    expect(result.bodyUtf8).toContain('"usage":{"output_tokens":17}');
    expect(result.bodyUtf8).toContain('"stop_reason":"end_turn"');
  });
});

/**
 * End-to-end byte-fidelity tests for the response-capture inlet's
 * decompression branch. Anthropic serves `/v1/messages` SSE with
 * `content-encoding: gzip` by default, so the capture pipeline must
 * decompress on the capture branch before feeding the reassembler.
 *
 * Regression gate for the bug discovered by the smoke test: prior to
 * the fan-out refactor, the captureTap sat in-series with the forwarding
 * path and saw raw gzip bytes — the reassembler silently fell through
 * and ~every `/v1/messages` record on disk was a useless base64 blob.
 *
 * See docs/designs/mitm-token-trajectory-capture.md §3 + §6 invariant 6.
 */
describe('Trajectory capture decompression (createResponseCaptureInlet)', () => {
  let dir: string;
  let writer: TrajectoryCaptureWriter;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'tj-decompress-'));
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
  });

  afterEach(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (writer) await writer.close();
    } catch {
      /* swallow */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
  });

  function makeSessionId(id: string): SessionId {
    return id as SessionId;
  }

  /** A canonical Anthropic SSE fixture matching the non-streaming "Hello world" body. */
  function helloWorldSse(): { sse: string; expectedBody: string } {
    const messageEnvelope =
      '{"id":"msg_gzip","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":5}}';
    const sse =
      sseEvent('message_start', `{"type":"message_start","message":${messageEnvelope}}`) +
      sseEvent(
        'content_block_start',
        '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}',
      ) +
      sseEvent(
        'content_block_delta',
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}',
      ) +
      sseEvent('content_block_stop', '{"type":"content_block_stop","index":0}') +
      sseEvent(
        'message_delta',
        '{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
      ) +
      sseEvent('message_stop', '{"type":"message_stop"}');
    const expectedBody =
      '{"id":"msg_gzip","type":"message","role":"assistant","model":"claude","content":[{"type":"text","text":"Hello world"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"output_tokens":5}}';
    return { sse, expectedBody };
  }

  function readJsonl<T>(path: string): T[] {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as T);
  }

  /**
   * Drive a complete capture lifecycle: begin an exchange, attach a
   * response, feed `wireBytes` to the inlet (in two halves to exercise
   * chunked behavior), close the inlet, and await `endSession`.
   *
   * Waits for the captureTap to fully drain (the in-flight reassembly
   * Promise settles) before calling `endSession`. This mirrors the
   * production lifecycle: in real use, the orchestrator never calls
   * `endSession` until the underlying agent session has cleanly closed,
   * which is long after any in-flight response capture has finalized.
   * Driving them back-to-back would trip the dispatcher's
   * `endRequested`-drops-new-writes guard before the in-flight record
   * could be enqueued.
   */
  async function driveCapture(opts: {
    sessionId: SessionId;
    contentEncoding?: string;
    wireBytes: Buffer;
    closeMode?: 'end' | 'destroy';
  }): Promise<void> {
    writer.beginSession({ sessionId: opts.sessionId });

    const handle = beginCaptureExchange({
      writer,
      sessionId: opts.sessionId,
      host: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      requestHeaders: { 'content-type': 'application/json' },
      requestStartedAt: Date.now(),
    });
    handle.setRequestBody(Buffer.from('{"model":"x"}', 'utf-8'));

    const responseHeaders: Record<string, string> = { 'content-type': 'text/event-stream; charset=utf-8' };
    if (opts.contentEncoding !== undefined) {
      responseHeaders['content-encoding'] = opts.contentEncoding;
    }

    const captureTap = handle.attachResponse({ statusCode: 200, headers: responseHeaders });

    // Wait for the tap to settle (clean end or destroyed/aborted) before
    // proceeding. PassThroughs emit 'close' after destroy or after a
    // clean end, so we listen for both to cover the success and abort
    // paths uniformly.
    const tapSettled = new Promise<void>((settle) => {
      captureTap.once('close', () => settle());
      captureTap.once('error', () => settle());
    });

    const inlet = createResponseCaptureInlet({
      captureTap,
      contentEncoding: opts.contentEncoding,
      captureHandle: handle,
      onPoison: (reason) => {
        writer.markSessionPoisoned(opts.sessionId, reason);
      },
    });

    // Feed in two halves to mimic real chunked delivery.
    const half = Math.max(1, Math.floor(opts.wireBytes.length / 2));
    inlet.write(opts.wireBytes.subarray(0, half));
    inlet.write(opts.wireBytes.subarray(half));
    if (opts.closeMode === 'destroy') {
      inlet.destroy(new Error('test-forced-abort'));
    } else {
      inlet.end();
    }

    await tapSettled;
    await writer.endSession(opts.sessionId);
  }

  it('gzipped SSE: reassembled bodyUtf8 is byte-equal to the uncompressed fixture (REGRESSION GATE)', async () => {
    const { sse, expectedBody } = helloWorldSse();
    const gzipped = zlib.gzipSync(Buffer.from(sse, 'utf-8'));

    const sid = makeSessionId('sess-gzip');
    await driveCapture({ sessionId: sid, contentEncoding: 'gzip', wireBytes: gzipped });

    const traceFile = resolve(dir, `${sid}.jsonl`);
    const records = readJsonl<ExchangeRecord>(traceFile);
    expect(records.length).toBe(1);
    const record = records[0];

    // The reassembled body must match the uncompressed fixture's expected body.
    expect(record.response.bodyUtf8).toBe(expectedBody);
    // bodyBase64 must NOT be present — compressed bytes are NEVER the
    // canonical body representation. See §6 invariant 6.
    expect(record.response.bodyBase64).toBeUndefined();
    // The content-encoding header is preserved as metadata so downstream
    // knows the wire was compressed.
    expect(record.response.headers['content-encoding']).toBe('gzip');
    expect(record.response.streaming).toBe(true);
    expect(record.capture.reassemblyOk).toBe(true);
    // The session is NOT poisoned.
    const manifest = readJsonl<ManifestEntry>(resolve(dir, 'manifest.jsonl'));
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    expect(end).toBeDefined();
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(false);
      expect(end.exchanges).toBe(1);
    }
  });

  it('truncated gzip: session is poisoned with reassembly-failure and no partial record is written', async () => {
    const { sse } = helloWorldSse();
    const gzipped = zlib.gzipSync(Buffer.from(sse, 'utf-8'));
    // Lop off the trailing 8 bytes (gzip CRC + size trailer) so the
    // decoder hits EOF before the stream completes.
    const truncated = gzipped.subarray(0, gzipped.length - 8);

    const sid = makeSessionId('sess-truncated-gzip');
    await driveCapture({ sessionId: sid, contentEncoding: 'gzip', wireBytes: truncated });

    // No partial record on disk.
    const traceFile = resolve(dir, `${sid}.jsonl`);
    if (existsSync(traceFile)) {
      const lines = readJsonl<ExchangeRecord>(traceFile);
      expect(lines.length).toBe(0);
    }

    const manifest = readJsonl<ManifestEntry>(resolve(dir, 'manifest.jsonl'));
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    expect(end).toBeDefined();
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(true);
      expect(end.poisonReason).toBe('reassembly-failure');
      expect(end.exchanges).toBe(0);
    }
  });

  it('unsupported encoding (zstd): session is poisoned with unsupported-encoding; inlet swallows further writes safely', async () => {
    // Drive arbitrary bytes through the inlet with `content-encoding:
    // zstd`. Node's zlib has no zstd decoder, so the inlet must poison
    // the session with `unsupported-encoding` and return a sink that
    // safely discards any bytes the caller still pushes. The forwarding
    // path is not exercised here (this test isolates the capture branch),
    // but the inlet's contract is that writes after the poison signal
    // never throw.
    const sid = makeSessionId('sess-zstd');
    writer.beginSession({ sessionId: sid });

    const handle = beginCaptureExchange({
      writer,
      sessionId: sid,
      host: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      requestHeaders: { 'content-type': 'application/json' },
      requestStartedAt: Date.now(),
    });
    handle.setRequestBody(Buffer.from('{"model":"x"}', 'utf-8'));

    const captureTap = handle.attachResponse({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'content-encoding': 'zstd' },
    });
    const inlet = createResponseCaptureInlet({
      captureTap,
      contentEncoding: 'zstd',
      captureHandle: handle,
      onPoison: (reason) => {
        writer.markSessionPoisoned(sid, reason);
      },
    });

    // Push some opaque bytes through. The inlet must not throw and the
    // session must be marked poisoned before this returns.
    inlet.write(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 0x29, 0x00]));
    inlet.end();

    await new Promise<void>((r) => setImmediate(r));
    await writer.endSession(sid);

    const traceFile = resolve(dir, `${sid}.jsonl`);
    if (existsSync(traceFile)) {
      const lines = readJsonl<ExchangeRecord>(traceFile);
      expect(lines.length).toBe(0);
    }

    const manifest = readJsonl<ManifestEntry>(resolve(dir, 'manifest.jsonl'));
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    expect(end).toBeDefined();
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(true);
      expect(end.poisonReason).toBe('unsupported-encoding');
    }
  });
});
