# Workflow FSM: single-active-state spine + vestigial parallelism (verified 2026-06-18)

The IronCurtain workflow abstraction is **single-active-state by construction**. Verified
while scoping `docs/brainstorm/evolve-parallelism.md`.

## The single-active-state spine (the load-bearing assumption)
- `const stateValue = String(snapshot.value)` (`orchestrator.ts:1873` as of 2026-06-18; was
  `:1743` in an older tree). Coerces XState
  snapshot value to a STRING. A `type:'parallel'` machine's value is an OBJECT → would
  become `"[object Object]"`. This one line is the core blocker to true parallel regions.
- `instance.currentState: string` (single field, set `:1786`, init `:1306`, resume reads
  `String(checkpoint.machineState)` `:1407`).
- `definition.states[previousState].type` (`:1751`), `isTerminalStateValue` (`:1838`):
  assume stateValue names exactly one state.
- `transitionHistory: TransitionRecord[]` is FLAT `{from,to,event}` (`types.ts:600`);
  checkpoint stores `machineState: snapshot.value` serialized as a string (`types.ts:566`).
- Gate model assumes AT MOST ONE pending gate: `instance.activeGateId` single nullable
  string (`:2556`/`:1598-1605`); `WorkflowStatus.gate` single (`types.ts:497`); CLI
  protocol `run->await->(show->gate->await)*->terminal` (`daemon-gate-commands.ts:9`),
  no gate-id selector on `gate`.
- Policy hot-swap is single-valued: `cyclePolicy` tracks ONE persona per bundle
  (`currentPersonaByBundle: Map<bundleId,persona>`, `:986/:1029`); coordinator has ONE
  active policy. Concurrent agent states on a shared scope would race it. Audit `persona`
  also single-valued.

## XState: v5 (`package.json:103`), `setup().createMachine()` at machine-builder.ts:474.
Uses: flat states, `invoke`+`fromPromise` actors (agentService/deterministicService,
`.provide()` at orchestrator.ts:1708), onDone/onError, guards (`__matchesWhen`
parameterized), `assign`, `final` terminals. NOT used: `type:'parallel'`, nested/compound
states, `spawn`, sendTo, `after`, history. Machine builder emits ONLY 4 flat kinds
(`machine-builder.ts:357-377`). The ONLY usable concurrency without touching the spine:
one `invoke` that fans out INTERNALLY (FSM sees one state).

## Vestigial parallelism scaffolding (DEAD — a reverted earlier design)
Type surface carries an aspirational parallel vocabulary that NO code produces/consumes:
- `WorkflowEvent`: `PARALLEL_ALL_COMPLETED|PARALLEL_SLOT_FAILED|MERGE_SUCCEEDED|MERGE_CONFLICT`
  (`types.ts:429-432`) — never sent.
- `WorkflowContext.parallelResults`/`worktreeBranches` (`types.ts:452-453`) — init `{}`/`[]`,
  never written. `WorkflowStatus.running.activeAgents` (`types.ts:496`) hardcoded `[]`
  (`orchestrator.ts:1550`). `settings.maxParallelism` (`types.ts:115`) read nowhere.
  Agent `worktree?` (`types.ts:184`) consumed nowhere.
- `parallelKey` schema field was REMOVED as unused; lint WF005 retired for that reason
  (`lint.ts:43-45`). Treat these types as a graveyard to delete or deliberately revive.

## Deterministic executor is SERIAL
`reduceDeterministicCommands` (`orchestrator.ts:2481-2500`) runs `run:` commands in a `for`
loop, one `docker.exec` each (`:2488`). A fan-out worker pool = either make this a
bounded `Promise.all`, OR (preferred, zero FSM change) have a single bridge helper fan out
internally.

## Engine concurrency split (evolve_core) — verified
- **database.py IS cross-process safe**: `_database_guard` takes `InterProcessFileLock`
  AND reloads-from-disk inside the lock (`refresh=True`, database.py:207-215, reload
  :210-211), atomic `os.replace` save (:147-167). Concurrent `sample`/`record` safe.
- **cognition.py is NOT**: in-process `RLock` only (cognition.py:30), no file lock,
  non-atomic `json.dump` (:103-112), and NO reload-before-save → last-writer-wins clobber.
  `cmd_cognition_add` builds fresh store + add_batch (cli.py:362-389). THE one engine-level
  parallelism blocker; fix is bridge-side `InterProcessFileLock`, never an engine edit.
