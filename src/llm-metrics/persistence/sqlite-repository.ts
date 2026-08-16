import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Worker, type WorkerOptions } from 'node:worker_threads';

import type { LlmExchangeCompleted } from '../types.js';
import {
  LlmMetricsRepositoryUnavailableError,
  type LlmDeleteBeforeOptions,
  type LlmDeleteBeforeResult,
  type LlmDimensionCount,
  type LlmExchangeScanQuery,
  type LlmMetricsRepository,
  type LlmMetricsRepositoryHealth,
  type LlmMetricsReaderState,
  type LlmStatisticsDimension,
  type StoredLlmExchange,
} from './repository.js';
import type {
  SqliteDeleteChunkResult,
  SqliteDeleteLeaseResult,
  SqliteReaderWorkerData,
  SqliteReaderWorkerRequest,
  SqliteWriterWorkerData,
  SqliteWorkerRequest,
  SqliteWorkerResponse,
} from './sqlite-worker.js';

const DEFAULT_MAX_QUEUED_RECORDS = 2_000;
const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 256 * 1024;
const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 5_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_READ_TIMEOUT_MS = 10_000;
const DEFAULT_DELETE_CHUNK_SIZE = 250;
const DEFAULT_DELETE_MAX_ROWS = 10_000;
const DEFAULT_DELETE_MAX_DURATION_MS = 5_000;
const DEFAULT_MAINTENANCE_LEASE_MS = 30_000;
const MAX_DELETE_CHUNK_SIZE = 1_000;
const MAX_DELETE_ROWS = 100_000;
const MIN_DELETE_DURATION_MS = 10;
const MAX_DELETE_DURATION_MS = 30_000;
const MIN_MAINTENANCE_LEASE_MS = 100;
const MAX_MAINTENANCE_LEASE_MS = 60_000;
const MAINTENANCE_RELEASE_TIMEOUT_MS = 1_000;
const DELETE_LEASE_NAME = 'llm-exchanges-delete';
const MAX_ERROR_LENGTH = 500;
const MAX_PENDING_WORKER_REQUESTS = 64;

type WorkerFactory = (url: URL, options: WorkerOptions) => Worker;
type WorkerResult = Extract<SqliteWorkerResponse, { kind: 'result' }>['value'];
type WriterRequestWithoutId =
  Exclude<SqliteWorkerRequest, SqliteReaderWorkerRequest> extends infer Request
    ? Request extends { readonly id: number }
      ? Omit<Request, 'id'>
      : never
    : never;
type ReaderRequestWithoutId = SqliteReaderWorkerRequest extends infer Request
  ? Request extends { readonly id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

interface PendingRequest {
  readonly resolve: (value: WorkerResult) => void;
  readonly reject: (error: Error) => void;
}

interface QueuedExchange {
  readonly exchange: LlmExchangeCompleted;
  readonly bytes: number;
}

export interface SqliteLlmMetricsRepositoryOptions {
  readonly databasePath: string;
  readonly processRunId?: string;
  readonly maxQueuedRecords?: number;
  readonly maxQueuedBytes?: number;
  readonly maxRecordBytes?: number;
  readonly batchSize?: number;
  readonly flushIntervalMs?: number;
  readonly checkpointIntervalMs?: number;
  readonly startupTimeoutMs?: number;
  readonly flushTimeoutMs?: number;
  readonly readTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  /** Writer test seam; production callers should use the default worker implementation. */
  readonly workerFactory?: WorkerFactory;
  /** Reader test seam; production callers should use the default worker implementation. */
  readonly readWorkerFactory?: WorkerFactory;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`Invalid ${name}`);
  return result;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`Invalid ${name}`);
  return result;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown LLM metrics persistence error';
  return message.replace(/[\r\n\t]+/g, ' ').substring(0, MAX_ERROR_LENGTH);
}

function workerUrl(): URL {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`./sqlite-worker.${extension}`, import.meta.url);
}

function defaultWorkerFactory(url: URL, options: WorkerOptions): Worker {
  const tsOptions = url.pathname.endsWith('.ts') ? { execArgv: ['--import', 'tsx'] } : {};
  return new Worker(url, { ...options, ...tsOptions });
}

