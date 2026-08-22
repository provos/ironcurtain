/**
 * Streaming `workflow watch` command.
 *
 * Message records always come from messages.jsonl. The daemon is consulted
 * only for authoritative liveness/terminal status when the target was given
 * as an ID, which keeps this command compatible with already-running daemons.
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, type Stats } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash, type Hash } from 'node:crypto';

import { createDaemonClient, type DaemonClient, type DaemonEvent } from '../daemon-client/daemon-client.js';
import { getWorkflowRunDir } from '../config/paths.js';
import { sha256Hex } from '../hash.js';
import { isPlainObject } from '../utils/is-plain-object.js';
import type { WorkflowDetailDto } from '../web-ui/web-ui-types.js';
import { parseArgsResult } from './cli-shared.js';
import { isTerminalWorkflowPhase, terminalPhaseFromStateName, type TerminalWorkflowPhase } from './terminal-phase.js';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_TERMINAL_FAILURE = 3;
const EXIT_SIGINT = 130;
const EXIT_SIGTERM = 143;

const DEFAULT_POLL_MS = 100;
const DEFAULT_RECONCILE_MS = 2_000;
const DEFAULT_RECONNECT_WINDOW_MS = 5_000;
const DEFAULT_RECONNECT_POLL_MS = 250;
const DEFAULT_QUIESCENCE_MS = 1_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RECORDS_PER_POLL = 256;
const DEFAULT_CHECKPOINT_RECHECK_MS = 1_000;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;

const EVENT_FILTERS = [
  'transition',
  'verdict',
  'retry',
  'error',
  'transient',
  'quota',
  'gate',
  'fanout',
  'sent',
] as const;
type EventFilter = (typeof EVENT_FILTERS)[number];

const DEFAULT_FILTERS = new Set<EventFilter>(EVENT_FILTERS.filter((filter) => filter !== 'sent'));

interface WatchRecord {
  readonly type: string;
  readonly ts?: string;
  readonly workflowId?: string;
  readonly state?: string;
  readonly [key: string]: unknown;
}

interface ParsedLine {
  readonly record: WatchRecord;
  readonly raw: string;
}

interface TailerOptions {
  readonly onLine: (line: ParsedLine) => void | Promise<void>;
  readonly onWarning: (message: string) => void;
}

/**
 * Byte-offset JSONL reader. Split records are kept as bounded chunks and only
 * decoded after a newline. On replacement, a constant-memory digest verifies
 * whether the bytes already consumed are an unchanged prefix of the new file.
 */
export class JsonlTailer {
  private offset = 0;
  private observedSize = 0;
  private identity: string | undefined;
  private present = false;
  private prefixHasher: Hash = createHash('sha256');
  private partialChunks: Buffer[] = [];
  private partialBytes = 0;
  private discardingOversizeRecord = false;

  constructor(
    private readonly path: string,
    private readonly options: TailerOptions,
    private readonly fixedEndOffset?: number,
  ) {}

