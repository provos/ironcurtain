# Containerized Deterministic Execution + Workflow Script Packaging

Status: Implemented (branch `feat/deterministic-container-execution`, PR #292)
Audience: IronCurtain runtime engineers
Consumer context: `docs/designs/asi-evolve-native-workflow.md` depends on this capability, but the work here is general-purpose workflow-runtime work, not ASI-Evolve-specific.

> **Implementation status (reconciliation pass).** This document was a forward-looking
> design and has been edited in place to reflect what was actually built on branch
> `feat/deterministic-container-execution` (PR #292). "Will build" language is now
> past tense, decisions taken are recorded, and deviations from the original design
> are flagged inline. The most significant deviation: the `DeterministicRunner`
> module proposed in §4.6/§10 was **not** created — host and container execution are
> inlined in `orchestrator.ts` and share a `reduceDeterministicCommands` reducer
> instead. See §4.6, §10, and §12 for the full deviation list.

---

## 1. Summary & goals

### What shipped

1. **In-container deterministic execution.** A workflow `deterministic` state can run its `run:` command array _inside the workflow's shared Docker container_ via `docker exec` instead of host-side `execFileAsync`. Opt-in per state via a new boolean field `container: true`. The state binds to a `containerScope` (default `"primary"`), reuses the bundle the orchestrator already minted for that scope (`instance.bundlesByScope`), and returns the **same** `{ passed, testCount, errors }` result shape as before.

2. **Workflow script packaging.** A workflow package can ship a `scripts/` directory (Python and/or Node helpers, plus `requirements.txt` / `package.json`). Code is delivered into the container via a dedicated read-only bind mount at `/workflow-scripts`. Dependencies are installed **at image-build time** (where network exists) into a per-workflow image layer; the resulting venv / `node_modules` are baked into a per-workflow image so they are available at `--network=none` runtime. A no-dependency fast path (stdlib / base-image-only) reuses the shared agent image with zero rebuild.

### What did NOT ship (explicit seams)

- **The structured deterministic result contract.** Routing on `when: { verdict: ... }` from a helper-written result file is a _separate_ piece (see `docs/designs/asi-evolve-native-workflow.md`). Containerized execution keeps working with today's stdout-mined `{ passed, testCount, errors }`. §4 keeps the host/container fork to a single per-command runner closure (`reduceDeterministicCommands`) so the result-contract piece can later replace only the reduction step. **We did not design the result file here.** (Note: the design originally proposed a standalone `DeterministicRunner`/`HostRunner`/`ContainerRunner` module for this seam; that module was **not** built — see §4.6.)
- No change to agent-state behavior, policy hot-swap, or the control server.
- No change to host-side deterministic states: `container: false` (the default) is byte-for-byte the prior path.

### Non-goals / invariants

- `--network=none` (Linux) / internal-bridge (macOS) is preserved at runtime. No runtime network is introduced. All dependency fetching happens at build time.
- `ToolCallCoordinator` does **not** mediate `docker exec`. Deterministic in-container commands are trusted workflow-author code, not agent-generated tool calls (see §9).

---

## 2. Pre-change baseline (cited)

> This section describes the codebase **before** this work and is preserved as the
> design's starting point. Line numbers here are pre-implementation; for the
> _current_ shapes see §4, §5, §6, and the §10 change list.

**Host-side execution (before).** `IronCurtainWorkflowOrchestrator.executeDeterministicState` looped the command arrays through `execFileAsync` on the **host** and mined a test count from stdout:

`src/workflow/orchestrator.ts:2253-2279`

```ts
private async executeDeterministicState(input: DeterministicInvokeInput): Promise<DeterministicInvokeResult> {
  const { commands } = input;
  let totalTestCount = 0;
  const allErrors: string[] = [];
  for (const cmdArray of commands) {
    if (cmdArray.length === 0) continue;
    const [binary, ...args] = cmdArray;
    try {
      const { stdout } = await execFileAsync(binary, args);
      const testMatch = /(\d+)\s+(?:tests?|specs?)\s+pass/i.exec(stdout);
      if (testMatch) totalTestCount += parseInt(testMatch[1], 10);
    } catch (err) {
      const execErr = err as { code?: number; stderr?: string; stdout?: string };
      allErrors.push(execErr.stderr ?? execErr.stdout ?? String(err));
    }
  }
  return {
    passed: allErrors.length === 0,
    testCount: totalTestCount > 0 ? totalTestCount : undefined,
    errors: allErrors.length > 0 ? allErrors.join('\n') : undefined,
  };
}
```

**The invoke input is scope-blind.** `DeterministicInvokeInput` carries only `stateId`, `commands`, `context` — no `workflowId`, no scope:

`src/workflow/machine-builder.ts:60-64`

```ts
export interface DeterministicInvokeInput {
  readonly stateId: string;
  readonly commands: readonly (readonly string[])[];
  readonly context: WorkflowContext;
}
```

It is constructed in **two** places, both of which lack scope:

- The XState invoke `input` mapper for the deterministic state — `src/workflow/machine-builder.ts:283-287` (`{ stateId, commands: config.run, context }`).
- The resume replay path — `src/workflow/orchestrator.ts:1375` (`this.executeDeterministicState({ stateId, commands: stateDef.run, context })`).

The orchestrator-provided actor wraps `executeDeterministicState` at `src/workflow/orchestrator.ts:1596-1605`; the placeholder actor lives at `src/workflow/machine-builder.ts:466-468`.

**The container already exists per scope.** Under `sharedContainer: true`, the orchestrator holds one bundle per scope in `instance.bundlesByScope: Map<string, DockerInfrastructure>` (`src/workflow/orchestrator.ts:565`), lazily minted by `ensureBundleForScope` (`src/workflow/orchestrator.ts:733`). `DockerInfrastructure.containerId` is the running container (`src/docker/docker-infrastructure.ts:267`). Agent states resolve their bundle exactly this way: `scope := stateConfig.containerScope ?? DEFAULT_CONTAINER_SCOPE`, then `ensureBundleForScope(instance, scope)` (`src/workflow/orchestrator.ts:1811-1819`).

**The exec-into-container primitive exists and is reachable from the bundle.** `DockerManager.exec(nameOrId, command, timeoutMs?, execUser?) → { exitCode, stdout, stderr }` with a default 10-minute timeout (`src/docker/docker-manager.ts:242-285`). `execUser === undefined` resolves to `'codespace'`; this is the user agent sessions exec as. Non-zero exit returns `exitCode` rather than throwing; a timeout is logged and returns `exitCode` from the killed process. **`DockerInfrastructure` already exposes the manager as `readonly docker: DockerManager` (`src/docker/docker-infrastructure.ts:160`)**, so the orchestrator does NOT need a new DockerManager dependency — it calls `bundle.docker.exec(bundle.containerId, ...)`.

**Container/workspace facts.**

- Workspace is bind-mounted RW at `/workspace` (`CONTAINER_WORKSPACE_DIR = '/workspace'`, `src/docker/agent-adapter.ts:19`; mount `src/docker/docker-infrastructure.ts:950`).
- `--network none` on Linux, `--init`/tini PID 1 (`src/docker/docker-manager.ts:70-78,1086`).
- Base image `mcr.microsoft.com/devcontainers/universal:latest` (`docker/Dockerfile.base:1`) ships Python 3.12 + `uv` + `ruff` + pip + Node. `uv` is configured for offline runtime with `UV_NATIVE_TLS=1` and a pre-warmed `UV_PYTHON_INSTALL_DIR=/opt/uv-python` (`docker/Dockerfile.base`).

**Skill staging (the analogous prior art).** The workflow package's `skills/` tree is staged to `resolve(bundleDir, BUNDLE_SKILLS_SUBDIR)` and bind-mounted **read-only** into the Claude adapter's `/home/codespace/.claude/skills` (`src/docker/docker-infrastructure.ts:644-658`, mount RO at `:1066`). It is **re-staged each transition** by a cached stager (`createCachedStager`) because per-state `skills:` filtering (`resolveSkillsForSession`, `src/skills/discovery.ts:232`) changes the staged set between states.

**Image build hash.** `computeBuildHash` SHA256s the Dockerfiles + every `*.sh` in `docker/` + the CA cert (+ optional parent hash); the result is stored as the `ironcurtain.build-hash` label and compared by `isImageStale` (`src/docker/docker-infrastructure.ts:1294-1383`). It does **not** include any per-workflow input today.

**Schema today.** `deterministicStateSchema` accepts only `type`, `description`, `run`, `transitions` (`src/workflow/validate.ts:78-83`); `DeterministicStateDefinition` matches (`src/workflow/types.ts:251-260`). `containerScope` is in `AGENT_ONLY_STATE_FIELDS` (`src/workflow/validate.ts:130`), and `validateContainerScopes` (`src/workflow/validate.ts:457`) only checks agent states — it `continue`s on every non-agent state (`:461`). So a `containerScope` written on a deterministic state today is **silently stripped by Zod** (the discriminated-union deterministic variant has no such field), not rejected with a diagnostic. `CONTAINER_SCOPE_PATTERN` already exists at `src/workflow/validate.ts:52` and is applied to the agent `containerScope` at `:66`.

---

## 3. YAML surface

### 3.1 New fields

Add to **deterministic** states:

| Field            | Type                                  | Default     | Meaning                                                                                                                         |
| ---------------- | ------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `container`      | `boolean`                             | `false`     | Run `run:` commands via `docker exec` into the shared-container bundle for this state's scope, instead of host `execFileAsync`. |
| `containerScope` | `string` (charset `^[a-zA-Z0-9_-]+$`) | `"primary"` | Which bundle to exec into. Only meaningful when `container: true`.                                                              |

Add to the workflow **package layout** (not YAML — directory convention, §5): an optional `scripts/` sibling of `workflow.yaml`.

**Why a per-state `container: true` and not implicit-when-`sharedContainer`?** Implicit coupling would silently change vuln-discovery and design-and-code if either ever turns on `sharedContainer` with a host-side deterministic state. An explicit opt-in keeps backward-compat trivially provable and makes the YAML self-documenting. `containerScope` is reused (not a new concept) so a deterministic state can target the _same_ container an agent state populated (e.g., run tests in the scope where the coder wrote code).

### 3.2 Before / after YAML

> For a complete, runnable example — a minimal agent that mints the container, then
> deterministic in-container states that do the work — see the
> `deterministic-eval-smoke` acceptance fixture in §11.

**Before** (host-side, unchanged behavior):

```yaml
states:
  run_tests:
    type: deterministic
    description: Run the unit suite on the host
    run:
      - ['npm', 'test']
    transitions:
      - to: review
```

**After** (in-container, binds to the `coder` scope's bundle):

```yaml
settings:
  mode: docker
  dockerAgent: claude-code
  sharedContainer: true # REQUIRED for container: true
states:
  implement:
    type: agent
    persona: coder
    containerScope: coder
    # ... writes code into /workspace inside the `coder` bundle
  run_tests:
    type: deterministic
    description: Run the unit suite inside the coder container
    container: true
    containerScope: coder # exec into the same bundle the coder used
    run:
      - ['python', '/workflow-scripts/run_suite.py', '--json']
      - ['node', '/workflow-scripts/lint.js']
    transitions:
      - to: review
```

### 3.3 Validation rules (in `src/workflow/validate.ts`) — as built

1. **Schema** (`deterministicStateSchema`, `:79`): **built** with three fields (the design's two plus `timeoutMs`), reusing `CONTAINER_SCOPE_PATTERN` (`:52`):
   ```ts
   container: z.boolean().optional(),
   containerScope: z.string().regex(CONTAINER_SCOPE_PATTERN).optional(),
   timeoutMs: z.number().int().positive().optional(),
   ```
2. **`containerScope` requires `container: true` on deterministic states.** `containerScope` was dropped from `AGENT_ONLY_STATE_FIELDS` (now just `['maxVisits']`, `src/workflow/validate.ts:133`) so the deterministic case is reachable; `maxVisits` stays agent-only. The explicit check **built** in `validateContainerScopes` (`:476`) is: on a deterministic state, `containerScope` set but `container !== true` → error `State "<id>" declares containerScope but is not container: true`. **Plus a new raw-input guard** (not in the original design): `validateRawInput` (`src/workflow/validate.ts:170`) now rejects `containerScope` on any state whose type is neither `agent` nor `deterministic`, with `State "<id>" (type: <t>) has "containerScope" but that field is only valid on agent states and containerized deterministic states.` — this closes the silent-Zod-strip gap for _other_ state types too.
3. **`container: true` requires `sharedContainer: true`.** `validateContainerScopes` (`src/workflow/validate.ts:466`) was extended so it no longer skips deterministic states. A deterministic state with `container: true` on a workflow without `settings.sharedContainer === true` fails with
   `State "<id>" has container: true but the workflow does not have sharedContainer: true.` (`:486`). A defense-in-depth runtime backstop also exists (§4.3, `shouldUseSharedContainer`).
4. **`container: true` requires `mode: docker`.** `builtin` mode has no container. Error (`:489`): `State "<id>" has container: true but settings.mode is not "docker".` (`mode` defaults to `'docker'` in the validator.)
5. **Scope-coherence.** `container: true` states need **no** MCP servers (they don't call the coordinator), so there is no required-server contribution — only the scope charset is enforced (already by the schema). Confirmed: no extra cross-state required-server check was added.
6. **`containerScope` requires `mode: docker` on agent states (post-review fix).** Builtin mode ignores `sharedContainer` (the orchestrator's `shouldUseSharedContainer` returns `false` for `mode: builtin`), so an agent `containerScope` declared under `mode: builtin` is a silent no-op — a workflow that _looks_ scoped but runs per-state builtin containers. `validateContainerScopes` now rejects it: `State "<id>" declares containerScope "<scope>" but settings.mode is "<mode>", not "docker". Builtin mode ignores sharedContainer, so the scope would be a silent no-op.` Deterministic states reach this transitively (rule 2 → rule 4); agent states are now checked directly. Added in response to PR review feedback.

**Backward-compat (held).** No shipped workflow has a `type: deterministic` state (vuln-discovery, design-and-code, test-email-summary contain zero deterministic states — vuln-discovery and test-email-summary set `sharedContainer: true`; design-and-code does not), so there is no existing-YAML regression surface. With `container` defaulting to `false`, `executeDeterministicState` dispatches to `runDeterministicHost` unchanged. This is verified by `test/workflow/orchestrator-deterministic.test.ts` (synthetic host-side state asserting identical `{ passed, testCount, errors }` and that `docker.exec` is never invoked) and a `test/workflow/validate.test.ts` no-regression snapshot over the three shipped workflows.

---

## 4. Execution-path changes

### 4.1 Thread scope into the invoke input

`DeterministicInvokeInput` (`src/workflow/machine-builder.ts:61`) gained three optional fields:

```ts
export interface DeterministicInvokeInput {
  readonly stateId: string;
  readonly commands: readonly (readonly string[])[];
  readonly context: WorkflowContext;
  readonly container?: boolean;
  readonly containerScope?: string;
  readonly timeoutMs?: number;
}
```

`workflowId` is **not** in the input — the orchestrator already closes over `workflowId` when it provides the actor (inside `buildMachine(workflowId, ...)`), so `executeDeterministicState(workflowId, input)` takes it as a separate first arg (§4.3). Passing `container`/`containerScope`/`timeoutMs` through the input keeps the machine-builder mapper as the single source of state config, and keeps the actor a pure consumer of `this.workflows.get(workflowId)`.

### 4.2 Populate the input in both construction sites

**Machine-builder mapper** (`src/workflow/machine-builder.ts:290`), as built:

```ts
input: ({ context }: { context: WorkflowContext }) => ({
  stateId,
  commands: config.run,
  context,
  container: config.container ?? false,
  containerScope: config.containerScope,
  timeoutMs: config.timeoutMs,
}),
```

**Resume replay** (`src/workflow/orchestrator.ts:1457`), as built:

```ts
: this.executeDeterministicState(workflowId, {
    stateId,
    commands: stateDef.run,
    context,
    container: stateDef.container ?? false,
    containerScope: stateDef.containerScope,
    timeoutMs: stateDef.timeoutMs,
  });
```

(`stateDef` is `DeterministicStateDefinition` in this branch; the new fields are added to that type in §10.)

### 4.3 Bundle resolution + dispatch in `executeDeterministicState`

> **Resolution note (read first).** The bundle-resolution strategy is **decided in §7 and §12(1): mint-on-demand via `ensureBundleForScope` with a soft warning, not a hard `bundlesByScope.get` fail-fast.** The code block below reflects that decision and the shipped code.

`executeDeterministicState` (now `src/workflow/orchestrator.ts:2343`) takes `workflowId` and dispatches on `input.container`. **As built** it also gained a runtime `shouldUseSharedContainer(definition)` guard (not in the original design) so a `container: true` state on a non-shared-container workflow fails with a clear result rather than reaching `ensureBundleForScope` — a defense-in-depth backstop to the static validation in §3.3 (rule 3). The shipped form:

```ts
private async executeDeterministicState(
  workflowId: WorkflowId,
  input: DeterministicInvokeInput,
): Promise<DeterministicInvokeResult> {
  if (!input.container) {
    return this.runDeterministicHost(input.commands); // §4.4
  }

  const instance = this.workflows.get(workflowId);
  if (!instance) {
    return { passed: false, errors: `workflow ${workflowId} not found` };
  }
  if (!this.shouldUseSharedContainer(instance.definition)) {
    return { passed: false, errors: `State "${input.stateId}" requires shared-container Docker execution.` };
  }

  const scope = input.containerScope ?? DEFAULT_CONTAINER_SCOPE;
  // Mint-on-demand (decision, §7/§12(1)): `ensureBundleForScope` reuses the
  // live bundle when present and mints one (re-attaching the persisted
  // /workspace) otherwise. The "was a bundle already live?" probe is the
  // available proxy for "did anything run in this scope yet?": a miss on a
  // fresh run is the graph-ordering footgun we warn about; on resume the
  // persisted /workspace makes the warning benign.
  const bundleWasLive = instance.bundlesByScope.has(scope); // before minting
  const bundle = await this.ensureBundleForScope(instance, scope); // :837
  const warning = bundleWasLive
    ? undefined
    : `container: true state "${input.stateId}": scope "${scope}" had no live container before this state. ` +
      `On a fresh run this likely means no prior state populated it; on resume this can be expected.`;
  return this.runDeterministicInContainer(bundle, input, warning); // §4.5
}
```

**Signature change:** the actor and replay both pass `workflowId` (both already had it in scope):

- Orchestrator actor (now `:1687`): `await this.executeDeterministicState(workflowId, input)`.
- Replay (now `:1457`): `this.executeDeterministicState(workflowId, { ... container: stateDef.container ?? false, containerScope: stateDef.containerScope, timeoutMs: stateDef.timeoutMs })`.

**Why mint-on-demand (not fail-fast).** A naive fail-fast on `bundlesByScope.get` would break a legitimate resume that lands directly on a deterministic state (the scope's bundle is lazily re-minted on demand, and `/workspace` is bind-mounted from the persisted run dir so the prior agent's code is present). `ensureBundleForScope` (`src/workflow/orchestrator.ts:804`) handles both fresh-run and resume uniformly. The "empty container" risk is really "empty _workspace_," which only arises from a genuine graph ordering bug; we surface that as a soft `writeStderr` log (the orchestrator's stderr helper at `orchestrator.ts:172`; **not** `console.*`, which `logger.setup()` may hijack to a file; kept out of `errors` so it does not flip `passed` — see §4.5) rather than a hard error, and still return a real exit-coded result. The strict fail-fast remains a defensible alternative for catching graph bugs — flagged for the maintainer in §12(1). **As built**, this is also now caught statically by WF011 (§3.3/§10). Errors still route to the state's `onError` target via the existing `findErrorTarget` wiring (`src/workflow/machine-builder.ts:264`).

### 4.4 Host branch (extracted, unchanged semantics)

**As built**, the host loop body was not literally duplicated. Both paths share a single reducer, `reduceDeterministicCommands(commands, runCommand)` (`src/workflow/orchestrator.ts:2376`), which owns the empty-array skip, the `N tests pass`/`specs pass` regex, the per-command error accumulation, and the `{ passed, testCount, errors }` assembly. `runDeterministicHost(commands)` (`:2404`) is a thin wrapper passing a `runCommand` closure that calls `execFileAsync`. This keeps the `container: false` path semantically byte-identical to the prior loop (verified by `test/workflow/orchestrator-deterministic.test.ts`), while guaranteeing host and container cannot drift in their pass/fail or test-count logic — the only fork is the per-command runner closure.

### 4.5 In-container branch

**As built**, `runDeterministicInContainer(bundle, input, warning)` (`src/workflow/orchestrator.ts:2417`) logs the soft warning via `writeStderr`, then delegates to the same `reduceDeterministicCommands` reducer with a `runCommand` closure that calls `bundle.docker.exec`:

```ts
private async runDeterministicInContainer(
  bundle: DockerInfrastructure,
  input: DeterministicInvokeInput,
  warning?: string, // soft graph-ordering warning from §4.3
): Promise<DeterministicInvokeResult> {
  // Logged but kept OUT of the reducer's error accumulation so it does not
  // flip `passed` (passed stays driven by exit codes only). Via writeStderr
  // (orchestrator.ts:172), NOT console.* (logger.setup() may hijack console.*).
  if (warning) writeStderr(`[workflow] ${warning}`);

  return this.reduceDeterministicCommands(input.commands, async (cmdArray) => {
    const result = await bundle.docker.exec( // bundle.docker is the DockerManager (:160)
      bundle.containerId,
      cmdArray,                              // verbatim author argv (no shell wrapper)
      input.timeoutMs,                       // undefined ⇒ DockerManager default (10 min)
      'codespace',                           // explicit exec user (matches agent sessions)
      CONTAINER_WORKSPACE_DIR,                // new --workdir param, §4.5(a)
    );
    if (result.exitCode !== 0) {
      return { stdout: '', error: result.stderr || result.stdout || `exit ${result.exitCode}` };
    }
    return { stdout: result.stdout };
  });
}
```

The reducer mines `testCount` from `stdout` on the success path and pushes `error` onto `allErrors` otherwise, so the exit-code→`passed` mapping is identical to host (`exitCode !== 0` is the in-container analog of `execFileAsync` rejecting). `CONTAINER_WORKSPACE_DIR` is imported from `src/docker/agent-adapter.ts:19` into the orchestrator.

**Working-directory mechanism (decision).** `DockerManager.exec` accepted no `-w`/`--workdir` and no `env`. Two clean options:

- (a) Add an optional 5th param `workdir?: string` to `DockerManager.exec` that appends `--workdir <dir>` to the `docker exec` args. **Chosen and built** — a one-line addition in `src/docker/docker-manager.ts:264` (`workdirArgs = workdir === undefined ? [] : ['--workdir', workdir]`, spliced into the `docker exec` argv) plus the param on the `DockerManager` interface (`src/docker/types.ts:179`). Keeps the command array equal to the author's `run` entry (no shell wrapper). `CONTAINER_WORKSPACE_DIR` is passed as the 5th arg.
- (b) Shell-wrap with `sh -c 'cd … && exec "$@"'`. Rejected: introduces a shell where none is needed and complicates argv quoting; conflicts with the no-shell-string rule's spirit.

**Exit-code → `passed` mapping.** `passed = allErrors.length === 0`, identical semantics to host (`exitCode !== 0` is the in-container analog of `execFileAsync` rejecting). Test-count mining is unchanged. **Result shape is unchanged** — `{ passed, testCount, errors }`.

**Timeout source.** `input.timeoutMs` flows from the new YAML `timeoutMs` field (**surfaced in the schema — see §12(2)**, a change from the original "deferred" plan) through `DeterministicInvokeInput` to `DockerManager.exec`. When absent it is `undefined` → DockerManager's 10-minute default.

### 4.6 Result-contract seam (built as a shared reducer, not a `DeterministicRunner` module)

**Deviation from design.** The design proposed a standalone leaf module `src/workflow/deterministic-runner.ts` exporting `DeterministicRunResult` / `DeterministicRunner` / `HostRunner` / `ContainerRunner`. **That module was not created.** Instead, the host/container fork was reduced to a single `runCommand` closure threaded into `reduceDeterministicCommands` (`src/workflow/orchestrator.ts:2376`), all inlined in `orchestrator.ts` (see §4.4/§4.5). The closures return `{ stdout: string; error?: string }` — a thinner shape than the proposed `{ exitCode, stdout, stderr }` triple, sufficient for the current stdout-mining reducer.

This still serves the same goal the `DeterministicRunner` interface was meant to serve: the result-contract piece (`when: { verdict }` from a helper-written file) plugs into the **reduction** step (`reduceDeterministicCommands`), not the exec path, without touching argv/timeout/workdir logic. When the result-contract work lands it can either (a) replace the reducer's stdout-mining with file reading, or (b) extract the runner closures into the originally-designed module at that point. The future-work refactor of `executeDeterministicState` is the natural place to introduce the `DeterministicRunner` interface if a richer per-command result (`exitCode`/`stderr` separately) is needed; the current `{ stdout, error? }` closure shape is intentionally minimal.

---

## 5. Script packaging — code delivery

### 5.1 Workflow package layout

```
src/workflow/workflows/<name>/
  workflow.yaml
  skills/                 (existing)
  scripts/                (NEW)
    run_suite.py
    helpers/util.py
    requirements.txt      (optional — triggers Python dep install, §6)
    lint.js
    package.json          (optional — triggers Node dep install, §6)
```

User-global workflows under `~/.ironcurtain/workflows/<name>/scripts/` are supported identically (the package dir resolves via `getWorkflowPackageDir(definitionPath)`, `src/workflow/discovery.ts`).

### 5.2 Decision: parallel `/workflow-scripts` mount, NOT skill-staging reuse

Skills are re-staged **every transition** by `createCachedStager` because the per-state `skills:` filter changes the staged set between states (`src/docker/docker-infrastructure.ts:644-658`). Deterministic states have **no** `skills:` filter and there is no per-state script subsetting — every `container: true` state sees the whole `scripts/` tree, unconditionally, for the whole run. Forcing scripts through the skill stager would (a) couple scripts to the per-state filter semantics they don't want, (b) re-copy on every transition for no reason, and (c) muddy the cached-stager invariant.

**Chosen:** stage `scripts/` **once at run start** to `resolve(bundleDir, 'workflow-scripts')` and bind-mount it **read-only** into the container at `/workflow-scripts` — a sibling of the existing skills mount. One stage per bundle, no re-staging, no filter. This mirrors the inline workspace/skills mount construction in `createSessionContainers` (the `mounts` array literal at `src/docker/docker-infrastructure.ts:949`, with skills pushed at `:1066` — there is no `buildContainerMounts` function; the mounts are assembled inline).

Wiring:

**As built**, the staging/copy happens in the **orchestrator** (one `cpSync` into the run dir), not in `prepareDockerInfrastructure` — which just records the mount if the staged dir exists. The wiring:

- A `scriptsMount?: { hostDir: string; target: string }` field on `PreContainerInfrastructure` / `DockerInfrastructure` (`src/docker/docker-infrastructure.ts:193`), set in `prepareDockerInfrastructure` (`:670`) only when the passed `scriptsDir` exists. No copy here — the orchestrator already staged it.
- The inline `mounts` array in `createSessionContainers` pushes `{ source: core.scriptsMount.hostDir, target: core.scriptsMount.target, readonly: true }` (`:1087`, next to the skills push).
- The orchestrator stages once at `start()` via `stageWorkflowScriptsAtStart(packageDir, metaDir)` (`src/workflow/orchestrator.ts:1259`), which delegates to a shared `stageWorkflowSubdir` core (refactored to also back `stageWorkflowSkillsAtStart`). The staged path lives on `WorkflowInstance.workflowScriptsDir` (`:590`) and is threaded into `createDockerInfrastructure` as the trailing `scriptsDir` arg (via `CreateWorkflowInfrastructureInput.workflowScriptsDir`, `:393`). Skipped when `scripts/` is absent.

Constant: `export const CONTAINER_SCRIPTS_DIR = '/workflow-scripts';` in `src/docker/agent-adapter.ts:22`, next to `CONTAINER_WORKSPACE_DIR`. (Note: the mount/target is wired via `CONTAINER_SCRIPTS_DIR`, but the orchestrator passes `CONTAINER_WORKSPACE_DIR` as the exec `--workdir`, so scripts run _from_ `/workspace` and _read_ `/workflow-scripts`.)

### 5.3 Exact `docker exec` commands

With workdir `/workspace` and scripts at `/workflow-scripts`:

**Python** (`run: [['python', '/workflow-scripts/run_suite.py', '--json']]`):

```
docker exec --user codespace --workdir /workspace <containerId> \
  python /workflow-scripts/run_suite.py --json
```

For dependency-bearing scripts the venv is on `PATH` / `python` resolves the baked venv (§6), so no `uv run` wrapper is needed; if a workflow prefers explicit isolation it can write `['uv', 'run', '/workflow-scripts/run_suite.py']` and uv resolves the per-workflow venv baked at build time.

**Node** (`run: [['node', '/workflow-scripts/lint.js']]`):

```
docker exec --user codespace --workdir /workspace <containerId> \
  node /workflow-scripts/lint.js
```

`node_modules` for these scripts live next to the baked install location (§6), discoverable via `NODE_PATH` set in the per-workflow image, so `require('left-pad')` resolves even though `lint.js` runs from `/workflow-scripts`.

`<containerId>` is `bundle.containerId`. The `--workdir` flag is added to `DockerManager.exec` per §4.5(a).

---

## 6. Script packaging — dependencies (offline runtime)

Runtime is `--network=none`. All fetching happens at **image build**, which has network. We bake a **per-workflow image layer** only when a dependency manifest is present.

### 6.1 No-deps fast path (default)

If `scripts/` has **no** `requirements.txt` and **no** `package.json` (or no `scripts/` at all), use the **shared agent image** unchanged. The base image already ships Python 3.12 stdlib, `ruff`, pip, and Node. Zero rebuild, zero per-workflow image. This is the common case and the only case vuln-discovery / design-and-code hit (they ship no scripts).

### 6.2 Per-workflow image (when a manifest exists)

When `scripts/requirements.txt` and/or `scripts/package.json` exists, build a thin image **`FROM ironcurtain-<agent>:latest`** (the exact agent image the bundle would otherwise use) that installs deps at build time.

**Generated in-memory with a hardcoded `FROM`.** `DockerManager.buildImage(tag, dockerfilePath, contextDir, labels?)` (`src/docker/docker-manager.ts:325-348`) takes a Dockerfile _path_ and a context _dir_ — **it has no `--build-arg` support** (its only build env is `DOCKER_BUILDKIT=1`, `:342-347`). So `ARG BASE` / `FROM ${BASE}` is not buildable. Instead, generate the Dockerfile text per agent with the base image resolved and **hardcoded** into the `FROM` line, then write it into a dedicated build context (below). The resolved base is exactly the agent image `ensureWorkflowImage` ensured first (§6.3) — i.e. whatever `adapter.getImage()` returns (`src/docker/docker-infrastructure.ts:625`), typically `ironcurtain-<agent>:latest`.

**Dedicated build context (B2).** The agent-image build context is `dockerDir` (`ensureImage`, `:1296`), which does **not** contain the workflow `scripts/` tree — so a `COPY scripts …` against it would fail. Mirror the base-image pattern instead, which assembles a temp context (`mkdtempSync` + copy `docker/*` + CA, `:1341-1348`) and builds from it. For the per-workflow layer, assemble a dedicated **temp** context dir (`mkdtempSync`) containing **only** the dependency manifests and a copy of the `scripts/` tree, write the generated Dockerfile into it, and call `buildImage(tag, <ctx>/Dockerfile, <ctx>, labels)`. Prefer a fresh temp dir over reusing the already-staged `bundleDir/workflow-scripts` from §5.2: that dir is bind-mounted read-only at `/workflow-scripts` at runtime, so writing the generated `Dockerfile` into it would leak the Dockerfile into the running container's `/workflow-scripts`. The `COPY` lines below are written against that context root.

Generated Dockerfile (no `ARG`; `<AGENT_IMAGE>` substituted at generation time). The shipped `ensureWorkflowImage` (`src/docker/docker-infrastructure.ts:1375`) emits this exact text (single-line `RUN` bodies, shown wrapped here for readability):

```dockerfile
# Generated in-memory per-workflow (written into the dedicated build context).
FROM <AGENT_IMAGE>            # e.g. ironcurtain-claude-code:latest — resolved & hardcoded
USER root
# Context root contains the staged scripts/ tree + manifests at its top level.
COPY . /opt/workflow-scripts-build
# Python: uv reaches PyPI over the normal build-host network (see rationale below).
RUN if [ -f /opt/workflow-scripts-build/requirements.txt ]; then \
      uv venv /opt/workflow-venv && \
      VIRTUAL_ENV=/opt/workflow-venv uv pip install \
        -r /opt/workflow-scripts-build/requirements.txt; \
    fi
# Node: npm ci when a lockfile is present, else npm install — both --omit=dev.
RUN if [ -f /opt/workflow-scripts-build/package.json ]; then \
      cd /opt/workflow-scripts-build && \
      if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi && \
      mv node_modules /opt/workflow-node_modules; \
    fi
ENV PATH=/opt/workflow-venv/bin:${PATH}
ENV NODE_PATH=/opt/workflow-node_modules
USER codespace
```

**Deviation from design (Node install).** The design's Dockerfile used an unconditional `npm ci --omit=dev`. **As built** it is `if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi` — `npm ci` requires a lockfile, so the fallback lets a `package.json`-only workflow (no committed `package-lock.json`, like the `deterministic-eval-smoke` fixture) still build. Reproducibility still recommends committing a lockfile.

**Inherited `ENTRYPOINT` / `USER` are fine.** Because the layer is `FROM ironcurtain-<agent>:latest`, it inherits the agent image's `ENTRYPOINT` and `USER codespace`. Neither matters for deterministic execution: the workflow container is launched with `sleep infinity` and commands run via `docker exec`, which **bypasses `ENTRYPOINT` entirely**; the exec user is set explicitly to `codespace` (§4.5), independent of the image's default `USER`. The trailing `USER codespace` above just keeps the image default consistent with the agent image.

- **Python:** `requirements.txt` → `uv pip install` into a baked venv at `/opt/workflow-venv`; the venv `bin` is prepended to `PATH` so `python` resolves the **venv interpreter** with deps. Deterministic states that need the deps should invoke the venv interpreter explicitly — e.g. `['/opt/workflow-venv/bin/python', '/workflow-scripts/run_eval.py']` — or rely on the `PATH` ordering (`python` → `/opt/workflow-venv/bin/python`). (Decision: `uv pip install` over bare `pip` — uv is already the base-image standard.)
- **Node:** `package.json` (+ `package-lock.json` if present) → `npm ci --omit=dev` (or `npm install --omit=dev` without a lockfile); baked `node_modules` at `/opt/workflow-node_modules`, exposed via `NODE_PATH` so `require()` resolves it even though scripts run from `/workflow-scripts`. (Decision: prefer `npm ci` for lockfile-pinned reproducibility; npm over pnpm because npm ships in the base image and avoids a new toolchain.)

> **Build-time network model (corrected).** There is **no MITM/proxy at `docker build` time.** `buildImage` injects only `DOCKER_BUILDKIT=1` and no proxy env (`src/docker/docker-manager.ts:342-347`); the `HTTPS_PROXY`/`HTTP_PROXY` MITM is only injected into the _running container_ at `docker create` time (`src/docker/docker-infrastructure.ts:969-970,1025-1026`), not the build. So the build reaches PyPI/npm over the **normal build-host network** — implementers should not hunt for a build-time proxy or a CA-trust shim. (`UV_NATIVE_TLS=1` in the base image is incidental here; it governs uv's TLS backend, not any MITM trust, and no MITM is in the build path.)

**Where deps live: baked in the image, NOT mounted.** The `/workflow-scripts` _code_ mount is RO and per-run; the _dependencies_ are baked into the image. This keeps the RO code mount free of a giant `node_modules`/venv, makes the image self-contained for offline runtime, and gives reproducibility (the build hash pins the manifest — §6.3).

The `scripts/` source is also still mounted RO at `/workflow-scripts` at runtime (§5) so edits to the helper code between runs don't require a rebuild _unless_ the dependency manifest changed.

### 6.3 Build-hash extension + the `ensureWorkflowImage` seam

**Child build hash.** `computeBuildHash` is module-private and tied to `dockerDir`'s file set, so it is not reusable for a context whose files are the workflow manifests. **As built**, the per-workflow hash lives in the exported `computeWorkflowImageHash(agentBuildHash, scriptsDir)` (`src/docker/docker-infrastructure.ts:1405`):

```
wfImageHash = sha256( "agent:<agentBuildHash>\n"
                      ++ for each of [requirements.txt, package.json, package-lock.json] present:
                           "file:<name>\n" ++ <bytes> ++ "\n" )
```

Each manifest is keyed by name before its bytes (so add/remove of a manifest changes the hash), and `agentBuildHash` is the parent agent image's hash — **as built**, `ensureImage` now _returns_ that hash (its signature changed from `Promise<void>` to `Promise<string>`, `:1315`) so `ensureWorkflowImage` can chain it. The per-workflow image is named `ironcurtain-wf-<wfImageHash[0:12]>:latest`, labeled `ironcurtain.build-hash = wfImageHash`, and rebuilt only when stale (`isImageStale`). If no manifest changed and the parent agent image is current, the cached per-workflow image is reused — no rebuild.

**New `ensureWorkflowImage` (the real build seam).** `ensureImage` is module-private, derives `Dockerfile.<agent>` from the image name, and always builds from `dockerDir`. Rather than overload it, the exported **`ensureWorkflowImage(agentImage, scriptsDir, docker, ca)`** (`src/docker/docker-infrastructure.ts:1352`) was added, which:

1. **ensures the agent image first** via `ensureImage(agentImage, docker, ca)` (capturing its returned `agentBuildHash`) so the `FROM` target exists and is current;
2. if `scriptsDir` is undefined/absent, or has **neither** `requirements.txt` nor `package.json`, returns `agentImage` unchanged (the §6.1 fast path — no per-workflow image);
3. otherwise computes `wfImageHash`, and if `ironcurtain-wf-<…>` is stale, `mkdtempSync`'s a temp context, `cpSync`'s `scriptsDir` into it, writes the generated Dockerfile, calls `docker.buildImage(wfImage, <ctx>/Dockerfile, <ctx>, { 'ironcurtain.build-hash': wfImageHash })`, and removes the temp dir in a `finally`;
4. returns the per-workflow image name.

**Threading to the real seam (B3) — `imageOverride` was NOT added.** The design proposed adding both `imageOverride?` and `scriptsDir?` to `CreateWorkflowInfrastructureInput` and resolving the image in the orchestrator. **As built, only `scriptsDir`/`workflowScriptsDir` is threaded; there is no `imageOverride` anywhere** (the image is resolved entirely inside the prep path):

- `CreateWorkflowInfrastructureInput` gained `workflowScriptsDir?: string` (`src/workflow/orchestrator.ts:393`) — no `imageOverride`.
- `loadDefaultInfrastructureFactory` (`src/workflow/orchestrator.ts:1095`) maps `input.workflowScriptsDir` to the trailing positional `scriptsDir` arg of `createDockerInfrastructure(...)` (`:1134/:1153`). Both `createDockerInfrastructure` (`:757`) and `prepareDockerInfrastructure` (`:352`) gained a matching trailing `scriptsDir?` parameter.
- Inside `prepareDockerInfrastructure` the unconditional `const image = await adapter.getImage(); await ensureImage(...)` became `const agentImage = await adapter.getImage(); const image = await ensureWorkflowImage(agentImage, scriptsDir, docker, ca);` (`:633`). The returned `image` (per-workflow when a manifest exists, else the agent image) flows into `core.image` exactly as before. No second image field is needed.

This keeps the agent-image staleness/build path untouched for the no-manifest fast path and adds the per-workflow layer only when a manifest is present.

**Reproducibility note.** Builds are not bit-reproducible (uv/npm resolve "latest compatible" absent full pins), but they are **content-addressed**: the same manifests yield the same image hash and the cached image is reused. Workflows wanting strict pinning commit a `package-lock.json` and fully-pinned `requirements.txt`.

---

## 7. Resume & checkpoint interaction

- **Idempotency.** Deterministic states are replayed on resume via `replayInvokeForRestoredState` (`src/workflow/orchestrator.ts:1448`); a `container: true` state re-runs its commands from scratch on resume. Test/lint commands are expected idempotent; no checkpoint of partial command progress (matching host behavior, which also re-runs the whole array).
- **Bundle resolution is `ensureBundleForScope`, both fresh-run and resume (the §4.3 decision, as built).** On resume the orchestrator re-mints bundles lazily per scope. A `container: true` deterministic state that is the _restored_ state mints the scope's bundle on demand via the same `ensureBundleForScope` — the `/workspace` mount carries the prior agent's code (bind-mounted from the persisted run dir), so the container is not "empty." The single residual risk is "empty _workspace_," which only happens on a genuine fresh-run graph-ordering mistake. We detect "no live bundle existed for this scope before minting" (§4.3) and surface a **soft `writeStderr` log**, kept out of `errors` so it never flips `passed`. **The "candidate lint" mentioned in §12(1) was built as a real check — WF011** (`checkContainerScopePopulatedByAgent`, §3.3 / §10), so the fresh-run graph-ordering case is now caught statically at author time, with the runtime warning as the backstop. The strict `bundlesByScope.get` fail-fast remains the un-taken flagged alternative (§12(1)).
- **Scripts on resume.** `workflowScriptsDir` is checkpointed and re-staged on resume by `resolveWorkflowScriptsDirOnResume` (`src/workflow/orchestrator.ts:285`), mirroring `resolveWorkflowSkillsDirOnResume`: trust the checkpointed staged path, else re-stage from the package, else warn (but only when scripts were previously staged — a workflow that never shipped scripts does not warn). The per-workflow image is rebuilt-if-stale by the same `ensureWorkflowImage` path (§6.3), so a resume after a manifest edit transparently rebuilds.

---

## 8. Cross-platform

- **Linux:** container runs `--network=none` (`src/docker/docker-manager.ts:1086`). `docker exec` works identically; no network needed since deps are baked. Exec user is `codespace` (Linux containers start as root for UID-remap then drop; passing `--user codespace` is required so exec lands as the right user — `src/docker/docker-manager.ts:254-261`).
- **macOS:** container runs on the Docker `--internal` bridge with a socat sidecar; `docker exec` is unaffected (it doesn't use the network). VirtioFS UID translation means `--user codespace` is a harmless no-op (`:258-261`). The `/workflow-scripts` and `/workspace` bind mounts behave like the existing skills/workspace mounts on both platforms.
- No platform branch is needed in the exec path: `DockerManager.exec` and the new `--workdir` flag are platform-agnostic. Image build (uv/npm) runs on the build host with network on both platforms.

---

## 9. Security

- **Container isolation is the boundary.** Deterministic in-container commands run inside the same `--network=none` / internal-bridge sandbox as the agent. They cannot reach the network at runtime (deps are baked) and are confined to the container's mounts.
- **Explicit non-mediation by `ToolCallCoordinator`.** `docker exec` is NOT a tool call; it does not pass through the policy engine, audit log, or control server. This is intentional and correct: the `run:` command array is **workflow-author** content (committed in `workflow.yaml`), the same trust level as the host-side `execFileAsync` it replaces — not agent-generated input. We add no policy hook. (Contrast: agent `execute_code` is mediated because the agent authors it.) Document this in `src/trusted-process/CLAUDE.md` so future readers don't mistake the gap for an oversight.
- **No shell string concatenation.** Per root `CLAUDE.md` safe-coding rules, commands are passed as argv arrays to `DockerManager.exec` → `spawn('docker', ['exec', ...])`. The `--workdir` flag value is a constant (`/workspace`), never interpolated user data. We do NOT introduce a `sh -c` wrapper (the §4.5(a) decision avoids it).
- **Workspace-RW write-scoping gap (called out, not closed).** `/workspace` is bind-mounted RW (`src/docker/docker-infrastructure.ts:950`). A `container: true` command can write anywhere under `/workspace`, which maps to the host run workspace. This is the **same** exposure agent sessions already have (they write `/workspace` freely) and the same as host-side deterministic commands (which run with the orchestrator's host privileges — _strictly broader_ than the container). In-container execution is therefore a **net reduction** in privilege vs. host `execFileAsync`. The residual gap — a buggy/malicious workflow script corrupting `/workspace` — is not closed here; mitigations (RO sub-mounts, a scratch dir) are a future hardening item (§12). Trust model: workflow authors are trusted; this matches today.
- **No credential exposure.** Deterministic commands get no fake keys, no MITM access (network-none), no MCP proxies. They see only `/workspace` (RW) and `/workflow-scripts` (RO).

---

## 10. File-by-file change list (as landed)

This is a record of the actual change set on `feat/deterministic-container-execution`. Line numbers are best-effort post-implementation; prefer the named symbols.

| File                                                   | Change (as built)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workflow/types.ts`                                | Added `container?`, `containerScope?`, `timeoutMs?` to `DeterministicStateDefinition` (`:256`); added `workflowScriptsDir?` to `WorkflowCheckpoint` (`:564`). `DEFAULT_CONTAINER_SCOPE = 'primary'` (`:66`) already existed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/workflow/validate.ts`                             | Added `container`/`containerScope`/`timeoutMs` to `deterministicStateSchema` (`:79`, reusing `CONTAINER_SCOPE_PATTERN`). Removed `containerScope` from `AGENT_ONLY_STATE_FIELDS` (now `['maxVisits']`, `:133`). Added a `validateRawInput` guard for `containerScope` on non-agent/non-deterministic types (`:170`). Extended `validateContainerScopes` (`:466`) with the container↔sharedContainer↔mode checks (§3.3 rules 2–4) plus the agent-`containerScope`-requires-`mode: docker` check (§3.3 rule 6, post-review). **Exported `collectTransitionTargets`** (`:199`) for WF011's reuse.                                                                                                                                                                                                                                                                                                                      |
| `src/workflow/lint.ts`                                 | **NEW check WF011** — `checkContainerScopePopulatedByAgent` + `isReachableWithoutScopeAgent` (absorbing BFS from `initial` that prunes same-scope agent states), wired into `lintWorkflow` (`:107`); `'WF011'` added to `DiagnosticCode`. Imports `collectTransitionTargets` from `validate.ts` and `DEFAULT_CONTAINER_SCOPE` from `types.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/workflow/machine-builder.ts`                      | Extended `DeterministicInvokeInput` (`:61`) with `container`/`containerScope`/`timeoutMs`; populated them in the deterministic input mapper (`:290`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/workflow/orchestrator.ts`                         | `executeDeterministicState(workflowId, input)` now dispatches on `container` (`:2343`), with a `shouldUseSharedContainer` runtime guard. Added the shared `reduceDeterministicCommands` reducer (`:2376`) plus thin `runDeterministicHost` (`:2404`) and `runDeterministicInContainer` (`:2417`, calls `bundle.docker.exec`). Updated actor (`:1687`) and replay (`:1457`) call sites. Added `workflowScriptsDir?` to `CreateWorkflowInfrastructureInput` (`:393`) and `WorkflowInstance` (`:590`); threaded `scriptsDir` through `loadDefaultInfrastructureFactory` (`:1095`) into `createDockerInfrastructure`. Added `stageWorkflowScriptsAtStart` (delegating to a shared `stageWorkflowSubdir`) + `resolveWorkflowScriptsDirOnResume` (`:285`); staged at `start()` (`:1259`); checkpoint/restore `workflowScriptsDir`. **No `imageOverride`** (see §6.3). **No `deterministic-runner.ts` module** (see §4.6). |
| `src/docker/docker-manager.ts` + `src/docker/types.ts` | Added optional 5th `workdir?: string` param to `exec` → appends `--workdir <dir>` to the `docker exec` argv (`docker-manager.ts:264`; `types.ts:179`). `buildImage` unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/docker/agent-adapter.ts`                          | Added `export const CONTAINER_SCRIPTS_DIR = '/workflow-scripts'` (`:22`) next to `CONTAINER_WORKSPACE_DIR`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/docker/docker-infrastructure.ts`                  | Added `scriptsMount?` to `PreContainerInfrastructure`/`DockerInfrastructure` (`:193`), set in `prepareDockerInfrastructure` (`:668`) from the passed `scriptsDir`; pushed the RO mount in the inline `mounts` array of `createSessionContainers` (`:1087`). Added trailing `scriptsDir?` param to `prepareDockerInfrastructure` (`:352`) and `createDockerInfrastructure` (`:757`). Replaced inline image resolution (`:633`) with `ensureWorkflowImage(...)`. `ensureImage` now **returns** `agentBuildHash` (`:1315`). Added exported `ensureWorkflowImage` (`:1352`) + `computeWorkflowImageHash` (`:1405`).                                                                                                                                                                                                                                                                                                     |
| `src/trusted-process/CLAUDE.md`                        | Documented explicit non-mediation of `docker exec` deterministic commands (§9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `WORKFLOWS.md`                                         | Documented `container`/`containerScope` on deterministic states, the `scripts/` layout, and the dep-image build (§3, §5, §6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `eslint.config.js`                                     | (Not in the design.) Added `src/workflow/workflows/*/scripts/` to the ignore list so packaged in-container helper JS (e.g. `format_report.js`) is excluded from the TS-project parser and does not break `npm run lint`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/workflow/workflows/deterministic-eval-smoke/`     | NEW acceptance fixture: `workflow.yaml` + `scripts/` (`run_eval.py`, `format_report.js`, `requirements.txt`, `package.json`). See §11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `test/...`                                             | NEW/extended unit tests: `test/workflow/orchestrator-deterministic.test.ts`, `test/workflow/machine-builder.test.ts`, `test/workflow/validate.test.ts`, `test/workflow/lint.test.ts` (WF011), `test/docker-infrastructure.test.ts` (`computeWorkflowImageHash` + `ensureWorkflowImage` fast path), `test/docker-manager.test.ts` (`--workdir` argv). See §11.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

---

## 11. Test plan

### Acceptance fixture: `deterministic-eval-smoke` (shipped & verified)

> **Status:** the fixture shipped at `src/workflow/workflows/deterministic-eval-smoke/` and
> was **verified end-to-end against a real Docker daemon**: the `author` agent wrote
> `/workspace/candidate.py`; `evaluate` imported `numpy` and `report` required `ajv`,
> both running at `--network=none` via `docker exec` into the same `"primary"` bundle;
> the per-workflow image `ironcurtain-wf-<hash>` was built `FROM ironcurtain-claude-code`;
> and routing reached the `done` terminal. **Caveat:** this end-to-end check was a manual
> run, not a committed automated integration test — the committed automated tests are the
> unit tests below (mocked `docker.exec`). The §11 "Integration (real docker)" items #7–#9
> describe the manual verification scope; they are not gated CI tests in this change set.

The primary acceptance test is the realistic minimal shape this feature exists for:
**one trivial agent state mints the container and produces an artifact, then
deterministic in-container states do the mechanical work** (evaluate the artifact
with packaged helpers) in the _same_ container. This is the asi-evolve
`evaluate`/`record` pattern in miniature. There is deliberately **no** zero-agent
variant: a workflow with only deterministic states has no reason to exist — the FSM
runtime (orchestrator, container bundle, checkpoints, gates) is there to mediate
_agent_ runs, so a deterministic state is always a helper _after_ some agent has
run. Ship the fixture under `src/workflow/workflows/deterministic-eval-smoke/`; it
is a smoke-test fixture (analogue of `test-email-summary`), not a real workflow.

**Package layout:**

```text
src/workflow/workflows/deterministic-eval-smoke/
  workflow.yaml
  scripts/
    run_eval.py          # uses a baked Python dep (numpy)
    format_report.js     # uses a baked Node dep (ajv)
    requirements.txt      # numpy
    package.json          # { "dependencies": { "ajv": "^8" } }
```

**`workflow.yaml` (as shipped):**

```yaml
name: deterministic-eval-smoke
description: 'TESTING ONLY - minimal agent plus deterministic in-container helper execution.'
initial: author

settings:
  mode: docker
  dockerAgent: claude-code
  sharedContainer: true
  model: anthropic:claude-haiku-4-5

states:
  author:
    type: agent
    description: Write the candidate program that deterministic helpers will evaluate.
    persona: global # shipped as `global`, not `coder` (the §3.2 example used `coder`)
    prompt: |
      Create exactly one file at /workspace/candidate.py. It must contain:

      def solve(xs):
          return sum(xs)

      Do not create additional files. Finish with the required agent_status block.
    inputs: []
    outputs: []
    transitions:
      - to: evaluate

  evaluate:
    type: deterministic
    description: Run the packaged Python evaluator inside the same shared container.
    container: true # default scope "primary" — reuses the bundle author minted
    run:
      - ['/opt/workflow-venv/bin/python', '/workflow-scripts/run_eval.py']
    transitions:
      - to: report
        guard: isPassed
      - to: failed

  report:
    type: deterministic
    description: Format the evaluation result with the packaged Node helper.
    container: true
    run:
      - ['node', '/workflow-scripts/format_report.js']
    transitions:
      - to: done
        guard: isPassed
      - to: failed

  done:
    type: terminal
    description: Candidate evaluated and report written.

  failed:
    type: terminal
    description: Evaluation failed.
```

**Helpers (as shipped — summarized; see the fixture for full source):**

- `scripts/run_eval.py` — `import numpy as np` (baked into the per-workflow image), loads `/workspace/candidate.py`, runs `solve` over three cases `[[], [1,2,3], [-5,10,12]]`, compares to `[0, 6, 17]` via `np.array_equal`, writes `/workspace/.workflow/eval.json`, prints `"3 tests pass"` on success (exercising the testCount regex) or `SystemExit(1)` on failure.
- `scripts/format_report.js` — `require('ajv')` (baked `node_modules`), reads `eval.json`, compiles+validates a schema requiring `dependency: 'numpy'`, writes `/workspace/.workflow/report.md`, prints `"1 test pass"` (note: not `"1 specs pass"` as the original sketch had) or `process.exit(1)` on invalid data.
- `scripts/requirements.txt` → `numpy`; `scripts/package.json` → `{ "dependencies": { "ajv": "^8.17.1" } }` (no committed `package-lock.json`, so the build uses the `npm install --omit=dev` fallback, §6.2).

**What this fixture proves (verified end to end):**

- A minimal **agent** state mints the `"primary"` bundle and writes `/workspace/candidate.py`; the deterministic `evaluate`/`report` states then `docker exec` into the **same** container — the realistic pattern: evaluate an agent's output in the container the agent worked in.
- **Both dependency paths**: `requirements.txt` (numpy → `/opt/workflow-venv`) and `package.json` (ajv → baked `node_modules`) trigger the per-workflow image build (§6).
- The `/workflow-scripts` RO mount and `/workspace` RW mount, cross-state via the same container (author writes, evaluate reads/writes, report reads).
- exit-code→`passed`, stdout test-count mining, and `isPassed` pass/fail routing to `done` / `failed`.
- The fixture also **lints clean** (no WF011): `author` is a `primary`-scope agent state preceding both `container: true` states, so the scope is populated before either deterministic state runs (`test/workflow/lint.test.ts`).

**Unit (vitest) — committed:**

1. `test/workflow/validate.test.ts`: `container: true` without `sharedContainer` → error; `container: true` with `mode: builtin` → error; `containerScope` on deterministic without `container: true` → error; valid combo passes. No-regression snapshot: vuln-discovery, design-and-code, test-email-summary still validate unchanged.
2. `test/workflow/machine-builder.test.ts`: deterministic input mapper emits `container`/`containerScope`/`timeoutMs` from config; defaults `container: false` when absent.
3. `test/workflow/orchestrator-deterministic.test.ts` (dispatch): `container: false` → `runDeterministicHost` (real `node -e`), `docker.exec` never invoked, result identical to the prior loop. `container: true` with a mock `DockerManager.exec` → exit 0 ⇒ `passed: true`; non-zero ⇒ `passed: false` with stderr in `errors`; stdout-fallback when stderr empty; `"N tests pass"` ⇒ `testCount`. Plus the `shouldUseSharedContainer` and unknown-workflow guards.
4. `test/workflow/orchestrator-deterministic.test.ts` (container branch): asserts `docker.exec` called with `bundle.containerId`, the verbatim `run` argv (no shell wrapper), `timeoutMs`, `'codespace'` user, and `/workspace` workdir; targets the requested `containerScope`; empty `[]` command skipped.
5. `test/docker-infrastructure.test.ts`: `computeWorkflowImageHash` — same manifests ⇒ same hash, changed `requirements.txt` ⇒ different hash; `ensureWorkflowImage` no-manifest fast path returns the agent image and builds no `ironcurtain-wf-*` tag.
6. `test/docker-manager.test.ts`: `exec` builds `docker exec ... --workdir <dir> ...` argv.
7. `test/workflow/lint.test.ts`: **WF011** — flags a `container: true` state whose scope no prior agent populated; does not flag a `container: false` state; the bundled `deterministic-eval-smoke` fixture lints clean.

**Integration (real docker) — manual verification, NOT committed CI tests.** The following were exercised by hand against a real daemon (see the status note at the top of §11) but did not land as gated automated tests: (8) `deterministic-eval-smoke` end-to-end → `author` mints `"primary"`, `evaluate`/`report` exec into the same container, baked `numpy`/`ajv` resolve at `--network=none`, routing reaches `done`; (9) dependency bake → per-workflow image built, imports succeed offline; (10) resume landing on a deterministic state re-mints the bundle with the persisted `/workspace`.

**Backward-compat (green unchanged):** the full existing workflow + orchestrator + policy-engine suites stay green. The host-branch byte-identity invariant is asserted on a **synthetic** host-side deterministic state in `test/workflow/orchestrator-deterministic.test.ts` (routes to `runDeterministicHost`, `docker.exec` never invoked), since no shipped workflow has a `type: deterministic` state.

---

## 12. Open questions / human decisions

The items below carried a **decided default**; they are now resolved as built (or noted still-open). They remain here so the maintainer can revisit them.

1. **Bundle resolution on a directly-resumed deterministic state (§4.3 vs §7).** **Built: `ensureBundleForScope` (mint-on-demand)** — reuses the live bundle when present and re-mints (re-attaching the persisted `/workspace`) otherwise, with a soft `writeStderr` log (kept out of `errors`) when no bundle was live before minting. The strict `bundlesByScope.get` fail-fast remains the un-taken alternative. **The "candidate lint" in this item was BUILT — WF011** (`checkContainerScopePopulatedByAgent` in `src/workflow/lint.ts`): it warns when a `container: true` state is reachable from `initial` without first passing through a same-scope agent state, via an absorbing BFS that prunes same-scope agent states; it reuses `collectTransitionTargets` (now exported from `validate.ts`). So both the runtime backstop and the static lint shipped.
2. **Per-state `timeoutMs` in YAML.** **Built and surfaced as a YAML field** (a change from the design's "deferred" default). `deterministicStateSchema` now has `timeoutMs: z.number().int().positive().optional()` (`src/workflow/validate.ts:82`), threaded through `DeterministicStateDefinition` → `DeterministicInvokeInput` → `DockerManager.exec`. Absent ⇒ `undefined` ⇒ the 10-minute default.
3. **Dependency location.** **Settled & built: baked into the per-workflow image, not mounted** — forced by `--network=none` runtime.
4. **Per-workflow Dockerfile generation.** **Settled & built: generated in-memory with a hardcoded `FROM ironcurtain-<agent>:latest`, written into a dedicated temp build context** — required because `DockerManager.buildImage` has no `--build-arg` and `dockerDir` lacks the `scripts/` tree (§6.2).
5. **Per-workflow image storage / GC.** Per-workflow dep images (`ironcurtain-wf-<hash>`) accumulate. No pruning was implemented — cleanup is left to the operator. **Still open.**

---

## Appendix: chosen-default rationale (quick reference)

- Opt-in `container: true`, not implicit-when-`sharedContainer` → backward-compat is provable.
- Parallel `/workflow-scripts` RO mount, not skill-stager reuse → no per-transition re-stage, no filter coupling.
- Deps baked into a per-workflow image, not mounted → offline-runtime-safe, content-addressed, keeps the RO code mount thin.
- `uv pip install` / `npm ci` → reproducible, uses base-image toolchain. (No MITM at build — the build reaches PyPI/npm over the normal build-host network; see §6.2 build-time network model.)
- `--workdir` flag on `DockerManager.exec`, not a `sh -c` wrapper → no shell, clean argv, safe-coding-compliant.
- Shared `reduceDeterministicCommands` reducer with per-path `runCommand` closures (not the originally-proposed `DeterministicRunner` module) → host/container fork is a single closure; the future verdict-file result contract plugs into the _reducer_, never the exec path. See §4.6.
