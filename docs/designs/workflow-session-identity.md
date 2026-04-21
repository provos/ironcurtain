# Workflow Session Identity Unification

## Implementation status

Revised 2026-04-19 after implementer review — socket layout flattened, BundleId=SessionId for CLI, AgentConversationId orchestrator-minted, transient-bundle teardown explicit, control-socket routing per-bundle, conversationStateDir now multi-conversation.

Revised again 2026-04-19 after second implementer review — §6.5 teardown ordering flipped, cyclePolicy takes bundle (not bundleId), §4 tree indent fixed, §9 migration paths corrected, Step 2 brand caveat added.

Revised 2026-04-20 — freshContainer replaced by containerScope string primitive; transientInfra map renamed to bundlesByScope; scoped bundles share the same lifecycle.

Revised 2026-04-20 (second pass) — dropped ironcurtain.role label; added ironcurtain.scope; resume walks all workflow matches and reconstructs bundlesByScope from scope labels.

**Implemented.** This document records the design as landed; see the
revision notes above for the clarifications made during implementation.
Prerequisite work: Steps 1-5 of
`docs/designs/workflow-container-lifecycle.md` shipped on master
(`0c3ac22`). `containerScope` subsumed the earlier `freshContainer`
proposal as the single per-state opt-out primitive.

Open questions resolved 2026-04-19: `BundleId` is a v4 UUID; single-session
CLI runs keep the asymmetric `sessions/<sessionId>/` layout; audit log is
per-bundle.

## 1. The identity problem

Three orthogonal identities are partially conflated under the name
`sessionId` today:

1. **Bundle identity (`bundleId`).** The Docker container's `--name`
   suffix, the `ironcurtain.session` label, the directory key for the
   shared bundle's sockets / CA / fake keys. Today
   `createDockerInfrastructure()` at `src/docker/docker-infrastructure.ts:476`
   derives it from a `sessionId` input. For shared-container workflows the
   orchestrator passes `workflowId` here (see
   `src/workflow/orchestrator.ts:596`); for standalone sessions the session
   factory passes a per-session UUID.

2. **Invocation identity (`invocationId`).** The key under which a single
   agent state's artifacts (`session.log`, `session-metadata.json`) live.
   Today each borrowing state mints its own `sessionId` via
   `createSessionId()` in `src/session/index.ts:160`, then the
   orchestrator composes `${stateId}.${visitCount}` as a _separate_ slug
   (`src/workflow/orchestrator.ts:1188`) and writes the artifacts to
   `workflow-runs/<workflowId>/states/<slug>/` -- but the per-state
   `DockerAgentSession` still carries its own UUID that is never
   persisted anywhere the workflow looks at.

3. **Agent conversation identity (`agentConversationId`).** The UUID that
   Claude Code's `--session-id <id>` / `--resume <id>` consumes to pick up
   a prior conversation. The orchestrator currently threads this as
   `context.sessionsByState[stateId]` (`src/workflow/types.ts:346`), typed
   and named like an IronCurtain session id but used solely to pass the
   previous invocation's `sessionId` into the next invocation's
   `SessionOptions.resumeSessionId` (`src/workflow/orchestrator.ts:1179`),
   which in turn becomes the `--session-id` / `--resume <uuid>` argument
   on the Claude CLI side (see
   `src/docker/docker-agent-session.ts:152-154` for the resume detection).

Under today's model the three collide because `createSessionId()` is the
only minting call site and every caller reuses the same type. This has
two concrete consequences:

- The invocation's UUID is pure overhead: no artifact is keyed on it, no
  consumer queries it. It exists because the session factory demands one.
- Under the Step 5 naming, the bundle tree
  (`workflow-runs/<workflowId>/bundle/`) lives next to state trees
  (`workflow-runs/<workflowId>/states/<stateId>.<visitCount>/`) with
  different keys. For Step 6 (`containerScope`) we would need a
  _second_ bundle tree inside the same workflow with yet another
  distinct key -- two bundles, two incompatible directory conventions,
  no place to point a resume operation at a single "the bundle for this
  workflow."

This refactor renames and plumbs the three identities as first-class
concepts. The end state:

- Every state that borrows a container shares **that container's**
  `bundleId`. A state that declares a `containerScope` not yet present
  in the workflow mints a new `bundleId` alongside its new container.
- Per-invocation artifacts are keyed on `{bundleId}/states/{stateId}.{visit}/`
  -- the invocation has no UUID of its own; the slug is the key.
- `agentConversationId` is a separate field on `SessionOptions`,
  carried in `WorkflowContext.agentConversationsByState`, and consumed
  by the adapter for `--resume`.

## 2. Type model deltas

### 2.1 New branded identity types (`src/session/types.ts`)

```typescript
/**
 * Unique key for a Docker infrastructure bundle: one container + its
 * MITM proxy, Code Mode proxy, CA, fake keys, and sockets tree. A
 * single-session CLI run has one `BundleId`. A shared-container workflow
 * has one per distinct `containerScope` used by its states (one when
 * every state uses the default scope `"primary"`; two or more for
 * bifurcated workflows).
 *
 * Used to key the on-disk directory tree (`workflow-runs/<wfId>/containers/<bundleId>/`),
 * the Docker container name suffix (`ironcurtain-<bundleId[0:12]>`), the
 * `ironcurtain.bundle` Docker label, and the coordinator control socket
 * path.
 */
export type BundleId = string & { readonly __brand: 'BundleId' };
export function createBundleId(): BundleId {
  return randomUUID() as BundleId;
}

/**
 * Single-session CLI invariant: `bundleId === sessionId`. The brands stay
 * distinct to keep type-level semantics clear, but the runtime value is one
 * UUID -- the session factory mints one `SessionId` and reuses the string as
 * its `BundleId` via `as unknown as BundleId`. This preserves the
 * deterministic `ironcurtain-<sessionId[0:12]>` container name that
 * `removeStaleContainer` depends on for prior-crash recovery.
 *
 * Only workflow mode mints distinct `BundleId`s (one per unique
 * `containerScope` used across the workflow's states).
 */

/**
 * UUID the external agent CLI (e.g., Claude Code) uses for conversation
 * continuity. Passed as `--session-id <id>` on first turn and
 * `--resume <id>` on subsequent turns. Shape is dictated by the external
 * agent: Claude Code writes `projects/<cwd-hash>/<id>.jsonl`, so we must
 * preserve the UUID across turns for that agent to find its own history.
 *
 * This identity does NOT correspond to any IronCurtain-owned directory;
 * its entire purpose is to be handed back to the agent CLI on re-entry.
 */
export type AgentConversationId = string & { readonly __brand: 'AgentConversationId' };
export function createAgentConversationId(): AgentConversationId {
  return randomUUID() as AgentConversationId;
}
```

