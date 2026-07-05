# Web-UI PTY Terminal — Vetted Implementation Design

_Status: design, ready for implementation. Synthesized and judged from two competing
design passes (max-reuse "A" and clean-shared-core "B") and two adversarial reviews
(plumbing-reality + lifecycle/race/security). This document is the authoritative spec;
where it differs from A or B the ruling here wins._

## 0. Problem & decision

The web-UI "Sessions" view renders Docker-Agent-Mode sessions as a turn-based chatbox that
reconstructs each turn from structured events. It is a strictly worse view of the same agent
than `ironcurtain mux`, so it goes unused. **We replace it, for Docker Agent Mode only, with a
live xterm.js terminal that streams Claude Code's real in-container TUI over the WebSocket —
mux parity in the browser — while keeping the existing structured escalation overlay
(Escalations view + approve/deny) on top.**

Locked product decisions:

- The terminal is the **only** view for a Docker session (chatbox removed for that mode); the
  structured escalation overlay stays.
- **Desktop-only** for now — no mobile/touch design effort.
- Target is **Docker Agent Mode** (Claude Code in a `--network=none` container). Code Mode (the
  builtin V8 agent) has no TTY and is untouched — it keeps the chatbox. The daemon's
  `SessionMode` is process-global, so there is no per-session mixing: a docker-mode daemon shows
  terminals, a builtin-mode daemon shows the chatbox.
- The turn-based `Transport` stays intact for **Signal (text-only), cron, and headless**. This
  adds a PTY session kind; it does not swap the transport.

**Chosen approach: Design B's clean-shared-core spine**, because both reviews confirmed it is
lower-risk on layering (no `web-ui → mux` edge) and lifecycle (explicit orphan handling), and it
stays within one streaming idiom. Design A's binary-frame efficiency win is real but negligible
on a single-operator localhost TUI, and it costs a hot-path message-loop insertion; binary is
recorded as a clean future upgrade, not the v1.

The judge overrides both designers on **session lifecycle / orphan reaping** (§6) and adds two
**mandatory pre-implementation gates** (§7).

## 1. The load-bearing discovery (verified)

Both design passes independently converged on — and the plumbing review CONFIRMED against source
— the key fact that reframes the whole problem:

> **mux does not attach to the container PTY via `attachPty`.** It spawns a child
> `ironcurtain start --pty` process wrapped in `PtyBridge` (`src/mux/pty-bridge.ts:150`,
> node-pty + `@xterm/headless`). `attachPty`'s `process.stdin/stdout` + raw-mode coupling
> (`src/docker/pty-session.ts:840-1017`) runs **inside that child**, one level below where mux
> attaches. `mux-app.ts` is a terminal-kit renderer + escalation manager wrapped around N bridges.

So the genuinely-shared primitive the web needs is **`PtyBridge`, not `attachPty`**. The web
reuses the entire container / MITM / socat / snapshot / resume / capture path *for free* by
spawning the same CLI child. `attachPty` is never touched.

Confirmed reuse points (plumbing review, 9/9 core claims verified):

| Need | Symbol | Location | Status |
|---|---|---|---|
| Spawn interactive PTY session, node-pty wrap, headless buffer, registration discovery, write/resize/kill | `createPtyBridge` | `pty-bridge.ts:150` | reuse + 2 additive methods |
| Child argv (`start --pty --agent … --persona … --capture-traces`) | `buildSpawnArgs` | `pty-bridge.ts:118` | as-is |
| Container + MITM + socat + snapshot + resume + capture | child `ironcurtain start --pty` | `pty-session.ts` `runPtySession` | as-is |
| Host-TTY pipe (NOT touched) | `attachPty` | `pty-session.ts:840` | untouched |
| Escalation dir watch + resolve-by-response-file | `createEscalationWatcher` / `.resolve` | `escalation-watcher.ts:60,131` | as-is (same leaf mux uses at `mux-escalation-manager.ts:134`) |
| PTY registration (sessionId + escalationDir) | registry file | `pty-session.ts:1207-1219` → `~/.ironcurtain/pty-registry/session-<id>.json` | as-is |
| Container resize all the way down | `bridge.resize` → SIGWINCH → `attachPty` `stdout.on('resize')` → `resize-pty.sh` | `pty-bridge.ts:238`, `pty-session.ts:973,927` | as-is |
| Container teardown + resume snapshot on kill | `runPtySession` finally | `pty-session.ts:734` | as-is (SIGTERM via `bridge.kill()`) |
| Per-session targeted WS streaming + subscribe + `removeAllForClient` | `sendToSubscribers`, token-stream pattern | `web-ui-server.ts:241`, `token-stream-dispatch.ts` | pattern reused |
| Shared label space (distinct kind) | `reserveLabel()` | `session-manager.ts:119` | as-is (same as workflow-agent labels) |
| Escalation event + DTO consumed by UI | `escalation.created`, `EscalationDto` | `web-event-bus.ts:42`, `web-ui-types.ts` | as-is → zero escalation-UI change |
| Daemon-global mode branch | `ctx.mode.kind` | `ironcurtain-daemon.ts:93,147`, `web-ui-server.ts:109` | as-is |

