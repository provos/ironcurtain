---
name: Mux Architecture
description: Terminal multiplexer architecture, escalation management, session ownership, and Docker network isolation
type: project
---

## Mux Architecture (`src/mux/`)

Key files:
- `src/mux/mux-command.ts` - CLI entry, generates muxId for session ownership, creates MuxApp
- `src/mux/mux-app.ts` - orchestrator: tabs, input, rendering, escalation manager
- `src/mux/mux-escalation-manager.ts` - watches escalation dirs, registry polling with ownership filtering
- `src/mux/pty-bridge.ts` - spawns `ironcurtain start --pty` via node-pty, xterm headless buffer
- `src/mux/types.ts` - MuxTab, MuxAction discriminated union, Layout

## Session Ownership (supports multiple parallel mux instances)
- Each mux generates a unique `muxId` + records its `muxPid`, propagated to child sessions via env vars
- `PtySessionRegistration` includes optional `muxId`/`muxPid` fields
- Registry polling filters by ownership: claims own sessions, skips other live mux's sessions, reclaims orphans (dead `muxPid`)
- `isLockHolderAlive()` checks standalone listener lock to avoid racing on unowned/orphaned sessions
- Standalone `ironcurtain escalation-listener` retains its own lock (`~/.ironcurtain/escalation-listener.lock`)

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

## Docker Internal Networks
- macOS TCP mode uses per-session networks (`ironcurtain-{shortId}`) with Docker-assigned subnets
- `getInternalNetworkName(shortId)` in `src/docker/platform.ts` generates the name
- Network tracked via `this.networkName` (null for UDS mode), cleaned up in close() and error paths

## Design Document
- See `docs/designs/multiple-mux-sessions.md` for full design rationale
