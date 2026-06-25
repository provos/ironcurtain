# Web UI Persona Policy Management (create / edit / compile / delete over WS)

**Status:** Implemented (v1 = Phases 0–1c landed; PR #347). Spike-validated — including the previously-open runtime-containment question, **resolved** by the containment-governance spike (§12, A9). All v1 open questions are resolved (§14): audit-chain secret stays in-memory (Q3); compile limits stay hardcoded at concurrency 2 / queue 10 (Q4). Global (non-persona) policy compilation (Phase 2), the WS customizer (Phase 3), and multi-user / non-localhost hardening remain deferred; `annotate-tools` over WS is a permanent non-goal.

**Authors:** feature-architect workflow (consolidated current-state map + 7 spikes + adversarial findings pass).

**Related:**
- [`WORKFLOWS.md`](../../WORKFLOWS.md), [`docs/designs/agent-driven-workflow-gates.md`](./agent-driven-workflow-gates.md) — long-running-op precedent (`workflows.start`).
- [`docs/designs/mitm-token-trajectory-capture.md`](./mitm-token-trajectory-capture.md) §10 — the `captureTracesDefault` daemon-flag plumbing this design mirrors for `--allow-policy-mutation`.
- [`docs/designs/per-persona-memory-optin.md`](./per-persona-memory-optin.md) — persona memory config semantics.
- `src/pipeline/CLAUDE.md`, `src/trusted-process/CLAUDE.md` — module-layering invariant.

---

## 1. Executive summary

IronCurtain's policy engine is its security kernel: every MCP tool call is evaluated `allow`/`deny`/`escalate` against a compiled policy. Today the Web UI (Svelte 5 SPA served by the daemon over an authenticated WebSocket) can only **read** personas and trigger a **blocking** compile (`personas.list` / `personas.get` / `personas.compile`). This design adds full persona lifecycle management over WS — create, edit-constitution, set-memory, delete, and a **streamed** compile with per-phase progress — by decomposing the interactive `@clack`-bound CLI logic into a single headless service shared by CLI and WS, and by modeling minutes-long compilation as a fire-and-return long-running operation that streams progress events (the proven `jobs.run` / `workflows.start` shape).

Because policy *is* the security boundary, exposing mutation to a WS client is a privilege-escalation surface. v1 targets a **single-operator localhost daemon**, so the threat model is "the operator (or someone who grabbed the operator's token) recompiles a weaker policy," not a multi-user privilege boundary. The design therefore lands its defenses **before** any mutation method ships: (1) a default-off `--allow-policy-mutation` kill switch (CLI-only, not config-persisted) — the mutation surface simply does not exist unless the operator launched the daemon with it; (2) **per-file atomic writes plus dependency-ordered artifact emission** — `dynamic-lists.json` is written before `compiled-policy.json`, and because the runtime loader reads compiled-policy *then* lists, a reader can never observe a new compiled policy ahead of the lists it references (a stale/missing list expands to empty ⇒ fail-safe deny), closing the measured ~97%-corruption torn-read race **without** a staging dir or directory rename; and (3) a post-compile structural broad-policy validator that rejects `*`-domain / out-of-workspace policies regardless of what the LLM produced (defeating constitution prompt injection), plus disabling data-backed (MCP) dynamic-list resolution on the WS path. A hard invariant underpins all of it: **tool annotations (`tool-annotations.json`) are never created or modified via the Web UI — they remain CLI-only (`ironcurtain annotate-tools`)**; compilation only ever *reads* them. Recompiling a persona while a workflow that uses it is running is explicitly **allowed** — the ordering guarantee keeps the live reader consistent — so there is no in-flight interlock and no policy snapshot.

Global (non-persona) policy compilation is deferred (Phase 2) because it writes the *live* active policy dir. Tool-annotation generation (`annotate-tools`) is a **permanent** Web-UI non-goal (never deferred-to-later, never in-process).

---

## 2. Goals & non-goals

### Goals (v1 = Phases 0–1c)
- Create a persona (name, description, optional server allowlist, memory toggle, optional constitution text) from the Web UI.
- Edit a persona's constitution text from the Web UI, with a "policy stale — recompile" signal.
- Toggle a persona's memory opt-in from the Web UI.
- Delete a persona (soft-delete by default; explicit hard-delete = revoke).
- Compile a persona's policy from the Web UI as a streamed long-running operation with per-server, per-phase progress, reconnect recovery, cross-process serialization, and a hard wall-clock cap.
- Share **one** headless implementation between the CLI (`persona-command.ts`) and the WS dispatch, so the two cannot drift.
- Respect the `src/web-ui/** → src/pipeline/**` runtime-import layering rule (dynamic import only), and *enforce* it with lint + a static-graph test.
- Add structural security: authz gate, audit, blast-radius containment, atomicity, prompt-injection ceiling.

### Non-goals (deferred / out of scope)
- Global (non-persona) `compile-policy` / `refresh-lists` over WS → **Phase 2** (writes the live active dir; sharpened prerequisites below).
- `annotate-tools` / any tool-annotation editing over WS → **never** (permanent non-goal). Annotations classify tool argument roles that drive policy evaluation; the Web UI only ever *reads* `tool-annotations.json` during compilation, never writes it (see §7).
- Interactive LLM constitution **generation** and the multi-turn **customizer** over WS → **Phase 3** (WS `create`/`edit` take a constitution string; generation/customization stay CLI-only in v1).
- True instant cancellation (v1 is best-effort: aborts at the next phase boundary + cancels in-flight LLM HTTP calls; `operationId` is reserved as a future `personas.cancelCompile` handle).
- Multi-user / non-localhost daemon hardening, including a second (admin) credential or moving the connection token out of the `?token=` URL (deferred; v1 is single-operator localhost, where the default-off kill switch is the appropriate gate — see §7 and the daemon-wide hardening note in §14).

---

## 3. Current state (with file:line anchors)

### Compilation engine (offline, `src/pipeline/`)
- Single entry point: `PipelineRunner.run(config: PipelineRunConfig)` (`src/pipeline/pipeline-runner.ts:578` class; `:91` config interface). Construction needs `createPipelineModels(logDir?)` (`pipeline-runner.ts:160`).
- LLM creds flow `createPipelineModels → createPipelineLlm → loadUserConfig → applyEnvOverrides` reading `process.env` (`src/config/user-config.ts:816`); `dotenv/config` loads synchronously at `src/cli.ts:2`. No separate credential injection; the daemon inherits its env.
- `run()` compiles each MCP server independently: sequential `compileServersSequential` (`pipeline-runner.ts:837`, reporter `new SpinnerProgressReporter(serverName)` at `:854`) or parallel `compileServersParallel` (`:877`, reporter `new ParallelProgressReporter(display, serverName)` at `:895`). `useParallel = entriesToCompile.length > 1` (`:803`).
- `PipelineRunConfig` (`pipeline-runner.ts:91-144`) has `onProgress?: (message: string) => void` (`:126`) but **no** `reporterFactory`, no `signal`, no `quiet`. `config.onProgress` only reaches repair sub-steps (`:1634`, `:1684`), **not** `CompilationPhase` transitions.
- `ServerProgressReporter` interface (`src/pipeline/pipeline-shared.ts:311-322`) and `CompilationPhase` union (`:295-304` — `'cached' | 'compiling' | 'lists' | 'scenarios' | 'repair-scenarios' | 'verifying' | 'repair-compile' | 'repair-verify' | 'done'`) are clean type-level contracts.
- `writeArtifact(generatedDir, filename, data)` (`pipeline-shared.ts:195-198`) is `mkdirSync + writeFileSync(JSON.stringify(...) + '\n')` — **non-atomic, no tmp+rename**.
- `run()` writes the artifact set as **three separate writes**: `compiled-policy.json` (`pipeline-runner.ts:641`), `test-scenarios.json` (`:651`), `dynamic-lists.json` (`:675`), with the lists write **skipped when `listDefinitions.length === 0`** — leaving a stale prior `dynamic-lists.json` permanently.
- `createThrottledModel(model, semaphore)` (`pipeline-shared.ts:283`) wraps the LM; the throttling semaphore is **per `run()`**, so N concurrent compiles = N independent semaphores. `generateText` calls in `constitution-compiler.ts` (`:540`, `:560`, `:629`, `:656`) accept an options object (can carry `abortSignal`).

### Persona subsystem (`src/persona/`)
- Storage: `$IRONCURTAIN_HOME/personas/{name}/` with `persona.json`, `constitution.md`, `generated/compiled-policy.json`, `workspace/`. Path helpers in `resolve.ts` (`getPersonaDir:28`, `getPersonaGeneratedDir:33`, `getPersonaConstitutionPath:38`, `getPersonaWorkspaceDir:43`, `getPersonaDefinitionPath:53`, `loadPersona:86`, `resolvePersona:117` → `policyDir = generated dir`, `applyServerAllowlist:151`).
- `applyServerAllowlist` writes `Warning: persona allowlist includes unknown server ...` to **`process.stderr`** (`resolve.ts:161`) — a CLI side-effect that becomes a daemon-stderr leak under WS compile.
- Name safety: `createPersonaName(raw)` (`types.ts:24`) calls `validateSlug` (rejects `..`, absolute paths, `.`-prefixed names, NUL); `PersonaDefinition` (`types.ts:44-68`) with optional `servers?` (omit = all) and optional `memory?: { enabled }` (absent = on).
- The **headless compile seam** already exists: `compilePersonaPolicy(name)` (`compile-persona-policy.ts:28`). It statically imports pipeline **values** (`pipeline-runner.ts:12`) — the sanctioned layering exception — and is reached via **dynamic import** from the dispatch. It reads annotations from the **global** `getUserGeneratedDir()` (`:33`), outputs to `getPersonaGeneratedDir(name)`, passes `config.allowedDirectory` (`:50`, = `process.env.ALLOWED_DIRECTORY ?? ~/.ironcurtain/sandbox`), and takes **no** opts.
- CLI flows (`persona-command.ts`) are interactive:
  - `runCreate` (`:181-307`): `@clack` prompts (description `:190`, server multiselect `:213` with `selected.length < serverNames.length ? servers : undefined` `:227`, memory confirm `:234`); writes `persona.json` **before** authoring (`:257`); supports an **empty-constitution** persona (`:290-295`); `mkdir` generated/ + workspace/ (`:244-247`).
  - `runEdit` (`:381-436`): select customize / editor / generate / memory. Memory toggle = destructure-omit at `:413-416` (enable ⇒ **drop** `memory` key; disable ⇒ `memory: { enabled: false }`). **`editViaEditor` (`:452-455`) calls `openEditor()` in place and returns a diff `changed` boolean — it never writes the file**; the write at `:445` is in `editViaCustomizer`.
  - `runDelete` (`:494-516`): `@clack` confirm then `rmSync(personaDir, { recursive, force })`.
- `runPersonaConstitutionCustomizer` (`persona-customizer.ts`) → `runConstitutionCustomizerLoop` hard-aborts when `!process.stdin.isTTY` and is `@clack`-bound throughout — no headless variant.

### WS daemon dispatch (`src/web-ui/`)
- Auth: single 32-byte bearer token verified at upgrade with `timingSafeEqual` (`web-ui-server.ts:486-491`); origin check in non-dev (`:493-496`); 10-client cap (`:445`); 1 MB `maxPayload` (`:142`). **No per-method authz.** Token is in the printed `?token=` URL (`:168`).
- `handleUpgrade` (`web-ui-server.ts:408-484`); `handleMessage` (`:500`) calls `dispatch(this.dispatchCtx, frame.method, frame.params ?? {}, client)` (`:521`) — **`client` is already threaded into `dispatch`**.
- `dispatchCtx` is built once at `web-ui-server.ts:96` (mirrors how `captureTracesDefault` is set at `:104`).
- Router `dispatch(ctx, method, params, client?)` (`json-rpc-dispatch.ts:27`): `sessionDispatch` gets `client` (`:34`); **`personaDispatch(method, params)` gets neither `ctx` nor `client`** (`:40`). So persona handlers have **no `eventBus`** (can't stream) and **no `client`** (can't audit the actor).
- `personaDispatch` (`persona-dispatch.ts:28`): `personas.list` (`:30` → `scanPersonas()`), `personas.get` (`:38` → `getPersonaDetail` `:76`, returns `PersonaDetailDto` **without memory**), `personas.compile` (`:43` → `compilePersona` `:113`, which **`await`s** `compilePersonaPolicy(name)` at `:119` — blocks the RPC response frame for minutes). No concurrency guard.
- `DispatchContext` (`dispatch/types.ts:27-43`) carries `eventBus`, `handler`, `sessionManager`, `captureTracesDefault?`. `validateParams(schema, params)` (`:49`) throws `InvalidParamsError` on Zod failure. `buildStatusDto(ctx)` (`:94`) builds `DaemonStatusDto`.
- `MethodName` union (`web-ui-types.ts:21-62`); `ErrorCode` union (`:88-106`, includes `PERSONA_NOT_FOUND`); `RpcError(code, message, data?)` (`:402`). DTOs: `PersonaDetailDto` (`:381-389`), `PersonaCompileResultDto` (`:392-396` = `{ success, ruleCount, errors? }`), `DaemonStatusDto` (`:160-167`), deprecated-alias precedent `ResumableWorkflowDto` (`:344`).
- `WebEventBus` / `WebEventMap` (`web-event-bus.ts:23-90`); long-running precedent `workflow.*` events (`:43-78`), `job.list_changed` (`:40`). `broadcast()` (`web-ui-server.ts:212`) sends only to currently-open clients — **no replay buffer**.

### Runtime hot-swap interaction (the race)
- `loadPersonaPolicyArtifacts(policyDir)` (`config/index.ts:424-431`) reads **two files non-transactionally**: `compiled-policy.json` (`:428`) + optional `dynamic-lists.json` (`:429`).
- Workflow `getPolicyDir(instance, persona)` (`orchestrator.ts:1061-1067`) caches per persona in `instance.policyDirByPersona` but resolves to the **live** persona generated dir via `resolvePersonaPolicyDir → resolvePersona().policyDir` (`:1064`, `:4542`). `cyclePolicy` (`:1111`) loads from `getPolicyDir` on each agent-state entry; the only guard (`:1125-1138`) rejects server-set **expansion**, not rule weakening. `ToolCallCoordinator.loadPolicy({persona, policyDir})` (`tool-call-coordinator.ts:551`) validates `policyDir` via `validatePolicyDir` and holds call+policy mutexes for the in-process engine swap only.
- `atomicWriteJsonSync(filePath, data)` exists at `escalation-watcher.ts:51-55` (write-tmp + `renameSync`) but **always `JSON.stringify`s** — unusable for `constitution.md`.

### Frontend (`packages/web-ui/`)
- Svelte 5 runes; single `appState` singleton (`lib/stores.svelte.ts`); RPC wrapped as named exports (`listPersonas`/`getPersonaDetail`/`compilePersonaPolicy` exist); events flow `ws-client → handleEvent → handleEventPure`.
- `event-handler.ts` has **three coupled structures**: `WebEvent` union (`:123`), `parseEvent(event, payload)` (`:175`, returns `undefined` for unknown at `:241` → silently dropped), `applyEvent(state, effects, parsed)` (`:259`). DTOs mirrored **manually** in `lib/types.ts`.
- `routes/Personas.svelte` consumes list/get/compile and polls. Mock WS server `scripts/mock-ws-server.ts` implements only `personas.list/get/compile` and **must stay in sync** (backs Playwright e2e).

### Daemon flag plumbing precedent
`captureTracesDefault` is a clean 4-hop template: `daemon-command.ts` CommandSpec option (`:46`) + `parseArgs` option (`:98`) + read (`:134`) + pass (`:139`) → `IronCurtainDaemonOptions` field (`ironcurtain-daemon.ts:58`) → `WebUiServerOptions` field (`web-ui-server.ts:64`) → `dispatchCtx` (`:104`).

---

## 4. Decomposition plan (interactive CLI → headless service seams)

All new live-layer modules carry **type-only** pipeline imports. The single value-level pipeline edge stays inside `compile-persona-policy.ts` (sanctioned exception), reached **only** via `await import(...)` from `persona-compile-orchestrator.ts`. Enforced by a Phase-0 ESLint `no-restricted-imports` rule + a madge static-graph test (§8).

### 4.1 `src/persona/persona-service.ts` (NEW; live-layer; ZERO reference to `compile-persona-policy.ts`)
The single canonical headless module called by **both** `persona-command.ts` (CLI) and `persona-dispatch.ts` (WS). The CLI keeps `@clack`/`$EDITOR`/customizer prompts as **arg-gatherers** and its own before/after diff for the "No changes made" branch (`persona-command.ts:431`); the service owns all fs effects + audit.

```ts
// Type-only pipeline imports allowed; NO value import from pipeline/.
import type { PersonaName } from './types.js';
import type { PersonaDetailDto, PersonaListDto, PersonaEditResultDto } from '../web-ui/web-ui-types.js';

export interface CreatePersonaInput {
  name: string;            // branded inside (path-traversal guard)
  description: string;     // trimmed; min 1
  servers?: string[];      // trimmed; validated ⊆ loadConfig().mcpServers
  memoryEnabled?: boolean; // default true
  constitution?: string;   // optional; default '' (empty persona, no compile)
}

/** actor = `${remoteAddr}#${connId}` (WS), or 'cli'/'cron'. */
export function createPersona(input: CreatePersonaInput, actor: string): PersonaDetailDto;
export function setPersonaConstitution(name: PersonaName, text: string, actor: string): PersonaEditResultDto; // { stale }
export function setPersonaMemory(name: PersonaName, enabled: boolean, actor: string): void;
export function deletePersona(name: PersonaName, actor: string, opts?: { force?: boolean }): void;
export function setPersonaBroadPolicyOptIn(name: PersonaName, enabled: boolean, actor: string): void;
export function getPersonaDetail(name: PersonaName): PersonaDetailDto;   // EXTENDED with memory, allowBroadPolicy
export function listPersonas(): PersonaListDto[];                        // canonical scanner (memory per row)
```

Behavior specifics (each lifted/hardened from `persona-command.ts`):

- **`createPersona`**: `createPersonaName(name)` **first** (bad slug ⇒ `INVALID_PARAMS`). Trim `description`/`servers`. **Validate `servers ⊆ Object.keys(loadConfig().mcpServers)`** (unknown ⇒ `INVALID_PARAMS`; replaces the CLI multiselect's implicit guarantee and the `resolve.ts:161` stderr warning). Normalize a **full-set selection** and **empty array `[]`** to **omit** the `servers` key (CLI "all = undefined" semantics, `persona-command.ts:226-229`). Build the **whole tree atomically**: `mkdir personas/.tmp-<name>-<uuid>/` + `generated/` + `workspace/` (replicate `:244-247`), write `persona.json` via `atomicWriteJsonSync` (mirroring the `:255` `memory:{enabled:false}` omission convention) + `constitution.md` (default `''`) via **`atomicWriteTextSync`**, then `renameSync` temp → `personas/<name>/`. Reject `PERSONA_EXISTS` if the final dir exists **after** branding. `rmSync` the temp dir on any failure (no half-persona). **Does not compile.**
- **`setPersonaConstitution`**: NEW (not lifted from `editViaEditor`, which never writes). Validate persona dir exists; `atomicWriteTextSync(constitution + '\n')`; read `compiled-policy.json.constitutionHash` (`pipeline/types.ts:226`/`:247`/`:278`) and compare to `computeHash(text)` ⇒ `stale`. Absent/missing compiled policy ⇒ `stale: true` (UI renders "not compiled / recompile"). Both CLI `editViaEditor` and `editViaCustomizer`/`editViaGeneration` refactor to call this for the final write+stale-detection.
- **`setPersonaMemory`**: lift the destructure-omit body **verbatim** (`persona-command.ts:413-416`): enable ⇒ **drop** key; disable ⇒ `memory:{enabled:false}`. `atomicWriteJsonSync(persona.json)`.
- **`deletePersona`**: slug-validate; default **soft delete** = `renameSync(getPersonaDir(name) → $IRONCURTAIN_HOME/.persona-trash/<name>-<ISO-ts>/)`. The trash dir is **outside** `getPersonasDir()`, so `scanPersonas`/`resolvePersona` (which brand-then-check, `resolve.ts:65-76`) can never list or resolve it, and it is outside `validatePolicyDir` containment for a persona policyDir. `force: true` ⇒ `rmSync`. Soft-delete is **not** revocation (a tombstone retains the compiled policy); the UI offers "permanently delete (revoke policy)" ⇒ `force: true`.
- **`getPersonaDetail`**: lifted from `persona-dispatch.ts:76-111`, **extended** with `memory: persona.memory?.enabled ?? true` and `allowBroadPolicy: persona.allowBroadPolicy ?? false`.
- **`listPersonas`**: canonical scanner; `mux/persona-scanner.ts:scanPersonas` and the dispatch list both **delegate** to it (single scan implementation prevents drift). Each row carries `memory`.
- Every mutating function writes a tamper-evident **audit record** (§7) and takes `actor`.

### 4.2 `src/persona/event-bus-progress-reporter.ts` (NEW; leaf; type-only pipeline import)
```ts
import type { ServerProgressReporter, CompilationPhase } from '../pipeline/pipeline-shared.js'; // TYPE-ONLY (pipeline-shared.ts:295-322)

export class EventBusProgressReporter implements ServerProgressReporter {
  constructor(
    private readonly ctx: { operationId: string; personaName: string; serverName: string;
      emit: (p: PersonaCompileProgressEvent) => void;
      snapshotUpdate: (s: { serverName: string; compilationPhase: CompilationPhase; detail?: string }) => void; },
  ) {}
  update(phase: CompilationPhase, detail?: string): void {
    // 1) write live phase into the active operation record (snapshot = source of truth)
    this.ctx.snapshotUpdate({ serverName: this.ctx.serverName, compilationPhase: phase, detail });
    // 2) then emit the (best-effort, lossy) progress event
    this.ctx.emit({ name: this.ctx.personaName, operationId: this.ctx.operationId, serverName: this.ctx.serverName, phase, detail });
  }
  complete(phase, summary, elapsed) { this.update(phase, summary); }
  warn(message)                     { this.update('compiling', message); } // routes applyServerAllowlist-style warnings as progress, not stderr
  fail(phase, error)                { /* contributes to terminal failed event */ }
  done(summary)                     { /* contributes to terminal done event */ }
}
```
This is the only place that touches the reporter contract; the dispatch never statically references pipeline.

### 4.3 `src/persona/persona-compile-orchestrator.ts` (NEW; leaf; the ONLY runtime invocation site of `compilePersonaPolicy`)
Owns the long-running model, per-persona serialization, the operation-record store, and security validation.

```ts
interface OperationRecord {
  operationId: string;
  name: PersonaName;
  phase: 'started' | 'running' | 'done' | 'failed';
  serverProgress?: { server: string; compilationPhase: string; detail?: string };
  queuePosition?: number;
  startedAt: string;
  endedAt?: string;
  result?: PersonaCompileResultDto;            // success only
  error?: { code: ErrorCode; message: string };
  actor: string;
  // internal:
  promise: Promise<void>;
  abort: AbortController;
}

const active = new Map<PersonaName, OperationRecord>();   // live snapshot (fast-path UX)
const recent = new Map<string, OperationRecord>();        // bounded LRU (~50) of TERMINAL records by operationId
const globalLimit = pLimit(2);                            // daemon-wide compile-concurrency gate (queue cap ~10)
let auditSecret: Buffer;                                  // generated at daemon startup (in-memory)
```

`startCompile(name, actor, eventBus, allowPolicyMutation)`:
1. If `!allowPolicyMutation` ⇒ `POLICY_MUTATION_FORBIDDEN` (the dispatch checks this **before** any credential read, so a client without mutation enabled never learns credential state). Recompiling a persona that an in-flight workflow is using is **allowed** — the dependency-ordered, per-file-atomic write (§4.4) keeps the workflow's live policy reader consistent, so there is no in-flight interlock. (The FS lock below still serializes *concurrent compiles of the same persona*, which is a separate concern.)
2. Acquire **O_EXCL filesystem lock** `getPersonaGeneratedDir(name)/.compile.lock` (JSON: `{ operationId, startedAt, pid }`). Held by a **live** pid ⇒ `COMPILE_IN_PROGRESS` with the live `operationId` in `error.data` (client attaches to the stream). Stale lock (`process.kill(pid,0)` throws `ESRCH`, or `startedAt` past the wall-clock cap) ⇒ reclaim. The FS lock is the **cross-process** correctness source of truth (CLI/cron/WS mutually exclude); the in-memory `active` Map is the fast UX path.
3. **Credential preflight** for **both** the policy model and the Haiku prefilter model — derive the required env var(s) from `policyModelId`/`prefilterModelId` via the `model-provider` mapping (not hardcoded `ANTHROPIC_API_KEY`); miss ⇒ `CREDENTIALS_MISSING`. **Snapshot** the resolved key(s) once.
4. Mint `randomUUID()` `operationId`; emit `persona.compile.started`; insert the `active` record.
5. If `globalLimit` is saturated and queue depth would exceed ~10 ⇒ `COMPILE_QUEUE_FULL`; else enqueue (return `{ accepted, operationId, queued }`). Inside `globalLimit`, run the detached promise:
   - `const { compilePersonaPolicy } = await import('../persona/compile-persona-policy.js');` (verbatim dynamic-import mirror of `persona-dispatch.ts:118`).
   - Read the persona's **previous** `compiled-policy.json` (for `ruleDelta`) before any write.
   - `await compilePersonaPolicy(name, { reporterFactory: (s) => new EventBusProgressReporter({...}), signal, quiet: true, operationId, allowMcpLists: false, allowedDirectory: getPersonaWorkspaceDir(name), validateCompiled })`. The pipeline runs the LLM work, then calls the **`validateCompiled` hook (the broad-policy validator, §7) on the in-memory compiled policy BEFORE writing any artifact**: reject if any `domains.allowed` / `lists[].allowed` contains a **broad wildcard** (the literal `'*'`, the empty-suffix `'*.'`, or a TLD-level prefix wildcard like `'*.com'` / `'*.gov'` — i.e. a `'*.'`-pattern whose suffix has ≤ 1 label; a per-registered-domain wildcard like `'*.github.com'` is narrow and allowed), or any `paths.within` resolves outside `getPersonaWorkspaceDir(name)` — **unless** `persona.allowBroadPolicy === true`. (The exact-`'*'`-only check was widened — see `isBroadDomainPattern` — because the runtime matcher `domainMatchesAllowlist` treats every `'*.'`-prefixed pattern as a hostname suffix match, so `'*.com'` grants near-wildcard egress.) Reject ⇒ throw ⇒ `BROAD_POLICY_REJECTED`, **nothing written** (prior artifacts intact).
   - On pass, the runner writes the artifact set **directly into `getPersonaGeneratedDir(name)` in dependency order** (§4.4): `dynamic-lists.json` first (or atomically *removed* when empty), then `compiled-policy.json` last — each via per-file atomic tmp+rename. Writes happen only at the very end, so an aborted/failed compile leaves prior artifacts untouched (no staging dir).
   - Compute `ruleDelta` from the previous policy vs the freshly written one.
6. `finally` — **one synchronous critical section** (no `await` between the Map ops): move the record `active → recent`, release the FS lock, then emit `persona.compile.done | persona.compile.failed` (failure carries structured `{ code, error }`; `LoadAPIKeyError` / missing-key text ⇒ `CREDENTIALS_MISSING`).
7. **Wall-clock cap** (default 20 min) fires `abort.signal`, which actually cancels the in-flight `generateText` HTTP call (signal threaded through `createThrottledModel`).

On **daemon startup**: scan persona dirs for `.compile.lock`; for stale locks (dead pid or past cap) emit a synthetic `persona.compile.failed` (operationId from the lock) so a reconnecting UI clears the stuck card, and release the lock. Because artifacts are written atomically and only at the end of a successful compile, the live `generated/` is never left half-written — there is nothing to clean up. Live (pid-alive) locks have their wall-clock cap re-armed.

### 4.4 Pipeline edits (offline tooling, in-layer)
Add to `PipelineRunConfig` (`pipeline-runner.ts:91`):
```ts
readonly reporterFactory?: (serverName: string) => ServerProgressReporter;
readonly signal?: AbortSignal;
readonly quiet?: boolean;
readonly validateCompiled?: (policy: CompiledPolicyFile) => void; // called after compile, BEFORE any artifact write; throw to reject (nothing written)
readonly allowMcpLists?: boolean; // default true (CLI); orchestrator passes false
```
- Replace the two reporter sites:
  - `pipeline-runner.ts:854` → `const reporter = config.reporterFactory?.(serverName) ?? (config.quiet ? throwQuietNoReporter(serverName) : new SpinnerProgressReporter(serverName));`
  - `pipeline-runner.ts:895` → `const reporter = config.reporterFactory?.(serverName) ?? (config.quiet ? throwQuietNoReporter(serverName) : new ParallelProgressReporter(display, serverName));`
  (The `?? new …` CLI fallback is retained only for `quiet:false`; under `quiet:true` an absent `reporterFactory` throws, making the ora fallback impossible in-process.)
- Route the ~24 raw `console.error` narrative sites (e.g. `pipeline-runner.ts:691-703`, `:695`) through an injected logger suppressed when `quiet` (or routed to `onProgress`), so daemon-driven compiles never write to the daemon's shared stderr (which carries the auth `?token=` line).
- **Cooperative cancellation:** check `config.signal` at each server's **per-phase boundary** inside `compileServer` (between `scenarios`/`verify`/`repair`) so a parallel server self-aborts at the next phase; and thread `config.signal` through `createThrottledModel` into each `generateText` `abortSignal` (`constitution-compiler.ts:540`/`:560`/`:629`/`:656`) so in-flight HTTP calls cancel. **Honest scope:** aborts at the next phase boundary + cancels in-flight LLM calls; no instant mid-phase abort.
- `allowMcpLists: false` ⇒ the list-resolver **fails** any `requiresMcp:true` list with a typed error surfaced as `LIST_REQUIRES_MCP` (no live MCP round-trip). Knowledge lists still resolve, capped at **200 values/list**; resolved values feed `ruleDelta`.
- **Artifact write ordering (the core correctness fix).** After a successful compile and after `validateCompiled` passes, write the set **in dependency order, each file via atomic tmp+rename**: `dynamic-lists.json` **first** (when `listDefinitions.length === 0`, atomically *remove* any prior `dynamic-lists.json` instead — fixing the existing stale-file SKIP at `pipeline-runner.ts:657`), then `test-scenarios.json`, then `compiled-policy.json` **last**. This **reverses the current write order** (`compiled-policy` at `:641`, `dynamic-lists` at `:675`). Rationale: the runtime loader `loadPersonaPolicyArtifacts` reads `compiled-policy.json` *then* `dynamic-lists.json` (`config/index.ts:428-429`), so writing lists first guarantees any reader that observes the new compiled policy already sees the lists it references; the reverse interleaving (old compiled + new lists) is fail-safe because an unknown list id expands to empty ⇒ deny. No staging dir / directory rename required.
- `compilePersonaPolicy(name, opts?)` threads `reporterFactory`/`signal`/`quiet`/`validateCompiled`/`operationId`/`allowMcpLists`/`allowedDirectory` into `runner.run`. **`allowedDirectory` defaults to `getPersonaWorkspaceDir(name)`** (stable, persona-bound — NOT the daemon's `~/.ironcurtain/sandbox` fallback baked via `process.env.ALLOWED_DIRECTORY`). Per spike A9 (§12) this is for cache/log stability only — it is **not** the runtime containment authority (runtime sandbox containment uses the coordinator's *live* `allowedDirectory`), so it cannot weaken enforcement regardless of value. The LLM interaction log targets `generated/llm-interactions/<operationId>.jsonl` (append-only, never truncated; closes the unconditional-truncate race).

### 4.5 Atomicity primitives (Phase 0)
- **`atomicWriteTextSync(path, text)`** (NEW; alongside `atomicWriteJsonSync`): `mkdir` + write tmp with the **raw string** + `renameSync` — **no `JSON.stringify`** (constitution.md is markdown; the JSON helper at `escalation-watcher.ts:51-55` would corrupt it). Used for `constitution.md`.
- `atomicWriteJsonSync` reused for single-file `persona.json` rewrites (`setPersonaMemory`).
- **Per-file atomic write + dependency ordering** for the multi-file artifact set (no directory swap): each artifact is written via tmp+rename, and the set is emitted in dependency order — `dynamic-lists.json` before `compiled-policy.json` (§4.4). Combined with the loader's compiled-then-lists read order (`config/index.ts:428-429`), this gives the runtime reader a consistent view (new-compiled ⇒ new-lists-present; the reverse is fail-safe deny), including the empty-lists case (the stale lists file is atomically removed first). This deliberately replaces the heavier staging-dir + directory-rename approach.

**Layering chain:** dispatch → (`await import`) `persona-compile-orchestrator` → (`await import`) `compile-persona-policy.ts` (sanctioned exception) → pipeline values. `persona-service.ts` / `event-bus-progress-reporter.ts` / `persona-compile-orchestrator.ts` carry only type-only pipeline imports.

---

## 5. WS protocol additions

Refactor the router and persona dispatch to the ctx-first, client-aware signature (single call site, `json-rpc-dispatch.ts:40`):

```ts
// json-rpc-dispatch.ts:40
if (method.startsWith('personas.')) return personaDispatch(ctx, method, params, client);

// persona-dispatch.ts
export async function personaDispatch(
  ctx: WorkflowDispatchContext, method: string, params: Record<string, unknown>, client?: WsWebSocket,
): Promise<unknown> { /* ... */ }
```
Assign a `connId` at `handleUpgrade` (`web-ui-server.ts:451`) stored in a `WeakMap<WsWebSocket, string>`; `actor = `${remoteAddr}#${connId}`` (used for audit, §7).

Add to `MethodName` (`web-ui-types.ts:21`) and `ErrorCode` (`:88`).

### New / changed methods (all params via `validateParams`; mutation methods require the daemon's `allowPolicyMutation` kill switch to be on, else `POLICY_MUTATION_FORBIDDEN`; read methods ungated)

```ts
// personas.create  (sync, fast) -> PersonaDetailDto ; emits personas.changed
const createSchema = z.object({
  name: z.string().min(1).max(63),
  description: z.string().trim().min(1),
  servers: z.array(z.string().trim().min(1)).optional(),
  memoryEnabled: z.boolean().optional(),
  constitution: z.string().optional(),       // default '' inside service
});
// errors: INVALID_PARAMS (bad slug / unknown server), PERSONA_EXISTS, POLICY_MUTATION_FORBIDDEN

// personas.editConstitution  (sync) -> PersonaEditResultDto { stale } ; emits personas.changed
const editSchema = z.object({ name: z.string().min(1), constitution: z.string() });
// errors: PERSONA_NOT_FOUND, POLICY_MUTATION_FORBIDDEN

// personas.setMemory  (sync) -> PersonaDetailDto
const memorySchema = z.object({ name: z.string().min(1), enabled: z.boolean() });

// personas.delete  (sync; soft by default) -> { deleted: true } ; emits personas.changed
const deleteSchema = z.object({ name: z.string().min(1), confirmed: z.literal(true), force: z.boolean().optional() });
// z.literal(true) makes an unconfirmed call a schema error; confirmation lives in the UI.

// personas.setBroadPolicyOptIn  (sync, gated) -> PersonaDetailDto
const broadSchema = z.object({ name: z.string().min(1), enabled: z.boolean() });
// the ONLY way to authorize a broad ('*'/out-of-workspace) policy; never inferred from the constitution.

// personas.compile  (REMOVED in Phase 1c — see the SECURITY note below)
// personaNameSchema is still used by personas.get / personas.compileStream.
const personaNameSchema = z.object({ name: z.string().min(1) });

// personas.compileStream  (NEW, fire-and-return; jobs.run shape) -> { accepted:true; name; operationId; queued?:boolean }
// schema = personaNameSchema
// errors: COMPILE_IN_PROGRESS (live operationId in data), COMPILE_QUEUE_FULL, CREDENTIALS_MISSING,
//         BROAD_POLICY_REJECTED (terminal, via failed event), LIST_REQUIRES_MCP (terminal), POLICY_MUTATION_FORBIDDEN

// personas.getCompile  (read, ungated) -> PersonaCompileOperationDto  (active live snapshot else recent)
const getCompileSchema = z.object({ operationId: z.string().min(1) });

// personas.listCompiles  (read, ungated) -> { active: PersonaCompileOperationDto[]; recent: PersonaCompileOperationDto[]; queueDepth: number }
// schema = z.object({})
```

> **SECURITY (Phase 1c): the blocking `personas.compile` method was REMOVED, not kept.** The original §10 1b plan kept it "blocking, back-compat, deprecated-but-supported." A Phase-1c security review found it was a real mutation (it ran the pipeline and overwrote the persona's `compiled-policy.json`) that was **(1) UNGATED** — omitted from the `--allow-policy-mutation` kill switch, so any authenticated WS client on a default daemon could trigger an LLM-driven recompile — and **(2) UNVALIDATED** — it passed no `validateCompiled` hook, so the broad-policy validator never ran and a (possibly prompt-injected) over-permissive policy could be written without the explicit `allowBroadPolicy` opt-in. Keeping a second compile surface re-opened exactly the threat the validator/kill-switch exist to close. There is now a **single** compile surface, `personas.compileStream`, which is both kill-switch gated and runs the validator. The frontend uses `startPersonaCompile` (compileStream) exclusively; the dead `compilePersonaPolicy` store wrapper, `PersonaBlockingCompileResultDto`, and the mock-server `personas.compile` case were all removed. `test/persona-dispatch-crud.test.ts` asserts `personas.compile` is now `METHOD_NOT_FOUND` to guard against reintroduction.

### New / changed DTOs (`web-ui-types.ts`; mirrored manually in `packages/web-ui/src/lib/types.ts`)
```ts
export interface PersonaDetailDto {       // EXTENDED
  readonly name: string; readonly description: string; readonly createdAt: string;
  readonly constitution: string; readonly servers?: readonly string[];
  readonly hasPolicy: boolean; readonly policyRuleCount?: number;
  readonly memory: boolean;               // NEW: persona.memory?.enabled ?? true
  readonly allowBroadPolicy: boolean;     // NEW: persona.allowBroadPolicy ?? false
}
export interface PersonaListDto {         // canonical list row (delegated scanner)
  readonly name: string; readonly description: string; readonly compiled: boolean; readonly memory: boolean;
}
export interface PersonaEditResultDto { readonly stale: boolean; }
export interface RuleDeltaDto {
  readonly added: number; readonly loosened: number; readonly removed: number;
  readonly broadenedDomains: readonly string[]; readonly outOfWorkspacePaths: readonly string[];
}
export interface PersonaCompileResultDto { // reused for SUCCESS ONLY (failures route through the failed event)
  readonly success: true; readonly ruleCount: number; readonly ruleDelta?: RuleDeltaDto;
}
export interface PersonaCompileOperationDto {
  readonly operationId: string; readonly name: string;
  readonly phase: 'started' | 'running' | 'done' | 'failed';     // operation-level lifecycle
  readonly serverProgress?: { readonly server: string; readonly compilationPhase: string; readonly detail?: string }; // per-server CompilationPhase
  readonly queuePosition?: number;
  readonly startedAt: string; readonly endedAt?: string;
  readonly result?: PersonaCompileResultDto;
  readonly error?: { readonly code: ErrorCode; readonly message: string };
  readonly actor: string;
}
export interface DaemonStatusDto {        // EXTENDED
  /* ...existing... */
  readonly allowPolicyMutation: boolean;  // NEW: from ctx, so the UI can hide mutation controls
}
```
> **Two phase vocabularies, documented:** `PersonaCompileOperationDto.phase` is the operation lifecycle; `serverProgress.compilationPhase` is the 9-value `CompilationPhase` from `pipeline-shared.ts:295` (type-only import). `PersonaCompileResultDto` is success-only — a `done` record never carries `success:false`. The existing blocking `personas.compile` keeps its current return shape (`{ success, ruleCount, errors? }`) unchanged for back-compat; only `personas.compileStream` uses the success-only `PersonaCompileResultDto` on its `done` event.

### New error codes (`web-ui-types.ts:88`)
`PERSONA_EXISTS`, `COMPILE_IN_PROGRESS`, `COMPILE_QUEUE_FULL`, `CREDENTIALS_MISSING`, `POLICY_MUTATION_FORBIDDEN`, `LIST_REQUIRES_MCP`, `BROAD_POLICY_REJECTED`.

### New events (`WebEventMap`, `web-event-bus.ts:23`; `CompilationPhase` type-only)
```ts
'persona.compile.started':  { name: string; operationId: string; actor: string };
'persona.compile.progress': { name: string; operationId: string; serverName: string; phase: CompilationPhase; detail?: string };
'persona.compile.done':     { name: string; operationId: string; result: PersonaCompileResultDto };
'persona.compile.failed':   { name: string; operationId: string; code: ErrorCode; error: string };
'personas.changed':         Record<string, never>;   // mirrors job.list_changed
```

---

## 6. Long-running operation & progress / cancel model

Reuse the `jobs.run` / `workflows.start` precedent verbatim — **no** generic job kernel.

- `personas.compileStream` emits `persona.compile.started` and returns `{ accepted, operationId }` synchronously (mirrors `job-dispatch.ts:63-74`); a detached promise (inside `globalLimit`) emits `done`/`failed`.
- Per-server `CompilationPhase` progress flows `reporterFactory → EventBusProgressReporter → persona.compile.progress`, disambiguated by `serverName`. Multi-server personas take the parallel branch (`useParallel`, `pipeline-runner.ts:803`), so **both** reporter sites (`:854`/`:895`) are substituted.
- **Snapshot is the source of truth; events are best-effort/lossy.** `broadcast()` (`web-ui-server.ts:212`) only reaches currently-open clients. `EventBusProgressReporter.update()` writes the live `{serverName, compilationPhase, detail}` into the `active` record **before** emitting, so a reconnecting client renders the current phase from a single `personas.listCompiles` call. The `active → recent` transition is one synchronous critical section (`getCompile`/`listCompiles` read both in one synchronous pass; an op is always findable in exactly one). `startCompile` re-checks the op is genuinely still active before throwing `COMPILE_IN_PROGRESS`; if it just settled, it treats the request as a fresh compile.
- **Serialization & concurrency:** per-persona in-memory `active` Map (fast UX) **backed by** an O_EXCL FS lock (cross-process correctness). Cross-persona fan-out bounded by `globalLimit = pLimit(2)` (the per-`run()` throttle is independent, so without this N compiles = N semaphores), plus a per-daemon token/cost ceiling (reusing the `ResourceBudgetTracker` pattern) threaded via `signal`. Queue depth/position surfaced via `listCompiles`; over-cap ⇒ `COMPILE_QUEUE_FULL`.
- **Cancellation (v1, honest):** the wall-clock cap (20 min) fires an `AbortSignal` that aborts at the next phase boundary of each in-flight server **and** cancels in-flight `generateText` HTTP calls. `operationId` is the reserved handle for a future `personas.cancelCompile`. Because the FS lock serializes same-persona compiles and artifacts are written only at the very end (after validation), an aborted compile writes nothing — prior artifacts stay intact and the content-hash cache is never poisoned by a partial run.
- **Restart recovery:** the FS lock is the in-progress sentinel; writing artifacts only at the end (atomically, in dependency order) means the live `generated/` is never left mid-flight. The startup stale-lock scan emits synthetic `persona.compile.failed` so reconnecting UIs clear stuck cards. Atomic artifacts make recompile idempotent.

---

## 7. Security, authz & audit model

Policy *is* the boundary. v1's deployment model is a **single-operator, localhost, opt-in** daemon (`--web-ui`, origin-checked, 10-client cap), so there is no privilege gradient between "may use the UI" and "may manage personas" — it is one operator. The gate is therefore *existence* (mutation off by default), not a second credential.

### Threat
With no per-method authz, a token-bearing/hijacked tab could compile an allow-all constitution that — in workflow shared-container mode — gets hot-swapped live via `ToolCallCoordinator.loadPolicy` (`tool-call-coordinator.ts:551`). The connection token is in the printed `?token=` URL (`web-ui-server.ts:168`), logged by proxies/history. **Scoping note:** in the single-operator model the token holder *is* the authorized operator, so the residual concern is token *theft* enabling additional privilege — which has no privilege gradient to escalate across here. A second (admin) credential would be defending the operator from themselves while adding key management and an unsolved "how does the browser receive a token deliberately kept out of the URL" UX problem; the token-in-URL weakness is a **daemon-wide** issue (it affects sessions/escalations/everything), to be fixed once at the transport layer if/when the daemon goes multi-user (§14), not bolted onto this one feature.

### Authz gate — the kill switch
**`--allow-policy-mutation`** (default **OFF**, CLI-only per invocation; **not** config-persisted, so it can't be silently enabled by editing `config.json`). 4-hop plumbing mirroring `captureTracesDefault`: `daemon-command.ts` CommandSpec option (`:39` block) + `parseArgs` option (`:92` block) + read + pass → `IronCurtainDaemonOptions` field → `WebUiServerOptions` field → `dispatchCtx` (`web-ui-server.ts:96`). When off, **all** mutation methods (`create`/`editConstitution`/`setMemory`/`delete`/`setBroadPolicyOptIn`/`compileStream`) return `POLICY_MUTATION_FORBIDDEN`; read methods stay ungated. `DaemonStatusDto.allowPolicyMutation` (populated in `buildStatusDto`, `dispatch/types.ts:94`, from `ctx` — the field is added to `DispatchContext`) lets the UI hide controls. So the mutation surface does not exist unless the operator deliberately launched the daemon with the flag: explicit, auditable, off-by-default. A second (admin) capability is **out of scope for v1** (deferred to multi-user hardening, §14).

### Blast-radius containment (Phase 1 invariants)
- **All writes** target persona dirs or `.persona-trash/` — **never** the active runtime dir (`getUserGeneratedDir()`, `config/paths.ts:284`).
- **Concurrent recompile is allowed — no interlock, no snapshot.** A persona may be recompiled even while a workflow using it is mid-run. Safety comes from the **dependency-ordered, per-file-atomic artifact write** (§4.4): `dynamic-lists.json` lands before `compiled-policy.json`, and the runtime loader reads compiled-then-lists, so `cyclePolicy`'s next per-state-entry read either sees the whole prior policy or a new compiled policy whose lists are already present; an id mismatch expands to empty ⇒ deny (fail-safe). The existing server-set-expansion guard (`orchestrator.ts:1125-1138`) stays as defense-in-depth. (Pinning a run to its start-time policy via a copy-at-start snapshot is a possible Phase-2 nicety, not a v1 need.)
- **Tool annotations are CLI-only — a hard invariant.** No WS method creates or modifies `tool-annotations.json` (generated by `ironcurtain annotate-tools`). Annotations classify each tool's argument roles, which directly drive policy evaluation, so editing them via the Web UI would be a second, subtler way to subvert policy semantics. Persona/global compilation only ever *reads* annotations from the global generated dir; it never regenerates them. (`annotate-tools` also needs in-process MCP connections the daemon must not own and mutates `process.env.ALLOWED_DIRECTORY` globally at `annotate.ts:256` — independent reasons it must never run in the daemon — but the invariant stands regardless: it is simply not a Web-UI capability.)
- **Path traversal** closed by `createPersonaName` branding before any fs op.
- **Atomicity** (per-file atomic writes + dependency ordering + FS lock) closes the corruption/over-permit races.
- **Prompt-injection ceiling** — the attacker controls the constitution text fed to the compiler LLM. Two structural controls **independent** of the LLM:
  1. The post-compile **broad-policy validator** rejects `domains.allowed` / `lists[].allowed` containing a **broad wildcard** (literal `'*'`, empty-suffix `'*.'`, or a TLD-level `'*.'`-pattern whose suffix has ≤ 1 label, e.g. `'*.com'` / `'*.gov'`; `'*.github.com'` is narrow and allowed — see `isBroadDomainPattern`), or any `paths.within` outside `getPersonaWorkspaceDir(name)` — unless `persona.allowBroadPolicy === true` (set only via the gated `personas.setBroadPolicyOptIn`, never inferred from the constitution). A single WS call cannot silently produce an allow-`*`/networked policy. (`paths.within` is a single string per `CompiledRuleCondition`, `pipeline/types.ts:103`/`:121`; `domains.allowed`/`lists[].allowed` are `string[]`, `:106-124`.)
  2. **Compile-time diff** — the `done` event and `PersonaCompileResultDto.result` carry `ruleDelta` vs the persona's previous `compiled-policy.json`; the UI surfaces it. Because Phase-1 compile writes only the persona dir, the diff is reviewable after the fact; combined with the dependency-ordered write keeping every reader consistent, no blocking confirm-before-write is needed.
  - Documented in `src/persona/CLAUDE.md`: LLM-as-judge verification is **not** an adversarial authz control.
- **Supply-chain edge** — `requiresMcp:true` dynamic-list resolution is **disabled** on the WS path (`allowMcpLists:false` ⇒ `LIST_REQUIRES_MCP`), eliminating compile-time live MCP I/O that could inject allowlist entries. The CLI (local trusted user) retains it. Knowledge-list values are capped (200/list) and appear in `ruleDelta`.

### Audit
Written at the **persona-service layer** (`persona-service.ts` + `persona-compile-orchestrator.ts`), **not** the WS dispatch — so CLI, cron, and WS mutations are all captured by construction, and the server layer never needs to know which methods mutate. File: `$IRONCURTAIN_HOME/audit/policy-mutation.jsonl`, opened `O_APPEND` with `0600`, size-rotated at 10 MB (`.1`/`.2` suffixes). Each record carries: `actor` (`remoteAddr#connId` for WS, or `cli`/`cron`), method + persona name, timestamp, constitution content hash, resulting rule-count delta + broadening flags, and `operationId` (ties to the per-op `llm-interactions/<operationId>.jsonl`). Tamper-evidence: a monotonic `seq` + `prevHash` chain HMAC'd with a daemon-private secret held in process memory (regenerated each startup). **Honest scope:** detects post-hoc edits by anyone **without** the in-memory secret (covers the WS-reachable surface); does **not** defend against a full-local-user fs attacker (who can write the policy files directly — the threat the audit attributes).

### Error surface hygiene
Mutation methods and `persona.compile.failed` return **typed codes** with operator-safe messages only; raw exception text (absolute paths, provider error strings) goes to the server log + the audit record, never through `INTERNAL_ERROR` for these methods. `CREDENTIALS_MISSING` is admin-gated (a read-only client never sees it — the method returns `POLICY_MUTATION_FORBIDDEN` before any credential check runs).

---

## 8. Module-layering enforcement (Phase 0, lands before the new seam)
- **ESLint `no-restricted-imports`** (`eslint.config.js` currently has no import-boundary rule, confirmed by spike A3) forbidding non-`type` static imports `from '../pipeline/...'` in `src/web-ui/**`, `src/persona/persona-service.ts`, `src/persona/persona-compile-orchestrator.ts`, `src/persona/event-bus-progress-reporter.ts`.
- **madge static-graph vitest test** asserting that loading `persona-service.ts` and `persona-compile-orchestrator.ts` does **not** pull in `pipeline-runner.ts` (i.e., the only pipeline value edge stays behind the dynamic import).

---

## 9. Frontend plan (Svelte 5 + runes)

Extend `routes/Personas.svelte` (already consumes list/get/compile).

- **Stores** (`lib/stores.svelte.ts`, next to the existing persona block): `createPersona`, `editPersonaConstitution`, `setPersonaMemory`, `setPersonaBroadPolicyOptIn`, `deletePersona(name, confirmed, force)`, `startPersonaCompile(name) → {operationId}` (calls `personas.compileStream`), `getPersonaCompile(operationId)`, `listPersonaCompiles()`. Add reactive `personaCompiles: Map<string, PersonaCompileOperationDto> = $state(new Map())` keyed by persona name.
- **Event handling** (`event-handler.ts` — **three edits per event**: `WebEvent` union `:123`, `parseEvent()` `:175`, `applyEvent()` `:259`): cases for the 5 new events. `persona.compile.started/progress` upsert the map (live phase); `done` clears + refreshes that persona's detail; `failed` records the typed code; `personas.changed` ⇒ `refreshPersonas` (mirroring `job.list_changed → refreshJobs`). vitest exercises `parseEvent → applyEvent` end-to-end (raw wire payload → state mutation), not just `applyEvent` with a pre-parsed object.
- **UI**:
  - "New Persona" form: slug-validated name, description, server multiselect sourced from a real server list with an explicit **"All servers (incl. future)"** default distinct from manual narrowing (sends `servers` only when the user narrows the set), memory toggle, optional constitution textarea (replaces `$EDITOR`; LLM generation/customizer stay CLI-only in v1).
  - Detail view: live phase indicator from `personaCompiles.get(name)?.serverProgress?.compilationPhase`, replacing the blocking spinner.
  - Edit-constitution textarea with dirty/unsaved tracking + a "policy stale — recompile" Badge from `result.stale`.
  - Delete: confirm dialog sending `confirmed:true`, with a "permanently delete (revoke policy)" checkbox ⇒ `force:true`.
  - Memory toggle ⇒ `setMemory`; `ruleDelta` shown on the `done` card (prompt-injected broadening reviewable).
  - **Reconnect:** call `listCompiles`; hydrate in-flight cards; any locally-tracked op **absent** from the response is marked `interrupted` with a "recompile" action (mirroring the workflow synthesized `interrupted` phase, `web-ui-types.ts:182`).
  - **Error/empty/loading states:** `CREDENTIALS_MISSING` → "set ANTHROPIC_API_KEY on the daemon host"; `COMPILE_IN_PROGRESS` → `error.data.operationId` ⇒ **attach** to the stream (not an error); `PERSONA_EXISTS`/`INVALID_PARAMS` → inline create-form field errors; `BROAD_POLICY_REJECTED` → actionable message pointing at the broad-policy opt-in.
  - All mutation controls gated behind `appState.daemonStatus.allowPolicyMutation`.
- **DTO mirror** (`lib/types.ts`): `memory` + `allowBroadPolicy` on `PersonaDetailDto`, `memory` on `PersonaListDto`, `PersonaEditResultDto`, `RuleDeltaDto`, `PersonaCompileResultDto` (success-only), `PersonaCompileOperationDto`, the 5 event payloads, `allowPolicyMutation` on `DaemonStatusDto`.
- **Mock server** (`packages/web-ui/scripts/mock-ws-server.ts` — backs Playwright, **must stay in sync**): add an in-memory `active`+`recent` Map, an `operationId` minter, `getCompile`/`listCompiles` reading from it. Convert `personas.compile` precedent: add `personas.compileStream` returning `{accepted, operationId}` then broadcast `started → progress(×2 canned phases) → done`, writing a **terminal** record into `recent` at/just-before `done` (so post-completion `getCompile` succeeds and the reconnect-hydration e2e is real). Add `create`/`editConstitution`/`setMemory`/`delete`/`setBroadPolicyOptIn` handlers mutating canned details. `allowPolicyMutation: true` by default; the flag-OFF e2e overrides it per-test via the existing `POST /__reset` endpoint. Keep blocking `personas.compile` for the back-compat path.

---

## 10. Phased implementation plan (ordered, shippable)

| Phase | Scope | WS surface? | Rough effort |
|---|---|---|---|
| **0** | `atomicWriteTextSync`; **per-file atomic writes + dependency-ordered artifact emission** in the runner (lists before compiled-policy; remove stale lists when empty; reverses today's write order); `reporterFactory`/`signal`/`quiet`/`allowMcpLists`/`validateCompiled` on `PipelineRunConfig` + the two reporter substitutions + per-phase signal checks + `abortSignal` through `generateText`; per-`operationId` LLM log; ~24 `console.error` suppression-when-quiet; ESLint `no-restricted-imports` boundary rule + madge static-graph test. **Strict prerequisite (lands FIRST, on the current pre-refactor code): a fake-`PipelineModels` harness + a captured golden `compiled-policy.json`** (§11) — the rest of Phase 0 must keep it structurally identical. | No | ~2–3 d |
| **1a** | `persona-service.ts` (zero compile reference); refactor `persona-command.ts` to call it (prompts + "No changes" diff stay in CLI). No behavior change; full unit tests. | No | ~2 d |
| **1b** | ctx-first `personaDispatch` (+`client`/`connId`); `event-bus-progress-reporter.ts` + `persona-compile-orchestrator.ts` (active Map + recent LRU + FS lock + `globalLimit` + wall-clock cap + stale-lock recovery + snapshot-as-truth); thread opts through `compilePersonaPolicy` (incl. persona-workspace `allowedDirectory` + `allowMcpLists:false`); `personas.compileStream` + the 5 events + `getCompile`/`listCompiles`; `CREDENTIALS_MISSING` preflight (both models) + post-dispatch classification. Frontend live indicator + reconnect hydrate. Mock + e2e. `personas.compile` kept blocking (no breaking change). | Yes (compile streaming) | ~3–4 d |
| **1c** | `personas.create`/`editConstitution`/`setMemory`/`delete`/`setBroadPolicyOptIn` + DTOs + new error codes + `personas.changed`; `--allow-policy-mutation` kill switch (4-hop) + `connId` + persona-service audit (chained); broad-policy validator + `ruleDelta`; soft-delete → `.persona-trash`. Frontend create form / edit textarea / delete confirm / memory toggle / `ruleDelta` / mutation-gating. | Yes (full CRUD) | ~4–5 d |
| **2** (deferred) | `compileGlobalPolicy(opts)` packaged like `compile-persona-policy.ts` (writes `getUserGeneratedDir()` = the **live active dir**, `config/paths.ts:284`), reached by `await import`; `policy.*` dispatch reusing fire-and-return + events + orchestrator. **Hard prereqs:** the ordered atomic-write discipline (§4.4) is **mandatory** for the global dir; a reserved `GLOBAL` singleton serialization key; a stronger operator confirmation (daemon-wide blast radius); and because global policy governs *all* sessions/workflows (where the per-persona ordered-write guarantee is weaker leverage), Phase 2 is where a copy-at-start **snapshot** (pin an in-flight run to its start-time policy) likely earns its complexity. Security model restated: "persona-dir-only writes" is a **Phase-1-only** property. | Yes (global) | (future) |
| **3** (deferred, optional) | Extract the **pure** customizer core (`applyChanges`+diff+`callLlm`) into a headless step shared by the `@clack` loop and a WS handler (prevents divergence); customize over WS (client holds `ModelMessage[]` per `operationId`). **`annotate-tools` is explicitly NOT in this (or any) phase** — tool-annotation generation is a permanent Web-UI non-goal (CLI-only; §2/§7). | Yes (authoring) | (future) |

---

## 11. Test plan

**vitest (backend):**
- `persona-service`: create/setConstitution/setMemory/delete against a temp `IRONCURTAIN_HOME` (headless-testable now): `servers='all'` ⇒ omit key; `[]` ⇒ reject; unknown ⇒ `INVALID_PARAMS`; memory enable ⇒ no key / disable ⇒ `{enabled:false}` (asserting the `exactOptionalPropertyTypes` destructure-omit body); whole-tree atomic create + temp-dir rollback on failure; soft-delete ⇒ `.persona-trash` unresolvable (and `loadPolicy` cannot target it).
- orchestrator: `COMPILE_IN_PROGRESS` dedup; FS-lock cross-process exclusion; `active → recent` synchronous transition + a second compile fired in the settle-but-not-cleaned window; stale-lock startup recovery (dead-pid + past-cap); `globalLimit` queueing + `COMPILE_QUEUE_FULL`; `validateCompiled` reject ⇒ no artifact written (prior artifacts intact); abort before the write leaves prior artifacts intact.
- broad-policy validator: rejects broad-wildcard domain/list entries (`'*'`, `'*.'`, TLD-level `'*.com'`/`'*.gov'`; `'*.github.com'` is narrow — see `isBroadDomainPattern`) / out-of-workspace `paths.within`; passes when `allowBroadPolicy`.
- per-op LLM log non-truncation across two sequential compiles.
- **A4 concurrency:** a worker-thread writer doing the **dependency-ordered, per-file-atomic** emission (lists-then-compiled; stale-lists removal on empty) vs the **actual** two-read `loadPersonaPolicyArtifacts` loop (`compiled-policy.json` + `dynamic-lists.json`), asserting the reader **never sees a new compiled policy ahead of its lists** (new-compiled ⇒ new-lists-present), that the reverse interleaving is fail-safe (unknown list id ⇒ empty ⇒ deny), and that the empty-lists case removes the stale file; plus a `constitution.md` **text** path (`atomicWriteTextSync`) and a `persona.json` path (`setPersonaMemory` writer vs `scanPersonas`/`loadPersona` reader).
- A2 method: a single-server compile asserting the captured `CompilationPhase` sequence via a test `reporterFactory`.
- **Golden compiled-policy (characterization — built and committed BEFORE the Phase-0 refactor).** The model is injected through the existing `PipelineRunner(models: PipelineModels)` constructor seam (`pipeline-runner.ts:584`); `baseLlm`/`prefilterModel` are `LanguageModel`s threaded to the only `generateText` sites via `options.model` (`constitution-compiler.ts:485/501/540/560/629/656`), so a fake needs **no production change**. Build a mock `PipelineModels` whose `baseLlm`/`prefilterModel` **replay recorded responses** (record once from a real run; cover the initial compile + a repair retry + a knowledge-list so the golden is non-trivial), compile a fixed constitution + annotations fixture on the **current** pipeline, and commit the resulting `compiled-policy.json` (+ `dynamic-lists.json`) as the golden fixture. The Phase-0 refactor then asserts **structural deep-equality** against the golden (parse + deep-equal, not byte compare) — any unintended change to rule output fails. This is the gate that proves `reporterFactory`/`quiet`/`allowMcpLists`/`validateCompiled`/the write-reorder are output-preserving. Capturing it *after* the refactor would defeat the purpose (it would enshrine whatever the refactor changed).
- Static madge test: `persona-service`/orchestrator do **not** load `pipeline-runner.ts`.
- Cancellation: abort after `server[0]` completes ⇒ a subsequent full compile does **not** cache-hit the aborted server's artifacts.
- Migration: legacy `persona.json` with no memory block reads `memory:true` uniformly; absent/`constitutionHash`-less compiled policy ⇒ `stale:true` rendered as "not compiled"; malformed legacy `persona.json` is skipped by the scanner (`persona-scanner.ts` catch).

**vitest (frontend):** `parseEvent → applyEvent` end-to-end for all 5 new events.

**Playwright e2e (extended mock):** create → appears in list; `compileStream` → phases render → compiled badge + `ruleDelta`; edit → stale badge; delete → confirm → removed; force-delete revokes; flag-OFF → mutation controls hidden; reconnect → in-flight card rehydrates; daemon-restart-during-compile → card marked `interrupted`; failed-compile + credentials-missing render their typed affordances.

---

## 12. Spike validation appendix

| ID | Assumption (abridged) | Verdict | Evidence (file:line) |
|---|---|---|---|
| **A1** | Daemon has `ANTHROPIC_API_KEY` at compile-RPC time; absent ⇒ typed error, not crash. | **CONFIRMED** | `dotenv/config` loads synchronously (`cli.ts:2`); `applyEnvOverrides` reads `process.env` lazily at RPC time (`user-config.ts:816`); absent ⇒ `LoadAPIKeyError` surfaced as `{success:false, errors:[...]}` (`persona-dispatch.ts:124`). Preflight kept as UX (typed code immediately), **not** load-bearing; extended to check policy **and** prefilter model creds + classify the SDK error post-dispatch. |
| **A2** | Phase progress can be bridged via a `reporterFactory` injection without a layering violation. | **CONFIRMED** | No `reporterFactory` today; reporters hardcoded (`pipeline-runner.ts:854`/`:895`); `config.onProgress` reaches only repair sub-steps (`:1634`/`:1684`). `ServerProgressReporter`/`CompilationPhase` are clean type contracts (`pipeline-shared.ts:295-322`). Both sites capture the full phase sequence. `EventBusProgressReporter` uses a type-only import. |
| **A3** | `compilePersonaPolicy` is dynamic-import-lazy; a new global consumer entry mirrors the pattern; no ESLint boundary rule exists. | **CONFIRMED** | Dynamic import at `persona-dispatch.ts:118`; ~29 ms startup vs ~119 ms first-RPC lazy load; zero value-level pipeline imports in hot-path dirs; `eslint.config.js` has no import-boundary plugin ⇒ Phase-0 lint rule + madge test added. |
| **A4** | `writeArtifact` is non-atomic; partial reads observable; needs atomic + multi-file fix. | **CONFIRMED + ESCALATED** | `writeArtifact = mkdirSync+writeFileSync` (`pipeline-shared.ts:195-198`); worker-thread reader saw ~97% partial-read corruption; per-file atomicity alone doesn't fix *cross-file* consistency — `loadPersonaPolicyArtifacts` reads two files non-transactionally (`config/index.ts:428-429`), with an empty-lists SKIP (`pipeline-runner.ts:657`) leaving a permanent stale file ⇒ **per-file atomic writes + dependency ordering** (lists before compiled-policy; remove stale lists when empty), making new-compiled ⇒ new-lists-present and the reverse fail-safe (deny) — no directory swap needed. `atomicWriteJsonSync` always stringifies (`escalation-watcher.ts:51-55`) ⇒ new `atomicWriteTextSync` for markdown. |
| **A5** | `annotate-tools` needs in-process MCP connections the daemon must not own; fork it. | **CONFIRMED** | `annotate.ts` spawns raw `StdioClientTransport` per server held across LLM annotation; `compile-policy` uses only `connectViaProxy` (one supervised child); the daemon has zero MCP connections. `annotate.ts:256` also does a global `process.env.ALLOWED_DIRECTORY = process.cwd()` mutation that would pollute every in-daemon compile. ⇒ **never exposed via the Web UI** (permanent non-goal, CLI-only); compilation only *reads* `tool-annotations.json`. |
| **A7** | No concurrency guard; three races (log truncate, artifact overwrite, double cost). | **CONFIRMED** | No guard in `persona-dispatch.ts:113-131`; shared `llm-interactions.jsonl` truncate via `initLogFile`; non-atomic `compiled-policy.json` overwrite; lock-free cache check. ⇒ per-persona `active` Map + O_EXCL FS lock + per-`operationId` log path + directory-swap + `globalLimit`. |
| **A8** | `personaDispatch` can be made ctx-first via the single router branch. | **CONFIRMED** | Single call site `json-rpc-dispatch.ts:40`; `client` already threaded into `dispatch` (`:31`, `web-ui-server.ts:521`) so adding `ctx`/`client` is a one-line router edit + signature change. |
| **A6** | Single bearer token is insufficient authz for mutation. | **DESIGN DECISION (not a code spike)** | Threat-modeled for the **single-operator localhost** target ⇒ default-off `--allow-policy-mutation` kill switch is the gate (no privilege gradient to a second credential), + persona-service audit + blast-radius containment (dependency-ordered atomic writes / broad-policy validator / annotations-CLI-only invariant). A separate admin token was considered and **rejected as over-built for v1** (deferred to multi-user hardening, §14). |
| **(workflow hot-swap)** | A WS recompile of an in-flight persona is hot-swapped into a running session. | **CONFIRMED (devil's-advocate)** | `getPolicyDir` resolves the **live** persona dir (`orchestrator.ts:1064`, `:4542`); `cyclePolicy` (`:1111`) loads from it; the only guard rejects server expansion (`:1125-1138`). ⇒ **accepted by design**: recompiling mid-run is allowed; the dependency-ordered, per-file-atomic write (§4.4) keeps `cyclePolicy`'s next read consistent (new-compiled ⇒ new-lists-present; id mismatch ⇒ deny). No interlock, no snapshot, no change to `getPolicyDir`/`cyclePolicy`. (The *separate* containment-governance question is resolved by A9 below.) |

| **A9** | Runtime `paths.within` containment governance: live coordinator `allowedDirectory` vs compile-time-baked value? | **CONFIRMED (resolved — was the Phase-1b blocker)** | Both `protectedPaths` (arg 3) and `allowedDirectory` (arg 4) are **runtime `PolicyEngine` constructor args** (`policy-engine.ts:316-328`), not baked into `compiled-policy.json`. Sandbox containment is a **structural** invariant evaluated against the **live** `this.allowedDirectory` (`:735-748`), and the compiler is forbidden from emitting `paths.within: <sandbox>` rules (`:729-735`). Empirical (no-LLM) harness over the real `PolicyEngine` + test fixtures: holding the compiled policy + request constant and flipping only the runtime `allowedDirectory` flips `read_file` on the sandbox file **allow ↔ escalate** (live value governs sandbox containment); an explicit baked `paths.within: permitted-a` rule fires `allow` regardless of the live dir (baked value governs *explicit non-sandbox* rules only). |

**Resolution & design implication (A9):** Persona policies **are** workspace-portable for sandbox containment — the runtime sandbox boundary is whatever `allowedDirectory` the session/workflow constructs its `ToolCallCoordinator` with, never the compile-time value. Consequently the compile-time `allowedDirectory = getPersonaWorkspaceDir(name)` (§4.4) is **harmless but NOT load-bearing for runtime containment** — keep it for cache/log stability, but the actual containment authority is the coordinator's live `allowedDirectory` + `protectedPaths`, which the existing session/workflow wiring already sets correctly. A WS-driven recompile only changes the compiled rules; it cannot change the runtime sandbox boundary. The only compile-time-baked path values are explicit *non-sandbox* `paths.within` rules (protected-path escalations), which are host-global and persona-independent. **No Phase-1b blocker remains.**

---

## 13. Devil's-advocate findings & resolutions

| # | Finding | Sev | Status | Resolution (anchor) |
|---|---|---|---|---|
| 1 | In-flight workflow picks up a WS-weakened persona policy (no rule-weakening guard) | critical | **accepted (by design)** | Recompiling mid-run is allowed; safety is the dependency-ordered, per-file-atomic write (lists before compiled-policy) — `cyclePolicy`'s next read sees a consistent set, id mismatch is fail-safe deny (§4.4, §7). No interlock or snapshot in v1. |
| 2 | `--allow-policy-mutation` is a process-global boolean gating a per-request capability | critical | **accepted (by design, scoped)** | For the **single-operator localhost** v1 there is no per-request privilege gradient, so a process-global default-off kill switch *is* the correct gate. Per-actor / admin capability and connection-token hardening are deferred to multi-user (§7, §14). |
| 3 | Atomic per-file write doesn't close the cross-file torn read (`compiled-policy.json` + `dynamic-lists.json`; empty-lists SKIP = permanent stale) | critical | **fixed** | **Dependency ordering**: write lists before compiled-policy (per-file atomic), reverse of today's order; reader reads compiled-then-lists ⇒ new-compiled implies new-lists; empty-lists ⇒ stale file removed first (§4.4, §4.5). No staging dir. |
| 4 | `atomicWriteJsonSync` is JSON-only; `constitution.md` is markdown | critical | **fixed** | New `atomicWriteTextSync` (raw write + rename) for markdown (§4.5). |
| 5 | Attacker-controlled constitution → over-permissive rules (prompt injection) | high | **fixed** | LLM-independent broad-policy validator (rejects broad-wildcard domains/lists — `'*'`, `'*.'`, TLD-level `'*.com'`/`'*.gov'` per `isBroadDomainPattern` — and out-of-workspace `paths.within` unless `allowBroadPolicy` opt-in) + compile-time `ruleDelta`; doc that LLM-judge ≠ authz (§7). |
| 6 | `requiresMcp` list resolution = LLM+MCP supply-chain injection path | high | **fixed** | WS path sets `allowMcpLists:false` ⇒ `LIST_REQUIRES_MCP`; knowledge lists capped 200 + in `ruleDelta`; CLI retains full capability (§4.4). |
| 7 | `compilePersonaPolicy` bakes wrong `allowedDirectory` via `process.env.ALLOWED_DIRECTORY` fallback | high | **fixed** | Spike A9 (§12) showed the compile-time `allowedDirectory` is **not** the runtime containment authority (live `PolicyEngine` constructor args govern), so this cannot weaken enforcement. Still pass `getPersonaWorkspaceDir(name)` for cache/log stability; test asserts no stale `~/.ironcurtain/sandbox` paths. |
| 8 | `persona-service.ts` one careless import from a static pipeline value-edge | high | **fixed** | Zero compile reference in service; orchestrator-only dynamic import; Phase-0 ESLint rule + madge test (§8). |
| 9 | `writeArtifact` atomic fix covers single files not the multi-file race | high | **fixed** | Directory-atomic swap (same as #3). |
| 10 | Progress events fire-and-forget; mid-compile disconnect loses all phase events | high | **fixed** | Snapshot-as-truth: `update()` writes the live phase into `active` before emitting; `listCompiles`/`getCompile` serve the live snapshot (§6). |
| 11 | Daemon restart mid-compile orphans the op; `generated/` indeterminate | high | **fixed** | FS lock sentinel; artifacts written only at the end (atomically, ordered) ⇒ live dir never mid-flight; startup stale-lock scan emits synthetic `failed` (§4.3, §6). |
| 12 | `llm-interactions.jsonl` unconditionally truncated at compile start | high | **fixed** | Per-`operationId` log path `generated/llm-interactions/<operationId>.jsonl` (append-only) (§4.4). |
| 13 | "Different personas run concurrently safely" ignores the shared LLM semaphore | high | **fixed** | Daemon-global `globalLimit = pLimit(2)` + queue cap + per-daemon cost ceiling (§6). |
| 14 | Audit log plaintext, bypassable | high | **mitigated** | Service-layer write (captures CLI/cron/WS); `O_APPEND` 0600 + seq/prevHash HMAC chain (in-memory secret); honest scope (§7). |
| 15 | `setPersonaConstitution` citation wrong (`editViaEditor` never writes) | high | **fixed** | Specified as a NEW write-and-hash-compare function; both CLI edit paths refactor to it; CLI keeps its own diff (§4.1). |
| 16 | `createPersona` conflates non-atomic write steps; changes failure semantics | high | **fixed** | Whole-tree temp-dir-then-rename; constitution optional (empty persona preserved); rollback on failure (§4.1). |
| 17 | `persona.json` mutations not atomic — corruption window for `loadPersona` | high | **fixed** | `atomicWriteJsonSync` for `persona.json`; added to the race-test matrix (§4.5, §11). |
| 18 | Audit `actor` needs the client socket, which `personaDispatch` lacks | high | **fixed** | ctx-first + `client` threaded; `connId` `WeakMap` at upgrade; audit at the service layer (§5, §7). |
| 19 | Frontend `parseEvent()` switch omitted from the wiring | high | **fixed** | Three edits per event (union + `parseEvent` + `applyEvent`); end-to-end vitest (§9, §11). |
| 20 | Cross-file torn read (duplicate root cause of #3) | critical | **fixed** | Directory-atomic swap + the two-read consistency test (§11). |
| 21 | Phase 2 global compile writes the live active dir — breaks the "never write active dir" guarantee | medium | **deferred** | Sharpened: ordered atomic writes mandatory for the global dir; `GLOBAL` singleton key; stronger operator confirmation; global policy governs all sessions (weaker leverage for the per-persona ordered-write guarantee), so Phase 2 is where a copy-at-start snapshot likely earns its cost (§10). |
| 22 | Spinner/Parallel fallbacks + 24 `console.error` corrupt daemon stderr | medium | **fixed** | `quiet` flag + injected logger; under `quiet` an absent `reporterFactory` throws (no ora fallback) (§4.4). |
| 23 | Cooperative abort is a no-op for the parallel branch | medium | **mitigated** | Per-phase signal checks + `abortSignal` through `generateText` (cancels in-flight HTTP); wall-clock cap is the hard bound; no instant abort claimed (§4.4, §6). |
| 24 | `createPipelineModels` builds two models, each re-reads env | medium | **fixed** | Preflight checks both providers; snapshot keys once; document the daemon-must-not-mutate-env invariant (annotate-fork rationale) (§4.3, §10). |
| 25 | Best-effort cancel poisons the per-server content-hash cache | medium | **fixed** | Artifacts written only at the very end after validation; an aborted compile writes nothing, so the cache is never poisoned by a partial run (§4.3, §6). |
| 26 | `active→recent` not a synchronous critical section | medium | **fixed** | Single synchronous critical section; re-check before `COMPILE_IN_PROGRESS` (§6). |
| 27 | No per-LLM-call timeout; wall-clock cap can't abort an in-flight call | medium | **fixed** | `abortSignal` through `createThrottledModel`/`generateText`; writes happen only after the call returns, so an aborted call leaves prior artifacts intact (§4.4, §6). |
| 28 | Server allowlist semantics diverge from CLI; unvalidated names | medium | **fixed** | Validate `servers ⊆ mcpServers`; full-set/`[]` ⇒ omit key; route residual warnings through progress (§4.1). |
| 29 | Mock-server canned compile is sync-return; conversion underspecified | medium | **fixed** | Mock state model (active+recent Map, minter, getCompile/listCompiles, timed broadcast, terminal record before done) (§9). |
| 30 | No rollback for the streaming-compile conversion | medium | **fixed** | Keep `personas.compile` blocking (deprecated-but-supported); add `personas.compileStream`; un-upgraded frontend still works (§5, §10). |
| 31 | Several DTOs/fields undefined; result-type ambiguity; two phase vocabularies | medium | **fixed** | Every field pinned (§5); `PersonaCompileResultDto` = success-only; two phase vocabularies documented. |
| 32 | `applyServerAllowlist` writes to `process.stderr` (daemon leak) | medium | **fixed** | Up-front server-allowlist validation at create-time; residual compile warning routed through the reporter (§4.1). |
| 33 | Migration of existing personas (no memory block; stale needs `constitutionHash`) | medium | **fixed** | No disk migration; `memory?.enabled ?? true`; absent/`constitutionHash`-less ⇒ `stale:true` rendered "not compiled"; scanner skips malformed (§4.1, §11). |
| 34 | Empty/error/loading states unspecified | medium | **fixed** | Enumerated per method/event (§9). |
| 35 | Interactive customizer/generation can't be headless; CLI-only deferral hides duplication | medium | **mitigated** | Phase-1a service does not touch the customizer; pre-Phase-3 task to extract the pure decision core shared by `@clack` + WS (§10). |
| 36 | `setPersonaMemory` destructure-omit is `exactOptionalPropertyTypes`-sensitive | low | **fixed** | Lifted verbatim (`persona-command.ts:413-416`) + unit tests (§4.1, §11). |
| 37 | `getPersonaDetail`/`listPersonas` naming/shape inconsistency | low | **fixed** | Both carry `memory`; one canonical scanner delegated to by mux + dispatch (§4.1). |
| 38 | `createPersonaName` doesn't normalize case/whitespace; CLI vs WS differ | low | **fixed** | Zod `.trim()` transforms + service-level trims; identical normalization regardless of entry (§4.1, §5). |
| 39 | WS `create` loses CLI "undefined = all servers" defaulting | medium | **fixed** | Replicate omission convention; explicit "All servers" UI default; unit tests for `'all'`/`{}`/subset (§4.1, §9, §11). |
| 40 | Preflight env read vs SDK deferred read; untyped post-dispatch failures | low | **fixed** | Classify `LoadAPIKeyError` ⇒ structured `code` on `failed`; snapshot keys once (§4.3). |
| 41 | Reconnect-hydration relies on in-memory LRU that doesn't survive a restart | low | **fixed** | On reconnect, ops absent from `listCompiles` ⇒ marked `interrupted`; backend startup scan emits synthetic `failed` (§9). |

---

## 14. Open questions & risks

### Open questions (NEEDS-HUMAN-VALIDATION / decisions)
1. ~~**(spike, blocks Phase 1b)** Runtime `paths.within` containment: live coordinator `allowedDirectory` vs compiled-in baked value?~~ **RESOLVED** by spike A9 (§12): runtime sandbox/protected-path containment uses the **live** `PolicyEngine` constructor args; persona policies are workspace-portable; the compile-time `allowedDirectory` is not the runtime containment authority. No blocker remains.
2. **Multi-user / non-localhost hardening** (`web-ui-server.ts:168`): before any exposure beyond single-operator localhost, move the connection token out of the `?token=` query string (cookie / `Sec-WebSocket-Protocol`) — a **daemon-wide** fix that protects all methods — and only then revisit whether a second (admin) credential + per-actor authz is warranted. v1 deliberately ships neither; the default-off kill switch is the gate. Decide owner + phase.
3. ~~**Audit-chain secret durability**: per-daemon-lifetime tamper-evidence (in-memory secret) vs cross-restart continuity (persisted secret = its own key-management problem).~~ **RESOLVED — keep the in-memory (per-daemon-lifetime) secret.** Persisting it would only put a forgeable-chain key on disk for marginal gain. Sharper operator framing: on the **trusted single-operator host** this design targets, the tamper-evident chain has limited *security* value to begin with — an adversary with host control can rewrite policy files or read process memory directly (far worse than editing the log, and they'd only be working against themselves). The chain is therefore best understood as lightweight integrity / accidental-corruption detection, not a defense against a capable local attacker; not worth hardening (or persisting) for v1.
4. ~~**`globalLimit` value** (default 2) and queue depth cap (~10): validate against operator usage + provider rate limits; decide if config-tunable.~~ **RESOLVED — keep the hardcoded defaults (concurrency 2, queue cap 10); not config-tunable for v1.** Sane for the single-operator target; a test-only override hook already exists, so promoting them to real config is trivial if `COMPILE_QUEUE_FULL` is ever hit in practice.
5. **Phase-3 WS customizer headless core**: the step-function signature and per-`operationId` `ModelMessage[]` history model need their own mini-design before Phase 3.

### Residual risks (accepted in v1)
- **No instant cancellation** — aborts at the next phase boundary + cancels in-flight LLM HTTP; `operationId` reserved for `personas.cancelCompile`.
- **Mutation gated only by a process-global kill switch** (no per-actor authz, no second credential) — correct for the single-operator localhost target; multi-user requires the connection-token hardening above + per-actor capabilities first.
- **A mid-run recompile changes a workflow's policy on its next state entry** (by design — concurrent recompile is allowed). The dependency-ordered, per-file-atomic write guarantees the reader never sees a compiled policy ahead of its lists (id mismatch ⇒ fail-safe deny); pinning a run to its start-time policy (snapshot) is a deferred Phase-2 nicety.
- **Tool annotations are CLI-only** — a permanent Web-UI non-goal, not a deferral. Compilation reads them; nothing in the UI writes them.
- **Audit does not defend against a full-local-user fs attacker** — who can write policy files directly (the threat the audit attributes).
- **Manual DTO / mock-server mirroring** — no codegen; mitigated by the Playwright gate.
- **`requiresMcp` lists unavailable on the WS path** — CLI retains them.
- **Phase-2 global compile writes the live active dir** — "persona-dir-only writes" is a Phase-1-only containment property; Phase 2 carries sharpened hard prerequisites.