The existing `SessionId` brand is **retired** as a separate concept.
Callers that today read/write `SessionId` fall into exactly one of the
three buckets above; the audit pass in §9 reassigns each site.

Alias note: inside `DockerAgentSession` and log messages we still speak
about "a session" as an in-memory runtime object (one sendMessage loop
over one bundle). That runtime object's identifier is just the tuple
`{bundleId, stateSlug | null}`; there is no third brand for it. The
invocation slug `{stateId}.{visitCount}` is already a structured string
owned by the orchestrator and is sufficient.

### 2.2 `SessionOptions` deltas (`src/session/types.ts`)

```typescript
export interface SessionOptions {
  // ... existing fields (config, mode, ...) unchanged ...

  /**
   * Infrastructure bundle to borrow. When set, the session is
   * constructed with `ownsInfra: false`; the caller retains lifecycle
   * ownership. Replaces today's `workflowInfrastructure` -- once
   * `containerScope` lands, this is no longer workflow-exclusive (the
   * orchestrator mints a new bundle when a state's scope is not yet
   * present and hands it to that state's session the same way).
   */
  readonly borrowBundle?: DockerInfrastructure;

  /**
   * Per-invocation artifact directory: where `session.log` and
   * `session-metadata.json` are written. When set, the session writes
   * here instead of `{home}/sessions/{sessionId}/`. The directory is
   * created by the caller (orchestrator) before session creation.
   * Replaces today's `workflowStateDir`.
   */
  readonly invocationDir?: string;

  /**
   * Human-readable slug identifying this state invocation
   * (e.g., "plan.1", "review.2"). Only used for logging / diagnostics.
   * Replaces today's `stateSlug`.
   */
  readonly invocationSlug?: string;

  /**
   * Agent CLI conversation id. **Required** for Docker agent sessions; the
   * orchestrator (or, for standalone CLI runs, the session factory) mints
   * this via `createAgentConversationId()` and passes it in. The Docker
   * adapter passes it to the agent CLI as `--session-id <id>` on first turn
   * and `--resume <id>` on subsequent turns (semantics determined by whether
   * a prior `.jsonl` exists in `conversationStateDir`, see §8.5).
   *
   * Not a getter on the session: IronCurtain picks the id, the agent CLI
   * consumes it. There is no round-trip where the agent surfaces its own id
   * back to us.
   *
   * For builtin sessions the field is unused; builtin resume semantics
   * remain keyed on IronCurtain session directories (see §3 "Identity flow").
   */
  readonly agentConversationId?: AgentConversationId;
}
```

### 2.3 `DockerInfrastructure` (`src/docker/docker-infrastructure.ts`)

```typescript
export interface DockerInfrastructure extends PreContainerInfrastructure {
  /**
   * Stable key for this bundle. Used by:
   *  - Docker container name: `ironcurtain-<bundleId[0:12]>`
   *  - `ironcurtain.bundle=<bundleId>` label (see §7 for label scheme)
   *  - Per-bundle directory: `workflow-runs/<wfId>/containers/<bundleId>/`
   *  - Coordinator control socket path
   * Minted by `createDockerInfrastructure()`; never changes for a bundle's
   * lifetime.
   */
  readonly bundleId: BundleId;

  // containerId, containerName, sidecarContainerId, internalNetwork -- unchanged
}

export interface PreContainerInfrastructure {
  readonly bundleId: BundleId; // was `sessionId: string`
  readonly bundleDir: string; // was `sessionDir: string`
  readonly workspaceDir: string; // was `sandboxDir: string` — clearer in workflow context
  readonly escalationDir: string; // unchanged
  readonly auditLogPath: string; // unchanged
  // ... rest unchanged ...
}
```

Rationale for renaming `sessionDir` -> `bundleDir`: the directory holds
bundle-scoped artifacts (sockets, escalations, orientation, CA, fake
keys) that outlive any single invocation. The old name is a tell for the
confusion this refactor fixes.

### 2.4 Workflow types (`src/workflow/types.ts`, `src/workflow/orchestrator.ts`)

