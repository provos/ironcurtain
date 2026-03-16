# Design: Ephemeral Approval Whitelisting

**Status:** Proposed (revised)
**Date:** 2026-03-16
**Author:** IronCurtain Engineering

## 1. Problem Statement

When an agent works on a task, it frequently makes the same *kind* of tool call repeatedly -- reading files from the same directory, pushing to the same git remote, fetching from the same domain. Each of these triggers an escalation that requires human approval. In a typical session, the user ends up approving 10-20 nearly identical escalations for what is conceptually the same operation with the same risk profile.

This approval fatigue has two negative consequences:

1. **Productivity loss.** The user spends more time approving than reviewing. In mux mode with multiple sessions, each session generates its own stream of escalations.

2. **Security degradation.** When every escalation feels like the same thing, users stop reading the details and rubber-stamp approvals. This defeats the purpose of human oversight.

### What we want

When a user approves an escalation, they should be able to optionally whitelist the *pattern* behind that escalation for the remainder of the session. Future tool calls matching the same pattern should be auto-allowed without further prompting. The whitelist is ephemeral (in-memory, session-scoped) and fully audited.

### The mux mode constraint

IronCurtain has a **mux mode** (`ironcurtain mux`) where multiple PTY sessions run concurrently in a single terminal. Each session can have pending escalations at the same time. The escalation listener (both standalone and mux-integrated) assigns monotonically increasing **display numbers** to pending escalations across all sessions. The existing command syntax is:

```
/approve <N>     -- approve escalation number N
/approve all     -- approve all pending escalations
/deny <N>        -- deny escalation number N
/deny all        -- deny all pending escalations
```

The `N` in `/approve N` identifies **which pending escalation** to approve. This number is already taken and cannot be repurposed for whitelist pattern selection. Any whitelisting UX must avoid collision with this established numbering.

## 2. How Escalations Currently Work

### 2.1 Single-session mode (Code Mode / non-PTY Docker)

In `AgentSession` (Code Mode) and `DockerAgentSession` (batch Docker), the session owns one escalation directory. The flow:

1. `mcp-proxy-server.ts`'s `handleCallTool()` evaluates policy; if `escalate`, it calls `waitForEscalationDecision()`.
2. `waitForEscalationDecision()` writes `request-{id}.json` to the escalation directory and polls for `response-{id}.json`.
3. The session's escalation watcher (or `AgentSession`'s poll loop) detects the request file, fires `onEscalation`, and the transport displays a banner.
4. The user types `/approve` or `/deny`. The transport calls `session.resolveEscalation(id, decision)`, which writes `response-{id}.json`.
5. The proxy picks up the response, cleans up files, and proceeds.

**Current divergence (Flaw 3):** `AgentSession` reimplements escalation watching with its own `startEscalationWatcher()` / `pollEscalationDirectory()` / `checkEscalationExpiry()` methods and writes response files directly with `writeFileSync`. `DockerAgentSession` uses `createEscalationWatcher()`. This split means any IPC protocol extension (like whitelist support) must be implemented in two places.

In `CliTransport`, `/approve` has no argument -- it resolves the single pending escalation returned by `session.getPendingEscalation()`.

### 2.2 Mux mode (PTY sessions)

In mux mode, each PTY session is an independent `ironcurtain start --pty` child process. Escalations are managed by `MuxEscalationManager`, which wraps `ListenerState` from `src/escalation/listener-state.ts`.

**Key data structures:**

- `ListenerState.sessions`: `Map<string, ActiveSession>` -- active PTY sessions keyed by session ID, each with a `displayNumber`.
- `ListenerState.pendingEscalations`: `Map<number, PendingEscalation>` -- pending escalations keyed by **display number** (monotonically increasing integer starting at 1).
- `ListenerState.nextEscalationNumber`: counter for the next display number.

When an escalation arrives from any session, `addEscalation()` assigns it the next display number. When the user types `/approve 3`, the mux looks up display number 3 in `pendingEscalations`, finds the corresponding session's watcher, and calls `watcher.resolve(escalationId, decision)`.

**The display number is a global counter across all sessions.** It is NOT a session-local number, NOT a tool call counter, and NOT reusable.

### 2.3 Standalone escalation listener

`ironcurtain escalation-listener` is the non-mux equivalent. It polls the PTY registry directory for active sessions and uses the same `ListenerState` and `EscalationWatcher` modules. The `/approve N` syntax is identical.

### 2.4 Auto-approver

The auto-approver (`auto-approver.ts`) is an LLM-based intent matcher that runs in the proxy process. It can auto-approve escalations when the user's most recent message clearly authorizes the action. It uses `user-context.json` written by the session (or mux trusted input). The auto-approver can only return `approve` or `escalate` (never deny).

The approval whitelist is complementary to the auto-approver:
- Auto-approver: "did the user just ask for this specific action?" (intent-based, per-message)
- Whitelist: "has the user already approved this category of action?" (pattern-based, session-scoped)

### 2.5 In-process mode (TrustedProcess)

`TrustedProcess` (`src/trusted-process/index.ts`) is the in-process alternative used by integration tests and the direct-tool-call fallback. It orchestrates PolicyEngine, MCPClientManager, EscalationHandler, and AuditLog. Escalations use a **direct callback**: `onEscalation?: EscalationPromptFn` which receives the `ToolCallRequest`, reason, and context, and returns `'approved' | 'denied'`. There is no file-based IPC in this path; escalation decisions go straight from the callback return value to the tool call flow.

The whitelist must work in this mode too. Since the callback is synchronous from the perspective of `handleToolCall()`, the whitelist check can be inserted before the callback is invoked, and the callback's return value can carry whitelist intent.

## 3. Approval Whitelisting Design

### 3.1 UX: The `/approve+` syntax

The whitelisting mechanism uses a **modifier suffix** on the existing approve command:

```
/approve 3       -- approve escalation #3 (existing behavior, unchanged)
/approve+ 3      -- approve escalation #3 AND whitelist the selected pattern
/approve all     -- approve all pending escalations (existing, unchanged)
/approve+ all    -- approve all pending AND whitelist each pattern
```

The `+` suffix is a natural modifier meaning "approve plus remember." It avoids any conflict with the existing `N` argument because it modifies the command name itself, not the argument.

The deny command has no whitelist variant -- denying and remembering makes no sense in a default-deny system (unmatched patterns are already denied).

There is intentionally no `/whitelist` management command in the initial version. The whitelist is session-scoped and ephemeral -- it evaporates when the session ends. If users need to inspect active whitelist entries, that can be added later as `/whitelist list` without conflicting with existing commands.

**UX in each context:**

| Context | `/approve+ N` behavior |
|---|---|
| Mux command mode | Approves escalation #N, shows candidate patterns, user selects which to whitelist |
| Standalone escalation listener | Same as mux |
| CliTransport (single session) | `/approve+` (no N needed) approves and whitelists |

