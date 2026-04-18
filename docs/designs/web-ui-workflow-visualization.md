# Cinematic Workflow Visualization — v1 Design

## Goal

A workflow-detail view where a **rich ambient tableau** — density-biased token rain, a gently pulsing active node, TF-IDF word drops, and a minimal HUD — holds the camera 98% of the time. State transitions, which in this FSM fire only a handful of times per run (minutes apart), land as **discrete punctuation**: a payload tile carrying real content handed off along the Dagre edge from the outgoing node into the incoming node, followed by a density sweep and a brief arrival scan-line.

The view must be **actively alive even when nothing is transitioning**. That is the forcing function for every design decision below. The existing login-page rain (`packages/web-ui/src/lib/matrix-rain/`) and the shipped token-stream bus (`src/web-ui/token-stream-bridge.ts:285`) do most of the heavy lifting; this design is mostly composition plus one well-placed new abstraction (the stream engine) and a small transition-effects overlay.

---

## A. Architecture

### A.1 Component decomposition

```
packages/web-ui/src/routes/WorkflowDetail.svelte                    (existing — grows a viz mode toggle)
packages/web-ui/src/lib/components/features/
    workflow-theater.svelte          NEW — full-bleed container; owns rAF; composes rain + graph + HUD + FX
    state-machine-graph.svelte       EXISTING — gains reportNodePositions + transition hooks
    state-transition-fx.svelte       NEW — overlay canvas for payload handoff tiles; idle-free
    ambient-hud.svelte               NEW — two-corner telemetry (top-left, top-right)
packages/web-ui/src/lib/matrix-rain/
    engine.ts                        EXISTING — no changes
    renderer.ts                      EXISTING — no changes
    stream-engine.ts                 NEW — live-stream variant (no wordmark; density fields; word drops)
    stream-renderer.ts               NEW — extends drawRainFrame for word drops + density tinting
    density-field.ts                 NEW — pure function: (sources[], cols, rows, sigma) -> Float32Array
    word-drop-types.ts               NEW — WordDrop type shared with stream-engine + renderer
packages/web-ui/src/lib/
    project-svg-to-grid.ts           NEW — named utility; SVG-space -> grid-space projection
    token-stream-store.svelte.ts     NEW — subscribes to session.token_stream, runs word scorer, fans out
    word-scorer.ts                   NEW — port of src/observe/observe-tui-word-scorer.ts (browser copy)
    event-handler.ts                 EXISTING — add session.token_stream case
```

**Dependency rule recap** (per `packages/web-ui/CLAUDE.md`): `ui/` components can't import domain; `features/` can; routes orchestrate. `workflow-theater.svelte` sits in `features/` and receives `workflowId` + resolved token stream data via props. The theater does **not** reach into `stores.svelte.ts` directly — the route wires the subscription and passes the resolved `WorkflowTokenStream` handle down.

**Theater size trigger:** the theater owns rAF coordination, field updates, transition lerps, scorer pumping, and subsystem composition. At the estimated ~250 LOC this is fine as a Svelte-as-glue component with plain callbacks to subsystems. **If during implementation the theater crosses ~400 LOC**, extract the non-Svelte orchestration into a headless `VisualizationDirector` plain-TS class (holds rAF state, density-field updates, transition state machine) and let the component become true glue. Don't pre-extract; cross the bridge when the size forces it.

### A.2 Rain engine reuse: forked interface, shared mechanism

**Recommendation: option (c).** Keep `createRainEngine` untouched for the login page. Add a sibling `createStreamRainEngine(layout, options)` that returns a `StreamRainEngine` with the same `step(nowMs)/getFrame()/resize()` contract, but:

- no `assembly` / `hold` / `wordmark` — phase is always `stream`
- extra API: `enqueueWord(word: string, opts: { priority: number; colorKind: 'tool' | 'text' | 'model' | 'error' })`, `setDensityField(field: Float32Array)`, `setIntensity(multiplier: number)` for token-rate modulation
- reuses `createSeededRng`, `RAIN_CHARS`, `DropSnapshot`, `DropTrailSnapshot`, `DropColorKind` verbatim
- shares `drawRainFrame` via a thin `stream-renderer.ts` that adds word-drop drawing and an alpha-channel density tint

