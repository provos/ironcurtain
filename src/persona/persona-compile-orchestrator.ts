/**
 * src/persona/persona-compile-orchestrator.ts
 *
 * The long-running persona-compile orchestrator (Phase 1b, §4.3).
 *
 * Owns:
 *  - the per-persona in-memory `active` Map (live snapshot, fast UX path) and a
 *    bounded `recent` LRU (~50) of TERMINAL records keyed by operationId;
 *  - a daemon-wide concurrency gate `globalLimit = pLimit(2)` + a queue cap;
 *  - an O_EXCL filesystem lock per persona generated dir (cross-process
 *    serialization of same-persona compiles) with stale-lock reclaim;
 *  - credential preflight (derive the env var from the policy + prefilter model
 *    ids and verify it is present);
 *  - a wall-clock cap that fires the abort signal;
 *  - daemon-startup stale-lock recovery (synthetic failed events).
 *
 * This module is the ONLY runtime invocation site of `compilePersonaPolicy`,
 * reached EXCLUSIVELY via `await import('./compile-persona-policy.js')`. It
 * carries ONLY type-only pipeline imports; the value edge stays behind the
 * dynamic import + the sanctioned seam. Enforced by the Phase-0 ESLint
 * no-restricted-imports rule + test/pipeline-import-boundary.test.ts.
 *
 * @see docs/designs/web-ui-policy-persona-management.md §4.3, §6
 */

import { randomUUID } from 'node:crypto';
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pLimit from 'p-limit';

import { getPersonaGeneratedDir, getPersonasDir } from './resolve.js';
import { createPersonaName, type PersonaName } from './types.js';
import { EventBusProgressReporter } from './event-bus-progress-reporter.js';
import type { EventBusProgressReporterContext } from './event-bus-progress-reporter.js';
// NOTE: EventBusProgressReporter carries ONLY type-only pipeline imports, so a
// static VALUE import of it does not violate the import boundary (the boundary
// forbids reaching pipeline-runner.ts / pipeline-shared.ts VALUES).
import { loadUserConfig } from '../config/user-config.js';
import { parseModelId, PROVIDER_ENV_VARS, resolveApiKeyForProvider } from '../config/model-provider.js';
import type { ErrorCode, PersonaCompileOperationDto, PersonaCompileResultDto } from '../web-ui/web-ui-types.js';
import type { WebEventBus } from '../web-ui/web-event-bus.js';
// Type-only pipeline imports — no runtime edge. The VALUE edge to the pipeline
// lives only behind `await import('./compile-persona-policy.js')` below.
import type { CompilationPhase } from '../pipeline/pipeline-shared.js';
import type { CompilePersonaOptions } from './compile-persona-policy.js';
import type { CompiledPolicyFile } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Daemon-wide compile concurrency. */
const GLOBAL_CONCURRENCY = 2;
/** Queue cap (number of operations waiting behind the global gate). */
const QUEUE_CAP = 10;
/** Bounded LRU size for terminal records. */
const RECENT_CAP = 50;
/** Wall-clock cap (ms) before the compile is aborted. */
const WALL_CLOCK_CAP_MS = 20 * 60 * 1000;

const LOCK_FILE = '.compile.lock';

/** Shape of the JSON written into the FS lock file. */
interface LockFileContent {
  readonly operationId: string;
  readonly startedAt: string;
  readonly pid: number;
}

/**
 * An error carrying a typed {@link ErrorCode} so the dispatch layer can map it
 * to a `ResponseFrame` error without importing this module's internals. Mirrors
 * the `RpcError` shape but lives here so the orchestrator does not depend on the
 * web-ui dispatch error class.
 */
export class CompileOrchestratorError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CompileOrchestratorError';
  }
}

// ---------------------------------------------------------------------------
// Operation record store
// ---------------------------------------------------------------------------

interface OperationRecord {
  operationId: string;
  name: PersonaName;
  phase: 'started' | 'running' | 'done' | 'failed';
  serverProgress?: { server: string; compilationPhase: CompilationPhase; detail?: string };
  queuePosition?: number;
  startedAt: string;
  endedAt?: string;
  result?: PersonaCompileResultDto;
  error?: { code: ErrorCode; message: string };
  actor: string;
}

/** Test-injectable dependency seam. */
export interface OrchestratorDeps {
  /** Concrete compile implementation; defaults to the dynamic-import seam. */
  readonly compileImpl?: (name: PersonaName, opts: CompilePersonaOptions) => Promise<CompiledPolicyFile>;
  /** Override the wall-clock cap (ms). */
  readonly wallClockCapMs?: number;
  /** Override the queue cap. */
  readonly queueCap?: number;
}