**Two verified gaps** (both designs, not previously present):
1. `@xterm/addon-serialize` is **not** in `package.json` — it is a required new root dependency
   (pairs with the existing `@xterm/headless@^6`). Gated by §7.1.
2. The current WS message loop treats every inbound frame as JSON text
   (`web-ui-server.ts:486` → `wsDataToString`). Design A's binary lane would need a branch
   *before* that conversion. We avoid this entirely by choosing base64 (Fork 2).

## 2. Architecture

```
                     ┌───────────────────────── src/pty/ (LEAF) ─────────────────────────┐
                     │  createPtyBridge():                                                │
                     │    node-pty(child `ironcurtain start --pty`) ──► @xterm/headless   │
                     │    write · resize · kill · onOutput · onData(NEW) · serialize(NEW)  │
                     │    onExit · onSessionDiscovered (sessionId, escalationDir)          │
                     └───────────────┬───────────────────────────────┬───────────────────┘
        GRID sink                    │                                │      STREAM sink
   src/mux/mux-app.ts (unchanged     │                                │   src/web-ui/pty-session-manager.ts
   except import path)               │                                │   - onData(chunk) → base64 → WS EventFrame
   - onOutput() → terminal-kit       │                                │   - serialize() → replay on attach
   - resize from process.stdout      │                                │   - resize from browser xterm cols/rows
   - MuxEscalationManager watches dir │                               │   - EscalationWatcher watches dir
                                                                      │     → WebEventBus.escalation.created
```

Neither `mux/` nor `web-ui/` imports the other; both import the `pty/` leaf. Live output path:
`container PTY → socat → child stdout → node-pty master → PtyBridge child.onData →
terminal.write() [scrollback] → (in the write callback) onOutput [mux] + onData [web] →
PtySessionManager → sendToSubscribers('session.pty_output', {label, data:b64}) → ws →
browser xterm.write()`.

## 3. The shared core: `PtyBridge` relocated + two additive methods

Move `src/mux/pty-bridge.ts` → `src/pty/pty-bridge.ts` (leaf: it imports only `node-pty`,
`@xterm/headless`, `config/paths`, `escalation/session-registry`, `docker/pty-types` — no
mux code, confirmed). Fix the 3 import sites (`mux-app.ts:10`, `mux/types.ts:5`,
`test/pty-bridge.test.ts:10`). **Land this as its own pure-move commit** so `git bisect` cleanly
separates "move" from "behavior".

Then add two methods:

```ts
// STREAM sink: raw incremental chunk, emitted AFTER the headless terminal.write()
// callback so the chunk is already reflected in serialize(). Returns unsubscribe. Mux ignores it.
onData(callback: (chunk: string) => void): () => void;

// Full screen + scrollback snapshot for reconnect replay (via @xterm/addon-serialize).
serialize(): string;
```

The one behavioral wiring change, at the existing `child.onData` handler (`pty-bridge.ts:185`):

```ts
child.onData((data) => {
  terminal.write(data, () => {
    for (const cb of outputCallbacks) cb();   // grid sink (mux) — order/semantics UNCHANGED
    for (const cb of dataCallbacks) cb(data); // NEW stream sink — fires AFTER buffer updated
  });
});
```

**Core ordering invariant (load-bearing for reconnect safety, §Fork 4):** `onData` fires *inside*
the `terminal.write` completion callback, i.e. after the headless buffer already reflects `data`.
Therefore any chunk a subscriber receives is already captured by a `serialize()` taken before the
subscription — no gap, no double-render. Also **add a `scrollback` cap** (e.g. `5000`) to the
`Terminal` construction (`pty-bridge.ts:153`) so long-running sessions don't grow the headless
buffer unbounded; this benefits mux too.

## 4. Fork rulings (final)

**Fork 1 — shared-core boundary → B.** Core = `PtyBridge` relocated to `src/pty/`; `attachPty`
untouched. Refactoring `attachPty` into a sink-agnostic pipe would touch the most delicate part of
the terminal path (raw-mode enter/exit, deferred-first-data, resize-verify, Ctrl-\ emergency exit,
`pty-session.ts:907-1013`) to serve a consumer that doesn't attach there — risk with zero reuse
payoff. Rejected.

