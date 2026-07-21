# Parallelism in the IronCurtain Workflow FSM — discussion proposal

**Status:** brainstorm / discussion only. No implementation. Motivated by making the
`evolve` (ASI-Evolve port) workflow more useful.

This document maps the **current** abstraction (with `file:line` citations), separates
"what XState can do" from "what our manifest/validator/orchestrator currently exposes,"
grounds the question "what parallelism does ASI-Evolve actually need?" in the vendored
engine, and proposes options from minimal to ambitious with a recommendation.

---

## Part 1 — The current abstraction (single-active-state by construction)

### 1.1 State kinds, transitions, outputs

Four state kinds, a discriminated union on `type`
(`src/workflow/types.ts:156`): `agent` (`:162`), `human_gate` (`:247`),
`deterministic` (`:261`), `terminal` (`:292`).

Transition model:

- Agent / deterministic transitions: `AgentTransitionDefinition`
  (`types.ts:332`) carry `to`, an optional `guard` (named XState guard) **xor** a
  `when` clause (declarative field-match on `AgentOutput`, `types.ts:348`), and optional
  `actions` (`types.ts:354`). Only `verdict` is actually supported in `when` today
  (`validate.ts:375-382`).
- Human-gate transitions: `HumanGateTransitionDefinition` (`types.ts:357`) carry `to`
  and one `event` from `HumanGateEventType = APPROVE | FORCE_REVISION | REPLAN | ABORT`
  (`types.ts:369`).
- Artifacts: agent `inputs`/`outputs` are artifact-name arrays (`types.ts:178-180`);
  deterministic states may emit a `resultFile` (`types.ts:288`); the orchestrator's
  context holds `artifacts: Record<string,string>` (`types.ts:440`).

### 1.2 The single-active-state assumption is structural, not incidental

`WorkflowContext.round`, `previousStateName`, `previousAgentOutput`,
`visitCounts`, `agentConversationsByState` are all keyed/scalar around **one**
state finishing at a time (`types.ts:438-489`). But the load-bearing assumption lives
in the orchestrator's actor subscription:

- `const stateValue = String(snapshot.value)` (`orchestrator.ts:1743`). XState's
  `snapshot.value` for a flat machine is a **string**; for a `type: 'parallel'` machine
  it is an **object** (`{regionA: 'x', regionB: 'y'}`). `String({...})` yields
  `"[object Object]"`, which then indexes `definition.states[...]` and is written as the
  transition `to`/`from` — silently corrupting history, checkpoint, and gate matching.
- `definition.states[previousState].type` (`orchestrator.ts:1751`) and
  `isTerminalStateValue` (`orchestrator.ts:1838`) both assume `stateValue` names exactly
  one entry in `definition.states`.
- `instance.currentState: string` (single field, set at `orchestrator.ts:1786`; initial
  `:1306`; resume reads `String(checkpoint.machineState)` `:1407`).

So **the data model cannot represent two states active at once.** Two states active
would require `currentState` to become a set / `snapshot.value` to be consumed as a tree.

### 1.3 Vestigial parallelism scaffolding (already in the tree, already dead)

The type surface carries an **aspirational, unwired** parallelism vocabulary that no
code path produces or consumes:

- `WorkflowEvent` includes `PARALLEL_ALL_COMPLETED`, `PARALLEL_SLOT_FAILED`,
  `MERGE_SUCCEEDED`, `MERGE_CONFLICT` (`types.ts:429-432`) — **never sent** anywhere in
  `src/` (grep: only the type declaration).
- `WorkflowContext.parallelResults` (`types.ts:452`) and `worktreeBranches`
  (`types.ts:453`) are initialized to `{}` / `[]` (`machine-builder.ts:160-161`,
  `cli-support.ts:452-453`) and **never written**.
- `WorkflowStatus.running.activeAgents: readonly AgentSlot[]` (`types.ts:496,506`) is
  hardcoded to `[]` (`orchestrator.ts:1550`).
- `settings.maxParallelism` (`types.ts:115`, validated `validate.ts:109`) is **read
  nowhere**.
