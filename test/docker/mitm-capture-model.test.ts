import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateCA, type CertificateAuthority } from '../../src/docker/ca.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import { anthropicOAuthProvider } from '../../src/docker/provider-config.js';
import { createTrajectoryCaptureWriter, type TrajectoryCaptureWriter } from '../../src/docker/trajectory-capture.js';
import type { ExchangeRecord, ManifestEntry } from '../../src/docker/trajectory-types.js';
import type { SessionId } from '../../src/session/types.js';
import { sendConnect } from '../helpers/mitm-tls-harness.js';
import { encodeModelSse, modelAnthropicResponse } from '../helpers/trajectory-model-fixtures.js';

const host = anthropicOAuthProvider.host;
const fakeKey = 'capture-sentinel';
const realKey = 'capture-injected-token';
const refreshedKey = 'capture-refreshed-token';
const replyCookie = 'capture-private-cookie';
const retryBody = '{"error":"internal refresh challenge"}';
const sessionA = { sessionId: 'capture-a' as SessionId, persona: 'persona-a', fsmState: 'state-a' };
const sessionB = { sessionId: 'capture-b' as SessionId, persona: 'persona-b', fsmState: 'state-b' };
const telemetrySessionId = 'token-stream-only' as SessionId;

type RequestId = 'a-first' | 'a-pending' | 'b' | 'disabled';
const requestBody = (id: RequestId) => `{ "model": "claude-test", "messages": [], "id": "${id}" }`;
const responseBody = (id: string) => JSON.stringify({ id, text: 'completed' });
const partialSse =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"partial","type":"message","role":"assistant","model":"claude-test","content":[]}}\n\n';
const partialJson = '{"id":"a-pending","text":"interrupted';

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as T);
}

function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

const outcomes = ['finish', 'truncated SSE', 'aborted JSON', 'OAuth retry'] as const;
const traces = outcomes.flatMap((outcome) => [false, true].map((endBFirst) => ({ outcome, endBFirst })));

