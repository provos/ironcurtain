import { describe, it, expect } from 'vitest';
import type { Transform } from 'node:stream';
import {
  GapDelayTransform,
  SlowDripTransform,
  createStreamDelayTransform,
  parseStreamDelayConfig,
} from '../../src/docker/stream-delay.js';

/**
 * Drive `chunks` through the transform and record each output chunk's
 * arrival time relative to the moment writing began.
 */
function runThroughDelay(transform: Transform, chunks: Buffer[]): Promise<{ data: Buffer; offsets: number[] }> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const offsets: number[] = [];
    const start = Date.now();
    transform.on('data', (c: Buffer) => {
      out.push(c);
      offsets.push(Date.now() - start);
    });
    transform.on('end', () => resolve({ data: Buffer.concat(out), offsets }));
    transform.on('error', reject);
    for (const c of chunks) transform.write(c);
    transform.end();
  });
}

const DELAY = 80; // ms — small enough to keep the suite fast, large enough to measure

describe('parseStreamDelayConfig', () => {
  it('returns null when the delay var is unset', () => {
    expect(parseStreamDelayConfig({})).toBeNull();
  });

  it('returns null for non-positive or non-numeric delays', () => {
    expect(parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: '0' })).toBeNull();
    expect(parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: '-5' })).toBeNull();
    expect(parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: 'abc' })).toBeNull();
  });

  it('defaults to mid-stream mode with no host filter and dripBytes=1', () => {
    expect(parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: '15000' })).toEqual({
      delayMs: 15000,
      mode: 'mid-stream',
      hostFilter: undefined,
      dripBytes: 1,
    });
  });

  it('parses first-token mode and a host filter', () => {
    expect(
      parseStreamDelayConfig({
        IRONCURTAIN_MITM_STREAM_DELAY_MS: '9000',
        IRONCURTAIN_MITM_STREAM_DELAY_MODE: 'first-token',
        IRONCURTAIN_MITM_STREAM_DELAY_HOST: 'anthropic',
      }),
    ).toEqual({ delayMs: 9000, mode: 'first-token', hostFilter: 'anthropic', dripBytes: 1 });
  });

  it('parses drip mode and an explicit bytes-per-tick', () => {
    expect(
      parseStreamDelayConfig({
        IRONCURTAIN_MITM_STREAM_DELAY_MS: '2000',
        IRONCURTAIN_MITM_STREAM_DELAY_MODE: 'drip',
        IRONCURTAIN_MITM_STREAM_DRIP_BYTES: '4',
      }),
    ).toEqual({ delayMs: 2000, mode: 'drip', hostFilter: undefined, dripBytes: 4 });
  });

  it('falls back to mid-stream for an unrecognized mode', () => {
    expect(
      parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: '100', IRONCURTAIN_MITM_STREAM_DELAY_MODE: 'wat' })
        ?.mode,
    ).toBe('mid-stream');
  });
});

describe('createStreamDelayTransform', () => {
  it('selects the transform class by mode', () => {
    expect(createStreamDelayTransform({ delayMs: 100, mode: 'drip', dripBytes: 1 })).toBeInstanceOf(SlowDripTransform);
    expect(createStreamDelayTransform({ delayMs: 100, mode: 'mid-stream', dripBytes: 1 })).toBeInstanceOf(
      GapDelayTransform,
    );
    expect(createStreamDelayTransform({ delayMs: 100, mode: 'first-token', dripBytes: 1 })).toBeInstanceOf(
      GapDelayTransform,
    );
  });
});

describe('GapDelayTransform', () => {
  const chunks = [Buffer.from('event: a\n\n'), Buffer.from('event: b\n\n'), Buffer.from('event: c\n\n')];
  const expected = Buffer.concat(chunks);

  it('mid-stream: preserves bytes and injects the gap before the second chunk', async () => {
    const { data, offsets } = await runThroughDelay(new GapDelayTransform(DELAY, 'mid-stream'), chunks);
    expect(data.equals(expected)).toBe(true);
    expect(offsets).toHaveLength(3);
    // First chunk forwarded promptly; the gap lands between chunk 0 and chunk 1.
    expect(offsets[0]).toBeLessThan(DELAY / 2);
    expect(offsets[1] - offsets[0]).toBeGreaterThanOrEqual(DELAY * 0.6);
    // Chunk 2 follows chunk 1 without an additional gap.
    expect(offsets[2] - offsets[1]).toBeLessThan(DELAY / 2);
  });

  it('first-token: preserves bytes and injects the gap before the first chunk', async () => {
    const { data, offsets } = await runThroughDelay(new GapDelayTransform(DELAY, 'first-token'), chunks);
    expect(data.equals(expected)).toBe(true);
    expect(offsets).toHaveLength(3);
    // Nothing reaches the client until the first-token gap elapses.
    expect(offsets[0]).toBeGreaterThanOrEqual(DELAY * 0.6);
    // The rest follow immediately after.
    expect(offsets[2] - offsets[0]).toBeLessThan(DELAY / 2);
  });

  it('mid-stream is a pass-through when only one chunk is emitted', async () => {
    const { data, offsets } = await runThroughDelay(new GapDelayTransform(DELAY, 'mid-stream'), [chunks[0]]);
    expect(data.equals(chunks[0])).toBe(true);
    expect(offsets[0]).toBeLessThan(DELAY / 2);
  });
});

describe('SlowDripTransform', () => {
  it('preserves bytes across input chunks and paces output over time', async () => {
    const input = Buffer.from('abcdefgh'); // 8 bytes
    const interval = 15;
    const { data, offsets } = await runThroughDelay(new SlowDripTransform(interval, 1), [
      input.subarray(0, 3),
      input.subarray(3),
    ]);
    expect(data.equals(input)).toBe(true);
    // 1 byte per tick ⇒ output is spread across multiple ticks, not delivered at once.
    expect(offsets.length).toBeGreaterThanOrEqual(4);
    const spread = offsets[offsets.length - 1] - offsets[0];
    expect(spread).toBeGreaterThanOrEqual(interval * 3);
  });

  it('honors bytes-per-tick', async () => {
    const input = Buffer.from('abcdefgh'); // 8 bytes, 4 per tick ⇒ 2 emissions
    const { data, offsets } = await runThroughDelay(new SlowDripTransform(15, 4), [input]);
    expect(data.equals(input)).toBe(true);
    expect(offsets.length).toBe(2);
  });
});
