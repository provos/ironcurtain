import { Writable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { createDockerProgressSink, type DockerProgressOperation } from '../src/docker/docker-progress-sink.js';

/** In-memory writable that records every chunk it receives. */
function captureStream(): { stream: NodeJS.WritableStream; chunks: string[]; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      cb();
    },
  });
  return { stream, chunks, text: () => chunks.join('') };
}

/** Strips ANSI escapes so assertions don't depend on chalk output. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

function makeSink(operation: DockerProgressOperation, opts: { isTTY: boolean; now?: () => number } = { isTTY: true }) {
  const out = captureStream();
  const sink = createDockerProgressSink({
    operation,
    output: out.stream,
    isTTY: opts.isTTY,
    now: opts.now ?? (() => 0),
  });
  return { sink, out };
}

describe('createDockerProgressSink', () => {
  describe('TTY mode', () => {
    it('renders an in-place line for docker pull layer transitions', () => {
      const { sink, out } = makeSink('docker pull', { isTTY: true });
      sink.stdout.write('latest: Pulling from library/alpine\n');
      sink.stdout.write('abc123def: Pulling fs layer\n');
      sink.stdout.write('beefcafe1: Pulling fs layer\n');
      sink.stdout.write('abc123def: Downloading [====>] 1MB/3MB\r');
      sink.stdout.write('abc123def: Pull complete\n');
      sink.stdout.write('beefcafe1: Already exists\n');

      const rendered = plain(out.text());
      // Every redraw is preceded by \r\x1B[2K — same-line update only.
      expect(out.text().split('\n').length).toBe(1);
      expect(rendered).toContain('docker pull');
      expect(rendered).toContain('2/2 layers');
    });

    it('renders step number from BuildKit --progress=plain output', () => {
      const { sink, out } = makeSink('docker build', { isTTY: true });
      sink.stderr.write('#1 [internal] load build definition from Dockerfile\n');
      sink.stderr.write('#1 DONE 0.0s\n');
      sink.stderr.write('#5 [2/8] RUN apt-get update && apt-get install -y curl\n');
      sink.stderr.write('#5 0.234 Reading package lists...\n');
      sink.stderr.write('#5 1.456 ...lots of noise...\n');
      sink.stderr.write('#5 DONE 12.3s\n');

      const rendered = plain(out.text());
      expect(rendered).toContain('docker build');
      expect(rendered).toContain('step 2/8');
      expect(rendered).toContain('RUN apt-get update');
      // Continuation lines should NOT have produced a separate visible
      // entry (they only feed the watchdog).
      expect(rendered).not.toContain('0.234');
      expect(rendered).not.toContain('1.456');
    });

    it('finish(true) commits a "done" summary line', () => {
      const { sink, out } = makeSink('docker pull', { isTTY: true });
      sink.stdout.write('abc123: Pulling fs layer\n');
      sink.stdout.write('abc123: Pull complete\n');
      sink.finish(true);

      const final = plain(out.text());
      expect(final).toContain('docker pull done');
      // After finish() the line ends with a newline so subsequent output
      // doesn't clobber it.
      expect(out.text().endsWith('\n')).toBe(true);
    });

    it('finish(false) marks the line failed', () => {
      const { sink, out } = makeSink('docker build', { isTTY: true });
      sink.stderr.write('#3 [1/4] FROM ubuntu:latest\n');
      sink.finish(false);

      expect(plain(out.text())).toContain('docker build failed');
    });

    it('dumpRecent emits the rolling raw buffer on failure', () => {
      const { sink, out } = makeSink('docker build', { isTTY: true });
      sink.stderr.write('#3 [1/4] FROM ubuntu:latest\n');
      sink.stderr.write('#3 0.123 fetching metadata\n');
      sink.stderr.write('#3 ERROR: failed to resolve source\n');
      sink.finish(false);
      sink.dumpRecent();

      const dumped = plain(out.text());
      expect(dumped).toContain('last');
      expect(dumped).toContain('lines from docker build');
      expect(dumped).toContain('ERROR: failed to resolve source');
    });

    it('caps the dump buffer at bufferSize', () => {
      const out = captureStream();
      const sink = createDockerProgressSink({
        operation: 'docker build',
        output: out.stream,
        isTTY: true,
        bufferSize: 3,
        now: () => 0,
      });
      for (let i = 0; i < 10; i++) {
        sink.stderr.write(`#1 raw line ${i}\n`);
      }
      sink.dumpRecent();

      const dumped = plain(out.text());
      expect(dumped).toContain('raw line 9');
      expect(dumped).toContain('raw line 8');
      expect(dumped).toContain('raw line 7');
      expect(dumped).not.toContain('raw line 6');
    });

    it('handles carriage-return-separated progress updates as line boundaries', () => {
      // docker pull uses `\r` (not `\n`) to update the downloading meter
      // in place. The sink has to split on it or the progress phase never
      // gets observed.
      const { sink, out } = makeSink('docker pull', { isTTY: true });
      sink.stdout.write('abc123: Pulling fs layer\n');
      sink.stdout.write('abc123: Downloading [=>      ] 1MB/100MB\r');
      sink.stdout.write('abc123: Downloading [==>     ] 2MB/100MB\r');
      sink.stdout.write('abc123: Downloading [===>    ] 3MB/100MB\r');

      expect(plain(out.text())).toContain('1 downloading');
    });
  });

  describe('non-TTY mode', () => {
    it('passes raw bytes straight through to the underlying stream', () => {
      const { sink, out } = makeSink('docker build', { isTTY: false });
      sink.stderr.write('#1 [internal] load Dockerfile\n');
      sink.stderr.write('#1 DONE 0.0s\n');

      // Non-TTY path must preserve full transcript so CI logs are useful.
      expect(out.text()).toBe('#1 [internal] load Dockerfile\n#1 DONE 0.0s\n');
    });

    it('finish() and dumpRecent() are no-ops on non-TTY', () => {
      const { sink, out } = makeSink('docker pull', { isTTY: false });
      sink.stdout.write('abc: Pulling fs layer\n');
      const beforeFinish = out.text();
      sink.finish(true);
      sink.dumpRecent();

      // Nothing extra was written after the raw lines.
      expect(out.text()).toBe(beforeFinish);
    });
  });

  describe('parser elapsed time', () => {
    it('uses the injected clock for the (Xs) suffix', () => {
      let t = 1000;
      const out = captureStream();
      const sink = createDockerProgressSink({
        operation: 'docker pull',
        output: out.stream,
        isTTY: true,
        now: () => t,
      });
      sink.stdout.write('abc: Pulling fs layer\n');
      t = 6000; // five seconds later
      // Trigger a re-render by pushing another line.
      sink.stdout.write('abc: Pull complete\n');

      expect(plain(out.text())).toContain('(5s)');
    });
  });
});