```typescript
export interface AgentStateDefinition {
  // ... existing fields unchanged ...

  /**
   * Container scope label. States sharing a scope share a bundle (one
   * container, one coordinator, one audit log, one control socket);
   * states with different scopes live in different bundles. When unset,
   * defaults to `"primary"`, so every state lands on the workflow's
   * primary bundle by default.
   *
   * Meaningful only under `sharedContainer: true`. Under
   * `sharedContainer: false` (legacy default, one container per state)
   * declaring a `containerScope` is a **validation error** -- silent
   * no-ops are footguns; we reject at validate.ts (§9).
   *
   * Charset: `/^[a-zA-Z0-9_-]+$/` (same as persona slugs). Scope strings
   * are opaque Map lookup keys -- they are NEVER embedded in filesystem
   * paths, so the charset is a sanity/diagnostics constraint rather than
   * a path-safety one. The on-disk bundle directory name is the UUID
   * `bundleId`, not the scope (§4).
   *
   * Degenerate cases: `containerScope: "isolated-<stateId>"` reproduces
   * the former `freshContainer: true` semantics. Two or more states can
   * share a non-default scope (e.g., `"env-python3"`) and cohabit a
   * bundle -- the new capability this primitive unlocks.
   */
  readonly containerScope?: string;
}

export interface WorkflowContext {
  // ... existing fields unchanged ...

  /**
   * Maps a stateId to the agent-CLI conversation id assigned on the last
   * successful invocation of that state. Consumed by `freshSession: false`
   * re-entries so the CLI can `--resume` the prior conversation.
   * Replaces `sessionsByState` (same shape, clearer name + brand).
   */
  readonly agentConversationsByState: Record<string, AgentConversationId>;
}

interface WorkflowInstance {
  // ... existing fields unchanged, except ...

  /**
   * All bundles owned by this workflow, keyed on the `containerScope`
   * string that mints them. Populated lazily: on first `executeAgentState`
   * for a given scope, the orchestrator mints a new `BundleId`, builds
   * the `DockerInfrastructure`, and inserts it under the scope key.
   * Subsequent states with the same scope borrow the existing entry.
   *
   * Under `sharedContainer: true`, the default-scope entry (`"primary"`)
   * is the same bundle today's code calls "the primary bundle" -- no
   * special-casing required, it is just the first scope most workflows
   * ever ask for. A bifurcated workflow (e.g., half the states on
   * `"env-a"`, half on `"env-b"`) produces two entries, each with its
   * own coordinator, audit log, and control socket.
   *
   * Under `sharedContainer: false`, this map is unused (every state
   * spins up and tears down its own bundle inline).
   *
   * Lifecycle: entries are created on first use, destroyed only at
   * workflow terminal via `destroyWorkflowInfrastructure` (§6.5). There
   * is no per-state teardown -- scoped bundles live for the whole run.
   *
   * Key is the literal scope string (not a branded type): scopes are
   * user-supplied labels that exist only as Map keys, and a brand buys
   * very little at that boundary.
   */
  readonly bundlesByScope: Map<string, DockerInfrastructure>;
}
```

**`primaryInfra` collapses into `bundlesByScope.get("primary")`.** Keeping
a separate field would mean two representations of the same bundle (the
Map entry and the field), two teardown walks, and a special case in
`destroyWorkflowInfrastructure`. The default scope is a key like any
other; resume reclamation (Step 7) queries Docker by
`ironcurtain.workflow=<wfId>`, walks all matches, and reconstructs
`bundlesByScope` by reading `ironcurtain.scope` off each container (§7).
No special-casing of the primary entry in either the in-memory store or
the Docker metadata.

### 2.5 `CreateWorkflowInfrastructureInput` (`src/workflow/orchestrator.ts:151`)

```typescript
export interface CreateWorkflowInfrastructureInput {
  readonly workflowId: WorkflowId;
  readonly bundleId: BundleId; // NEW — minted by orchestrator
  readonly agentId: AgentId;
  readonly controlSocketPath: string;
  readonly workspacePath: string;
  /**
   * Scope label this bundle was minted for (the Map key under
   * `bundlesByScope`). Emitted directly as the
   * `ironcurtain.scope=<scope>` Docker label (§7). Not embedded in any
   * path.
   */
  readonly scope: string;
}
```

## 3. Identity flow

Both `BundleId` and `AgentConversationId` are v4 UUIDs minted via
`randomUUID()`. No collision-resistance tricks, no workflow-id prefixes --
they are opaque keys whose only job is to be unique.

### Minting rules

| Entry point                                                        | Who mints `bundleId`                                                                                                                                                                                                                                                              | Who mints `agentConversationId`                                                                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Single-session CLI (`ironcurtain start "task"`)                    | `createDockerSession()` reuses the `SessionId` value as the `BundleId` (single UUID, two brands). No separate mint.                                                                                                                                                               | Orchestrator-equivalent (session factory) mints via `createAgentConversationId()` and passes into `SessionOptions.agentConversationId`. |
| Workflow state, scope not yet in `instance.bundlesByScope`         | Orchestrator mints a new `BundleId` inside `executeAgentState`, calls the factory, inserts under the scope key. Applies to the first state visited under every scope -- including the default `"primary"` scope; there is no longer a separate eager-mint step at workflow start. | Orchestrator mints in `executeAgentState` (see "agentConversationId propagation" below)                                                 |
| Workflow state, scope already present in `instance.bundlesByScope` | Orchestrator borrows the existing bundle (no mint).                                                                                                                                                                                                                               | Same as above                                                                                                                           |

Rule of thumb: **the orchestrator is always the minter in workflow
mode; the session factory is the minter in standalone mode.** That
matches the ownership story -- the layer that will destroy the bundle
is also the layer that names it.

### Bundle selection at state entry

Inside `executeAgentState(stateId)`, **before** session construction:

1. Compute `scope = stateConfig.containerScope ?? "primary"`.
2. Look up `bundle = instance.bundlesByScope.get(scope)`.
3. If present: borrow it (`SessionOptions.borrowBundle = bundle`).
4. If absent: mint a new `BundleId` via `createBundleId()`, call
   `createDockerInfrastructure(...)` with that id and the scope,
   insert the result via `instance.bundlesByScope.set(scope, bundle)`,
   then borrow it the same way.