**Fork 2 — WS framing → B (base64 over EventFrame) for v1.** Server→client:
`session.pty_output {label, data:b64}` and one-shot `session.pty_replay {label, snapshot:b64}`,
via `sendToSubscribers` to *subscribed* clients only. Client→server RPC:
`sessions.ptyAttach|ptyDetach|ptyInput|ptyResize`. Rationale: rides the already-authed `/ws`; the
monotonic `EventFrame.seq` guarantees in-order delivery; stays within the proven token-stream idiom
(no message-loop insertion). base64's ~33% inflation over localhost is irrelevant for a few-KB TUI
repaint. **The decisive win is not the encoding — it is the robustness pair below, adopted
regardless of framing:**
- **Coalescing:** flush accumulated `onData` on a ~16ms timer or at 32KB, whichever first.
- **Backpressure with auto-resync:** if a client's `ws.bufferedAmount` exceeds a threshold, stop
  sending deltas and mark it desynced; when it drains, send a fresh `serialize()` snapshot. (This
  beats A's "drop frames, user must manually reconnect.")

_Binary frames are the clean future upgrade if profiling ever shows the base64/JSON encode is a
real cost, or if we stream non-TUI high-bandwidth data. Not v1._

**Fork 3 — daemon PTY manager → B.** New `src/web-ui/pty-session-manager.ts`: `PtySessionManager`
owns `Map<number, PtyWebSession>`, each holding one `PtyBridge` + one `EscalationWatcher` + a
`Set<WsWebSocket>` of subscribers. It is a **distinct session kind**, never a `ManagedSession`
(which requires a `Session`+`Transport` a PTY has neither of — shoehorning would force a fake
`sendMessage`-throws adapter and put regression risk on the class shared by Signal/cron/turn-based
web). It borrows labels via `sessionManager.reserveLabel()` only. Composition is in dispatch:
`sessions.create` branches on `ctx.mode.kind` (`docker` → `ptySessionManager.create`, `code` →
existing turn-based path); `sessions.list`/`sessions.end` merge/route by a new
`SessionSource.kind === 'web-pty'` discriminant; `sessions.pty*` delegate to a new
`pty-dispatch.ts` (mirroring token-stream delegation).

**Fork 4 — reconnect / scrollback → B, gated by §7.1.** `ptyAttach(label, client)` runs
synchronously: (1) `serialize()` the bridge's headless buffer, (2) send `session.pty_replay` to
*that one* client, (3) add client to `subscribers`. The manager keeps a single per-session
`bridge.onData` fan-out to the whole subscriber set. The §3 ordering invariant closes the
serialize/subscribe race; late joiners each get their own fresh replay at one subscription cost.

**Fork 5 — escalation overlay → B, plus a race fix.** Once `bridge.onSessionDiscovered` yields
`escalationDir`, `PtyWebSession` starts `createEscalationWatcher(escalationDir, …)` and re-emits
`escalation.created` / `escalation.expired` (with `sessionSource:{kind:'web-pty'}`,
`sessionLabel = this.label`) onto `WebEventBus`. `escalations.resolve` tries the PTY manager first
(`watcher.resolve` writes `response-<id>.json`), else the turn-based path; `escalations.list`
merges both pending sets. **`PtySessionManager.resolveEscalation` MUST, on success, drop the entry
from its pending map AND `eventBus.emit('escalation.resolved', {escalationId, decision})`** — the UI
clears the pending card on `escalation.resolved` (`event-handler.ts:393`), mirroring the turn-based
emitter (`web-session-transport.ts:113`). Without this the card never clears after approve/deny.
The MITM writes escalation files regardless of transport, so the entire existing Escalations UI
works unchanged. **Race fix (from lifecycle review):**
`createEscalationWatcher` currently first-polls only after one `setInterval` tick (~300ms), so a
`request-*.json` written in that window before the watcher's first poll can be missed → agent
hangs waiting for an approval the operator never sees. Make the watcher **poll immediately on
`start()`**, and add a unit test that writes `request-*.json` *before* `start()` and asserts
`onEscalation` fires. (Benefits mux too.)

**Fork 6 — resize → B.** `@xterm/addon-fit` computes cols/rows → `sessions.ptyResize` →
`bridge.resize` → node-pty SIGWINCH → child `attachPty` → `resize-pty.sh`. Identical chain to mux;
the web is just a different resize source. Multiple browsers on one PTY share one winsize
(shared-tmux semantics): **last-writer-wins**, documented; a "primary driver" designation is a
follow-up. Add a small UI note that resizing a shared PTY affects all viewers.

**Fork 7 — frontend → B.** New presentational
`packages/web-ui/src/lib/components/features/terminal-console.svelte` wrapping xterm.js + FitAddon.
It respects the features/ layering rule (**no `stores.svelte.ts` import** — props/callbacks only):
exports imperative `write(chunk)` / `reset(snapshot)` / `fit()` handles and emits
`oninput(dataB64)` / `onresize(cols,rows)`. Imperative (not a reactive `chunks` prop) because
xterm must apply *every discrete chunk in order* — a `$state` "latest chunk" would drop bursts.
The `Sessions` route owns data: on selecting a `web-pty` session it calls store action
`attachPty(label)` and routes `session.pty_replay`/`session.pty_output` to the bound component via
`reset`/`write`; keystrokes → `sendPtyInput`; resize → `sendPtyResize`. Event routing lives in the
pure `event-handler.ts` (new `session.pty_*` cases → per-label callback registry the route
installs), keeping it DOM/Svelte-free and unit-testable. Render branch:
`{#if selectedSession.source.kind === 'web-pty'} <TerminalConsole/> {:else} <SessionConsole/> {/if}`.

**Input, focus & mouse handling (mux parity).** The terminal is the sole input surface for a PTY
session; it must forward keystrokes but consciously mirror mux's mouse stance (mux does NOT forward
mouse to the container — `mux-app.ts:611-670`).
- **Keyboard.** The browser xterm captures keys only when focused. The route `.focus()`es the
  terminal on select/attach and **refocuses it when the escalation overlay closes** (the overlay
  steals focus). `term.onData(b => oninput(b64(b)))` forwards every keystroke — control chars,
  arrows, function keys, bracketed paste — to `sessions.ptyInput` → `bridge.write()` → child stdin.
  **`onData` alone is sufficient for keyboard.**
