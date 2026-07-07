# Web-UI PTY terminal frontend (packages/web-ui)

Frontend for the `web-pty` (Docker Agent Mode) xterm terminal session kind.
See `docs/designs/webui-pty-terminal.md` §4 fork 7 / §11 D2. Grep to confirm
symbols still exist before acting.

## Protocol (must match backend exactly)
- Client->server RPC: `sessions.ptyAttach {label}`, `sessions.ptyDetach {label}`,
  `sessions.ptyInput {label, data}` (data = base64 of UTF-8 bytes of keystrokes),
  `sessions.ptyResize {label, cols, rows}`. `label` is a NUMBER (backend
  `z.number().int().positive()` in `src/web-ui/dispatch/pty-dispatch.ts`).
- Server->client events: `session.pty_replay {label, snapshot}` (one-shot on
  attach), `session.pty_output {label, data}` (deltas). Both base64 of UTF-8 bytes.
- `SessionSource` gains `{kind:'web-pty'; persona?}`; web-pty `SessionDto` has
  zeroed budget, turnCount 0, `tokenTrackingAvailable:false`, optional `lastAttachedAt`.

## Layering seam: pure event-handler -> per-label sink registry
- `event-handler.ts` stays pure/type-only: it does NOT decode base64 and does NOT
  touch the DOM. It routes `session.pty_*` to `effects.getPtySink(label)?.write/reset`
  passing the RAW base64 string. `getPtySink` is a new `EventSideEffects` member.
- The sink registry (`Map<number, PtySink>`) lives in `stores.svelte.ts`
  (`registerPtySink`/`unregisterPtySink`, non-reactive — imperative handles).
- The component (the sink impl) decodes base64->Uint8Array at the `term.write()`
  boundary. Passing bytes (not a JS string) lets xterm own UTF-8 (correct across
  frame splits). Base64 helpers live in the pure leaf `lib/pty-codec.ts`
  (`encodeB64Utf8`/`decodeB64Utf8ToBytes`) — `btoa`/`atob` are Latin-1 only, so
  go through `TextEncoder`/byte<->binary-string (classic `btoa(unicode)` pitfall).

## features/ component rules (reviewer checks for a store import)
- `terminal-console.svelte` imports ONLY xterm + addon-fit + `pty-codec.js` + CSS.
  NO stores import. features/ components importing a PURE leaf util (pty-codec,
  output-grouping, markdown) is established and NOT a layering violation; only a
  `stores.svelte.ts` import is forbidden.
- Imperative handles via Svelte 5 instance-level `export function write/reset/
  fit/focus`, reached by the route through `bind:this`.

## Non-churning $derived-primitive pattern
`const selectedPtyLabel = $derived(appState.selectedSession?.source.kind==='web-pty'
? appState.selectedSession.label : null)`. Reading the reactive sessions map inside
a `$derived` recomputes on every session update, but since the value is a primitive
(number|null) the downstream `$effect` only re-runs when it actually changes — so
the attach effect reacts to a freshly-created pty session appearing (null->N) yet
never churns attach/detach on budget/status updates. Preferred over label + `untrack`.
- Ordering: register the sink BEFORE `attachPty` (server replays one-shot on attach).
- Wrap `<TerminalConsole>` in `{#key label}` so switching between two web-pty
  sessions remounts a fresh terminal (Svelte reuses the component otherwise).
- D2 guard: skip the history/budget/diagnostics effect for web-pty (terminal has
  no turn history). Keep the history effect keyed on label only; read kind via
  `untrack` so it doesn't over-subscribe to the sessions map.

## xterm versions (lockstep with existing @xterm/headless@6.0.0 + addon-serialize@0.14.0)
`@xterm/xterm@^6.0.0` + `@xterm/addon-fit@^0.11.0` (0.10 peers xterm5; 0.12.x are
xterm6.1-beta). addon-fit@0.11.0 has empty peerDeps. `write(data: string | Uint8Array)`.

## Mock server (scripts/mock-ws-server.ts)
PTY sim is behind `MOCK_SESSION_MODE=docker` (default off keeps existing e2e green).
docker mode: `sessions.create` -> web-pty; ptyAttach emits pty_replay + starts a
per-label frame `setInterval`; ptyInput echoes + routes "escalate" -> escalation.created;
ptyResize noop. Timers cleared on detach/end/reset. `b64()` = `Buffer.from(s).toString('base64')`.

## CSS import
`import '@xterm/xterm/css/xterm.css'` needs an ambient decl for svelte-check:
added `src/vite-env.d.ts` with `declare module '*.css';`. Vite build handles it regardless.