  async poll(maxRecords = DEFAULT_MAX_RECORDS_PER_POLL): Promise<number> {
    const recordLimit = Math.max(1, maxRecords);
    const byteLimit = Math.max(READ_CHUNK_BYTES, recordLimit * READ_CHUNK_BYTES);
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.present = false;
        this.observedSize = this.offset;
        return 0;
      }
      throw err;
    }
    let delivered = 0;
    let processed = 0;
    let bytesRead = 0;
    try {
      const stats = fstatSync(fd);
      if (!stats.isFile()) throw new Error(`Message log is not a file: ${this.path}`);
      const visibleSize = Math.min(stats.size, this.fixedEndOffset ?? stats.size);
      const identity = `${String(stats.dev)}:${String(stats.ino)}`;
      const replaced =
        this.identity !== undefined && (!this.present || identity !== this.identity || visibleSize < this.offset);
      if (replaced && !this.hasUnchangedPrefix(fd, visibleSize)) this.reset();
      this.identity = identity;
      this.present = true;
      this.observedSize = visibleSize;

      while (this.offset < visibleSize && processed < recordLimit && bytesRead < byteLimit) {
        const wanted = Math.min(READ_CHUNK_BYTES, visibleSize - this.offset, byteLimit - bytesRead);
        const chunk = Buffer.allocUnsafe(wanted);
        const read = readSync(fd, chunk, 0, wanted, this.offset);
        if (read === 0) break;
        bytesRead += read;
        let start = 0;
        while (start < read && processed < recordLimit) {
          const newline = chunk.indexOf(0x0a, start);
          if (newline < 0 || newline >= read) {
            const remainder = chunk.subarray(start, read);
            this.consume(remainder);
            this.appendPartial(remainder);
            start = read;
            continue;
          }

          const linePart = chunk.subarray(start, newline);
          this.consume(chunk.subarray(start, newline + 1));
          this.appendPartial(linePart);
          start = newline + 1;
          processed += 1;
          if (await this.deliverCompleteRecord()) delivered += 1;
        }
      }
    } finally {
      closeSync(fd);
    }
    return delivered;
  }

  hasUnreadData(): boolean {
    return this.offset < this.observedSize;
  }

  /** Stable progress token used to detect a quiet producer without decoding partial data. */
  cursor(): string {
    return `${this.present ? (this.identity ?? 'unknown') : 'missing'}:${this.offset}:${this.partialBytes}`;
  }

  private consume(bytes: Buffer): void {
    this.prefixHasher.update(bytes);
    this.offset += bytes.length;
  }

  private appendPartial(bytes: Buffer): void {
    if (this.discardingOversizeRecord || bytes.length === 0) return;
    if (this.partialBytes + bytes.length > MAX_RECORD_BYTES) {
      this.partialChunks = [];
      this.partialBytes = 0;
      this.discardingOversizeRecord = true;
      this.options.onWarning(`Ignoring JSONL record larger than ${String(MAX_RECORD_BYTES)} bytes in ${this.path}`);
      return;
    }
    this.partialChunks.push(Buffer.from(bytes));
    this.partialBytes += bytes.length;
  }

  private async deliverCompleteRecord(): Promise<boolean> {
    if (this.discardingOversizeRecord) {
      this.discardingOversizeRecord = false;
      return false;
    }
    let lineBytes =
      this.partialChunks.length === 1 ? this.partialChunks[0] : Buffer.concat(this.partialChunks, this.partialBytes);
    this.partialChunks = [];
    this.partialBytes = 0;
    if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, -1);
    const raw = lineBytes.toString('utf8');
    if (raw.trim().length === 0) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.options.onWarning(`Ignoring malformed complete JSONL record in ${this.path}`);
      return false;
    }
    if (!isWatchRecord(parsed)) {
      this.options.onWarning(`Ignoring JSONL value that is not a workflow record in ${this.path}`);
      return false;
    }
    await this.options.onLine({ record: parsed, raw });
    return true;
  }

  private hasUnchangedPrefix(fd: number, size: number): boolean {
    if (size < this.offset) return false;
    const hasher = createHash('sha256');
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    while (position < this.offset) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, this.offset - position), position);
      if (read === 0) return false;
      hasher.update(buffer.subarray(0, read));
      position += read;
    }
    return hasher.digest('hex') === this.prefixHasher.copy().digest('hex');
  }

  private reset(): void {
    this.offset = 0;
    this.prefixHasher = createHash('sha256');
    this.partialChunks = [];
    this.partialBytes = 0;
    this.discardingOversizeRecord = false;
  }
}

function isWatchRecord(value: unknown): value is WatchRecord {
  return isPlainObject(value) && typeof value.type === 'string';
}

interface WatchTarget {
  readonly workflowId: string;
  readonly runDir: string;
  readonly useDaemon: boolean;
}

interface DiskEvidence {
  readonly phase: TerminalWorkflowPhase;
  readonly key: string;
  readonly source: 'terminal_marker' | 'checkpoint' | 'legacy_checkpoint' | 'legacy_transition';
}

class DiskRunInspector {
  private markerCapable = false;
  private markerTimestamp: string | undefined;
  private markerCheckpointMtimeMs: number | undefined;
  private markerCheckpointFingerprint: string | undefined;
  private terminalMarker: { phase: TerminalWorkflowPhase; ts: string } | undefined;
  private latestTerminalTransition: { state: string; ts: string } | undefined;
  private definition: Record<string, { type?: unknown }> | undefined;
  private definitionStamp: string | undefined;
  private checkpointWarningStamp: string | undefined;
  private checkpointStamp: string | undefined;
  private checkpointMtimeMs: number | undefined;
  private checkpointFingerprint: string | undefined;
  private checkpoint: { timestamp?: unknown; finalStatus?: unknown; machineState?: unknown } | undefined;
  private nextSameStampCheckpointRead = 0;

  constructor(
    private readonly runDir: string,
    private readonly warn: (message: string) => void,
    private readonly checkpointRecheckMs = DEFAULT_CHECKPOINT_RECHECK_MS,
  ) {}