This is "forked interface, shared mechanism." The `FrameState` contract stays the narrow drawing boundary it was designed to be, and the login-page code literally does not change. We pay for this by duplicating ~150 lines of ambient-drop management — worth it. Rejected: forking the whole engine (ages badly, duplicates ~700 lines) and parameterizing `createRainEngine` in place (leaks assembly-FSM concerns into every consumer).

Add a new `DropColorKind` variant `'word-hold'` for paused TF-IDF word drops so the renderer can tint them distinctly without the engine knowing colors.

### A.3 Spatial density biasing — the cinematic lever

This is the most important mechanism in the whole design. Without density biasing the view is just "rain behind a graph"; with it, the rain *points at* whatever the agent is currently doing, and the viewer's eye follows.

Drops in `engine.ts` currently pick columns via `pickAvailableColumn()` — a uniform random draw subject to per-column cooldown (`packages/web-ui/src/lib/matrix-rain/engine.ts:401-409`). Replace this in the stream engine with a weighted picker.

**Density field** (new pure module `density-field.ts`):

```ts
/**
 * Compute a per-column spawn-weight field. Higher weight = denser rain.
 *
 * Each source contributes a 2D Gaussian bump at (centerCol, centerRow) scaled
 * by `amplitude` onto a (cols * rows) scalar field. Collapse to per-column
 * weights by taking the max across rows (not sum -- sum makes every column
 * near the hot source equally hot, which blurs the focus).
 *
 * This module is deliberately node-ID-agnostic. Callers (the theater) resolve
 * their own model (active vs. inactive nodes, transition lerp midpoints, etc.)
 * into amplitudes before calling. Keeps the contract a one-sentence pure
 * geometric computation.
 */
export interface DensitySource {
  readonly centerCol: number;
  readonly centerRow: number;
  /** 1.0 = full, 0.1 = faint trace. Theater picks per source. */
  readonly amplitude: number;
}

export interface DensityInput {
  readonly sources: ReadonlyArray<DensitySource>;
  readonly cols: number;
  readonly rows: number;
  /** Falloff radius in cells. 8-12 looks right at typical cellSize=12. */
  readonly sigma: number;
}

export function computeColumnWeights(input: DensityInput): Float32Array;
```

**Theater** owns the mapping from workflow model to `DensitySource[]`: active node → amplitude 1.0, other nodes → 0.1, and during a transition the theater lerps a synthetic source's `centerCol/centerRow` between outgoing and incoming node centers over 600ms. The density-field module never sees a node ID or a transition event — it just renders whatever points the theater hands it.

Stream engine calls `setDensityField()` when the theater pushes a new field, stores the `Float32Array`, and in `pickAvailableColumn()` does a weighted cumulative-distribution draw instead of uniform. Rebuild the CDF lazily only when the field changes — O(cols) amortized to ~zero.

**Intensity multiplier** — the second half of the cinematic lever. Scale `AMBIENT_TARGET_MAX` and `AMBIENT_SPAWN_PER_TICK` by `intensity`, computed in `token-stream-store.svelte.ts` as a decaying EMA of tokens/second (target: `intensity=1.0` at ~40 tok/s, clamped to [0.3, 2.0]). Idle agent → sparse rain; hot `text_delta` burst → density visibly punches up. Together, density field + intensity EMA are what make the view feel *attached* to the live computation even when the FSM hasn't transitioned in minutes.

### A.4 SVG → grid projection (`projectSvgToGrid`)

Dagre reports node centers in SVG space (pixels relative to the graph viewport). The density field and the transition-FX overlay both think in grid cells (cols × rows at `cellSize` = 12). Don't inline the projection in each consumer — introduce it as a named utility so the contract is stated once:

```ts
// packages/web-ui/src/lib/project-svg-to-grid.ts
export interface GridPoint { readonly col: number; readonly row: number; }
export interface SvgPoint { readonly x: number; readonly y: number; }

/**
 * Project an SVG-space point into grid cells. The theater pixel-matches its
 * canvas to the graph viewport, so this is a pure divide-and-round. Centralized
 * here so density-field, transition-FX, and HUD anchors all agree.
 */
export function projectSvgToGrid(p: SvgPoint, cellSize: number): GridPoint;
```

### A.5 Word scoring: port to browser