### 3.2 Pattern extraction: extract once, display, then whitelist

**Critical design principle (Flaw 1 fix):** Pattern extraction happens ONCE, on the proxy side, at escalation time. The extracted candidates are included in the IPC request file so the user sees exactly what will be whitelisted. The user's selection is returned as an index into the candidates array. There is no second extraction.

The flow:

1. Policy engine returns `escalate`.
2. **Proxy extracts whitelist candidates** from the tool call's annotation and arguments, producing a `WhitelistCandidate[]` array.
3. The candidates are included in the `request-{id}.json` file as `whitelistCandidates`.
4. The session/transport reads the request file and displays the candidates to the user alongside the escalation banner.
5. When the user types `/approve+ N`, the transport writes `{ "decision": "approved", "whitelistSelection": 0 }` (index into candidates array) in the response file.
6. The proxy reads the response, looks up the candidate by index, and adds the pattern to its in-memory whitelist.

**Why extract on the proxy side:** The proxy has access to `ToolAnnotation` and `ArgumentRole` metadata. The session/transport does not, and should not -- it is on the other side of the IPC boundary.

**Why include candidates in the request:** This eliminates drift between what the user saw and what gets whitelisted. The proxy extracts once; the index in the response refers back to exactly the array the user was shown.

### 3.3 Pattern extraction algorithm

A whitelist candidate is derived from the **role(s) that actually caused the escalation**, not from all resource-identifier roles on the tool. The policy engine evaluates each role independently and the most restrictive result wins (deny > escalate > allow). When the winning result is `escalate`, the engine knows exactly which role(s) produced that outcome. Only those escalated roles should generate whitelist constraints.

**Why only escalated roles:** Consider `move_file` with `read-path` on source and `write-path` on destination. If the source is inside the sandbox (auto-allowed by sandbox containment) but the destination is outside (escalated by compiled rules), only the `write-path` role caused the escalation. Whitelisting a directory pattern for `read-path` would be meaningless -- that role was never the problem. Worse, it would give the user a false sense that they're constraining the whitelist to a specific source directory, when in fact the risk was always about the destination.

**Escalated role tracking:** The `EvaluationResult` returned by `PolicyEngine.evaluate()` is extended with an optional `escalatedRoles` field that carries the role(s) whose independent evaluation produced the `escalate` outcome. Structural escalations (e.g., `structural-domain-escalate`) also populate this field with the specific role that triggered the domain gate. See section 4.1 for the type change.

The extraction algorithm:

1. Receive the `EvaluationResult` from the policy engine, which includes `escalatedRoles` when `decision === 'escalate'`.
2. For each role in `escalatedRoles`, extract the canonicalized value from the tool call arguments using the annotation.
3. Group by role category and generalize:
   - **path roles** (`read-path`, `write-path`, `delete-path`): extract the containing directory (parent of the path), producing a "within directory" constraint.
   - **url roles** (`fetch-url`, `git-remote-url`): extract the domain, producing a "domain" constraint.
   - **identifier roles** (`github-owner`, `github-repo`): extract the exact value (case-folded).
4. Combine into a `WhitelistCandidate` that captures the server, tool, the escalated roles, and role-specific constraints.