- Upstream README documents `pipeline.parallel.num_workers` 2-4 for production
  (`scripts/README.md:286`) — engine IS designed for parallel workers. `island` sampler is
  MAP-Elites WITHIN one DB (island.py), not separate populations.

## XState usage is REAL actor runtime (not "manual pump") — verified 2026-06-18
- `createActor(providedMachine)` (orchestrator.ts:1388), `actor.start()` (:1434), `actor.subscribe(...)` (:1864). Services ARE genuine `fromPromise` invokes whose bodies call `executeAgentState`/`executeDeterministicState` (`provideActors` :1833-1858, `.provide({actors:{agentService,deterministicService}})`). XState auto-transitions on `xstate.done.actor` and fires `incrementVisitCount` ENTRY action per state entry (machine-builder.ts:262, assign :604-608). `maxVisits` is an XState guard `isStateVisitLimitReached` over `maxVisitsByState` map (:351-362, :406-411). `updateContextFromAgentResult` assign (:489) writes tokens/outputHash back.
- The ONLY "manual" part: resume replay `replayInvokeForRestoredState` (:1554-1608) — it manually re-runs ONE state's invoke because resolveState restores-to but doesn't enter. So "orchestrator is a manual pump" framing is OVERSTATED; it's actor-driven with a manual resume seam.
- CAVEAT for spawned-child-actor designs (load-bearing): checkpoint is `{machineState: snapshot.value, context}` (buildCheckpoint :1977-1999) restored via `resolveState({value, context})` (:1457) + `createActor(m,{snapshot})`. NOT `getPersistedSnapshot()`. So spawned child `ActorRef`s held in context do NOT survive the JSON round-trip today. Any "spawn N children, persist via XState" design REQUIRES migrating checkpoint to `getPersistedSnapshot()`/`actor.getPersistedSnapshot()` AND reconciling context-stored refs — a real migration, not free.
- Spawned/invoked child ACTORS are NOT `type:parallel` REGIONS. Parallel-regions make `snapshot.value` an object → break `String(snapshot.value)` (:1873) → correctly rejected. Spawned actors keep parent value a string (children are refs in context, snapshots not folded in) → preserve single-active-state. The two are distinct; don't conflate.

## Scheduler-factory + transport seams (for distributed/resource-isolated eval) — verified 2026-06-18
- Placement seam EXISTS: orchestrator never creates a container directly — calls injected `createWorkflowInfrastructure` factory (deps field :463, called :862, default impl `loadDefaultInfrastructureFactory` :1216 lazy-imports `createDockerInfrastructure`). Then only touches `bundle.docker.exec` (:2667). "FSM talks to bundles, not nodes." A scheduler is a different factory impl.
- Transport seam PARTIAL: proxies already have TCP mode (docker-infrastructure.ts:454 `listenMode: useTcp?'tcp':'uds'`, socat sidecar + per-session `--internal` network :290-293, :1029-1077). Coordinator control server CAN bind loopback TCP (control-server.ts:341 `listen(port,'127.0.0.1')`) but orchestrator passes a UDS path (`controlSocketPath` :848 via getBundleControlSocketPath). Cross-host needs non-loopback bind + network-addressable control transport.
- Same-host vs cross-host boundary: same-host preserves shared `/workspace` mount → file-locked DB stays shared free. Cross-host breaks that (node DB on local FS → networked store) AND needs network control transport AND re-established `--network=none`+host-proxy trust per node. Same-host emulation defers all three.

## Recommendation reached
Intra-round fan-out (eval N candidates concurrently) is the high-value form; DB already
tolerates it. Ship it INSIDE evolve_result.py bridge (parallelism stays a leaf, FSM
single-active-state intact), serialize cognition promote at fan-in. True XState parallel
regions (Option C) break gate+policy+checkpoint spine — avoid as first step.
See `docs/brainstorm/evolve-parallelism.md`.

## Coordinator IS built for concurrent callers (verified 2026-06-18 — de-risks the "one real unknown")
- `ToolCallCoordinator` holds a FIFO `callMutex` (AsyncMutex, fair FIFO async-mutex.ts:13,
  non-reentrant :15). EVERY `handleToolCall`/`handleStructuredToolCall` runs its WHOLE body
  (buildCallToolDeps + handleCallTool incl. the JSONL audit append) inside
  `callMutex.withLock` (tool-call-coordinator.ts:310-313, :348-357). So audit-append +
  CallCircuitBreaker + ApprovalWhitelist + ServerContextMap RMW are ALREADY serialized vs
  concurrent lanes — N concurrent tool-call streams queue, can't tear. The mutex is NOT new work.
