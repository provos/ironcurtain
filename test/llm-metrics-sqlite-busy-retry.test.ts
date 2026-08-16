import { describe, expect, it, vi } from 'vitest';

import { withSqliteBusyRetry } from '../src/llm-metrics/persistence/sqlite-busy-retry.js';

function sqliteBusy(): Error {
  const error = new Error('database is locked') as Error & { code?: string };
  error.code = 'SQLITE_BUSY';
  return error;
}

describe('SQLite busy retry', () => {
  it('retries transient busy failures within a fixed attempt bound', () => {
    const operation = vi.fn<() => string>().mockImplementationOnce(() => {
      throw sqliteBusy();
    });
    operation.mockImplementationOnce(() => {
      throw sqliteBusy();
    });
    operation.mockReturnValue('written');

    expect(withSqliteBusyRetry(operation)).toBe('written');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry validation or other non-busy failures', () => {
    const operation = vi.fn(() => {
      throw new Error('constraint failed');
    });

    expect(() => withSqliteBusyRetry(operation)).toThrow('constraint failed');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('surfaces persistent lock contention after the bounded retries', () => {
    const operation = vi.fn(() => {
      throw sqliteBusy();
    });

    expect(() => withSqliteBusyRetry(operation)).toThrow('database is locked');
    expect(operation).toHaveBeenCalledTimes(4);
  });
});
