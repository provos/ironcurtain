# Workflow Container Snapshot & Resume

## Status

**Implemented on `feat/workflow-container-snapshot-resume` for the acceptance
criteria below.** This document is the design record for the "Resume
reclamation" follow-up tracked as Step 7 in
[`workflow-container-lifecycle.md`](./workflow-container-lifecycle.md).
The shipped scope covers digest-based snapshot capture, guarded digest restore,
host-mount reattachment, dependency-cache preservation, completion/supersede/
startup/age GC, discovery surfacing, and the end-to-end integration test.
The §4.8 disk/cost hardening items around commit concurrency, size pre-checks,
and byte-cap eviction remain follow-up hardening rather than part of the current
acceptance gate.

This revision incorporates three adversarial reviews. The load-bearing
corrections: snapshot images are referenced by **immutable digest, not a mutable
tag** (the only thing that makes this safe across a run and its own resumes, and
across parallel workflows); the commit happens **before** the terminal checkpoint
is written, inside `handleWorkflowComplete`/`abort()`, not in fire-and-forget
teardown; the **only** stop that actually reaches the teardown seam with a live
container is `aborted`; and resume must keep calling `ensureImage` (for the
dep-cache hash) while overriding only the final image reference.

A post-implementation review added two further corrections, now reflected below:
the snapshot primitive is a **flattened `docker export`/`import`** (a single,
parent-less layer, so a superseded digest is force-removable) that **re-bakes the
image Config** (ENTRYPOINT/ENV/…) that export/import drops — not a plain
`docker commit`; and single-flight is enforced by `abort()` claiming
`finalStatus` synchronously before its first `await`. The byte-cap eviction knob
(`snapshot.maxBytes`) was dropped — there is no such config field today.

## Overview

When a workflow stops in a **resumable** state, its Docker containers are
destroyed. On `workflow resume`, containers are minted fresh and **anything the
agent installed into the container's writable layer is lost** — system packages,
globally-installed tools, and artifacts downloaded outside the mounted paths must
be rebuilt from scratch, costing wall-clock time and agent tokens.

This design takes a **flattened filesystem snapshot** of each live container at a
resumable stop (`docker export` piped into `docker import`, see §4.1), records the
resulting **image digest** in the checkpoint, and recreates the container **from
that digest** on resume so the writable layer comes back intact. Host bind mounts
(`/workspace`, the workflow venv, conversation state) are *not* captured — they
re-attach on resume — so the snapshot stores only the otherwise-lost slice, with
no double-storage.

### Parallel-workflow correctness is a first-class requirement

IronCurtain runs **multiple workflows in parallel**, and a single run may stop and
resume several times. Docker's image namespace is **global and shared** across all
of them. The design therefore treats image *identity* as the central correctness
problem, not an afterthought:

- Each commit yields an **immutable content-addressed digest** (`sha256:…`,
  printed on `docker import` stdout). The checkpoint stores the **digest**, and
  resume + garbage collection bind to the **digest** — never to a mutable tag in
  the shared namespace. A human-readable tag is applied for `docker images`
  legibility only and is never the source of truth.
- Cross-workflow isolation across *distinct* runs is already structurally sound:
  `createWorkflowId()` mints a fresh UUIDv4 per start (`src/workflow/types.ts:82`),
  and the orchestrator's per-run state (`bundlesByScope` and siblings) is
  instance-local (`orchestrator.ts:1309`, `:1410`); the only orchestrator-global
  map is `workflows` (`:733`). The real exposure is the **run↔resume lineage**,
  because `resume(workflowId)` *reuses* the same id (`:1394`). Digest-based
  identity (plus a per-stop unique id in the cosmetic tag) closes that gap.

## 1. Motivation

