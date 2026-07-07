---
name: webui-pty-serialize-gate0
description: Gate-0 spike verdict for webui-pty-terminal §7.1 — @xterm/addon-serialize faithfully round-trips alt-screen TUIs (PASS); build on serialize(), no ring-buffer fallback
metadata:
  type: project
---

Gate-0 of `docs/designs/webui-pty-terminal.md` §7.1: proved `@xterm/addon-serialize`'s
`serialize()` faithfully round-trips an alt-screen TUI (Claude Code) for browser reconnect.

**Verdict: PASS — build on `serialize()`, no raw-byte ring-buffer fallback needed.**

**Why:** empirical round-trip spike (7-fixture battery, cell-by-cell compare of chars/
width/fg+bg color+mode/all SGR attrs + cursorX/Y + `buffer.active.type`). All fixtures
100% cell-faithful incl. wide/CJK/emoji, truecolor, full scrollback, and alt-screen
enter/exit state. Two immaterial deviations: (1) cursor X off-by-1 only when a full-width
row leaves deferred-wrap AND target col unclamped — cursor is hidden in TUIs, self-heals
on next absolute-CUP repaint; (2) 256-color indices 0-15 re-encoded as 16-color, identical
rendered color, only mode enum differs.

**How to apply — when implementing the PTY terminal streaming:**
- Pin `@xterm/addon-serialize@0.14.0` with `@xterm/headless@6.0.0` (both `latest`
  dist-tags; addon peers `@xterm/xterm`, not headless, and 0.14.0 has NO peerDependencies
  field so no version constraint). The `0.15.0-beta` line peers the `6.1.0-beta` core — wrong pair.
- Both packages lack an `exports` map → bare specifier resolves to CJS `main`; named ESM
  imports FAIL. Use default-import interop: `import pkg from '@xterm/headless'; const { Terminal } = pkg;`
- `term.write()` is async — drain on its callback before `serialize()`.
- Snapshot with `serialize()` DEFAULTS. NEVER set `excludeAltBuffer:true` — it drops the
  alt buffer and yields a blank/empty snapshot for a live TUI (the alt buffer IS the screen).
- Alt-screen snapshot itself is ~1.2 KB (alt buffer has no scrollback) — never a WS-frame
  risk. Scrollback is the only size risk: realistic 5000-line ≈ 0.31 MB raw / 0.02 MB gzip
  (14x); pathological every-cell-truecolor 5000-line ≈ 13 MB raw / 3.7 MB gzip — exceeds
  1 MB even gzipped. Bound scrollback by a BYTE budget (re-serialize with smaller
  `{scrollback:N}` if over) + enable WS permessage-deflate; a line-count cap alone is not
  a frame-size guarantee.
