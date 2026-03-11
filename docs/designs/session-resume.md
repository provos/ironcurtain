# Design: Session Resume for Docker PTY Sessions

**Status:** Proposed
**Date:** 2026-03-07

## 1. Problem Statement

When a Docker PTY session ends — whether from an OAuth token expiry, a crash, user disconnect, or intentional exit — there is no way to resume it. The user must start a fresh session, losing all conversation context. This is particularly painful for long-running sessions where significant work has been done.

Two independent problems prevent session resume:

1. **Agent conversation state is lost.** Agents store conversation history inside the container (e.g., Claude Code in `~/.claude/projects/`, Goose in `~/.config/goose/`). These directories are not mounted from the host, so when the container exits, conversation data is destroyed.

2. **Mux has no resume capability.** The terminal multiplexer can only spawn new sessions. There is no way to resume a previously ended session, even though the session directory (sandbox, audit log, interaction logs) persists on disk.

## 2. Current Architecture

### What persists after a session ends

| Artifact | Location | Survives exit? |
|---|---|---|
| Workspace files | `~/.ironcurtain/sessions/{id}/sandbox/` | Yes |
| Audit log | `~/.ironcurtain/sessions/{id}/audit.jsonl` | Yes |
| LLM interactions | `~/.ironcurtain/sessions/{id}/llm-interactions.jsonl` | Yes |
| Session log | `~/.ironcurtain/sessions/{id}/session.log` | Yes |
| Agent conversation state | In-container paths (agent-specific) | **No** |
| PTY registration | `~/.ironcurtain/pty-registry/session-{id}.json` | **No** (deleted on exit) |
| Proxy sockets | `~/.ironcurtain/sessions/{id}/sockets/` | **No** (cleaned up) |

### Existing resume support

`ironcurtain start --resume <sessionId>` exists but only reuses the session directory. It spawns a fresh container — the agent inside starts with no conversation memory.

### Container volume mounts (current)

```
Host                                    Container
{sessionDir}/sandbox        →    /workspace           (rw)
{sessionDir}/sockets        →    /run/ironcurtain     (rw, Linux)
{sessionDir}/orientation    →    /etc/ironcurtain     (ro)
```

## 3. Proposed Design

The design separates **generic session infrastructure** (snapshots, mux resume, `--resume` flag) from **agent-specific conversation persistence** (state directories, resume flags). The existing `AgentAdapter` interface (`src/docker/agent-adapter.ts`) is extended with optional resume hooks.

### 3.1 Agent adapter resume interface

Extend `AgentAdapter` with optional methods that each adapter implements if the agent supports session resume:

```typescript
interface AgentAdapter {
  // ... existing methods ...

  /**
   * Returns the conversation state configuration for this agent.
   * If undefined, the agent does not support conversation persistence
   * and sessions will not be marked as resumable.
   */
  getConversationStateConfig?(): ConversationStateConfig;
}

interface ConversationStateConfig {
  /** Host-side subdirectory name within sessionDir (e.g., 'claude-state'). */
  hostDirName: string;

  /** Container-side mount target (e.g., '/root/.claude/'). */
  containerMountPath: string;

  /**
   * Files/directories to pre-populate on first session start.
   * Paths are relative to the host-side directory.
   */
  seed: Array<{
    path: string;
    content: string | (() => string | undefined);
  }>;

  /**
   * CLI flag(s) the agent uses to continue a previous conversation.
   * Appended to the PTY command on resume (e.g., ['--continue']).
   * If empty, the agent handles resume via presence of state files alone.
   */
  resumeFlags: string[];
}
```

This keeps agent-specific details out of the generic infrastructure. `pty-session.ts` and `docker-infrastructure.ts` call the adapter method and act on the returned config without knowing agent internals.

### 3.2 Agent-specific conversation persistence

#### Claude Code

```typescript
getConversationStateConfig(): ConversationStateConfig {
  return {
    hostDirName: 'claude-state',
    containerMountPath: '/root/.claude/',
    seed: [
      { path: 'projects/', content: '' },  // directory, populated by Claude Code
      { path: '.claude.json', content: '{"hasCompletedOnboarding": true}' },
      {
        path: 'settings.json',
        // Copy host settings if they exist, otherwise omit
        content: () => readSettingsFromHost(),
      },
    ],
    resumeFlags: ['--continue'],
  };
}
```

**Explicitly excluded** from the mounted directory (never copied):
- `.credentials.json` — OAuth tokens (MITM proxy handles auth)
- `session-env/` — may contain env snapshots with secrets
- `statsig/`, `stats-cache.json` — analytics, unnecessary

**Runtime cleanup:** On each container start, the generic infrastructure deletes `.credentials.json` from the state directory if it exists. Since auth is handled entirely by the MITM proxy via environment variables, any credentials file created by the agent at runtime is stale/invalid and must not persist across resumes.

**Workspace path stability:** Claude Code keys conversations by the project working directory path. Since the container always mounts the workspace at `/workspace`, the conversation key is stable across container restarts for the same session. `--continue` will find the previous conversation.

#### Goose

```typescript
getConversationStateConfig(): ConversationStateConfig {
  return {
    hostDirName: 'goose-state',
    containerMountPath: '/root/.config/goose/',
    seed: [
      { path: 'sessions/', content: '' },
    ],
    resumeFlags: [],  // Goose uses --no-session; resume via session files
  };
}
```

Goose currently runs with `--no-session` (fresh context each turn). To support resume, the adapter would need to switch to persistent sessions and manage session file selection. This is a future enhancement — `getConversationStateConfig()` can return `undefined` until Goose resume is implemented.