  observe(record: WatchRecord): void {
    if (record.type === 'run_started') {
      this.beginMarkerCapableAttempt();
      return;
    }
    if (record.type === 'run_resumed') {
      this.beginMarkerCapableAttempt();
      this.markerTimestamp = typeof record.ts === 'string' ? record.ts : new Date().toISOString();
      this.markerCheckpointMtimeMs =
        typeof record.checkpointMtimeMs === 'number' ? record.checkpointMtimeMs : undefined;
      this.markerCheckpointFingerprint =
        typeof record.checkpointFingerprint === 'string' ? record.checkpointFingerprint : undefined;
      return;
    }
    if (record.type === 'run_terminal') {
      if (typeof record.phase === 'string' && isTerminalWorkflowPhase(record.phase)) {
        this.terminalMarker = {
          phase: record.phase,
          ts: typeof record.ts === 'string' ? record.ts : '',
        };
      }
      return;
    }
    if (record.type !== 'state_transition' || typeof record.event !== 'string') return;
    const states = this.readStates();
    if (states?.[record.event]?.type === 'terminal') {
      this.latestTerminalTransition = {
        state: record.event,
        ts: typeof record.ts === 'string' ? record.ts : '',
      };
    } else {
      // An old daemon cannot emit run_resumed, so a later non-terminal
      // transition is also an attempt boundary for legacy logs.
      this.markerTimestamp = typeof record.ts === 'string' ? record.ts : new Date().toISOString();
      this.markerCheckpointMtimeMs = undefined;
      this.markerCheckpointFingerprint = undefined;
      this.terminalMarker = undefined;
      this.latestTerminalTransition = undefined;
    }
  }

  evidence(): DiskEvidence | undefined {
    const terminalMarker = this.terminalMarker;
    if (terminalMarker) {
      return {
        phase: terminalMarker.phase,
        key: `terminal-marker:${terminalMarker.ts}:${terminalMarker.phase}`,
        source: 'terminal_marker',
      };
    }

    const checkpoint = this.readCheckpoint();
    if (checkpoint && this.isFresh(checkpoint.timestamp)) {
      const finalPhase = readFinalPhase(checkpoint.finalStatus);
      const checkpointTimestamp = typeof checkpoint.timestamp === 'string' ? checkpoint.timestamp : '';
      if (finalPhase) {
        return {
          phase: finalPhase,
          key: `checkpoint:${checkpointTimestamp}:${finalPhase}`,
          source: 'checkpoint',
        };
      }

      // A marker-capable producer promises an exact terminal phase after its
      // terminal checkpoint and operational log records. A fresh finalStatus
      // is itself authoritative, but do not race the marker with a generic
      // transition or an intermediate checkpoint.
      if (this.markerCapable && this.latestTerminalTransition) return undefined;

      const state = extractStateName(checkpoint.machineState);
      if (state && this.readStates()?.[state]?.type === 'terminal') {
        const phase = terminalPhaseFromStateName(state);
        return { phase, key: `legacy-checkpoint:${checkpointTimestamp}:${state}`, source: 'legacy_checkpoint' };
      }
    }

    if (this.markerCapable && this.latestTerminalTransition) return undefined;

    const transition = this.latestTerminalTransition;
    if (transition) {
      const phase = terminalPhaseFromStateName(transition.state);
      return { phase, key: `transition:${transition.ts}:${transition.state}`, source: 'legacy_transition' };
    }
    return undefined;
  }

  private beginMarkerCapableAttempt(): void {
    this.markerCapable = true;
    this.markerTimestamp = undefined;
    this.markerCheckpointMtimeMs = undefined;
    this.markerCheckpointFingerprint = undefined;
    this.terminalMarker = undefined;
    this.latestTerminalTransition = undefined;
  }

  private isFresh(timestamp: unknown): boolean {
    if (this.markerTimestamp === undefined) return true;
    if (this.markerCheckpointFingerprint !== undefined && this.checkpointFingerprint !== undefined) {
      return this.checkpointFingerprint !== this.markerCheckpointFingerprint;
    }
    if (this.markerCheckpointMtimeMs !== undefined && this.checkpointMtimeMs !== undefined) {
      return this.checkpointMtimeMs > this.markerCheckpointMtimeMs;
    }
    if (typeof timestamp !== 'string') return false;
    const checkpointTime = Date.parse(timestamp);
    const markerTime = Date.parse(this.markerTimestamp);
    return Number.isFinite(checkpointTime) && Number.isFinite(markerTime) && checkpointTime > markerTime;
  }

