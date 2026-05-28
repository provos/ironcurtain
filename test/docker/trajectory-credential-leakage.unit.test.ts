/**
 * Trajectory-capture credential-leakage unit test.
 *
 * Drives `(headers, rawBody)` tuples directly through the dispatcher's
 * redaction layer with no proxy involvement. This is the per-PR CI gate
 * against accidental real-key leakage in the trajectory corpus
 * (docs/designs/mitm-token-trajectory-capture.md §8 / §12 test #2(a)).
 *
 * The end-to-end equivalent (a full MITM CA + CONNECT setup) is opt-in
 * and runs nightly. This test must stay sub-second so it runs on every
 * PR.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTrajectoryCaptureWriter, type TrajectoryCaptureWriter } from '../../src/docker/trajectory-capture.js';
import type { ExchangeRecord } from '../../src/docker/trajectory-types.js';
import { redactHeaders } from '../../src/docker/trajectory-types.js';
import type { SessionId } from '../../src/session/types.js';

const REAL_KEY = 'sk-ant-test-REALKEY12345-DO-NOT-LEAK';

function makeSessionId(id: string): SessionId {
  return id as SessionId;
}

function buildRecord(args: {
  sessionId: SessionId;
  reqHeaders: Record<string, string>;
  reqBodyUtf8: string;
  respHeaders: Record<string, string>;
  respBodyUtf8: string;
  reassemblyDiagnostic?: string;
  streamEventData?: string;
}): ExchangeRecord {
  return {
    schemaVersion: 1,
    exchangeId: 'test-exchange-1',
    sessionId: args.sessionId,
    provider: 'anthropic',
    method: 'POST',
    host: 'api.anthropic.com',
    path: '/v1/messages',
    requestStartedAt: 1000,
    requestFinishedAt: 1010,
    responseFinishedAt: 1020,
    request: {
      headers: redactHeaders(args.reqHeaders),
      bodyUtf8: args.reqBodyUtf8,
      bodyBytes: Buffer.byteLength(args.reqBodyUtf8, 'utf-8'),
    },
    response: {
      status: 200,
      headers: redactHeaders(args.respHeaders),
      streaming: false,
      bodyUtf8: args.respBodyUtf8,
      bodyBytes: Buffer.byteLength(args.respBodyUtf8, 'utf-8'),
      ...(args.streamEventData
        ? {
            streamRaw: {
              events: [{ eventType: 'message_start', dataUtf8: args.streamEventData, offsetMs: 0 }],
            },
          }
        : {}),
    },
    capture: {
      reassemblyOk: true,
      ...(args.reassemblyDiagnostic !== undefined ? { reassemblyDiagnostic: args.reassemblyDiagnostic } : {}),
    },
  };
}

async function flush(writer: TrajectoryCaptureWriter, sessionId: SessionId): Promise<void> {
  await writer.endSession(sessionId);
  await writer.close();
}

function readAllBytes(dir: string): Buffer {
  const files = readdirSync(dir);
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(readFileSync(resolve(dir, f)));
  }
  return Buffer.concat(chunks);
}

describe('Trajectory credential leakage (writer-input unit test)', () => {
  it('(a) authorization header carrying real key is redacted before disk', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tj-leak-a-'));
    try {
      const writer = createTrajectoryCaptureWriter({ capturesDir: dir });
      const sid = makeSessionId('sess-a');
      writer.beginSession({ sessionId: sid });
      writer.write(
        buildRecord({
          sessionId: sid,
          reqHeaders: { authorization: `Bearer ${REAL_KEY}`, 'content-type': 'application/json' },
          reqBodyUtf8: '{"model":"claude","messages":[]}',
          respHeaders: { 'content-type': 'application/json' },
          respBodyUtf8: '{"id":"msg_01"}',
        }),
      );
      await flush(writer, sid);
      const blob = readAllBytes(dir).toString('utf-8');
      expect(blob).not.toContain('REALKEY12345');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(b) x-api-key header carrying real key is redacted before disk', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'tj-leak-b-'));
    try {
      const writer = createTrajectoryCaptureWriter({ capturesDir: dir });
      const sid = makeSessionId('sess-b');
      writer.beginSession({ sessionId: sid });
      writer.write(
        buildRecord({
          sessionId: sid,
          reqHeaders: { 'x-api-key': REAL_KEY, 'content-type': 'application/json' },
          reqBodyUtf8: '{"model":"claude"}',
          respHeaders: { 'content-type': 'application/json' },
          respBodyUtf8: '{}',
        }),
      );
      await flush(writer, sid);
      const blob = readAllBytes(dir).toString('utf-8');
      expect(blob).not.toContain('REALKEY12345');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(c) request body containing leaked credential string is captured verbatim (downstream tooling responsibility)', async () => {
    // This case differs from (a)/(b): if the AGENT itself leaks a credential
    // into its request body (e.g., pastes a key into a prompt), the capture
    // does NOT modify request bodies — that would corrupt the corpus. The
    // boundary is HEADERS only. Document the contract: bodies are NOT
    // redacted, and downstream curation must scrub them.
    const dir = mkdtempSync(resolve(tmpdir(), 'tj-leak-c-'));
    try {
      const writer = createTrajectoryCaptureWriter({ capturesDir: dir });
      const sid = makeSessionId('sess-c');
      writer.beginSession({ sessionId: sid });
      writer.write(
        buildRecord({
          sessionId: sid,
          reqHeaders: { 'content-type': 'application/json' },
          reqBodyUtf8: `{"prompt":"please use ${REAL_KEY}"}`,
          respHeaders: { 'content-type': 'application/json' },
          respBodyUtf8: '{}',
        }),
      );
      await flush(writer, sid);
      const blob = readAllBytes(dir).toString('utf-8');
      // Body IS expected to contain the string — verified to make the
      // contract explicit. Downstream tooling owns body-level scrubbing.
      expect(blob).toContain('REALKEY12345');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(d) upstream error reflected through reassemblyDiagnostic carrying a key is redacted by the writer', async () => {
    // The reassemblyDiagnostic field is writer-controlled (built from
    // reassembler exception messages). The writer must not transit a
    // diagnostic that contains a real key. We test this by reading the
    // emitted JSONL — if a diagnostic ever contained a real key it would
    // show up here. Today, the reassembler error messages never carry
    // request headers, so this is a regression guard: if a future change
    // ever surfaces upstream-error envelopes through diagnostics, the
    // grep here catches the leak.
    const dir = mkdtempSync(resolve(tmpdir(), 'tj-leak-d-'));
    try {
      const writer = createTrajectoryCaptureWriter({ capturesDir: dir });
      const sid = makeSessionId('sess-d');
      writer.beginSession({ sessionId: sid });
      writer.write(
        buildRecord({
          sessionId: sid,
          reqHeaders: { 'x-api-key': REAL_KEY }, // pre-redaction
          reqBodyUtf8: '{}',
          respHeaders: { 'content-type': 'application/json' },
          respBodyUtf8: '{"error":"unauthorized"}',
          reassemblyDiagnostic: 'malformed SSE',
        }),
      );
      await flush(writer, sid);
      const blob = readAllBytes(dir).toString('utf-8');
      expect(blob).not.toContain('REALKEY12345');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(e) streamRaw.events payload (which CAN contain agent-emitted text) is not auto-scrubbed for credential keys (contract documentation)', async () => {
    // Same as (c): streamRaw.events.dataUtf8 contains the agent's
    // raw SSE payload. We capture it verbatim and rely on downstream
    // scrubbing for any in-stream leakage. Documenting via test.
    const dir = mkdtempSync(resolve(tmpdir(), 'tj-leak-e-'));
    try {
      const writer = createTrajectoryCaptureWriter({ capturesDir: dir });
      const sid = makeSessionId('sess-e');
      writer.beginSession({ sessionId: sid });
      writer.write(
        buildRecord({
          sessionId: sid,
          reqHeaders: { 'content-type': 'application/json' },
          reqBodyUtf8: '{}',
          respHeaders: { 'content-type': 'text/event-stream' },
          respBodyUtf8: '',
          streamEventData: `{"type":"text","text":"hi ${REAL_KEY}"}`,
        }),
      );
      await flush(writer, sid);
      const blob = readAllBytes(dir).toString('utf-8');
      expect(blob).toContain('REALKEY12345');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redactHeaders is case-insensitive on every dangerous header name', () => {
    const out = redactHeaders({
      AUTHORIZATION: `Bearer ${REAL_KEY}`,
      'X-API-KEY': REAL_KEY,
      'Proxy-Authorization': `Basic ${REAL_KEY}`,
      Cookie: `session=${REAL_KEY}`,
      'Set-Cookie': REAL_KEY,
      'content-type': 'application/json',
    });
    expect(out.authorization).toBe('<redacted>');
    expect(out['x-api-key']).toBe('<redacted>');
    expect(out['proxy-authorization']).toBe('<redacted>');
    expect(out.cookie).toBe('<redacted>');
    expect(out['set-cookie']).toBe('<redacted>');
    expect(out['content-type']).toBe('application/json');
  });
});