Under `sharedContainer: false`, the branch above is skipped entirely:
every state spins up and tears down its own `DockerInfrastructure`
inline (today's behavior, unchanged), and any `containerScope` field
on the state is a validation error at load time (§9).

### `agentConversationId` propagation

The orchestrator is the **minter** of `AgentConversationId`, symmetric
with how it mints `BundleId` for a fresh container. There is no getter
on the session -- IronCurtain picks the id up front, the agent CLI
consumes it.

Decision table at state entry inside `executeAgentState(stateId)`:

| Condition                                                                         | Behavior                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `freshSession: false` **and** `context.agentConversationsByState[stateId]` is set | Reuse the stored id: pass it as `SessionOptions.agentConversationId`. The Docker adapter then emits `--resume <id>` (since a prior `.jsonl` exists in the bundle's `conversationStateDir`; see §8.5). |
| `freshSession: true`                                                              | Mint a new `AgentConversationId` via `createAgentConversationId()`. Pass it as `SessionOptions.agentConversationId`. The adapter emits `--session-id <id>` (no prior `.jsonl`).                       |
| First visit to `stateId` (no map entry)                                           | Same as `freshSession: true`: mint fresh.                                                                                                                                                             |

On successful completion, the orchestrator writes the id used into
`context.agentConversationsByState[stateId]`. Because the orchestrator
knew the id before calling the session (it just passed it in), the
write is a direct store of the `SessionOptions.agentConversationId`
value -- no read-back from the session.

The `AgentInvokeResult.sessionId` field that today propagates the id
out of `executeAgentState` is removed; the id is already in the local
scope when the `updateContextFromAgentResult` action runs. The action
is simplified accordingly in `src/workflow/machine-builder.ts`.

`DockerAgentSession` gains no accessor for this id. It holds the
value passed in via `SessionOptions.agentConversationId` purely to
thread it into the adapter's CLI-arg construction.

## 4. Directory layout

```
~/.ironcurtain/
├── sessions/                              # standalone / CLI sessions ONLY
│   └── <sessionId>/                       # today's single-session layout — unchanged
│       ├── sandbox/
│       ├── sockets/
│       ├── escalations/
│       ├── session.log
│       ├── session-metadata.json
│       ├── audit.jsonl
│       └── ...
└── workflow-runs/
    └── <workflowId>/
        ├── message-log.jsonl              # workflow-scoped
        ├── checkpoint.json                # workflow-scoped
        ├── workspace/                     # shared workspace (one per workflow)
        ├── sockets/                       # coordinator control UDS, flat per-workflow
        │   ├── <bundleIdA>.sock           # one socket per bundle (one per unique containerScope)
        │   └── <bundleIdB>.sock           # bifurcated / scoped workflows have more than one
        └── containers/
            ├── <bundleIdA>/               # scope "primary" bundle (the common case)
            │   ├── audit.jsonl            # per-bundle, persona-tagged
            │   ├── bundle/                # MCP + MITM sockets, CA, fake keys, orientation, system-prompt.txt
            │   └── states/
            │       ├── plan.1/
            │       │   ├── session.log
            │       │   └── session-metadata.json
            │       ├── review.1/
            │       └── review.2/
            └── <bundleIdB>/               # second scope bundle (e.g., "env-python3") — one per distinct scope used
                ├── audit.jsonl
                ├── bundle/
                └── states/
                    └── build.1/
```

### Properties of this layout

1. **Single-session CLI stays at `sessions/<sessionId>/`.** Standalone
   runs keep today's layout. They have a `BundleId` under the hood
   (naming the Docker container), but the on-disk tree is keyed by
   `SessionId`. The `SessionId` brand remains for this purpose in
   single-session mode.

2. **Workflow workspace is one level up from containers.** `workspace/`
   is shared across all bundles in the workflow; a state in any scope
   still mutates the same workspace (otherwise scoped states could not
   hand off artifacts to states in other scopes). If future work needs
   isolated workspaces per scope, it lands inside `<bundleId>/workspace/`
   -- a forward-compatible shape without restructuring.

3. **Per-bundle `audit.jsonl`.** The audit log lives under each bundle,
   which keeps the invariant "one audit file per coordinator" visible in
   the path and avoids the cross-process append hazard that Step 5
   eliminated (scoped bundles would otherwise have to append to a file
   owned by another scope). Consumers that want a workflow-level view
   concatenate across bundles in chronological order by mtime (bundles are
   created serially as the workflow progresses; no parallel-bundle case
   exists in v1). If concatenation becomes painful, add an
   `ironcurtain workflow audit <wfId>` helper later.

   **Scope is a lookup key, not a path component.** The `<bundleId>`
   directory names are UUIDs; `containerScope` values never appear in
   any filesystem path. This decouples path safety from scope-string
   validation -- we can be lax about what scope characters we allow
   (charset is a diagnostics sanity check, see §2.4) without worrying
   about injection into directory names, socket paths, or Docker labels
   that feed commands. Scope only appears as a Map key and as the value
   of the `ironcurtain.scope` Docker label (§7), neither of which has
   path-traversal semantics.

4. **`bundle/` name preserved inside the bundle dir.** The inner
   directory still holds exactly what `DockerInfrastructure` already
   puts there (MCP + MITM sockets, CA, fake keys, orientation,
   system-prompt.txt). Its parent gains the `<bundleId>/` wrapper with
   the audit log alongside.

5. **Coordinator control sockets live under a flat `sockets/` dir,
   one directory up from `containers/`.** This is a deliberate
   departure from the "everything per-bundle lives under
   `containers/<bundleId>/`" principle, imposed by the macOS
   `sockaddr_un.sun_path` ~104-byte limit. A nested
   `containers/<bundleId>/proxy-control.sock` path with a 36-char
   UUID `bundleId` and a typical `$HOME` exceeds that limit and
   fails `bind(2)` on Darwin. The flattened layout
   (`workflow-runs/<wfId>/sockets/<bundleId>.sock`) drops roughly 18
   bytes per path and stays inside the limit.

   The **bundle's internal sockets** (MCP proxy, MITM) continue to
   live under `containers/<bundleId>/bundle/sockets/` because they
   are bind-mounted into the container: the host path is only used
   for the mount, while the in-container path
   (`/run/ironcurtain/…`) is short and is what the MCP / MITM
   processes bind to. Only the host-bound coordinator control socket
   has to move.

   Single-session CLI runs keep their sockets under
   `sessions/<sessionId>/sockets/` -- the nested sessionId segment
   is shorter than `containers/<bundleId>/proxy-control.sock`, so
   the limit is not exceeded for that mode.

## 5. Path helpers (`src/config/paths.ts`)

### Added

```typescript
/** `workflow-runs/<wfId>/containers/` */
export function getWorkflowContainersDir(workflowId: string): string;

/** `workflow-runs/<wfId>/containers/<bundleId>/` */
export function getBundleDir(workflowId: string, bundleId: BundleId): string;

/** `workflow-runs/<wfId>/containers/<bundleId>/bundle/` */
export function getBundleInnerDir(workflowId: string, bundleId: BundleId): string;

/** `workflow-runs/<wfId>/containers/<bundleId>/audit.jsonl` */
export function getBundleAuditLogPath(workflowId: string, bundleId: BundleId): string;

/** `workflow-runs/<wfId>/sockets/` — flat per-workflow dir for coordinator control sockets */
export function getWorkflowSocketsDir(workflowId: string): string;

/**
 * `workflow-runs/<wfId>/sockets/<bundleId>.sock` — flattened layout
 * (not under `containers/<bundleId>/`) to stay inside the macOS
 * `sun_path` ~104-byte limit. See §4 property 5 for rationale.
 */
export function getBundleControlSocketPath(workflowId: string, bundleId: BundleId): string;

/** `workflow-runs/<wfId>/containers/<bundleId>/states/<stateSlug>/` */
export function getInvocationDir(workflowId: string, bundleId: BundleId, stateSlug: string): string;

/** `workflow-runs/<wfId>/workspace/` — already effectively exists as `instance.workspacePath`, promote to helper */
export function getWorkflowWorkspaceDir(workflowId: string): string;
```

All new helpers must honor the existing UDS path-length caveat
(`assertPathSafeSlug` + the 100-byte truncation heuristic from today's
`getWorkflowProxyControlSocketPath` JSDoc). Because the path now
includes _two_ variable segments (`workflowId` + `bundleId`), the
heuristic must run on the full assembled path, not on either id alone.

### Removed (with migration)

| Removed                                                    | Migration                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getWorkflowAuditLogPath(wfId)`                            | `getBundleAuditLogPath(wfId, bundleId)` -- callers must know which bundle's audit they want. Orchestrator passes the `bundleId` of whichever scoped bundle the current call is targeting (typically `bundlesByScope.get("primary")?.bundleId` when looking up the default-scope audit from outside a state invocation). |
| `getWorkflowProxyControlSocketPath(wfId)`                  | `getBundleControlSocketPath(wfId, bundleId)` -- same story.                                                                                                                                                                                                                                                             |
| `getWorkflowBundleDir(wfId)`                               | `getBundleInnerDir(wfId, bundleId)` -- note the inner rename; the bundle's _outer_ directory is `getBundleDir`.                                                                                                                                                                                                         |
| `getWorkflowStatesDir(wfId)`                               | Deleted; replaced by per-bundle `getInvocationDir(wfId, bundleId, slug)`. Tests that enumerate all states must walk `getWorkflowContainersDir(wfId)` then each bundle's `states/`.                                                                                                                                      |
| `getWorkflowStateDir(wfId, slug)`                          | `getInvocationDir(wfId, bundleId, slug)`                                                                                                                                                                                                                                                                                |
| `getWorkflowStateLogPath` / `getWorkflowStateMetadataPath` | Derive from `getInvocationDir` + `SESSION_LOG_FILENAME` / `SESSION_METADATA_FILENAME`.                                                                                                                                                                                                                                  |

### Unchanged

- `getSessionDir`, `getSessionSandboxDir`, `getSessionAuditLogPath`,
  `getSessionLogPath`, `getSessionEscalationDir`, `getSessionSocketsDir`,
  etc. These remain the standalone-CLI layout.
- `getWorkflowRunDir`, `getWorkflowRunsDir` remain (workflow-root helpers).

## 6. DockerInfrastructure changes

`DockerInfrastructure.sessionId` (today holds either the single-session
sessionId or the workflowId depending on caller -- see §1) is renamed
to `bundleId: BundleId` and always carries a freshly-minted `BundleId`
independent of any session or workflow identity. Consumers:

- `DockerAgentSession.initialize()` reads `infra.bundleId` only for
  labels and log messages -- the agent process does not see it.
- `createDockerInfrastructure()` uses `infra.bundleId[0:12]` as the
  container-name suffix (replacing today's
  `core.sessionId.substring(0, 12)` at line 476).
- The `ironcurtain.bundle=<bundleId>` Docker label replaces today's
  `ironcurtain.session=<id>` label (see §7).
- `getWorkflowProxyControlSocketPath(workflowId)` callers become
  `getBundleControlSocketPath(workflowId, infra.bundleId)`.

The standalone path (`createDockerSession()` at `src/session/index.ts:155`)
does **not** mint a second UUID: `bundleId === sessionId` for single-session
runs (see §2.1 invariant). The session's `SessionId` is cast to `BundleId`
at the factory boundary (`infra.bundleId = sessionId as unknown as BundleId`),
so the deterministic `ironcurtain-<sessionId[0:12]>` container name still
drops out of `bundleId[0:12]` and `removeStaleContainer`'s prior-crash
recovery path continues to work. The factory writes nothing under a
`BundleId`-keyed directory for standalone runs; the session tree
(`sessions/<sessionId>/`) is the only writable surface in that mode. The
two modes differ deliberately:

- Workflow mode: `BundleId` is a fresh UUID and names on-disk artifacts
  (`workflow-runs/<wfId>/containers/<bundleId>/`).
- Standalone mode: `BundleId` equals the `SessionId` by convention; the
  on-disk tree uses `SessionId`, the Docker container name derives from
  `bundleId[0:12]` which is just the first 12 chars of the session UUID.

## 6.5 Scoped bundle lifecycle

Step 6 introduces `containerScope`: each unique scope value used by a
workflow's states becomes its own bundle, lazily created. The lifecycle
rules:

- **Storage.** `WorkflowInstance.bundlesByScope: Map<string, DockerInfrastructure>`,
  keyed on the scope string (literal `"primary"`, `"env-python3"`, etc.).
  Each bundle is inserted on the first `executeAgentState` call that
  resolves to its scope; later states with the same scope borrow the
  existing entry rather than minting a new one. Bundles are created in
  the order their scopes are first visited; the map's size equals the
  number of distinct scopes visited so far.

- **No per-state teardown.** Scoped bundles live for the full workflow
  run, like the primary bundle did before this primitive existed. There
  is no `try { ... } finally { destroyInfra(bundle) }` around individual
  `executeAgentState` calls -- entries in `bundlesByScope` are created
  lazily and destroyed only at workflow terminal. This is a real
  simplification relative to the prior "transient bundle" model: no
  per-state rollback path, no delete-before-destroy ordering concern, no
  "entry survives until instance-level teardown" edge case.

- **Terminal teardown (instance-level).** The existing
  `destroyWorkflowInfrastructure(instance)` helper walks
  `instance.bundlesByScope.values()` and destroys each bundle in
  parallel via `Promise.allSettled`. Failures are collected into a
  single log line rather than short-circuiting. All callers of
  `destroyWorkflowInfrastructure` (abort, shutdownAll,
  handleWorkflowComplete) pick up the new behavior transparently. No
  special-casing of the `"primary"` entry -- it is destroyed the same
  way as any other scope.

- **Ordering.** Teardowns across scopes run in parallel. No dependency
  between bundles: each owns its own sockets, containers, and
  coordinator subprocess.

- **Leak diagnostics.** After `destroyWorkflowInfrastructure` completes,
  the helper clears the map and asserts `instance.bundlesByScope.size === 0`.
  Any residual entry is thrown as a leak assertion so the invariant
  violation surfaces as a synchronous error and the underlying cause bug
  is never silently swallowed.

## 6.7 Control-socket routing across bundles

Each bundle -- primary or transient -- runs its own coordinator
subprocess with its own control socket at
`getBundleControlSocketPath(workflowId, bundleId)`. Operations that
today hit "the workflow's coordinator" must now specify which
bundle's coordinator they target.

- **`cyclePolicy(instance, persona, bundle: DockerInfrastructure)`** takes
  the full bundle as its third argument and computes its own socket path
  via `getBundleControlSocketPath(instance.id, bundle.bundleId)`. This
  matches how `defaultLoadPolicyRpc` at
  `src/workflow/orchestrator.ts:1627` already accepts a resolved
  `socketPath` -- the "callers don't pre-compute" pattern. The call
  site today at `orchestrator.ts:1160` reads
  `cyclePolicy(instance, stateConfig.persona)`; post-refactor it becomes
  `cyclePolicy(instance, stateConfig.persona, bundle)` where `bundle` is
  the one picked via scope lookup at the top of `executeAgentState`
  (§3 "Bundle selection at state entry", step 3/4). The default-scope
  case and the scoped-bundle case go through the same code path --
  `bundle` is whatever `bundlesByScope.get(scope)` returned (after
  minting if absent). Policy is still cycled once at state entry;
  every bundle needs its persona-tagged policy loaded before the agent runs.

- **Other control-socket consumers.** Any other orchestrator-initiated
  RPC to a coordinator (none today beyond `loadPolicy`, but Step 7
  resume may add more) takes the same `bundleId` argument and routes
  accordingly.

The helper signature change ripples into `machine-builder.ts` where
the `cyclePolicy` action is invoked: the action now reads the target
bundle from the current step's context via the scope lookup in §3
(the bundle is the same object the session will borrow, so the two
code paths agree on which coordinator to target).

## 7. Docker label scheme

Today: every container carries `ironcurtain.session=<id>` and nothing
else (`src/docker/docker-manager.ts:69`). That label means different
things for single-session vs. shared-container workflows, which the
resume path (Step 7) will not be able to disambiguate.

New scheme (three labels per container):

```
ironcurtain.bundle=<bundleId>     # always present, primary key for docker query
ironcurtain.workflow=<workflowId> # only on workflow bundles
ironcurtain.scope=<scopeName>     # only on workflow bundles — the literal scope string (e.g., "primary", "env-python3")
```

For standalone / CLI / PTY sessions: only `ironcurtain.bundle=<bundleId>`.
No workflow or scope label.

Scope strings are user-authored YAML content, not secrets -- exposing
them in Docker metadata is fine, and the diagnostic value
(`docker ps --filter label=ironcurtain.scope=env-a`) is real.

Resume reclamation query (Step 7):

```
docker ps -a --filter label=ironcurtain.workflow=<workflowId>
```

Returns **every** bundle the workflow owns -- one per distinct scope
ever visited. Resume walks the matches, reads `ironcurtain.scope` off
each container, and rebuilds `bundlesByScope` from the resulting
(scope, container) pairs. The `"primary"` scope has no privileged
treatment at the query layer; it is simply one entry among the rest.

Orphan sweep: after resume reconciles `bundlesByScope` against live
workflows, any container carrying `ironcurtain.workflow=<wfId>` whose
`wfId` does not correspond to an active workflow is an orphan and is
gc'd. No role/scope filter is required -- unclaimed workflow id is
the signal.

## 8. Logger singleton interaction

The retargeting semantics added in Step 5 (`src/logger.ts`) exist
because per-state sessions need to redirect `session.log` mid-workflow
between per-state directories. Under the new model those artifacts
live at `containers/<bundleId>/states/<slug>/session.log`. The
retarget is still per-state-visit, not per-bundle: two re-entries of
the same state within the same bundle still need distinct
`session.log` files. The retarget stays.

The only consumer change is the path the retarget points at: today
`getWorkflowStateLogPath(wfId, slug)`, post-refactor
`resolve(getInvocationDir(wfId, bundleId, slug), SESSION_LOG_FILENAME)`.
`session/index.ts:buildSessionConfig` computes this path and calls
`logger.setup({ logFilePath })` as today.

No behavioral change; only path plumbing.

## 8.5 Agent conversation state under shared bundles

Today the adapter stores one `{sessionId}.jsonl` per Docker session in
`conversationStateDir` (Claude Code's `projects/<cwd-hash>/` bind-mount).
The "prior conversation exists" probe at
`src/docker/docker-agent-session.ts:152-154` checks for that file to
decide whether to emit `--session-id` (first turn, file absent) or
`--resume` (subsequent turn, file present).

Under the new model `conversationStateDir` is **bundle-scoped and
multi-conversation**: the shared primary bundle accumulates one `.jsonl`
per agent state that ran, each keyed on the state's
`AgentConversationId` rather than any session-level identifier.

Consequences:

- The probe key changes from `{sessionId}.jsonl` to
  `{agentConversationId}.jsonl`. This is the concrete change that
  Step 4 in §11 calls out.
- `freshSession: false` (continue) flow: orchestrator reuses the id
  stored in `context.agentConversationsByState[stateId]`, passes it
  as `SessionOptions.agentConversationId`, the adapter probes for
  `{agentConversationId}.jsonl`, finds it, emits `--resume <id>`.
- `freshSession: true` (fresh) or first visit: orchestrator mints a
  new `AgentConversationId`, passes it in, the adapter probes, does
  NOT find a matching `.jsonl`, emits `--session-id <id>` to start a
  fresh conversation with that id.
- Two states invoked back-to-back within the same bundle (same scope)
  each write their own `.jsonl`; the directory's file count grows
  monotonically with distinct states visited. This is exactly what
  Claude Code expects -- its own project history format is already
  multi-conversation per project directory. This property holds per
  bundle regardless of whether the scope is `"primary"` or something
  else: states sharing a non-default scope cohabit a
  `conversationStateDir` the same way.
- Scoped bundles (scope other than `"primary"`) have their own
  `conversationStateDir` (part of their bundle directory), accumulating
  one `.jsonl` per state invocation that ran under that scope. Because
  scoped bundles now live for the whole workflow run (§6.5), `--resume`
  works against scoped conversations the same way it does for the
  primary bundle -- there is no lifecycle asymmetry between scopes.

## 9. Scope and blast radius

| File                                                   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                    | Risk                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/session/types.ts`                                 | Add `BundleId`, `AgentConversationId` brands + creators; rename `workflowStateDir` → `invocationDir`, `stateSlug` → `invocationSlug`, `workflowInfrastructure` → `borrowBundle`; add `agentConversationId` field                                                                                                                                                                                                                          | semantic — field renames ripple to every caller                           |
| `src/docker/docker-infrastructure.ts`                  | Rename `sessionId` → `bundleId` (brand it), `sessionDir` → `bundleDir`, `sandboxDir` → `workspaceDir` on `PreContainerInfrastructure` and `DockerInfrastructure`; `createDockerInfrastructure` signature takes `BundleId` instead of `sessionId: string`                                                                                                                                                                                  | rename-heavy                                                              |
| `src/docker/docker-agent-session.ts`                   | Consume `SessionOptions.agentConversationId` (required field for Docker sessions); adapter threads it into the CLI as `--session-id` (first turn) or `--resume` (subsequent turns, detected via prior `.jsonl` presence); update `hasConversationForSession` probe to key on `agentConversationId` not `sessionId` (see §8.5)                                                                                                             | semantic — changes how resume is detected                                 |
| `src/docker/docker-manager.ts`                         | Label shape: `sessionLabel` → `bundleLabel` (string); new optional `workflowLabel`, `roleLabel` on `DockerContainerConfig`; emit all three `--label` flags                                                                                                                                                                                                                                                                                | semantic — breaks any external tooling that queries `ironcurtain.session` |
| `src/session/index.ts`                                 | Mint `BundleId` in standalone path; forward through `createDockerInfrastructure`; branch on `borrowBundle` instead of `workflowInfrastructure`                                                                                                                                                                                                                                                                                            | rename                                                                    |
| `src/config/paths.ts`                                  | Remove `getWorkflowAuditLogPath`, `getWorkflowProxyControlSocketPath`, `getWorkflowBundleDir`, `getWorkflowStatesDir`, `getWorkflowStateDir`, `getWorkflowStateLogPath`, `getWorkflowStateMetadataPath`; add the seven new helpers listed in §5                                                                                                                                                                                           | semantic but mechanical — every caller must switch                        |
| `src/workflow/types.ts`                                | Add optional `containerScope?: string` to `AgentStateDefinition`; rename `sessionsByState` → `agentConversationsByState` (brand values); replace `primaryInfra` + `transientInfra` on `WorkflowInstance` with unified `bundlesByScope: Map<string, DockerInfrastructure>`                                                                                                                                                                 | semantic                                                                  |
| `src/workflow/machine-builder.ts`                      | Rename `sessionsByState` in XState context + result extraction; brand `sessionId` in `AgentInvokeResult` to `agentConversationId: AgentConversationId`                                                                                                                                                                                                                                                                                    | rename + brand                                                            |
| `src/workflow/validate.ts`                             | Reject `containerScope` when `sharedContainer: false` (silent no-ops are footguns); enforce charset `/^[a-zA-Z0-9_-]+$/`; homogeneous-persona check for all states sharing a scope                                                                                                                                                                                                                                                        | semantic — new validator rules                                            |
| `src/workflow/orchestrator.ts`                         | `executeAgentState`: scope resolution + `bundlesByScope` Map ops (lookup, lazy mint on miss, borrow); `destroyWorkflowInfrastructure`: walk `bundlesByScope.values()` in parallel; `cyclePolicy`: use bundle from scope lookup; `createWorkflowInfrastructure` folds into the lazy-mint path (no eager workflow-start mint); use `getInvocationDir(wfId, bundleId, slug)`, read back `agentConversationId` from session, store in context | semantic — core orchestrator plumbing                                     |
| `src/workflow/cli-support.ts` (L440)                   | Rename `sessionsByState` → `agentConversationsByState` in default context                                                                                                                                                                                                                                                                                                                                                                 | rename                                                                    |
| `src/docker/pty-session.ts`                            | PTY sessions today use `ironcurtain-pty-<shortId>` where `shortId` derives from `effectiveSessionId`; switch to `ironcurtain-pty-<bundleId[0:12]>`, mint bundleId in pty session                                                                                                                                                                                                                                                          | rename                                                                    |
| `src/signal/**`, `src/web-ui/**`                       | The `sessionLabel` concept there is a **different label** (a UI-facing small integer for chat message threading, unrelated to `ironcurtain.session`). No change needed.                                                                                                                                                                                                                                                                   | unaffected                                                                |
| `test/workflow-policy-cycling.integration.test.ts`     | Every path reference goes through the new helpers; label queries updated                                                                                                                                                                                                                                                                                                                                                                  | rewrite                                                                   |
| `test/workflow-orchestrator.test.ts`                   | `sessionsByState` → `agentConversationsByState` throughout; `workflowStateDir` → `invocationDir`                                                                                                                                                                                                                                                                                                                                          | rewrite                                                                   |
| `test/session.test.ts` / `test/docker-session.test.ts` | Rename fields in fixtures                                                                                                                                                                                                                                                                                                                                                                                                                 | minor                                                                     |

Not touched: policy engine, MCP proxy subprocess, MITM proxy, CA,
orientation, agent adapters beyond the conversation-id pass-through.

### Tests that will need rewrites (flagged)

1. `test/workflow-policy-cycling.integration.test.ts` -- the canonical
   executable spec for Step 5. Expects the old layout; every path
   assertion moves.
2. Any test that asserts a Docker `docker ps --filter label=ironcurtain.session=`
   query -- none today AFAICT (grep result in prep for this doc shows
   only the session-manager/signal `sessionLabel` field, which is
   unrelated). Verify at implementation time.
3. `test/fixtures` for session options -- regenerate after field renames.

## 10. Migration

Nothing shipped relies on the old layout at user-visible scope:

- `workflow-runs/<id>/` is user-data-local; the only consumer is
  `ironcurtain workflow resume`, which for the first time in Step 7
  would have a stable-naming reason to care. Until Step 7 lands, a
  `workflow-runs/<id>/` directory written under the old layout is
  unusable for resume regardless of this refactor (checkpoint
  doesn't persist bundle info, Step 7 isn't written yet).
- `sessions/<id>/` is unchanged.

**Recommendation: no migration code.** Document `rm -rf
~/.ironcurtain/workflow-runs/` in the PR description and move on.
Anyone with in-flight workflow runs at merge time is a developer on
this branch; they will re-run.

If an adopter pushes back on this, the minimal migration is a one-shot
script (`scripts/migrate-workflow-runs-layout.ts`) that walks
`workflow-runs/*/bundle/` and rewrites to
`workflow-runs/<id>/containers/<generated-bundleId>/bundle/`. Not
worth writing unless someone asks.

## 11. Step plan

Six commits, each independently reviewable and revertable:

1. **Introduce brands and factories.** Add `BundleId` / `AgentConversationId`
   types and creators in `src/session/types.ts` (or a new
   `src/docker/bundle-id.ts`); both are v4 UUIDs via `randomUUID()`. The
   existing `SessionId` brand is retained for single-session CLI runs.
   No callers yet; pure addition. Add unit tests for the creators.

2. **Rename `DockerInfrastructure.sessionId` → `bundleId` and
   related fields; introduce the `BundleId` brand at factory
   boundaries.** Mechanical rename across `docker-infrastructure.ts`,
   `docker-agent-session.ts`, `docker-manager.ts`, `pty-session.ts`,
   `session/index.ts`, `workflow/orchestrator.ts`. No behavioral
   change; tests still pass with old path helpers. This is primarily
   mechanical, but the brand is nominal -- every callsite that
   previously passed a plain `string` will need either a brand cast
   (where the source value is authoritative, e.g., a UUID we just
   minted) or a validating constructor at the factory boundary. Plan
   for ~1 day of mechanical changes plus a focused pass on the factory
   boundary. CI should stay green at each logical checkpoint within
   the step. This is the single biggest diff -- keep the scope tight
   to minimize review cost.

3. **Add new path helpers and switch workflow callers.** Implement
   the seven helpers in §5. Update `workflow/orchestrator.ts` to use
   them (including per-bundle `audit.jsonl` and per-bundle control
   socket paths). Delete the removed helpers. Rewrite
   `test/workflow-policy-cycling.integration.test.ts` to use new
   helpers. Verify `rm -rf workflow-runs` cleanup works. (§10
   committed to no migration.)

4. **Rebrand agent conversation identity.** Rename `sessionsByState` →
   `agentConversationsByState` in `WorkflowContext`, `machine-builder`,
   `cli-support`, orchestrator. Add the `SessionOptions.agentConversationId`
   field (required for Docker sessions) and wire the orchestrator to mint
   it at state entry (§3 decision table): read from
   `context.agentConversationsByState[stateId]` when `freshSession: false`
   and a prior entry exists, otherwise mint fresh via
   `createAgentConversationId()`. On successful state completion, write
   the used id back into the map. Remove `AgentInvokeResult.sessionId`
   (orchestrator already knows the id locally). Update
   `hasConversationForSession` in `docker-agent-session.ts:152` to key on
   `agentConversationId` (not `sessionId`) so the `--session-id` vs
   `--resume` decision uses the new identity (§8.5).

5. **Relabel Docker containers.** Add `ironcurtain.bundle`,
   `ironcurtain.workflow`, `ironcurtain.scope` labels in
   `docker-manager.ts` and the factories. Remove
   `ironcurtain.session`. Add assertion in `cleanupContainers` that
   checks `ironcurtain.bundle` instead.

6. **(Follow-up, not part of this refactor: Step 6.)** With the layout
   in place, implement `containerScope` resolution + validation:
   - **Validator** (`src/workflow/validate.ts`): accept optional
     `containerScope?: string` on agent state schema, enforce charset
     `/^[a-zA-Z0-9_-]+$/`, reject `containerScope` under
     `sharedContainer: false` (error, not silent no-op), keep the
     homogeneous-persona check (all states sharing a scope must share a
     persona -- the coordinator's policy is per-bundle).
   - **Orchestrator**: replace `primaryInfra` + `transientInfra` on
     `WorkflowInstance` with `bundlesByScope: Map<string, DockerInfrastructure>`;
     implement the scope-lookup + lazy-mint flow in `executeAgentState`
     (§3 "Bundle selection at state entry"); fold the workflow-start
     eager mint into the first-`executeAgentState` path; extend
     `destroyWorkflowInfrastructure` to walk `bundlesByScope.values()`
     in parallel (§6.5); thread the scope-resolved bundle into
     `cyclePolicy` call sites (§6.7); emit `ironcurtain.scope=<scope>`
     on every bundle. No role label.
   - **Tests**: two-scope bifurcated workflow integration test (e.g.,
     `"env-python2"` vs `"env-python3"` -- good for catching cross-scope
     routing bugs); per-scope audit log + control-socket separation;
     validation rejection for `containerScope` under `sharedContainer: false`;
     legacy unset-`containerScope` workflows still behave exactly as
     before (default scope `"primary"` yields the same single bundle).
     This commit is the payoff that justifies the previous five.
