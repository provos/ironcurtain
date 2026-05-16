/**
 * Single-line progress renderer for `docker pull` / `docker build` streams.
 *
 * `spawnWithIdleTimeout` (PR #250) restored real-time visibility into image
 * pulls/builds by piping the child's stdout/stderr verbatim to the parent's
 * terminal — fixing silent hangs but flooding the user with thousands of
 * lines of BuildKit / per-layer chatter. This sink replaces that verbatim
 * dump in the interactive (TTY) case with a single status line that
 * updates in place, while still feeding every chunk to the watchdog (the
 * heartbeat detection in `spawnWithIdleTimeout` runs before the chunk
 * reaches the sink — see `forward()` in that file).
 *
 * On non-TTY stderr (CI, redirected logs) the sink passes chunks through
 * verbatim, matching the pre-existing behavior and keeping CI logs useful.
 *
 * On failure, `dumpRecent()` flushes the last ~200 raw lines so the user
 * gets a real diagnostic — the 4 KB stderr-tail quoted in the rejection
 * message from `spawnWithIdleTimeout` is often too short to capture an
 * earlier RUN step that actually went wrong.
 */

import { Writable } from 'node:stream';
import chalk from 'chalk';

export type DockerProgressOperation = 'docker pull' | 'docker build';

export interface DockerProgressSink {
  /** Writable that the child's stdout pipes into. */
  stdout: NodeJS.WritableStream;
  /** Writable that the child's stderr pipes into. */
  stderr: NodeJS.WritableStream;
  /** Commit the in-place line (TTY) or emit a final summary (non-TTY). */
  finish(success: boolean): void;
  /** Flush the rolling raw-line buffer; intended for the failure path. */
  dumpRecent(): void;
}

export interface CreateDockerProgressSinkOptions {
  operation: DockerProgressOperation;
  /** Underlying writable. Defaults to `process.stderr`. */
  output?: NodeJS.WritableStream;
  /** Override TTY detection (used by tests). */
  isTTY?: boolean;
  /** Max raw lines retained for failure dump. Defaults to 200. */
  bufferSize?: number;
  /** Override clock for elapsed timers (used by tests). */
  now?: () => number;
}

const DEFAULT_BUFFER_LINES = 200;
const PENDING_BUFFER_HARD_CAP = 8 * 1024;