/**
 * Encapsulates all orchestrator state. A module-level singleton is exported for
 * the daemon, but tests instantiate their own to avoid cross-test bleed.
 */
export class PersonaCompileOrchestrator {
  private readonly active = new Map<PersonaName, OperationRecord>();
  private readonly recent = new Map<string, OperationRecord>();
  private readonly globalLimit = pLimit(GLOBAL_CONCURRENCY);
  /** Operations enqueued behind the global gate but not yet running. */
  private queueDepth = 0;
  private readonly deps: OrchestratorDeps;
  private readonly wallClockCapMs: number;
  private readonly queueCap: number;

  constructor(deps: OrchestratorDeps = {}) {
    this.deps = deps;
    this.wallClockCapMs = deps.wallClockCapMs ?? WALL_CLOCK_CAP_MS;
    this.queueCap = deps.queueCap ?? QUEUE_CAP;
  }

  // -------------------------------------------------------------------------
  // Read APIs (ungated)
  // -------------------------------------------------------------------------

  /** Returns the live snapshot for an operation (active first, then recent). */
  getCompile(operationId: string): PersonaCompileOperationDto | undefined {
    for (const rec of this.active.values()) {
      if (rec.operationId === operationId) return toDto(rec);
    }
    const terminal = this.recent.get(operationId);
    return terminal ? toDto(terminal) : undefined;
  }

  /** Returns active + recent operations and the current queue depth. */
  listCompiles(): {
    active: PersonaCompileOperationDto[];
    recent: PersonaCompileOperationDto[];
    queueDepth: number;
  } {
    return {
      active: [...this.active.values()].map(toDto),
      recent: [...this.recent.values()].map(toDto),
      queueDepth: this.queueDepth,
    };
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  /**
   * Starts a streamed compile. Synchronously validates / acquires the lock /
   * mints the operationId / emits `persona.compile.started`, then detaches the
   * actual compile inside the global concurrency gate. Returns the ack.
   *
   * @throws {CompileOrchestratorError} with a typed code on a synchronous
   *   rejection (in-progress, queue-full, credentials-missing).
   */
  startCompile(
    name: PersonaName,
    actor: string,
    eventBus: WebEventBus,
  ): { accepted: true; name: PersonaName; operationId: string; queued?: boolean } {
    // 1) Same-persona dedup via the live `active` Map (fast path). The op is
    //    only here while genuinely active; the active->recent transition is a
    //    single synchronous critical section so a just-settled op is not here.
    const live = this.active.get(name);
    if (live) {
      throw new CompileOrchestratorError('COMPILE_IN_PROGRESS', `A compile for persona "${name}" is already running.`, {
        operationId: live.operationId,
      });
    }

    // 2) O_EXCL FS lock (cross-process correctness). Stale locks are reclaimed.
    const operationId = randomUUID();
    const startedAt = new Date().toISOString();
    this.acquireLockOrThrow(name, operationId, startedAt);

    // 3) Credential preflight (both models). Runs AFTER the dispatch gate, so a
    //    read-only client never reaches here. On miss, release the lock.
    try {
      this.credentialPreflight();
    } catch (err) {
      this.releaseLock(name);
      throw err;
    }

    // 4) Queue cap: if the global gate is saturated and the queue would exceed
    //    the cap, reject. Otherwise enqueue.
    const willQueue = this.globalLimit.activeCount >= GLOBAL_CONCURRENCY;
    if (willQueue && this.queueDepth >= this.queueCap) {
      this.releaseLock(name);
      throw new CompileOrchestratorError('COMPILE_QUEUE_FULL', 'Too many persona compiles are queued.');
    }

    // 5) Insert active record, emit started.
    const record: OperationRecord = {
      operationId,
      name,
      phase: 'started',
      startedAt,
      actor,
    };
    this.active.set(name, record);
    eventBus.emit('persona.compile.started', { name, operationId, actor });

    // 6) Detach the compile inside the global gate. Track queue depth around the
    //    gate so listCompiles reports waiting operations.
    if (willQueue) {
      this.queueDepth += 1;
      record.queuePosition = this.queueDepth;
    }
    void this.globalLimit(async () => {
      if (willQueue) this.queueDepth = Math.max(0, this.queueDepth - 1);
      record.queuePosition = undefined;
      await this.runCompile(record, eventBus);
    });

    return { accepted: true, name, operationId, ...(willQueue ? { queued: true } : {}) };
  }

  // -------------------------------------------------------------------------
  // Detached compile body
  // -------------------------------------------------------------------------

  private async runCompile(record: OperationRecord, eventBus: WebEventBus): Promise<void> {
    const { name, operationId } = record;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('wall-clock cap exceeded')), this.wallClockCapMs);
    // Don't keep the process alive solely for the cap timer.
    if (typeof timer.unref === 'function') timer.unref();

