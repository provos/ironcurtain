# Design: Safe Docker PTY ownership reconciliation

**Status:** Proposed
**Scope:** Docker-managed PTY containers and per-session networks

## Problem and evidence

Starting a Docker PTY currently calls global, best-effort reconciliation before
creating the new container (`runPtySession` in `src/docker/pty-session.ts`). The
reconciler treats every managed resource whose owner lease is not `alive` as an
orphan. A lease is `unattributed` when its owner PID is alive but the lease is
missing, malformed, unreadable, or its process identity cannot be read. For
scoped (current-schema) resources, the removal path does not distinguish that
ambiguous state from proven owner death.

This matches the reported symptom: starting a second PTY logged reclamation of
the first session's `ironcurtain-pty-*` container, which caused the idle first
session to exit and disappear. The incident logs alone do **not** establish
whether the resource was classified `unattributed` or `dead`; the design must
make that classification observable before relying on it as the final incident
explanation.

`releaseManagedResourceLease()` currently deletes the lease even while its
owner process is alive. That intentionally enables a later reconciliation to
clean up resources left by a failed teardown, and its test relies on it. Simply
retaining all `unattributed` resources would prevent the deletion incident but
would leak those failed teardowns.

## Goals

- Never delete a current-scope managed resource while its ownership is
  ambiguous.
- Preserve automatic cleanup after process death, PID reuse, and failed
  teardown.
- Make every reclaim/retain decision diagnosable without exposing credentials.
- Preserve existing safeguards for foreign homes, legacy networks, and networks
  with attachments that cannot be proven orphaned.

## Non-goals

- Changing PTY/WebSocket attachment behavior.
- Reclaiming foreign-home resources or making Docker GC a session-start
  prerequisite.
- Solving arbitrary manual Docker-label tampering.

## Ownership lease states

Replace the implicit "lease file exists" protocol with a small durable record:

```json
{
  "leaseSchema": 1,
  "token": "…",
  "pid": 1234,
  "identity": { "bootId": "…", "startedAt": "…" },
  "bundleId": "…",
  "state": "active",
  "createdAt": "…",
  "releasedAt": "…"
}
```

- `active`: the owner is expected to be operating the bundle. It is live only
  when labels, record, PID, and process identity all agree.
- `released`: teardown deliberately relinquished ownership while resources may
  remain. It is an explicit authorization for reconciliation to remove only
  resources whose labels exactly match this record.

Lease creation remains exclusive. State changes must be atomic (write a
same-directory temporary file, then rename) and durable enough that a crash
cannot turn `released` into an unreadable authorization. Successful teardown
deletes its record; a failed or unverified teardown changes `active` to
`released`. The exit hook removes only active records owned by that process;
released records remain until GC verifies removal. A released record is never
created merely because no resources were created.

The record is a tombstone while `released`. GC must not prune it after deleting
one candidate: a token can label both a container and a network (or multiple
resources in a partial setup). It may delete a tombstone only after a complete
container-and-network inventory and post-removal verification establish that no
matching current-scope resource remains. If inventory, removal verification, or
locking fails, retain the tombstone for a future pass.

## Reconciliation decision table

The following applies to current-scope, managed resources. "Retain" includes
logging the reason and does not add the owner token to lease-file deletion.

| Evidence | Classification | Action |
| --- | --- | --- |
| Owner scope differs from this IronCurtain home | foreign | Retain |
| Labels lack a valid PID/token, or owner PID is live and the record is missing, unreadable, malformed, mismatched, or identity probing fails | ambiguous | Retain |
| Exact `active` record and matching live PID identity | active/live | Retain |
| Valid recorded PID is demonstrably dead | dead | Reclaim |
| Exact `active` record but its live PID identity differs | PID reused | Reclaim |
| Exact matching `released` record | explicitly released | Reclaim |
| Unknown lease state or inconsistent `released` record | ambiguous | Retain |

