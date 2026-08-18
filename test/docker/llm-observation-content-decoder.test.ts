import * as zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BoundedContentDecoder, type ContentDecoderFailure } from '../../src/docker/llm-observation/content-decoder.js';

async function decode(
  contentEncoding: string | undefined,
  wire: Buffer,
  limits?: ConstructorParameters<typeof BoundedContentDecoder>[0]['limits'],
): Promise<{ body: Buffer; failure?: ContentDecoderFailure; state: string }> {
  const chunks: Buffer[] = [];
  let failure: ContentDecoderFailure | undefined;
  let settle: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const decoder = new BoundedContentDecoder({
    contentEncoding,
    limits,
    onDecodedChunk: (chunk) => chunks.push(Buffer.from(chunk)),
    onEnd: () => settle?.(),
    onFailure: (value) => {
      failure = value;
      settle?.();
    },
  });
  const split = Math.floor(wire.length / 2);
  decoder.write(wire.subarray(0, split));
  decoder.write(wire.subarray(split));
  decoder.end();
  await settled;
  return { body: Buffer.concat(chunks), failure, state: decoder.snapshot().state };
}

describe('BoundedContentDecoder', () => {
  const body = Buffer.from('hello µ-world\n'.repeat(200), 'utf8');

  it.each([
    ['identity', (value: Buffer) => value],
    ['gzip', zlib.gzipSync],
    ['x-gzip', zlib.gzipSync],
    ['deflate', zlib.deflateSync],
    ['br', zlib.brotliCompressSync],
  ] as const)('decodes %s without changing decoded bytes', async (encoding, compress) => {
    const result = await decode(encoding, compress(body));
    expect(result.failure).toBeUndefined();
    expect(result.state).toBe('ended');
    expect(result.body.equals(body)).toBe(true);
  });

  it.each([
    ['gzip', zlib.gzipSync],
    ['deflate', zlib.deflateSync],
    ['br', zlib.brotliCompressSync],
  ] as const)('drains normal %s high-water signals instead of detaching', async (encoding, compress) => {
    const largeBody = randomBytes(256 * 1024);
    const wire = compress(largeBody);
    expect(wire.length).toBeGreaterThan(64 * 1024);

    const result = await decode(encoding, wire);

    expect(result.failure).toBeUndefined();
    expect(result.state).toBe('ended');
    expect(result.body.equals(largeBody)).toBe(true);
  });

  it('detaches when synchronous writes outrun the compressed-input backlog bound', async () => {
    const wire = zlib.gzipSync(randomBytes(512 * 1024));
    let failure: ContentDecoderFailure | undefined;
    const decoder = new BoundedContentDecoder({
      contentEncoding: 'gzip',
      limits: {
        maxCompressedBytes: wire.length + 1,
        maxPendingInputBytes: 64 * 1024,
      },
      onDecodedChunk: () => {},
      onFailure: (value) => {
        failure = value;
      },
    });

    for (let offset = 0; offset < wire.length; offset += 16 * 1024) {
      decoder.write(Buffer.from(wire.subarray(offset, offset + 16 * 1024)));
    }

    expect(failure?.reason).toBe('decoder-backlog-limit');
    expect(decoder.snapshot().state).toBe('detached');
  });

  it('detaches unsupported and stacked encodings without throwing', async () => {
    const unsupported = await decode('zstd', Buffer.from('opaque'));
    expect(unsupported.failure?.reason).toBe('unsupported-encoding');
    const stacked = await decode('gzip, identity', zlib.gzipSync(body));
    expect(stacked.failure?.reason).toBe('unsupported-encoding');
  });

  it('isolates corrupt compressed bodies', async () => {
    const result = await decode('gzip', Buffer.from('not gzip'));
    expect(result.failure?.reason).toBe('decoder-error');
    expect(result.state).toBe('detached');
  });

  it('enforces compressed, decoded, and expansion limits', async () => {
    const compressedLimit = await decode('identity', Buffer.alloc(20), { maxCompressedBytes: 10 });
    expect(compressedLimit.failure?.reason).toBe('compressed-byte-limit');

    const decodedLimit = await decode('gzip', zlib.gzipSync(body), { maxDecodedBytes: 10 });
    expect(decodedLimit.failure?.reason).toBe('decoded-byte-limit');

    const expansionLimit = await decode('gzip', zlib.gzipSync(Buffer.alloc(10_000, 65)), {
      maxExpansionRatio: 1,
      expansionRatioSlackBytes: 1,
    });
    expect(expansionLimit.failure?.reason).toBe('expansion-ratio-limit');
  });

  it('turns a decoded consumer exception into a detached observation', () => {
    let failure: ContentDecoderFailure | undefined;
    const decoder = new BoundedContentDecoder({
      onDecodedChunk: () => {
        throw new Error('observer exploded');
      },
      onFailure: (value) => {
        failure = value;
      },
    });
    expect(() => decoder.write(Buffer.from('safe forwarding bytes'))).not.toThrow();
    expect(failure?.reason).toBe('consumer-error');
    expect(decoder.snapshot().state).toBe('detached');
  });

  it('makes end and post-end writes idempotent while a compressed decoder drains', async () => {
    let ends = 0;
    let settle: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const decoder = new BoundedContentDecoder({
      contentEncoding: 'gzip',
      onDecodedChunk: () => {},
      onEnd: () => {
        ends++;
        settle?.();
      },
    });
    decoder.write(zlib.gzipSync(Buffer.from('complete')));
    decoder.end();
    decoder.end();
    decoder.write(Buffer.from('ignored'));
    await settled;
    expect(ends).toBe(1);
    expect(decoder.snapshot().state).toBe('ended');
  });
});