#### Agents without resume support

If an adapter does not implement `getConversationStateConfig()` (or returns `undefined`), sessions using that agent are not marked as resumable. The generic infrastructure handles this gracefully — the `resumable` field in the session snapshot is set to `false`.

### 3.3 Session state snapshot on exit (generic)

Write a `session-state.json` to the session directory when a PTY session ends, capturing enough metadata to support resume decisions. This is agent-agnostic.

```typescript
interface SessionSnapshot {
  sessionId: string;
  status: 'completed' | 'crashed' | 'auth-failure' | 'user-exit';
  exitCode: number | null;
  lastActivity: string;         // ISO timestamp
  turnCount: number;
  workspacePath: string;        // host-side workspace
  agent: string;                // 'claude-code', 'goose', etc.
  label: string;                // tab label from mux
  resumable: boolean;           // true if agent supports resume AND state dir exists
}
```

Written to: `~/.ironcurtain/sessions/{id}/session-state.json`

The exit status can be inferred from:
- OAuth refresh failure → `auth-failure`
- Container exit code 0 → `completed`
- Container exit code != 0 → `crashed`
- User-initiated close → `user-exit`

The `resumable` field is set by checking:
1. The adapter implements `getConversationStateConfig()`
2. The conversation state directory exists and is non-empty

### 3.4 Mux resume support (generic)

#### New mux commands

| Command | Behavior |
|---|---|
| `/resume [sessionId]` | Open a picker of resumable sessions, or resume a specific one |
| `/sessions --all` | List both active and resumable sessions |

#### Resume flow

```
/resume
    ↓
Scan ~/.ironcurtain/sessions/*/session-state.json
    ↓
Filter: resumable == true, sort by lastActivity desc
    ↓
Show picker: "session-id | agent | label | last activity | status"
    ↓
User selects session
    ↓
spawnSession(sessionId, workspacePath)  ← reuses existing sessionId
    ↓
PtyBridge spawns: ironcurtain start --pty --resume <sessionId> --agent <agent>
    ↓
New container starts with same sandbox + conversation state mounts
    ↓
Agent runs with resume flags (if any), finds previous conversation
    ↓
User continues where they left off
```

#### Auto-resume on mux startup (optional)

When `ironcurtain mux` starts, it could scan for sessions that ended with `auth-failure` or `crashed` status and offer to resume them. This could be a config option (`mux.autoResumeOnStart: boolean`).

### 3.5 Changes to `ironcurtain start --pty` (generic)

When `--resume <sessionId>` is passed:

1. Validate the session directory exists
2. Validate `session-state.json` exists and `resumable == true`
3. Load the adapter for the session's agent
4. Call `adapter.getConversationStateConfig()` to get mount config
5. Reuse `{sessionDir}/sandbox/` as workspace
6. Reuse `{sessionDir}/{hostDirName}/` (contains previous conversations)
7. Create fresh `sockets/` and `orientation/`
8. Append `resumeFlags` to the agent's PTY command
9. Start new container with all mounts
10. Append to existing `session.log` and `audit.jsonl` (not overwrite)

## 4. Security Considerations

- **No credentials in conversation state directories**: Adapters are responsible for excluding credential files from the mounted state directory. The MITM proxy's fake-key swap handles auth independently. On each container start, `.credentials.json` is deleted from the state directory as a defense-in-depth measure.
- **Session isolation**: Each session has its own conversation state directory. State from one session is not visible to another.
- **Read-write mount**: Agents need write access to their state directories to save conversations. This is the same trust level as the workspace mount.
- **Agent-specific exclusions**: Each adapter's `seed` list defines what gets pre-populated. Sensitive files (credentials, env snapshots) are never included.

## 5. Implementation Plan

### Phase 1: Adapter interface + Claude Code conversation persistence
1. Add `getConversationStateConfig()` to `AgentAdapter` interface
2. Implement for Claude Code adapter (seed files, exclude list, resume flags)
3. Generic logic in `docker-infrastructure.ts`: call adapter, create state dir, add mount
4. Verify `--continue` picks up previous conversations

### Phase 2: Session snapshots (generic)
1. Define `SessionSnapshot` type
2. Write snapshot on PTY session exit (classify exit reason)
3. Set `resumable` based on adapter capability and state directory existence
4. Add `--resume` validation logic to session startup

### Phase 3: Mux resume (generic)
1. Add `/resume` command to `MuxInputHandler`
2. Add session scanner (read `session-state.json` files)
3. Add resumable session picker UI
4. Wire `spawnSession()` to pass `--resume` flag and agent ID

### Phase 4: Goose + future agents
1. Implement `getConversationStateConfig()` for Goose adapter (requires switching from `--no-session`)
2. Document how to add resume support to new adapters

### Phase 5: Polish (optional)
1. Auto-resume prompt on mux startup
2. Session age-out / cleanup for old state directories
3. `/sessions --all` command showing resumable sessions

## 6. Open Questions

1. **Session expiry**: How long should sessions remain resumable? Should we auto-clean conversation state after N days?
2. **Multiple resumes**: Should a session be resumable more than once? (Probably yes — the snapshot just gets overwritten each time.)
3. **Cross-agent resume**: If a session was started with `claude-code`, can it be resumed with `goose`? (No — conversation format is agent-specific. The `agent` field in the snapshot enforces this.)
4. **Mux tab restoration**: Should mux save/restore its full tab layout on restart, not just individual sessions?
5. **Goose session continuity**: Goose currently uses `--no-session`. What is the best approach to enable persistent sessions while maintaining the existing turn-based architecture?
