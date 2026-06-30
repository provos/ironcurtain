/**
 * Attaches an `'error'` listener to a stdio stream (default `process.stdout`)
 * that swallows benign pipe-closed errors (`EPIPE` / `ECONNRESET`).
 *
 * Stdio MCP servers (the SDK's `StdioServerTransport`) write responses to the
 * process's stdout. When the peer closes the pipe during shutdown while a write
 * is in flight, Node emits an `'error'` (`EPIPE`) on the stream — and a stream
 * `'error'` with no listener is an *unhandled* error that crashes the whole
 * process. Under vitest's worker pool this surfaces as an opaque "worker exited
 * unexpectedly" with no error text. Swallowing only the benign shutdown codes
 * keeps any real stdout error visible.
 *
 * Idempotent per stream: re-invocations are no-ops, so it is safe to call from
 * multiple module entry points that share a process.
 */
const guarded = new WeakSet<NodeJS.WritableStream>();

export function guardStdioStreamErrors(stream: NodeJS.WriteStream = process.stdout): void {
  if (guarded.has(stream)) return;
  guarded.add(stream);
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return;
    process.stderr.write(`[stdio-guard] unexpected stdout error: ${err.message}\n`);
  });
}