- **Copy / paste.** Terminal semantics: **Ctrl/Cmd+C is SIGINT to the agent, not copy.** Copy is
  selection→clipboard via an explicit affordance (Cmd/Ctrl+Shift+C or right-click); paste routes the
  clipboard text through `oninput`/`ptyInput` (bracketed-paste when the app enabled it). Pick the
  shortcut per-OS; do not let the copy binding shadow SIGINT.
- **Mouse → NOT forwarded to the agent in v1 (mux parity).** mux disables mouse tracking on macOS
  (`grabInput({mouse:false})` + alternate-scroll `\x1b[?1007h`) to preserve native text selection,
  and elsewhere uses the wheel only for local scrollback. The web mirrors this: **scroll wheel drives
  xterm's own local scrollback** (its default when the app isn't in mouse-tracking mode), **text
  selection + copy are preserved**, and **mouse clicks / movement / app mouse-mode are not forwarded
  to the agent.** This avoids the selection-vs-mouse-mode conflict mux already chose to avoid, and
  needs no extra wiring (do not opt the browser xterm into forwarding app mouse-mode).
- **Follow-up (optional, §10): forward mouse to the agent.** Only if an agent genuinely needs it.
  That version MUST wire `term.onBinary` alongside `onData` into `ptyInput` — legacy (non-SGR) mouse
  reporting emits 128–255 bytes via `onBinary`, which must not be UTF-8-mangled — and must resolve
  the selection conflict (e.g. modifier-to-select). Out of v1 scope.

**Mock WS server (first-class requirement).** `packages/web-ui/scripts/mock-ws-server.ts` gains a
docker-mode `sessions.create`, `sessions.ptyAttach` (emit `session.pty_replay` with a canned ANSI
banner), a timer emitting `session.pty_output` fake-TUI frames, `ptyInput` (echo back),
`ptyResize` (noop ack), and an input containing "escalate" → `escalation.created`. Both the xterm
view and the escalation overlay must be demoable and E2E-testable without Docker/LLM.

## 5. Security (trusted-host model — no new boundary; confirmed)

Both reviews confirmed: browser → `sessions.ptyInput` → child PTY stdin is **no new trust
boundary** vs. today's chatbox textarea → `sessions.send`. Both are operator input over the same
bearer-authed `/ws` on a trusted single-operator localhost, flowing into a `--network=none`
container whose only egress is the mediated MITM. Input is passed as **bytes to node-pty
`write()`**, never interpolated into a command; container/socat construction is untouched (it lives
in the reused child) — no shell-string concatenation is introduced. Do **not** add per-browser
isolation or host-adversary controls; that would over-build against the threat model.

