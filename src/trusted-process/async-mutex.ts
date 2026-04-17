/**
 * Minimal async mutex for serializing access to coordinator-owned state.
 *
 * Used by ToolCallCoordinator to:
 *   - Serialize concurrent handleToolCall invocations against each other
 *     (protects ApprovalWhitelist, CallCircuitBreaker, ServerContextMap
 *     from read-modify-write races)
 *   - Reserve a separate lock for future loadPolicy operations
 *
 * Implementation notes:
 *   - Single-threaded: `Node.js` concurrency happens only at await points,
 *     so a simple promise-chain mutex is sufficient.
 *   - Fair FIFO order: each acquirer receives a release token after the
 *     previous holder's promise resolves. No priority inversion risk.
 *   - Non-reentrant: a holder that calls `acquire()` recursively will deadlock.
 */
export class AsyncMutex {
  private waitTail: Promise<void> = Promise.resolve();

  /**
   * Acquires the mutex, returning a `release()` function.
   *
   * Usage:
   *   const release = await mutex.acquire();
   *   try { ... } finally { release(); }
   */
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prior = this.waitTail;
    this.waitTail = next;
    await prior;
    return release;
  }

  /**
   * Runs `fn` while holding the mutex. Preferred form for call sites
   * that do not need manual release control.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