function estimateBytes(exchange: LlmExchangeCompleted): number {
  try {
    return Buffer.byteLength(JSON.stringify(exchange), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(message));
      },
    );
  });
}

class SqliteReadWorkerClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private startPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private nextRequestId = 1;
  private admittedRequests = 0;
  private ready = false;
  private closed = false;
  private state: LlmMetricsReaderState = 'idle';
  private lastError: string | null = null;

  constructor(
    private readonly databasePath: string,
    private readonly workerFactory: WorkerFactory,
    private readonly startupTimeoutMs: number,
    private readonly requestTimeoutMs: number,
  ) {}

  async request(request: ReaderRequestWithoutId): Promise<WorkerResult> {
    if (this.closed) throw new LlmMetricsRepositoryUnavailableError('LLM metrics reader is closed');
    if (this.admittedRequests >= MAX_PENDING_WORKER_REQUESTS) {
      throw new LlmMetricsRepositoryUnavailableError('LLM metrics reader request limit reached');
    }
    this.admittedRequests++;
    try {
      await this.ensureReady();
      const worker = this.worker;
      if (worker === null || !this.ready) {
        throw new LlmMetricsRepositoryUnavailableError('LLM metrics reader is unavailable');
      }

      const id = this.nextRequestId++;
      const result = new Promise<WorkerResult>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        try {
          worker.postMessage({ ...request, id } satisfies SqliteReaderWorkerRequest);
        } catch (error) {
          this.pending.delete(id);
          reject(error instanceof Error ? error : new Error('Failed to send LLM metrics reader request'));
        }
      });
      const timeoutMessage = 'LLM metrics reader request timed out';
      try {
        return await withTimeout(result, this.requestTimeoutMs, timeoutMessage);
      } catch (error) {
        if (error instanceof Error && error.message === timeoutMessage) {
          const failure = this.unavailable(error);
          this.fail(worker, failure);
          throw failure;
        }
        throw error;
      }
    } finally {
      this.admittedRequests--;
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.state = 'closed';
    const worker = this.worker;
    if (worker === null) return Promise.resolve();
    this.detach(worker, new LlmMetricsRepositoryUnavailableError('LLM metrics reader is closed'));
    return worker.terminate().then(() => undefined);
  }

  health(): { readonly state: LlmMetricsReaderState; readonly lastError: string | null } {
    return { state: this.state, lastError: this.lastError };
  }

  private ensureReady(): Promise<void> {
    if (this.ready && this.worker !== null) return Promise.resolve();
    this.startPromise ??= this.start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    if (this.closed) throw new LlmMetricsRepositoryUnavailableError('LLM metrics reader is closed');
    this.state = 'starting';
    const workerData: SqliteReaderWorkerData = { role: 'reader', databasePath: this.databasePath };
    let worker: Worker;
    try {
      worker = this.workerFactory(workerUrl(), { workerData });
    } catch (error) {
      const failure = this.unavailable(error);
      this.state = 'unavailable';
      this.lastError = sanitizeError(failure);
      throw failure;
    }
    this.worker = worker;
    const ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    worker.on('message', (message: unknown) => this.onMessage(worker, message));
    worker.on('error', (error) => this.fail(worker, error));
    worker.on('exit', (code) => {
      if (!this.closed) this.fail(worker, new Error(`LLM metrics reader exited with code ${code}`));
    });
    const timeoutMessage = 'LLM metrics reader startup timed out';
    try {
      await withTimeout(ready, this.startupTimeoutMs, timeoutMessage);
    } catch (error) {
      const failure = this.unavailable(error);
      this.fail(worker, failure);
      throw failure;
    }
  }

  private onMessage(worker: Worker, message: unknown): void {
    if (worker !== this.worker) return;
    if (typeof message !== 'object' || message === null || !('kind' in message)) {
      this.fail(worker, new Error('Invalid response from LLM metrics reader'));
      return;
    }
    const response = message as SqliteWorkerResponse;
    if (response.kind === 'ready') {
      if (!Number.isSafeInteger(response.schemaVersion) || response.schemaVersion < 1) {
        this.fail(worker, new Error('Invalid schema response from LLM metrics reader'));
        return;
      }
      this.ready = true;
      this.state = 'ready';
      this.lastError = null;
      this.resolveReady?.();
      this.resolveReady = null;
      this.rejectReady = null;
      return;
    }
    if (response.kind === 'error' && response.id === undefined) {
      this.fail(worker, new Error(response.message));
      return;
    }
    const id = response.id;
    if (id === undefined) {
      this.fail(worker, new Error('LLM metrics reader response is missing a request ID'));
      return;
    }
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    if (response.kind === 'error' && response.category !== 'invalid_request') {
      this.fail(worker, new Error(response.message));
      return;
    }
    this.pending.delete(id);
    if (response.kind === 'error') pending.reject(new Error(response.message));
    else pending.resolve(response.value);
  }

  private fail(worker: Worker, error: unknown): void {
    if (worker !== this.worker) return;
    this.detach(worker, error);
    void worker.terminate();
  }

  private detach(worker: Worker, error: unknown): void {
    if (worker !== this.worker) return;
    const failure = this.unavailable(error);
    this.worker = null;
    this.ready = false;
    if (!this.closed) {
      this.state = 'unavailable';
      this.lastError = sanitizeError(failure);
    }
    this.rejectReady?.(failure);
    this.resolveReady = null;
    this.rejectReady = null;
    for (const request of this.pending.values()) request.reject(failure);
    this.pending.clear();
  }

  private unavailable(error: unknown): LlmMetricsRepositoryUnavailableError {
    if (error instanceof LlmMetricsRepositoryUnavailableError) return error;
    return new LlmMetricsRepositoryUnavailableError(sanitizeError(error));
  }
}