`workflow-container-lifecycle.md` already observed that environment setup
dominates multi-round runs ("On a vuln-discovery run with eight rounds, 80% of
wall-clock time is spent redoing environment setup") and solved the *within-run*
case by moving from per-state containers to **one container per workflow run**.

The *across-resume* case is still open. A workflow that aborts at round 5 — after
the agent has `sudo apt-get install`'d its build dependencies and downloaded a
toolchain — throws all of that away when it resumes, even though the workspace and
conversation state are faithfully restored.

## 2. What already survives resume today

Containers run `sleep infinity`; the agent is driven via discrete, awaited
`docker exec` calls (`docker-agent-session.ts:290`). The container's filesystem is
layered: an **immutable image layer** (base / agent image) plus an **ephemeral
writable layer** (lost on `docker rm`). Bind mounts are a third category — they
live on the host and re-attach to any new container.

Everything below is **already preserved across resume** with no snapshot, because
it lives outside the writable layer. Mount assembly is in
`createDockerInfrastructure` (`src/docker/docker-infrastructure.ts:770`, mount
array at `:1001`; emitted as `-v` by `buildCreateArgs`, `docker-manager.ts:66`).
All preserved paths are **plain bind mounts** — there are no `VOLUME` directives,
named volumes, or tmpfs anywhere, so a commit excludes all of them cleanly.

| Expensive thing | Where it lives | Survives resume? |
|---|---|---|
| Agent workspace: source, **compiled artifacts**, in-tree `node_modules`/build output | Bind mount `workspaceDir → /workspace` (RW) | ✅ host mount |
| Workflow Python venv | `~/.ironcurtain/workflow-deps/<hash>/python-venv` → `/opt/workflow-venv` (RW) | ✅ content-hash cache |
| Workflow Node modules | `~/.ironcurtain/workflow-deps/<hash>/node_modules` → `/opt/workflow-node_modules` (RW) | ✅ content-hash cache |
| Agent conversation history | conversation-state dir (e.g. `~/.claude`) bind-mounted RW | ✅ host mount |
| Python 3.12, Node, Playwright/Chromium, uv, ruff, socat, CA cert | `ironcurtain-base:latest` (`docker/Dockerfile.base`) | ✅ image layer |
| Agent CLI (e.g. Claude Code) | agent image layer (`docker/Dockerfile.claude-code`) | ✅ image layer |

The dependency cache (`provisionWorkflowDependencies`,
`docker-infrastructure.ts:1511`) is keyed by `computeWorkflowDependencyHash`
(`:1412`) over the **agent base-image build hash** (returned by `ensureImage`,
`:1409`) plus the hashes of `requirements.txt` / `package.json` /
`package-lock.json`, with a `.ironcurtain-provisioned-<key>` sentinel that
short-circuits reinstall. A same-hash resume therefore **already skips
`uv pip install` / `npm ci`** — installs land in the host-mounted cache dir, not
the writable layer. (This is why §4.6 must preserve that hash on resume.)

**Implication:** pure-coding workflows — agent writes code and builds in-tree —
gain little from a snapshot, which is exactly why snapshotting is **opt-in and
default-off** (§4.8). The snapshot earns its keep only for workflows that mutate
the container *outside* the mounts.

## 3. The gap: what is actually lost

A snapshot recovers precisely the **writable layer outside the mounts**. The home
directory (`/home/codespace`) is *not* mounted, and neither are the system dirs.
The lost slice:

- `sudo apt-get install <pkg>` → `/usr`, `/var/lib/dpkg` — **lost** (the container
  is granted `SETUID/SETGID/CHOWN/FOWNER/DAC_OVERRIDE` for exactly this,
  `docker-infrastructure.ts:1175`; package fetches route through the MITM registry
  proxy, see [`package-installation-proxy.md`](./package-installation-proxy.md)).
- `npm install -g <tool>` / `pip install --user <pkg>` → `/usr/lib/node_modules`,
  `~/.local` — **lost**.
- Models / datasets / toolchains downloaded to `$HOME`, `/tmp`, `/opt` — anything
  **not** under `/workspace` — **lost**.
- Agent home-dir caches: `~/.cache`, `~/.npm`, `~/.config` — **lost**.

The target workflows do all of: install apt/system packages, download large
artifacts to `$HOME`/`/tmp`, *and* write code + in-tree deps. The snapshot
recovers the apt/system and downloaded-artifact slice; the in-tree slice already
survives via mounts and is **excluded from the commit by design** (it lives under
`/workspace`, a bind mount).

## 4. Design

### 4.1 Why a flattened filesystem snapshot, not CRIU

A snapshot of the container's **filesystem** (writable layer) — not its process
memory — is exactly right here:

- The only long-lived in-container process is `sleep infinity`; the agent is a
  series of `docker exec` invocations whose *logical* state (conversation history)
  is already host-mounted and checkpointed.
- A filesystem snapshot is sufficient to restore installed packages and downloaded
  artifacts.

So `docker checkpoint` / CRIU (process-state freeze) is unnecessary, more fragile,
and experimental in Docker.

The filesystem snapshot is taken by **`docker export` → `docker import`** (a
"flatten"), not plain `docker commit`. The reason is GC, not capture: a
`docker commit` image is a *child layer* of the source image, so superseding it
(resume → stop → re-commit from a container created off the prior snapshot) leaves
the previous digest as a **parent of the new one**, and `docker image rm` refuses
to remove an image with dependent children (not forceable). `export`/`import`
squashes the container into a **single, parent-less layer**, so any superseded
digest can be force-removed cleanly (§4.7). The cost: `export`/`import` discards
the image **Config** (ENTRYPOINT/CMD/WORKDIR/USER/ENV), so the snapshot path
re-bakes that config via `--change` (§4.2) — otherwise a resumed container would
come up with no entrypoint (no UID-remap, no `socat` proxy bridge) and a default
`PATH` (so `node`/`npm` would not resolve).

There is no agent process in flight at snapshot time (sessions are closed before
the commit on both stop paths — §4.3), and `docker export` captures the filesystem
without pausing, so freezing mid-write is not a risk.

### 4.2 Image identity: bind to the digest, not the tag

This is the crux of parallel-workflow safety.

1. **The flattened commit yields a digest; capture it.** `docker import` prints
   the new image ID (`sha256:…`) on stdout. That digest is immutable and
   content-addressed — globally unique under any amount of parallelism, immune to
   retag/rm races in the shared namespace.
2. **Re-bake structural config; stamp only the snapshot labels.** Because the
   flatten drops *all* image Config and labels, there is nothing to "neutralize":
   the inherited `ironcurtain.bundle`/`scope` labels and the per-session sentinel
   env simply don't survive `export`/`import`. The snapshot path instead:
   - reads the live container's `Config` (`docker container inspect`,
     `readContainerConfigChanges` in `docker-manager.ts`) and re-emits
     ENTRYPOINT/CMD/WORKDIR/USER/ENV as `--change` directives on `docker import`,
     so the flattened image still runs its entrypoint and keeps its base-image
     `PATH`. ENV values are shell-safely quoted (newline-bearing values, which are
     always dynamic, are dropped); the stale sentinel key / `HTTPS_PROXY` are
     re-baked but **shadowed** by the fresh `-e` resume passes (§5);
   - stamps a **dedicated label namespace** —
     `ironcurtain.snapshot.workflow=<workflowId>`,
     `ironcurtain.snapshot.scope=<scope>`, `ironcurtain.snapshot.stop=<stopId>` —
     used only by snapshot GC, never reusing `ironcurtain.bundle`, so container-GC
     and image-GC can never cross-target.