- Residual unknowns for N-lane parallelism: (1) escalation await may happen INSIDE the held
  callMutex → lane-0 escalation would block lanes 1..N-1 (held-mutex stall). Mitigation =
  drain-on-escalation (at most one escalation ever live). (2) AutoApprover concurrency
  (moot under drain). (3) breaker threshold may need to scale with workers (tuning, not bug).
- `AuditEntry` (types/audit.ts:3-47) has `persona?` (:46, single-valued) but NO lane-id → add
  `laneId?` for attribution. Homogeneous persona means lane-id is the only stream discriminator.
- Deterministic `container:true` states are TRUSTED docker exec (argv from YAML), NOT coordinator
  tool calls (trusted-process/CLAUDE.md). Only agent (researcher/analyzer) calls hit the coordinator.

## Sync (barrier-batched) parallelism design (designed 2026-06-18)
- See `docs/designs/evolve-sync-parallelism-slice.md`. SYNC ONLY (async = explicit non-goal,
  shaped additive). `settings.workers` count (default 1 = byte-identical no-op of linear chain).
- **RESTRUCTURED 2026-06-18** around three interlocking changes (see doc Status changelog). The
  OLD `LaneTraversal` manual-pump mechanism is SUPERSEDED; do not cite it.
- Mechanism NOW: parent FSM stays in ONE `workers` state; its invoke `runFanOutSegment` SPAWNS
  N child round-machine ACTORS (XState v5 `spawn`; round sub-chain factored into a spawnable
  child machine in machine-builder.ts with same agentService/deterministicService provided).
  Each child = real actor, so incrementVisitCount/maxVisits/updateContextFromAgentResult fire
  per lane NATIVELY from the child's own context — zero manual re-implementation (this deleted
  the old §7.5 shadow-FSM table). Spawned ACTORS ≠ parallel REGIONS: parent String(snapshot.value)
  stays "workers" (children are refs in context, not folded into value). Barrier = await children's
  onDone outputs. `bundle.docker.exec(containerId)` (orchestrator.ts:2667) = N-concurrent-exec point.
- Residual cost (NOT shadow-FSM): observability fan-in — per-lane transition history needs
  subscribing to child actors (or sendParent). Principled XState work.
- batch.json DELETED (not advisory). Resume first cut = DB-as-truth + re-spawn (synthesize
  `recorded` for lanes the DB has, spawn fresh for the rest). PERSISTENCE CAVEAT: current
  checkpoint is {machineState, context} via resolveState (orch:1457/:1977-1999), NOT
  getPersistedSnapshot() → spawned-child ActorRefs do NOT survive the round-trip. Migrating to
  getPersistedSnapshot() is the clean long-term option, flagged for reviewers, not assumed done.
- CHANGE 2: scheduler-factory seam (§8.5) — orchestrator never creates containers, calls injected
  createWorkflowInfrastructure factory (orch:463/:862/:1216) + only touches bundle.docker.exec.
  A scheduler = different factory impl. Transport: proxies already have TCP mode (docker-infra:454);
  control socket still loopback-only. Same-host preserves shared /workspace+DB; cross-host breaks all 3.
- CHANGE 3: lane divergence INJECTED at sample (barrier-side db.sample(n=N) over island/MAP-Elites,
  per-lane seed base_seed+laneId; content-hash candidates at fan-in, log dup rate). Two-pool:
  only `evaluate` is schedulable (heavy local compute → eval-slot pool via schedule:{pool:eval}
  marker); researcher/analyzer = LLM egress, stay in shared container.
- Lane discipline (unchanged): per-lane `current/lane_<k>/` dirs; lane-tagged step names
  `step_<batch>_lane_<k>` for resume-stable idempotency (meta_info.step_name :186-191).
- Cognition promotion serialized at barrier (cognition.py NOT cross-proc safe); DB record per-lane.
- Escalation = child `blocked` final state, read at barrier → ONE aggregated human_escalation gate.
- Biggest risk still = coordinator audit (Phase 0). Mutex-release escalation fix in-scope.