The TUI scorer (`src/observe/observe-tui-word-scorer.ts`) is 723 lines of pure TypeScript with zero Node-specific dependencies. It imports only `TokenStreamEvent` from `src/docker/token-stream-types.ts` and a TUI-specific `WordDropSource` type.

**Port, don't move.** Copy it into `packages/web-ui/src/lib/word-scorer.ts`, replace the `WordDropSource` import with a local `type WordDropSource = 'text' | 'tool' | 'model' | 'error'`. Keep the server-side file where it is — the observe CLI still needs it, and the corpus state is inherently per-consumer (two subscribers can't share a live IDF table without coordination we don't need).

**Why not send scored words over the wire?**
1. Corpus is per-consumer: TUI, web UI, and a future "documentary mode" replay tool each want independent IDF state reflecting what *their* user has seen.
2. Dedup window (30s recently-shown, `observe-tui-word-scorer.ts:26`) is a presentation concern, not a signal concern.
3. Adds a server-side scheduler and a new event type for no bandwidth win.

Unit tests for the scorer already exist (grep `observe-tui-word-scorer.test.ts`). Copy them to `packages/web-ui/src/lib/word-scorer.test.ts` — same inputs, same expectations. **Test-parity requirement:** the ported scorer must pass the same golden-input/output cases as the TUI version for the *signal layer* (TF-IDF math, token accumulation, stop-word filtering). Dedup windows and presentation concerns may diverge between TUI and web; the core scoring must not. That's the cheap insurance against silent drift at the 700-LOC scale.

**Two-theater scenarios are per-corpus by design.** If the web UI ever mounts two theaters simultaneously (e.g. list thumbnails + detail view), they maintain independent `WordScorer` state. This is the correct behavior — each viewer has a different window of attention and different dedup timing — not a leak. Do not attempt to share scorer state across theaters.

Budget ~2-3 days for tuning on real agents; browser-rendered word drops need different dedup parameters than the TUI's narrow column.

---

## B. Data flow

### B.1 Token stream subscription

1. `WorkflowDetail.svelte` mounts and calls `subscribeAllTokenStreams()` via a new action in `stores.svelte.ts`. Global, not per-session — a workflow's states spawn multiple sessions sequentially (one per agent), and we don't want to tear down/re-subscribe on every `state_entered`.
2. `event-handler.ts` gains a `session.token_stream` case that calls `tokenStreamStore.publish(label, events)` directly.
3. `token-stream-store.svelte.ts` owns the fanout. It exposes two methods — `publish(label, events)` for the dispatcher and `subscribeToStream(cb: (label, events) => void): () => void` for consumers. No intermediate "bus" store; one module is the only owner of the hot path. `workflow-theater.svelte`'s `$effect` subscribes, runs events through the `WordScorer`, and calls `streamEngine.enqueueWord()` / updates the intensity EMA.

Rationale: the rain engine is not a Svelte store. Pushing word drops into it is inherently imperative. Making the subscription imperative too keeps the data flow honest — and collapsing the dispatcher→bus→store indirection into a single-owner store avoids thrashing Svelte's reactive graph on 50ms batches of 20+ events without adding a layer that isn't pulling its weight.

### B.2 No new JSON-RPC methods

Everything already exists:

- `sessions.subscribeAllTokenStreams` — `src/web-ui/dispatch/token-stream-dispatch.ts:50`
- `session.token_stream` event — `src/web-ui/token-stream-bridge.ts:285`
- `workflow.state_entered` / `agent_started` / `agent_completed` — `src/web-ui/workflow-manager.ts:187`

**One protocol gap worth calling out:** `workflow.agent_started` (`src/workflow/orchestrator.ts:152-157`) does not carry a session label. Two options:

- **Quick fix (recommended):** subscribeAll; the theater accepts *all* token events. We only care about density, not per-session attribution.
- **Proper fix (follow-up):** add `sessionLabel: number` to `workflow.agent_started` / `agent_completed`, update `workflow-manager.ts:210-222`, let the theater filter.

Ship v1 with subscribeAll. The visual result is the same when only one workflow session is active.

### B.3 Mock server baseline

`packages/web-ui/scripts/mock-ws-server.ts` must emit `session.token_stream` and `workflow.*` events when any subscription is active. Default behavior: a realistic-looking scenario with a modest token-rate and a handful of transitions over a few minutes, good enough for casual "does the page render" work. Specific UI-iteration scenarios live in §B.4.