3. **Apply a cosmetic, per-stop-unique tag** for `docker images` legibility only:
   `ironcurtain-snapshot:<workflowId>-<scope>-<stopId>`, where `<stopId>` is a
   fresh UUID (or a monotonic per-instance stop counter) minted at **each** commit.
   The `<stopId>` is what prevents a run and its own resume from colliding on a
   tag. `<workflowId>` is lowercase UUID hex and `<scope>` matches
   `/^[a-zA-Z0-9_-]+$/` (`validate.ts:52`); both are legal in the tag-value
   position. Lowercase the scope (or tighten the validator) to stay safe if the
   scheme ever moves the id into the repository-name position, which forbids
   uppercase.
4. **The checkpoint records the digest** (§4.5). Resume (§4.6) and GC (§4.7) use
   the digest. The tag is never the source of truth.

### 4.3 When the snapshot fires, and where

**Only the `aborted` terminal actually reaches a teardown seam with a live
container.** `finalStatus` is assigned in exactly five places
(`orchestrator.ts:1642`, `:2642`, `:2654`, `:2661`, `:2667`) and only ever takes
`aborted` or `completed`. `failed` and `waiting_human` exist in the
`WorkflowStatus` union (`types.ts:495`) but are **transient runtime statuses**,
never terminal: `waiting_human` is synthesized by `getStatus` (`:1541`) while a
gate is active, and `handleGateEntry` (`:2551`) only raises the gate — it does
**not** tear down the container. **A workflow paused at a human gate keeps its
container alive**, so there is nothing to snapshot at gate time and nothing lost.

