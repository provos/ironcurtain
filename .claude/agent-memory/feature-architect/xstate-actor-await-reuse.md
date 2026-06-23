---
name: xstate-actor-await-reuse
description: Repo ships XState 5.30 (waitFor/toPromise exported); hand-rolled actor.subscribe settle-loops in workflow/ are a recurring missed-reuse
metadata:
  type: reference
---

The workflow layer (`src/workflow/`) depends on `xstate@^5.30.0`, which exports both
`waitFor(actor, predicate, { timeout, signal })` and `toPromise(actor)`.

- `waitFor` resolves with the **full matching snapshot** (`.value`, `.context`, `.status`),
  defaults to `timeout: Infinity`, handles unsubscribe + the already-settled initial-snapshot
  check. Use it when you need the terminal state value or context.
- `toPromise(actor)` resolves only with `snapshot.output` (not value/context), rejects on error.
  Simpler, but not a drop-in when you need which terminal state was reached.

Recurring missed-reuse: code that hand-rolls `new Promise((res,rej) => { const sub =
actor.subscribe(snap => { if (snap.status==='done'){...} else if (snap.status==='error'){...} });
... observe(actor.getSnapshot()) })`. That entire pattern is `waitFor(actor, s => s.status ===
'done' || s.status === 'error')`. Seen in `runFanOutSegment`/`waitForRoundChild`
(orchestrator.ts) during the evolve sync-parallelism slice review (commit 043f180).

Caveat when swapping a manual loop for `waitFor`: the manual loop often *rejects* on actor
`error` status; `waitFor` *resolves* with the error snapshot. The downstream join/await code must
then read `snap.status === 'error'` itself instead of relying on a rejected promise.

UPDATE (commit ae74ea1, evolve Phase-6 aggregated escalation): `waitForRoundChild` was changed to
*resolve* on `status === 'error'` (as an `errored` lane) instead of rejecting — which REMOVES the
above blocker — but the hand-rolled `new Promise`/`subscribe`/`observe(getSnapshot())` settle loop
was kept and grown (now returns a `RoundChildWaiter` with `drain()`/`isSettled()`). The settle half
is now a clean `waitFor(actor, s => s.status==='done'||s.status==='error')` (no timeout to keep
Infinity semantics); the new drain wrapper races that. Still the recurring missed-reuse here.