### B.4 Synthetic scenario timelines

Iterating on density sweeps, word-drop cadence, payload tiles, and transition FX against a live daemon is too slow: Docker + Anthropic credits + minutes-long waits per try. We need reproducible, scriptable token streams on demand.

**No capture pipeline.** The visualization responds to event *shape and timing*, not semantic content. "Realistic-feeling" token bursts from a prose corpus are visually indistinguishable from real LLM output for every pixel the UI draws. Capturing real runs would add a daemon recording flag, a redactor, protocol-drift discipline, and PII concerns to solve a problem we don't have. If a specific bug ever needs real data to repro, copy-paste the offending snippet from the TUI `observe` output into a new scenario file — that's capture-by-hand and it's enough.

**Scenario fixtures.** Each scenario is a small JSON file in `packages/web-ui/scripts/scenarios/` describing a timeline:

```jsonc
// scenarios/rapid-transitions.json
{
  "description": "Transitions every 20s. For iterating on payload tiles and density sweeps.",
  "tokenProfile": {
    "corpus": "default",            // packages/web-ui/scripts/fixtures/mock-stream-corpus.txt
    "baseTokenRate": 35,            // tokens per second
    "burstiness": 0.6,              // 0 = smooth, 1 = extreme bursts
    "toolCallRatePerMin": 4
  },
  "timeline": [
    { "at": 0,     "event": "workflow.started",         "payload": { /* ... */ } },
    { "at": 500,   "event": "workflow.state_entered",   "payload": { "state": "analyze" } },
    { "at": 800,   "event": "workflow.agent_started",   "payload": { "state": "analyze" } },
    { "at": 20000, "event": "workflow.agent_completed", "payload": { "verdict": "reanalyze", "notes": "hypothesis: off-by-one in bounds check at parse.c:412" } },
    { "at": 20200, "event": "workflow.state_entered",   "payload": { "state": "discover" } },
    { "at": 20500, "event": "workflow.agent_started",   "payload": { "state": "discover" } },
    { "at": 40000, "event": "workflow.agent_completed", "payload": { "verdict": "harness_design", "notes": "confirmed via differential test across versions 2.1 and 2.2" } }
  ]
}
```

The mock server reads the file, schedules each `timeline` entry with `setTimeout` against wall-clock deltas (adjusted by `?speed=`), and **fills the gaps with synthetic `session.token_stream` events** generated from `tokenProfile` — sampling chunks from the corpus, honoring `baseTokenRate` + `burstiness` + `toolCallRatePerMin`, batching into 50ms `TokenStreamEvent[]` to match `TokenStreamBridge`'s real cadence (`src/web-ui/token-stream-bridge.ts:285`).

The generator is ~150 LOC in `packages/web-ui/scripts/scenario-runner.ts`: a corpus sampler, a Poisson-ish burst scheduler, and a fixed timeline driver. No runtime dependencies.

**Scenarios to ship in v1.**

- `default` — the baseline from §B.3; a few transitions over 3 minutes, moderate token rate
- `no-transitions` — 5 minutes in one state, steady 40 tok/s. **Checks AC1.**
- `rapid-transitions` — transitions every 20s. For iterating on payload tiles, density sweeps, dormant-edge re-brightening
- `long-state` — 10 minutes in one state with occasional tool-call bursts. Stress-tests word-drop backpressure (§G Q6) and the intensity EMA
- `error` — a short run ending in `workflow.state_failed`. Deferred payload for v1.1's glitch FX, but the fixture lands in v1 so it's ready

Fixtures are checked into the repo at `packages/web-ui/scripts/scenarios/*.json`. Hand-written by an engineer in ~10 minutes each; edited when visuals need a new edge case.

**CLI / URL surface.**

- `npm run mock-ws-server -- --scenario rapid-transitions` picks the scenario at server start; the server defaults to `default` with no flag.
- Query params override at connection time: `?scenario=rapid-transitions` selects the file; `?speed=4` plays at 4×; `?speed=0.25` frame-steps for slow-mo transition FX debugging; `?loop=true` restarts at timeline end so a developer can leave the page open.
- Query-param selection mirrors the existing `?scenario=no-transitions` hook mentioned in earlier drafts — same shape, just generalized.