The `aborted` terminal subsumes every resumable stop that matters: user abort,
quota exhaustion (`:2638`), transient upstream failure (`:2646`), and reaching an
abort terminal state (`:2660`). A `waiting_human` workflow is only snapshotted if
the daemon/CLI shuts down while paused, via `shutdownAll() → abort()`, at which
point it is reclassified `aborted` anyway. The resumability *predicate* stays
`isCheckpointResumable` = `finalStatus?.phase !== 'completed'` (`checkpoint.ts:17`).

**Ordering — commit before the terminal checkpoint save.** The terminal
checkpoint (with `finalStatus`) is written *before* teardown is fired:
`handleWorkflowComplete` (`:2618`) saves at `:2695`, then fires the
fire-and-forget `destroyWorkflowInfrastructure` at `:2714`. `destroyWorkflow­Infrastructure`
has no checkpoint store and runs after the file is already on disk — so the commit
**cannot** live there. Instead:

- Add `snapshotResumableScopes(instance): Promise<Record<scope, SnapshotRef>>`
  that commits each live bundle's `containerId` (per §4.2) **without** clearing or
  destroying `bundlesByScope`.
- In `handleWorkflowComplete`, when the terminal is `aborted`, `await` the
  snapshot **before** building/saving the checkpoint at `:2681`–`:2695`, and fold
  the result into the checkpoint. This makes the currently-synchronous actor
  subscription callback (`:1822`) await a commit — a real structural change this
  design accepts (§4.8 bounds its cost).
- Mirror in `abort()` (`:1622`): commit after sessions are closed (`:1635`) and
  before teardown (`:1653`). `abort()` today intentionally leaves the existing
  checkpoint untouched (`:1655`), so it must now perform one explicit checkpoint
  save to persist the snapshot digests + `aborted` status.
- `destroyWorkflowInfrastructure` stays **purely destructive** — no commit logic.

Commit-before-save also gives clean crash semantics: if the commit fails, that
scope is simply absent from the checkpoint and resume mints it fresh; the
checkpoint can never reference an image that was never written.

### 4.4 Single-flight, per-scope isolation, partial failure

- **Capture entries before any await.** Within `snapshotResumableScopes`, read
  `const entries = [...instance.bundlesByScope.entries()]` up front, then iterate.
  (The existing teardown's safety rests on a synchronous snapshot-and-clear at
  `:1068`; the commit path must not reintroduce a window where the map is mutated
  mid-iteration.)
- **Per-scope try/catch.** A commit failure for one scope (disk full, container
  already gone) records nothing for that scope and continues; it must not abort the
  whole loop. Resume already tolerates absent scopes by minting fresh.
- **Guard against a vanished container.** Treat a snapshot failure from a
  concurrently-removed container (ENOENT out of `docker container inspect` /
  `docker export`) as "skip this scope," not a hard error.
- **Single-flight stop.** `abort()` and `handleWorkflowComplete` both guard on
  `finalStatus`, but a check-then-act without synchronization lets a natural
  completion race a user abort in the `session.close()` window. `abort()` therefore
  **claims the terminal synchronously** — it sets `finalStatus = aborted` before its
  first `await` — so a completion firing during session close bails at its own
  `finalStatus` guard. The early-return path `await`s any in-flight
  `instance.teardownPromise`, so exactly one path commits + tears down and the
  other waits.

### 4.5 Checkpoint schema