## 6. Session lifecycle / orphan reaping — JUDGE OVERRIDE (differs from both A and B)

The designers split: **A exempts** PTY sessions from the 60s orphan sweep (survive indefinitely);
**B extends** the 60s sweep to reap PTY sessions after no clients. **Both are wrong for this
feature.**

- B's 60s reap is far too aggressive for a PTY: a browser reload, laptop sleep, or wifi blip all
  exceed 60s, and reaping would **kill a working Claude Code agent mid-task** — a worse failure
  than a leaked container, and it violates the mux mental model the user explicitly wants (mux
  children survive until you close the tab or exit mux).
- A's indefinite silent survival is a real container leak on a multi-day daemon.

**Ruling — mux-faithful with a guarded backstop:**
1. PTY sessions are **not** subject to the existing 60s turn-based orphan sweep. A transient
   disconnect detaches the client only; the child + container keep running and reconnect replays.
2. Guaranteed reaping happens on **explicit `sessions.end`** (`bridge.kill()` → child `finally`
   tears down container + writes resume snapshot) and on **daemon shutdown**
   (`PtySessionManager.close()` kills all bridges with a bounded await, mirroring mux `doShutdown`,
   `mux-app.ts:533`).
3. Add a **generous idle-TTL** as the leak backstop — no-clients-for-N, distinct from the 60s
   turn-based sweep. **v1: hard-code a named constant (`PTY_IDLE_TTL_MS`, 30 min)** — do NOT wire a
   config schema / Settings surface for it. A backstop that is rarely tuned does not justify the
   config surface (trusted-host / right-altitude); promote it to a config knob only if a real need
   appears. `0`/absence must be expressible as "disabled" in the constant for local testing.