**v1 scope.**

- Must-have: scenario file format, five scenarios above, `--scenario` flag + `?scenario=`/`?speed=`/`?loop=` query params, corpus sampler, burst scheduler.
- Yes: `daemon.status` heartbeats woven into every scenario so the HUD `●/○` glyph stays alive.
- Deferred: authoring UI (a form in the mock page that lets a developer tweak `baseTokenRate` live). Nice to have, not needed; edit the JSON.

**Acceptance (for the replay itself).**

- AC-R1: `--scenario rapid-transitions` at `?speed=1` plays transitions at precisely the timestamps declared in the timeline, with synthetic token chunks filling the gaps at roughly the declared rate. No drift over a 5-minute run.
- AC-R2: `--scenario no-transitions` exercises AC1 without Docker or Anthropic credits. Playable in any browser attached to the mock server.
- AC-R3: `?speed=0.25` frame-steps transition FX well enough to debug payload-tile easing curves.

**Scope estimate.** ~1 day. Half a day for the scenario runner (corpus sampler + burst scheduler + timeline driver), half a day for the five fixture files and the query-param wiring. If authoring new scenarios ever becomes a bottleneck, a small in-page editor is a few more hours — defer.

---

## C. Workflow FSM rendering

### C.1 Where Dagre lives

Already integrated at `packages/web-ui/src/lib/components/features/state-machine-graph.svelte:3` (`import dagre from '@dagrejs/dagre'`). `computeLayout()` at line 69 produces node centers and edge waypoints. The graph ships `StateGraphDto` via `getWorkflowDetail()` — frontend does **not** reconstruct from message log. Good.

### C.2 Reuse vs. replace

Don't fork `state-machine-graph.svelte`. Extend it with two additive props:

```ts
interface Props {
  // ... existing ...
  /** Fired after each layout pass with current node centers in SVG space.
   *  Consumer projects via projectSvgToGrid() for the density field. */
  onnodepositions?: (positions: Map<string, SvgPoint>) => void;
  /** Fired on agent_started / agent_completed — NOT on every state_entered.
   *  See §D and §G Q5 for rationale. Payload carries from/to node ids,
   *  their SVG positions, and a handoff label. */
  ontransition?: (t: TransitionEvent) => void;
}

interface TransitionEvent {
  readonly from: string;
  readonly to: string;
  readonly fromPos: SvgPoint;
  readonly toPos: SvgPoint;
  /** Short human-readable handoff text rendered on the payload tile. */
  readonly handoffLabel: string;
}
```

The graph remains the authoritative source of node geometry.

### C.3 Node rendering — HTML over SVG

Keep SVG for edges (curved paths from Dagre, trivially stylable). Switch node rendering from SVG `<rect>`+`<text>` to `<foreignObject>` wrapping an HTML `<div>` per node. Reasons:

- Drop-shadow / backdrop-filter on HTML is cheap and GPU-accelerated; SVG filters are not.
- We want node content (title, visit count, verdict badge) to be crisp terminal-style typography with monospace numerics. Easier in CSS.
- The active-state pulse is a CSS `@keyframes` on the HTML node — 60fps free.

### C.4 Edge visual language: dormant by default

**This is a framing correction.** Edges in this FSM fire maybe 3-5 times across a 10-minute workflow. A "circuit board with current flowing through it" framing would be an active lie — the viewer would expect constant traffic and see almost none.

Edges default to **dormant**: 1px dashed, stroke at 20% `--accent-cyan`, no glow, no animation. They communicate "path exists, not currently in use." They brighten (to 80% solid, 1.5px, with a short trailing glow) only while a payload-handoff tile is traversing them, and fade back to dormant over 400ms after arrival.

### C.5 Active vs. completed vs. failed nodes

Already tracked: `currentState`, `completedStates`, `failedState`, `visitCounts` (see `WorkflowDetail.svelte:93-99`). Visual language:

- **Active**: 2px border in `--accent-cyan`, outer `box-shadow: 0 0 24px` pulse, interior alpha scan-line overlay. The pulse is what keeps the view alive while a state runs for minutes — it must be visible but not fidgety (1.8s sine cycle, 0.4-1.0 opacity on the glow).
- **Completed**: 1px border, dimmed to 40% opacity, tiny check glyph top-right.
- **Failed**: 2px border in crimson, constant glow, no pulse (dead things don't breathe).
- **Unvisited**: 1px dashed border, 20% opacity.

---

## D. State transitions — discrete punctuation

Between firings, edges are dormant and nothing about the graph is moving. When a transition fires (see §D.1 for the trigger), the theater gets about a second of punctuation — carefully timed so it registers without disrupting the ambient tableau the viewer is already watching.

The transition FX subsystem is cheap: the overlay canvas is mounted only while `now < lastTransitionAt + 1000ms`. Zero cost when idle. Total budget: ~120 LOC (not 250) — smaller than a generic particle-travel system because the FX are semantically earned rather than procedurally elaborate.

### D.1 Trigger: `agent_started` / `agent_completed`, not `state_entered`

`state_entered` fires for every FSM step including guard checks and decision nodes that never produce a payload. Using it as the transition-FX trigger would make the punctuation fire for nothing — the exact opposite of what we want.

**Decision (resolves §G Q5):** The transition-FX trigger is `workflow.agent_completed` for the outgoing half (the node that just finished hands off) paired with the subsequent `agent_started` for the incoming node. Guard/decision `state_entered` events update node highlighting but do **not** fire the payload-handoff effect. This keeps punctuation meaningful: FX happen only when real work completed and real content is moving between agents.

### D.2 Payload handoff — the one concrete moment

On `agent_completed` for the outgoing state, the theater constructs a small tile:

- ~180×44px rounded rectangle, monospace text, `--accent-cyan` border at 80%, phosphor glow
- Tile content is the outgoing agent's **`notes` string** from the agent_status YAML block (`src/workflow/status-parser.ts:28`) — the free-form context field every agent writes on completion. Truncate to ~80 chars with ellipsis on the tile; full `notes` text surfaces on hover. This is real content moving, not a generic dot.
- Tile lerps along the Dagre edge path from `fromPos` to `toPos` over 600ms with an ease-out cubic curve
- On arrival the tile scales to zero into the incoming node's header (200ms), and the truncated `notes` briefly appears as a flash-badge in that header before settling into the node's normal metadata display

Because the tile *is* the payload, there's nothing left to animate after arrival — no radial particle burst, no trail of ghost copies. One tile, one path, one absorption. The handoff reads as a meaningful event because the viewer sees what actually got handed off.

### D.3 Density sweep follows the payload

The density field smoothly interpolates from the outgoing node's center to the incoming node's center over the same 600ms as the payload tile. The rain appears to "follow" the payload to its destination. Linear tween of the center coord; sigma holds constant. Essentially free — we'd recompute the field on every transition anyway.

### D.4 Arrival scan-line

When the tile lands, the receiving node gets a one-shot 200ms horizontal scan-line sweep (CSS `@keyframes` on a `::before` pseudo-element with `background-image: linear-gradient(90deg, transparent, var(--accent-cyan), transparent)`). Quick, crisp, no lingering.

### D.5 Cut / deferred

- **Cut outright:** screen shake (nauseating), particle trails on edges during idle (actively misleading given dormant-edge framing), node entrance animations (confusing on resume-from-checkpoint — see §G Q8), generic cyan packet-dot FX (replaced by payload tile).
- **Deferred to v1.1:** chromatic aberration on `critical` nodes (nice polish, not needed for shape-of-thing), error-glitch burst on `workflow.failed` (needs careful dosing; failure is rare enough that we can afford to get it right later).

### D.6 Performance discipline

All transition FX live in a third stacked canvas (`state-transition-fx.svelte`, overlay above the graph SVG, below the HUD). The theater owns the single `requestAnimationFrame` loop (see §G.3 resolution below) and fans out `step(nowMs)` to the rain engine and the transition-FX module. This is the single most important perf guardrail: token streaming at 40 tok/s through Svelte's reactivity system would otherwise dominate the frame budget; keeping the hot path in plain canvas draws inside one rAF handler avoids any per-token reactivity.

**Error isolation:** each subsystem's `step(nowMs)` call is wrapped in a try/catch at the theater. On a thrown error, log once via `console.warn`, skip that subsystem for the remainder of the frame, and continue driving the rest. A corrupt frame in the transition-FX module must not take down the rain; a bug in the stream engine must not freeze the HUD. Errors are a dev-time concern — no user-facing degraded state needed in v1.

**rAF ownership (resolves §G.3):** The theater owns the loop, unambiguously. Both the stream engine and the transition-FX module expose `step(nowMs)` and are driven from a single `requestAnimationFrame` callback in `workflow-theater.svelte`. Tab-visibility changes pause/resume the theater's loop, which coherently halts all subsystems. This deliberately breaks the "engine is self-driven" pattern from `matrix-rain.svelte`; that pattern made sense for the standalone login page but is the wrong shape when multiple canvases share a frame budget.

---

## E. Sci-fi details worth shipping

Ordered by importance to the ambient-first vision:

1. **TF-IDF word drops are the hero ambient detail.** Port the TUI's `WordDrop` metaphor exactly: picked words held stationary for ~2.5 seconds at their drop position, color-tinted by source (green/text, cyan/tool, amber/model, red/error), with a 30% alpha fade-in and hard fade-out. These are what make the rain feel like it's *about* something even when the FSM has been on the same state for five minutes.
2. **Active-node pulse + density field + intensity EMA** — the three mechanisms that together carry the view between transitions. Already covered in §A.3 and §C.5; calling them out here because they are the true headliners, not the transitions.
3. **Ambient HUD — two corners in v1.** Top-left: workflow name + round `3/20` + connection indicator glyph (`●`/`○`, amber if reconnecting). Top-right: tokens/sec live (same EMA used for rain intensity) + active model name (`shortenModelName` from the scorer). Monospace, 11px, 70% opacity, 1px solid `--accent-cyan` at 20%, no drop shadows. Two corners, not four — on narrow viewports (<900px) the bottom corners collided with the graph (see §G.2 in prior draft); bottom-left/bottom-right panels move to v1.1.
4. **Subtle CRT scan-lines.** Full-bleed CSS `::after` layer with `repeating-linear-gradient(0deg, transparent 0, transparent 2px, rgba(0,0,0,0.15) 3px)`. 2px tall stripes at 15% opacity, 1px/sec vertical drift. Free, unifies canvas + HTML + SVG layers visually.
5. **Phosphor bloom on the wordmark.** Already in place at `matrix-rain.svelte:247-249` via `drop-shadow`. Reuse on active-node labels and the payload tile.
6. **Terminal cursor on the currently-streaming text.** A blinking `▊` glyph at the latest `text_delta`'s grid cell for 200ms after each batch. Tiny, sells "live."
7. **Sigil watermark.** Small 40×40 SVG of an IronCurtain mark bottom-center at 8% opacity. Free branding.

Skip: hex-dump panels, fake binary counters, real-time audio-reactive effects, screen-wide error glitches (v1.1 if at all), audio layer (documentary-friendly, daily-driver-hostile).

---

## F. Scope

### F.1 Acceptance criteria

**AC1 (forcing function for ambient-first design):** On a workflow with **zero transitions in its first 3 minutes**, the view must still look actively alive — density field tracks the active node, rain intensity responds to the token stream EMA, word drops appear at a visible cadence, the active-node pulse is clearly breathing, CRT scan-lines drift, HUD tokens/sec is updating. A viewer glancing at the screen should not wonder whether the system is frozen.

**AC2:** When a transition fires, the payload-handoff tile carries the outgoing agent's `notes` string (truncated to ~80 chars; see §G Q5) along the Dagre edge and is absorbed into the incoming node, with the density sweep and arrival scan-line completing within 1s total.

**AC3:** Edges not currently carrying a payload render as dormant (dashed, 20% opacity). At no point during ambient operation does any edge glow, pulse, or animate.

**AC4:** At tab-visibility = hidden, the theater's rAF loop halts; resume within one frame of visibility returning.

**AC5:** At 40 tok/s sustained for 10 minutes, no frame budget overruns in Chrome perf trace; word-drop concurrent-count stays under the cap (see §G Q10).

### F.2 v1 (ships)

- `workflow-theater.svelte` with two-canvas rain (stream engine + renderer) + extended state-machine-graph + one-canvas transition-FX overlay.
- Density field, intensity EMA, word drops, `session.token_stream` subscription via store.
- Dormant edges, active-node pulse, payload-handoff tile, density sweep, node-arrival scan-line.
- Two-corner ambient HUD (top-left, top-right).
- CRT scan-lines + existing phosphor bloom reused on nodes and payload tile.
- Mock server emits realistic token streams tied to workflow transitions, including `?scenario=no-transitions` for AC1.
- Theme: iron only (dark). Daylight theme gets a "visualization requires dark theme" message.
- **Protocol: add `notes: string` to the `workflow.agent_completed` wire payload** (emit site: `src/web-ui/workflow-manager.ts:187`; source field: `AgentStatusSchema.notes` in `src/workflow/status-parser.ts:28`). The payload-handoff tile's content (§D.2) and AC2 depend on this; without it, the hero transition moment cannot be verified. Trivial string-field addition; must land with the v1 frontend work.

### F.3 v1.1 (follow-ups)

- Four-corner HUD (bottom-left transition history, bottom-right cost / token budget) with responsive breakpoint.
- Chromatic aberration on `critical` nodes + error-glitch burst on `workflow.failed`.
- `sessionLabel` added to `workflow.agent_started` so multi-workflow dashboards can attribute streams.
- Audio layer (gated).
- Replay mode: feed a recorded transcript through the same pipeline for post-hoc docs.

### F.4 Explicitly out of scope

- Editing the login-page `matrix-rain.svelte`. Zero-touch.
- Per-user customizable palettes. Ship the opinionated look.
- 3D / WebGL anything. The whole design is Canvas 2D + SVG + CSS.

### F.5 Estimated size

~1070 LOC net added (stream engine 300, renderer 150, density field 80, `projectSvgToGrid` 20, word scorer port 700 — mostly shared with existing tests, word drop management 150, theater 250, two-corner HUD 120, transition FX 120, mock-server extensions 200, event-handler + store glue 100). **Three weeks for one engineer** — bumped from two because scorer port tuning on real agents and payload-label UX iteration consume more time than a pure mechanical build would.

---

## G. Open questions

1. **Per-session coloring?** If multiple sessions stream concurrently (future: workflow spawns parallel agents), do we tint their word drops per session, or unify? Current design: unified. Decide before parallel agents ship.
2. **Word drop hold duration vs. scroll rate.** TUI uses 2.5s hold. On a larger web viewport, should it be longer (3.5s) so words register before fading? Needs real-agent data; ship at 2.5s and tune.
3. **Theme fallback.** Daylight theme is legitimately used for debugging. Do we build a muted light-mode variant, or lock to iron/midnight? Lean toward locking — documentary mode is opinionated.
4. **Resume-from-checkpoint replay policy.** *(Resolved.)* Snap silently to the current active state on load. The default must not lie about timing; we do not want to make stale events look fresh. No replay-at-speed mode in v1 or v1.1 unless requested later.
5. **Payload-handoff content source.** *(Resolved.)* Use the **`notes` field** from the agent_status YAML block (`src/workflow/status-parser.ts:28`, `AgentStatusSchema`). Every workflow agent already emits `{ verdict, notes }` as a mandatory status block on completion — `verdict` is the routing label ("completed", "approved"), `notes` is the free-form context string describing what actually happened. That's the handoff payload. Surface `notes` on `workflow.agent_completed` (currently only `verdict` is on the wire — confirm by auditing `workflow-manager.ts` emit sites; if `notes` isn't there, add it; it's a string field and a trivial protocol extension). Truncate to ~80 chars with ellipsis on the tile; full text available on hover / in a detail panel.
6. **Word-drop backpressure.** *(Resolved.)* At 40 tok/s for 10 minutes the scorer could see ~24,000 tokens. Held word drops need explicit eviction — neither TUI nor web gets "natural wipe" for free, both manage held state in code. Spec: a **FIFO cap of 24 concurrent held word drops**; when a new drop arrives at the cap, evict the oldest. On `workflow.state_completed` or `state_failed`, wipe all held word drops over a 400ms coordinated fade so the next state starts with a clean ambient surface. Enforce cap in the stream engine, not the scorer — the scorer stays presentation-agnostic.

---

Design doc written to: `/Users/provos/src/ironcurtain-persona-memory/docs/designs/web-ui-workflow-visualization.md`
