# PTY Session & Escalation Listener

## PTY Session Architecture
- **Module**: `src/docker/pty-session.ts` -- `runPtySession()` orchestrates the full lifecycle
- **Types**: `src/docker/pty-types.ts` -- `PtySessionRegistration`, `PTY_SOCK_NAME`, `DEFAULT_PTY_PORT`
- **Infra**: `src/docker/docker-infrastructure.ts` -- `prepareDockerInfrastructure()` shared by both `createDockerSession()` and `runPtySession()`
- **Design**: `docs/designs/pty-escalation-listener.md`

## DockerAgentSession preBuiltInfrastructure Pattern
- `DockerAgentSessionDeps` has optional `preBuiltInfrastructure?: { systemPrompt, image, mitmAddr }`
- When set, `initialize()` skips proxy start / orientation / image steps (already done by `prepareDockerInfrastructure()`)
- `createDockerSession()` in `src/session/index.ts` uses this pattern to avoid duplication

## Keystroke Reconstruction
- **Module**: `src/docker/keystroke-reconstructor.ts`
- `KeystrokeBuffer`: rolling buffer capped at 32KB, discards old chunks
- `reconstructUserInput()`: sends hex-encoded keystrokes to cheap LLM (Haiku) for reconstruction
- `writeUserContext()`: writes `{ userMessage }` to `user-context.json` (same format as `DockerAgentSession`)
- Lazy: only triggered when escalation is detected via `onEscalation` callback
- Model: uses `config.userConfig.autoApprove.modelId` or `DEFAULT_RECONSTRUCT_MODEL_ID`

## Escalation Watcher
- **Module**: `src/escalation/escalation-watcher.ts` -- shared polling + response writing
- `createEscalationWatcher()`: polls escalation directory for request files
- `atomicWriteJsonSync()`: write-to-temp-then-rename for all IPC files
- Used by: DockerAgentSession, PTY session (BEL notification), escalation listener

## Session Registry
- **Module**: `src/escalation/session-registry.ts` -- reads PTY session registrations
- `readActiveRegistrations()`: reads files from `~/.ironcurtain/pty-registry/`, removes stale (dead PID)
- Registration files: `session-{sessionId}.json` with `PtySessionRegistration` data

## Listener State
- **Module**: `src/escalation/listener-state.ts` -- immutable state management
- Functions: `createInitialState()`, `addSession()`, `removeSession()`, `addEscalation()`, `resolveEscalation()`, `expireEscalation()`
- Escalation display numbers are monotonically increasing (never reused)
- History capped at 20 entries

## AI SDK v6 Gotcha
- `maxOutputTokens` (not `maxTokens`) in `generateText()` options