  private readStates(): Record<string, { type?: unknown }> | undefined {
    const path = resolve(this.runDir, 'definition.json');
    let stats: Stats;
    try {
      stats = statSync(path);
    } catch {
      return undefined;
    }
    const stamp = `${String(stats.dev)}:${String(stats.ino)}:${stats.mtimeMs}:${stats.size}`;
    if (this.definitionStamp === stamp) return this.definition;
    this.definitionStamp = stamp;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { states?: unknown };
      this.definition = isPlainObject(parsed.states)
        ? (parsed.states as Record<string, { type?: unknown }>)
        : undefined;
    } catch {
      this.definition = undefined;
      this.warn(`Unable to read workflow definition: ${path}`);
    }
    return this.definition;
  }

  private readCheckpoint(): { timestamp?: unknown; finalStatus?: unknown; machineState?: unknown } | undefined {
    const path = resolve(this.runDir, 'checkpoint.json');
    let stats: Stats;
    try {
      stats = statSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    this.checkpointMtimeMs = stats.mtimeMs;
    const stamp = `${String(stats.dev)}:${String(stats.ino)}:${stats.mtimeMs}:${stats.size}`;
    const sameStamp = this.checkpointStamp === stamp;
    const markerStillMatches =
      this.markerCheckpointFingerprint !== undefined && this.checkpointFingerprint === this.markerCheckpointFingerprint;
    if (sameStamp && (!markerStillMatches || Date.now() < this.nextSameStampCheckpointRead)) return this.checkpoint;
    this.checkpointStamp = stamp;
    try {
      const raw = readFileSync(path, 'utf8');
      this.checkpointFingerprint = sha256Hex(raw);
      this.nextSameStampCheckpointRead = Date.now() + this.checkpointRecheckMs;
      this.checkpoint = JSON.parse(raw) as {
        timestamp?: unknown;
        finalStatus?: unknown;
        machineState?: unknown;
      };
      return this.checkpoint;
    } catch {
      this.checkpoint = undefined;
      this.checkpointFingerprint = undefined;
      if (this.checkpointWarningStamp !== stamp) {
        this.checkpointWarningStamp = stamp;
        this.warn(`Unable to parse workflow checkpoint: ${path}`);
      }
      return undefined;
    }
  }
}

function readFinalPhase(value: unknown): TerminalWorkflowPhase | undefined {
  if (!isPlainObject(value) || typeof value.phase !== 'string') return undefined;
  return isTerminalWorkflowPhase(value.phase) ? value.phase : undefined;
}

function extractStateName(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isPlainObject(value)) return undefined;
  return Object.keys(value)[0];
}

export interface WorkflowWatchDependencies {
  readonly createClient?: () => DaemonClient;
  readonly pollIntervalMs?: number;
  readonly reconcileIntervalMs?: number;
  readonly reconnectWindowMs?: number;
  readonly reconnectPollMs?: number;
  /** Required quiet interval for a legacy producer with no terminal barrier. */
  readonly quiescenceMs?: number;
  /** Upper bound while draining a terminal producer. */
  readonly drainTimeoutMs?: number;
  /** Internal test/embedding override for bounded replay batches. */
  readonly maxRecordsPerPoll?: number;
  /** Internal fallback cadence for same-metadata checkpoint rewrites. */
  readonly checkpointRecheckMs?: number;
  readonly signal?: AbortSignal;
  readonly installProcessSignals?: boolean;
  readonly writeStdout?: (text: string) => void | Promise<void>;
  readonly writeStderr?: (text: string) => void;
}

