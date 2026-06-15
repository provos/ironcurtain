# Containerized Deterministic Execution + Workflow Script Packaging

Status: Design (implementation-ready)
Audience: IronCurtain runtime engineers
Consumer context: `docs/designs/asi-evolve-native-workflow.md` depends on this capability, but the work here is general-purpose workflow-runtime work, not ASI-Evolve-specific.

---

## 1. Summary & goals

### What ships

1. **In-container deterministic execution.** A workflow `deterministic` state can run its `run:` command array _inside the workflow's shared Docker container_ via `docker exec` instead of host-side `execFileAsync`. Opt-in per state via a new boolean field `container: true`. The state binds to a `containerScope` (default `"primary"`), reuses the bundle the orchestrator already minted for that scope (`instance.bundlesByScope`), and returns the **same** `{ passed, testCount, errors }` result shape as today.

2. **Workflow script packaging.** A workflow package can ship a `scripts/` directory (Python and/or Node helpers, plus `requirements.txt` / `package.json`). Code is delivered into the container via a dedicated read-only bind mount at `/workflow-scripts`. Dependencies are installed **at image-build time** (where network exists) into a per-workflow image layer; the resulting `site-packages` / `node_modules` are baked into a per-workflow image so they are available at `--network=none` runtime. A no-dependency fast path (stdlib / base-image-only) reuses the shared agent image with zero rebuild.

### What does NOT ship (explicit seams)

- **The structured deterministic result contract.** Routing on `when: { verdict: ... }` from a helper-written result file is a _separate_ piece (see `docs/designs/asi-evolve-native-workflow.md`). Containerized execution must keep working with today's stdout-mined `{ passed, testCount, errors }`. §4 defines a clean `DeterministicRunner` interface so the result-contract piece plugs in later without touching the exec path. **We do not design the result file here.**
- No change to agent-state behavior, policy hot-swap, or the control server.
- No change to host-side deterministic states: `container: false` (the default) is byte-for-byte today's path.

### Non-goals / invariants

- `--network=none` (Linux) / internal-bridge (macOS) is preserved at runtime. No runtime network is introduced. All dependency fetching happens at build time.
- `ToolCallCoordinator` does **not** mediate `docker exec`. Deterministic in-container commands are trusted workflow-author code, not agent-generated tool calls (see §9).

---

## 2. Current behavior (cited)

**Host-side execution.** `IronCurtainWorkflowOrchestrator.executeDeterministicState` loops the command arrays through `execFileAsync` on the **host** and mines a test count from stdout:

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

### 3.3 Validation rules (added to `src/workflow/validate.ts`)

1. **Schema** (`deterministicStateSchema`, `:78-83`): add the two fields, **reusing** the existing `CONTAINER_SCOPE_PATTERN` constant (`src/workflow/validate.ts:52`, already used for the agent `containerScope` at `:66` — do not introduce a new regex):
   ```ts
   container: z.boolean().optional(),
   containerScope: z.string().regex(CONTAINER_SCOPE_PATTERN).optional(),
   ```
2. **`containerScope` requires `container: true` on deterministic states.** Today `containerScope` is in `AGENT_ONLY_STATE_FIELDS` (`:130`), and a `containerScope` on a deterministic state is **silently stripped by Zod** (the deterministic variant of the discriminated union has no such field) rather than rejected with a diagnostic. After adding it to `deterministicStateSchema` (rule 1) it survives parsing, so add an explicit check: on a deterministic state, `containerScope` set but `container !== true` → error `State "<id>" declares containerScope but is not container: true`. Drop `containerScope` from the blanket `AGENT_ONLY_STATE_FIELDS` rejection so the deterministic case is reachable; `maxVisits` stays agent-only.
3. **`container: true` requires `sharedContainer: true`.** Extend the existing scope-usage validator (`validateContainerScopes`, `src/workflow/validate.ts:457`) — which today `continue`s on every non-agent state (`:461`) — so it no longer skips deterministic states. Add: a deterministic state with `container: true` on a workflow without `settings.sharedContainer === true` fails with
   `State "<id>" has container: true but the workflow does not have sharedContainer: true.`
