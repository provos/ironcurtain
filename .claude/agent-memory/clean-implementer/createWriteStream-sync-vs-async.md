---
name: createWriteStream sync vs async error behavior
description: node:fs createWriteStream does not throw synchronously on a missing-parent path — the error is async via the 'error' event. To test a synchronous-throw path in AuditLog.rotate(), use vi.mock('node:fs') with a path-scoped toggle, not a bogus path.
type: feedback
---

When writing tests that need to exercise a *synchronous* failure from `createWriteStream`:

- **Does NOT throw sync:** a path whose parent directory does not exist. Node returns a stream object and emits `{code: 'ENOENT'}` via an async `'error'` event instead.
- **Does throw sync:** invalid argument types caught by input validation (but those are hard to construct plausibly).

**How to apply:** For `AuditLog.rotate()` or any method with an ordering-sensitive invariant ("construct new thing, then tear down old thing"), use `vi.mock('node:fs', async (importOriginal) => ...)` with a path-scoped toggle:

```typescript
let forceCreateWriteStreamThrow: { path: string; error: Error } | null = null;
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    createWriteStream: ((path: string, options?: unknown) => {
      if (forceCreateWriteStreamThrow && path === forceCreateWriteStreamThrow.path) {
        throw forceCreateWriteStreamThrow.error;
      }
      return original.createWriteStream(path, options as Parameters<typeof original.createWriteStream>[1]);
    }) as typeof original.createWriteStream,
  };
});
```

Then gate the throw on a specific path in the one test that needs it, and clear the toggle in `beforeEach` so a stray trap can't corrupt other tests. See `test/audit-log-tailer.test.ts` for the same-shape pattern used to mock `watchFile`/`unwatchFile`.

**Why:** Review suggested "pass a path whose parent doesn't exist" as a way to force a sync throw; in practice that only produces an async `'error'` event, which races with `endStream()` and does not reliably exercise the ordering bug the test is meant to catch.