/** Execute `workflow watch`; returns a process exit code without exiting. */
export async function runWorkflowWatch(args: string[], deps: WorkflowWatchDependencies = {}): Promise<number> {
  const parsed = parseArgsResult({
    args,
    options: {
      json: { type: 'boolean' },
      since: { type: 'string' },
      events: { type: 'string' },
      lines: { type: 'string' },
    },
    allowPositionals: true,
  });
  const stderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  const diagnostic = (message: string): void => stderr(`[workflow watch] ${sanitizeHumanText(message, '', 1_000)}\n`);

  if (!parsed.ok) {
    diagnostic(
      `${parsed.message}\nUsage: ironcurtain workflow watch <workflowId|runDir> [--json] [--since <ISO>] [--events <list>] [--lines <N>]`,
    );
    return EXIT_USAGE;
  }
  if (parsed.positionals.length !== 1) {
    diagnostic(
      'Usage: ironcurtain workflow watch <workflowId|runDir> [--json] [--since <ISO>] [--events <list>] [--lines <N>]',
    );
    return EXIT_USAGE;
  }

  const since = parseSince(parsed.values.since);
  if (since === null) {
    diagnostic('--since must be a valid ISO timestamp');
    return EXIT_USAGE;
  }
  const filters = parseFilters(parsed.values.events);
  if (!filters) {
    diagnostic(`--events must be a comma-separated list of: ${EVENT_FILTERS.join(',')},all`);
    return EXIT_USAGE;
  }
  const lineLimit = parseLineLimit(parsed.values.lines);
  if (lineLimit === null) {
    diagnostic('--lines must be a positive integer');
    return EXIT_USAGE;
  }

  const targetResult = resolveWatchTarget(parsed.positionals[0]);
  if ('error' in targetResult) {
    diagnostic(targetResult.error);
    return EXIT_USAGE;
  }
  const target = targetResult.target;
  const ownController = new AbortController();
  const stdout = deps.writeStdout
    ? async (text: string): Promise<void> => deps.writeStdout?.(text)
    : async (text: string): Promise<void> => writeProcessStdout(text, ownController.signal);
  const inspector = new DiskRunInspector(target.runDir, diagnostic, deps.checkpointRecheckMs);
  const json = parsed.values.json === true;
  const snapshotLines: string[] = [];
  let selectedSnapshotLines = 0;
  const rememberSnapshotLine = (line: string): void => {
    if (lineLimit === undefined) return;
    if (snapshotLines.length < lineLimit) snapshotLines.push(line);
    else snapshotLines[selectedSnapshotLines % lineLimit] = line;
    selectedSnapshotLines += 1;
  };
  const warnedForeignWorkflowIds = new Set<string>();
  const logPath = resolve(target.runDir, 'messages.jsonl');
  let snapshotEnd: number | undefined;
  try {
    snapshotEnd = lineLimit === undefined ? undefined : snapshotFileEnd(logPath);
  } catch (err) {
    diagnostic(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  }
  const tailer = new JsonlTailer(
    logPath,
    {
      onWarning: diagnostic,
      onLine: async ({ record, raw }) => {
        if (record.workflowId !== target.workflowId) {
          const foreignId = typeof record.workflowId === 'string' ? record.workflowId : '(missing)';
          if (!warnedForeignWorkflowIds.has(foreignId)) {
            warnedForeignWorkflowIds.add(foreignId);
            diagnostic(`Ignoring message record for workflow ${foreignId}; expected ${target.workflowId}`);
          }
          return;
        }
        if (lineLimit === undefined) inspector.observe(record);
        if (
          record.type === 'run_started' ||
          record.type === 'run_resumed' ||
          record.type === 'run_terminal' ||
          !recordPassesSince(record, since)
        )
          return;
        const filter = filterForRecord(record.type);
        if (!filter || !filters.has(filter)) return;
        const output = json ? `${raw}\n` : `${formatHumanRecord(record)}\n`;
        if (lineLimit !== undefined) rememberSnapshotLine(output);
        else await stdout(output);
      },
    },
    snapshotEnd,
  );

  let signalExitCode = EXIT_SIGINT;
  const onSigint = (): void => {
    signalExitCode = EXIT_SIGINT;
    ownController.abort();
  };
  const onSigterm = (): void => {
    signalExitCode = EXIT_SIGTERM;
    ownController.abort();
  };
  const installSignals = deps.installProcessSignals !== false;
  if (installSignals) {
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  }
  const externalAbort = (): void => ownController.abort();
  deps.signal?.addEventListener('abort', externalAbort, { once: true });

  try {
    if (lineLimit !== undefined) {
      do {
        await tailer.poll(deps.maxRecordsPerPoll);
        if (ownController.signal.aborted) return signalExitCode;
        if (tailer.hasUnreadData()) await delay(0, ownController.signal);
      } while (tailer.hasUnreadData());

      const start = selectedSnapshotLines > lineLimit ? selectedSnapshotLines % lineLimit : 0;
      const orderedLines =
        selectedSnapshotLines > lineLimit
          ? [...snapshotLines.slice(start), ...snapshotLines.slice(0, start)]
          : snapshotLines;
      for (const line of orderedLines) {
        await stdout(line);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the awaited writer can receive a signal
        if (ownController.signal.aborted) return signalExitCode;
      }
      return EXIT_OK;
    }

    await tailer.poll(deps.maxRecordsPerPoll);
    const initialEvidence = inspector.evidence();
    if (!target.useDaemon && !tailer.hasUnreadData() && initialEvidence) {
      const settled = await settleDiskEvidence(tailer, inspector, initialEvidence, ownController.signal, deps);
      if (ownController.signal.aborted) return signalExitCode;
      if (settled) return exitCodeForPhase(settled.phase);
    }
    return await watchLoop(target, tailer, inspector, diagnostic, ownController.signal, () => signalExitCode, deps);
  } catch (err) {
    diagnostic(err instanceof Error ? err.message : String(err));
    return EXIT_ERROR;
  } finally {
    deps.signal?.removeEventListener('abort', externalAbort);
    if (installSignals) {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
  }
}

async function watchLoop(
  target: WatchTarget,
  tailer: JsonlTailer,
  inspector: DiskRunInspector,
  diagnostic: (message: string) => void,
  signal: AbortSignal,
  getSignalExitCode: () => number,
  deps: WorkflowWatchDependencies,
): Promise<number> {
  const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
  const reconcileMs = deps.reconcileIntervalMs ?? DEFAULT_RECONCILE_MS;
  const reconnectWindowMs = deps.reconnectWindowMs ?? DEFAULT_RECONNECT_WINDOW_MS;
  const reconnectPollMs = deps.reconnectPollMs ?? DEFAULT_RECONNECT_POLL_MS;
  const createClient =
    deps.createClient ?? (() => createDaemonClient({ requestTimeoutMs: 2_500, connectTimeoutMs: 1_000 }));

  let client: DaemonClient | undefined;
  let unsubscribeEvent: (() => void) | undefined;
  let unsubscribeClose: (() => void) | undefined;
  let nextReconcile = 0;
  let immediateQuery = true;
  let lastEvidenceKey: string | undefined;
  let daemonNonterminal = false;
  let reconnectDeadline: number | undefined;
  let nextReconnect = 0;
  let authoritativePhase: TerminalWorkflowPhase | 'interrupted' | undefined;

  const detachClient = async (): Promise<void> => {
    unsubscribeEvent?.();
    unsubscribeClose?.();
    unsubscribeEvent = undefined;
    unsubscribeClose = undefined;
    const old = client;
    client = undefined;
    await old?.close().catch(() => {});
  };

  const connect = async (): Promise<boolean> => {
    let candidate: DaemonClient | undefined;
    try {
      candidate = createClient();
      await candidate.connect();
    } catch {
      await candidate?.close().catch(() => {});
      return false;
    }
    client = candidate;
    reconnectDeadline = undefined;
    // Subscribe before the initial get/requery to close the event/query race.
    unsubscribeEvent = candidate.onEvent((event) => {
      if (eventTargetsWorkflow(event, target.workflowId)) immediateQuery = true;
    });
    unsubscribeClose = candidate.onClose(() => {
      if (client !== candidate) return;
      client = undefined;
      unsubscribeEvent = undefined;
      unsubscribeClose = undefined;
      reconnectDeadline ??= Date.now() + reconnectWindowMs;
      nextReconnect = 0;
    });
    immediateQuery = true;
    return true;
  };

  if (target.useDaemon && !(await connect())) {
    diagnostic('daemon unavailable; watching disk for positive terminal evidence');
  }

  try {
    for (;;) {
      if (signal.aborted) return getSignalExitCode();
      await tailer.poll(deps.maxRecordsPerPoll);
      const evidence = inspector.evidence();
      if (evidence?.key !== lastEvidenceKey) {
        lastEvidenceKey = evidence?.key;
        if (evidence) immediateQuery = true;
      }

      const now = Date.now();
      if (!client && reconnectDeadline !== undefined && now >= nextReconnect && now < reconnectDeadline) {
        nextReconnect = now + reconnectPollMs;
        await connect();
      }

      if (client && (immediateQuery || now >= nextReconcile)) {
        immediateQuery = false;
        nextReconcile = now + reconcileMs;
        const queriedClient = client;
        try {
          const result = await queriedClient.call<WorkflowDetailDto>('workflows.get', {
            workflowId: target.workflowId,
          });
          if (result.ok) {
            const phase = result.payload.phase;
            if (phase === 'running' || phase === 'waiting_human') {
              daemonNonterminal = true;
            } else if (phase === 'interrupted' || isTerminalWorkflowPhase(phase)) {
              authoritativePhase = phase;
            }
          } else if (result.code === 'WORKFLOW_NOT_FOUND') {
            diagnostic('daemon does not know this workflow; continuing with disk evidence');
            await detachClient();
          } else {
            diagnostic(`daemon status query failed: ${result.code}: ${result.message}`);
          }
        } catch (err) {
          diagnostic(`daemon disconnected: ${err instanceof Error ? err.message : String(err)}; reconnecting`);
          reconnectDeadline ??= Date.now() + reconnectWindowMs;
          nextReconnect = 0;
          await detachClient();
        }
      }

      if (authoritativePhase) {
        await drainToQuiescence(tailer, inspector, signal, deps);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the awaited drain can receive a signal
        if (signal.aborted) return getSignalExitCode();
        return exitCodeForPhase(authoritativePhase);
      }

      if (!client && reconnectDeadline !== undefined && Date.now() >= reconnectDeadline) {
        const finalEvidence = inspector.evidence();
        const settled = finalEvidence
          ? await settleDiskEvidence(tailer, inspector, finalEvidence, signal, deps)
          : await drainToQuiescence(tailer, inspector, signal, deps);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the awaited drain can receive a signal
        if (signal.aborted) return getSignalExitCode();
        if (settled) return exitCodeForPhase(settled.phase);
        diagnostic('daemon connection was lost and no definitive terminal evidence was found');
        return EXIT_ERROR;
      }

      // A connected daemon saying running/waiting wins over stale disk. With
      // no daemon (including an initial best-effort miss), positive disk
      // evidence is sufficient and silence/non-terminal state never is.
      if (!client && reconnectDeadline === undefined && !tailer.hasUnreadData() && evidence) {
        const settled = await settleDiskEvidence(tailer, inspector, evidence, signal, deps);
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the awaited drain can receive a signal
        if (signal.aborted) return getSignalExitCode();
        if (settled) return exitCodeForPhase(settled.phase);
      }
      if (client && evidence && !daemonNonterminal) immediateQuery = true;

      await delay(tailer.hasUnreadData() ? 0 : pollMs, signal);
    }
  } finally {
    await detachClient();
  }
}

function resolveWatchTarget(value: string): { target: WatchTarget } | { error: string } {
  const candidate = resolve(value);
  if (existsSync(candidate)) {
    let isDirectory = false;
    try {
      isDirectory = statSync(candidate).isDirectory();
    } catch {
      // Report the stable usage diagnostic below.
    }
    if (!isDirectory) return { error: `Run path is not a directory: ${candidate}` };
    if (!looksLikeRunDirectory(candidate)) {
      return { error: `Path is not a workflow run directory (parent directories are not accepted): ${candidate}` };
    }
    return { target: { workflowId: basename(candidate), runDir: candidate, useDaemon: false } };
  }

  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    return { error: `Run directory does not exist: ${candidate}` };
  }
  let runDir: string;
  try {
    runDir = getWorkflowRunDir(value);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!existsSync(runDir) || !looksLikeRunDirectory(runDir)) {
    return { error: `Workflow run not found: ${value}` };
  }
  return { target: { workflowId: value, runDir, useDaemon: true } };
}

function looksLikeRunDirectory(path: string): boolean {
  return ['definition.json', 'checkpoint.json', 'messages.jsonl'].some((name) => existsSync(resolve(path, name)));
}

function snapshotFileEnd(path: string): number {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error(`Message log is not a file: ${path}`);
    return stats.size;
  } finally {
    closeSync(fd);
  }
}