Add one field to `WorkflowCheckpoint` (`src/workflow/types.ts:566`):

```text
readonly containerSnapshots?: Readonly<Record<
  string /* containerScope */,
  { readonly image: string /* sha256:… digest — source of truth */;
    readonly tag?: string  /* cosmetic ironcurtain-snapshot:… */ }
>>;
```

Written into the terminal checkpoint by `handleWorkflowComplete`/`abort()` per
§4.3. Backward compatible: absent field ⇒ no snapshots ⇒ resume mints fresh
(today's behavior). The atomic temp-write-then-rename in `FileCheckpointStore.save`
(`checkpoint.ts:53`) is unchanged and makes the `abort()` re-save safe.

### 4.6 Resume: override the image, keep `ensureImage`

On resume, `bundlesByScope` starts empty (`orchestrator.ts:1410`) and the first
state to execute mints its bundle via `ensureBundleForScope` →
`createDockerInfrastructure`. Thread the per-scope digest through:

1. `resume()` (`:1336`) reads `checkpoint.containerSnapshots` and stashes it on the
   `WorkflowInstance` (instance-local, next to `bundlesByScope`).
2. `ensureBundleForScope` passes `instance.containerSnapshots?.[scope]?.image`
   into the infra factory as an optional `baseImageOverride`.
3. **Keep calling `ensureImage`** (`docker-infrastructure.ts:1375`). It returns
   `agentBuildHash` (`:1409`), which is the first input to
   `computeWorkflowDependencyHash` (`:1412`) — the key for the host-mounted
   venv/node_modules cache. Skipping `ensureImage` would orphan that hash and
   needlessly invalidate the dep cache (defeating §2's "already skips install"
   benefit). `ensureImage` is a cheap no-op when images are current. Override
   **only** the final image string passed to `docker create` (`core.image`,
   ~`:1154`) with the snapshot digest. The snapshot was committed from a container
   running that same agent image, so the `agentBuildHash`-derived cache key still
   matches.
4. **Verify before use.** Resume must `imageExists(digest)` (an existing
   `DockerManager` method) and fall back to a fresh container if the image is gone
   (e.g. an operator ran `docker image prune -a`). This makes a missing snapshot a
   graceful degradation, never a crash.
5. Update the stderr notice at `:1431` (which currently warns "Any dependencies
   installed in pre-resume containers are lost") to report restored scopes.

### 4.7 Garbage collection — digest-driven from the checkpoint

Snapshot images can be GB-sized and accumulate per (resumable run × scope). GC
must be **driven by the checkpoint digests**, never by a broad label sweep that
could delete a parallel or resume-pending run's image. There is **no existing
image-removal primitive** to reuse: `removeStaleContainer` (`docker-manager.ts:486`)
removes a single *container* by name with a label *guard* — it is not a label
sweep and does not touch images. New `DockerManager` methods are required (§7).

Lifecycle:

- **Create:** at an `aborted` stop, labeled `ironcurtain.snapshot.workflow=<id>`
  (a dedicated namespace, never `ironcurtain.bundle`, so container-GC and image-GC
  can never cross-target).
- **Supersede (resume-of-a-resume):** on the *next* stop, commit a new image
  (new digest, new `<stopId>` tag), write the new checkpoint, **then**
  `docker image rm` the *previous* digest for that scope — write-new-then-delete-old
  so a crash never strands the live reference. The flattened (parent-less) image
  from §4.1 is what makes that `rm` succeed: a plain-`commit` parent would be
  un-removable while its child snapshot still exists.
- **Delete on clean completion:** when a run reaches `completed`
  (non-resumable per `isCheckpointResumable`), `docker image rm` every digest in
  its `containerSnapshots`.
- **Startup reconciliation (orphan backstop):** on daemon start, list images by
  the `ironcurtain.snapshot.workflow` label and `docker image rm` any whose digest
  is **not** referenced by a present, resumable checkpoint (covers out-of-band
  `rm -rf` of a run dir, and crash-after-commit-before-save). This is the *only*
  label-filtered path, and it is gated on "no resumable checkpoint references this
  digest."
- **Age-based retention (automatic).** A periodic sweep reclaims snapshots that
  are *still referenced by a resumable checkpoint* but have aged out — the case
  none of the paths above touch, because those checkpoints are intentionally kept
  resumable, so an abandoned-but-resumable run would otherwise leak disk forever.
  Governed by `snapshot.maxAgeDays` in `UserConfig` (**default 7**; `null`
  disables). An image whose age — read from `docker image inspect`'s `.Created`,
  cross-checked against the owning checkpoint's `timestamp` (`types.ts:566`) —
  exceeds the threshold is `docker image rm`'d. Crucially it **deletes the image
  only and leaves the checkpoint untouched**: a later resume of an aged-out run
  hits §4.6's `imageExists` guard and degrades to a fresh container, losing the
  dependency-restore optimization but never the ability to resume. Age GC is thus
  a pure disk-reclamation pass — no checkpoint surgery, no risk of bricking a
  resume.
  - **Triggers (mode-independent):** (a) in daemon mode, on daemon start (folded
    into the reconciliation sweep above) and on a periodic timer (default every
    24h), so a long-lived daemon reclaims without a restart; (b) in non-daemon
    use, at the start of every `workflow start` / `workflow resume` CLI
    invocation, so standalone runs reclaim too. All call the same idempotent,
    cheap sweep (a `listImages({labelFilter: 'ironcurtain.snapshot.workflow'})`
    plus an age compare), so coverage does not depend on a daemon being up.
  - **Eviction:** age only (anything past `maxAgeDays`). A byte-cap secondary
    bound (oldest-first eviction under a total-size ceiling via `docker system df`)
    is a deferred follow-up — there is no `snapshot.maxBytes` config field today.

### 4.8 Concurrency, disk, and cost

The commit now sits on the awaited completion/abort path, and N parallel workflows
× M scopes can commit multi-GB layers simultaneously. The first two items below are
**deferred hardening** (not in the current acceptance gate); the rest are shipped:

- **Bound commit concurrency** *(deferred)* with a global semaphore so simultaneous
  multi-GB commits across parallel workflows can't collectively exhaust disk.
- **Size pre-check / cap** *(deferred)*. Before committing, check free space and a
  configurable per-snapshot size cap; over the cap, **skip** (log) rather than
  block — the workflow still resumes, just without that scope's snapshot.
- **Partial-image cleanup.** The flatten path removes its temp tar in a `finally`;
  on a non-flatten commit error a best-effort `docker image rm` of a materialized
  partial keeps the digest GC's view clean.
- **Bounded timeout.** The `commit` method carries its own generous-but-finite
  timeout (10 min, vs `create` 30s); on timeout it falls through to skip-and-log.
- **Default off (shipped).** Opt-in via a workflow-definition
  `settings.snapshotOnStop` flag (alongside `sharedContainer`/`mode`, read near
  `shouldUseSharedContainer`) plus a global `snapshot.enabled` `UserConfig`
  kill-switch — both editable in `ironcurtain config` (Container Snapshots
  section), mirroring the memory kill-switch.

## 5. Security considerations

- **Credential isolation is preserved.** Real API keys / OAuth tokens never enter
  the container — per-session sentinel keys are minted host-side
  (`docker-infrastructure.ts:498`) and swapped at the MITM. The snapshot's re-baked
  `Config.Env` therefore contains only a *stale sentinel*, and on resume a freshly
  minted `-e` of the same name shadows it. Env the agent exports mid-run does
  **not** persist (only create-time `Config.Env` is re-baked, and only single-line
  values). The blast radius is bounded to known create-time vars.
- **The layer still holds whatever the agent wrote** — fetched data, downloaded
  artifacts, files created outside `/workspace`. Snapshots are host-local images:
  never pushed to a registry, deleted on GC, and covered by the same redaction
  expectations as the audit log.
- **No new capabilities.** The agent already has the apt-install capability set;
  snapshotting changes only what persists, not what the agent can do.

## 6. Alternatives considered

### 6.1 CRIU / `docker checkpoint`

Rejected — captures process memory we don't need (no long-lived agent process in
the container; logical state is host-mounted/checkpointed), experimental, heavier.
See [§4.1](#41-why-docker-commit-not-criu).

### 6.2 Pre-baking into the base image

Bake common agent dependencies into `Dockerfile.base`. Orthogonal and already the
strategy for *known, static* deps — but it can't capture *run-specific* installs
the agent decides on at runtime, which is the whole point here.

## 7. Implementation checklist (phased)

1. **Extend `DockerManager`** (`docker-manager.ts`, `execFile`/arg-array pattern,
   CLAUDE.md "no shell string concat"): `commit(containerId, {tag, changes[],
   pause, flatten, timeoutMs})` — with `flatten:true` it routes through
   `docker export | docker import`, re-baking the dropped Config via
   `readContainerConfigChanges` — returning the `sha256:` digest; `removeImage(ref)`
   (distinguishing "already gone" / "still in use" from hard failures);
   `listImages({labelFilter})`; `inspectImage(ref)` (for `.Created` age).
2. **`snapshotResumableScopes(instance)`** in the orchestrator, delegating per
   scope to `commitContainerSnapshot` (`src/workflow/container-snapshots.ts`): a
   flattened commit with config re-bake + snapshot-label stamping (§4.2), per-scope
   try/catch (§4.4). Returns `Record<scope, {image, tag}>`. (Commit-concurrency
   semaphore + size cap, §4.8, are deferred.)
3. **Checkpoint field** `containerSnapshots` in `types.ts:566`; thread through the
   `handleWorkflowComplete` and `abort()` save paths **before** the terminal save
   (§4.3). Backward-compat test (absent field).
4. **Commit-before-save wiring** in `handleWorkflowComplete` (`:2618`, now awaits
   the commit) and `abort()` (`:1622`, adds one explicit save). Single-flight via
   the `teardownPromise` pattern.
5. **`baseImageOverride`** through `ensureBundleForScope` →
   `createDockerInfrastructure`, overriding only `core.image` while still calling
   `ensureImage`; resume reads `containerSnapshots`, stashes per-scope digests,
   and `imageExists`-guards with fresh fallback (§4.6).
6. **GC**: digest-driven supersede + delete-on-complete + startup reconciliation
   sweep + **age-based retention** (`snapshot.maxAgeDays`, default 7, image-only
   deletion) triggered on daemon start/timer and on each CLI `workflow
   start`/`resume` (§4.7).
7. **Surface in discovery**: add `hasSnapshot` / snapshot digests to
   `WorkflowRunSummary` (`workflow-discovery.ts:7`) so `workflow inspect` and the
   daemon past-runs UI show (and can offer to prune) these heavy artifacts.
8. **Integration test**: a workflow that writes a sentinel file to `$HOME` (outside
   `/workspace`) via `docker exec`, aborts, and resumes — assert the file is
   present without re-running setup. Prefer the file-marker over an `apt-get
   install` marker: a real apt install needs the registry/apt MITM proxy live
   (`provisionWorkflowDependencies` hard-fails when package install is disabled,
   `:1525`) and is slow/flaky in CI. Extends
   `test/workflow-policy-cycling.integration.test.ts` territory.
9. **Docs**: update `WORKFLOWS.md`, `src/docker/CLAUDE.md`, and flip Step 7 in
   `workflow-container-lifecycle.md` from *pending* → *shipped*.

## 8. Open questions

- **Default on or off?** Resolved to **off** (opt-in `settings.snapshotOnStop` +
  global kill-switch, §4.8), given disk cost and redundancy for pure-coding
  workflows.
- **No per-state "fresh container" flag is needed.** `freshContainer` was retired
  in favor of `containerScope` (see `workflow-session-identity.md:9`). Snapshots
  are already keyed per `containerScope`; a state that wants an unsnapshotted
  environment simply uses a distinct `containerScope`, which mints a fresh bundle
  with no snapshot key. The "Step 6: validation for freshContainer" item in
  `workflow-container-lifecycle.md` names a field that no longer exists and should
  be re-scoped to `freshSession` + `containerScope`.
- **Commit on the completion critical path.** Because the commit must precede the
  terminal save (§4.3), a multi-GB commit blocks the actor-completion handler. The
  size cap + timeout + semaphore (§4.8) bound this, but the worst case (a huge,
  slow commit before the workflow reports done) is inherent; is the cap the right
  lever, or should very large layers be committed asynchronously with a "snapshot
  pending" checkpoint state?
- **Base-image drift is benign but worth stating.** A snapshot is pinned to the
  base layers it was committed from. The IronCurtain CA is host-stable (10-year,
  regenerated only if missing, `ca.ts:37`), so a base rebuild between stop and
  resume does **not** break the snapshot's baked CA / MITM trust. Layer sharing
  means an ordinary dangling `docker image prune` won't touch a referenced
  snapshot; only `prune -a` / `system prune -a` would, which §4.6's `imageExists`
  fallback already degrades gracefully.

## Code references

- Stop seams: `src/workflow/orchestrator.ts:2618` (`handleWorkflowComplete`,
  saves terminal checkpoint at `:2695`, fires teardown at `:2714`), `:1622`
  (`abort`, closes sessions `:1635`, leaves checkpoint `:1655`, teardown `:1653`),
  `:1673` (`shutdownAll`, awaits `teardownPromise` `:1695`), `:1059`
  (`destroyWorkflowInfrastructure` — stays destructive; snapshot-and-clear `:1068`,
  parallel destroy `:1073`). `finalStatus` assignments: `:1642`, `:2642`, `:2654`,
  `:2661`, `:2667` (only `aborted`/`completed`). Gate: `:2551`
  (`handleGateEntry`, no teardown), `:1541` (`getStatus` synthesizes
  `waiting_human`).
- Resume: `orchestrator.ts:1336` (`resume`), `:1394` (reuses `workflowId`), `:1410`
  (empty `bundlesByScope`), `:1424`/`:1431` (the "dependencies are lost"
  comment/notice this design retires). Id: `src/workflow/types.ts:82`
  (`createWorkflowId` = `randomUUID`); scope: `src/workflow/validate.ts:52`
  (`CONTAINER_SCOPE_PATTERN`), `types.ts:66` (default `'primary'`).
- Checkpoint: `src/workflow/checkpoint.ts:17` (`isCheckpointResumable`), `:53`
  (`FileCheckpointStore.save`); `src/workflow/types.ts:566` (`WorkflowCheckpoint`),
  `:495` (`WorkflowStatus` phases).
- Docker: `src/docker/docker-infrastructure.ts:770` (`createDockerInfrastructure`,
  mounts at `:1001`), `:1375` (`ensureImage`, returns `agentBuildHash` `:1409`),
  `:1412` (`computeWorkflowDependencyHash`), `:1511`
  (`provisionWorkflowDependencies`, package-install guard `:1525`), `:498`
  (per-session sentinel key), `:907` (`buildBundleLabels`), `:1175` (capability
  set); `src/docker/docker-manager.ts:66` (`buildCreateArgs`), `:112` (label
  args), `:242` (`exec`), `:486` (`removeStaleContainer` — single-container, not a
  sweep), `:59` (`IRONCURTAIN_LABEL_WORKFLOW`). Snapshot primitives — `commit`
  (with `flatten` + `readContainerConfigChanges`), `removeImage`, `listImages`,
  `inspectImage` — live in `docker-manager.ts` (interface in
  `src/docker/types.ts`); the snapshot helpers `commitContainerSnapshot` /
  `sweepContainerSnapshots` / `removeContainerSnapshotImages` in
  `src/workflow/container-snapshots.ts`. CA: `src/docker/ca.ts:37`.
- Base images: `docker/Dockerfile.base`, `docker/Dockerfile.claude-code`.
- Discovery: `src/workflow/workflow-discovery.ts:7` (`WorkflowRunSummary`).
- Related designs: `workflow-container-lifecycle.md` (Step 7),
  `workflow-session-identity.md` (containerScope supersedes freshContainer),
  `package-installation-proxy.md` (apt/registry proxy), `session-resume.md`.