/**
 * Main-thread half of the SQLite repository. All SQLite work runs in a worker;
 * enqueue is bounded, synchronous in-memory work and deliberately fail-open.
 */
export class SqliteLlmMetricsRepository implements LlmMetricsRepository {
  private readonly worker: Worker;
  private readonly reader: SqliteReadWorkerClient;
  private readonly queue: QueuedExchange[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  private readonly maxQueuedRecords: number;
  private readonly maxQueuedBytes: number;
  private readonly maxRecordBytes: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly checkpointIntervalMs: number;
  private readonly flushTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly readyPromise: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private checkpointTimer: NodeJS.Timeout | null = null;
  private activeFlush: Promise<void> | null = null;
  private activeClose: Promise<void> | null = null;
  private activeDelete: Promise<LlmDeleteBeforeResult> | null = null;
  private nextRequestId = 1;
  private state: LlmMetricsRepositoryHealth['state'] = 'starting';
  private schemaVersion: number | null = null;
  private observed = 0;
  private finalized = 0;
  private enqueued = 0;
  private persisted = 0;
  private duplicates = 0;
  private dropped = 0;
  private queuedBytes = 0;
  private inFlightRecords = 0;
  private inFlightBytes = 0;
  private lastError: string | null = null;
  private closing = false;

  private constructor(options: SqliteLlmMetricsRepositoryOptions) {
    if (options.databasePath.length === 0) throw new Error('databasePath is required');
    this.maxQueuedRecords = positiveInteger(options.maxQueuedRecords, DEFAULT_MAX_QUEUED_RECORDS, 'maxQueuedRecords');
    this.maxQueuedBytes = positiveInteger(options.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES, 'maxQueuedBytes');
    this.maxRecordBytes = positiveInteger(options.maxRecordBytes, DEFAULT_MAX_RECORD_BYTES, 'maxRecordBytes');
    this.batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE, 'batchSize');
    this.flushIntervalMs = positiveInteger(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS, 'flushIntervalMs');
    this.checkpointIntervalMs = positiveInteger(
      options.checkpointIntervalMs,
      DEFAULT_CHECKPOINT_INTERVAL_MS,
      'checkpointIntervalMs',
    );
    this.startupTimeoutMs = positiveInteger(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 'startupTimeoutMs');
    this.flushTimeoutMs = positiveInteger(options.flushTimeoutMs, DEFAULT_FLUSH_TIMEOUT_MS, 'flushTimeoutMs');
    this.readTimeoutMs = positiveInteger(options.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS, 'readTimeoutMs');
    this.closeTimeoutMs = positiveInteger(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, 'closeTimeoutMs');

    this.reader = new SqliteReadWorkerClient(
      options.databasePath,
      options.readWorkerFactory ?? defaultWorkerFactory,
      this.startupTimeoutMs,
      this.readTimeoutMs,
    );

    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    const workerData: SqliteWriterWorkerData = {
      role: 'writer',
      databasePath: options.databasePath,
      processRunId: options.processRunId ?? randomUUID(),
      startedAtMs: Date.now(),
    };
    this.worker = (options.workerFactory ?? defaultWorkerFactory)(workerUrl(), { workerData });
    this.worker.on('message', (message: unknown) => this.onMessage(message));
    this.worker.on('error', (error) => this.disable(error));
    this.worker.on('exit', (code) => {
      if (!this.closing && this.state !== 'disabled' && this.state !== 'closed') {
        this.disable(new Error(`LLM metrics worker exited with code ${code}`));
      }
    });
  }

