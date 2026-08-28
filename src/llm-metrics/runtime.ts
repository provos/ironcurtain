import { dirname } from 'node:path';

import { getLlmStatisticsDatabasePath } from '../config/paths.js';
import { getLlmMetricsEventBus } from './event-bus.js';
import type { LlmMetricsRepository } from './persistence/repository.js';
import { SqliteLlmMetricsRepository } from './persistence/sqlite-repository.js';
import { LlmStatisticsQueryService, type LlmStatisticsReader } from './query-service.js';
import { createPersistenceIdentityProtector, protectLlmMetricsRepository } from './identity-protector.js';
import { BOUNDED_STATISTICS_DELETE_OPTIONS } from './persistence/delete-policy.js';

export interface LlmMetricsRuntimeLease {
  readonly repository: LlmMetricsRepository;
  readonly reader: LlmStatisticsReader;
  release(): Promise<void>;
}

export interface LlmMetricsRuntimeOptions {
  readonly databasePath?: string;
  /** Null disables pruning unless another active lease requests a finite window. */
  readonly retentionDays?: number | null;
}

const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const RETENTION_DAY_MS = 24 * 60 * 60 * 1_000;
const RETENTION_RETRY_BASE_MS = 30_000;
const RETENTION_RETRY_MAX_MS = 30 * 60 * 1_000;
const RETENTION_RETRY_MAX_EXPONENT = Math.ceil(Math.log2(RETENTION_RETRY_MAX_MS / RETENTION_RETRY_BASE_MS));
interface SharedRuntime {
  readonly databasePath: string;
  readonly repository: LlmMetricsRepository;
  readonly reader: LlmStatisticsReader;
  readonly unsubscribe: () => void;
  readonly retentionByLease: Map<symbol, number | null>;
  references: number;
  effectiveRetentionDays: number | null;
  retentionTimer?: ReturnType<typeof setInterval>;
  immediateRetentionTimer?: ReturnType<typeof setTimeout>;
  retentionRetryTimer?: ReturnType<typeof setTimeout>;
  retentionRetryAttempt: number;
  prunePromise?: Promise<void>;
  rerunPrune: boolean;
  closing: boolean;
}

let sharedRuntime: SharedRuntime | undefined;
let lifecycle: Promise<void> = Promise.resolve();

