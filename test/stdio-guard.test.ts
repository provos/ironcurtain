import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { guardStdioStreamErrors } from '../src/utils/stdio-guard.js';

/**
 * `guardStdioStreamErrors` prevents an unhandled stream `'error'` (a benign
 * pipe-closed EPIPE/ECONNRESET during shutdown) from crashing the process —
 * the root cause of an intermittent vitest worker-exit flake on stdio MCP
 * servers. Unrelated errors must still surface (to stderr), never silently.
 */
describe('guardStdioStreamErrors', () => {
  function fakeStream(): NodeJS.WriteStream {
    return new EventEmitter() as unknown as NodeJS.WriteStream;
  }

  it('swallows EPIPE without throwing or writing to stderr', () => {
    const stream = fakeStream();
    guardStdioStreamErrors(stream);
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(() => stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('swallows ECONNRESET the same way', () => {
    const stream = fakeStream();
    guardStdioStreamErrors(stream);
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(() => stream.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('surfaces an unexpected stdout error to stderr instead of crashing', () => {
    const stream = fakeStream();
    guardStdioStreamErrors(stream);
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(() => stream.emit('error', Object.assign(new Error('boom'), { code: 'ENOSPC' }))).not.toThrow();
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).toContain('boom');
    spy.mockRestore();
  });

  it('is idempotent per stream (one listener even if called repeatedly)', () => {
    const stream = fakeStream();
    guardStdioStreamErrors(stream);
    guardStdioStreamErrors(stream);
    guardStdioStreamErrors(stream);
    expect((stream as unknown as EventEmitter).listenerCount('error')).toBe(1);
  });
});