  static async open(options: SqliteLlmMetricsRepositoryOptions): Promise<SqliteLlmMetricsRepository> {
    const repository = new SqliteLlmMetricsRepository(options);
    try {
      await withTimeout(repository.readyPromise, repository.startupTimeoutMs, 'LLM metrics worker startup timed out');
    } catch (error) {
      repository.disable(error);
    }
    return repository;
  }

  enqueue(exchange: LlmExchangeCompleted): boolean {
    this.observed++;
    this.finalized++;
    if (!this.acceptingWrites()) {
      this.dropped++;
      return false;
    }

    const bytes = estimateBytes(exchange);
    const totalRecords = this.queue.length + this.inFlightRecords;
    const totalBytes = this.queuedBytes + this.inFlightBytes;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > this.maxRecordBytes ||
      totalRecords >= this.maxQueuedRecords ||
      totalBytes + bytes > this.maxQueuedBytes
    ) {
      this.dropped++;
      return false;
    }

    this.queue.push({ exchange, bytes });
    this.queuedBytes += bytes;
    this.enqueued++;
    this.scheduleFlush();
    return true;
  }

  async flush(): Promise<void> {
    if (this.activeFlush !== null) return this.activeFlush;
    this.clearFlushTimer();
    this.activeFlush = withTimeout(this.drainQueue(), this.flushTimeoutMs, 'LLM metrics worker flush timed out')
      .catch((error: unknown) => this.disable(error))
      .finally(() => {
        this.activeFlush = null;
        if (this.queue.length > 0 && this.acceptingWrites()) this.scheduleFlush();
      });
    return this.activeFlush;
  }

  close(): Promise<void> {
    if (this.state === 'closed') return Promise.resolve();
    this.activeClose ??= this.performClose();
    return this.activeClose;
  }

  private async performClose(): Promise<void> {
    const startedAt = performance.now();
    this.closing = true;
    const readerClose = this.reader.close().catch(() => undefined);
    this.clearFlushTimer();
    if (this.checkpointTimer !== null) clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
    try {
      await withTimeout(
        (async () => {
          await this.flush();
          if (this.state !== 'ready' && this.state !== 'degraded') return;
          await this.request({
            kind: 'close',
            cleanEndedAtMs: Date.now(),
            observed: this.observed,
            finalized: this.finalized,
            enqueued: this.enqueued,
          });
        })(),
        this.closeTimeoutMs,
        'LLM metrics worker close timed out',
      );
    } catch (error) {
      this.disable(error);
    }
    const remainingCloseMs = Math.max(1, Math.floor(this.closeTimeoutMs - (performance.now() - startedAt)));
    await withTimeout(readerClose, remainingCloseMs, 'LLM metrics reader close timed out').catch(() => undefined);
    this.rejectPending(new LlmMetricsRepositoryUnavailableError('LLM metrics repository closed'));
    void this.worker.terminate();
    this.state = 'closed';
  }

  health(): LlmMetricsRepositoryHealth {
    const readerHealth = this.reader.health();
    return {
      state: this.state,
      schemaVersion: this.schemaVersion,
      observed: this.observed,
      finalized: this.finalized,
      enqueued: this.enqueued,
      persisted: this.persisted,
      duplicates: this.duplicates,
      dropped: this.dropped,
      queuedRecords: this.queue.length + this.inFlightRecords,
      queuedBytes: this.queuedBytes + this.inFlightBytes,
      lastError: this.lastError,
      readerState: readerHealth.state,
      readerLastError: readerHealth.lastError,
    };
  }

  async snapshotMaxSequence(): Promise<number> {
    this.assertReadable();
    const value = await this.reader.request({ kind: 'snapshotMaxSequence' });
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid snapshot response from LLM metrics worker');
    }
    return value;
  }

  async scan(query: LlmExchangeScanQuery): Promise<readonly StoredLlmExchange[]> {
    this.assertReadable();
    const value = await this.reader.request({ kind: 'scan', query });
    if (!Array.isArray(value)) throw new Error('Invalid scan response from LLM metrics worker');
    return value as readonly StoredLlmExchange[];
  }

  async dimensionValues(
    dimension: LlmStatisticsDimension,
    query: Omit<LlmExchangeScanQuery, 'cursor'>,
  ): Promise<readonly LlmDimensionCount[]> {
    this.assertReadable();
    const value = await this.reader.request({ kind: 'dimensionValues', dimension, query });
    if (!Array.isArray(value)) throw new Error('Invalid dimension response from LLM metrics worker');
    return value as readonly LlmDimensionCount[];
  }

  async deleteBefore(cutoffMs: number, options: LlmDeleteBeforeOptions = {}): Promise<LlmDeleteBeforeResult> {
    this.assertReadable();
    if (this.closing) throw new LlmMetricsRepositoryUnavailableError('LLM metrics repository is closing');
    if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) throw new Error('Invalid delete cutoff');
    const snapshotMaxSequence =
      options.snapshotMaxSequence === undefined
        ? undefined
        : boundedInteger(options.snapshotMaxSequence, 0, 0, Number.MAX_SAFE_INTEGER, 'delete snapshotMaxSequence');

    const chunkSize = boundedInteger(
      options.chunkSize,
      DEFAULT_DELETE_CHUNK_SIZE,
      1,
      MAX_DELETE_CHUNK_SIZE,
      'delete chunkSize',
    );
    const maxRows = boundedInteger(options.maxRows, DEFAULT_DELETE_MAX_ROWS, 1, MAX_DELETE_ROWS, 'delete maxRows');
    const maxDurationMs = boundedInteger(
      options.maxDurationMs,
      DEFAULT_DELETE_MAX_DURATION_MS,
      MIN_DELETE_DURATION_MS,
      MAX_DELETE_DURATION_MS,
      'delete maxDurationMs',
    );
    const leaseDurationMs = boundedInteger(
      options.leaseDurationMs,
      DEFAULT_MAINTENANCE_LEASE_MS,
      MIN_MAINTENANCE_LEASE_MS,
      MAX_MAINTENANCE_LEASE_MS,
      'delete leaseDurationMs',
    );
    if (leaseDurationMs < maxDurationMs) throw new Error('delete leaseDurationMs must cover maxDurationMs');

    if (this.activeDelete !== null) {
      return Promise.resolve({
        status: 'busy',
        cutoffMs,
        snapshotMaxSequence: null,
        deletedCount: 0,
        chunksProcessed: 0,
      });
    }

    const operation = this.performDeleteBefore(
      cutoffMs,
      snapshotMaxSequence,
      chunkSize,
      maxRows,
      maxDurationMs,
      leaseDurationMs,
    )
      .catch((error: unknown) => {
        this.markDegraded(error);
        throw error;
      })
      .finally(() => {
        this.activeDelete = null;
      });
    this.activeDelete = operation;
    return operation;
  }

  private async performDeleteBefore(
    cutoffMs: number,
    requestedSnapshotMaxSequence: number | undefined,
    chunkSize: number,
    maxRows: number,
    maxDurationMs: number,
    leaseDurationMs: number,
  ): Promise<LlmDeleteBeforeResult> {
    const startedAt = performance.now();
    let leaseAcquired = false;
    try {
      const leaseValue = await this.boundedMaintenanceRequest(
        {
          kind: 'beginDeleteBefore',
          leaseName: DELETE_LEASE_NAME,
          cutoffMs,
          snapshotMaxSequence: requestedSnapshotMaxSequence,
          leaseDurationMs,
        },
        maxDurationMs,
        'LLM metrics retention lease acquisition timed out',
      );
      if (!this.isDeleteLeaseResult(leaseValue)) {
        throw new Error('Invalid retention lease response from LLM metrics worker');
      }
      if (!leaseValue.acquired) {
        return {
          status: 'busy',
          cutoffMs,
          snapshotMaxSequence: null,
          deletedCount: 0,
          chunksProcessed: 0,
        };
      }
      leaseAcquired = true;
      const snapshotMaxSequence = leaseValue.snapshotMaxSequence;
      if (snapshotMaxSequence === null || snapshotMaxSequence === 0) {
        return {
          status: 'complete',
          cutoffMs,
          snapshotMaxSequence,
          deletedCount: 0,
          chunksProcessed: 0,
        };
      }

      let deletedCount = 0;
      let chunksProcessed = 0;
      while (deletedCount < maxRows) {
        const remainingDurationMs = Math.floor(maxDurationMs - (performance.now() - startedAt));
        if (remainingDurationMs < 1) {
          return {
            status: 'partial',
            cutoffMs,
            snapshotMaxSequence,
            deletedCount,
            chunksProcessed,
          };
        }

        const chunkValue = await this.boundedMaintenanceRequest(
          {
            kind: 'deleteBeforeChunk',
            leaseName: DELETE_LEASE_NAME,
            cutoffMs,
            snapshotMaxSequence,
            chunkSize: Math.min(chunkSize, maxRows - deletedCount),
            leaseDurationMs,
          },
          remainingDurationMs,
          'LLM metrics retention chunk timed out',
        );
        if (!this.isDeleteChunkResult(chunkValue)) {
          throw new Error('Invalid retention chunk response from LLM metrics worker');
        }
        deletedCount += chunkValue.deleted;
        chunksProcessed++;
        if (!chunkValue.hasMore) {
          return {
            status: 'complete',
            cutoffMs,
            snapshotMaxSequence,
            deletedCount,
            chunksProcessed,
          };
        }
        if (deletedCount >= maxRows) break;
        await yieldToEventLoop();
      }

      return {
        status: 'partial',
        cutoffMs,
        snapshotMaxSequence,
        deletedCount,
        chunksProcessed,
      };
    } finally {
      if (leaseAcquired && (this.state === 'ready' || this.state === 'degraded')) {
        try {
          await this.boundedMaintenanceRequest(
            { kind: 'releaseMaintenanceLease', leaseName: DELETE_LEASE_NAME },
            MAINTENANCE_RELEASE_TIMEOUT_MS,
            'LLM metrics retention lease release timed out',
          );
        } catch (error) {
          this.markDegraded(error);
        }
      }
    }
  }

  private async boundedMaintenanceRequest(
    request: WriterRequestWithoutId,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<WorkerResult> {
    try {
      return await withTimeout(this.request(request), timeoutMs, timeoutMessage);
    } catch (error) {
      if (error instanceof Error && error.message === timeoutMessage) this.disable(error);
      throw error;
    }
  }

  private isDeleteLeaseResult(value: WorkerResult): value is SqliteDeleteLeaseResult {
    return (
      value !== null &&
      !Array.isArray(value) &&
      typeof value === 'object' &&
      'acquired' in value &&
      typeof value.acquired === 'boolean' &&
      'snapshotMaxSequence' in value &&
      (value.snapshotMaxSequence === null ||
        (typeof value.snapshotMaxSequence === 'number' &&
          Number.isSafeInteger(value.snapshotMaxSequence) &&
          value.snapshotMaxSequence >= 0))
    );
  }

  private isDeleteChunkResult(value: WorkerResult): value is SqliteDeleteChunkResult {
    return (
      value !== null &&
      !Array.isArray(value) &&
      typeof value === 'object' &&
      'deleted' in value &&
      typeof value.deleted === 'number' &&
      Number.isSafeInteger(value.deleted) &&
      value.deleted >= 0 &&
      'hasMore' in value &&
      typeof value.hasMore === 'boolean'
    );
  }

  private acceptingWrites(): boolean {
    return !this.closing && (this.state === 'ready' || this.state === 'degraded');
  }

  private assertReadable(): void {
    if (this.state !== 'ready' && this.state !== 'degraded') {
      throw new LlmMetricsRepositoryUnavailableError(this.lastError ?? undefined);
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0 && (this.state === 'ready' || this.state === 'degraded')) {
      const batch = this.queue.splice(0, this.batchSize);
      const batchBytes = batch.reduce((total, item) => total + item.bytes, 0);
      this.queuedBytes -= batchBytes;
      this.inFlightRecords += batch.length;
      this.inFlightBytes += batchBytes;
      try {
        const value = await this.request({
          kind: 'insert',
          exchanges: batch.map((item) => item.exchange),
        });
        if (
          value === null ||
          Array.isArray(value) ||
          typeof value !== 'object' ||
          !('inserted' in value) ||
          !('duplicates' in value)
        ) {
          throw new Error('Invalid insert response from LLM metrics worker');
        }
        this.persisted += value.inserted;
        this.duplicates += value.duplicates;
        if (this.state === 'degraded') this.state = 'ready';
      } catch (error) {
        this.recordBatchDrop(batch.length);
        this.markDegraded(error);
      } finally {
        this.inFlightRecords = Math.max(0, this.inFlightRecords - batch.length);
        this.inFlightBytes = Math.max(0, this.inFlightBytes - batchBytes);
      }
    }
    await this.checkpoint();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.activeFlush !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private async checkpoint(): Promise<void> {
    if (this.state !== 'ready' && this.state !== 'degraded') return;
    try {
      await this.request({
        kind: 'checkpoint',
        observed: this.observed,
        finalized: this.finalized,
        enqueued: this.enqueued,
        checkpointAtMs: Date.now(),
      });
    } catch (error) {
      this.markDegraded(error);
    }
  }

  private request(request: WriterRequestWithoutId): Promise<WorkerResult> {
    this.assertReadable();
    if (this.pending.size >= MAX_PENDING_WORKER_REQUESTS) {
      return Promise.reject(new LlmMetricsRepositoryUnavailableError('LLM metrics worker request limit reached'));
    }
    const id = this.nextRequestId++;
    return new Promise<WorkerResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id } satisfies SqliteWorkerRequest);
    });
  }

  private onMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null || !('kind' in message)) {
      this.disable(new Error('Invalid response from LLM metrics worker'));
      return;
    }
    const response = message as SqliteWorkerResponse;
    if (response.kind === 'ready') {
      this.schemaVersion = response.schemaVersion;
      this.state = 'ready';
      this.resolveReady?.();
      this.resolveReady = null;
      this.checkpointTimer = setInterval(() => void this.checkpoint(), this.checkpointIntervalMs);
      this.checkpointTimer.unref();
      return;
    }
    if (response.kind === 'error' && response.id === undefined) {
      this.disable(new Error(response.message));
      return;
    }
    const id = response.id;
    if (id === undefined) {
      this.disable(new Error('LLM metrics worker response is missing a request ID'));
      return;
    }
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    if (response.kind === 'error') {
      pending.reject(new Error(response.message));
    } else {
      pending.resolve(response.value);
    }
  }

  private disable(error: unknown): void {
    if (this.state === 'closed' || this.state === 'disabled') return;
    this.state = 'disabled';
    this.lastError = sanitizeError(error);
    this.dropped += this.queue.length + this.inFlightRecords;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.inFlightRecords = 0;
    this.inFlightBytes = 0;
    this.clearFlushTimer();
    if (this.checkpointTimer !== null) clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
    this.rejectPending(new LlmMetricsRepositoryUnavailableError(this.lastError));
    this.resolveReady?.();
    this.resolveReady = null;
    void this.reader.close();
    void this.worker.terminate();
  }

  private markDegraded(error: unknown): void {
    if (this.state === 'disabled' || this.state === 'closed') return;
    this.state = 'degraded';
    this.lastError = sanitizeError(error);
  }

  private recordBatchDrop(count: number): void {
    if (this.state === 'ready' || this.state === 'degraded') this.dropped += count;
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}

export async function openSqliteLlmMetricsRepository(
  options: SqliteLlmMetricsRepositoryOptions,
): Promise<SqliteLlmMetricsRepository> {
  return SqliteLlmMetricsRepository.open(options);
}