function serializeLifecycle<T>(operation: () => T | Promise<T>): Promise<T> {
  const result = lifecycle.then(operation, operation);
  lifecycle = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function createSharedRuntime(databasePath: string): Promise<SharedRuntime> {
  const statisticsDir = dirname(databasePath);
  const identityProtector = createPersistenceIdentityProtector(statisticsDir);
  const durableRepository = await SqliteLlmMetricsRepository.open({ databasePath });
  const repository = protectLlmMetricsRepository(durableRepository, identityProtector);
  const unsubscribe = getLlmMetricsEventBus().subscribe((exchange) => {
    repository.enqueue(exchange);
  });
  return {
    databasePath,
    repository,
    reader: new LlmStatisticsQueryService(repository),
    unsubscribe,
    retentionByLease: new Map(),
    references: 0,
    effectiveRetentionDays: null,
    retentionRetryAttempt: 0,
    rerunPrune: false,
    closing: false,
  };
}

function validateRetentionDays(value: number | null | undefined): void {
  if (
    value !== undefined &&
    value !== null &&
    (!Number.isSafeInteger(value) || value <= 0 || value > Math.floor(Number.MAX_SAFE_INTEGER / RETENTION_DAY_MS))
  ) {
    throw new Error('LLM metrics retentionDays must be a positive safe integer or null');
  }
}

function effectiveRetentionDays(shared: SharedRuntime): number | null {
  let result: number | null = null;
  for (const retentionDays of shared.retentionByLease.values()) {
    if (retentionDays !== null && (result === null || retentionDays < result)) result = retentionDays;
  }
  return result;
}

function clearRetentionTimers(shared: SharedRuntime): void {
  if (shared.immediateRetentionTimer !== undefined) clearTimeout(shared.immediateRetentionTimer);
  if (shared.retentionTimer !== undefined) clearInterval(shared.retentionTimer);
  shared.immediateRetentionTimer = undefined;
  shared.retentionTimer = undefined;
  resetRetentionRetry(shared);
}

function resetRetentionRetry(shared: SharedRuntime): void {
  if (shared.retentionRetryTimer !== undefined) clearTimeout(shared.retentionRetryTimer);
  shared.retentionRetryTimer = undefined;
  shared.retentionRetryAttempt = 0;
}

function scheduleRetentionRetry(shared: SharedRuntime): void {
  if (shared.closing || shared.effectiveRetentionDays === null || shared.retentionRetryTimer !== undefined) return;
  const exponent = Math.min(shared.retentionRetryAttempt, RETENTION_RETRY_MAX_EXPONENT);
  const delayMs = Math.min(RETENTION_RETRY_BASE_MS * 2 ** exponent, RETENTION_RETRY_MAX_MS);
  shared.retentionRetryAttempt += 1;
  shared.retentionRetryTimer = setTimeout(() => {
    shared.retentionRetryTimer = undefined;
    if (shared.prunePromise === undefined) runRetentionPrune(shared);
  }, delayMs);
  shared.retentionRetryTimer.unref();
}

function runRetentionPrune(shared: SharedRuntime): void {
  if (shared.closing || shared.effectiveRetentionDays === null) return;
  if (shared.prunePromise !== undefined) {
    shared.rerunPrune = true;
    return;
  }
  shared.rerunPrune = false;
  const cutoffMs = Date.now() - shared.effectiveRetentionDays * RETENTION_DAY_MS;
  const prune = (async (): Promise<void> => {
    try {
      const result = await shared.repository.deleteBefore(cutoffMs, BOUNDED_STATISTICS_DELETE_OPTIONS);
      // A large backlog is drained in separately bounded calls. setTimeout(0)
      // below yields between calls. Busy repositories retry with bounded
      // exponential backoff without waiting for the periodic fallback.
      if (result.status === 'busy') scheduleRetentionRetry(shared);
      else {
        resetRetentionRetry(shared);
        if (result.status === 'partial' && !shared.closing) shared.rerunPrune = true;
      }
    } catch {
      // Retention is best-effort management work. Repository health remains
      // queryable and inference/session startup must never fail because of it.
      scheduleRetentionRetry(shared);
    }
  })();
  shared.prunePromise = prune;
  void prune.finally(() => {
    shared.prunePromise = undefined;
    if (shared.rerunPrune && !shared.closing) {
      shared.rerunPrune = false;
      scheduleImmediateRetention(shared);
    }
  });
}

function scheduleImmediateRetention(shared: SharedRuntime): void {
  if (shared.closing || shared.effectiveRetentionDays === null || shared.immediateRetentionTimer !== undefined) return;
  shared.immediateRetentionTimer = setTimeout(() => {
    shared.immediateRetentionTimer = undefined;
    runRetentionPrune(shared);
  }, 0);
  shared.immediateRetentionTimer.unref();
}

function updateRetentionScheduling(shared: SharedRuntime): void {
  const previous = shared.effectiveRetentionDays;
  const next = effectiveRetentionDays(shared);
  shared.effectiveRetentionDays = next;
  if (next === null) {
    clearRetentionTimers(shared);
    return;
  }
  if (shared.retentionTimer === undefined) {
    shared.retentionTimer = setInterval(() => runRetentionPrune(shared), RETENTION_INTERVAL_MS);
    shared.retentionTimer.unref();
  }
  // A new, shorter privacy window should not wait for the periodic timer.
  if (previous === null || next < previous) scheduleImmediateRetention(shared);
}

/** Acquire the process-scoped writer/reader shared by all proxies. */
export async function acquireLlmMetricsRuntime(
  input: string | LlmMetricsRuntimeOptions = {},
): Promise<LlmMetricsRuntimeLease> {
  const options: LlmMetricsRuntimeOptions = typeof input === 'string' ? { databasePath: input } : input;
  validateRetentionDays(options.retentionDays);
  const databasePath = options.databasePath ?? getLlmStatisticsDatabasePath();
  const leaseId = Symbol('llm-metrics-runtime-lease');
  const shared = await serializeLifecycle(async () => {
    if (sharedRuntime !== undefined && sharedRuntime.databasePath !== databasePath) {
      throw new Error('LLM metrics runtime is already active for a different database path');
    }
    sharedRuntime ??= await createSharedRuntime(databasePath);
    sharedRuntime.references += 1;
    if (options.retentionDays !== undefined) sharedRuntime.retentionByLease.set(leaseId, options.retentionDays);
    updateRetentionScheduling(sharedRuntime);
    return sharedRuntime;
  });
  let released = false;
  return {
    repository: shared.repository,
    reader: shared.reader,
    release: async (): Promise<void> => {
      if (released) return;
      released = true;
      await serializeLifecycle(async () => {
        shared.retentionByLease.delete(leaseId);
        shared.references -= 1;
        if (shared.references !== 0) {
          updateRetentionScheduling(shared);
          return;
        }
        shared.closing = true;
        clearRetentionTimers(shared);
        await shared.prunePromise;
        shared.unsubscribe();
        try {
          await shared.repository.close();
        } finally {
          if (sharedRuntime === shared) sharedRuntime = undefined;
        }
      });
    },
  };
}

/** Return the active reader for daemon/WebSocket injection without creating a second runtime. */
export async function getActiveLlmStatisticsReader(): Promise<LlmStatisticsReader | undefined> {
  return serializeLifecycle(() => sharedRuntime?.reader);
}