function parseLineLimit(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseSince(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFilters(value: unknown): ReadonlySet<EventFilter> | undefined {
  if (value === undefined) return DEFAULT_FILTERS;
  if (typeof value !== 'string') return undefined;
  const tokens = value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return undefined;
  if (tokens.includes('all'))
    return tokens.every((token) => token === 'all' || EVENT_FILTERS.includes(token as EventFilter))
      ? new Set(EVENT_FILTERS)
      : undefined;
  const selected = new Set<EventFilter>();
  for (const token of tokens) {
    if (!EVENT_FILTERS.includes(token as EventFilter)) return undefined;
    selected.add(token as EventFilter);
  }
  return selected;
}

function recordPassesSince(record: WatchRecord, since: number | undefined): boolean {
  if (since === undefined) return true;
  if (typeof record.ts !== 'string') return false;
  const timestamp = Date.parse(record.ts);
  return Number.isFinite(timestamp) && timestamp >= since;
}

function filterForRecord(type: string): EventFilter | undefined {
  switch (type) {
    case 'state_transition':
      return 'transition';
    case 'agent_received':
      return 'verdict';
    case 'agent_retry':
      return 'retry';
    case 'error':
      return 'error';
    case 'transient_failure':
      return 'transient';
    case 'quota_exhausted':
      return 'quota';
    case 'gate_raised':
    case 'gate_resolved':
      return 'gate';
    case 'fanout_join':
      return 'fanout';
    case 'agent_sent':
      return 'sent';
    default:
      return undefined;
  }
}

function formatHumanRecord(record: WatchRecord): string {
  const ts = sanitizeHumanText(record.ts);
  const role = sanitizeHumanText(record.role);
  switch (record.type) {
    case 'state_transition':
      return `${ts} transition ${scalar(record.from)} -> ${scalar(record.event)}`;
    case 'agent_received':
      return `${ts} verdict/${role} ${scalar(record.verdict)} ${oneLine(record.message)}`.trimEnd();
    case 'agent_retry':
      return `${ts} retry/${role} ${scalar(record.reason)} ${oneLine(record.details)}`.trimEnd();
    case 'error':
      return `${ts} error ${oneLine(record.error)}`;
    case 'transient_failure':
      return `${ts} transient/${role} ${scalar(record.kind)} ${oneLine(record.rawMessage)}`.trimEnd();
    case 'quota_exhausted':
      return `${ts} quota/${role} reset=${scalar(record.resetAt, 'unknown')} ${oneLine(record.rawMessage)}`.trimEnd();
    case 'gate_raised':
      return `${ts} gate raised ${stringList(record.acceptedEvents)}`.trimEnd();
    case 'gate_resolved':
      return `${ts} gate resolved ${scalar(record.event)}`;
    case 'fanout_join':
      return `${ts} fanout ${scalar(record.fanOutState ?? record.state)} workers=${scalar(record.workers)}`;
    case 'agent_sent':
      return `${ts} sent/${role} ${oneLine(record.message)}`.trimEnd();
    default:
      return `${ts} ${record.type}`;
  }
}

function scalar(value: unknown, fallback = '-'): string {
  return sanitizeHumanText(value, fallback);
}

function oneLine(value: unknown): string {
  return sanitizeHumanText(value, '');
}

function stringList(value: unknown): string {
  return Array.isArray(value)
    ? value
        .map((item) => sanitizeHumanText(item, ''))
        .filter(Boolean)
        .join(',')
    : '';
}

// Strip complete CSI/OSC sequences first, then every remaining control or
// formatting code. Even an unrecognized escape form becomes inert when its
// ESC/C1 byte is removed. JSON mode intentionally bypasses this function.
// eslint-disable-next-line no-control-regex
const TERMINAL_ESCAPE_SEQUENCE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]/gu;
const TERMINAL_CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/gu;

function sanitizeHumanText(value: unknown, fallback = '-', maxLength = 160): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return fallback;
  const text = String(value)
    .replace(TERMINAL_ESCAPE_SEQUENCE, '')
    .replace(TERMINAL_CONTROL_CHARACTER, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length === 0) return fallback;
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function eventTargetsWorkflow(event: DaemonEvent, workflowId: string): boolean {
  return isPlainObject(event.payload) && event.payload.workflowId === workflowId;
}

function exitCodeForPhase(phase: TerminalWorkflowPhase | 'interrupted'): number {
  return phase === 'completed' ? EXIT_OK : EXIT_TERMINAL_FAILURE;
}

async function settleDiskEvidence(
  tailer: JsonlTailer,
  inspector: DiskRunInspector,
  evidence: DiskEvidence,
  signal: AbortSignal,
  deps: WorkflowWatchDependencies,
): Promise<DiskEvidence | undefined> {
  // Current producers write these only after all operational records and the
  // terminal checkpoint. Only transition-only legacy evidence needs settling.
  if (evidence.source !== 'legacy_transition' && !tailer.hasUnreadData()) return evidence;
  return drainToQuiescence(tailer, inspector, signal, deps, true);
}

async function drainToQuiescence(
  tailer: JsonlTailer,
  inspector: DiskRunInspector,
  signal: AbortSignal,
  deps: WorkflowWatchDependencies,
  requireEvidence = false,
): Promise<DiskEvidence | undefined> {
  const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_MS;
  const quiescenceMs = deps.quiescenceMs ?? DEFAULT_QUIESCENCE_MS;
  const deadline = Date.now() + (deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
  let quietSince = Date.now();
  let cursor = tailer.cursor();
  let evidence = inspector.evidence();
  let evidenceKey = evidence?.key;

  for (;;) {
    if (signal.aborted) return evidence;
    const hasUnreadData = tailer.hasUnreadData();
    if (!hasUnreadData) {
      if (evidence?.source === 'terminal_marker') return evidence;
      if (requireEvidence && evidence === undefined) return undefined;
      if (requireEvidence && evidence?.source !== 'legacy_transition') return evidence;
    }

    const now = Date.now();
    if (!hasUnreadData && (now - quietSince >= quiescenceMs || now >= deadline)) return evidence;
    await delay(hasUnreadData ? 0 : Math.min(pollMs, deadline - now), signal);
    await tailer.poll(deps.maxRecordsPerPoll);

    const nextCursor = tailer.cursor();
    const nextEvidence = inspector.evidence();
    const nextEvidenceKey = nextEvidence?.key;
    if (nextCursor !== cursor || nextEvidenceKey !== evidenceKey) {
      cursor = nextCursor;
      evidenceKey = nextEvidenceKey;
      quietSince = Date.now();
    }
    evidence = nextEvidence;
  }
}

function writeProcessStdout(text: string, signal: AbortSignal): Promise<void> {
  if (process.stdout.write(text)) return Promise.resolve();
  return new Promise((resolveWrite) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      process.stdout.removeListener('drain', finish);
      signal.removeEventListener('abort', finish);
      resolveWrite();
    };
    process.stdout.once('drain', finish);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveDelay();
    };
    const onAbort = (): void => finish();
    const timer = setTimeout(finish, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) finish();
  });
}
