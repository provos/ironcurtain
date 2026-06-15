# Structured Deterministic Result Contract

Status: Design (ready to implement)
Audience: IronCurtain workflow-runtime engineers
Predecessor: `docs/designs/deterministic-in-container-execution.md` (PR #292, merged). This
document fills the explicit seam that doc left open in its §1 ("What did NOT ship → The
structured deterministic result contract") and §4.6 ("the result-contract piece plugs into the
**reduction** step (`reduceDeterministicCommands`), not the exec path").

Consumer context: `docs/designs/asi-evolve-native-workflow.md` needs this so an `evaluate` /
`record_node` deterministic state can distinguish `evaluated` from `evaluator_blocked` and route a
hard failure straight to a gate/terminal without an agent turn. **That workflow is out of scope
here** — this is general-purpose runtime work.

---

## 1. Summary & goals

### What ships

A **`container: true`** `deterministic` state can emit a **structured verdict + machine-readable
payload** by having its packaged helper write a **result file** (`result.json` with
`{ "verdict": "...", ... }`) into the run workspace. The machine then routes the deterministic state
on `when: { verdict: ... }` edges —
**the exact same `__matchesWhen` mechanism agent states already use**
(`src/workflow/machine-builder.ts:233-236`, `:433-461`). This lets a deterministic state e.g.
distinguish `evaluated` vs `evaluator_blocked` and route a hard failure straight to a terminal/gate
with no agent turn.

Concretely, the deltas are:

1. **YAML**: an optional `resultFile: <path>` field on deterministic states (relative to
   `/workspace`); `when: { verdict: ... }` transitions become legal on deterministic states.
   **Both `resultFile` and `when:{verdict}` edges require `container: true`** (see §5.2 / §7.3 for
   why and where this is enforced).
2. **Result-file contract**: `result.json` shape `{ verdict: string, payload?: object, passed?:
boolean }` with defined precedence vs exit code and defined missing/malformed behavior.
3. **Execution**: the helper writes the result file under `/workspace` in the container; the
   orchestrator reads the same bytes host-side under `instance.workspacePath` (the bind-mount
   source) after `reduceDeterministicCommands` runs, and attaches `verdict`/`payload` to
   `DeterministicInvokeResult`. This is **container-only** — see §5.2.
4. **Machine-builder**: deterministic `onDone` transitions gain a `when` branch that reuses the
   `__matchesWhen` guard; the deterministic-result→event mapping is extended so `__matchesWhen` can
   read a `verdict`.
5. **Validation**: the deterministic-`when` rejection (`src/workflow/validate.ts:336-338`) is
   relaxed; a new semantic check requires `container: true` on any deterministic state that uses
   `resultFile` or `when:{verdict}` edges (§7.3); a new lint (WF012) warns when `when:{verdict}`
   edges exist without a declared `resultFile`.

### What does NOT ship

- No change to **agent-state** routing, the `__matchesWhen` guard body, or `AgentOutput`.
- No change to **container execution, packaging, the per-workflow image build, or `docker exec`**
  (all shipped in PR #292). The result file is a plain workspace artifact the helper writes; the
  runtime never tells the helper how to compute its verdict.
- No new `WorkflowEvent` variant is **required** (see §6 for the chosen approach: extend the
  existing `VALIDATION_PASSED`/`VALIDATION_FAILED` events with an optional `verdict`/`payload`
  carrier and route `__matchesWhen` through them — `isPassed` keeps reading `VALIDATION_PASSED`).

### Back-compat invariant (the load-bearing one)

**Every existing guard-only deterministic state keeps working byte-identically.** Today
deterministic transitions support only `guard:` (`isPassed`, pass/fail via stdout-mined `passed`).
A deterministic state with **no `resultFile`** never reads a result file, produces a
`DeterministicInvokeResult` with `verdict` undefined, and routes exactly as it does today:
`passed → VALIDATION_PASSED → isPassed`, else `VALIDATION_FAILED`. The result file is strictly
opt-in; `resultFile` defaults to absent. No shipped workflow has a `type: deterministic` state
today (verified in PR #292 §3.3), so the regression surface is the `deterministic-eval-smoke`
fixture, which is guard-only and must stay green.

---

## 2. Current behavior (cited)

**Deterministic execution → result.** `executeDeterministicState(workflowId, input)`
(`src/workflow/orchestrator.ts:2343`) dispatches host (`runDeterministicHost`, `:2404`) vs container
(`runDeterministicInContainer`, `:2417`) by `input.container`, both funneling through the shared
reducer `reduceDeterministicCommands(commands, runCommand)` (`:2376`). The reducer skips empty
command arrays, mines a test count from stdout (`/(\d+)\s+(?:tests?|specs?)\s+pass/i`), accumulates
per-command failures, and returns:

```ts
// src/workflow/machine-builder.ts:69-74
export interface DeterministicInvokeResult {
  readonly passed: boolean; // allErrors.length === 0
  readonly testCount?: number;
  readonly errors?: string;
}
```

`passed` is purely "no command errored" (exit code 0 for every command). There is no notion of a
verdict; the only routing signal a deterministic state can produce today is this boolean.

**Result → event mapping.** In the XState guard adapter
(`src/workflow/machine-builder.ts:413-419`), when the done event is _not_ an agent result it is
treated as a deterministic result and mapped:

```ts
const detResult = doneEvent.output as DeterministicInvokeResult | undefined;
if (detResult?.passed) {
  workflowEvent = { type: 'VALIDATION_PASSED', testCount: detResult.testCount ?? 0 };
} else {
  workflowEvent = { type: 'VALIDATION_FAILED', errors: detResult?.errors ?? 'unknown' };
}
```

**The `isPassed` guard** (`src/workflow/guards.ts:34-36`) is just
`event.type === 'VALIDATION_PASSED'`. That is the _only_ guard a deterministic transition can use
for routing today.

**`when` is rejected on deterministic states.** `buildDeterministicState`
(`src/workflow/machine-builder.ts:271-301`) builds `onDone` transitions using **only** `t.guard`
and silently drops `t.when` (`:276-280`). Validation makes that explicit:

```ts
// src/workflow/validate.ts:336-338  (validateWhenClauses)
if (state.type === 'deterministic' && t.when) {
  issues.push(`State "${stateId}" is deterministic and cannot use "when" (agent output not available)`);
}
```

The rationale in the comment — "agent output not available" — is exactly the gap this contract
closes: a deterministic state _can_ now produce structured output, via a result file.

**The `__matchesWhen` guard** (`src/workflow/machine-builder.ts:433-461`) is the agent-state
mechanism: built per-transition as `{ type: '__matchesWhen', params: { when: t.when } }`
(`:237-238`). It calls `extractInvokeResult(doneEvent)` (`:97-103`) to pull an `AgentInvokeResult`
(detected by the presence of `output` + `outputHash`), reads `result.output` (an `AgentOutput`),
and matches each `when` key against `agentOutput[key]` with `!==` AND-semantics. `extractInvokeResult`
returns `undefined` for a deterministic result (no `outputHash`), so today `__matchesWhen` would
**fail closed** (`return false`, `:444`) on a deterministic state — which is why deterministic
`when` was disallowed rather than silently no-op.

**`collectTransitionTargets`** is exported from `src/workflow/validate.ts:199` and reused by lint
(`src/workflow/lint.ts` WF011 at `:473`). The lint family lives in `src/workflow/lint.ts`; the
`DiagnosticCode` union (`lint.ts:55`) is the **non-contiguous** set
`WF001|WF002|WF003|WF004|WF006|WF007|WF008|WF010|WF011` (no WF005, no WF009). `WF012` is unused, so
adding it does not collide.

**Workspace ↔ container.** A `container: true` deterministic state runs with `--workdir /workspace`
(`CONTAINER_WORKSPACE_DIR = '/workspace'`, `src/docker/agent-adapter.ts:19`). `/workspace` is the
RW bind mount of the host run workspace `instance.workspacePath`: the field is declared at
`src/workflow/orchestrator.ts:601`, passed to the infrastructure factory at `:838` →
`createDockerInfrastructure(..., input.workspacePath, ...)` at `:1138` →
`prepareDockerInfrastructure(workspaceDir, ...)` (`src/docker/docker-infrastructure.ts:345`) → the
RW mount `{ source: core.workspaceDir, target: CONTAINER_WORKSPACE_DIR, readonly: false }`
(`docker-infrastructure.ts:967`). So a file the helper writes at `/workspace/<path>` inside the
container is readable host-side at `resolve(instance.workspacePath, <path>)`.

A host-side (`container: false`) deterministic state, by contrast, runs the helper via
`execFileAsync(binary, args)` with **no `cwd`** (`src/workflow/orchestrator.ts:2408`), so the
helper writes relative to the orchestrator's `process.cwd()`, **not** the workspace. There is no
mount aligning the two paths, so a host helper's result file and `applyResultFile`'s
`resolve(instance.workspacePath, resultFile)` read would point at different files. **This is the
reason the result contract is container-only** (enforced in §7.3; host-side verdict routing is
deferred — §13). `WORKFLOW_ARTIFACT_DIR = '.workflow'` (`src/workflow/types.ts:12`) is the existing
convention for runtime-written workspace artifacts.

---

## 3. YAML surface

### 3.1 New field

Add to **deterministic** states:

| Field        | Type     | Default | Meaning                                                                                                                                                                                                                                                                                                 |
| ------------ | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resultFile` | `string` | absent  | Path **relative to the workspace root** where the helper writes its result JSON. **Requires `container: true`** (§7.3). When set, the orchestrator reads it after the commands run and exposes its `verdict`/`payload` for `when:{verdict}` routing. Absent ⇒ legacy guard-only behavior, no file read. |

**Path rules** (enforced in §7): `resultFile` must be a relative, normalized POSIX path with no
leading `/`, no `..` segment, and no NUL — it is resolved under `/workspace` inside the container
(where the helper writes) and read host-side under the identical bind-mount source
`instance.workspacePath`. It is **not** a `containerScope` and has no charset coupling to it.
Recommended convention: put it under the existing `.workflow` artifact dir, e.g.
`resultFile: .workflow/result.json`, so it lands next to other runtime artifacts and is swept by the
same checkpoint/inspect tooling. The runtime does **not** mandate `.workflow/`; any in-workspace
relative path is accepted.

### 3.2 Authoring `when:{verdict}` transitions

A deterministic state authors verdict edges exactly like an agent state does:

```yaml
transitions:
  - to: <state>
    when: { verdict: <string> }
```

- **`guard:`-only states stay valid** — unchanged. No `resultFile`, no `when`: pure legacy.
- **Coexistence rule.** A single deterministic state's transition list **may mix** `when:{verdict}`
  edges and `guard:` edges. A single _transition_ may **not** carry both `guard` and `when` (already
  enforced — mutual exclusivity at `validate.ts:329-332`). This is identical to agent states.
- **Ordering rule (XState first-match).** XState evaluates `onDone` transitions **top-to-bottom and
  takes the first whose guard passes**. Authors therefore order specific `when:{verdict}` edges
  _before_ any catch-all. The recommended pattern is verdict edges first, then a final **unguarded**
  edge (or a `guard: isPassed` edge) as the default:

  ```yaml
  transitions:
    - to: blocked_terminal
      when: { verdict: evaluator_blocked } # specific, checked first
    - to: record_node
      when: { verdict: evaluated }
    - to: failed # default fall-through (unguarded)
  ```

  `__matchesWhen` returns `false` (not throw) when the verdict doesn't match
  (`machine-builder.ts:458`), so a non-matching verdict edge is skipped and evaluation continues to
  the next transition — same semantics as agent states.

### 3.3 Before / after YAML

**Before** (guard-only, today's only option — unchanged, still valid):

```yaml
evaluate:
  type: deterministic
  container: true
  run:
    - ['/opt/workflow-venv/bin/python', '/workflow-scripts/run_eval.py']
  transitions:
    - to: report
      guard: isPassed
    - to: failed
```

**After** (verdict-routed):

```yaml
evaluate:
  type: deterministic
  container: true
  resultFile: .workflow/result.json # helper writes {"verdict": "...", ...} here
  run:
    - ['/opt/workflow-venv/bin/python', '/workflow-scripts/run_eval.py']
  transitions:
    - to: blocked # hard failure: skip the agent loop entirely
      when: { verdict: evaluator_blocked }
    - to: record_node # normal path
      when: { verdict: evaluated }
    - to: failed # default: malformed/missing verdict, or unexpected value
```

---

## 4. Result-file contract

### 4.1 Schema

The helper writes **valid JSON** matching:

```jsonc
{
  "verdict": "evaluated", // REQUIRED when the file is present: non-empty string
  "payload": { "score": 0.91 }, // OPTIONAL: arbitrary JSON object (not array/scalar)
  "passed": true, // OPTIONAL: boolean; see precedence in §4.3
}
```

| Field     | Required           | Type             | Meaning                                                                                              |
| --------- | ------------------ | ---------------- | ---------------------------------------------------------------------------------------------------- |
| `verdict` | yes (when present) | non-empty string | Routing key for `when:{verdict}`. Free-form, like `AgentOutput.verdict`.                             |
| `payload` | no                 | JSON object      | Opaque machine-readable data for downstream consumers. Surfaced on the result; not used for routing. |
| `passed`  | no                 | boolean          | Lets the helper assert pass/fail independent of process exit code. See §4.3.                         |

`payload` is intentionally a free-form object. The runtime stores it on the result and (per §6)
makes it available to context, but does **not** schema-validate its interior — that is the
consuming workflow's concern (e.g. asi-evolve's `record_node` reads it).

### 4.2 Verdict-file required when `when:{verdict}` edges exist?

**No — soft requirement, lint-only.** A deterministic state that has `when:{verdict}` edges but no
`resultFile` cannot ever produce a verdict, so those edges are dead. This is an **author error**,
surfaced as a lint warning **WF012** (§7), not a hard validation failure (lint is advisory; some
authors gate verdict edges behind a default that always fires). At runtime, a `when:{verdict}` edge
with no result file simply never matches (verdict is `undefined`) and the default edge is taken.

### 4.3 Precedence: exit code vs verdict file

The verdict file governs **routing**; the exit code still governs **`passed`** unless the file
overrides it. Precedence, evaluated after `reduceDeterministicCommands` returns its
`{ passed, testCount, errors }`:

1. **`passed` field present in result file** → it **overrides** the exit-code-derived `passed`.
   (A helper can `exit(0)` but declare `passed: false`, or vice-versa. This is the escape hatch for
   "the evaluator ran fine but the candidate failed" — exit 0, `verdict: evaluated`, `passed:
false`.)
2. **`passed` field absent** → keep the exit-code-derived `passed` from the reducer (today's
   semantics).
3. **`verdict`** is always taken verbatim from the file (independent of `passed`). Routing checks
   `when:{verdict}` first; the `passed`-derived `VALIDATION_PASSED`/`isPassed` fallback only matters
   for guard edges.

**Why exit code stays authoritative for `passed` by default:** it preserves the back-compat
invariant — a legacy helper that doesn't write `passed` behaves exactly as today. The file is the
_additive_ signal.

### 4.4 Missing / malformed file behavior

Define a **reserved verdict** so authors can route the "the contract itself broke" case
explicitly. The reserved verdict is the constant `DETERMINISTIC_RESULT_ERROR_VERDICT =
'result_file_error'` (new export in `src/workflow/types.ts`, see §11).

| Condition                                                           | `verdict`             | `passed`                      | `errors` (appended)                        |
| ------------------------------------------------------------------- | --------------------- | ----------------------------- | ------------------------------------------ |
| `resultFile` absent (legacy)                                        | `undefined`           | exit-code-derived (unchanged) | unchanged                                  |
| `resultFile` set, commands all passed, file present & well-formed   | from file             | file `passed` ?? exit-derived | unchanged                                  |
| `resultFile` set, file **missing** after commands ran               | `'result_file_error'` | `false`                       | `+ "result file <path> not found"`         |
| `resultFile` set, file present but **not valid JSON**               | `'result_file_error'` | `false`                       | `+ "result file <path> is not valid JSON"` |
| `resultFile` set, JSON valid but **no/empty/non-string `verdict`**  | `'result_file_error'` | `false`                       | `+ "result file <path> missing verdict"`   |
| `resultFile` set, but a **command already errored** (non-zero exit) | not read              | `false`                       | unchanged (command error)                  |

Rules:

- **File read is conditional on commands having passed.** If `reduceDeterministicCommands` already
  set `passed: false` (a command exited non-zero), the orchestrator does **not** read the result
  file — the command failure is authoritative and `verdict` stays `undefined`. (A helper that wants
  to _report_ a verdict on failure should `exit(0)` and set `passed: false` in the file, per §4.3.)
- A malformed/missing file when one was promised is a **failure** (`passed: false`) _and_ yields the
  reserved verdict, so the author can write `when: { verdict: result_file_error }` to route it, or
  just let it fall through to the default edge.
- The reserved verdict string is documented and exported; authors **must not** emit it from their
  own helpers (the lint WF012 does not police this, but `WORKFLOWS.md` documents the reservation).

---

## 5. Execution / reducer changes

### 5.1 Extend `DeterministicInvokeResult` and `DeterministicInvokeInput`

`src/workflow/machine-builder.ts:60-74`:

```ts
export interface DeterministicInvokeInput {
  readonly stateId: string;
  readonly commands: readonly (readonly string[])[];
  readonly context: WorkflowContext;
  readonly container?: boolean;
  readonly containerScope?: string;
  readonly timeoutMs?: number;
  readonly resultFile?: string; // NEW: workspace-relative path
}

export interface DeterministicInvokeResult {
  readonly passed: boolean;
  readonly testCount?: number;
  readonly errors?: string;
  readonly verdict?: string; // NEW: from result file (or reserved error verdict)
  readonly payload?: Record<string, unknown>; // NEW: opaque machine-readable data
}
```

Both new input fields are populated in the **two** construction sites that already populate
`container`/`containerScope`/`timeoutMs`:

- Machine-builder mapper (`src/workflow/machine-builder.ts:286-293`): add `resultFile:
config.resultFile`.
- Resume replay (`src/workflow/orchestrator.ts:1457`, the `replayInvokeForRestoredState` det
  branch): add `resultFile: stateDef.resultFile`.

`DeterministicStateDefinition` (`src/workflow/types.ts:251-275`) gains `readonly resultFile?:
string;`.

### 5.2 Where the orchestrator reads the file (container branch)

The reducer is **not** touched — per PR #292 §4.6, the result-contract piece plugs in _after_ the
reduction step, at the `executeDeterministicState` level (`orchestrator.ts:2343`), where the
orchestrator has `instance` (hence `workspacePath`) and the stateId. Add a new private method
`applyResultFile(instance, input, result)` called at the end of the **container** branch of
`executeDeterministicState`. The result contract is **container-only** (§7.3 rejects `resultFile`
without `container: true`), so the host branch is left byte-identical to today — it does **not**
call `applyResultFile`:

```ts
private async executeDeterministicState(
  workflowId: WorkflowId,
  input: DeterministicInvokeInput,
): Promise<DeterministicInvokeResult> {
  // --- HOST branch (unchanged; resultFile rejected for container:false in §7.3) ---
  if (!input.container) {
    return this.runDeterministicHost(input.commands);
  }

  // --- CONTAINER branch (existing dispatch, unchanged through bundle resolution) ---
  const instance = this.workflows.get(workflowId);
  if (!instance) return { passed: false, errors: `workflow ${workflowId} not found` };
  if (!this.shouldUseSharedContainer(instance.definition)) {
    return { passed: false, errors: `State "${input.stateId}" requires shared-container Docker execution.` };
  }
  const scope = input.containerScope ?? DEFAULT_CONTAINER_SCOPE;
  const bundleWasLive = instance.bundlesByScope.has(scope);
  const bundle = await this.ensureBundleForScope(instance, scope);
  const warning = bundleWasLive ? undefined : /* ...existing soft warning... */;
  const base = await this.runDeterministicInContainer(bundle, input, warning);
  return this.applyResultFile(instance, input, base);   // container-only read site
}
```

> The container branch keeps its existing `instance` fetch and the `{ passed: false, errors:
'workflow ... not found' }` / `shouldUseSharedContainer` guards unchanged. Because the read is
> reached only on the container path, `instance` is always defined when `applyResultFile` runs.
>
> The XState `deterministicService` actor that calls `executeDeterministicState`
> (`orchestrator.ts:1685-1687`) forwards `input` and returns `output` **opaquely**, so it needs
> **no edit**; the only changed sites are `executeDeterministicState` itself (`:2343`) and the
> resume replay (`:1457`, which gains `resultFile: stateDef.resultFile` per §5.1).

**`applyResultFile`** — the container-side reader:

```ts
private async applyResultFile(
  instance: WorkflowInstance | undefined,
  input: DeterministicInvokeInput,
  base: DeterministicInvokeResult,
): Promise<DeterministicInvokeResult> {
  if (input.resultFile === undefined) return base;              // legacy: no file
  if (!base.passed) return base;                                // command already failed (§4.4)

  // The helper wrote the file at /workspace/<resultFile> inside the container;
  // instance.workspacePath is the host source of that bind mount, so we read
  // the same bytes back here. (Reached only on the container path — §7.3.)
  const workspace = instance?.workspacePath;
  const resolved = workspace
    ? resolve(workspace, input.resultFile)                      // input.resultFile is validated relative (§7)
    : undefined;

  const fail = (msg: string): DeterministicInvokeResult => ({
    ...base,
    passed: false,
    verdict: DETERMINISTIC_RESULT_ERROR_VERDICT,
    errors: base.errors ? `${base.errors}\n${msg}` : msg,
  });

  // Defense-in-depth: §7.3 validation already guarantees a safe relative path,
  // but re-check before touching the file (the path string is author-controlled).
  if (!isSafeWorkspaceRelativePath(input.resultFile)) {
    return fail(`result file ${input.resultFile} is not a safe workspace-relative path`);
  }

  if (!resolved || !existsSync(resolved)) return fail(`result file ${input.resultFile} not found`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf-8'));
  } catch {
    return fail(`result file ${input.resultFile} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail(`result file ${input.resultFile} is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.verdict !== 'string' || obj.verdict.length === 0) {
    return fail(`result file ${input.resultFile} missing verdict`);
  }

  const payload =
    typeof obj.payload === 'object' && obj.payload !== null && !Array.isArray(obj.payload)
      ? (obj.payload as Record<string, unknown>)
      : undefined;
  const passed = typeof obj.passed === 'boolean' ? obj.passed : base.passed;  // §4.3 precedence

  return { ...base, passed, verdict: obj.verdict, payload };
}
```

`resolve`, `existsSync`, `readFileSync` are already imported in `orchestrator.ts`;
`isSafeWorkspaceRelativePath` is exported from `validate.ts` (see §7.3) and imported here.

**The read resolves under `instance.workspacePath`, which is the host source of the `/workspace`
bind mount** (mount chain in §2): the orchestrator reads back the exact bytes the container helper
wrote. This holds **only for the container path** — a `container: false` helper writes relative to
`process.cwd()`, not the workspace (`orchestrator.ts:2408`, see §2), which is precisely why §7.3
forbids `resultFile` on host states; host-side verdict routing is deferred (§13). The validation in
§7 guarantees `input.resultFile` cannot escape the workspace (no `..`, no leading `/`), so the
`resolve(workspace, …)` containment is safe; as defense-in-depth, `applyResultFile` re-checks that
the resolved path is still under `workspace` and treats an escape as `result_file_error` (mirrors
the §7 static check at runtime).

### 5.3 Why not in the reducer

`reduceDeterministicCommands` is deliberately I/O-free over the workspace and shared by host and
container exactly so the two paths can't drift (PR #292 §4.4). Reading a workspace artifact is a
post-reduction concern that needs `instance` (which the reducer doesn't have). Keeping the read in
`applyResultFile` preserves the reducer's single-fork invariant and makes the back-compat path
(no `resultFile`) a literal early-return.

---

## 6. Machine-builder changes

Two changes, both in `src/workflow/machine-builder.ts`.

### 6.1 Build `when:{verdict}` transitions for deterministic states

`buildDeterministicState` (`:271-301`) currently maps transitions with **only** `t.guard`. Mirror
the agent path (`buildAgentOnDoneTransitions`, `:234-249`): prefer `when` (via `__matchesWhen`),
else `guard`:

```ts
function buildDeterministicState(stateId, config, definition): object {
  const onDoneTransitions = config.transitions.map((t) => {
    let guard: string | { type: string; params: { when: Readonly<Record<string, WhenValue>> } } | undefined;
    if (t.when) {
      guard = { type: '__matchesWhen', params: { when: t.when } };
    } else if (t.guard) {
      guard = t.guard;
    }
    return {
      target: t.to,
      ...(guard ? { guard } : {}),
      actions: collectTransitionActions(t, 'updateContextFromDeterministicResult'),
    };
  });
  // ... invoke wiring unchanged (add resultFile to the input mapper, §5.1) ...
}
```

The `__matchesWhen` guard is **already registered globally** (`:433`); deterministic states pick it
up for free. The only thing that doesn't work yet is that `__matchesWhen` reads an `AgentOutput` via
`extractInvokeResult`, which returns `undefined` for a deterministic result — §6.2 fixes that.

### 6.2 Make a deterministic result matchable by `__matchesWhen`

`__matchesWhen` (`:433-461`) needs an object with a `verdict` field to match against. The cleanest
seam that **keeps `isPassed` working** and adds **no new `WorkflowEvent` variant**: teach
`__matchesWhen` to also accept a deterministic result and synthesize a minimal `AgentOutput`-shaped
match object from it.

Add, right after the agent-result extraction in `__matchesWhen` (`:437-442`):

```ts
xstateGuards['__matchesWhen'] = ({ event }, params) => {
  const doneEvent = event as { type: string; output?: unknown };
  let matchSource: Pick<AgentOutput, 'verdict'> | AgentOutput | undefined;

  if (doneEvent.type.startsWith('xstate.done.actor.')) {
    const agentResult = extractInvokeResult(doneEvent);
    if (agentResult) {
      matchSource = agentResult.output; // agent path (unchanged)
    } else {
      // Deterministic path: synthesize a match object carrying the verdict.
      const det = doneEvent.output as DeterministicInvokeResult | undefined;
      if (det && typeof det.verdict === 'string') {
        matchSource = { verdict: det.verdict };
      }
    }
  }
  if (!matchSource) return false;
  // ... existing param/when guards (:446-453) unchanged ...
  for (const [key, expected] of Object.entries(when)) {
    const actual = (matchSource as Record<string, unknown>)[key];
    if (actual !== expected) return false;
  }
  return true;
};
```

Because validation already restricts deterministic `when` keys to `verdict` only (the existing
`nonVerdictKeys` check at `validate.ts:352-359` applies to both state types), the synthesized object
needs only `verdict`. If a future change allows more keys, the synthesized object is extended in
lockstep.

**The `VALIDATION_PASSED`/`VALIDATION_FAILED` mapping (`:413-419`) is left unchanged.** It still
drives `isPassed` and the `updateContextFromDeterministicResult` action. So:

- `when:{verdict}` edges route via `__matchesWhen` reading `result.verdict` directly off the done
  event's `output` (a `DeterministicInvokeResult`) — **bypassing** the `VALIDATION_*` mapping
  entirely, exactly as the agent path bypasses it.
- `guard: isPassed` edges route via the `VALIDATION_PASSED` mapping (driven by `result.passed`,
  which now respects the file's `passed` override per §4.3) — **byte-identical to today** for
  legacy states.

This is the minimal-surface choice: no new event type, no change to `isPassed`, no change to the
guard-adapter loop. (Alternative considered and rejected: adding a
`{ type: 'VERDICT'; verdict; payload }` event variant and a guard adapter for it — more surface, and
`__matchesWhen` already operates directly on the done-event output, not on a `WorkflowEvent`.)

### 6.3 Surface `payload` into context (optional, recommended)

`updateContextFromDeterministicResult` (`:512-532`) currently copies `testCount` and, on failure,
`errors` into `previousAgentOutput`. Extend it to also stash `result.payload` and `result.verdict`
so a downstream **agent** state can read the deterministic verdict/payload. Add a
`readonly lastDeterministicResult?: { readonly verdict?: string; readonly payload?: Record<string,
unknown> }` field to `WorkflowContext` (`src/workflow/types.ts:423-470`, near `previousTestCount`;
`WorkflowContext` is fully `readonly`, so the field matches that style) and set it in the action.
This is **not required for routing** (routing reads the done event directly) but is the natural way
asi-evolve's `record_node` agent consumes the payload. Gate this behind "do we have a consumer" —
ship the field; the prompt-builder wiring that _renders_ it is asi-evolve's concern, out of scope
here.

---

## 7. Validation changes (`src/workflow/validate.ts`)

### 7.1 Schema

`deterministicStateSchema` (`:78-86`) gains the field, reusing a new workspace-relative-path check:

```ts
const deterministicStateSchema = z.object({
  // ... existing ...
  resultFile: z.string().min(1).optional(),
  transitions: z.array(agentTransitionSchema).min(1),
});
```

The `agentTransitionSchema` (already used for deterministic transitions, `:85`) already permits
`when`, so no transition-schema change is needed — only the semantic guard below is relaxed.

### 7.2 Relax the deterministic-`when` rejection

Remove the hard rejection at `validate.ts:336-338`:

```ts
// DELETE:
if (state.type === 'deterministic' && t.when) {
  issues.push(`State "${stateId}" is deterministic and cannot use "when" (agent output not available)`);
}
```

Everything else in `validateWhenClauses` (`:324-387`) already handles both state types uniformly and
**continues to apply to deterministic states**:

- mutual exclusivity of `guard`+`when` per transition (`:329-332`),
- empty-`when` rejection (`:343-347`),
- **`verdict`-only key restriction** (`:352-359`) — deterministic `when` is thus limited to
  `{ verdict: ... }`, which is exactly what §6.2 supports,
- value-type check: `verdict` must be a string (`WHEN_KEY_TYPES.verdict`, `:270`), enforced at
  `:372-378`. `verdict` accepts any string (no enum), so custom verdicts route.

No new positive validation of the verdict-transition _set_ is required beyond these; the existing
machinery is sufficient.

### 7.3 New `resultFile` rules: container-only + path safety

**(a) Container-only rule (the load-bearing one).** The result contract only works when the helper
runs in the container, because that is the only path where the helper's write target (`/workspace`)
and the orchestrator's read target (`instance.workspacePath`) are the same bytes (§2, §5.2). A
host-side (`container: false`) helper writes relative to `process.cwd()` (`orchestrator.ts:2408`),
so its result file would never be where `applyResultFile` reads — every such state would return
`result_file_error`. Reject this at validation time rather than letting it fail at runtime.

`validateContainerScopes` (`validate.ts:472-505`) is the natural home: it already iterates every
deterministic state and gates `container: true` against `sharedContainer`/`mode`. Add a sibling
check in that same deterministic branch (after the existing `container === true` checks):

```ts
// A deterministic state that uses resultFile, or routes on when:{verdict},
// requires container:true — the result-file path only aligns host<->container
// inside the workspace bind mount (host-side cwd is process.cwd(), not /workspace).
const usesVerdictEdges = state.transitions.some((t) => t.when && 'verdict' in t.when);
if ((state.resultFile !== undefined || usesVerdictEdges) && state.container !== true) {
  issues.push(
    `State "${stateId}" uses resultFile / when:{verdict} routing but is not container: true. ` +
      `The deterministic result contract is container-only (the host helper's cwd is not the workspace).`,
  );
}
```

(This sits next to the existing `containerScope`/`container` checks in `validateContainerScopes` so
all of a deterministic state's container preconditions are validated in one place.)

**(b) Path safety.** Add a semantic check (in `validateSemantics`, alongside the existing per-state
loop at `validate.ts:404`, or folded into the same `validateContainerScopes` pass): for each
deterministic state with `resultFile` set, reject if the path is not a safe workspace-relative path:

```ts
// reject: absolute, parent-escape, or NUL
if (state.type === 'deterministic' && state.resultFile !== undefined) {
  const rf = state.resultFile;
  if (rf.startsWith('/') || rf.split('/').includes('..') || rf.includes('\0')) {
    issues.push(
      `State "${stateId}" has resultFile "${rf}" — must be a workspace-relative path (no leading "/", no "..").`,
    );
  }
}
```

Factor the path check into a small `isSafeWorkspaceRelativePath(p): boolean` helper so the runtime
defense-in-depth check in §5.2 shares it.

**(c) Reject `resultFile` on non-deterministic state types (author feedback).** `resultFile` lives
only in `deterministicStateSchema`, so Zod's `.strip()` would **silently drop** a `resultFile`
mistakenly placed on an agent/terminal/human_gate state — the author gets no diagnostic. Mirror the
existing `containerScope` raw-input gate (`validate.ts:159-176`, which rejects `containerScope` on
non-agent/non-deterministic types) by extending it to also reject `resultFile` on any non-deterministic
state: `State "<id>" (type: <t>) has "resultFile" but that field is only valid on deterministic states.`
Cheap; prevents a silent no-op. (Optional — not a correctness blocker, since a stripped `resultFile`
just yields legacy guard-only behavior.)

### 7.4 Lint WF012 — verdict edges without a result file

New lint in `src/workflow/lint.ts` (mirrors WF011's shape; reuses `collectTransitionTargets` /
iterates states):

- **Code:** add `'WF012'` to `DiagnosticCode` (`lint.ts:55`).
- **Check `checkVerdictEdgesHaveResultFile(def)`:** for each `deterministic` state, if any transition
  has `t.when` with a `verdict` key **and** the state has no `resultFile`, emit a `warning`:

  > Deterministic state `<id>` routes on `when:{verdict}` but declares no `resultFile`; the verdict
  > will always be undefined and these edges are dead. Add `resultFile: <path>` and have the helper
  > write `{ "verdict": ... }` there.

- Wire into `lintWorkflow` (`lint.ts:95-107`) next to WF011.
- **Symmetric note (not a separate code):** a `resultFile` with no `when:{verdict}` edges is _not_
  an error (a helper may write a result for payload-only consumption by a later agent). Do not warn.

---

## 8. Back-compat

The invariant from §1 restated as a checklist the implementation must hold:

1. **No `resultFile`** ⇒ on the container branch `applyResultFile` early-returns the reducer result
   untouched, and the host branch never calls it at all ⇒ `verdict` undefined,
   `passed`/`testCount`/`errors` identical to today.
2. **No `when` on transitions** ⇒ `buildDeterministicState` maps only `guard`, identical XState
   config to today (the `else if (t.guard)` branch).
3. **`VALIDATION_PASSED`/`VALIDATION_FAILED` mapping unchanged** ⇒ `isPassed` byte-identical.
4. **stdout-mined `passed`/`testCount` unchanged** ⇒ the reducer is not touched.
5. **`deterministic-eval-smoke` fixture** (guard-only, no `resultFile`) keeps routing
   `evaluate → report → done` via `isPassed`. It is the regression oracle (no shipped real workflow
   has a deterministic state).

A `test/workflow/orchestrator-deterministic.test.ts` case asserts that with `resultFile` undefined,
`applyResultFile` returns the exact reducer object (reference-stable shape) and reads no file.

---

## 9. Resume & checkpoint

- **Result files are workspace artifacts**, written under `instance.workspacePath` (the persisted
  run workspace, bind-mounted to `/workspace`). They are **not** part of `WorkflowCheckpoint` — they
  live in the workspace dir, which already survives resume (the workspace is re-mounted from the
  persisted run dir, PR #292 §7). No new checkpoint field is needed for the file itself.
- **Deterministic states are replayed on resume** via `replayInvokeForRestoredState`
  (`orchestrator.ts:1448-1457`); the replay path constructs `DeterministicInvokeInput` and must
  include `resultFile: stateDef.resultFile` (§5.1) so a re-run reads the file the same way. The
  re-run **re-executes the commands**, which **re-write** the result file (helpers are expected
  idempotent, matching the existing replay assumption for the command array). The orchestrator reads
  the freshly-written file, so a stale file from a prior partial run is overwritten — no special
  handling.
- **`lastDeterministicResult` context field** (§6.3), if added, is part of `WorkflowContext` and is
  therefore checkpointed/restored with the rest of context automatically (no extra wiring); on
  replay it is overwritten by the re-run's `updateContextFromDeterministicResult`.
- **Edge case:** if a workflow is resumed _at_ a terminal/gate immediately after a verdict-routed
  deterministic state (the deterministic state already completed pre-checkpoint), there is no replay
  of the deterministic state and no file read — the routing decision was baked into the checkpointed
  XState position. Correct and requires nothing.

---

## 10. Acceptance — end-to-end gating test (REQUIRED)

This is the gap PR #292 left (its integration items #8–#10 were **manual, not committed CI**). Close
it with an **automated, gated, real-Docker integration test** that proves the machine routes a
deterministic state on a **helper-written verdict file**, not on stdout pass/fail.

### 10.1 Fixture: `deterministic-verdict-smoke`

Ship under `src/workflow/workflows/deterministic-verdict-smoke/`. Shape: **a minimal agent mints the
container and records the task; a deterministic in-container state's packaged helper reads the task
and writes a `verdict` into `result.json`; two `when:{verdict}` edges route to two distinct
terminals.** The helper picks its verdict from the task input so **both branches are exercisable**.

How the task reaches the helper: the agent writes the verbatim task string to a workspace file the
helper reads. (The orchestrator already persists the task at `<metaDir>/task/description.md`
host-side, but that is not mounted into the container; the simplest container-visible channel is the
agent writing it into `/workspace`.)

```yaml
# src/workflow/workflows/deterministic-verdict-smoke/workflow.yaml
name: deterministic-verdict-smoke
description: 'TESTING ONLY - deterministic state routes on a helper-written verdict file.'
initial: author

settings:
  mode: docker
  dockerAgent: claude-code
  sharedContainer: true
  model: anthropic:claude-haiku-4-5

states:
  author:
    type: agent
    description: Record the task verbatim so the deterministic helper can read it.
    persona: global
    prompt: |
      Write the EXACT task text you were given to the file /workspace/task.txt and nothing else.
      Create no other files. Finish with the required agent_status block.
    inputs: []
    outputs: []
    transitions:
      - to: classify

  classify:
    type: deterministic
    description: Read the task and emit a verdict file the machine routes on.
    container: true # default scope "primary" — reuses author's bundle
    resultFile: .workflow/result.json
    run:
      - ['python3', '/workflow-scripts/classify.py']
    transitions:
      - to: passed_terminal
        when: { verdict: pass }
      - to: blocked_terminal
        when: { verdict: block }
      - to: error_terminal # default: result_file_error or unexpected verdict
        when: { verdict: result_file_error }
      - to: error_terminal # belt-and-braces unguarded default

  passed_terminal:
    type: terminal
    description: Helper emitted verdict=pass.
  blocked_terminal:
    type: terminal
    description: Helper emitted verdict=block.
  error_terminal:
    type: terminal
    description: Verdict file missing/malformed or unexpected verdict.
```

```python
# src/workflow/workflows/deterministic-verdict-smoke/scripts/classify.py
# No third-party deps -> no requirements.txt -> shared agent image (no per-workflow build).
import json, pathlib

ws = pathlib.Path("/workspace")
out = ws / ".workflow"
out.mkdir(exist_ok=True)
task = (ws / "task.txt").read_text().strip().lower() if (ws / "task.txt").exists() else ""

# Verdict is chosen from the task input so both branches are reachable.
verdict = "block" if "block" in task else "pass"

(out / "result.json").write_text(
    json.dumps({"verdict": verdict, "payload": {"task": task}, "passed": True}) + "\n"
)
# Deliberately print a misleading "0 tests pass"-free line to prove routing is NOT
# stdout-derived: stdout says nothing about pass/block; only result.json decides.
print(f"classified: {verdict}")
```

No `requirements.txt`/`package.json` ⇒ no per-workflow image build (PR #292 §6.1 fast path); the
fixture exercises the verdict contract in isolation from the dep-bake machinery.

### 10.2 Completion gate (stated precisely)

The test runs the workflow twice against a **real Docker daemon**:

- `workflow start deterministic-verdict-smoke "pass"` ⇒ final state **`passed_terminal`**.
- `workflow start deterministic-verdict-smoke "block"` ⇒ final state **`blocked_terminal`**.

**Gate:** both runs land on their **verdict-specific terminal**, and neither lands on
`error_terminal`. Because `classify.py`'s **stdout carries no pass/fail signal** (`isPassed` would
see `VALIDATION_PASSED` for _both_ runs — the commands always exit 0), the only thing that can
distinguish `passed_terminal` from `blocked_terminal` is the **verdict read from `result.json`**.
Two distinct terminals from two task inputs therefore **prove the machine routed on the
helper-written verdict file, not on stdout pass/fail.** A guard-only implementation could not reach
both terminals.

### 10.3 Automated gated integration test

`test/workflow/deterministic-verdict-smoke.integration.test.ts`:

- Gate with `describe.skipIf(!process.env.INTEGRATION_TEST || !dockerReady)` using the existing
  `isDockerAvailable()` / `isDockerImageAvailable(IMAGE)` helpers
  (`test/helpers/docker-available.ts`) and the `dockerReady` composition from
  `test/skills-end-to-end.integration.test.ts:397`.
- Drive the orchestrator the way `skills-end-to-end.integration.test.ts` does (construct the
  orchestrator with real infra, `start()` the fixture, poll the run to terminal, assert the final
  state name from the checkpoint / lifecycle events).
- Two cases (`"pass"` → `passed_terminal`, `"block"` → `blocked_terminal`), plus a **negative
  case**: a third fixture variant (or a mutated helper that writes no file) lands on
  `error_terminal` with verdict `result_file_error` — proving the §4.4 reserved-verdict path is
  reachable and routable.
- This test **doubles as the asi-evolve `evaluate`/`record_node` smoke test**: same pattern (agent
  mints container → deterministic helper emits verdict → verdict routes to distinct successors), so
  asi-evolve can build its `evaluate` state against a proven contract.

### 10.4 Manual run (developer loop)

```
INTEGRATION_TEST=1 npm test -- test/workflow/deterministic-verdict-smoke.integration.test.ts
# or by hand:
tsx src/cli.ts workflow start deterministic-verdict-smoke "pass"   # → passed_terminal
tsx src/cli.ts workflow start deterministic-verdict-smoke "block"  # → blocked_terminal
tsx src/cli.ts workflow inspect <baseDir>                          # confirm final state
```

---

## 11. File-by-file change list

| File                                                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workflow/types.ts`                                         | Add `readonly resultFile?: string` to `DeterministicStateDefinition` (`:251`). Add `export const DETERMINISTIC_RESULT_ERROR_VERDICT = 'result_file_error'`. Add `readonly lastDeterministicResult?: { readonly verdict?: string; readonly payload?: Record<string, unknown> }` to `WorkflowContext` (`:423-470`, fully readonly) (§6.3).                                                                                               |
| `src/workflow/machine-builder.ts`                               | Extend `DeterministicInvokeInput` (`resultFile?`) and `DeterministicInvokeResult` (`verdict?`, `payload?`) (`:60-74`). Build `when:{verdict}` deterministic transitions via `__matchesWhen` in `buildDeterministicState` (`:271`). Teach `__matchesWhen` to read a deterministic `verdict` (`:433`). Populate `resultFile` in the input mapper (`:286`). Stash `verdict`/`payload` in `updateContextFromDeterministicResult` (`:512`). |
| `src/workflow/orchestrator.ts`                                  | In `executeDeterministicState` (`:2343`) add `applyResultFile(instance, input, base)` on the **container** branch only (host branch unchanged — contract is container-only). Thread `resultFile` into the replay-path `DeterministicInvokeInput` (`:1457`). The `deterministicService` actor (`:1685-1687`) forwards opaquely → **no edit**. Import `DETERMINISTIC_RESULT_ERROR_VERDICT` + `isSafeWorkspaceRelativePath`.              |
| `src/workflow/validate.ts`                                      | Add `resultFile` to `deterministicStateSchema` (`:78`). **Remove** the deterministic-`when` rejection (`:336-338`). In `validateContainerScopes` (`:472-505`) add the **container-only** check: a deterministic state with `resultFile` or `when:{verdict}` edges must be `container: true`. Add `resultFile` path-safety semantic check + export `isSafeWorkspaceRelativePath`.                                                       |
| `src/workflow/lint.ts`                                          | Add `'WF012'` to `DiagnosticCode` (`:55`); add `checkVerdictEdgesHaveResultFile` and wire into `lintWorkflow` (`:95-107`).                                                                                                                                                                                                                                                                                                             |
| `src/workflow/workflows/deterministic-verdict-smoke/`           | NEW acceptance fixture: `workflow.yaml` + `scripts/classify.py` (no deps).                                                                                                                                                                                                                                                                                                                                                             |
| `test/workflow/orchestrator-deterministic.test.ts`              | Add `applyResultFile` unit cases (§12): well-formed verdict, `passed` override, missing/malformed → reserved verdict, no-`resultFile` no-op, command-failed-skips-read.                                                                                                                                                                                                                                                                |
| `test/workflow/machine-builder.test.ts`                         | Add: deterministic `when:{verdict}` builds `__matchesWhen` guard; `__matchesWhen` matches a `DeterministicInvokeResult.verdict`; guard-only path unchanged; input mapper emits `resultFile`.                                                                                                                                                                                                                                           |
| `test/workflow/validate.test.ts`                                | Add: deterministic `when:{verdict}` now valid; `guard`+`when` on one transition still rejected; non-`verdict` key rejected; bad `resultFile` path rejected; no-regression snapshot over shipped fixtures + `deterministic-eval-smoke`.                                                                                                                                                                                                 |
| `test/workflow/lint.test.ts`                                    | Add WF012: verdict edges without `resultFile` warn; with `resultFile` clean; `deterministic-verdict-smoke` lints clean.                                                                                                                                                                                                                                                                                                                |
| `test/workflow/deterministic-verdict-smoke.integration.test.ts` | NEW gated real-Docker integration test (§10.3): `"pass"`→`passed_terminal`, `"block"`→`blocked_terminal`, malformed→`error_terminal`.                                                                                                                                                                                                                                                                                                  |
| `WORKFLOWS.md`                                                  | Document `resultFile`, the `result.json` contract (§4), `when:{verdict}` on deterministic states, the reserved `result_file_error` verdict, and WF012.                                                                                                                                                                                                                                                                                 |

---

## 12. Unit / integration test plan (beyond the gating fixture)

**Unit (vitest, no Docker):**

1. `applyResultFile` (orchestrator-deterministic): (a) no `resultFile` ⇒ returns base unchanged, no
   `fs` read (spy `readFileSync` not called); (b) well-formed `{verdict,payload,passed}` ⇒ fields
   merged, `passed` from file overrides base; (c) `passed` absent ⇒ keeps base `passed`; (d) file
   missing ⇒ `verdict='result_file_error'`, `passed=false`, error appended; (e) invalid JSON / array
   / non-object ⇒ reserved verdict; (f) empty/non-string `verdict` ⇒ reserved verdict; (g) base
   already failed (command non-zero) ⇒ file **not** read, `verdict` undefined; (h) `..`/absolute
   `resultFile` reaching runtime ⇒ reserved verdict (defense-in-depth).
2. `machine-builder`: deterministic transition with `when:{verdict:'x'}` produces guard
   `{type:'__matchesWhen', params:{when:{verdict:'x'}}}`; with `guard:'isPassed'` produces
   `guard:'isPassed'`; `__matchesWhen` returns true when done-event output is a
   `DeterministicInvokeResult` with matching `verdict`, false on mismatch/undefined; agent path
   unchanged.
3. `validate`: deterministic `when:{verdict}` accepted; `when:{completed:true}` on deterministic
   rejected (non-`verdict` key); `guard`+`when` same transition rejected; absolute/`..` `resultFile`
   rejected; valid `resultFile` accepted.
4. `lint`: WF012 fires/clears as specified; the existing codes
   (`WF001|WF002|WF003|WF004|WF006|WF007|WF008|WF010|WF011`) are unaffected (snapshot).
5. `isPassed` back-compat: a guard-only deterministic result still maps to
   `VALIDATION_PASSED`/`FAILED` and `isPassed` routes identically (existing tests stay green).

**Integration (real Docker, `INTEGRATION_TEST=1`):** the §10.3 `deterministic-verdict-smoke` test —
two-terminal verdict routing + reserved-verdict negative case. This is the only _required_ Docker
test; the rest are unit-level and run in normal CI.

---

## 13. Open questions / human decisions

1. **`passed`-in-file overriding exit code (§4.3).** Decided: the file's `passed` wins when present.
   The alternative — exit code is always authoritative and `passed` in the file is ignored — is
   simpler but blocks the "evaluator exited 0 but the candidate failed" pattern asi-evolve wants.
   _Maintainer call:_ keep the override, or restrict it (e.g. only allow `passed:false` to _demote_,
   never `passed:true` to _promote_ a non-zero exit). Recommended: keep the full override; the helper
   is trusted workflow-author code.
2. **Should a missing/malformed result file be a hard `onError` (storeError → error target) instead
   of a routable `result_file_error` verdict (§4.4)?** Decided: routable verdict + `passed:false`, so
   authors can branch on it. The alternative routes it through the existing `onError`
   (`findErrorTarget`) wiring, which is blunter (no verdict) but reuses an existing path. Recommended:
   routable verdict — it's strictly more expressive and the error is still in `errors`.
3. **Whether to ship the `lastDeterministicResult` context field / payload-into-context now (§6.3)**
   or defer it until asi-evolve actually consumes the payload. Decided: ship the context field (it's
   cheap and checkpoint-free) but **not** the prompt-builder rendering (asi-evolve's concern).
   _Maintainer call:_ if YAGNI is preferred, drop the field entirely and let asi-evolve add it — the
   routing contract (verdict) stands alone without it.
4. **Host-side (`container: false`) verdict routing is deferred — out of scope here.** This design
   scopes the result contract to `container: true` (§1, §5.2, §7.3) because the host helper's cwd is
   `process.cwd()`, not the workspace (`orchestrator.ts:2408`), so its result file never aligns with
   `applyResultFile`'s `resolve(instance.workspacePath, …)` read. Lifting this would mean giving the
   host helper a `cwd` set to `instance.workspacePath` (the reviewer's option b) — a change to
   `runDeterministicHost`'s `execFileAsync` call plus its own back-compat note (today's host states
   run with the orchestrator's cwd) and a dedicated host-side routing test. Tracked as future work;
   asi-evolve's `evaluate`/`record_node` states are container-only, so nothing depends on it now.