4. Abandoned PTY sessions remain **visible in the session list** (they're labeled sessions), so the
   operator can end them manually. Surface `alive` + last-attached time in the DTO.

Label recycling: `reserveLabel()` is monotonic with no `releaseLabel()`. At the JS safe-integer
ceiling this is ~one session/sec for 63 years — a non-issue on a single-operator host. **Documented
as intentional; no `releaseLabel` added** (avoids over-engineering).

## 7. Pre-implementation gates (MUST pass before writing feature code)

**7.1 — Validate `@xterm/addon-serialize` alt-screen fidelity → RESOLVED: PASS. Build on
`serialize()`.** Ran as a two-agent spike (empirical round-trip harness + source/known-issue
corroboration + a real `vim` alt-screen capture); reports in `scratchpad/gate0-empirical-report.md`
and `scratchpad/gate0-corroboration-report.md`. Findings, now binding on implementation:
- **Pin `@xterm/addon-serialize@0.14.0`** — the lockstep stable cut with `@xterm/headless@6.0.0`
  (0.13 peers xterm 5; 0.15.x-beta peers xterm 6.1-beta). 0.14.0's source has first-class
  alt-buffer handling (emits `\x1b[?1049h` + alt content + cursor + SGR pen) with upstream tests
  named "serialize with alt screen correctly."
- **Fidelity: 100%** on the alt-screen content, colors (truecolor/256/16), all SGR attrs, cursor
  position, and alt-vs-normal buffer state — across a 7-fixture synthetic battery (serialize while
  alt active, 200-line scrollback, alt enter→exit, wide/CJK/emoji) AND a real vim capture
  (1920/1920 cells). The alt-screen snapshot is ~1.2 KB.
- **Accepted cosmetic losses (self-healing):** cursor *visibility* (`?25l`) and *shape* (DECSCUSR)
  are not serialized, and a cursor-X off-by-one occurs only in a deferred-wrap edge. On a Claude
  Code reconnect the worst case is a stray cursor for a single frame; the next alt-screen repaint
  re-hides/re-places it. Not worth mitigating in v1 (optional 1-line polish: re-append `?25l` to an
  alt-buffer replay if headless exposes DECTCEM state). 256-color indices 0–15 re-encode as 16-color
  — identical rendered color, enum only.
- **Implementation notes:** `term.write()` is async — the manager MUST `serialize()` from *inside*
  the `write` drain callback (this is the §3 ordering invariant, now doubly required). **Never set
  `excludeAltBuffer`** (it blanks a live TUI). Cap the replay via the addon's `serialize({scrollback:
  N})` option (see §11 Q2) — the alt buffer has no scrollback so the Claude Code case is always tiny;
  only normal-buffer sessions with huge truecolor logs can bloat, so bound the replayed scrollback
  tail rather than sending the full 5000-line buffer.
- **Ring-buffer fallback is DEMOTED** to a documented contingency (§10), off the critical path — not
  built for v1.

**7.2 — Escalation-watcher first-poll race (see Fork 5).** Make `createEscalationWatcher` poll
immediately on `start()`; add the pre-`start()` file-present unit test. Cheap, and a missed
escalation hangs the agent.

## 8. File-by-file change list

**New files**
- `src/pty/pty-bridge.ts` — relocated `PtyBridge`/`createPtyBridge`/`buildSpawnArgs` + `onData` +
  `serialize` + scrollback cap. (git-move of `src/mux/pty-bridge.ts`.)
- `src/pty/index.ts` — barrel (optional).
- `src/web-ui/pty-session-manager.ts` — `PtySessionManager` + `PtyWebSession` (bridge +
  EscalationWatcher + subscriber set + coalescing streamer + backpressure/resync + idle-TTL hook).
- `src/web-ui/dispatch/pty-dispatch.ts` — `sessions.ptyAttach|ptyDetach|ptyInput|ptyResize` (Zod).
- `packages/web-ui/src/lib/components/features/terminal-console.svelte` — xterm.js + FitAddon.
- `test/pty/pty-session-manager.test.ts` — attach/replay ordering, detach, escalation routing,
  idle-TTL, backpressure resync (stubbed `PtyBridge`).

**Modified — backend/daemon**
- `src/mux/mux-app.ts:10`, `src/mux/types.ts:5`, `test/pty-bridge.test.ts:10` — import path →
  `src/pty/pty-bridge.js`. Mechanical, compiler-verified. Sole mux change.
- `src/web-ui/web-event-bus.ts` — add `session.pty_output`, `session.pty_replay` (targeted like
  `session.token_stream`).
- `src/web-ui/dispatch/types.ts` — add `ptySessionManager?` to `DispatchContext`;
  `toPtySessionDto(session): SessionDto` (zeroed budget, `turnCount:0`,
  `tokenTrackingAvailable:false`); `ptyTerminal` on the status DTO.
- `src/web-ui/dispatch/session-dispatch.ts` — `sessions.create` branch on `ctx.mode.kind`;
  `sessions.list`/`sessions.end` merge/route PTY; delegate `sessions.pty*`.
- `src/web-ui/dispatch/escalation-dispatch.ts` — `resolve`/`list` compose `ptySessionManager`.
- `src/web-ui/web-ui-server.ts` — construct `PtySessionManager`, add to dispatch ctx; in
  `ws.on('close')`/`'error'` call `ptySessionManager.removeAllForClient(ws)` (mirrors
  `tokenStreamBridge?.removeAllForClient`); PTY idle-TTL timer; end PTY sessions in `stop()`.
- `src/session/session-manager.ts:47` — add `{ kind: 'web-pty' }` to `SessionSource` (produced
  only by `toPtySessionDto`/`toEscalationDto`; `SessionManager` never registers it).
- `src/escalation/escalation-watcher.ts` — immediate first poll on `start()` (§7.2).
- `src/web-ui/web-ui-types.ts` — `web-pty` source; new `MethodName`s; `ptyTerminal` on
  `DaemonStatusDto`.
- `src/daemon/ironcurtain-daemon.ts` — in `startWebUiServer` build `PtySessionManager` (needs
  `sessionManager`, `eventBus`, `mode`, `captureTracesDefault`, daemon id/pid) and pass to
  `WebUiServer`; call `ptySessionManager.close()` in shutdown.
- `package.json` (root) — add `@xterm/addon-serialize@0.14.0` (pinned; lockstep with
  `@xterm/headless@6.0.0` — see §7.1).

**Modified — frontend**
- `packages/web-ui/package.json` — add `@xterm/xterm`, `@xterm/addon-fit`.
- `packages/web-ui/src/lib/types.ts` — mirror `web-pty` source + new event payloads + methods.
- `packages/web-ui/src/lib/stores.svelte.ts` — `attachPty`/`detachPty`/`sendPtyInput`/
  `sendPtyResize`/`endPty` actions + per-label write/reset callback registry.
- `packages/web-ui/src/lib/event-handler.ts` — `session.pty_replay`/`session.pty_output` cases.
- `packages/web-ui/src/routes/Sessions.svelte` — render `TerminalConsole` for `web-pty`; wire
  attach/input/resize lifecycle; keep `SessionConsole` for turn-based.
- `packages/web-ui/scripts/mock-ws-server.ts` — PTY simulation (Fork 7).
- `packages/web-ui/CLAUDE.md` + `src/web-ui` docs — document the PTY streaming protocol + mock sync.

## 9. Phased plan

0. **Gate 7.1 spike — DONE (PASS).** `serialize()` validated at 100% alt-screen fidelity;
   `@xterm/addon-serialize@0.14.0` pinned; ring-buffer fallback dropped. See §7.1.
1. **Core relocation (isolated, zero-behavior commit).** `git mv` `src/mux/pty-bridge.ts` →
   `src/pty/pty-bridge.ts`; fix 3 imports. `npm run build` + `npm test` + manual `mux` smoke
   (spawn, type, resize, escalate, scroll, close). Bisect-clean.
2. **Core additions.** `onData` (post-write fan-out) + `serialize` + scrollback cap; add root dep;
   unit-test ordering + snapshot; re-run mux smoke.
3. **Daemon PTY manager + protocol.** `PtySessionManager`/`PtyWebSession`, `pty-dispatch.ts`,
   `session.pty_*` events, coalescing + backpressure/resync, `removeAllForClient`, idle-TTL,
   `sessions.create` mode branch + `list`/`end` merge. Unit tests with a stubbed bridge.
4. **Escalation bridge.** `EscalationWatcher` in `PtyWebSession` → `escalation.created`;
   `escalations.resolve`/`list` compose the PTY manager; §7.2 immediate-poll fix + test. Temp-dir
   test: write `request-*.json`, assert event + `response-*.json`.
5. **Frontend.** xterm deps; `terminal-console.svelte`; store actions + event-handler cases;
   `Sessions.svelte` render branch. Manual against a real docker-mode daemon.
6. **Mock + E2E.** PTY simulation in `mock-ws-server.ts`; Playwright: create docker session →
   terminal renders replay + live output → type echoes → resize → "escalate" → overlay approve/
   deny → reload → replay. Keep `npm run e2e` green.
7. **Docs.** `packages/web-ui/CLAUDE.md` protocol section; note that Docker web sessions are
   terminal-rendered while Code-Mode stays chatbox; verify Signal/cron/headless + Code-Mode web
   untouched.

## 10. Deferred / follow-ups (explicitly out of v1)

- Binary WS frames (Fork 2 upgrade) — only if profiling justifies it.
- Reattach-to-existing PTY after daemon restart (`createPtyBridge` spawns; it cannot re-adopt an
  already-running child via the persisted registration). v1: daemon shutdown kills its children.
- "Primary driver" designation for multi-tab resize (v1 is last-writer-wins).
- Mobile/touch terminal UX.
- Resume / model-selection UI in `sessions.create` (docker) — start with `persona` +
  `captureTraces` parity with the turn-based create schema.
- Generalize the PTY registry ownership fields from `muxId`/`muxPid` to a neutral
  `ownerKind`/`ownerId`/`ownerPid` (see §11, Q1). v1 reuses the mux fields.
- Forward mouse events to the agent (Fork 7): wire `term.onBinary` + `onData`, resolve the
  selection-vs-mouse-mode conflict. v1 is mux-parity (no mouse forwarding).
- Promote `PTY_IDLE_TTL_MS` to a config knob (§6) if a real need appears.

## 11. Integration-contract completeness (independent review — authoritative deltas)

An independent review found real gaps in how the new `web-pty` session kind coexists with the
*existing* web-UI RPC/event/limit contracts — a dimension the two adversarial reviews (scoped to
plumbing-reality and races/security) did not cover. All items below were verified against source
and are **binding**; they supersede/augment the referenced sections and the §8 change list.

**D1 (P1) — Shared PTY spawn resolver + initial-size + preflight.** `createPtyBridge` needs
`ironcurtainBin`, `prefixArgs`, `agent`, `cols`, `rows`, but the only runtime resolver is the
private nested `resolveIroncurtainBin()` in `mux-app.ts:97` (confirmed not exported). Fix:
- **New file `src/pty/resolve-ironcurtain-bin.ts`** — extract `resolveIroncurtainBin()` (tsx-vs-
  installed-bin logic) into the shared `src/pty/` leaf; mux imports it (one more mechanical edit in
  the move commit). `PtySessionManager` uses it to build child argv identically.
- **Initial-size policy:** the daemon has no controlling TTY, so a session spawns at a sane default
  (**80×24**) and adopts the first attaching browser's `FitAddon` size via `sessions.ptyResize`.
- **Preflight:** the daemon must probe that `node-pty` loads and `@xterm/addon-serialize` is present
  before offering the terminal path (mux probes node-pty in `mux-command.ts`). On failure, degrade
  gracefully (surface an error DTO / fall back to a clear "PTY unavailable" state) rather than
  throwing inside `sessions.create`.

**D2 (P1) — Guard the turn-based per-session RPCs/effects for `web-pty`.** PTY labels are not in
`SessionManager`, but `sessions.history/budget/diagnostics/get/send` all do
`if (!managed) throw SessionNotFoundError` (`session-dispatch.ts:87-96`), and `Sessions.svelte:83`
loads history on **every** selection unconditionally. Selecting a PTY session fires a throwing RPC
each time (masked by the frontend `.catch`, but a broken contract). Fix — **frontend guards**
(preferred, since a terminal session has no turn history/budget/diagnostics): the route must not
call `loadSessionHistory` / budget / diagnostics for `source.kind === 'web-pty'`, and must never
render the chatbox `send` path for it (it renders `TerminalConsole`). **Backend defensiveness:**
these dispatch cases should return a typed "not applicable for PTY" result (empty history, zeroed
budget, empty diagnostics) for a known PTY label rather than throw, so a stale/racing client
degrades cleanly. `toPtySessionDto` already zeroes budget/turnCount/`tokenTrackingAvailable`.

**D3 (P1) — Emit `escalation.resolved` from the PTY resolve path.** Folded into Fork 5 above:
`PtySessionManager.resolveEscalation` must drop the pending entry and emit
`escalation.resolved {escalationId, decision}` (UI clears the card on that event,
`event-handler.ts:393`). Verified missing from the original Fork 5 text.

**D4 (P2, elevated) — Count PTY sessions in status and the create limit.** `activeSessions` uses
`sessionManager.size` (`types.ts:118`) → dashboard **undercounts**; `createWebSession` gates on
`byKind('web').length >= maxConcurrentWebSessions` (`session-dispatch.ts:138`) → PTY sessions
**bypass the cap**. Because each PTY session is a full Docker container (heavier than a turn-based
session), unbounded spawn is a real resource concern, so this is elevated toward P1. Fix:
`PtySessionManager` exposes `.size` / `.count`; `buildStatusDto` adds it to `activeSessions`; the
docker branch of `sessions.create` enforces the **same** `maxConcurrentWebSessions` cap counting
`ptySessionManager.size` (or a dedicated `maxConcurrentPtySessions` if we want a separate ceiling —
default: reuse the existing knob).

**D5 (P2) — Idle-TTL wiring.** Resolved in §6: hard-coded `PTY_IDLE_TTL_MS` constant for v1, no
config schema. The §8 `web-ui-server.ts` line ("PTY idle-TTL timer") is the only wiring needed.

**Q1 ruling — registry ownership.** v1 **reuses `muxId`/`muxPid`** with a `webui-<daemonId>` owner
value (low-risk, no schema change). Generalizing the field names to `ownerKind`/`ownerId`/`ownerPid`
is a §10 follow-up.

**Q2 ruling — replay size (measured in Gate-0).** The **alt-screen** snapshot is ~1.2 KB — the
Claude Code case is always tiny (alt buffer has no scrollback). Only a **normal-buffer** session
with a huge log can bloat: a realistic 5000-line scrollback ≈ 0.31 MB (fits the 1 MB `maxPayload`),
but pathological all-truecolor ≈ 13 MB (does not). Ruling: bound the replay with the addon's
`serialize({ scrollback: N })` option (cap the replayed tail, e.g. N≈1000) so a single
`session.pty_replay` frame stays well under `maxPayload`; the headless buffer keeps its full
`scrollback: 5000` for the (out-of-scope) local-scroll case. Enable WS permessage-deflate if not
already on (the snapshot gzips ~15×). Chunking into multiple `pty_replay` frames is a last resort,
not v1.

**Change-list additions (augment §8):**
- New: `src/pty/resolve-ironcurtain-bin.ts` (extracted; mux import updated in the move commit).
- `src/web-ui/pty-session-manager.ts` — add `.size`/`.count`; `resolveEscalation` emits
  `escalation.resolved`; initial-size default + `ptyResize`-on-attach; node-pty/addon preflight;
  `PTY_IDLE_TTL_MS` timer.
- `src/web-ui/dispatch/types.ts` — `buildStatusDto.activeSessions` includes `ptySessionManager.size`.
- `src/web-ui/dispatch/session-dispatch.ts` — docker `sessions.create` enforces the concurrency cap
  over PTY count; `history/budget/diagnostics/get` return PTY-appropriate results (not throw) for
  known PTY labels.
- `packages/web-ui/src/routes/Sessions.svelte` — guard the history/budget/diagnostics effects on
  `source.kind !== 'web-pty'`.