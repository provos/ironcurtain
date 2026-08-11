# `src/docker-workload/process-lock.ts` — what is load-bearing vs ceremony

Callers: `bundle-lease.ts` (`withLeaseLock`, attempts 2), `docker/docker-resource-lifecycle.ts`
(reconcile lock, attempts 2 + a `{bootId}:{startedAt}` identity adapter),
`docker-workload/infrastructure.ts` (admission lock). Public API they depend on:
`acquireProcessLock(path, {attempts, processIdentityForPid})`, `ProcessLockHandle.release()`,
`ProcessLockBusyError.ownerPid`, `ProcessIdentityResolver`. `malformedGraceMs` / `now` are
test-only seams.

## Load-bearing crash-recovery choreography (do not "simplify" these)

- **Publication**: write + `fsync` a COMPLETE owner record under a unique `.candidate-*` name,
  then `linkSync(candidate, path)`. EEXIST = someone else holds it. This is why a contender can
  never observe a half-written lock (the old `O_EXCL create -> empty file -> write JSON` shape
  could). `O_NOFOLLOW` on the candidate open is redundant — `O_CREAT|O_EXCL` already fails on an
  existing symlink.
- **Ownership = PID + process-start identity + random token.** PID alone is unusable across
  crashes/reboots. Adjudication: same identity -> busy; `undefined` -> PID gone; different ->
  PID reuse. A *throw* from the resolver must map to `ProcessLockBusyError` (never steal a
  possibly-live lock). Same rule for an unreadable lock file.
- **Reclaim**: re-read immediately before capture, `renameSync` to `.stale-*`, verify the
  captured file is still the observed instance (dev/ino AND token), then unlink; on mismatch
  `linkSync` it back. Removing the re-read or the verify reintroduces "delete a racer's
  freshly published lock".
- **`malformedGraceMs`**: a FRESH unparsable entry is mid-publication (busy); only an OLD one is
  reclaimed.
- Linux identity = boot-id + `/proc/<pid>/stat` start ticks; macOS = `/bin/ps -o lstart=` under
  `LC_ALL=C`, exit status 1 -> `undefined`.

## Deliberately NOT defended (trusted single-operator host, reviewed 2026-08)

Peers only publish by link/rename and never reclaim a live owner's lock, so these were removed as
protocol-violating-writer defenses: foreign-uid checks, symlink/`isFile` classification on the
lock path, `O_NOFOLLOW` + double-`fstat` TOCTOU verification around the read, token regex/length
caps in `parseOwner`, and the rename-capture-verify dance for releasing OUR OWN lock (release is
now: lstat, same dev/ino as the inode we published, unlink; otherwise throw "ownership was lost").
Captured instances that lose a restore race are unlinked, not quarantined for inspection.

## Testing note (why coverage stops where it does)

`reclaimObservedLock`'s capture-verify put-back and `restoreCapturedLock`'s EEXIST branch are
**not deterministically reachable from a unit test** — every injectable seam (`processIdentityForPid`,
`now`) fires BEFORE reclaim's re-read, so a file swap performed from a seam is always caught by the
re-read guard instead. `test/docker-workload/process-lock.test.ts` pins the re-read guard instead;
do not add a production-only seam just to reach the inner branch.

Release-behaviour trap for tests: `writeFileSync(path, ...)` rewrites IN PLACE (same inode), so it
no longer simulates a lock takeover. Use write-to-temp + `renameSync` to install a distinct inode.
