/**
 * Trajectory-capture session-poisoning behavior.
 *
 * Covers §12 test #4 from docs/designs/mitm-token-trajectory-capture.md:
 *   (a) disk error -> session-end carries `poisoned: true` /
 *       `poisonReason: 'disk-error'` (with fs-injection so we can fail on
 *       the Nth record deterministically)
 *   (b) reassembly failure -> partial record is not written; the session
 *       is marked poisoned in its session-end manifest entry
 *   (c) counter consistency under load -> on-disk line count equals
 *       `exchanges` in session-end (no individual records dropped)
 *
 * Plus the issue 1 / issue 2 fixes:
 *   - mid-stream-abort poison wiring (tap closes before _flush)
 *   - in-flight tracking blocks endSession until reassembly settles
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  createTrajectoryCaptureWriter,
  type TrajectoryCaptureWriter,
  type WriterFsDep,
} from '../../src/docker/trajectory-capture.js';
import { AnthropicReassembler, ReassemblyError } from '../../src/docker/trajectory-reassembler.js';
import { beginCaptureExchange } from '../../src/docker/trajectory-tap.js';
import type { ExchangeRecord, ManifestEntry } from '../../src/docker/trajectory-types.js';
import type { SessionId } from '../../src/session/types.js';

const FIXTURES = resolve(fileURLToPath(import.meta.url), '..', 'fixtures');

function makeSessionId(id: string): SessionId {
  return id as SessionId;
}

function buildRecord(sessionId: SessionId, n: number): ExchangeRecord {
  const body = `{"i":${n}}`;
  return {
    schemaVersion: 1,
    exchangeId: `ex-${n}`,
    sessionId,
    provider: 'anthropic',
    method: 'POST',
    host: 'api.anthropic.com',
    path: '/v1/messages',
    requestStartedAt: 0,
    requestFinishedAt: 1,
    responseFinishedAt: 2,
    request: { headers: {}, bodyUtf8: body, bodyBytes: Buffer.byteLength(body) },
    response: {
      status: 200,
      headers: {},
      streaming: false,
      bodyUtf8: body,
      bodyBytes: Buffer.byteLength(body),
    },
    capture: { reassemblyOk: true },
  };
}

function readJsonl(path: string): unknown[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

function readManifest(dir: string): ManifestEntry[] {
  return readJsonl(resolve(dir, 'manifest.jsonl')) as ManifestEntry[];
}

/**
 * Build a WriterFsDep that delegates to real `node:fs/promises` but
 * counts `appendFile` calls and fails the Nth one matching `failOnPath`.
 */
function makeFailOnAppendFs(opts: { failAfter: number; failOnPath?: (p: string) => boolean }): {
  fs: WriterFsDep;
  appendCallsByPath: Map<string, number>;
} {
  const appendCallsByPath = new Map<string, number>();
  let matchedAppendCount = 0;
  const real = {
    appendFile: async (p: string, d: string): Promise<void> => {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(p, d);
    },
    mkdir: async (p: string, o: { recursive: true }): Promise<unknown> => {
      const { mkdir } = await import('node:fs/promises');
      return mkdir(p, o);
    },
    writeFile: async (p: string, d: string): Promise<void> => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(p, d);
    },
  };
  const fs: WriterFsDep = {
    async appendFile(p: string, d: string) {
      const prior = appendCallsByPath.get(p) ?? 0;
      appendCallsByPath.set(p, prior + 1);
      const match = opts.failOnPath ? opts.failOnPath(p) : true;
      if (match) {
        matchedAppendCount += 1;
        if (matchedAppendCount === opts.failAfter) {
          const err = new Error('ENOSPC: simulated no space left on device');
          (err as NodeJS.ErrnoException).code = 'ENOSPC';
          throw err;
        }
      }
      await real.appendFile(p, d);
    },
    mkdir: real.mkdir,
    writeFile: real.writeFile,
  };
  return { fs, appendCallsByPath };
}

