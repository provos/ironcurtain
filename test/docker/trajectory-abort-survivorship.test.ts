/**
 * Regression: a single transient upstream abort must not silently kill
 * trajectory capture for the REST of the session.
 *
 * Observed in production (workflow run a822c784, containers d3a98022 and
 * 5f997c98): capture wrote N exchanges, then stopped permanently. The
 * agent kept working and ~100+ subsequent completions succeeded upstream,
 * but none were captured. The only trace was a single DEBUG line
 * `[mitm-proxy] upstream response error: aborted`; the capture subsystem
 * logged nothing at all.
 *
 * Mechanism (fixed): the aborting exchange's tap ends without a terminal
 * SSE event and `AbstractSseReassembler.finalize()` throws
 * TruncatedStreamError. That used to call
 * `writer.markSessionPoisoned(sessionId, 'mid-stream-abort')` — SESSION
 * -scoped and permanent — so every later `write()` hit the silent
 * `session.poisoned` drop in `trajectory-capture.ts`.
 *
 * A transport truncation now costs exactly the one exchange it aborted:
 * the tap calls `writer.noteAbortedExchange(sessionId)`, the session
 * keeps capturing, and the gap is surfaced as
 * `session-end.abortedExchanges` so downstream sees it explicitly
 * instead of inheriting it silently.
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createTrajectoryCaptureWriter, type TrajectoryCaptureWriter } from '../../src/docker/trajectory-capture.js';
import { beginCaptureExchange } from '../../src/docker/trajectory-tap.js';
import type { ExchangeRecord, ManifestEntry } from '../../src/docker/trajectory-types.js';
import type { SessionId } from '../../src/session/types.js';

function readJsonl(path: string): unknown[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

function readManifest(dir: string): ManifestEntry[] {
  return readJsonl(resolve(dir, 'manifest.jsonl')) as ManifestEntry[];
}

const COMPLETE_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"c","content":[],"stop_reason":null,"stop_sequence":null,"usage":{}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

const TRUNCATED_SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"c","content":[]}}\n\n';

/** Let the writer's async appendFile drain settle. */
const settle = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 25));

describe('trajectory capture: survivorship across a transient upstream abort', () => {
  let dir: string;
  let writer: TrajectoryCaptureWriter | undefined;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'tj-survivorship-'));
  });

  afterEach(async () => {
    try {
      if (writer) await writer.close();
    } catch {
      /* swallow */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* swallow */
    }
    writer = undefined;
  });

  /**
   * Drive one exchange end-to-end through the tap, mirroring the
   * production identity-encoding path (local litellm gateway sends
   * `text/event-stream` with NO content-encoding, so the capture inlet
   * IS the tap).
   */
  async function runExchange(sid: SessionId, sse: string): Promise<void> {
    const handle = beginCaptureExchange({
      writer: writer as TrajectoryCaptureWriter,
      sessionId: sid,
      host: 'api.anthropic.com',
      path: '/v1/messages?beta=true',
      method: 'POST',
      requestHeaders: { 'content-type': 'application/json' },
      requestStartedAt: Date.now(),
    });
    handle.setRequestBody(Buffer.from('{}', 'utf-8'));
    const tap = handle.attachResponse({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
    // Production wiring: `upstreamRes.on('error'|'close'|'end')` -> `inlet.end()`.
    // With identity encoding the inlet IS the tap, so every outcome — clean
    // completion or transient abort — arrives here as `tap.end(bytes)`. The
    // only difference is whether the SSE contains its terminal `message_stop`.
    tap.end(Buffer.from(sse, 'utf-8'));
    await settle();
  }

  it('keeps capturing after ONE aborted exchange', async () => {
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = 'sess-survivorship' as SessionId;
    writer.beginSession({ sessionId: sid });

    // 2 healthy exchanges.
    await runExchange(sid, COMPLETE_SSE);
    await runExchange(sid, COMPLETE_SSE);

    // 1 transient upstream abort (stream truncated before message_stop).
    // The agent's SDK retries this transparently; upstream health is fine.
    await runExchange(sid, TRUNCATED_SSE);

    // 5 more healthy exchanges — these are the ~104 completions that
    // production silently dropped.
    for (let i = 0; i < 5; i++) {
      await runExchange(sid, COMPLETE_SSE);
    }

    await writer.endSession(sid);

    const traceFile = resolve(dir, `${sid}.jsonl`);
    const written = existsSync(traceFile) ? (readJsonl(traceFile) as ExchangeRecord[]) : [];

    // 7 healthy exchanges happened; the 1 truncated one is legitimately
    // not recordable. All 7 healthy ones should be on disk.
    expect(written.length).toBe(7);

    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    expect(end).toBeDefined();
    if (end?.event === 'session-end') {
      expect(end.exchanges).toBe(7);
    }
  });

  it('accounts for the aborted exchange itself: dropped whole, counted, never partially written', async () => {
    // The other half of the contract. Survivorship must not be bought by
    // salvaging a truncated stream: the aborted exchange produces NO
    // record at all (a half-message is worse than no message), and the
    // resulting gap is explicit on the manifest rather than silent.
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = 'sess-abort-accounting' as SessionId;
    writer.beginSession({ sessionId: sid });

    await runExchange(sid, COMPLETE_SSE);
    await runExchange(sid, COMPLETE_SSE);
    await runExchange(sid, TRUNCATED_SSE);
    for (let i = 0; i < 5; i++) {
      await runExchange(sid, COMPLETE_SSE);
    }

    const statsBeforeEnd = writer.stats();
    await writer.endSession(sid);

    const traceFile = resolve(dir, `${sid}.jsonl`);
    const written = existsSync(traceFile) ? (readJsonl(traceFile) as ExchangeRecord[]) : [];

    // (i) The truncated exchange contributed no record, partial or
    // otherwise — every record on disk is a complete reassembly.
    expect(written.length).toBe(7);
    expect(written.every((r) => r.capture.reassemblyOk)).toBe(true);
    expect(written.every((r) => r.response.stopReason === 'end_turn')).toBe(true);

    // (ii) The truncation is accounted for, not silently swallowed: it
    // is an aborted exchange, NOT a dropped record (nothing ever reached
    // the writer's queue) and NOT a poison.
    expect(statsBeforeEnd.abortedExchanges).toBe(1);
    expect(statsBeforeEnd.dropped).toBe(0);
    expect(existsSync(resolve(dir, 'manifest.poisoned'))).toBe(false);

    // (iii) The manifest records the gap explicitly and keeps the
    // session usable. No session-poisoned entry is emitted.
    const manifest = readManifest(dir);
    expect(manifest.some((m) => m.event === 'session-poisoned')).toBe(false);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    expect(end).toBeDefined();
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(false);
      expect(end.poisonReason).toBeUndefined();
      expect(end.exchanges).toBe(7);
      expect(end.abortedExchanges).toBe(1);
    }
  });
});
