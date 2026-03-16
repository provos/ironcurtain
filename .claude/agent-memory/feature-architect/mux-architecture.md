---
name: Mux Architecture
description: Terminal multiplexer architecture, escalation management, session ownership, and Docker network isolation
type: project
---

## Mux Architecture (`src/mux/`)

Key files:
- `src/mux/mux-command.ts` - CLI entry, acquires global lock, creates MuxApp
- `src/mux/mux-app.ts` - orchestrator: tabs, input, rendering, escalation manager
- `src/mux/mux-escalation-manager.ts` - watches escalation dirs, registry polling
- `src/mux/pty-bridge.ts` - spawns `ironcurtain start --pty` via node-pty, xterm headless buffer
- `src/mux/types.ts` - MuxTab, MuxAction discriminated union, Layout

## Single-Instance Lock (current constraint)
- `~/.ironcurtain/escalation-listener.lock` shared between mux and standalone escalation-listener
- `src/escalation/listener-lock.ts` - `acquireLock()`/`releaseLock()` with O_EXCL + PID liveness
- Purpose: prevent two watchers from racing on same escalation response files

## Escalation IPC Flow
1. MCP proxy (`mcp-proxy-server.ts`) writes `request-{id}.json` to session's escalation dir
2. Proxy polls for `response-{id}.json` (with timeout)
3. Mux's `EscalationWatcher` polls escalation dir, surfaces to user
4. User resolves via `/approve N` or `/deny N`
5. Watcher writes `response-{id}.json` atomically (write-to-temp-then-rename)

## PTY Session Registry
- `~/.ironcurtain/pty-registry/session-{id}.json` - PtySessionRegistration
- Written by `pty-session.ts` when Docker container starts
- Deleted on session end (finally block)
- Mux polls registry every 1s for external sessions
- Stale entries cleaned by PID liveness check

## Docker Internal Network Issue
- macOS TCP mode uses `ironcurtain-internal` (fixed name, fixed subnet 172.30.0.0/24)
- Multiple sessions create network (idempotent) but cleanup removes it (breaks others)
- Fix: per-session network names (`ironcurtain-{shortId}`)

## Multiple Mux Sessions Design (2026-03-16)
- See `docs/designs/multiple-mux-sessions.md`
- Solution: muxId ownership field in PtySessionRegistration
- Each mux generates unique ID, propagated via IRONCURTAIN_MUX_ID env var
- Registry polling filters by ownership
- Lock removed from mux; retained for standalone escalation-listener only
- Per-session Docker networks replace shared `ironcurtain-internal`
