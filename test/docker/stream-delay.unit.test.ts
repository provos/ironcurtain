import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Transform } from 'node:stream';
import {
  GapDelayTransform,
  SlowDripTransform,
  createStreamDelayTransform,
  parseStreamDelayConfig,
} from '../../src/docker/stream-delay.js';

describe('parseStreamDelayConfig', () => {
  it('returns null when the delay var is unset', () => {
    expect(parseStreamDelayConfig({})).toBeNull();
  });

  it('returns null for non-positive, non-integer, or partially-numeric delays', () => {
    expect(parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: '0' })).toBeNull();
    expect(parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: '-5' })).toBeNull();
    expect(parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: 'abc' })).toBeNull();
    expect(parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: '100ms' })).toBeNull();
    expect(parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: '100.5' })).toBeNull();
  });

  it('ignores a partially-numeric drip-bytes value (falls back to 1)', () => {
    expect(
      parseStreamDelayConfig({ IRONCURTAIN_MITM_STREAM_DELAY_MS: '2000', IRONCURTAIN_MITM_STREAM_DRIP_BYTES: '4x' })
        ?.dripBytes,
    ).toBe(1);
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

/**
 * Write all chunks + end, and collect output. Timers are faked, so callers step
 * time explicitly with `vi.advanceTimersByTimeAsync` and assertions stay
 * deterministic (no wall-clock flakiness).
 */
function drive(transform: Transform, chunks: Buffer[]): { out: Buffer[]; ended: Promise<void> } {
  const out: Buffer[] = [];
  transform.on('data', (c: Buffer) => out.push(Buffer.from(c)));
  const ended = new Promise<void>((resolve, reject) => {
    transform.on('end', () => resolve());
    transform.on('error', reject);
  });
  for (const c of chunks) transform.write(c);
  transform.end();
  return { out, ended };
}

const GAP = 1000;

describe('GapDelayTransform', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const chunks = [Buffer.from('event: a\n\n'), Buffer.from('event: b\n\n'), Buffer.from('event: c\n\n')];
  const expected = Buffer.concat(chunks);

  it('mid-stream: forwards the first chunk, then holds the rest for exactly the gap', async () => {
    const { out, ended } = drive(new GapDelayTransform(GAP, 'mid-stream'), chunks);
    await vi.advanceTimersByTimeAsync(0);
    expect(out).toHaveLength(1); // chunk 0 through; chunk 1 waiting on the gap
    expect(out[0].equals(chunks[0])).toBe(true);
    await vi.advanceTimersByTimeAsync(GAP - 1);
    expect(out).toHaveLength(1); // gap not yet elapsed
    await vi.advanceTimersByTimeAsync(1);
    await ended;
    expect(out).toHaveLength(3);
    expect(Buffer.concat(out).equals(expected)).toBe(true);
  });

  it('first-token: holds everything until the gap elapses', async () => {
    const { out, ended } = drive(new GapDelayTransform(GAP, 'first-token'), chunks);
    await vi.advanceTimersByTimeAsync(GAP - 1);
    expect(out).toHaveLength(0); // nothing before the first-token gap
    await vi.advanceTimersByTimeAsync(1);
    await ended;
    expect(Buffer.concat(out).equals(expected)).toBe(true);
  });

  it('mid-stream is a pass-through when only one chunk is emitted', async () => {
    const { out, ended } = drive(new GapDelayTransform(GAP, 'mid-stream'), [chunks[0]]);
    await vi.advanceTimersByTimeAsync(0);
    await ended;
    expect(out).toHaveLength(1);
    expect(out[0].equals(chunks[0])).toBe(true);
  });
});

describe('SlowDripTransform', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const TICK = 100;

  it('preserves bytes across input chunks and emits one byte per tick', async () => {
    const input = Buffer.from('abcdefgh'); // 8 bytes
    const { out, ended } = drive(new SlowDripTransform(TICK, 1), [input.subarray(0, 3), input.subarray(3)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(out).toHaveLength(0); // nothing until the first tick
    await vi.advanceTimersByTimeAsync(TICK);
    expect(Buffer.concat(out)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TICK * 7);
    await ended;
    expect(Buffer.concat(out).equals(input)).toBe(true);
    expect(out).toHaveLength(8); // 1 byte per tick
  });

  it('honors bytes-per-tick', async () => {
    const input = Buffer.from('abcdefgh'); // 8 bytes, 4 per tick ⇒ 2 emissions
    const { out, ended } = drive(new SlowDripTransform(TICK, 4), [input]);
    await vi.advanceTimersByTimeAsync(TICK * 2);
    await ended;
    expect(Buffer.concat(out).equals(input)).toBe(true);
    expect(out).toHaveLength(2);
  });

  it('finalizes promptly when the queue is already empty at flush', async () => {
    const { out, ended } = drive(new SlowDripTransform(60_000, 1), []); // 60s tick, no data
    await vi.advanceTimersByTimeAsync(0); // must not wait a full 60s tick to end
    await ended;
    expect(out).toHaveLength(0);
  });
});