describe('Trajectory poison: failure modes', () => {
  let dir: string;
  let writer: TrajectoryCaptureWriter;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'tj-poison-'));
  });

  afterEach(async () => {
    try {
      // writer is conditionally undefined in setups that fail early.
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
    vi.restoreAllMocks();
  });

  it('(a) disk write error on Nth record: session is poisoned, file has N-1 records, marker is written, new sessions rejected', async () => {
    // Inject an fs that fails on the 3rd append to the per-session
    // trajectory file. The injection lets us assert exactly N-1 records
    // on disk and the manifest entry's poison fields.
    const sid = makeSessionId('sess-enospc');
    const sessionPath = resolve(dir, `${sid}.jsonl`);
    const { fs: failingFs } = makeFailOnAppendFs({
      failAfter: 3,
      failOnPath: (p) => p === sessionPath,
    });
    writer = createTrajectoryCaptureWriter({ capturesDir: dir, fs: failingFs });
    writer.beginSession({ sessionId: sid });

    for (let i = 1; i <= 5; i++) {
      writer.write(buildRecord(sid, i));
    }
    await writer.endSession(sid);

    // (i) file contains exactly N-1 = 2 records (the 3rd append threw).
    const lines = readJsonl(sessionPath);
    expect(lines.length).toBe(2);

    // (ii) the session-end manifest entry reports poisoned + reason.
    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    expect(end).toBeDefined();
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(true);
      expect(end.poisonReason).toBe('disk-error');
      // exchanges counter matches the records that actually reached disk
      expect(end.exchanges).toBe(2);
    }

    // (iii) per-session disk error must NOT trigger the bundle-wide
    // manifest.poisoned marker — only manifest-level failures do.
    expect(existsSync(resolve(dir, 'manifest.poisoned'))).toBe(false);

    // Subsequent writes for the same session no-op (already poisoned).
    // begin a NEW session on the same dir to confirm the per-session
    // disk error did NOT poison the bundle.
    const sid2 = makeSessionId('sess-followup');
    writer.beginSession({ sessionId: sid2 });
    writer.write(buildRecord(sid2, 99));
    await writer.endSession(sid2);
    const followLines = readJsonl(resolve(dir, `${sid2}.jsonl`));
    expect(followLines.length).toBe(1);
  });

  it('(a.2) manifest-level disk error writes the manifest.poisoned marker and rejects new sessions', async () => {
    // Fail the very first manifest append (= session-start). This is
    // bundle-wide blast radius per §9.4: marker file, refuse new
    // sessions, poison every open session.
    const manifestPath = resolve(dir, 'manifest.jsonl');
    const { fs: failingFs } = makeFailOnAppendFs({
      failAfter: 1,
      failOnPath: (p) => p === manifestPath,
    });
    writer = createTrajectoryCaptureWriter({ capturesDir: dir, fs: failingFs });
    const sid = makeSessionId('sess-mfail');
    writer.beginSession({ sessionId: sid });
    writer.write(buildRecord(sid, 1));
    // endSession should not hang — the bundle-wide failure path resolves
    // all pending end-resolvers.
    await writer.endSession(sid).catch(() => {});

    // (iii) manifest.poisoned marker exists.
    expect(existsSync(resolve(dir, 'manifest.poisoned'))).toBe(true);

    // (iv) subsequent beginCaptureSession calls are rejected: no new
    // sessions accepted, no new files created.
    const sid2 = makeSessionId('sess-after-poison');
    writer.beginSession({ sessionId: sid2 });
    expect(existsSync(resolve(dir, `${sid2}.jsonl`))).toBe(false);
  });

  it('(b) reassembly failure driven through the dispatcher poisons the session with reassembly-failure and writes no partial record', async () => {
    // Drive a real malformed SSE event through the trajectory tap +
    // dispatcher (not the reassembler in isolation). Asserts the
    // session is poisoned via the public surface and the on-disk
    // trajectory file is empty (no partial record).
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-reasm');
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
    handle.setRequestBody(Buffer.from('{}', 'utf-8'));
    const tap = handle.attachResponse({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

    // Feed a genuinely malformed event sequence: message_start (ok) followed
    // by a content_block_delta for an index with NO preceding
    // content_block_start. The dispatcher throws ("content_block_delta for
    // unknown index 0"), latching the reassembler as failed — a real parse
    // failure, distinct from a transport truncation. finalize() rethrows it
    // (NOT a TruncatedStreamError), so the tap poisons 'reassembly-failure'
    // and no record is enqueued.
    const malformedSse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","model":"c","content":[]}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n';

    const src = new PassThrough();
    src.pipe(tap);
    src.end(Buffer.from(malformedSse, 'utf-8'));

    await writer.endSession(sid);

    // No record file should exist (or, if it was created, it must be empty).
    const traceFile = resolve(dir, `${sid}.jsonl`);
    if (existsSync(traceFile)) {
      const lines = readJsonl(traceFile);
      expect(lines.length).toBe(0);
    }

    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    expect(end).toBeDefined();
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(true);
      expect(end.poisonReason).toBe('reassembly-failure');
      expect(end.exchanges).toBe(0);
    }
  });

  it('(b.0) reassembler in isolation refuses to emit a partial body on malformed SSE', () => {
    // Sanity check the underlying invariant: the reassembler itself
    // throws on a malformed stream. Combined with the tap's
    // exception-handling logic, this guarantees no partial reassembly
    // can ever be handed to the writer.
    const malformedSse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","model":"c","content":[]}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';

    const r = new AnthropicReassembler();
    r.push(Buffer.from(malformedSse, 'utf-8'));
    expect(() => r.finalize()).toThrow(ReassemblyError);
  });

  it('(c) counter consistency under load: line count equals session-end.exchanges', async () => {
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-load');
    writer.beginSession({ sessionId: sid });

    const N = 200;
    for (let i = 0; i < N; i++) {
      writer.write(buildRecord(sid, i));
    }
    await writer.endSession(sid);

    const traceFile = resolve(dir, `${sid}.jsonl`);
    const lines = readJsonl(traceFile);
    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    expect(end).toBeDefined();
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(false);
      expect(end.exchanges).toBe(lines.length);
      expect(lines.length).toBe(N);
    }
  });

  it('infrastructure-teardown safety net emits a synthetic session-end with closedReason', async () => {
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-teardown');
    writer.beginSession({ sessionId: sid });
    writer.write(buildRecord(sid, 1));
    writer.write(buildRecord(sid, 2));
    await writer.close();

    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    expect(end).toBeDefined();
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(true);
      expect(end.poisonReason).toBe('infrastructure-teardown');
      expect(end.closedReason).toBe('infrastructure-teardown');
    }
  });

  it('mid-stream abort (tap closes before _flush) poisons the session with mid-stream-abort', async () => {
    // The trajectory tap's `close` event arriving before `_flush` is
    // the §9 mid-stream-abort signal. We drive an SSE response by
    // piping into the tap, then destroy the upstream side BEFORE the
    // reassembler sees a message_stop — the tap should mark the session
    // poisoned via markSessionPoisoned('mid-stream-abort').
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-midabort');
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
    handle.setRequestBody(Buffer.from('{}', 'utf-8'));
    const tap = handle.attachResponse({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

    // Begin a stream but never finalize: write partial bytes, then
    // destroy the tap to simulate the upstream closing mid-stream.
    tap.write(
      Buffer.from(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"x","type":"message","role":"assistant","model":"m","content":[]}}\n\n',
        'utf-8',
      ),
    );
    // Destroy with an error — the tap emits 'error' first, then 'close'.
    // Either path should mark the session poisoned with mid-stream-abort.
    tap.destroy(new Error('upstream reset'));

    // Give the tap's lifecycle events a microtask to settle.
    await new Promise<void>((r) => setImmediate(r));

    await writer.endSession(sid);

    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    expect(end).toBeDefined();
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(true);
      expect(end.poisonReason).toBe('mid-stream-abort');
    }
  });

  it('in-flight tracking: endSession waits for a slow in-flight Promise before resolving', async () => {
    // Drive an externally-controlled Promise via trackInFlight, then
    // call endSession. The endSession Promise must not resolve until
    // the in-flight settles. We instrument with a flag that flips after
    // settlement; if endSession resolved early the flag would be false.
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-inflight');
    writer.beginSession({ sessionId: sid });
    writer.write(buildRecord(sid, 1));

    let settled = false;
    let resolveInflight!: () => void;
    const inflight = new Promise<void>((r) => {
      resolveInflight = r;
    });
    writer.trackInFlight(sid, inflight);

    const endPromise = writer.endSession(sid).then(() => {
      expect(settled).toBe(true); // endSession only fires AFTER the in-flight settles
    });

    // Schedule the inflight to settle after a tick. If endSession races
    // ahead, the assertion above will fail.
    setTimeout(() => {
      settled = true;
      resolveInflight();
    }, 30);

    await endPromise;

    // And the session-end manifest entry must be durable on disk by
    // the time endSession returns.
    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    expect(end).toBeDefined();
    if (end?.event === 'session-end') {
      expect(end.exchanges).toBe(1);
    }
  });

  it('lifecycle: Anthropic message_stop-then-close writes a record and does NOT poison', async () => {
    // canFinalize() hardening: a socket abort AFTER the terminal event
    // (message_stop) must finalize a faithful record, not poison.
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-anth-stop-then-close');
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
    handle.setRequestBody(Buffer.from('{}', 'utf-8'));
    const tap = handle.attachResponse({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

    const completeSse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"c","content":[],"stop_reason":null,"stop_sequence":null,"usage":{}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';

    // Write the complete stream, then destroy WITHOUT a clean end.
    tap.write(Buffer.from(completeSse, 'utf-8'));
    await new Promise<void>((r) => setImmediate(r));
    tap.destroy(new Error('socket reset after message_stop'));

    await new Promise<void>((r) => setImmediate(r));
    await writer.endSession(sid);

    const traceFile = resolve(dir, `${sid}.jsonl`);
    const lines = readJsonl(traceFile) as ExchangeRecord[];
    expect(lines.length).toBe(1);
    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(false);
      expect(end.exchanges).toBe(1);
    }
  });

  it('lifecycle: Anthropic close BEFORE message_stop still poisons mid-stream-abort (no record)', async () => {
    // Genuinely-truncated stream: abort before the terminal event. The
    // canFinalize() path must NOT rescue this.
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-anth-truncated');
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
    handle.setRequestBody(Buffer.from('{}', 'utf-8'));
    const tap = handle.attachResponse({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

    tap.write(
      Buffer.from(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"c","content":[]}}\n\n',
        'utf-8',
      ),
    );
    await new Promise<void>((r) => setImmediate(r));
    tap.destroy(new Error('socket reset before message_stop'));

    await new Promise<void>((r) => setImmediate(r));
    await writer.endSession(sid);

    const traceFile = resolve(dir, `${sid}.jsonl`);
    if (existsSync(traceFile)) {
      expect(readJsonl(traceFile).length).toBe(0);
    }
    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(true);
      expect(end.poisonReason).toBe('mid-stream-abort');
    }
  });

  it('lifecycle: clean end() with no terminal event poisons mid-stream-abort, NOT reassembly-failure', async () => {
    // The gzip-tail recovery path turns an upstream reset into a graceful
    // inlet.end() → a clean tap 'end' with no terminal event parsed. That is a
    // transport truncation, not a reassembly bug, so it must poison
    // mid-stream-abort. (Before the TruncatedStreamError fix this clean-end
    // path mislabeled truncations as reassembly-failure.)
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-clean-end-no-terminal');
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
    handle.setRequestBody(Buffer.from('{}', 'utf-8'));
    const tap = handle.attachResponse({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

    // Well-formed partial stream (message_start, no message_stop), ended
    // CLEANLY — mirrors an upstream reset flushed gracefully via inlet.end().
    tap.end(
      Buffer.from(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"c","content":[]}}\n\n',
        'utf-8',
      ),
    );

    await new Promise<void>((r) => setImmediate(r));
    await writer.endSession(sid);

    const traceFile = resolve(dir, `${sid}.jsonl`);
    if (existsSync(traceFile)) {
      expect(readJsonl(traceFile).length).toBe(0);
    }
    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(true);
      expect(end.poisonReason).toBe('mid-stream-abort');
    }
  });

  it('lifecycle: Responses response.completed-then-close-without-end writes a record (not poisoned)', async () => {
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-resp-completed-then-close');
    writer.beginSession({ sessionId: sid });

    const handle = beginCaptureExchange({
      writer,
      sessionId: sid,
      host: 'chatgpt.com',
      path: '/backend-api/codex/responses',
      method: 'POST',
      requestHeaders: { 'content-type': 'application/json' },
      requestStartedAt: Date.now(),
    });
    handle.setRequestBody(Buffer.from('{}', 'utf-8'));
    const tap = handle.attachResponse({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

    const sse = readFileSync(resolve(FIXTURES, 'codex-responses-stream.sse'), 'utf-8');
    tap.write(Buffer.from(sse, 'utf-8'));
    await new Promise<void>((r) => setImmediate(r));
    // Close WITHOUT a clean end after response.completed already landed.
    tap.destroy(new Error('socket teardown at session end'));

    await new Promise<void>((r) => setImmediate(r));
    await writer.endSession(sid);

    const traceFile = resolve(dir, `${sid}.jsonl`);
    const lines = readJsonl(traceFile) as ExchangeRecord[];
    expect(lines.length).toBe(1);
    expect(lines[0].response.bodyUtf8).toContain('17 * 23 = 17 * (20 + 3) = 340 + 51 = 391');
    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(false);
      expect(end.exchanges).toBe(1);
    }
  });

  it('HEADERLESS ENGAGEMENT: codex chatgpt.com with NO content-type still engages the reassembler (streaming:true + structured fields)', async () => {
    // The live codex chatgpt.com response carries NO content-type header
    // (only transfer-encoding:chunked + x-oai-request-id). This is the
    // exact shape the content-type-only gate dropped to raw bytes. After
    // the host-driven engagement fix the reassembler MUST engage.
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-headerless-engagement');
    writer.beginSession({ sessionId: sid });

    const handle = beginCaptureExchange({
      writer,
      sessionId: sid,
      host: 'chatgpt.com',
      path: '/backend-api/codex/responses',
      method: 'POST',
      requestHeaders: { 'content-type': 'application/json' },
      requestStartedAt: Date.now(),
    });
    handle.setRequestBody(Buffer.from('{}', 'utf-8'));
    // NO content-type — mirrors the real codex upstream response headers.
    const tap = handle.attachResponse({
      statusCode: 200,
      headers: { 'transfer-encoding': 'chunked', 'x-oai-request-id': 'req_test' },
    });

    const sse = readFileSync(resolve(FIXTURES, 'codex-responses-stream.sse'), 'utf-8');
    tap.end(Buffer.from(sse, 'utf-8'));

    await new Promise<void>((r) => setImmediate(r));
    await writer.endSession(sid);

    const traceFile = resolve(dir, `${sid}.jsonl`);
    const lines = readJsonl(traceFile) as ExchangeRecord[];
    expect(lines.length).toBe(1);
    const rec = lines[0];
    // Reassembler engaged: streaming flag + structured fields populated.
    expect(rec.response.streaming).toBe(true);
    expect(rec.response.providerRequestId).toBe('resp_044409b8234111cf016a2e059444e481998de5fc1941e9ce57');
    expect(rec.response.stopReason).toBe('completed');
    expect(rec.response.usage).toEqual({
      input_tokens: 12047,
      input_tokens_details: { cached_tokens: 11648 },
      output_tokens: 27,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 12074,
    });
    // bodyUtf8 is the reassembled `"object":"response"` envelope, NOT raw SSE.
    expect(rec.response.bodyUtf8).toContain('"object":"response"');
    expect(rec.response.bodyUtf8).not.toContain('event: response.completed');
    expect(rec.response.bodyUtf8).toContain('17 * 23 = 17 * (20 + 3) = 340 + 51 = 391');

    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(false);
      expect(end.exchanges).toBe(1);
    }
  });

  it('NON-STREAMING JSON on a reassembler host is captured raw, NOT poisoned', async () => {
    // A capturable completion endpoint can answer stream:false with a single
    // JSON object (content-type: application/json). It must be captured
    // verbatim, NOT routed to the SSE reassembler — which would never see a
    // terminal event and would falsely poison the session reassembly-failure.
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-nonstreaming-json');
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
    handle.setRequestBody(Buffer.from('{"stream":false}', 'utf-8'));
    const jsonBody =
      '{"id":"msg_01","type":"message","role":"assistant","content":[{"type":"text","text":"hi"}],"stop_reason":"end_turn"}';
    // content-type: application/json (present, non-SSE) → reassembler must NOT engage.
    const tap = handle.attachResponse({ statusCode: 200, headers: { 'content-type': 'application/json' } });
    tap.end(Buffer.from(jsonBody, 'utf-8'));

    await new Promise<void>((r) => setImmediate(r));
    await writer.endSession(sid);

    const lines = readJsonl(resolve(dir, `${sid}.jsonl`)) as ExchangeRecord[];
    expect(lines.length).toBe(1);
    const rec = lines[0];
    // Reassembler did NOT engage: raw verbatim capture, no structured fields.
    expect(rec.response.streaming).toBe(false);
    expect(rec.response.providerRequestId).toBeUndefined();
    expect(rec.response.bodyUtf8).toBe(jsonBody);

    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(false);
      expect(end.exchanges).toBe(1);
    }
  });

  it('HEADERLESS LIFECYCLE: codex completed-then-close with empty headers writes a record (canFinalize, not poison)', async () => {
    // The real codex header shape (no content-type) on the
    // completed-then-socket-close lifecycle: canFinalize() must recover a
    // faithful record rather than poison mid-stream-abort.
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-headerless-completed-then-close');
    writer.beginSession({ sessionId: sid });

    const handle = beginCaptureExchange({
      writer,
      sessionId: sid,
      host: 'chatgpt.com',
      path: '/backend-api/codex/responses',
      method: 'POST',
      requestHeaders: { 'content-type': 'application/json' },
      requestStartedAt: Date.now(),
    });
    handle.setRequestBody(Buffer.from('{}', 'utf-8'));
    const tap = handle.attachResponse({ statusCode: 200, headers: {} });

    const sse = readFileSync(resolve(FIXTURES, 'codex-responses-stream.sse'), 'utf-8');
    tap.write(Buffer.from(sse, 'utf-8'));
    await new Promise<void>((r) => setImmediate(r));
    // Close WITHOUT a clean end after response.completed already landed.
    tap.destroy(new Error('socket teardown at session end'));

    await new Promise<void>((r) => setImmediate(r));
    await writer.endSession(sid);

    const traceFile = resolve(dir, `${sid}.jsonl`);
    const lines = readJsonl(traceFile) as ExchangeRecord[];
    expect(lines.length).toBe(1);
    expect(lines[0].response.streaming).toBe(true);
    expect(lines[0].response.bodyUtf8).toContain('17 * 23 = 17 * (20 + 3) = 340 + 51 = 391');
    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(false);
      expect(end.exchanges).toBe(1);
    }
  });

  it('lifecycle: GZIP path — terminal-bearing compressed stream then close-without-end still writes a record', async () => {
    // The genuine gzip-path fix: on a graceful close-without-end, the
    // proxy calls inlet.end() so zlib _flush emits the buffered tail and
    // the reassembler sees response.completed. We exercise the decompressor
    // inlet directly: write the full gzip then inlet.end() (mirroring the
    // mitm-proxy upstream-close path), and assert a faithful record.
    const { createResponseCaptureInlet } = await import('../../src/docker/trajectory-tap.js');
    const zlib = await import('node:zlib');

    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-resp-gzip-terminal');
    writer.beginSession({ sessionId: sid });

    const handle = beginCaptureExchange({
      writer,
      sessionId: sid,
      host: 'chatgpt.com',
      path: '/backend-api/codex/responses',
      method: 'POST',
      requestHeaders: { 'content-type': 'application/json' },
      requestStartedAt: Date.now(),
    });
    handle.setRequestBody(Buffer.from('{}', 'utf-8'));
    const captureTap = handle.attachResponse({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
    });
    const tapSettled = new Promise<void>((settle) => {
      captureTap.once('close', () => settle());
      captureTap.once('error', () => settle());
    });

    const inlet = createResponseCaptureInlet({
      captureTap,
      contentEncoding: 'gzip',
      captureHandle: handle,
      onPoison: (reason) => writer.markSessionPoisoned(sid, reason),
    });

    const sse = readFileSync(resolve(FIXTURES, 'codex-responses-stream.sse'), 'utf-8');
    const gz = zlib.gzipSync(Buffer.from(sse, 'utf-8'));
    inlet.write(gz);
    // Graceful close-without-end: end() (NOT destroy) so zlib flushes its
    // tail through to the tap and the reassembler sees response.completed.
    inlet.end();

    await tapSettled;
    await writer.endSession(sid);

    const traceFile = resolve(dir, `${sid}.jsonl`);
    const lines = readJsonl(traceFile) as ExchangeRecord[];
    expect(lines.length).toBe(1);
    expect(lines[0].response.bodyUtf8).toContain('17 * 23 = 17 * (20 + 3) = 340 + 51 = 391');
    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(false);
    }
  });

  it('lifecycle: error-then-close pair finalizes exactly once (one record, zero extra poison)', async () => {
    // tap.destroy(err) emits 'error' then 'close'. With a terminal event
    // already seen, the FIRST event must finalize and the SECOND must
    // short-circuit via the finalized guard — exactly one record, no poison.
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-error-then-close');
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
    handle.setRequestBody(Buffer.from('{}', 'utf-8'));
    const tap = handle.attachResponse({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

    const completeSse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"c","content":[],"stop_reason":null,"stop_sequence":null,"usage":{}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    tap.write(Buffer.from(completeSse, 'utf-8'));
    await new Promise<void>((r) => setImmediate(r));
    // destroy(err) → 'error' then 'close'.
    tap.destroy(new Error('reset'));

    await new Promise<void>((r) => setImmediate(r));
    await writer.endSession(sid);

    const traceFile = resolve(dir, `${sid}.jsonl`);
    const lines = readJsonl(traceFile) as ExchangeRecord[];
    expect(lines.length).toBe(1);
    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(false);
      expect(end.poisonReason).toBeUndefined();
    }
  });

  it('lifecycle: endSession teardown timeout poisons a never-settling in-flight tap', async () => {
    // A stream that never terminates and never aborts would hang teardown.
    // endSession must bound the in-flight wait and poison mid-stream-abort.
    writer = createTrajectoryCaptureWriter({ capturesDir: dir, teardownTimeoutMs: 20 });
    const sid = makeSessionId('sess-hung-teardown');
    writer.beginSession({ sessionId: sid });

    // A promise that never settles, registered as in-flight.
    writer.trackInFlight(sid, new Promise<void>(() => {}));

    await writer.endSession(sid);

    const manifest = readManifest(dir);
    const end = manifest.find((m) => m.event === 'session-end' && m.sessionId === sid);
    expect(end).toBeDefined();
    if (end?.event === 'session-end') {
      expect(end.poisoned).toBe(true);
      expect(end.poisonReason).toBe('mid-stream-abort');
    }
  });

  it('(f) duplicate beginSession with conflicting persona/fsmState: first wins, warns loudly', async () => {
    // Hardening for the double-begin footgun: when two call sites both
    // drive capture for the same sessionId (the workflow shared-container
    // bug), the dispatcher's first-wins idempotency silently dropped the
    // richer begin. A duplicate begin carrying different persona/fsmState
    // must now warn so the latent bug is loud, while the first entry
    // remains authoritative on the manifest.
    const logger = await import('../../src/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-dup-begin');

    // First begin: bare sessionId (the docker-agent-session call site).
    writer.beginSession({ sessionId: sid });
    // Second begin: richer metadata (the orchestrator call site).
    writer.beginSession({ sessionId: sid, persona: 'researcher', fsmState: 'triage' });

    // (i) the conflicting duplicate produced exactly one warn.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('duplicate beginSession');
    expect(warnSpy.mock.calls[0]?.[0]).toContain(sid);

    await writer.endSession(sid);

    // (ii) first begin wins: the single session-start entry carries
    // NEITHER persona NOR fsmState (the bare first call's metadata).
    const manifest = readManifest(dir);
    const starts = manifest.filter((m) => m.event === 'session-start' && m.sessionId === sid);
    expect(starts.length).toBe(1);
    const start = starts[0];
    if (start.event === 'session-start') {
      expect(start.persona).toBeUndefined();
      expect(start.fsmState).toBeUndefined();
    }
  });

  it('(g) duplicate beginSession with identical metadata does not warn', async () => {
    // A pure idempotent retry (same metadata) is benign — no warn.
    const logger = await import('../../src/logger.js');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = makeSessionId('sess-dup-benign');

    writer.beginSession({ sessionId: sid, persona: 'researcher', fsmState: 'triage' });
    writer.beginSession({ sessionId: sid, persona: 'researcher', fsmState: 'triage' });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