**Fallback when `escalatedRoles` is absent:** For defensive robustness, if `escalatedRoles` is undefined (e.g., a future structural escalation that doesn't populate the field), the extraction falls back to all resource-identifier roles. This preserves backward safety -- the candidate is overly broad rather than silently empty.

**Trusted servers never escalate:** Trusted servers bypass all policy evaluation and always return `allow` (rule `trusted-server`). Pattern extraction never needs to handle the case of a null annotation from a trusted server, because the `escalate` code path is unreachable for them.

**History-rewriting roles (Flaw 9):** Roles `write-history` and `delete-history` are excluded from directory-level whitelisting even when they appear in `escalatedRoles`. These roles represent operations that rewrite git history (rebase, reset, force-push) or delete refs (branch delete, tag delete). Approving one `git_reset` in a directory should NOT auto-approve all future resets in that directory -- each is a distinct, dangerous operation. When the only escalated roles are history-rewriting roles, the candidate has zero constraints (meaning it matches the exact server/tool pair only, without directory generalization). The escalation banner warns the user accordingly.

### 3.4 Zero-constraint patterns and side-effectful tools (Flaw 7)

When the escalated roles have no resource-identifier arguments (or only history-rewriting roles), the extracted candidate has an empty `constraints` array. This means it matches ANY call to that exact server/tool combination.

**Security concern:** For side-effectful tools like `github/create_issue`, this means approving one issue creation would auto-allow ALL future issue creations. This is dangerous.

**Mitigation:** When extracting candidates for a tool where `annotation.sideEffects === true` and the candidate has zero constraints, the proxy:
1. Still includes the candidate in `whitelistCandidates` (the user can choose to whitelist it).
2. Adds a `warning` field to the candidate: `"Whitelisting will auto-approve ALL future calls to this tool for this session."`.
3. The transport displays this warning prominently in the escalation banner.

This makes the risk explicit. The user makes an informed choice.

### 3.5 Pattern matching rules

A whitelist pattern matches a tool call when ALL of the following hold:

1. **Server name** matches exactly.
2. **Tool name** matches exactly.
3. **Every constraint** in the pattern is satisfied by the call's arguments:
   - `directory` constraint: the call's path for that role is within the whitelisted directory (using `isWithinDirectory` with symlink resolution -- see Flaw 6 for export).
   - `domain` constraint: the call's URL for that role resolves to the whitelisted domain (using existing `extractDomainForRole`).
   - `exact` constraint: the call's value for that role matches exactly (case-insensitive for identifier roles).

A pattern with zero constraints matches any call to that server/tool.

**Multiple patterns** can exist for the same server/tool. A call matches if ANY pattern matches (OR semantics across patterns). This allows whitelisting writes to both `/home/user/Documents` and `/home/user/Downloads` via two separate approvals.

### 3.6 Security invariants

1. **Only `escalate` -> `allow`.** The whitelist is consulted ONLY when the policy engine returns `escalate`. It NEVER overrides `deny` decisions. Structural denials (protected paths, unknown tools) and compiled rule denials are absolute.

2. **Ephemeral, session-scoped.** Whitelist entries live in memory only, bound to a specific proxy process. They are never persisted to disk. When the session ends, the whitelist evaporates.

3. **Full audit trail.** Every whitelist-approved call is logged to the audit log with a distinct marker (`whitelistApproved: true`, `whitelistPatternId: string`). The original escalation reason is preserved.

4. **Explicit opt-in.** Whitelisting only happens when the user types `/approve+`. Plain `/approve` never creates whitelist entries.

5. **Directory containment, not path prefix.** Path constraints use directory containment with symlink resolution (`isWithinDirectory`), not string prefix matching. This prevents symlink escape attacks.

6. **No wildcard expansion.** The pattern extracted is the minimal generalization of the approved call. It is NOT a glob, NOT a regex. The only generalizations are: path -> containing directory, URL -> domain.

7. **Deny takes precedence.** If a compiled rule explicitly denies a call (not default-deny), the whitelist is never consulted. The evaluation order guarantees this.

8. **Extract-once guarantee.** The pattern the user saw in the escalation banner IS the pattern that gets whitelisted. No re-extraction on the proxy side after the response is read.

9. **History roles excluded from directory generalization.** `write-history` and `delete-history` roles never produce directory-level constraints.

### 3.7 Where the whitelist lives in the evaluation pipeline

The whitelist check is a new phase in `handleCallTool()` (proxy mode) and `handleToolCall()` (in-process mode), inserted between the policy engine evaluation and the escalation flow:

```
Policy Engine evaluation
    |
    v
decision == 'deny'  ->  return denied (whitelist NOT consulted)
    |
decision == 'allow' ->  proceed to tool call
    |
decision == 'escalate'
    |
    v
Whitelist check  <----  NEW PHASE
    |
    v
match found  ->  proceed to tool call (audit: whitelistApproved=true)
    |
no match
    |
    v
Extract whitelist candidates  <----  NEW (uses escalatedRoles from evaluation)
    |
    v
Auto-approver (if enabled)
    |
    v
Human escalation (file-based IPC in proxy, callback in TrustedProcess)
    |
    v
On approved response with whitelistSelection:
  -> look up candidate by index, add to whitelist
```

This placement ensures:
- Denials are never overridden.
- The whitelist runs before the auto-approver and before human escalation, avoiding unnecessary LLM calls and user prompts.
- Candidates are extracted after the whitelist check fails (not before), avoiding wasted work on already-whitelisted calls.
- The whitelist runs in the process that has access to annotations (proxy or TrustedProcess), not in the session/transport layer.

### 3.8 Communication protocol: file-based IPC (proxy mode)

**Current request file format (`EscalationFileRequest`):**
```typescript
interface EscalationFileRequest {
  escalationId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  context?: Record<string, string>;
}
```

**Extended request file format:**
```typescript
interface EscalationFileRequest {
  escalationId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  context?: Record<string, string>;
  /** Whitelist candidates extracted from this escalation's annotation. */
  whitelistCandidates?: WhitelistCandidateIpc[];
}
```

Where `WhitelistCandidateIpc` is a JSON-serializable description of the pattern:
```typescript
interface WhitelistCandidateIpc {
  /** Human-readable summary, e.g. "Allow write_file within /home/user/Documents" */
  description: string;
  /** Warning for zero-constraint side-effectful patterns. */
  warning?: string;
}
```

The full constraint details are NOT serialized into the IPC file. They stay in the proxy process's memory, indexed by escalation ID. The IPC file contains only the human-readable descriptions. The response carries an index back into the proxy's in-memory candidate array.

**Current response file format:**
```json
{ "decision": "approved" }
```

**Extended response file format:**
```json
{ "decision": "approved", "whitelistSelection": 0 }
```

`whitelistSelection` is the 0-based index into the `whitelistCandidates` array from the request. When absent, no pattern is whitelisted (backward compatible).

### 3.9 Communication protocol: in-process mode (TrustedProcess, Flaw 4)

`TrustedProcess.handleToolCall()` uses `EscalationPromptFn` for escalations:

```typescript
// Current:
export type EscalationPromptFn = (
  request: ToolCallRequest,
  reason: string,
  context?: Readonly<Record<string, string>>,
) => Promise<'approved' | 'denied'>;
```

**Extended:**
```typescript
/** Result from an escalation callback, optionally including whitelist selection. */
export interface EscalationResult {
  readonly decision: 'approved' | 'denied';
  /** Index into whitelistCandidates to whitelist. Absent = no whitelisting. */
  readonly whitelistSelection?: number;
}

export type EscalationPromptFn = (
  request: ToolCallRequest,
  reason: string,
  context?: Readonly<Record<string, string>>,
  /** Whitelist candidates for display to the user. */
  whitelistCandidates?: readonly WhitelistCandidateIpc[],
) => Promise<EscalationResult>;
```

**Backward compatibility:** The old return type `'approved' | 'denied'` is a string, not an `EscalationResult`. Callers of the old API (tests, `EscalationHandler.prompt()`) need updating. To ease migration:
- `EscalationHandler.prompt()` returns `EscalationResult` with just `{ decision }`.
- The `handleToolCall` code normalizes string returns to `{ decision: string }` for any old callbacks.

The `ApprovalWhitelist` instance in `TrustedProcess` is the same class used in proxy mode. `TrustedProcess` creates one in its constructor and uses it in `handleToolCall()`.

### 3.10 Refactoring `AgentSession` to use `EscalationWatcher` (Flaw 3)

`AgentSession` currently reimplements escalation watching inline:
- `startEscalationWatcher()` / `pollEscalationDirectory()` / `checkEscalationExpiry()` -- ~70 lines duplicating `escalation-watcher.ts`.
- `resolveEscalation()` writes response files with `writeFileSync` directly, not `atomicWriteJsonSync`, and without the stale-detection logic in `EscalationWatcher.resolve()`.

**Refactoring plan:** Replace the inline implementation with `createEscalationWatcher()`, matching `DockerAgentSession`. This consolidation means:

1. `AgentSession` gains an `escalationWatcher: EscalationWatcher | null` field (like `DockerAgentSession`).
2. `startEscalationWatcher()` is replaced by `createEscalationWatcher(this.escalationDir, events)` + `.start()`.
3. `resolveEscalation()` delegates to `this.escalationWatcher.resolve(id, decision)`.
4. `pollEscalationDirectory()`, `checkEscalationExpiry()`, `extractEscalationId()`, `seenEscalationIds` are all removed.
5. `pendingEscalation` is accessed via `this.escalationWatcher.getPending()`.

After refactoring, extending the IPC protocol for whitelisting only needs to happen in `EscalationWatcher.resolve()` -- once, not twice.

### 3.11 Widening `readEscalationResponse()` and `waitForEscalationDecision()` (Flaw 2)

**Current signatures in `mcp-proxy-server.ts`:**
```typescript
function readEscalationResponse(responsePath: string): 'approved' | 'denied' | undefined;
async function waitForEscalationDecision(escalationDir: string, request: EscalationFileRequest): Promise<'approved' | 'denied'>;
```

These discard any extra fields from the response JSON. The fix:

```typescript
/** Parsed escalation response with optional whitelist selection. */
interface EscalationResponseData {
  readonly decision: 'approved' | 'denied';
  readonly whitelistSelection?: number;
}

function readEscalationResponse(responsePath: string): EscalationResponseData | undefined;
async function waitForEscalationDecision(escalationDir: string, request: EscalationFileRequest): Promise<EscalationResponseData>;
```

The proxy holds a module-level `pendingWhitelistCandidates: Map<string, WhitelistPattern[]>` keyed by escalation ID (not on `CallToolDeps` -- it's internal mutable state acting as a side-channel between writing the escalation request and reading the response). After writing the request file with candidates, the proxy stores the full pattern objects. When the response comes back with `whitelistSelection`, it looks up the candidate by index from this map.

### 3.12 Command parsing: prefix-based, not exact match (Flaw 5)

**Current `CliTransport.handleSlashCommand()`:**
```typescript
switch (input) {
  case '/approve':
  case '/deny':
    this.handleEscalationCommand(input, session);
    return true;
  // ...
}
```

This uses exact string matching. `/approve+` does not match. The fix: parse the command prefix and extract a modifier.

```typescript
private handleSlashCommand(input: string, session: Session, onQuit: () => void): boolean {
  const [command, ...args] = input.split(/\s+/);

  // Extract modifier suffix: "/approve+" -> base="approve", modifier="+"
  const modifierMatch = command.match(/^\/(\w+)(\+)?$/);
  if (!modifierMatch) return false;
  const base = modifierMatch[1];
  const whitelist = modifierMatch[2] === '+';

  switch (base) {
    case 'quit':
    case 'exit':
      onQuit();
      return true;
    case 'logs':
      this.displayDiagnosticLog(session.getDiagnosticLog());
      return true;
    case 'budget':
      this.displayBudgetStatus(session.getBudgetStatus());
      return true;
    case 'approve':
    case 'deny':
      this.handleEscalationCommand(base, session, whitelist);
      return true;
    default:
      return false;
  }
}
```

**Mux mode (`mux-input-handler.ts`):** The mux already parses commands by splitting on whitespace and extracting the first word:
```typescript
const parts = text.slice(1).split(/\s+/);
const command = parts[0].toLowerCase();
const args = parts.slice(1);
return { kind: 'command', command, args };
```

The command `approve+` would arrive as `command = 'approve+'`. The `handleCommand()` in `mux-app.ts` uses `switch (command)` with `case 'approve':`. This needs to be updated to strip the `+` suffix:

```typescript
// In mux-app.ts handleCommand():
const whitelist = command.endsWith('+');
const baseCommand = whitelist ? command.slice(0, -1) : command;

switch (baseCommand) {
  case 'approve':
  case 'deny':
    // ... pass whitelist flag to escalationManager.resolve()
}
```

**Standalone escalation listener (`listener-command.ts`):** Same pattern. The `handleCommand()` function already splits on whitespace and lowercases the command. Apply the same `+` suffix stripping.

### 3.13 Multi-proxy per session in Docker mode (Flaw 11)

In Docker mode, each `DockerAgentSession` may spawn multiple MCP proxy processes (one per `SERVER_FILTER`). Each proxy is an independent process with its own `PolicyEngine` and its own whitelist. When the user approves an escalation from one proxy, the whitelist pattern is added to THAT proxy's memory only -- the other proxies do not see it.

This is acceptable because:
1. Each proxy serves a different MCP server (e.g., one for filesystem, one for git). Cross-server whitelisting is not meaningful.
2. The whitelist matches on `(serverName, toolName)`. A pattern whitelisted in the filesystem proxy would never match a tool call in the git proxy anyway.
3. There is no need for cross-proxy communication. The session-scoped lifetime is the session of the proxy process, which aligns with the Docker session.

**No design change needed.** The per-process whitelist naturally scopes to the right proxy.

### 3.14 `isWithinDirectory` export (Flaw 6)

`isWithinDirectory` in `policy-engine.ts` is currently a module-private function. The whitelist matching code in `approval-whitelist.ts` needs it. Two options:

**Option A (preferred):** Move `isWithinDirectory` to `src/types/argument-roles.ts` alongside `resolveRealPath` (which it depends on). Both are path-related utilities, not policy-engine-specific logic.

**Option B:** Export from `policy-engine.ts`. This creates a dependency from the whitelist module to the policy engine, which is undesirable -- the whitelist should be a peer, not a dependent.

We choose Option A.

### 3.15 Evaluation order clarification (Flaw 10)

The actual evaluation order in the code is:

1. **Structural invariants** (hardcoded in `PolicyEngine.evaluateStructuralInvariants()`):
   - Protected path check (deny)
   - Introspection tool allow
   - Filesystem sandbox containment (allow/partial)
   - Untrusted domain gate (escalate)
   - Unknown tool denial (deny)

2. **Compiled rule evaluation** (`PolicyEngine.evaluateCompiledRules()`):
   - Per-role evaluation, first-match-wins per role
   - Most-restrictive-wins across roles (deny > escalate > allow)
   - Default deny if no rule matches

3. **Whitelist check** (NEW -- in `handleCallTool()` / `handleToolCall()`, not in PolicyEngine):
   - Only when evaluation returns `escalate`
   - Match against in-memory patterns

4. **Auto-approver** (existing, in proxy/TrustedProcess):
   - Only when whitelist does not match

5. **Human escalation** (existing):
   - File-based IPC (proxy) or callback (TrustedProcess)

The whitelist is NOT part of the PolicyEngine. It lives in the call handler (`handleCallTool` / `handleToolCall`), after policy evaluation, before the escalation flow. This is intentional: the PolicyEngine is a pure evaluator with no mutable state; the whitelist is mutable session state.

### 3.16 User feedback at approval time (Flaw 8)

When the user types `/approve+ N`, the transport should:

1. Display the candidate descriptions from the escalation request (already shown in the banner).
2. Confirm which pattern was selected (for single-candidate escalations, automatic; for multi-candidate, show a numbered list and accept a sub-selection -- deferred to a future enhancement).
3. Display a confirmation message: `"Escalation approved. Whitelisted: <description>"`.

For the initial implementation, when there is exactly one candidate, `/approve+` auto-selects it. When there are multiple candidates (multi-argument tools), all candidates are whitelisted as a single combined pattern. A future enhancement can add sub-selection.

## 4. Type Definitions

### 4.1 Extended `EvaluationResult` (in `src/trusted-process/policy-types.ts`)

```typescript
import type { PolicyDecisionStatus } from '../types/mcp.js';
import type { ArgumentRole } from '../types/argument-roles.js';

export interface EvaluationResult {
  decision: PolicyDecisionStatus;
  rule: string;
  reason: string;
  /**
   * When decision is 'escalate', the role(s) whose independent evaluation
   * produced the escalation. Used by whitelist candidate extraction to
   * generate constraints only for the roles that actually caused the
   * escalation, not all resource-identifier roles on the tool.
   *
   * Populated by:
   * - evaluateCompiledRules(): roles whose per-role evaluation was 'escalate'
   *   and whose severity matched the final most-restrictive result.
   * - evaluateStructuralInvariants(): the specific role that triggered
   *   structural-domain-escalate.
   *
   * Undefined for non-escalate decisions and as a defensive fallback
   * (extraction falls back to all resource-identifier roles).
   */
  escalatedRoles?: readonly ArgumentRole[];
}
```

The engine populates `escalatedRoles` in two places:

1. **`evaluateCompiledRules()`**: When iterating roles, if the most restrictive result is `escalate`, collect all roles that independently evaluated to `escalate` (there may be more than one). This is a minor bookkeeping change in the existing `for (const role of rolesToEvaluate)` loop.

2. **`evaluateStructuralInvariants()`**: When the `structural-domain-escalate` rule fires for a specific URL arg, the `EvaluationResult` includes the role from the `extractAnnotatedUrls()` entry that failed the domain allowlist check.

### 4.2 Whitelist types (new file: `src/trusted-process/approval-whitelist.ts`)

```typescript
/**
 * Ephemeral approval whitelist -- session-scoped in-memory store
 * of approval patterns extracted from user-approved escalations.
 *
 * Security invariant: only converts escalate -> allow, never overrides deny.
 * Entries are never persisted to disk.
 */

import type { ArgumentRole } from '../types/argument-roles.js';
import type { ToolAnnotation } from '../pipeline/types.js';

/** Unique identifier for a whitelist entry, for audit trail linkage. */
export type WhitelistEntryId = string & { readonly __brand: 'WhitelistEntryId' };

/**
 * A constraint on a single argument role's value.
 * Discriminated union by `kind`.
 */
export type WhitelistConstraint =
  | {
      readonly kind: 'directory';
      readonly role: ArgumentRole;
      /** Resolved real path of the containing directory. */
      readonly directory: string;
    }
  | {
      readonly kind: 'domain';
      readonly role: ArgumentRole;
      /** Extracted domain (e.g., "github.com"). */
      readonly domain: string;
    }
  | {
      readonly kind: 'exact';
      readonly role: ArgumentRole;
      /** Exact value to match (case-insensitive for identifier roles). */
      readonly value: string;
    };

/**
 * A whitelist pattern extracted from an approved escalation.
 * Matches future calls to the same server/tool with arguments
 * satisfying all constraints.
 */
export interface WhitelistPattern {
  readonly id: WhitelistEntryId;
  readonly serverName: string;
  readonly toolName: string;
  readonly constraints: readonly WhitelistConstraint[];
  /** ISO 8601 timestamp when the pattern was created. */
  readonly createdAt: string;
  /** The escalation ID that produced this pattern (for audit linkage). */
  readonly sourceEscalationId: string;
  /** The original escalation reason (preserved for audit). */
  readonly originalReason: string;
  /** Human-readable description of the pattern. */
  readonly description: string;
}

/**
 * JSON-serializable candidate description for IPC.
 * Included in the escalation request file so the user sees
 * exactly what will be whitelisted.
 */
export interface WhitelistCandidateIpc {
  /** Human-readable summary, e.g. "Allow write_file within /home/user/Documents" */
  readonly description: string;
  /** Warning for zero-constraint side-effectful patterns. */
  readonly warning?: string;
}

/**
 * Result of a whitelist match check.
 */
export type WhitelistMatchResult =
  | { readonly matched: false }
  | { readonly matched: true; readonly patternId: WhitelistEntryId; readonly pattern: WhitelistPattern };

/**
 * The ephemeral whitelist store. Session-scoped, in-memory only.
 *
 * Thread safety: the proxy is single-threaded (Node.js event loop),
 * so no synchronization is needed.
 */
export interface ApprovalWhitelist {
  /**
   * Adds a pattern to the whitelist.
   * Returns the pattern ID for audit linkage.
   */
  add(pattern: Omit<WhitelistPattern, 'id'>): WhitelistEntryId;

  /**
   * Checks whether a tool call matches any whitelist pattern.
   * Returns the matching pattern if found.
   *
   * @param serverName - The MCP server name
   * @param toolName - The tool name (without server prefix)
   * @param resolvedArgs - Arguments with paths already resolved to real paths
   * @param annotation - The tool's annotation (for role extraction)
   */
  match(
    serverName: string,
    toolName: string,
    resolvedArgs: Record<string, unknown>,
    annotation: ToolAnnotation,
  ): WhitelistMatchResult;

  /** Returns all active patterns (for diagnostics/testing). */
  entries(): readonly WhitelistPattern[];

  /** Number of active patterns. */
  readonly size: number;
}
```

### 4.3 Extended escalation IPC types

```typescript
// In mcp-proxy-server.ts, extend EscalationFileRequest:

interface EscalationFileRequest {
  escalationId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  context?: Record<string, string>;
  /** Whitelist candidates extracted from this escalation's annotation. */
  whitelistCandidates?: WhitelistCandidateIpc[];
}

// Parsed response (replaces the current 'approved' | 'denied' return):

interface EscalationResponseData {
  readonly decision: 'approved' | 'denied';
  /** Index into whitelistCandidates to whitelist. Absent = no whitelisting. */
  readonly whitelistSelection?: number;
}
```

### 4.4 Extended EscalationRequest (session/types.ts)

```typescript
// Extend the existing EscalationRequest exposed to transports:

export interface EscalationRequest {
  readonly escalationId: string;
  readonly toolName: string;
  readonly serverName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
  readonly context?: Readonly<Record<string, string>>;
  /** Whitelist candidates for display. Present when the proxy supports whitelisting. */
  readonly whitelistCandidates?: readonly WhitelistCandidateIpc[];
}
```

### 4.5 Extended Session.resolveEscalation()

```typescript
// In Session interface (session/types.ts):

resolveEscalation(
  escalationId: string,
  decision: 'approved' | 'denied',
  options?: { whitelistSelection?: number },
): Promise<void>;
```

### 4.6 Extended EscalationWatcher.resolve()

```typescript
// In EscalationWatcher interface (escalation-watcher.ts):

resolve(
  escalationId: string,
  decision: 'approved' | 'denied',
  options?: { whitelistSelection?: number },
): boolean;
```

### 4.7 Extended EscalationPromptFn (TrustedProcess in-process mode)

```typescript
// In src/trusted-process/index.ts:

export interface EscalationResult {
  readonly decision: 'approved' | 'denied';
  readonly whitelistSelection?: number;
}

export type EscalationPromptFn = (
  request: ToolCallRequest,
  reason: string,
  context?: Readonly<Record<string, string>>,
  whitelistCandidates?: readonly WhitelistCandidateIpc[],
) => Promise<EscalationResult>;
```

### 4.8 Extended audit entry

```typescript
// Additions to AuditEntry in src/types/audit.ts:
export interface AuditEntry {
  // ... existing fields ...

  /**
   * When true, the escalation was bypassed because a whitelist
   * pattern matched. The whitelistPatternId links to the original
   * approval that created the pattern.
   */
  whitelistApproved?: boolean;

  /**
   * ID of the whitelist pattern that matched, linking back to the
   * original escalation approval. Only present when whitelistApproved is true.
   */
  whitelistPatternId?: string;
}
```

### 4.9 Extended CallToolDeps (proxy mode)

```typescript
// Addition to CallToolDeps in mcp-proxy-server.ts:
export interface CallToolDeps {
  // ... existing fields ...

  /** Ephemeral approval whitelist for this session. */
  whitelist: ApprovalWhitelist;
}
```

> **Note:** `pendingWhitelistCandidates` is module-level state in the proxy process
> (`const pendingWhitelistCandidates = new Map<...>()`), not a `CallToolDeps` field.
> It is internal mutable state acting as a side-channel between writing the escalation
> request and reading the response -- putting it on `CallToolDeps` would leak
> implementation details into the interface.

## 5. Component Diagram

```
User types "/approve+ 3"
        |
        v
+------------------+     writes response-{id}.json
| MuxApp /         | --> { "decision": "approved", "whitelistSelection": 0 }
| CliTransport /   |
| Listener         |
+------------------+
                          escalation directory (per-session)
                          ~/.ironcurtain/sessions/{sid}/escalation/

                          request-{id}.json includes:
                            whitelistCandidates: [
                              { description: "Allow write_file within /home/user/Documents" }
                            ]

                               ^                    |
                               | polls              | reads
+------------------------------+--------------------v------------------+
|                     mcp-proxy-server (per-session proxy process)     |
|                                                                      |
|  handleCallTool()                                                    |
|      |                                                               |
|      v                                                               |
|  PolicyEngine.evaluate()  --> EvaluationResult { escalatedRoles }     |
|      |                                                               |
|      v  decision == 'escalate'                                       |
|      |                                                               |
|      v                                                               |
|  ApprovalWhitelist.match()  <-- check existing patterns              |
|      |                                                               |
|      +-- match found --> proceed (audit: whitelistApproved=true)     |
|      |                                                               |
|      +-- no match                                                    |
|      |                                                               |
|      v                                                               |
|  extractWhitelistCandidates(escalatedRoles)  -- only escalated roles |
|      |                                                               |
|      v                                                               |
|  Store candidates in pendingWhitelistCandidates[escalationId]        |
|      |                                                               |
|      v                                                               |
|  AutoApprover (LLM-based intent match)                               |
|      |                                                               |
|      v                                                               |
|  waitForEscalationDecision()  -- file-based IPC                      |
|      |    (candidates included in request file)                      |
|      |                                                               |
|      v  response.whitelistSelection present?                         |
|      |                                                               |
|      v                                                               |
|  Look up candidate by index from pendingWhitelistCandidates          |
|  ApprovalWhitelist.add(pattern)                                      |
|      |                                                               |
|      v                                                               |
|  proceed with tool call                                              |
+----------------------------------------------------------------------+
```

**In-process mode (TrustedProcess):**

```
TrustedProcess.handleToolCall()
    |
    v
PolicyEngine.evaluate()  --> EvaluationResult { escalatedRoles }
    |  decision == 'escalate'
    v
ApprovalWhitelist.match()
    |  no match
    v
extractWhitelistCandidates(escalatedRoles)
    |
    v
onEscalation callback (with candidates)
    |  returns EscalationResult { decision: 'approved', whitelistSelection: 0 }
    v
Look up candidate, ApprovalWhitelist.add(pattern)
    |
    v
proceed with tool call
```

## 6. Pattern Extraction Implementation

### 6.1 `extractWhitelistCandidates()` function

```typescript
/**
 * Extracts whitelist candidate patterns from an escalated tool call.
 *
 * Only generates constraints for the role(s) that caused the escalation,
 * as identified by `escalatedRoles` on the EvaluationResult. This avoids
 * generating meaningless patterns for roles that were already allowed
 * (e.g., by sandbox containment) or that matched a different compiled rule.
 *
 * Falls back to all resource-identifier roles when `escalatedRoles` is
 * undefined (defensive robustness for future structural escalation paths).
 *
 * Returns both:
 * - WhitelistPattern[] (full patterns, stored in proxy memory)
 * - WhitelistCandidateIpc[] (descriptions, serialized into IPC file)
 *
 * For the initial implementation, returns exactly one candidate that
 * combines all escalated-role constraints. Future versions may
 * return multiple candidates for user sub-selection.
 *
 * @param serverName - The MCP server name
 * @param toolName - The tool name
 * @param args - The tool call arguments (already resolved for policy)
 * @param annotation - The tool's resolved annotation
 * @param escalatedRoles - The role(s) that caused the escalation (from EvaluationResult).
 *   When undefined, falls back to all resource-identifier roles on the annotation.
 * @param escalationId - The escalation that triggered this extraction
 * @param escalationReason - The reason for escalation
 */
function extractWhitelistCandidates(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  escalatedRoles: readonly ArgumentRole[] | undefined,
  escalationId: string,
  escalationReason: string,
): { patterns: Array<Omit<WhitelistPattern, 'id'>>; ipcs: WhitelistCandidateIpc[] };
```

### 6.2 Generalization rules by role category

These generalizations apply only to roles present in `escalatedRoles`. Roles that were allowed by sandbox containment or matched an `allow` compiled rule are not included.

| Role category | Role | Generalization | Rationale |
|---|---|---|---|
| `path` | `read-path`, `write-path`, `delete-path` | `dirname(resolveRealPath(value))` | Approving a write to `report.md` implies writes to that directory are acceptable. |
| `path` | `write-history`, `delete-history` | No directory constraint generated | History-rewriting is too dangerous for directory-level generalization. Each operation requires individual approval. |
| `url` | `fetch-url`, `git-remote-url` | `extractDomainForRole(canonicalize(value), role)` | Domain-level matches existing security boundaries. |
| `identifier` | `github-owner`, `github-repo` | `value.toLowerCase()` | Case-insensitive exact match. |

### 6.3 Human-readable descriptions

The `description` field in `WhitelistCandidateIpc` is built from the constraints:

```
"Allow filesystem/write_file within /home/user/Documents"
"Allow git/git_push to domain github.com"
"Allow github/create_issue for owner=octocat, repo=hello-world"
"Allow git/git_reset (exact tool match only)"  -- history role, no directory constraint
"Allow github/create_issue (all future calls)"  -- zero-constraint side-effectful
```

### 6.4 Multi-argument tools

A tool may have multiple resource-identifier arguments (e.g., `move_file` has `source` with `[read-path, delete-path]` and `destination` with `[write-path]`). The pattern includes constraints only for the **escalated** roles, not all resource-identifier arguments. For example, if `move_file`'s source `read-path` and `delete-path` roles were allowed by sandbox containment but the destination `write-path` was escalated, only the `write-path` constraint appears in the candidate. All constraints must match for the pattern to fire.

When multiple roles escalate (e.g., both `read-path` on source and `write-path` on destination are outside the sandbox), all escalated roles generate constraints and all must match.

## 7. Security Considerations

### 7.1 Directory traversal

Path constraints use `isWithinDirectory()` which internally calls `resolveRealPath()` (symlink-following `realpathSync`). A whitelisted directory of `/home/user/Documents` will not match a path like `/home/user/Documents/../../etc/passwd` because it resolves to `/etc/passwd`, which is not within `/home/user/Documents`.

### 7.2 Pattern over-generalization

The design intentionally generalizes to the directory level for paths and domain level for URLs. History-rewriting roles are excluded from this generalization (Flaw 9).

For side-effectful tools with no resource-identifier arguments, the warning system (Flaw 7) makes the risk explicit.

### 7.3 Whitelist cannot override deny

The evaluation order (deny check before whitelist check) ensures that even if a compromised agent tries to exploit a whitelisted pattern to access denied resources, the deny phase runs first and blocks the call.

### 7.4 Extract-once guarantee eliminates drift

The pattern displayed to the user (via `WhitelistCandidateIpc.description`) is generated from the same extraction that produces the `WhitelistPattern`. The response carries only an index, not a request to "re-extract." This eliminates any possibility of the proxy computing a different pattern than what the user saw.

### 7.5 Audit completeness

Every whitelist-approved call includes:
- `whitelistApproved: true`
- `whitelistPatternId` -- links to the original approval
- The original `policyDecision` with `status: 'escalate'` and the escalation reason

### 7.6 Interaction with auto-approver

The whitelist runs BEFORE the auto-approver. When both are enabled:
1. Policy engine returns `escalate`.
2. Whitelist check: if matched, proceed (no auto-approver call, no human prompt).
3. Auto-approver: if approved, proceed (no human prompt). Note: auto-approved calls do NOT create whitelist entries.
4. Human escalation.

## 8. Integration Points (Files Changed)

### Phase 1: Core whitelist module + AgentSession refactor

**New file: `src/trusted-process/approval-whitelist.ts`**
- `ApprovalWhitelist` implementation (in-memory store, `add()`, `match()`, `entries()`).
- `extractWhitelistCandidates()` accepts `escalatedRoles` from `EvaluationResult` to scope extraction to only the role(s) that caused the escalation.
- Constraint matching for each kind (directory, domain, exact).

**Modify: `src/trusted-process/policy-types.ts`**
- Add optional `escalatedRoles?: readonly ArgumentRole[]` field to `EvaluationResult`.

**Modify: `src/trusted-process/policy-engine.ts`**
- `evaluateCompiledRules()`: collect roles that evaluated to `escalate` into `escalatedRoles` on the result.
- `evaluateStructuralInvariants()`: populate `escalatedRoles` on `structural-domain-escalate` results.
- Import `isWithinDirectory` from `argument-roles.ts` (moved out of this file).

**Move: `isWithinDirectory` from `src/trusted-process/policy-engine.ts` to `src/types/argument-roles.ts`**
- Export for use by both `policy-engine.ts` and `approval-whitelist.ts`.

**Refactor: `src/session/agent-session.ts`**
- Replace inline escalation watcher with `createEscalationWatcher()`.
- Replace `resolveEscalation()` direct `writeFileSync` with `this.escalationWatcher.resolve()`.
- Remove `pollEscalationDirectory()`, `checkEscalationExpiry()`, `extractEscalationId()`, `seenEscalationIds`, `escalationPollInterval`.
- Add `escalationWatcher: EscalationWatcher | null` field.

### Phase 2: IPC protocol extension + proxy integration

**Modify: `src/trusted-process/mcp-proxy-server.ts`**
- Extend `EscalationFileRequest` with `whitelistCandidates`.
- Widen `readEscalationResponse()` return type to `EscalationResponseData`.
- Widen `waitForEscalationDecision()` return type to `EscalationResponseData`.
- Add `ApprovalWhitelist` to `CallToolDeps`; `pendingWhitelistCandidates` is module-level state (not on `CallToolDeps` -- it's an internal side-channel, not a dependency).
- Insert whitelist check in `handleCallTool()` between policy evaluation and escalation flow.
- Pass `evaluation.escalatedRoles` to `extractWhitelistCandidates()` to scope extraction to only the causal roles.
- Store candidates in `pendingWhitelistCandidates` map.
- After reading response with `whitelistSelection`, look up candidate and add to whitelist.
- Pass whitelist audit fields to `buildAuditEntry()`.

**Modify: `src/types/audit.ts`**
- Add `whitelistApproved?: boolean` field to `AuditEntry`.
- Add `whitelistPatternId?: string` field to `AuditEntry`.

**Modify: `src/trusted-process/index.ts`**
- Add `EscalationResult` type and update `EscalationPromptFn` signature.
- Create `ApprovalWhitelist` instance in `TrustedProcess` constructor.
- Insert whitelist check in `handleToolCall()`.
- Extract candidates and pass to `onEscalation` callback.
- Handle `whitelistSelection` in callback result.

### Phase 3: Session/transport layer

**Modify: `src/escalation/escalation-watcher.ts`**
- Extend `resolve()` to accept optional `{ whitelistSelection?: number }` options.
- Write `{ decision, whitelistSelection }` when present.

**Modify: `src/session/types.ts`**
- Extend `EscalationRequest` with `whitelistCandidates`.
- Extend `Session.resolveEscalation()` with optional `options` parameter.

**Modify: `src/session/cli-transport.ts`**
- Replace exact `switch (input)` with prefix-based command parsing.
- Recognize `/approve+` as a command.
- Display whitelist candidates in escalation banner when present.
- Pass `{ whitelistSelection: 0 }` when resolving with `/approve+`.
- Display confirmation message showing whitelisted pattern description.

**Modify: `src/session/agent-session.ts`** (after Phase 1 refactor)
- Update `resolveEscalation()` to pass options through to `escalationWatcher.resolve()`.

**Modify: `src/docker/docker-agent-session.ts`**
- Update `resolveEscalation()` to pass options through to `escalationWatcher.resolve()`.

### Phase 4: Mux + escalation listener integration

**Modify: `src/mux/mux-app.ts`**
- Strip `+` suffix from command name in `handleCommand()`.
- Pass `whitelist: true` flag through to `escalationManager.resolve()`.

**Modify: `src/mux/mux-input-handler.ts`**
- No change needed. The `+` is part of the command string and passes through to `handleCommand()`.

**Modify: `src/mux/mux-escalation-manager.ts`**
- Extend `resolve()` to accept optional `whitelist: boolean` parameter.
- Pass through to `watcher.resolve()` as `{ whitelistSelection: 0 }`.

**Modify: `src/escalation/listener-command.ts`**
- Strip `+` suffix from command name in `handleCommand()`.
- Pass through to `watcher.resolve()`.

### Phase 5: Polish

- Update escalation banner in all transports to show whitelist candidates and warnings.
- Update command help text and hint bars with `/approve+` syntax.
- Update CLAUDE.md with whitelist documentation.

## 9. Testing Strategy

### 9.1 Unit tests: `approval-whitelist.test.ts`

Test the `ApprovalWhitelist` implementation in isolation:

- **Pattern matching:**
  - Path constraint matches file within whitelisted directory.
  - Path constraint rejects file outside whitelisted directory.
  - Path constraint handles symlink escape (symlinked path resolves outside directory).
  - Domain constraint matches URL with whitelisted domain.
  - Domain constraint rejects URL with different domain.
  - Exact constraint matches (case-insensitive for identifiers).
  - Multi-constraint patterns require all constraints to match.
  - Empty constraints match any call to that server/tool.
  - Multiple patterns for same server/tool -- first match wins.

- **Pattern extraction:**
  - Path role in `escalatedRoles` extracts parent directory.
  - URL role in `escalatedRoles` extracts domain.
  - Identifier role in `escalatedRoles` extracts case-folded value.
  - Roles NOT in `escalatedRoles` are excluded from constraints.
  - `write-history` and `delete-history` roles produce no directory constraint even when escalated.
  - Side-effectful tool with no resource-identifier args in escalated roles gets warning.
  - Multi-argument tool with only one escalated role produces single constraint.
  - Fallback: undefined `escalatedRoles` extracts all resource-identifier roles.

- **EvaluationResult.escalatedRoles population:**
  - `evaluateCompiledRules()`: single escalated role is captured.
  - `evaluateCompiledRules()`: multiple roles escalated, all captured.
  - `evaluateCompiledRules()`: mix of allow and escalate roles, only escalate roles captured.
  - `evaluateStructuralInvariants()`: `structural-domain-escalate` captures the failing URL role.
  - Non-escalate decisions have undefined `escalatedRoles`.

- **Lifecycle:**
  - Empty whitelist matches nothing.
  - Added patterns are immediately matchable.
  - `entries()` returns all active patterns.
  - `size` reflects current count.

### 9.2 Unit tests: `AgentSession` refactor

- Verify `AgentSession.resolveEscalation()` delegates to `EscalationWatcher.resolve()`.
- Verify escalation detection works identically to before (poll, detect, fire callback).
- Verify escalation expiry detection works identically.
- Verify `getPendingEscalation()` returns `escalationWatcher.getPending()`.

### 9.3 Unit tests: IPC protocol extension

- `readEscalationResponse()` parses `whitelistSelection` field.
- `readEscalationResponse()` returns `undefined` for missing `whitelistSelection` (backward compat).
- `waitForEscalationDecision()` returns full `EscalationResponseData`.
- `EscalationWatcher.resolve()` writes `whitelistSelection` when provided.
- `EscalationWatcher.resolve()` omits field when not provided (backward compat).

### 9.4 Unit tests: extended `handleCallTool` / `handleToolCall`

- **Whitelist bypass:**
  - Escalated call with matching whitelist pattern is allowed without escalation.
  - Audit entry has `whitelistApproved: true` and `whitelistPatternId`.
  - Denied call is NOT affected by whitelist.
  - Allowed call is NOT affected by whitelist.

- **Pattern creation on approval:**
  - Response with `whitelistSelection: 0` triggers pattern addition.
  - Response without `whitelistSelection` does not create a pattern.
  - Pattern is correctly extracted from the escalation request and annotation.

- **TrustedProcess in-process mode:**
  - Whitelist check runs before `onEscalation` callback.
  - Callback receives `whitelistCandidates` parameter.
  - `EscalationResult` with `whitelistSelection` creates pattern.

### 9.5 Unit tests: command parsing

- `CliTransport`: `/approve+` recognized as approve with whitelist.
- `CliTransport`: `/approve` recognized as approve without whitelist.
- `CliTransport`: `/approve+ 3` is NOT a valid command in single-session mode (CliTransport has no N).
- Mux: `approve+` command stripped to `approve` with whitelist flag.
- Mux: `approve` command has no whitelist flag.
- Listener: same as mux.

### 9.6 Integration tests

- End-to-end: approve+ in CLI transport, verify subsequent matching call skips escalation.
- End-to-end: verify audit log contains correct whitelist fields.
- End-to-end: verify whitelist does not persist after session close and restart.
- Verify `AgentSession` and `DockerAgentSession` both work with extended `resolveEscalation()`.

## 10. Implementation Plan (Phased PRs)

### Phase 1: Core whitelist module + AgentSession refactor

**Files:**
- New: `src/trusted-process/approval-whitelist.ts`
- New: `test/approval-whitelist.test.ts`
- Modify: `src/trusted-process/policy-types.ts` (add `escalatedRoles` field to `EvaluationResult`)
- Modify: `src/trusted-process/policy-engine.ts` (populate `escalatedRoles` in `evaluateCompiledRules()` and `evaluateStructuralInvariants()`, import `isWithinDirectory` from argument-roles)
- Modify: `src/types/argument-roles.ts` (add `isWithinDirectory`)
- Modify: `src/session/agent-session.ts` (refactor to use `createEscalationWatcher()`)
- New: `test/agent-session-escalation.test.ts` (verify refactored escalation behavior)

**Dependencies:** None.

### Phase 2: IPC protocol extension + proxy/TrustedProcess integration

**Files:**
- Modify: `src/trusted-process/mcp-proxy-server.ts` (widen IPC types, whitelist check, pass `evaluation.escalatedRoles` to candidate extraction)
- Modify: `src/trusted-process/index.ts` (`EscalationResult`, whitelist in `handleToolCall`, pass escalated roles)
- Modify: `src/types/audit.ts` (add whitelist fields)
- Modify: `test/mcp-proxy-server.test.ts`
- New: `test/whitelist-integration.test.ts`

**Dependencies:** Phase 1.

### Phase 3: Session/transport layer

**Files:**
- Modify: `src/escalation/escalation-watcher.ts` (extend `resolve()`)
- Modify: `src/session/types.ts` (extend `EscalationRequest`, `Session.resolveEscalation()`)
- Modify: `src/session/cli-transport.ts` (prefix-based parsing, `/approve+`)
- Modify: `src/session/agent-session.ts` (pass options through)
- Modify: `src/docker/docker-agent-session.ts` (pass options through)

**Dependencies:** Phase 2.

### Phase 4: Mux + escalation listener integration

**Files:**
- Modify: `src/mux/mux-app.ts` (`+` suffix stripping)
- Modify: `src/mux/mux-escalation-manager.ts` (whitelist flag in `resolve()`)
- Modify: `src/escalation/listener-command.ts` (`+` suffix stripping)

**Dependencies:** Phase 3.

### Phase 5: Polish and documentation

- Escalation banner enhancements (show candidates, warnings, confirmations).
- Update command help text in all transports.
- Update CLAUDE.md.
- Performance validation (linear scan of small list, expected <1ms).

**Dependencies:** Phase 4.
