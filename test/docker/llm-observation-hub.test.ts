import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  ResponseObservationHub,
  type ResponseObservationConsumer,
} from '../../src/docker/llm-observation/response-observation-hub.js';

async function waitForHub(hub: ResponseObservationHub): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (hub.snapshot().decoder.state !== 'active') return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('observation hub did not settle');
}

describe('ResponseObservationHub', () => {
  it('decodes and frames once for isolated consumers', async () => {
    const eventsA: string[] = [];
    const eventsB: string[] = [];
    const decoded: Buffer[] = [];
    let finish: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const wire = zlib.gzipSync(Buffer.from('event: x\ndata: one\n\nevent: y\ndata: two\n\n'));
    const hub = new ResponseObservationHub({
      contentEncoding: 'gzip',
      frameSse: true,
      consumers: [
        { id: 'a', onSseEvent: (event) => eventsA.push(`${event.eventType}:${event.dataUtf8}`) },
        { id: 'b', onSseEvent: (event) => eventsB.push(`${event.eventType}:${event.dataUtf8}`) },
        { id: 'json-side', onDecodedChunk: (chunk) => decoded.push(chunk), onEnd: () => finish?.() },
      ],
    });
    hub.write(wire);
    hub.end();
    await finished;
    expect(eventsA).toEqual(['x:one', 'y:two']);
    expect(eventsB).toEqual(eventsA);
    expect(Buffer.concat(decoded).toString()).toContain('data: one');
    expect(hub.snapshot().decoder.state).toBe('ended');
  });

  it('detaches a throwing consumer without affecting siblings', async () => {
    const healthy: string[] = [];
    const detached: string[] = [];
    const hub = new ResponseObservationHub({
      frameSse: true,
      consumers: [
        {
          id: 'faulty',
          onSseEvent: () => {
            throw new Error('boom');
          },
          onDetach: (failure) => detached.push(failure.reason),
        },
        { id: 'healthy', onSseEvent: (event) => healthy.push(event.dataUtf8) },
      ],
    });
    expect(() => hub.write(Buffer.from('data: first\n\ndata: second\n\n'))).not.toThrow();
    hub.end();
    await waitForHub(hub);
    expect(detached).toEqual(['consumer-callback-error']);
    expect(healthy).toEqual(['first', 'second']);
  });

  it('detaches promise-returning and over-budget consumers independently', async () => {
    const healthy: string[] = [];
    const promiseCallback = (() => Promise.resolve()) as unknown as NonNullable<
      ResponseObservationConsumer['onSseEvent']
    >;
    const hub = new ResponseObservationHub({
      frameSse: true,
      consumers: [
        { id: 'async', onSseEvent: promiseCallback },
        { id: 'one-event', maxSseEvents: 1, onSseEvent: () => {} },
        { id: 'healthy', onSseEvent: (event) => healthy.push(event.dataUtf8) },
      ],
    });
    hub.write(Buffer.from('data: first\n\ndata: second\n\n'));
    hub.end();
    await waitForHub(hub);
    const snapshot = hub.snapshot();
    expect(snapshot.consumers.find((entry) => entry.id === 'async')?.detached?.reason).toBe(
      'consumer-returned-promise',
    );
    expect(snapshot.consumers.find((entry) => entry.id === 'one-event')?.detached?.reason).toBe(
      'consumer-event-count-limit',
    );
    expect(healthy).toEqual(['first', 'second']);
  });

  it('contains framing overflow to SSE consumers while decoded consumers finish', async () => {
    let decoded = '';
    let decodedEnded = false;
    const hub = new ResponseObservationHub({
      frameSse: true,
      sseLimits: { maxLineBytes: 8 },
      consumers: [
        { id: 'sse', onSseEvent: () => {} },
        {
          id: 'decoded',
          onDecodedChunk: (chunk) => {
            decoded += chunk.toString();
          },
          onEnd: () => {
            decodedEnded = true;
          },
        },
      ],
    });
    hub.write(Buffer.from('data: this-is-too-long\n\n'));
    hub.end();
    await waitForHub(hub);
    expect(hub.snapshot().framingFailure?.reason).toBe('line-limit');
    expect(hub.snapshot().consumers.find((entry) => entry.id === 'sse')?.active).toBe(false);
    expect(decoded).toContain('this-is-too-long');
    expect(decodedEnded).toBe(true);
  });

  it('defensively copies decoded chunks between consumers', async () => {
    let seen = '';
    const hub = new ResponseObservationHub({
      frameSse: false,
      consumers: [
        { id: 'mutator', onDecodedChunk: (chunk) => chunk.fill(0) },
        { id: 'reader', onDecodedChunk: (chunk) => (seen += chunk.toString()) },
      ],
    });
    hub.write(Buffer.from('original'));
    hub.end();
    await waitForHub(hub);
    expect(seen).toBe('original');
  });

  it('never invokes consumers in the forwarding write stack', async () => {
    let callbackRan = false;
    const hub = new ResponseObservationHub({
      frameSse: false,
      consumers: [{ id: 'deferred', onDecodedChunk: () => (callbackRan = true) }],
    });
    hub.write(Buffer.from('bytes'));
    expect(callbackRan).toBe(false);
    hub.end();
    await waitForHub(hub);
    expect(callbackRan).toBe(true);
  });

  it('hard-detaches when its asynchronous input queue would grow beyond its cap', () => {
    const hub = new ResponseObservationHub({
      frameSse: false,
      maxQueuedCompressedBytes: 4,
      consumers: [{ id: 'consumer', onDecodedChunk: () => {} }],
    });
    expect(() => hub.write(Buffer.from('12345'))).not.toThrow();
    expect(hub.snapshot().consumers[0]?.detached?.reason).toBe('hub-input-queue-limit');
    expect(hub.snapshot().queuedCompressedBytes).toBe(0);
  });

  it('bounds queued tiny chunks independently of their byte size', () => {
    const hub = new ResponseObservationHub({
      frameSse: false,
      maxQueuedCompressedBytes: 1_000,
      maxQueuedChunks: 2,
      consumers: [{ id: 'consumer', onDecodedChunk: () => {} }],
    });
    hub.write(Buffer.from('1'));
    hub.write(Buffer.from('2'));
    hub.write(Buffer.from('3'));
    expect(hub.snapshot().consumers[0]?.detached?.reason).toBe('hub-input-queue-limit');
  });

  it('enforces decoded-byte limits for SSE-only consumers', async () => {
    const hub = new ResponseObservationHub({
      frameSse: true,
      consumers: [{ id: 'sse', maxDecodedBytes: 4, onSseEvent: () => {} }],
    });
    hub.write(Buffer.from('data: too-large\n\n'));
    hub.end();
    await waitForHub(hub);
    expect(hub.snapshot().consumers[0]?.detached?.reason).toBe('consumer-decoded-byte-limit');
    expect(hub.snapshot().queuedCompressedBytes).toBe(0);
  });

  it('reports an explicit abort without reclassifying it as a decoder fault', () => {
    const hub = new ResponseObservationHub({
      frameSse: false,
      consumers: [{ id: 'consumer', onDecodedChunk: () => {} }],
    });
    hub.abort('upstream aborted');
    expect(hub.snapshot().consumers[0]?.detached?.reason).toBe('hub-aborted');
  });
});