4. **`container: true` requires `mode: docker`.** `builtin` mode has no container. Error: `State "<id>" has container: true but settings.mode is not "docker".`
5. **Scope-coherence (reuse existing infra logic).** `container: true` states participate in the per-scope required-server union exactly like agent states do — but deterministic states need **no** MCP servers (they don't call the coordinator). No new required-server contribution; just ensure the scope key is a valid bundle scope (charset already enforced). No additional cross-state check needed beyond what agent scoping already does.

**Backward-compat proof.** No shipped workflow has a `type: deterministic` state at all (vuln-discovery, design-and-code, test-email-summary contain zero deterministic states — vuln-discovery and test-email-summary do set `sharedContainer: true`; design-and-code does not). So there is no existing-YAML regression surface for this change. The relevant invariant is that the **host branch (`runDeterministicHost`, §4.4) is byte-identical to today's loop**. With `container` defaulting to `false`, `executeDeterministicState` dispatches to that host branch unchanged. This is proven by a unit test on a _synthetic_ host-side deterministic state (`container` absent/false) asserting identical `{ passed, testCount, errors }` output and that `docker.exec` is never invoked — not by asserting against shipped workflows, which have no deterministic states to exercise.

---

## 4. Execution-path changes

### 4.1 Thread scope into the invoke input

Extend `DeterministicInvokeInput` (`src/workflow/machine-builder.ts:60-64`):

```ts
export interface DeterministicInvokeInput {
  readonly stateId: string;
  readonly commands: readonly (readonly string[])[];
  readonly context: WorkflowContext;
  /** undefined ⇒ host-side execFileAsync (today's path). */
  readonly container?: boolean;
  /** Bundle scope to exec into when container === true. */
  readonly containerScope?: string;
  /** Per-command timeout override (ms); falls back to DockerManager default. */
  readonly timeoutMs?: number;
}
```

`workflowId` is **not** added to the input — the orchestrator already closes over `workflowId` when it provides the actor (`src/workflow/orchestrator.ts:1596`, inside `buildMachine(workflowId, ...)`). Passing `container`/`containerScope` through the input keeps the machine-builder mapper as the single source of state config, and keeps the actor a pure consumer of `this.workflows.get(workflowId)`.

### 4.2 Populate the input in both construction sites

**Machine-builder mapper** (`src/workflow/machine-builder.ts:283-287`):

```ts
input: ({ context }: { context: WorkflowContext }) => ({
  stateId,
  commands: config.run,
  context,
  container: config.container ?? false,
  containerScope: config.containerScope,
}),
```

**Resume replay** (`src/workflow/orchestrator.ts:1375`):

```ts
: this.executeDeterministicState({
    stateId,
    commands: stateDef.run,
    context,
    container: stateDef.container ?? false,
    containerScope: stateDef.containerScope,
  });
```

(`stateDef` is `DeterministicStateDefinition` in this branch; the new fields are added to that type in §10.)

### 4.3 Bundle resolution + dispatch in `executeDeterministicState`

> **Resolution note (read first).** The bundle-resolution strategy is **decided in §7 and §12(1): mint-on-demand via `ensureBundleForScope` with a soft warning, not a hard `bundlesByScope.get` fail-fast.** The code block below reflects that decision. (An earlier draft of this section used a hard fail-fast `bundlesByScope.get` null-check; that is superseded — it is retained only as the flagged alternative in §12.) Implement the mint-on-demand form shown here.

Refactor `executeDeterministicState` (`src/workflow/orchestrator.ts:2253`) to dispatch on `input.container`:

```ts
private async executeDeterministicState(
  workflowId: WorkflowId,
  input: DeterministicInvokeInput,
): Promise<DeterministicInvokeResult> {
  if (!input.container) {
    return this.runDeterministicHost(input.commands);   // §4.4 — unchanged body
  }
  const instance = this.workflows.get(workflowId);
  if (!instance) {
    return { passed: false, errors: `workflow ${workflowId} not found` };
  }
  const scope = input.containerScope ?? DEFAULT_CONTAINER_SCOPE;
  // Mint-on-demand (decision, §7/§12(1)): a fresh run that lands a
  // deterministic state before any agent ran in `scope` is a graph
  // mistake, but on resume the scope's bundle simply may not be
  // re-minted yet while `/workspace` still carries the persisted code.
  // `ensureBundleForScope` is correct for both: it reuses the live
  // bundle when present and mints one (re-attaching the persisted
  // workspace mount) otherwise. The "was a bundle already live?" probe
  // is the available proxy for "did anything run in this scope yet?":
  // a miss on a *fresh* run is the graph-ordering footgun we warn about;
  // on resume the persisted `/workspace` mount makes the warning benign.
  const bundleWasLive = instance.bundlesByScope.has(scope);   // before minting
  const bundle = await this.ensureBundleForScope(instance, scope);   // :733
  const warning = bundleWasLive
    ? undefined
    : `container: true state "${input.stateId}": scope "${scope}" had no live ` +
      `container before this state. On a fresh run this means no prior state ` +
      `populated it (likely a graph-ordering bug); on resume /workspace still ` +
      `carries the persisted code, so this is expected.`;
  return this.runDeterministicInContainer(bundle, input, warning);   // §4.5
}
```

**Signature change:** the actor and replay must pass `workflowId`. Both already have it:

- Orchestrator actor (`:1596-1605`): change to `await this.executeDeterministicState(workflowId, input)` (the closure has `workflowId`).
- Replay (`:1375`): `this.executeDeterministicState(workflowId, { ... })`.

**Why mint-on-demand (not fail-fast).** A naive fail-fast on `bundlesByScope.get` would break a legitimate resume that lands directly on a deterministic state (the scope's bundle is lazily re-minted on demand, and `/workspace` is bind-mounted from the persisted run dir so the prior agent's code is present). `ensureBundleForScope` (`:733`) handles both fresh-run and resume uniformly. The "empty container" risk is really "empty _workspace_," which only arises from a genuine graph ordering bug; we surface that as a soft `writeStderr` log (the orchestrator's stderr helper at `orchestrator.ts:167`, used in ~10 places; **not** `console.*`, which `logger.setup()` may hijack to a file; kept out of `errors` so it does not flip `passed` — see §4.5) rather than a hard error, and still return a real exit-coded result. The strict fail-fast remains a defensible alternative for catching graph bugs — flagged for the maintainer in §12(1). Errors still route to the state's `onError` target via the existing `findErrorTarget` wiring (`src/workflow/machine-builder.ts:289-292`).

### 4.4 Host branch (extracted, unchanged)

Move today's loop body verbatim into `runDeterministicHost(commands)` returning `{ passed, testCount, errors }`. No semantic change — this is the `container: false` path and must stay byte-identical for vuln-discovery / design-and-code.

### 4.5 In-container branch

```ts
private async runDeterministicInContainer(
  bundle: DockerInfrastructure,
  input: DeterministicInvokeInput,
  warning?: string,   // soft graph-ordering warning from §4.3
): Promise<DeterministicInvokeResult> {
  let totalTestCount = 0;
  const allErrors: string[] = [];
  // The soft warning is logged but kept OUT of `allErrors` so it does not
  // flip `passed` (passed must stay driven by exit codes only). Log via the
  // orchestrator's `writeStderr` helper (orchestrator.ts:167), NOT console.*
  // (logger.setup() may hijack console.* to a file).
  if (warning) writeStderr(`[workflow] ${warning}\n`);
  for (const cmdArray of input.commands) {
    if (cmdArray.length === 0) continue;
    const [binary, ...args] = cmdArray;
    // Working dir = /workspace via the new --workdir param (§4.5(a)); no
    // shell wrapper. The argv is workflow-author trusted (NOT agent input)
    // and is passed verbatim as positional tokens to docker exec.
    const res = await bundle.docker.exec(           // bundle.docker is the DockerManager (:160)
      bundle.containerId,
      [binary, ...args],                            // verbatim author argv (no shell wrapper)
      input.timeoutMs,                              // undefined ⇒ DockerManager default (10 min)
      'codespace',                                  // explicit exec user (matches agent sessions)
      CONTAINER_WORKSPACE_DIR,                       // new --workdir param, §4.5(a)
    );
    if (res.exitCode !== 0) {
      allErrors.push(res.stderr || res.stdout || `exit ${res.exitCode}`);
    } else {
      const m = /(\d+)\s+(?:tests?|specs?)\s+pass/i.exec(res.stdout);
      if (m) totalTestCount += parseInt(m[1], 10);
    }
  }
  return {
    passed: allErrors.length === 0,
    testCount: totalTestCount > 0 ? totalTestCount : undefined,
    errors: allErrors.length > 0 ? allErrors.join('\n') : undefined,
  };
}
```

**Working-directory mechanism (decision).** `DockerManager.exec` accepts no `-w`/`--workdir` and no `env` (`src/docker/docker-manager.ts:242-285`). Two clean options:

- (a) Add an optional 5th param `workdir?: string` to `DockerManager.exec` that appends `--workdir <dir>` to the `docker exec` args. **Chosen** — a one-line, generally useful addition that keeps the command array equal to the author's `run` entry (no shell wrapper). This is the call shown in the snippet above (`CONTAINER_WORKSPACE_DIR` as the 5th arg).
- (b) Shell-wrap with `sh -c 'cd … && exec "$@"'`. Rejected: introduces a shell where none is needed and complicates argv quoting; conflicts with the no-shell-string rule's spirit.

Use option (a). `CONTAINER_WORKSPACE_DIR` is imported from `src/docker/agent-adapter.ts:19`.

**Exit-code → `passed` mapping.** `passed = allErrors.length === 0`, identical semantics to host (`exitCode !== 0` is the in-container analog of `execFileAsync` rejecting). Test-count mining is unchanged. **Result shape is unchanged** — `{ passed, testCount, errors }`.

**Timeout source.** `input.timeoutMs` (new optional YAML-derived field; if we choose not to surface it in YAML in v1, it is simply `undefined` → DockerManager's 10-minute default). Surfacing a per-state `timeoutMs` in YAML is a small additive follow-up; v1 may ship with default-only and add the field later (see §12).

### 4.6 The pluggable `DeterministicRunner` seam (for the future result contract)

To keep the result-contract piece (`when: { verdict }` from a helper-written file) out of the exec path, define:

```ts
// src/workflow/deterministic-runner.ts (NEW, leaf module — no session imports)
export interface DeterministicRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface DeterministicRunner {
  run(cmd: readonly string[]): Promise<DeterministicRunResult>;
}
```

- `HostRunner` wraps `execFileAsync`.
- `ContainerRunner` wraps `docker.exec(bundle.containerId, cmd, timeoutMs, 'codespace', workdir)`.

`executeDeterministicState` builds the appropriate runner, loops commands through it, and applies **today's** `{ passed, testCount, errors }` reduction. The future result-contract piece replaces only the _reduction_ step (read a result file from `/workspace` instead of mining stdout) — it consumes `DeterministicRunResult` and the bundle's workspace dir, and never touches exec/argv/timeout logic. This interface is the seam called out as out-of-scope; we build it but do not implement the file-reading reducer.

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

- A new `scriptsMount?: { hostDir: string; target: string }` field on `PreContainerInfrastructure` / `DockerInfrastructure`, set in `prepareDockerInfrastructure` (begins `src/docker/docker-infrastructure.ts:334`) alongside `skillsMount` (`:642-652`). Stage once (`cpSync(scriptsSourceDir, hostDir, { recursive: true })`); no cached stager.
- The inline `mounts` array in `createSessionContainers` pushes `{ source: scriptsMount.hostDir, target: '/workflow-scripts', readonly: true }` (next to the skills push at `:1066`).
- The orchestrator passes the staged scripts dir into `createWorkflowInfrastructure` the same way it passes `workflowSkillsDir` (a per-run staged path, stable across resume — §7). Add `workflowScriptsDir?: string` to `WorkflowInstance` and to the infrastructure-creation options, computed at `start()` from `resolve(packageDir, 'scripts')` (skip if absent).

Constant: `const CONTAINER_SCRIPTS_DIR = '/workflow-scripts';` in `src/docker/agent-adapter.ts` next to `CONTAINER_WORKSPACE_DIR`.

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

Generated Dockerfile (no `ARG`; `<AGENT_IMAGE>` is substituted at generation time):

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
# Node: npm ci into a baked node_modules.
RUN if [ -f /opt/workflow-scripts-build/package.json ]; then \
      cd /opt/workflow-scripts-build && npm ci --omit=dev && \
      mv node_modules /opt/workflow-node_modules; \
    fi
ENV PATH=/opt/workflow-venv/bin:${PATH}
ENV NODE_PATH=/opt/workflow-node_modules
USER codespace
```

**Inherited `ENTRYPOINT` / `USER` are fine.** Because the layer is `FROM ironcurtain-<agent>:latest`, it inherits the agent image's `ENTRYPOINT` and `USER codespace`. Neither matters for deterministic execution: the workflow container is launched with `sleep infinity` and commands run via `docker exec`, which **bypasses `ENTRYPOINT` entirely**; the exec user is set explicitly to `codespace` (§4.5), independent of the image's default `USER`. The trailing `USER codespace` above just keeps the image default consistent with the agent image.

- **Python:** `requirements.txt` → `uv pip install` into a baked venv at `/opt/workflow-venv`; the venv `bin` is prepended to `PATH` so `python` resolves the **venv interpreter** with deps. Deterministic states that need the deps should invoke the venv interpreter explicitly — e.g. `['/opt/workflow-venv/bin/python', '/workflow-scripts/run_suite.py']` — or rely on the `PATH` ordering (`python` → `/opt/workflow-venv/bin/python`). (Decision: `uv pip install` over bare `pip` — uv is already the base-image standard.)
- **Node:** `package.json` (+ `package-lock.json` if present) → `npm ci --omit=dev` for reproducible installs; baked `node_modules` at `/opt/workflow-node_modules`, exposed via `NODE_PATH` so `require()` resolves it even though scripts run from `/workflow-scripts`. (Decision: `npm ci` over `npm install` for lockfile-pinned reproducibility; over pnpm because npm ships in the base image and avoids a new toolchain.)

> **Build-time network model (corrected).** There is **no MITM/proxy at `docker build` time.** `buildImage` injects only `DOCKER_BUILDKIT=1` and no proxy env (`src/docker/docker-manager.ts:342-347`); the `HTTPS_PROXY`/`HTTP_PROXY` MITM is only injected into the _running container_ at `docker create` time (`src/docker/docker-infrastructure.ts:969-970,1025-1026`), not the build. So the build reaches PyPI/npm over the **normal build-host network** — implementers should not hunt for a build-time proxy or a CA-trust shim. (`UV_NATIVE_TLS=1` in the base image is incidental here; it governs uv's TLS backend, not any MITM trust, and no MITM is in the build path.)

**Where deps live: baked in the image, NOT mounted.** The `/workflow-scripts` _code_ mount is RO and per-run; the _dependencies_ are baked into the image. This keeps the RO code mount free of a giant `node_modules`/venv, makes the image self-contained for offline runtime, and gives reproducibility (the build hash pins the manifest — §6.3).

The `scripts/` source is also still mounted RO at `/workflow-scripts` at runtime (§5) so edits to the helper code between runs don't require a rebuild _unless_ the dependency manifest changed.

### 6.3 Build-hash extension + the `ensureWorkflowImage` seam

**Child build hash.** `computeBuildHash` (`src/docker/docker-infrastructure.ts:1364-1383`) hashes the named Dockerfiles + every `*.sh` in `dockerDir` + the CA, with optional parent-hash chaining (`parentHash` arg). It is **module-private** and tied to `dockerDir`'s file set, so it is not reusable verbatim for a context whose files are the workflow manifests. For the per-workflow image, compute a dedicated child hash:

```
wfImageHash = sha256( agentBuildHash ++ requirements.txt-bytes ++ package.json-bytes ++ package-lock.json-bytes )
```

where `agentBuildHash` is the parent agent image's hash (the same value `ensureImage` computes at `:1317`). The per-workflow image is named `ironcurtain-wf-<wfImageHash[0:12]>:latest`, labeled `ironcurtain.build-hash = wfImageHash`, and rebuilt only when stale (`isImageStale`, `:1358`). If neither manifest changed and the parent agent image is current, the cached per-workflow image is reused — no rebuild.

**New `ensureWorkflowImage` (the real build seam).** `ensureImage` (`src/docker/docker-infrastructure.ts:1294`) is module-private, derives `Dockerfile.<agent>` from the image name, and always builds from `dockerDir` — it cannot express a parent-plus-extra-layer build from a manifest context. Rather than overload it, add a sibling **`ensureWorkflowImage(agentImage, scriptsDir, docker, ca)`** that:

1. **ensures the agent image first** via the existing `ensureImage(agentImage, docker, ca)` (`:1294`) so the `FROM` target exists and is current;
2. if `scriptsDir` has no manifest, returns `agentImage` unchanged (the §6.1 fast path — no per-workflow image);
3. otherwise computes `wfImageHash`, and if the `ironcurtain-wf-<…>` image is stale, assembles the dedicated build context (§6.2), generates the in-memory Dockerfile with `FROM <agentImage>` hardcoded, and calls `docker.buildImage(wfImage, <ctx>/Dockerfile, <ctx>, { 'ironcurtain.build-hash': wfImageHash })`;
4. returns the per-workflow image name.

**Threading the override to the real seams (B3).** Image resolution + `ensureImage` happen inside **`prepareDockerInfrastructure`** (`src/docker/docker-infrastructure.ts:625-626` — `const image = await adapter.getImage(); await ensureImage(image, docker, ca);`), **not** inside `createDockerInfrastructure` (`:731`, which just delegates to `prepareDockerInfrastructure` at `:743`). So the override is plumbed as follows:

- Add `imageOverride?: string` and `scriptsDir?: string` to `CreateWorkflowInfrastructureInput` (`src/workflow/orchestrator.ts:276`).
- `loadDefaultInfrastructureFactory` (`src/workflow/orchestrator.ts:1033-1082`) is what maps `CreateWorkflowInfrastructureInput` to the **positional-arg** `createDockerInfrastructure(...)` call (`:1062-1081`). It must pass the new `scriptsDir` (and, if we resolve the image name in the orchestrator rather than the prep path, `imageOverride`) through as additional positional/options args. Both `createDockerInfrastructure` (`:731`) and `prepareDockerInfrastructure` (`:334`) gain a matching trailing parameter.
- Inside `prepareDockerInfrastructure`, replace the unconditional `const image = await adapter.getImage(); await ensureImage(image, docker, ca);` (`:625-626`) with: resolve `agentImage = adapter.getImage()`, then `const image = await ensureWorkflowImage(agentImage, scriptsDir, docker, ca);`. The returned `image` (per-workflow image when a manifest exists, else the agent image) flows into the bundle's `core.image` exactly as today (the existing `image` field in the returned `PreContainerInfrastructure`, `:676`), and on into `docker create` via `core.image`. No second image field is needed.

This keeps the agent-image staleness/build path untouched for the no-manifest fast path and adds the per-workflow layer only when a manifest is present.

**Reproducibility note.** Builds are not bit-reproducible (uv/npm resolve "latest compatible" absent full pins), but they are **content-addressed**: the same manifests yield the same image hash and the cached image is reused. Workflows wanting strict pinning commit a `package-lock.json` and fully-pinned `requirements.txt`.

---

## 7. Resume & checkpoint interaction

- **Idempotency.** Deterministic states are already replayed on resume via `replayInvokeForRestoredState` (`src/workflow/orchestrator.ts:1359-1388`); a `container: true` state re-runs its commands from scratch on resume. Test/lint commands are expected idempotent; we add no checkpoint of partial command progress (matching today's host behavior, which also re-runs the whole array).
- **Bundle resolution is `ensureBundleForScope`, both fresh-run and resume (the §4.3 decision).** On resume the orchestrator re-mints bundles lazily per scope (agent states call `ensureBundleForScope`). A `container: true` deterministic state that is the _restored_ state mints the scope's bundle on demand via the same `ensureBundleForScope` — the `/workspace` mount carries the prior agent's code (it is bind-mounted from the persisted run dir), so the container is not "empty" in the worrying sense. The single residual risk is "empty _workspace_," which only happens on a genuine fresh-run graph-ordering mistake (a deterministic state placed before any state populated its scope). We detect that as "no live bundle existed for this scope before minting" (§4.3) and surface a **soft `writeStderr` log** — deliberately kept out of `errors` so it never flips `passed`; the real exit code drives the result. The strict `bundlesByScope.get` fail-fast is the flagged alternative (§12(1)).
- **Scripts on resume.** `workflowScriptsDir` is checkpointed and re-staged on resume exactly like `workflowSkillsDir` (`resolveWorkflowSkillsDirOnResume`, `src/workflow/orchestrator.ts:222-253`): trust the checkpointed staged path, else re-stage from the package, else warn. The per-workflow image is rebuilt-if-stale by the same `ensureWorkflowImage` path (§6.3), so a resume after a manifest edit transparently rebuilds.

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

## 10. File-by-file change list

| File                                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/workflow/types.ts` (state def)                 | Add `container?: boolean` and `containerScope?: string` (+ optional `timeoutMs?`) to `DeterministicStateDefinition` (`:251-260`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/workflow/orchestrator.ts` (`WorkflowInstance`) | Add `workflowScriptsDir?: string` to the in-memory `WorkflowInstance` interface (`src/workflow/orchestrator.ts:519`, next to `workflowSkillsDir`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/workflow/types.ts` (checkpoint)                | Add `workflowScriptsDir?: string` to the **checkpoint** type next to the checkpoint's `workflowSkillsDir` (`src/workflow/types.ts:551`). (Distinct from the `WorkflowInstance` field above — instance vs persisted checkpoint.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/workflow/validate.ts`                          | Add `container` + `containerScope` (+ `timeoutMs`) to `deterministicStateSchema` (`:78-83`), **reusing** `CONTAINER_SCOPE_PATTERN` (`:52`). Drop `containerScope` from `AGENT_ONLY_STATE_FIELDS` (`:130`); add deterministic-specific checks (§3.3 rules 2–4) and extend `validateContainerScopes` (`:457`) so it no longer `continue`s past deterministic states (`:461`) for the `container`/`sharedContainer` check.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/workflow/machine-builder.ts`                   | Extend `DeterministicInvokeInput` (`:60-64`) with `container`/`containerScope`/`timeoutMs`. Populate in the deterministic input mapper (`:283-287`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/workflow/orchestrator.ts`                      | Change `executeDeterministicState` to take `workflowId` + dispatch on `container` (calls `bundle.docker.exec`); extract `runDeterministicHost`; add `runDeterministicInContainer` (`:2253-2279`). Update actor (`:1596-1605`) and replay (`:1375`) call sites. Add `imageOverride?`/`scriptsDir?` to `CreateWorkflowInfrastructureInput` (`:276`) and thread them through `loadDefaultInfrastructureFactory` (`:1033-1082`, where the input maps to the positional-arg `createDockerInfrastructure` call). Stage `scripts/` at `start()`; thread the scripts dir through `ensureBundleForScope` (`:733`) into the factory. Checkpoint/restore `workflowScriptsDir` (mirror `:195-253`).                                                                                                                                               |
| `src/workflow/deterministic-runner.ts`              | NEW leaf module: `DeterministicRunResult`, `DeterministicRunner`, `HostRunner`, `ContainerRunner` (§4.6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/docker/docker-manager.ts`                      | Add optional 5th `workdir?: string` param to `exec` → append `--workdir <dir>` to `docker exec` args (`:242-285`). (`buildImage` is left as-is — `(tag, dockerfilePath, contextDir, labels?)`, `:325-348`; the per-workflow Dockerfile is written to disk in the build context, no new `buildImage` param.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/docker/agent-adapter.ts`                       | Add `CONTAINER_SCRIPTS_DIR = '/workflow-scripts'` next to `CONTAINER_WORKSPACE_DIR` (`:19`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/docker/docker-infrastructure.ts`               | Add `scriptsMount?` to `PreContainerInfrastructure`/`DockerInfrastructure`; stage scripts once in the prep path alongside `skillsMount` (`:642-652`); push the RO mount into the inline `mounts` array in `createSessionContainers` (next to the skills push at `:1066` — no `buildContainerMounts` function exists). Add a trailing `scriptsDir?`/`imageOverride?` param to `prepareDockerInfrastructure` (`:334`) **and** `createDockerInfrastructure` (`:731`). Replace the unconditional image resolution at `:625-626` (`adapter.getImage()` + `ensureImage`) with `ensureWorkflowImage(...)`, whose result flows into the existing `image` return field (`:676`) → `core.image` (`:1084`). Add the NEW module-private `ensureWorkflowImage` + a per-workflow build hash beside `ensureImage`/`computeBuildHash` (`:1294-1383`). |
| `src/trusted-process/CLAUDE.md`                     | Document the explicit non-mediation of `docker exec` deterministic commands (§9).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `WORKFLOWS.md`                                      | Document `container`, `containerScope` on deterministic states, the `scripts/` layout, and the dep-image build (§3, §5, §6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/workflow/workflows/deterministic-eval-smoke/`  | NEW acceptance fixture (minimal agent + in-container deterministic states): `workflow.yaml` + `scripts/` (`run_eval.py`, `format_report.js`, `requirements.txt`, `package.json`). The primary integration test (§11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

---

## 11. Test plan

### Acceptance fixture: `deterministic-eval-smoke`

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

**`workflow.yaml`:**

```yaml
name: deterministic-eval-smoke
description: 'TESTING ONLY — a minimal agent writes a candidate, then deterministic in-container states evaluate it with packaged Python/Node helpers. Smoke-tests in-container deterministic execution + script packaging.'
initial: author

settings:
  mode: docker
  dockerAgent: claude-code
  sharedContainer: true # REQUIRED for container: true
  model: anthropic:claude-haiku-4-5

states:
  author:
    type: agent
    description: The (only) agent step — writes a tiny candidate into /workspace; this mints the "primary" bundle
    persona: coder
    prompt: |
      Write a Python file at /workspace/candidate.py defining `solve(xs)` that
      returns the sum of a list of ints, using your built-in Write tool
      (/workspace is bind-mounted). Then stop.
    outputs:
      - candidate
    transitions:
      - to: evaluate

  evaluate:
    type: deterministic
    description: Run the packaged Python evaluator in the SAME container author used
    container: true # default scope "primary" — reuses the bundle author minted
    run:
      - ['/opt/workflow-venv/bin/python', '/workflow-scripts/run_eval.py']
    transitions:
      - to: report
        guard: isPassed
      - to: failed

  report:
    type: deterministic
    description: Format the evaluation result with the packaged Node helper
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
    description: Evaluation failed (non-zero exit captured in errors).
```

**Helper sketches** (full impls in the fixture):

```python
# run_eval.py — imports the agent's candidate, scores it; exits 0 on pass.
# The "N tests pass" line exercises the testCount regex.
import json, os, importlib.util
import numpy as np  # baked into the per-workflow image at build time
spec = importlib.util.spec_from_file_location('candidate', '/workspace/candidate.py')
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
score = int(mod.solve([1, 2, 3, 4]))  # expect 10
result = {'score': score, 'ok': score == int(np.array([1, 2, 3, 4]).sum())}
os.makedirs('/workspace/.workflow', exist_ok=True)
with open('/workspace/.workflow/eval.json', 'w') as f:
    json.dump(result, f)
if not result['ok']:
    print('eval failed', flush=True); raise SystemExit(1)
print('1 tests pass')
```

```js
// format_report.js — reads eval.json (same /workspace), validates with a baked npm dep, writes a report.
const Ajv = require('ajv'); // node_modules baked into the per-workflow image
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/workspace/.workflow/eval.json', 'utf8'));
const valid = new Ajv().validate(
  { type: 'object', required: ['score', 'ok'], properties: { ok: { const: true } } },
  data,
);
if (!valid) {
  console.error('report: invalid eval.json');
  process.exit(1);
}
fs.writeFileSync('/workspace/.workflow/report.md', `# Eval report\n\nscore: ${data.score}\n`);
console.log('1 specs pass');
```

**What this fixture proves (end to end):**

- A minimal **agent** state mints the `"primary"` bundle and writes `/workspace/candidate.py`; the deterministic `evaluate`/`report` states then `docker exec` into the **same** container (assert containerId equality) — the realistic pattern: evaluate an agent's output in the container the agent worked in.
- **Both dependency paths**: `requirements.txt` (numpy → `/opt/workflow-venv`) and `package.json` (ajv → baked `node_modules`) trigger the per-workflow image build (§6); a manifest change rebuilds.
- The `/workflow-scripts` RO mount and `/workspace` RW mount, cross-state via the same container (author writes, evaluate reads/writes, report reads).
- exit-code→`passed`, stdout test-count mining, and `isPassed` pass/fail routing to `done` / `failed`.

**Unit (vitest):**

1. `validate.ts`: `container: true` without `sharedContainer` → error; `container: true` with `mode: builtin` → error; `containerScope` on deterministic without `container: true` → error; valid combo passes. Negative: existing shipped workflow YAML (vuln-discovery, design-and-code, test-email-summary) still validate unchanged (snapshot) — none has a deterministic state, so this is purely a no-regression check on the schema additions.
2. `machine-builder.ts`: deterministic input mapper emits `container`/`containerScope` from config; defaults `container: false` when absent.
3. `executeDeterministicState` dispatch: `container: false` → `runDeterministicHost` (mock `execFileAsync`), result identical to today. `container: true` with a mock `DockerManager.exec` → exit 0 ⇒ `passed: true`; non-zero ⇒ `passed: false` with stderr in `errors`; stdout `"7 tests pass"` ⇒ `testCount: 7`.
4. `runDeterministicInContainer`: asserts `docker.exec` called with `bundle.containerId`, `--workdir /workspace`, `--user codespace`, and the verbatim `run` argv (no shell wrapper). Empty `[]` command skipped.
5. `computeBuildHash` per-workflow: same manifests ⇒ same hash; changed `requirements.txt` ⇒ different hash; absent manifests ⇒ no per-workflow image (fast path returns shared image name).
6. `DockerManager.exec` workdir param: builds `docker exec --workdir <dir> ...` args (existing exec arg-building test extended).

**Integration (real docker, ~30–60s, gated like existing docker tests):** 7. **Acceptance fixture (`deterministic-eval-smoke`, the primary case):** run end-to-end → the `author` agent mints the `"primary"` bundle and writes `/workspace/candidate.py`; `evaluate` and `report` `docker exec` into the **same** container (assert containerId equality), the packaged Python/Node helpers run with their baked `numpy`/`ajv` deps, both pass → `done`; then force a non-zero exit in `run_eval.py` and assert routing to `failed`. 8. Dependency bake: the fixture's `requirements.txt` (numpy) → per-workflow image built, `import numpy` succeeds at `--network=none` runtime; same for `package.json` (ajv) + `npm ci`. 9. Container-must-exist / resume: kill+resume the fixture checkpointed just before the `evaluate` deterministic state; verify the bundle is re-minted, `/workspace` carries the persisted `candidate.py`, and the state runs.

**Backward-compat (must be green unchanged):** 10. Full existing workflow + orchestrator + policy-engine suites stay green. The host-branch invariant cannot be asserted against shipped workflows (none ships a `type: deterministic` state). Instead, assert it on a **synthetic** host-side deterministic state (`container` absent/false): `executeDeterministicState` routes to `runDeterministicHost`, produces the same `{ passed, testCount, errors }` as today's loop, and `docker.exec` is never invoked. This proves `container: false` is byte-identical to today's path. (Covered in part by test #3; #10 is the suite-wide no-regression gate.)

---

## 12. Open questions / human decisions

The items below carry a **decided default** (both author and reviewer lean the same way); they are implemented as stated in the body. They remain here so the maintainer can flip them deliberately.

1. **Bundle resolution on a directly-resumed deterministic state (§4.3 vs §7).** **Decided default: `ensureBundleForScope` (mint-on-demand)** — it reuses the live bundle when present and re-mints (re-attaching the persisted `/workspace`) otherwise, so a resume that lands directly on a deterministic state works; a fresh-run scope that was never populated yields a soft `writeStderr` log (kept out of `errors`, so it does not flip `passed`). §4.3 and §7 are both written to this. **Maintainer may flip to** a strict `bundlesByScope.get` fail-fast if catching graph-ordering bugs hard (rejecting any deterministic state placed before its scope is populated) is preferred over resume-friendliness. **Note:** a real workflow always begins with an agent state or gate — a deterministic state is a helper that runs _after_ an agent (there is no valid FSM of only deterministic states; the runtime exists to mediate agent runs). So on a **fresh** run a `container: true` state's scope is already populated by a prior agent, and the soft warning only meaningfully fires on (a) **resume** landing directly on a deterministic state — correctly handled by mint-on-demand, which re-attaches the persisted `/workspace` — or (b) a genuine **graph bug**: a deterministic state reachable before any agent populates its scope. Case (b) is better caught statically — a candidate lint: warn if a `container: true` state is reachable from `initial` without an intervening agent state in the same scope. The runtime warning stays as a backstop.
2. **Per-state `timeoutMs` in YAML for v1.** **Decided default: plumb `DeterministicInvokeInput.timeoutMs` end-to-end but do NOT surface a YAML/schema field in v1** — `timeoutMs` is `undefined` → `DockerManager.exec`'s 10-minute default. The plumbing is built either way; only the YAML surface is deferred. **Maintainer may flip to** adding the deterministic-state `timeoutMs` schema field now.
3. **Dependency location.** **Settled: baked into the per-workflow image, not mounted** — forced by `--network=none` runtime (deps must be present without fetch). Not open; recorded for traceability.
4. **Per-workflow Dockerfile generation.** **Settled: generated in-memory with a hardcoded `FROM ironcurtain-<agent>:latest`, written into a dedicated build context** — required because `DockerManager.buildImage` has no `--build-arg` (so `ARG BASE`/`FROM ${BASE}` is unbuildable) and `dockerDir` lacks the `scripts/` tree (§6.2). Not open; recorded so the in-memory choice isn't second-guessed.
5. **Per-workflow image storage / GC.** Per-workflow dep images (`ironcurtain-wf-<hash>`) accumulate. Do we prune stale ones (LRU / on `isImageStale` miss), or leave cleanup to the operator? Out of the hot path but a real operational decision. **Genuinely open.**

---

## Appendix: chosen-default rationale (quick reference)

- Opt-in `container: true`, not implicit-when-`sharedContainer` → backward-compat is provable.
- Parallel `/workflow-scripts` RO mount, not skill-stager reuse → no per-transition re-stage, no filter coupling.
- Deps baked into a per-workflow image, not mounted → offline-runtime-safe, content-addressed, keeps the RO code mount thin.
- `uv pip install` / `npm ci` → reproducible, uses base-image toolchain. (No MITM at build — the build reaches PyPI/npm over the normal build-host network; see §6.2 build-time network model.)
- `--workdir` flag on `DockerManager.exec`, not a `sh -c` wrapper → no shell, clean argv, safe-coding-compliant.
- `DeterministicRunner` seam → the future verdict-file result contract plugs into the _reducer_, never the exec path.