For every reclaim-eligible network, retain the existing second proof: skip it
when it has attachments other than containers already removed in this pass.
Legacy, unscoped resources keep their current conservative behavior: foreign
scope protection where present; empty-and-aged rules for unlabeled legacy
networks; and no removal based solely on a live, unattributable owner. The
implementation should treat malformed ownership labels as ambiguous rather
than as proof of death.

## Implementation outline

1. Introduce typed lease parsing and a richer ownership result, e.g.
   `live`, `released`, `dead`, `pid-reused`, `ambiguous`, and `foreign`; avoid
   using a boolean or collapsing ambiguity into `dead`.
2. Version and atomically persist lease records. Have
   `managedResourceLabels()` continue to stamp the token, PID, and owner scope;
   keep the identity-bound metadata in the lease record.
3. Replace unconditional `releaseManagedResourceLease()` call-site behavior
   with a finalization API: delete the active record after exact absence is
   verified; otherwise mark it `released`. Teardown code must surface a
   verification result instead of swallowing it before finalization.
4. Change container and network loops to reclaim only the three proven cases in
   the table. Remove a lease record only after the corresponding reclamation
   is verified; do not delete records for retained/ambiguous resources.
5. Keep reconciliation best-effort at PTY startup, but log a summary and a
   per-resource decision.

### Ordering and races

- Persist `active` before the first Docker create carrying its labels. A
  concurrent reconciler then sees a positive live ownership proof even before
  the creator has finished setup.
- Do not transition to `released` until the owning flow has stopped creating
  bundle resources and completed its exact teardown attempt. Otherwise GC could
  race a still-active creator/teardown and remove a resource it is using.
- Reconciliation holds the existing per-home reconcile lock for inventory,
  classification, removals, verification, and any tombstone pruning. Creation
  need not take that lock because its durable active record is sufficient; a
  future implementation may serialize creation too if Docker inventory proves
  a remaining race.
- Reclaim Docker objects by their inspected ID/name as today, then verify their
  absence before reporting success or pruning a record. An inventory error or
  lock contention is a no-op, never permission to infer death.

## Migration and compatibility

Existing lease JSON files lack `leaseSchema` and `state`; parse a valid
matching one as `active` for backward compatibility. Resources already stamped
with schema-3 labels retain current scope behavior, except a live owner with a
missing/unreadable lease now fails closed and is retained. During a mixed
old/new process rollout, an old process can still delete a lease; the new
reconciler will retain its live resource rather than risk deletion, and will
clean it when the PID is demonstrably dead. This trades a temporary leak for
safety. No automatic migration is required; records are rewritten on their
next lifecycle transition.

## Test plan

- Live PID plus missing, unreadable, malformed, mismatched, or
  identity-unavailable record: neither container nor network is removed.
- Exact live active record: retained; dead PID and mismatched process identity:
  reclaimed.
- Exact released record with a live PID: reclaimed; inconsistent/unknown
  released record: retained.
- Successful verified teardown deletes its lease; failed/unverified teardown
  writes `released` and is reclaimed on the next pass.
- A released tombstone remains when either a matching container or network
  survives, or inventory/verification fails; it is pruned only after the full
  post-removal inventory is clean.
- Existing foreign-home, legacy-network grace, attachment, dry-run, lock, and
  best-effort startup tests remain valid.
- Add an integration regression: two concurrently live PTY bundles in one home;
  starting/reconciling the second must not remove the first.

## Observability and risks

Emit structured `[docker-gc]` decision logs for each candidate with resource
kind/name, owner scope relation, PID liveness, lease state/classification, and
action/reason. Do not log full lease tokens or session secrets. Emit a summary
count by classification and retain existing removal warnings. This both verifies
the incident branch and makes future unsafe decisions searchable.

The principal trade-off is deliberate: an uncertain resource can leak until an
operator runs an explicit diagnostic/cleanup or later evidence proves it dead.
That is preferable to terminating a live interactive session. Atomic lease
transitions and exact label-to-record matching limit the risk that a stale
`released` record authorizes deletion of an unrelated resource.
