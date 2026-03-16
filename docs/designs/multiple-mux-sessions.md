# Multiple Parallel Mux Sessions

## 1. Problem Statement

Running `ironcurtain mux` twice currently fails with:

```
Another escalation listener or mux is already running.
Only one instance can run at a time to prevent escalation conflicts.
```

The single-instance lock (`~/.ironcurtain/escalation-listener.lock`) was introduced to prevent two independent escalation-resolution UIs from racing on the same escalation request files. If mux A and mux B both poll the same PTY registry, both discover the same session's escalation, and both attempt to write `response-{id}.json`, the result is undefined: one response wins, the other is silently lost, and the losing mux shows stale state.

This design removes the single-instance constraint so that multiple mux processes can coexist safely, each managing its own set of sessions without interfering with the others.

## 2. Root Cause Analysis

### 2.1 Shared Resources That Create Conflicts

| Resource | Path / Identifier | Conflict Scenario |
|---|---|---|
| **Listener lock file** | `~/.ironcurtain/escalation-listener.lock` | Prevents any second mux/listener from starting |
| **PTY registry directory** | `~/.ironcurtain/pty-registry/` | Both mux instances discover the same sessions, both set up escalation watchers, both try to resolve the same escalation |
| **Docker internal network** | `ironcurtain-internal` (macOS TCP mode) | One mux's session cleanup calls `docker network rm ironcurtain-internal`, tearing down the network while another mux's containers are still using it |
| **Escalation directories** | `~/.ironcurtain/sessions/{id}/escalations/` | No conflict -- each session has its own directory. The conflict is at the *discovery* level (which mux owns which session's watcher) |

### 2.2 Resources That Are Already Session-Scoped (No Conflict)

- Session directories (`~/.ironcurtain/sessions/{id}/`)
- MCP proxy and MITM proxy (per-session processes, dynamic ports or per-session UDS)
- Docker containers (uniquely named per session: `ironcurtain-pty-{shortId}`)
- Sidecar containers (uniquely named: `ironcurtain-sidecar-{shortId}`)
- PTY sockets (per-session UDS path or dynamically allocated TCP port)

### 2.3 Why the Original Lock Existed

The lock served two purposes:

1. **Prevent escalation resolution races.** Two independent UIs polling the same escalation directory could both present the same pending escalation to the user, and both attempt to write `response-{id}.json`. The file-based IPC is not transactional -- whichever write lands second silently overwrites the first.

2. **Prevent mux + standalone escalation-listener conflicts.** The `ironcurtain escalation-listener` command (a simpler TUI) watches *all* sessions in the registry. A mux running simultaneously would create the same race condition.

The key insight is: the race only exists when *two watchers observe the same session*. If each mux exclusively owns its sessions' escalation directories, there is no race.

## 3. Design

### 3.1 Core Principle: Session Ownership via Mux ID

Each mux instance gets a unique identifier (a short random ID, e.g., `mux-a3f7`). Sessions spawned by a mux are *owned* by that mux. Ownership is recorded in the PTY registry entry so that other mux instances know to ignore sessions they do not own.

This eliminates the escalation race without requiring a global lock: each mux only watches escalation directories for sessions it owns.

### 3.2 Changes to PtySessionRegistration

Add an optional `muxId` field to the registration:

```typescript
export interface PtySessionRegistration {
  readonly sessionId: string;
  readonly escalationDir: string;
  readonly label: string;
  readonly startedAt: string;
  readonly pid: number;
  /** ID of the mux instance that owns this session. Absent for standalone sessions. */
  readonly muxId?: string;
  /** PID of the mux process that owns this session. Used to detect orphaned sessions. */
  readonly muxPid?: number;
}
```

Sessions spawned by a mux include both `muxId` and `muxPid`. Sessions spawned standalone (e.g., `ironcurtain start --pty` from a bare terminal) have neither -- these are "unowned" sessions that any listener can claim.

The `muxPid` field enables orphan detection: if a mux crashes without running its shutdown handler, its child sessions continue running with a `muxId` that no live mux recognizes. Without `muxPid`, these sessions would be permanently orphaned from escalation handling. With `muxPid`, any mux (or standalone listener) can check whether the owning mux process is still alive and reclaim orphaned sessions.

### 3.3 Mux Instance ID Generation and Propagation

The mux generates its ID at startup:

```typescript
// In mux-command.ts
import { randomBytes } from 'node:crypto';
const muxId = `mux-${randomBytes(4).toString('hex')}`; // e.g., "mux-a3f7b2c1"
```

The `muxId` and `muxPid` are passed through the session spawn chain:

1. `mux-command.ts` generates `muxId`, passes it (along with `process.pid` as `muxPid`) to `createMuxApp()`
2. `mux-app.ts` passes both to each `createPtyBridge()` call
3. `pty-bridge.ts` passes both as environment variables (`IRONCURTAIN_MUX_ID`, `IRONCURTAIN_MUX_PID`) to the child `ironcurtain start --pty` process
4. `pty-session.ts` reads both from the environment and includes them in the registration file

### 3.4 Registry Polling with Ownership Filtering

The `MuxEscalationManager.startRegistryPolling()` method currently watches for *all* sessions in the registry. With mux IDs, it filters:

```typescript
// In mux-escalation-manager.ts, inside the registry poll loop
for (const reg of registrations) {
  // Determine if this session belongs to us
  const isOwned = reg.muxId !== undefined;
  const isOurs = reg.muxId === ourMuxId;
  const isOrphaned = isOwned && !isOurs && reg.muxPid !== undefined && !isPidAlive(reg.muxPid);
  const isUnowned = !isOwned;

  // Claim sessions that are: ours, unowned, or orphaned (owning mux crashed)
  if (!isOurs && !isOrphaned && !isUnowned) continue;

  // Skip unowned/orphaned sessions if a standalone listener is handling them
  if ((isUnowned || isOrphaned) && isStandaloneListenerRunning()) continue;

  if (!stateIds.has(reg.sessionId) && !managedSessionIds.has(reg.sessionId) && !removedSessionIds.has(reg.sessionId)) {
    // ... add watcher as before
  }
}
```

The ownership filter handles four cases:
- **Owned by this mux** (`muxId === ourMuxId`): always claimed.
- **Owned by another live mux** (`muxId` differs, `muxPid` is alive): skipped.
- **Orphaned** (`muxId` differs, `muxPid` is dead): reclaimed by the first mux or standalone listener that discovers it. This handles mux crashes gracefully.
- **Unowned** (no `muxId`): claimed by the first mux to discover it, same as today's behavior.

For unowned and orphaned sessions, the escalation watcher's file-based resolution is idempotent enough that the worst case is a duplicated BEL notification, not data corruption. The `resolve()` method writes a response file atomically and checks if the request file still exists, so even if two watchers both see the same escalation, only one response matters to the proxy.

### 3.5 Remove the Global Lock

The `acquireLock()` / `releaseLock()` calls in `mux-command.ts` are removed. The mux no longer needs exclusive access because session ownership provides the isolation.

### 3.6 Escalation Listener Compatibility

The standalone `ironcurtain escalation-listener` command continues to use the lock. However, its lock scope changes: it only prevents *multiple standalone listeners* from running (which would still race on unowned sessions). A mux can run alongside a standalone listener because the mux only watches sessions it owns.

To implement this cleanly:

- **Rename the lock file** to `escalation-listener.lock` (same as today -- no change needed).
- **The mux no longer acquires this lock.** Only `escalation-listener` does.
- **The mux ignores unowned sessions if an escalation listener is running.** The mux checks for the lock file's existence (without acquiring it) and, if present, skips unowned sessions entirely. This prevents the mux from racing with a standalone listener on unowned sessions.

```typescript
// In mux-escalation-manager.ts
function isStandaloneListenerRunning(): boolean {
  const lockPath = getListenerLockPath();
  try {
    const content = readFileSync(lockPath, 'utf-8');
    const pid = parseInt(content.trim(), 10);
    return !isNaN(pid) && isPidAlive(pid);
  } catch {
    return false;
  }
}
```

### 3.7 Docker Internal Network Isolation

On macOS (TCP mode), each PTY session creates a Docker network named `ironcurtain-internal`. When a session ends, it calls `docker network rm ironcurtain-internal`, which can tear down the network while another session's containers are still attached.

The fix: use a session-scoped network name.

```typescript
// In pty-session.ts and docker-agent-session.ts
const networkName = `ironcurtain-${shortId}`;
```

This replaces the fixed `INTERNAL_NETWORK_NAME` constant with a per-session unique name. Each session creates and destroys its own network.

The `INTERNAL_NETWORK_NAME` constant in `platform.ts` can be retained as a prefix generator:

```typescript
export function getInternalNetworkName(shortId: string): string {
  return `ironcurtain-${shortId}`;
}
```

The subnet must also be unique per session to avoid Docker conflicts. Two approaches:

**Option A: Let Docker assign the subnet automatically.** Remove the explicit `--subnet` and `--gateway` flags. Docker assigns non-overlapping subnets by default. The sidecar and main container communicate via Docker DNS (container names), not hardcoded IPs. The `host.docker.internal` extra-host entry uses the sidecar's dynamically discovered IP (already the case via `getContainerIp()`).

**Option B: Deterministic per-session subnets.** Hash the session ID to derive a subnet in the 172.16.0.0/12 range. This is fragile and unnecessary given Option A.

**Recommendation: Option A.** Remove explicit subnet/gateway arguments. Docker's automatic subnet allocation is designed for this use case.

### 3.8 Summary of Changes

| File | Change |
|---|---|
| `src/docker/pty-types.ts` | Add `muxId?: string` and `muxPid?: number` to `PtySessionRegistration` |
| `src/mux/mux-command.ts` | Generate `muxId`, remove `acquireLock()`/`releaseLock()`, pass `muxId` and `muxPid` to `createMuxApp()` |
| `src/mux/mux-app.ts` | Accept `muxId`/`muxPid` in `MuxAppOptions`, pass to `createPtyBridge()` and `createMuxEscalationManager()` |
| `src/mux/pty-bridge.ts` | Accept `muxId`/`muxPid` in `PtyBridgeOptions`, set `IRONCURTAIN_MUX_ID` and `IRONCURTAIN_MUX_PID` env vars on child process |
| `src/mux/mux-escalation-manager.ts` | Accept `muxId`, filter registry polling by ownership with orphan detection via `muxPid` liveness check, check for standalone listener |
| `src/docker/pty-session.ts` | Read `IRONCURTAIN_MUX_ID` and `IRONCURTAIN_MUX_PID` from env, include in registration; use per-session network name; remove explicit subnet/gateway |
| `src/docker/docker-agent-session.ts` | Use per-session network name; remove explicit subnet/gateway |
| `src/docker/platform.ts` | Replace `INTERNAL_NETWORK_NAME` constant with `getInternalNetworkName()` function; remove subnet/gateway constants or keep as defaults |
| `src/escalation/listener-command.ts` | No change -- retains its lock for standalone listener single-instance |
| `src/escalation/session-registry.ts` | No change -- `isValidRegistration()` already uses duck typing, `muxId` is optional |

## 4. Key Design Decisions

1. **Ownership via muxId rather than per-mux registry directories.** An alternative would give each mux its own registry directory (e.g., `~/.ironcurtain/pty-registry-{muxId}/`). This was rejected because it would break the standalone escalation listener (which watches a single well-known directory) and would require the child `ironcurtain start --pty` process to know which registry to write to. Adding a field to the existing registration file is simpler and backward-compatible.

2. **No cross-mux escalation visibility.** Each mux only sees escalations from its own sessions (plus unowned/orphaned sessions). A user running two mux windows must approve escalations in the mux that spawned the session. This is the correct UX: each mux window is an independent workspace.

3. **Per-session Docker networks instead of a shared network.** The shared `ironcurtain-internal` network was a simplification that assumed only one session would run at a time on macOS. Per-session networks are the correct isolation boundary and align with how Docker networks are designed to be used.

4. **Automatic subnet allocation (Option A).** Hardcoded subnets conflict when multiple networks coexist. Docker's automatic allocation is robust and well-tested. The only requirement is that containers communicate via Docker DNS names (which they already do).

5. **Unowned session handling is best-effort.** If no standalone listener is running, a mux will claim unowned sessions (standalone `ironcurtain start --pty` invocations). If two mux instances exist, both may claim the same unowned session. This is acceptable because: (a) it is an edge case (running standalone PTY sessions alongside mux is unusual), and (b) the file-based escalation IPC degrades gracefully (duplicate BEL, not data loss).

## 5. Migration Plan

### PR 1: Per-session Docker networks (independent, no mux changes)

- Replace `INTERNAL_NETWORK_NAME` constant with `getInternalNetworkName(shortId)`
- Remove explicit subnet/gateway from `createNetwork()` calls
- Update `removeNetwork()` calls to use the session-scoped name
- Update tests that reference `INTERNAL_NETWORK_NAME`

This PR can be merged independently and fixes a real bug: running `ironcurtain start --pty` in two terminals on macOS already breaks because the second session's cleanup removes the first session's network.

### PR 2: Mux ownership and lock removal

- Add `muxId` and `muxPid` to `PtySessionRegistration`
- Generate `muxId` in `mux-command.ts`, capture `process.pid` as `muxPid`
- Propagate both through bridge -> child process -> registration (via `IRONCURTAIN_MUX_ID` and `IRONCURTAIN_MUX_PID` env vars)
- Filter registry polling by ownership in `MuxEscalationManager`, with orphan detection via `muxPid` liveness
- Remove lock acquisition from `mux-command.ts`
- Add standalone-listener detection for unowned session filtering

## 6. Testing Strategy

### Unit Tests

- `mux-escalation-manager.test.ts`: Add tests for ownership filtering:
  - Registrations with matching `muxId` are picked up
  - Registrations with different `muxId` (live `muxPid`) are ignored
  - Registrations with different `muxId` (dead `muxPid`) are reclaimed as orphans
  - Registrations with no `muxId` are picked up when no standalone listener is running
  - Registrations with no `muxId` are ignored when a standalone listener is running
  - Orphaned registrations are ignored when a standalone listener is running

- `session-registry.test.ts`: Verify `isValidRegistration()` accepts registrations with and without `muxId`

### Integration Tests

- Spawn two mux-like processes (without fullscreen TUI -- just the escalation manager and bridge logic), each with a different `muxId`. Verify that each only watches its own sessions' escalation directories.

### Docker Network Tests

- `docker-session.test.ts`: Update assertions to expect session-scoped network names instead of the fixed `ironcurtain-internal`

## 7. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Orphan Docker networks accumulate if sessions crash without cleanup | Docker networks are lightweight. Add a `docker network ls --filter name=ironcurtain-` cleanup to a health check or startup routine. |
| Two mux instances claim same unowned session | Acceptable degradation: duplicate BEL, one response wins. The proxy handles this correctly (first `response-{id}.json` wins). |
| `IRONCURTAIN_MUX_ID` env var leaks to Docker containers | The env var is set on the host-side `ironcurtain start --pty` child process, not on the Docker container. The child process reads it to write the registration file, then it is unused. |
| Backward compatibility: old registrations without `muxId` | Handled by treating `undefined` muxId as "unowned" -- new mux instances claim them, maintaining existing behavior. |
| Mux crashes without running shutdown handler, orphaning child sessions | The `muxPid` field in registrations enables orphan detection. Other mux instances (or the standalone listener) check `muxPid` liveness and reclaim sessions whose owning mux has died. The `isPidAlive()` check (via `process.kill(pid, 0)`) is the same proven mechanism used by the existing lock file staleness detection. |
| TOCTOU race in `isPidAlive()` check for orphan detection | The mux PID could die between the liveness check and the escalation claim. This is acceptable: at worst two mux instances briefly both claim the orphan, with the same benign outcome as the unowned-session race (duplicate BEL, one response wins). |