- Agent `worktree?: boolean` (`types.ts:184`, validated `validate.ts:62`) is **consumed
  nowhere**.
- A `parallelKey` schema field **once existed and was removed as unused**; lint code
  WF005 ("parallelKey + worktree needs gitRepoPath") is now **retired** for that reason
  (`lint.ts:43-45`). The machine builder emits **no** `type: 'parallel'` node and no
  fan-out `invoke` (`machine-builder.ts:357-377` handles only the four flat kinds).

**Read this as a partially-reverted earlier design.** The types are a graveyard, not a
foundation; any real proposal should either revive them deliberately or delete them, not
silently inherit them.

### 1.4 Compilation to XState

- XState **v5** (`"xstate": "^5.30.0"`, `package.json:103`).
- Single `setup({...}).createMachine({...})` call (`machine-builder.ts:474-630`).
- Features **used:** flat atomic states, `invoke` with `fromPromise` actors
  (`agentService`, `deterministicService`, `machine-builder.ts:480-485`, injected via
  `.provide()` at `orchestrator.ts:1708`), `onDone`/`onError` transitions, guards
  (incl. the parameterized `__matchesWhen`, `machine-builder.ts:439`), `assign` actions,
  `final` states for terminals (`machine-builder.ts:373`).
- Features **NOT used:** `type: 'parallel'` regions, nested/compound states, `spawn`
  (dynamic actors), `sendTo`, delayed/`after` transitions, history states. Every state is
  a single flat node with at most one in-flight `invoke`.

### 1.5 The gate model assumes at most one pending gate

- A gate suspends by being a state with only `on: { HUMAN_* }` handlers and no `invoke`
  (`machine-builder.ts:309-329`) — the machine simply parks there.
- `instance.activeGateId` is a **single nullable string** (set `orchestrator.ts:2556`,
  read/cleared in `resolveGate` `:1598-1605`). `resolveGate` resolves *the* active gate;
  there is no gate selector.
- `WorkflowStatus` exposes a single `gate` (`types.ts:497`); the CLI await protocol is
  `run -> await -> (show -> gate -> await)* -> terminal` (`daemon-gate-commands.ts:9`),
  blocking on a single `waiting_human` phase (`:511`) and resolving the one gate with
  `--event` and no id (`:583`). **Concurrent regions each reaching a gate cannot be
  addressed or resolved** under today's model.

### 1.6 Execution substrate & policy hot-swap (single-valued under concurrency)

- Each agent state runs one agent session in the shared container; deterministic states
  run their `run:` commands. The deterministic executor reduces commands **serially** in
  a `for` loop, one `docker.exec` per command (`orchestrator.ts:2488-2500`,
  `runDeterministicInContainer` `:2522-2540`). There is no fan-out today.