describe('MITM capture and session attribution model', () => {
  let dir: string;
  let ca: CertificateAuthority;
  let socketPath: string;
  let capturesDir: string;
  let upstream: http.Server;
  let proxy: MitmProxy;
  let writer: TrajectoryCaptureWriter;
  let pending: http.ServerResponse | undefined;
  let replyToRetry: (res: http.ServerResponse) => void;
  let attempts: { id: string | null; body: string; auth: string | undefined }[];
  let refreshStarted: ReturnType<typeof gate>;
  let refreshMayFinish: ReturnType<typeof gate>;
  const agents = new Set<https.Agent>();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mitm-capture-model-'));
    ca = loadOrCreateCA(join(dir, 'ca'));
    socketPath = join(dir, 'mitm.sock');
  });

  beforeEach(async () => {
    capturesDir = mkdtempSync(join(dir, 'captures-'));
    pending = undefined;
    replyToRetry = (res) => sendJson(res, 200, responseBody('a-pending'));
    attempts = [];
    refreshStarted = gate();
    refreshMayFinish = gate();
    writer = createTrajectoryCaptureWriter({ capturesDir });
    upstream = http.createServer((req, res) => {
      const id = new URL(req.url ?? '/', 'http://fixture.test').searchParams.get('id');
      req.setEncoding('utf8');
      let body = '';
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        const firstAttempt = !attempts.some((attempt) => attempt.id === id);
        attempts.push({ id, body, auth: req.headers.authorization });
        if (id !== 'a-pending') sendJson(res, 200, responseBody(id ?? ''));
        else if (firstAttempt) pending = res;
        else replyToRetry(res);
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const { port } = upstream.address() as AddressInfo;
    const tokenManager = {
      getValidAccessToken: () => Promise.resolve(realKey),
      async handleAuthFailure() {
        refreshStarted.release();
        await refreshMayFinish.ready;
        return refreshedKey;
      },
    };
    proxy = createMitmProxy({
      socketPath,
      ca,
      capture: writer,
      agentKind: 'workflow',
      providers: [
        {
          config: {
            ...anthropicOAuthProvider,
            upstreamTarget: { hostname: '127.0.0.1', port, pathPrefix: '', useTls: false },
          },
          fakeKey,
          realKey,
          tokenManager,
        },
      ],
    });
    await proxy.start();
  });

  afterEach(async () => {
    refreshMayFinish.release();
    for (const agent of agents) agent.destroy();
    agents.clear();
    await proxy.stop();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await writer.close();
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function sendJson(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'set-cookie': `fixture=${replyCookie}`,
    });
    res.end(body);
  }

  function selectSession(session?: typeof sessionA): void {
    proxy.setCaptureSessionId(session?.sessionId);
    proxy.setCapturePersona(session?.persona);
    if (session) writer.beginSession(session);
  }

  async function openTunnel(): Promise<https.Agent> {
    const { socket, statusCode } = await sendConnect(socketPath, host, 443);
    if (!socket || statusCode !== 200) throw new Error(`CONNECT returned ${statusCode}`);
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    agent.createConnection = () => tls.connect({ socket, servername: host, ca: ca.certPem });
    agents.add(agent);
    return agent;
  }

  interface Reply {
    statusCode: number | undefined;
    body: string;
    complete: boolean;
    reusedSocket: boolean;
  }

  function request(
    agent: https.Agent,
    id: RequestId,
    options: { body?: string; onChunk?: () => void } = {},
  ): Promise<Reply> {
    const body = options.body ?? requestBody(id);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: host,
          agent,
          method: 'POST',
          path: `/v1/messages?id=${id}`,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            authorization: `Bearer ${fakeKey}`,
          },
        },
        (res) => {
          let received = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            received += chunk;
            options.onChunk?.();
          });
          // A reset still reports the bytes already delivered and complete=false.
          res.on('error', () => {});
          res.once('close', () =>
            resolve({
              statusCode: res.statusCode,
              body: received,
              complete: res.complete,
              reusedSocket: req.reusedSocket,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  it.each(traces)(
    'keeps A attribution through $outcome with B ending first=$endBFirst',
    async ({ outcome, endBFirst }) => {
      proxy.setTokenSessionId(telemetrySessionId);
      selectSession(sessionA);
      const shared = await openTunnel();
      expect(await request(shared, 'a-first')).toMatchObject({ statusCode: 200, body: responseBody('a-first') });

      const partialDelivered = gate();
      const a = request(await openTunnel(), 'a-pending', { onChunk: partialDelivered.release });
      await expect.poll(() => pending !== undefined).toBe(true);
      if (!pending) throw new Error('Missing pending response');
      const res = pending;
      if (outcome === 'OAuth retry') {
        sendJson(res, 401, retryBody);
        await refreshStarted.ready;
      } else if (outcome === 'truncated SSE') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': Buffer.byteLength(partialSse) });
        res.flushHeaders();
      } else if (outcome === 'aborted JSON') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(partialJson) + 100,
        });
        res.write(partialJson);
        await partialDelivered.ready;
      }

      selectSession(sessionB);
      proxy.setTokenSessionId(sessionA.sessionId);
      expect(await request(shared, 'b')).toMatchObject({
        statusCode: 200,
        body: responseBody('b'),
        reusedSocket: true,
      });
      if (endBFirst) {
        selectSession();
        await writer.endSession(sessionB.sessionId);
      }

      switch (outcome) {
        case 'finish':
          sendJson(res, 200, responseBody('a-pending'));
          break;
        case 'truncated SSE':
          res.end(partialSse);
          break;
        case 'aborted JSON':
          expect(res.socket).not.toBeNull();
          res.socket?.destroy();
          break;
        case 'OAuth retry':
          refreshMayFinish.release();
          break;
      }
      const expectedReply = {
        finish: responseBody('a-pending'),
        'truncated SSE': partialSse,
        'aborted JSON': partialJson,
        'OAuth retry': responseBody('a-pending'),
      }[outcome];
      expect(await a).toMatchObject({
        statusCode: 200,
        body: expectedReply,
        complete: outcome !== 'aborted JSON',
      });

      selectSession();
      expect(await request(shared, 'disabled')).toMatchObject({
        statusCode: 200,
        body: responseBody('disabled'),
        reusedSocket: true,
      });
      await writer.endSession(sessionA.sessionId);
      if (!endBFirst) await writer.endSession(sessionB.sessionId);

      const isRetry = outcome === 'OAuth retry';
      const isTruncated = outcome === 'truncated SSE' || outcome === 'aborted JSON';
      const ids: RequestId[] = ['a-first', 'a-pending', 'b', ...(isRetry ? (['a-pending'] as const) : []), 'disabled'];
      expect(attempts).toEqual(
        ids.map((id, index) => ({
          id,
          body: requestBody(id),
          auth: `Bearer ${isRetry && index === 3 ? refreshedKey : realKey}`,
        })),
      );

      const aIds = isTruncated ? (['a-first'] as const) : (['a-first', 'a-pending'] as const);
      const aRecords = readJsonl<ExchangeRecord>(join(capturesDir, `${sessionA.sessionId}.jsonl`));
      const bRecords = readJsonl<ExchangeRecord>(join(capturesDir, `${sessionB.sessionId}.jsonl`));
      expect(aRecords.map(({ response }) => response.bodyUtf8)).not.toContain(partialJson);
      const assertRecords = (records: ExchangeRecord[], session: typeof sessionA, expected: readonly RequestId[]) => {
        expect(records).toHaveLength(expected.length);
        for (const [index, id] of expected.entries()) {
          expect(records[index]).toMatchObject({
            sessionId: session.sessionId,
            persona: session.persona,
            request: { bodyUtf8: requestBody(id) },
            response: { status: 200, bodyUtf8: responseBody(id) },
            capture: { reassemblyOk: true },
          });
          expect(records[index].capture.retried).toBe(isRetry && id === 'a-pending' ? true : undefined);
        }
      };
      assertRecords(aRecords, sessionA, aIds);
      assertRecords(bRecords, sessionB, ['b']);
      const serialized = JSON.stringify([...aRecords, ...bRecords]);
      for (const secret of [realKey, refreshedKey, replyCookie, 'internal refresh challenge']) {
        expect(serialized).not.toContain(secret);
      }

      const manifest = readJsonl<ManifestEntry>(join(capturesDir, 'manifest.jsonl'));
      expect(manifest).toHaveLength(4);
      for (const [session, exchanges, abortedExchanges] of [
        [sessionA, aIds.length, isTruncated ? 1 : 0],
        [sessionB, 1, 0],
      ] as const) {
        expect(manifest.filter((entry) => entry.sessionId === session.sessionId)).toMatchObject([
          { ...session, event: 'session-start' },
          { ...session, event: 'session-end', exchanges, abortedExchanges, poisoned: false },
        ]);
      }
      expect(writer.stats()).toMatchObject({ dropped: 0, openSessions: 0, queued: 0 });
    },
  );

  it('rewrites both OAuth attempts and captures the original request with the reassembled reply', async () => {
    const inspect = { name: 'Inspect', input_schema: { type: 'object' } };
    const schedule = { name: 'CronCreate', input_schema: { type: 'object' } };
    const keptReference = { type: 'tool_reference', tool_name: inspect.name };
    const removedReference = { type: 'tool_reference', tool_name: schedule.name };
    const toolSearch = (...content: (typeof keptReference)[]) => ({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'search-1', content }],
    });
    const original = {
      model: 'fixture',
      stream: true,
      tools: [inspect, schedule, { type: 'web_search_20250305', name: 'web_search' }],
      messages: [toolSearch(removedReference, keptReference)],
    };
    const originalBytes = JSON.stringify(original, null, 2);
    const filtered = { ...original, tools: [inspect], messages: [toolSearch(keptReference)] };
    const model = modelAnthropicResponse(1, true);
    const sse = encodeModelSse(model.events, '\r\n');
    const splitAt = sse.indexOf(Buffer.from('🚀')) + 1;
    const firstChunkDelivered = gate();
    let retry: http.ServerResponse | undefined;
    replyToRetry = (res) => {
      retry = res;
    };
    selectSession(sessionA);

    const reply = request(await openTunnel(), 'a-pending', {
      body: originalBytes,
      onChunk: firstChunkDelivered.release,
    });
    await expect.poll(() => pending !== undefined).toBe(true);
    if (!pending) throw new Error('Missing upstream OAuth attempt');
    sendJson(pending, 401, retryBody);
    await refreshStarted.ready;
    refreshMayFinish.release();

    await expect.poll(() => retry !== undefined).toBe(true);
    if (!retry) throw new Error('Missing upstream retry');
    retry.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': sse.length });
    retry.write(sse.subarray(0, splitAt));
    await firstChunkDelivered.ready;
    retry.end(sse.subarray(splitAt));
    expect(await reply).toMatchObject({ statusCode: 200, body: sse.toString('utf8'), complete: true });
    await writer.endSession(sessionA.sessionId);

    expect(attempts).toEqual(
      [realKey, refreshedKey].map((key) => ({
        id: 'a-pending',
        body: JSON.stringify(filtered),
        auth: `Bearer ${key}`,
      })),
    );
    const records = readJsonl<ExchangeRecord>(join(capturesDir, `${sessionA.sessionId}.jsonl`));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sessionId: sessionA.sessionId,
      persona: sessionA.persona,
      request: { bodyUtf8: originalBytes },
      response: { status: 200, bodyUtf8: model.bodyUtf8, stopReason: model.stopReason, streaming: true },
      capture: { reassemblyOk: true, retried: true },
    });
    expect(records[0].response.streamRaw?.events.map(({ eventType, dataUtf8 }) => ({ eventType, dataUtf8 }))).toEqual(
      model.events,
    );
  });
});