    record.phase = 'running';

    try {
      const compileImpl = this.deps.compileImpl ?? defaultCompileImpl;
      const reporterFactory = (serverName: string) => {
        const ctx: EventBusProgressReporterContext = {
          operationId,
          personaName: name,
          serverName,
          emit: (p) => eventBus.emit('persona.compile.progress', p),
          snapshotUpdate: (snapshot) => {
            record.serverProgress = {
              server: snapshot.serverName,
              compilationPhase: snapshot.compilationPhase,
              ...(snapshot.detail ? { detail: snapshot.detail } : {}),
            };
          },
        };
        return new EventBusProgressReporter(ctx);
      };

      const policy = await compileImpl(name, {
        reporterFactory,
        signal: abort.signal,
        quiet: true,
        operationId,
        allowMcpLists: false,
      });

      record.result = { success: true, ruleCount: policy.rules.length };
    } catch (err) {
      record.error = classifyError(err);
    } finally {
      clearTimeout(timer);
      // ONE synchronous critical section: move active->recent, release lock.
      // No `await` between these ops so getCompile/listCompiles always find the
      // op in exactly one place.
      record.endedAt = new Date().toISOString();
      record.phase = record.error ? 'failed' : 'done';
      this.active.delete(name);
      this.releaseLock(name);
      this.pushRecent(record);

      if (record.error) {
        eventBus.emit('persona.compile.failed', {
          name,
          operationId,
          code: record.error.code,
          error: record.error.message,
        });
      } else if (record.result) {
        eventBus.emit('persona.compile.done', { name, operationId, result: record.result });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Startup recovery
  // -------------------------------------------------------------------------

  /**
   * Scans persona dirs for `.compile.lock` files. A stale lock (dead pid or
   * past the wall-clock cap) is released and a synthetic `persona.compile.failed`
   * event is emitted (operationId from the lock) so a reconnecting UI clears the
   * stuck card. Live (pid-alive, within-cap) locks are left in place.
   */
  recoverStaleLocks(eventBus: WebEventBus): void {
    const personasDir = getPersonasDir();
    if (!existsSync(personasDir)) return;
    let entries: string[];
    try {
      entries = readdirSync(personasDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      let name: PersonaName;
      try {
        name = createPersonaName(entry);
      } catch {
        continue; // tmp dirs / trash / invalid slugs
      }
      const lockPath = resolve(getPersonaGeneratedDir(name), LOCK_FILE);
      if (!existsSync(lockPath)) continue;
      const content = readLockFile(lockPath);
      if (!content) {
        // Unparseable lock — treat as stale and remove.
        safeUnlink(lockPath);
        continue;
      }
      if (this.isLockStale(content)) {
        safeUnlink(lockPath);
        eventBus.emit('persona.compile.failed', {
          name,
          operationId: content.operationId,
          code: 'INTERNAL_ERROR',
          error: 'Compile interrupted by daemon restart.',
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // FS lock
  // -------------------------------------------------------------------------

  private acquireLockOrThrow(name: PersonaName, operationId: string, startedAt: string): void {
    const lockPath = resolve(getPersonaGeneratedDir(name), LOCK_FILE);
    const payload: LockFileContent = { operationId, startedAt, pid: process.pid };
    try {
      writeLockExclusive(lockPath, payload);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    // Lock exists — reclaim if stale, else COMPILE_IN_PROGRESS.
    const existing = readLockFile(lockPath);
    if (existing && !this.isLockStale(existing)) {
      throw new CompileOrchestratorError('COMPILE_IN_PROGRESS', `A compile for persona "${name}" is already running.`, {
        operationId: existing.operationId,
      });
    }
    // Stale (or unparseable) — remove and retry once.
    safeUnlink(lockPath);
    writeLockExclusive(lockPath, payload);
  }

  private releaseLock(name: PersonaName): void {
    safeUnlink(resolve(getPersonaGeneratedDir(name), LOCK_FILE));
  }

  private isLockStale(content: LockFileContent): boolean {
    // Dead pid => stale.
    if (!isPidAlive(content.pid)) return true;
    // Past the wall-clock cap => stale.
    const started = Date.parse(content.startedAt);
    if (Number.isNaN(started)) return true;
    return Date.now() - started > this.wallClockCapMs;
  }

  // -------------------------------------------------------------------------
  // Credential preflight
  // -------------------------------------------------------------------------

  private credentialPreflight(): void {
    const config = loadUserConfig({ readOnly: true });
    const missing = new Set<string>();
    for (const modelId of [config.policyModelId, config.prefilterModelId]) {
      const { provider } = parseModelId(modelId);
      const key = resolveApiKeyForProvider(provider, config);
      if (!key) missing.add(PROVIDER_ENV_VARS[provider]);
    }
    if (missing.size > 0) {
      throw new CompileOrchestratorError(
        'CREDENTIALS_MISSING',
        `Missing credential(s) on the daemon host: ${[...missing].join(', ')}.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Recent LRU
  // -------------------------------------------------------------------------

  private pushRecent(record: OperationRecord): void {
    // Map preserves insertion order; delete-then-set moves to MRU.
    this.recent.delete(record.operationId);
    this.recent.set(record.operationId, record);
    while (this.recent.size > RECENT_CAP) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

/**
 * The default compile implementation: the dynamic-import seam to the sanctioned
 * pipeline-value module. Keeping it a free function (not a static import at the
 * top of the file) is what keeps the import-boundary green.
 */
async function defaultCompileImpl(name: PersonaName, opts: CompilePersonaOptions): Promise<CompiledPolicyFile> {
  const { compilePersonaPolicy } = await import('./compile-persona-policy.js');
  return compilePersonaPolicy(name, opts);
}

function toDto(rec: OperationRecord): PersonaCompileOperationDto {
  return {
    operationId: rec.operationId,
    name: rec.name,
    phase: rec.phase,
    ...(rec.serverProgress ? { serverProgress: rec.serverProgress } : {}),
    ...(rec.queuePosition !== undefined ? { queuePosition: rec.queuePosition } : {}),
    startedAt: rec.startedAt,
    ...(rec.endedAt ? { endedAt: rec.endedAt } : {}),
    ...(rec.result ? { result: rec.result } : {}),
    ...(rec.error ? { error: rec.error } : {}),
    actor: rec.actor,
  };
}

/**
 * Classifies a thrown compile error into a typed `{ code, message }`. Credential
 * / MCP-list / broad-policy / orchestrator errors carry their codes; everything
 * else maps to INTERNAL_ERROR with an operator-safe message.
 */
function classifyError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof CompileOrchestratorError) {
    return { code: err.code, message: err.message };
  }
  // Discriminant string from the pipeline (McpListsDisallowedError) — detected
  // without importing the thrower's module (layering rule).
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === 'MCP_LISTS_DISALLOWED') {
    return { code: 'LIST_REQUIRES_MCP', message: 'A dynamic list requires live MCP access, which is disabled.' };
  }
  const message = err instanceof Error ? err.message : String(err);
  // AI SDK missing-key surfaces as a LoadAPIKeyError; map to CREDENTIALS_MISSING.
  if (err instanceof Error && (err.name === 'LoadAPIKeyError' || /api key/i.test(message))) {
    return { code: 'CREDENTIALS_MISSING', message: 'Missing model credentials on the daemon host.' };
  }
  return { code: 'INTERNAL_ERROR', message: 'Persona compilation failed.' };
}

/** Writes the lock file with O_EXCL (`wx`): fails with EEXIST if it exists. */
function writeLockExclusive(lockPath: string, payload: LockFileContent): void {
  // 'wx' => O_CREAT | O_EXCL | O_WRONLY. The generated dir already exists for
  // any compiled persona; if not, createPersona made it.
  const fd = openSync(lockPath, 'wx');
  try {
    writeSync(fd, JSON.stringify(payload));
  } finally {
    closeSync(fd);
  }
}

function readLockFile(lockPath: string): LockFileContent | null {
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LockFileContent>;
    if (
      typeof parsed.operationId === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.startedAt === 'string'
    ) {
      return { operationId: parsed.operationId, pid: parsed.pid, startedAt: parsed.startedAt };
    }
    return null;
  } catch {
    return null;
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** True iff a process with `pid` exists (signal 0 probe). */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH => no such process. EPERM => exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Daemon singleton
// ---------------------------------------------------------------------------

/** The daemon-wide orchestrator singleton. Tests construct their own instance. */
export const personaCompileOrchestrator = new PersonaCompileOrchestrator();
