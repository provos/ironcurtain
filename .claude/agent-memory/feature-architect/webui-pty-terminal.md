---
name: webui-pty-terminal
description: Two control planes (turn-based transport vs container-PTY/mux) and the exact reuse seams for putting Claude Code's in-container TUI into the web UI over a WebSocket
metadata:
  type: project
---

# Web-UI PTY terminal / mux reuse map

Design brief 2026-07: replace the web-UI Sessions chatbox for **Docker Agent Mode** with a live
xterm.js terminal streaming Claude Code's in-container TUI (like `ironcurtain mux`). Design written
to a scratchpad (max-reuse lens, "Design A"); a sibling explored a clean-shared-core lens.

## Two DIFFERENT control planes (do not conflate)
- **Turn-based transport**: `src/session/transport.ts` `Transport{run(session),close()}`,
  `base-transport.ts`. IronCurtain owns the agent loop; structured `DiagnosticEvent`s;
  `sendMessage(text):Promise<string>`; text-only. Used by web (today), Signal, cron, headless.
- **PTY (mux)**: IronCurtain does NOT own the loop — Claude Code runs its own TUI in the container;
  only MITM egress is mediated. Opaque byte stream.

## Key reuse primitives (max-reuse for a WS terminal)
- `createPtyBridge` `src/mux/pty-bridge.ts:150` — node-pty wraps a spawned `ironcurtain start --pty`
  CHILD; feeds bytes into an `@xterm/headless` Terminal (scrollback source of truth); exposes
  write/resize/kill, `onOutput` (a "changed" signal, NOT raw bytes), and `onSessionDiscovered`
  (registration → sessionId + escalationDir). **Only seam needed for a byte stream:** add a raw-byte
  `onData` fan-out — today `child.onData` (:185) writes headless term + fires onOutput but never
  exposes bytes. `buildSpawnArgs` (:118) already threads agent/workspace/persona/provider/model/
  capture; child ownership via `IRONCURTAIN_MUX_ID/MUX_PID` env (:162).
- `attachPty` `src/docker/pty-session.ts:840` — the CLI leaf; hard-wired to process.stdin/stdout +
  setRawMode. NOT directly WS-reusable. The mux trick (spawn `start --pty` under node-pty; child's
  own attachPty pipes container⇄child stdio) is MORE reuse: child owns full DockerInfrastructure.
  Resize chain: `bridge.resize` → node-pty master → SIGWINCH → attachPty `stdout.on('resize')`
  (:973) → `runtime.exec('/etc/ironcurtain/resize-pty.sh',cols,rows)` (:927). Teardown+resume
  snapshot in runPtySession finally (:734), triggered by SIGTERM via `bridge.kill()`.
- `createEscalationWatcher` `src/escalation/escalation-watcher.ts:60` — polls escalation DIR for
  `request-<id>.json`; `.resolve()` (:131) writes `response-<id>.json`. **MITM writes escalation
  files regardless of transport** → this dir-watch is the seam to keep the structured Escalations
  overlay working for PTY. `MuxEscalationManager` (`src/mux/mux-escalation-manager.ts:134`) is a
  mux-specific consumer of this leaf (keys by displayNumber, BELs stderr) — reuse the LEAF, not the
  manager, for web.

## Web-UI wiring facts
- `SessionMode` is process-GLOBAL on the daemon (`ironcurtain-daemon.ts:760`): docker-mode daemon ⇒
  all web sessions PTY; builtin-mode ⇒ all chatbox. No per-session mixing. Code Mode has no TTY —
  stays turn-based.
- Today web docker sessions are turn-based batch DockerAgentSession (docker exec/turn) via
  `createStandaloneSession`; the feature changes ONLY the web `sessions.create` docker branch to
  spawn PTY. Signal/cron/headless untouched.
- WS is JSON-RPC-over-text: `web-ui-server.ts` `ws.on('message')` (:486) has an unused `isBinary`
  arg; `sendToSubscribers` (:241) is JSON-only (add a binary sibling). `TokenStreamBridge` is the
  proven per-subscriber targeted-delivery pattern. Escalation resolve dispatch
  (`escalation-dispatch.ts:34`) routes through `sessionManager.resolveSessionEscalation` →
  `session.resolveEscalation` — PTY sessions have NO Session, so add a PtyManager-first branch that
  resolves via the watcher.
- Labels without a ManagedSession: `sessionManager.reserveLabel()` (`session-manager.ts:119`), same
  as workflow-agent labels (`ironcurtain-daemon.ts:811`).
- Frontend layering (`packages/web-ui/CLAUDE.md`): `features/` components MUST NOT import
  `stores.svelte.ts` — route owns data, component takes props/callbacks. All RPC via named store
  actions. Mock WS server (`scripts/mock-ws-server.ts`) MUST support any new method/stream (e2e
  source of truth). Deps present: `@xterm/headless@^6`, `node-pty@^1.1` (root); browser needs
  `@xterm/xterm`+`@xterm/addon-fit`; server replay wants `@xterm/addon-serialize`.

## Design B — clean-shared-core lens deltas (scratch `design-pty-webui-B.md`, 2026-07)
The sibling clean-core design; differs from Design A (max-reuse) on three calls:
- **Relocate** `PtyBridge` from `src/mux/` to a new `src/pty/` leaf so `web-ui/` consumes it
  without a `web-ui→mux` edge. It's ALREADY a leaf (only node-pty/@xterm-headless/config-paths/
  escalation-registry/pty-types imports). Refactor cost is a git-move + 3 import fixes
  (`mux-app.ts:10`, `mux/types.ts:5`, `test/pty-bridge.test.ts:10`) + additive `onData`/
  `serialize()`; mux consumption otherwise byte-identical → near-zero regression. Do NOT touch
  `attachPty` (it's inside the child, one level below both consumers).
- **`onData` ordering invariant**: fire the raw-byte fan-out INSIDE the `terminal.write` callback
  (`pty-bridge.ts:185`) AFTER `onOutput`, so a delivered chunk is already in the buffer a
  synchronous `serialize()` captured → race-free reconnect (snapshot-then-subscribe, replay
  emitted before live deltas). `serialize()` via `@xterm/addon-serialize` on the headless term.
- **WS framing**: base64 chunks over the EXISTING JSON-RPC EventFrame (`session.pty_output` +
  one-shot `session.pty_replay`), reusing `sendToSubscribers`/subscribe/`removeAllForClient`
  (token-stream precedent) — NOT a binary sibling, NOT a 2nd `/ws` endpoint. Justified by
  trusted-host localhost + low-bandwidth TUI; coalesce (~16ms/32KB) + `bufferedAmount` guard w/
  snapshot-resync for backpressure. RPC in: `sessions.ptyAttach|ptyDetach|ptyInput|ptyResize`.
- **Distinct kind, NOT ManagedSession**: new `PtySessionManager` (Map<label, PtyWebSession>);
  each holds a PtyBridge + EscalationWatcher + subscriber Set. Borrows only label space via
  `reserveLabel()`. Do NOT shoehorn into `ManagedSession` (needs Session+Transport a PTY lacks).
  Dispatch composes: `sessions.create` branches on `ctx.mode.kind`; list/end/escalations.resolve
  try PTY manager then fall through. Frontend: presentational `terminal-console.svelte` with an
  exported imperative `write()`/`reset()` handle (route drives writes from the event stream —
  a reactive "latest chunk" prop would drop bursts).
