const RETRY_DELAYS_MS = [10, 25, 50] as const;
const waitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export const SQLITE_BUSY_TIMEOUT_MS = 250;

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; errcode?: unknown };
  if (candidate.code === 'SQLITE_BUSY' || candidate.code === 'SQLITE_LOCKED') return true;
  if (candidate.errcode === 5 || candidate.errcode === 6) return true;
  return /database (?:table )?is locked|database is busy/i.test(candidate.message);
}

/** Synchronous because node:sqlite operations run in the dedicated persistence worker. */
export function withSqliteBusyRetry<Value>(operation: () => Value): Value {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length || !isSqliteBusy(error)) throw error;
      const delayMs = RETRY_DELAYS_MS[attempt] as number;
      Atomics.wait(waitBuffer, 0, 0, delayMs);
    }
  }
}