export function createDockerProgressSink(opts: CreateDockerProgressSinkOptions): DockerProgressSink {
  const output: NodeJS.WritableStream = opts.output ?? process.stderr;
  // `process.stderr` is typed as `WriteStream` (with `isTTY: true | undefined`);
  // a generic `WritableStream` may not have the property at all. Cast to a
  // shape that admits either so ESLint does not flag the comparison.
  const isTTY = opts.isTTY ?? (output as { isTTY?: unknown }).isTTY === true;
  const bufferSize = opts.bufferSize ?? DEFAULT_BUFFER_LINES;
  const now = opts.now ?? Date.now;

  // Non-TTY fast path: behave like the pre-sink `process.stderr` so CI logs
  // keep their full transcript and dumpRecent / finish are no-ops.
  if (!isTTY) {
    const passthroughBuffer: string[] = [];
    const recordPassthroughLines = (text: string): void => {
      for (const line of text.split('\n')) {
        const trimmed = line.replace(/\r$/g, '').trimEnd();
        if (!trimmed) continue;
        passthroughBuffer.push(trimmed);
        if (passthroughBuffer.length > bufferSize) passthroughBuffer.shift();
      }
    };
    const makeStream = (): NodeJS.WritableStream =>
      new Writable({
        write(chunk: Buffer | string, _encoding, cb) {
          const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
          recordPassthroughLines(text);
          output.write(text);
          cb();
        },
      });
    return {
      stdout: makeStream(),
      stderr: makeStream(),
      finish: () => {},
      dumpRecent: () => {
        /* raw lines are already on screen */
      },
    };
  }

  const parser = opts.operation === 'docker pull' ? createPullParser(now) : createBuildParser(now);
  const ringBuffer: string[] = [];
  const startTime = now();

  let pendingStdout = '';
  let pendingStderr = '';
  // Empty string means no in-place line is currently on screen.
  let lastRendered = '';
  let finished = false;

  const record = (line: string): void => {
    if (!line) return;
    ringBuffer.push(line);
    if (ringBuffer.length > bufferSize) ringBuffer.shift();
  };

  const render = (): void => {
    if (finished) return;
    const summary = parser.summary();
    if (summary === lastRendered) return;
    lastRendered = summary;
    output.write(`\r\x1B[2K${summary}`);
  };

  const processChunk = (chunk: Buffer | string, isStderr: boolean): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    let pending = (isStderr ? pendingStderr : pendingStdout) + text;
    // Docker pull uses `\r` (not `\n`) to update its progress meter in place;
    // we treat both as line boundaries so each transient state is parsed.
    const splitter = /[^\r\n]*[\r\n]/g;
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = splitter.exec(pending)) !== null) {
      const segment = match[0];
      const line = segment.replace(/[\r\n]+$/, '').trimEnd();
      if (line) {
        record(line);
        try {
          parser.feed(line);
        } catch {
          // Parser bugs MUST NOT propagate — the streaming pipeline relies
          // on the sink consuming bytes without error so the watchdog stays
          // armed.
        }
      }
      lastIdx = splitter.lastIndex;
    }
    pending = pending.slice(lastIdx);
    // Guard against pathological no-newline output (e.g. a malicious image
    // streaming a giant binary blob to stderr). Keep only the trailing half
    // of the cap so we don't OOM on the pending buffer.
    if (pending.length > PENDING_BUFFER_HARD_CAP) {
      pending = pending.slice(-PENDING_BUFFER_HARD_CAP / 2);
    }
    if (isStderr) pendingStderr = pending;
    else pendingStdout = pending;
    render();
  };

  const makeWritable = (isStderr: boolean): NodeJS.WritableStream =>
    new Writable({
      write(chunk: Buffer | string, _encoding, cb) {
        try {
          processChunk(chunk, isStderr);
        } catch {
          // see comment above — never throw from the write path
        }
        cb();
      },
    });

  const flushPending = (): void => {
    for (const pending of [pendingStdout, pendingStderr]) {
      const trimmed = pending.replace(/[\r\n]+$/, '').trimEnd();
      if (!trimmed) continue;
      record(trimmed);
      try {
        parser.feed(trimmed);
      } catch {
        /* swallow */
      }
    }
    pendingStdout = '';
    pendingStderr = '';
  };

  return {
    stdout: makeWritable(false),
    stderr: makeWritable(true),
    finish(success) {
      if (finished) return;
      finished = true;
      flushPending();
      const elapsed = ((now() - startTime) / 1000).toFixed(1);
      const summary = parser.summary();
      const tag = success ? chalk.green(`${opts.operation} done`) : chalk.red(`${opts.operation} failed`);
      const line = `${tag}  ${chalk.dim(`(${elapsed}s)`)}  ${chalk.dim(summary)}`;
      if (lastRendered) {
        output.write(`\r\x1B[2K${line}\n`);
      } else {
        output.write(`${line}\n`);
      }
      lastRendered = '';
    },
    dumpRecent() {
      if (ringBuffer.length === 0) return;
      if (lastRendered) {
        // Make sure our dump starts on a fresh line.
        output.write('\r\x1B[2K');
        lastRendered = '';
      }
      output.write(chalk.dim(`--- last ${ringBuffer.length} lines from ${opts.operation} ---`) + '\n');
      for (const line of ringBuffer) {
        output.write(line + '\n');
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

interface ProgressParser {
  feed(line: string): void;
  summary(): string;
}

type PullPhase = 'pending' | 'downloading' | 'verifying' | 'downloaded' | 'extracting' | 'done' | 'exists';

function createPullParser(now: () => number): ProgressParser {
  const layers = new Map<string, PullPhase>();
  let statusLine = '';
  const startTime = now();

  return {
    feed(line) {
      const clean = stripAnsi(line).trim();
      // Layer-scoped messages: `<id>: <message>` where id is a short hex
      // digest or a tag name in the case of the first line.
      const layerMatch = clean.match(/^([0-9a-f]{8,}|[A-Za-z][\w.-]*):\s+(.+?)\s*$/);
      if (layerMatch) {
        const [, id, msg] = layerMatch;
        if (/^Pulling fs layer$/i.test(msg) || /^Waiting$/i.test(msg)) {
          if (!layers.has(id)) layers.set(id, 'pending');
        } else if (/^Downloading/i.test(msg)) {
          layers.set(id, 'downloading');
        } else if (/^Verifying Checksum/i.test(msg)) {
          layers.set(id, 'verifying');
        } else if (/^Download complete/i.test(msg)) {
          layers.set(id, 'downloaded');
        } else if (/^Extracting/i.test(msg)) {
          layers.set(id, 'extracting');
        } else if (/^Pull complete/i.test(msg)) {
          layers.set(id, 'done');
        } else if (/^Already exists/i.test(msg)) {
          layers.set(id, 'exists');
        } else if (/^Pulling from /i.test(msg)) {
          statusLine = clean;
        }
        return;
      }
      if (/^Status:|^Digest:/i.test(clean) || /Pulling from /i.test(clean)) {
        statusLine = clean;
      }
    },
    summary() {
      const total = layers.size;
      const phases = [...layers.values()];
      const done = phases.filter((p) => p === 'done' || p === 'exists').length;
      const downloading = phases.filter((p) => p === 'downloading').length;
      const extracting = phases.filter((p) => p === 'extracting').length;
      const elapsed = ((now() - startTime) / 1000).toFixed(0);

      const parts: string[] = [chalk.cyan('docker pull')];
      if (total === 0) {
        parts.push(chalk.dim(statusLine || 'starting...'));
      } else {
        parts.push(chalk.dim(`${done}/${total} layers`));
        if (downloading > 0) parts.push(chalk.yellow(`${downloading} downloading`));
        if (extracting > 0) parts.push(chalk.blue(`${extracting} extracting`));
      }
      parts.push(chalk.dim(`(${elapsed}s)`));
      return parts.join('  ');
    },
  };
}

function createBuildParser(now: () => number): ProgressParser {
  let currentStep: number | undefined;
  let totalSteps: number | undefined;
  let currentDesc: string | undefined;
  let lastBracket: string | undefined;
  const startTime = now();

  return {
    feed(line) {
      const clean = stripAnsi(line);
      // BuildKit `--progress=plain` format. Step headers look like:
      //   #5 [stage 2/8] RUN apt-get install -y curl
      //   #4 [internal] load build definition from Dockerfile
      //   #6 [build 3/5] COPY . /workspace
      // We pull the `N/M` out of the bracket when present so the summary
      // can show progress; otherwise we fall back to the bracket label.
      const stepHeader = clean.match(/^#\d+\s+\[([^\]]+)\]\s+(.+?)\s*$/);
      if (stepHeader) {
        const [, bracket, desc] = stepHeader;
        const numbered = bracket.match(/(\d+)\/(\d+)/);
        if (numbered) {
          currentStep = Number.parseInt(numbered[1], 10);
          totalSteps = Number.parseInt(numbered[2], 10);
        }
        lastBracket = bracket;
        currentDesc = truncate(desc, 80);
      }
      // Step continuation lines (`#5 0.234 ...output...`) and DONE markers
      // intentionally don't update the summary — they'd just flicker the
      // line. Their job is to advance the watchdog, which already happens
      // before the sink is reached.
    },
    summary() {
      const elapsed = ((now() - startTime) / 1000).toFixed(0);
      const parts: string[] = [chalk.cyan('docker build')];
      if (currentStep !== undefined && totalSteps !== undefined) {
        parts.push(chalk.dim(`step ${currentStep}/${totalSteps}`));
      } else if (lastBracket) {
        parts.push(chalk.dim(lastBracket));
      } else {
        parts.push(chalk.dim('starting...'));
      }
      if (currentDesc) parts.push(currentDesc);
      parts.push(chalk.dim(`(${elapsed}s)`));
      return parts.join('  ');
    },
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// CSI sequence: ESC [ <params> <intermediate> <final>. Strips colors and
// cursor-control codes BuildKit/docker may embed in line output.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}