- Policy hot-swap: `cyclePolicy` (`orchestrator.ts:980`) sends `loadPolicy` over the
  bundle's UDS control socket and tracks **one** current persona per bundle
  (`currentPersonaByBundle: Map<bundleId, persona>`, `:986`, `:1029`). The coordinator
  has a **single active policy** at a time. Two concurrent agent states sharing a scope
  would race that single policy — there is no per-call policy context. Audit `persona` is
  similarly single-valued (set from the coordinator's `currentPersona`, per CLAUDE.md).
- The container is shared via `DockerInfrastructure` bundles keyed by `containerScope`
  (`types.ts:214-232`, default `'primary'` `:66`); `ownsInfra` distinguishes standalone
  (owns/destroys) from workflow-borrowed bundles (per CLAUDE.md). The orchestrator attaches
  a control server through `infra.proxy.getPolicySwapTarget()` (`orchestrator.ts:2786`).

### 1.7 Checkpoint/resume assumes a linear history

`WorkflowCheckpoint` (`types.ts:566`) stores `machineState: snapshot.value`
(serialized as a string today), `context`, and a **flat** `transitionHistory:
TransitionRecord[]` of `{from, to, event, ...}` (`types.ts:600`). Resume reconstructs via
`String(checkpoint.machineState)` (`orchestrator.ts:1407`). A parallel snapshot value is a
nested object: it would serialize but resume's `String(...)` coercion and the
single-`currentState` model would not reconstruct it. **A fan-out run is not
representable or resumable under the current checkpoint shape.**

---

## Part 2 — XState parallelism primitives vs our exposure

XState v5 offers three concurrency mechanisms. For each: can our manifest/orchestrator
represent it, and what is the concrete blocker?

| XState primitive | What it does | Exposed by our abstraction? | Concrete blocker |
|---|---|---|---|
| `type: 'parallel'` states / regions | A state with N child regions all active simultaneously; `snapshot.value` becomes `{regionA, regionB}` | **No** | `machine-builder.ts:357-377` emits only flat nodes; `String(snapshot.value)` (`orchestrator.ts:1743`), single `currentState`, single `activeGateId`, flat `transitionHistory`, single checkpoint string all assume one active leaf. Validator/Zod (`validate.ts:96-101`) has no `parallel` kind. |
| Invoked actors (`invoke`) | One child actor per state, awaited via `onDone` | **Yes, but exactly one per state** | Already the substrate for agent/deterministic states. A state could `invoke` a service that *internally* runs N things concurrently **without** the FSM seeing multiple active states — this is the seam the minimal option exploits. No blocker; this is in-bounds. |
| Spawned actors (`spawn`) | Dynamically spawn a variable number of child actors, tracked in context | **No** | Never used; no `ActorRef`-in-context model; `WorkflowContext` has no actor registry; checkpoint can't serialize live actor refs. Would need a bespoke "child run" abstraction (see Option D). |

**Bottom line:** the only XState concurrency primitive we can use *without touching the
single-active-state core* is "one `invoke` that internally fans out." True
`type: 'parallel'` regions and `spawn` both break the orchestrator's
`String(snapshot.value)` / single-`currentState` / single-gate spine.

---

## Part 3 — What parallelism does ASI-Evolve actually need?

Grounded in the vendored engine (`src/workflow/workflows/evolve/scripts/evolve_core/`)
and the AlphaEvolve / MAP-Elites model.

### 3.1 The engine is *built* for parallel workers at the DB layer — and the upstream README says so

- The vendored README documents `pipeline.parallel.num_workers` = "Parallel evolution
  workers (2-4 for production)" (`scripts/README.md:286`). So the upstream engine's
  intended production mode **is** concurrent workers.
- The node DB is cross-process safe and uses **load-mutate-save under an exclusive file
  lock**: `_database_guard` takes `InterProcessFileLock(.database.lock)` and, crucially,
  **reloads from disk inside the lock** (`refresh=True`, `database.py:207-215`,
  reload at `:210-211`) before every mutation, then writes atomically via a temp file +
  `os.replace` (`database.py:147-167`). `InterProcessFileLock` is a real `fcntl.flock`
  (`file_lock.py:32`). So **two worker processes calling `evolve-db sample` / `record`
  concurrently each see the latest committed nodes and can't lose writes** — multi-parent
  `record` and concurrent `sample` are already parallelism-safe.

### 3.2 The cognition store is the one true race (verified)

- `Cognition` has only an **in-process** `RLock` (`cognition.py:30`), **no file lock**,
  a plain non-atomic `json.dump` save (`cognition.py:110-111`), and — the decisive flaw —
  **no reload before save**: each process builds a fresh `Cognition`, loads once at
  construction (`_load`, `cognition.py:114`), mutates in memory, then `_save()` clobbers
  the whole file (`:103-112`). `cmd_cognition_add` (`cli.py:362-389`) builds a fresh
  store (`:365`) and `add_batch`es (`:387`).
- Consequence under N concurrent `evolve-cognition add`: **last-writer-wins; additions
  from all but one process are lost**, and the FAISS sidecar + `round_log` (`cli.py:388`,
  non-atomic append) can corrupt/interleave. This is the *only* engine-level blocker to
  concurrent workers, and it is exactly the surface flagged in
  `docs/designs/evolve-search-quality-slice.md` (Fix 1, cognition promotion).

### 3.3 Which form of parallelism, and how much it helps

| Form | What it is | Engine tolerance | Search-quality / throughput value | What in OUR stack blocks it |
|---|---|---|---|---|
| **(a) intra-round fan-out** | Sample N candidates, evaluate/analyze them concurrently, fan-in and `record` all | DB: **already safe** (file lock + reload-before-save). Cognition: races on the analyze→promote write (3.2) | **High & direct.** AlphaEvolve quality scales with candidates-evaluated-per-unit-time; N concurrent evals is the canonical AlphaEvolve `num_workers` lever. Throughput ~Nx on the eval bottleneck. | Deterministic executor is serial (`orchestrator.ts:2488`); but a *single* helper can fan out internally — FSM never sees concurrency. Cognition write must be serialized at fan-in. |
| **(b) concurrent islands/populations** | Multiple populations evolving in parallel | The `island` sampler is **MAP-Elites within ONE db** (`algorithms/island.py` — islands are `Set[int]` partitions of one node set, `:38`), not separate runs. True separate populations = N databases. | **Medium, and partly already captured** by the island sampler's diversity without process parallelism. Separate DBs add exploration breadth but also N× cost and a merge problem. | Would need N parallel sub-runs (Option D) + a migration/merge bridge. Heaviest. |
| **(c) pipelined stages** | Design round k+1 while evaluating round k | Engine has no notion of pipeline; DB lock would serialize the writes anyway | **Low.** Eval dominates wall-clock; overlapping design (cheap) with eval (expensive) saves little. High coordination complexity for marginal gain. | Single-active-state spine; would need true parallel regions (worst blast radius for least value). |

**Verdict for Part 3:** **form (a), intra-round fan-out, is the high-value target.** The
engine's DB is already built for it; the only engine-level hazard is the cognition store,
which is a bridge-side fix, not an engine change.

---

## Part 4 — Options (minimal → ambitious)

Engine is **byte-verbatim**: prefer bridge / manifest / orchestrator changes; never edit
`evolve_core/`.

### Option A — Fan-out *inside the bridge* (deterministic state stays a single leaf)

A single `deterministic` state (e.g. `evaluate`) invokes `evolve_result.py` with N
candidates; the **Python bridge** spawns N evaluator subprocesses (bounded pool), waits,
and writes one aggregated result file. The FSM sees one state, one `invoke`, one result.

- **Manifest schema:** none, or just a `sample_n`/`fanout` numeric the bridge reads.
  No new state kind.
- **Validator/linter:** none.
- **Orchestrator:** none (the existing serial `reduceDeterministicCommands` runs one
  command that happens to fan out internally).
- **Gate model:** unchanged — still one gate at a time.
- **Container/policy model:** unchanged — all subprocesses run in the one shared
  container under the one active policy; no `cyclePolicy` race because no concurrent
  *agent* states.
- **Checkpointing:** unchanged — single leaf, single `currentState`.
- **Cognition race:** the bridge owns fan-in, so it can serialize the cognition write
  (single-threaded promote after `Promise`/`join`) or wrap it in a bridge-side
  `InterProcessFileLock`. **Fully mitigable without engine change.**
- **Blast radius:** *tiny* — confined to `evolve_result.py` (+ optional manifest scalar).
  Zero changes to the FSM core, gate model, or security model.
- **Engine changes:** none (DB already concurrency-safe; cognition serialized at fan-in).
- **Limitation:** only **deterministic** work fans out. If the per-candidate step needs
  an *agent* (e.g. an LLM "researcher" per candidate), this option can't run those agents
  concurrently — they'd be serialized or pushed into a non-agent helper.

### Option B — A first-class "fan-out worker pool" deterministic primitive

Promote Option A into the abstraction: a new orchestrator capability where a
`deterministic` state declares it runs its `run:` command **once per work-item** with
bounded concurrency, collecting results into the result file. Parallelism stays a **leaf
primitive**; the FSM stays single-active-state.

- **Manifest schema:** new optional field on `DeterministicStateDefinition`, e.g.
  `fanout: { items: <artifact|count>, maxConcurrency: number }`. Revive
  `settings.maxParallelism` (`types.ts:115`) as the cap instead of leaving it dead.
- **Validator/linter:** validate `fanout` only on container deterministic states; a lint
  to require `resultFile` (results must aggregate). Modest.
- **Orchestrator:** `reduceDeterministicCommands` (`:2481`) gains a bounded-concurrency
  variant (`Promise.all` with a semaphore) for fan-out states. Self-contained.
- **Gate model:** unchanged.
- **Container/policy model:** all items run in the same scope/container under one policy;
  still no concurrent *agent* states, so no `cyclePolicy` race. (If items must run under
  different policies, that's Option C territory.)
- **Checkpointing:** unchanged shape — the fan-out completes within a single state
  before the next transition/checkpoint. **Important:** a fan-out is **not resumable
  mid-flight** — a crash re-runs the whole batch on resume (acceptable for idempotent
  evals; document it).
- **Cognition race:** same as A — fan-in is single-threaded in the orchestrator, so the
  promote write is naturally serialized; or bridge-side lock.
- **Blast radius:** *small-to-moderate* — one new schema field, one validator rule, one
  orchestrator concurrency helper. Gate/security/checkpoint core untouched.
- **Engine changes:** none.

### Option C — True XState parallel regions in the manifest

Add a `type: 'parallel'` (or `regions: {...}`) state kind that compiles to an XState
parallel node; N agent/deterministic sub-graphs run concurrently and join.

- **Manifest schema:** new state kind + region sub-graphs. Large.
- **Validator/linter:** new union member; reachability/`when`/gate rules must all
  understand nested values; new lint family. Large.
- **Orchestrator:** the **single-active-state spine must be replaced**:
  `String(snapshot.value)` (`:1743`), `instance.currentState: string`,
  `definition.states[stateValue]` lookups, `transitionHistory` (flat), and
  `isTerminalStateValue` all need a tree-aware model. High risk.
- **Gate model:** **breaks.** `activeGateId` (single, `:1598`), `WorkflowStatus.gate`
  (single), and the `run/await/show/gate` CLI protocol (`daemon-gate-commands.ts:9`) all
  assume one pending gate. Concurrent regions can each reach a gate → need gate IDs,
  multi-gate status, and a gate selector on `gate`/`await`. Major surface change.
- **Container/policy model:** **breaks under shared scope.** Concurrent agent states on
  one bundle race the coordinator's single active policy (`cyclePolicy`/`currentPersona`,
  `:980-1029`). Either force each region onto its own `containerScope` (own bundle, own
  coordinator, own policy) — multiplying containers and cost — or build per-call policy
  context (deep coordinator change). Audit `persona` becomes ambiguous.
- **Checkpointing:** nested `machineState`; resume's `String(...)` coercion and
  single-`currentState` reconstruction must become tree-aware. Large.
- **Cognition race:** now a **genuine multi-process** race (concurrent *agent* states
  each calling `evolve-cognition add`); the bridge-side `InterProcessFileLock` becomes
  mandatory, not optional.
- **Blast radius:** *large* — touches every load-bearing assumption in Part 1.
- **Engine changes:** none directly, but the cognition lock becomes required.

### Option D — Sub-workflow spawning (one orchestrator spawns N child runs)

The orchestrator spawns N **child workflow runs** (each its own container, gate stream,
checkpoint) and aggregates. Maps to "concurrent islands" (form b).

- **Manifest schema:** a "spawn-children" state + an aggregation state.
- **Validator/linter:** new state kind; child-definition reference validation.
- **Orchestrator:** a parent that manages a set of child `WorkflowInstance`s — each child
  is already single-active-state, so the *core* FSM model is untouched; the
  **composition** layer is new. Reuses existing run-dir/checkpoint per child.
- **Gate model:** each child has its own single gate stream; the parent must **fan gates
  out to distinct addressable runs** (children already have distinct `WorkflowId`s, so
  this is more tractable than Option C's intra-machine multi-gate problem). The CLI's
  one-gate-per-run model holds *per child*; a parent-level UX is new.
- **Container/policy model:** each child owns its bundle/coordinator/policy — **no
  cyclePolicy race** (clean isolation, at N× container cost).
- **Checkpointing:** each child checkpoints independently; the parent needs a manifest of
  child run IDs. Resumable per child; parent resume is new work.
- **Cognition race:** if children share one cognition store → same race as C (need the
  lock). If each child has its **own** store → no race, but then a **merge/migration**
  bridge is needed to realize the island benefit (form b).
- **Blast radius:** *moderate-to-large*, but **isolated from the single-run core** — the
  risk is concentrated in a new composition layer, not in retrofitting the FSM spine.
- **Engine changes:** none for isolated stores; a merge bridge if you want cross-island
  migration.

---

## Recommendation

**Ship Option A now; design Option B as the durable shape. Defer C and D.**

Rationale — smallest increment, most evolve value, least disruption to the
gate/security model:

1. **The high-value form is intra-round fan-out (Part 3, form a)**, and the engine's node
   DB is *already* built for concurrent workers (file lock + reload-before-save,
   `database.py:207-215`; upstream `num_workers`, `README.md:286`). The only engine-level
   hazard is the cognition store (`cognition.py:30,103-112`), which is a **bridge-side
   fix**, never an engine edit.
2. **Option A keeps parallelism a leaf primitive**: one deterministic state, one
   `invoke`, one result file. It touches **none** of the load-bearing single-active-state
   assumptions — no `String(snapshot.value)` change, no `activeGateId` change, no
   `cyclePolicy` race, no checkpoint reshape. Blast radius is one Python file. This is the
   "smallest increment that unlocks the most value."
3. **Option B is the right *abstraction-level* destination** if/when fan-out should be
   reusable beyond evolve — it formalizes A with a `fanout` field and revives the dead
   `maxParallelism`, while *still* preserving single-active-state. Do A first to learn the
   cognition-locking and fan-in ergonomics, then lift into B.
4. **Options C and D break or multiply the gate/policy/checkpoint model** (C breaks all
   three in-process; D multiplies containers and needs a parent composition layer) for
   forms of parallelism (true regions / islands) whose marginal search value is lower than
   intra-round fan-out. Not worth it as a first step.

**Concrete first move:** fan out evaluation inside `evolve_result.py` (bounded pool),
serialize the cognition promote at fan-in (or wrap it in a bridge-side
`InterProcessFileLock` mirroring `evolve_core/file_lock.py`), and have the bridge emit one
aggregated result file. **Delete or explicitly revive** the vestigial parallel scaffolding
(`PARALLEL_*`/`MERGE_*` events, `parallelResults`, `worktreeBranches`, `worktree`,
`activeAgents`) so the codebase stops carrying a misleading half-design.

---

## Open questions for the human

1. **Agent-level fan-out?** Option A/B only fans out *deterministic* work. Does evolve
   need N **agents** (e.g. a per-candidate "researcher") running concurrently? If yes,
   that forces Option C or D and the policy-race / multi-gate decisions. If the
   per-candidate step can stay deterministic (the engine's `sample`/`evaluate`/`record`
   are already CLI helpers), A/B suffice.
2. **Cognition concurrency contract:** is serialize-at-fan-in (single writer) sufficient,
   or do you want a real bridge-side `InterProcessFileLock` around `evolve-cognition add`
   regardless? The latter is the prerequisite if you ever go to C/D, and it's cheap.
3. **Fan-out resumability:** is "a crashed batch re-runs from scratch on resume"
   acceptable (evals are idempotent), or do you want per-item checkpointing? The former
   keeps the checkpoint shape untouched; the latter starts pulling toward C/D.
4. **Vestigial scaffolding:** delete the dead `PARALLEL_*`/`MERGE_*`/`worktree`/
   `maxParallelism`/`activeAgents` types now (recommended — they encode a reverted
   design), or keep them as a reserved hook for a future Option C? Carrying them silently
   is the worst of both.
5. **How many workers, and where's the bottleneck?** Upstream suggests 2-4. Confirm the
   eval cost dominates (so fan-out helps) and pick the concurrency cap (revive
   `settings.maxParallelism`).
