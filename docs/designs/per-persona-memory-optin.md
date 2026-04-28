# Per-Persona / Per-Job Memory Opt-In

Status: design, not yet implemented
Owner: TBD
Last updated: 2026-04-28

## Revision history

- **2026-04-28**: Resolved import-cycle and orchestrator-deps blockers from
  clean-implementer review. Split the loader-aware helper into a new
  `src/persona/memory-gate.ts` module to break a `memory/ → persona/ → memory/`
  import cycle. Acknowledged that `WorkflowOrchestratorDeps` does not hold
  `userConfig` today and enumerated the four production caller sites and
  the shared `createDeps` test fixture that must be updated. Tightened
  enumerations of `shouldAutoSaveMemory` callers (§5 site E) and the
  workflow orchestrator test target (§9.4). Replaced the `memory: undefined`
  spread idiom in §6.2 with a destructure-omission pattern. Resolved Q7
  in §11 (both `loadJob` and `loadPersona` are sync).
- **2026-04-27**: Initial design.

## 1. Problem

The memory MCP server is currently gated by a single global flag,
`userConfig.memory.enabled` (default `true`), defined in
`~/.ironcurtain/config.json`. The schema lives at
`src/config/user-config.ts:128-135`; it is resolved into
`ResolvedMemoryConfig` at `src/config/user-config.ts:623-628`.

That single flag is consulted at four runtime sites and one orchestrator
site, with inconsistent additional scope checks. The result is two
distinct bugs:

### 1.1 System-prompt leak into non-memory sessions

A workflow agent recently received a system prompt instructing it to
call `memory.context` and `memory.store`, while the memory MCP server
was not actually spawned for that workflow's scope. Tracing the four
call sites:

| # | Site | Adds scope check `(persona OR jobId)`? |
|---|------|----------------------------------------|
| 1 | `src/session/index.ts:467-468` — `buildPersonaSystemPromptAugmentation(resolved.persona, memoryEnabled)` | No (only entered when `opts.persona` is set, which is implicit) |
| 2 | `src/session/index.ts:583-608` — bolts `MEMORY_SERVER_NAME` into `sessionConfig.mcpServers`; for non-persona cron jobs also injects the memory system prompt | Yes |
| 3 | `src/session/index.ts:297-300` — `buildDockerClaudeMd({ memoryEnabled })` writes memory protocol guidance to Docker `~/.claude/CLAUDE.md` | No |
| 4 | `src/docker/pty-session.ts:255-258` — same `buildDockerClaudeMd` call from PTY session path | No |

Sites 3 and 4 (and structurally site 1 — see §1.3) write memory prompts
based on the global flag alone. For ad-hoc / global-policy / non-persona
sessions, `buildDockerClaudeMd` happily emits the "Before responding to
any user message, call the memory.context MCP tool" rule even though
site 2's bolt-on never adds the memory server, so the agent is told to
call a tool that is not present.

### 1.2 Workflow shared-container relay-spawning gap

`extractRequiredServers(compiledPolicy)` (`src/trusted-process/policy-roots.ts:65`)
walks compiled rules' `if.server` field to derive the set of MCP servers
to spawn. The pipeline does not emit memory rules
(`grep -rn memory src/pipeline/` returns nothing), so memory is never
in `extractRequiredServers`'s output.

In standalone session mode, `buildSessionConfig` (`src/session/index.ts:578-608`)
applies `filterMcpServersByPolicy` (which uses `extractRequiredServers`) and
then bolts `MEMORY_SERVER_NAME` into `sessionConfig.mcpServers` *after* the
filter — so memory survives.

In workflow shared-container mode, the orchestrator computes the union
of required servers per scope via `getRequiredServersForScope`
(`src/workflow/orchestrator.ts:700-715`), which only consults
`extractRequiredServers` per persona. The bolt-on at
`session/index.ts:586` runs against `sessionConfig.mcpServers`, but the
bundle was minted with a fixed set that did not include `memory`, and
the per-state coordinator's policy hot-swap is gated by the
`mintedServersByBundle` check at `orchestrator.ts:746-758`. Net result:
in shared-container mode today, **memory is not actually spawned as a
relay**, regardless of `memory.enabled`.

### 1.3 Architectural smell: `ALWAYS_INCLUDED_SERVERS`

`src/persona/resolve.ts:17` declares
`ALWAYS_INCLUDED_SERVERS = new Set(['filesystem', MEMORY_SERVER_NAME])`,
making memory survive `applyServerAllowlist` for personas. This conflates
"always-on tooling for personas" with "session has long-term state."
It also creates a TUI footgun: existing personas without an
`allowlist` would suddenly need one to keep memory if a user moved the
gate into the allowlist.

## 2. Decision

**Per-persona / per-job opt-in, default `true`, with a global kill
switch retained.**

- New per-persona field: `PersonaDefinition.memory?: { enabled: boolean }`.
- New per-job field: `JobDefinition.memory?: { enabled: boolean }`.
- Field absence means "default on" (no behavior change for existing files).
- `userConfig.memory.enabled` is the AND-mask: when `false`, memory is
  off everywhere regardless of persona/job state. (Operations team's
  "turn it off site-wide" lever.)
- For sessions running against the global compiled policy (no persona,
  no job), memory is **always off**, regardless of any flag. This is
  the policy decision that makes ad-hoc default sessions stateless.
- `ALWAYS_INCLUDED_SERVERS` loses `MEMORY_SERVER_NAME`; the
  `session/index.ts:586` bolt-on becomes the single insertion point,
  gated by the resolution helper.

### Rejected alternatives

- **Move memory into the persona's `serverAllowlist`.** Conflates
  "which MCP tools" with "long-term state"; the TUI question becomes
  awkward; existing personas without an explicit allowlist would lose
  memory implicitly. User explicitly rejected this.
- **Keep the global flag only and tighten the four scope checks.**
  Patches the leak symptom but ignores the per-persona UX request and
  leaves the relay gap in workflow shared-container mode. Does not
  address the user wanting memory off for some personas and on for
  others.
- **Flat boolean (`memory: true | false`) on each definition.** Simpler
  on the wire, but precludes future per-persona memory knobs
  (namespace override, per-persona DB path, per-persona LLM key, etc.)
  without another schema migration. Nested object chosen for
  consistency with `userConfig.memory` and for forward compatibility.

## 3. Schema changes

### 3.1 `PersonaDefinition` (`src/persona/types.ts`)

```ts
/** Per-persona memory configuration. */
export interface PersonaMemoryConfig {
  /**
   * Whether the memory MCP server is mounted into sessions for this
   * persona. Defaults to true when this whole block is absent.
   * The global kill switch (`userConfig.memory.enabled`) ANDs with this:
   * if the global is off, memory is off regardless of this field.
   */
  readonly enabled: boolean;
}

export interface PersonaDefinition {
  // ...existing fields...
  /**
   * Optional memory configuration. Absent = use defaults (memory on,
   * subject to the global kill switch). Present = explicit per-persona
   * choice, persisted across upgrades.
   */
  readonly memory?: PersonaMemoryConfig;
}
```

### 3.2 `JobDefinition` (`src/cron/types.ts`)

```ts
/** Per-job memory configuration. Same shape as PersonaMemoryConfig. */
export interface JobMemoryConfig {
  readonly enabled: boolean;
}

export interface JobDefinition {
  // ...existing fields...
  /**
   * Optional memory configuration. Absent = use defaults (memory on,
   * subject to the global kill switch).
   */
  readonly memory?: JobMemoryConfig;
}
```

Reuse the `JobMemoryConfig` type instead of re-declaring `enabled` to
keep the call-site signature readable; the two configs are
intentionally identical.

### 3.3 JSON-on-disk shape

Nested object, not flat boolean. Justification:
- Mirrors `userConfig.memory` (already nested) — single mental model.
- Reserves room for namespace override, per-entity LLM API key, and
  enable/disable per surface (e.g., disable auto-save for one persona
  but keep store/context tools active) without another migration.
- The cost of nesting is one extra property level on disk; for a
  field absent in 99% of files (defaults-by-omission), the on-disk
  cost is zero.

When the user accepts the default during creation, **nothing is written**
(absence == "default on"). Only an explicit toggle-off writes
`"memory": { "enabled": false }`. This keeps definition files clean and
makes the default behavior trivially observable.

## 4. Resolution helper

Single helper, single place that combines the three signals.

### 4.1 Location and signature

The helper is split across two files to avoid an import cycle. The
pure-data variant lives in `src/memory/memory-policy.ts`; the
loader-aware variant lives in `src/persona/memory-gate.ts`. Rationale:
`src/persona/resolve.ts` already imports `MEMORY_SERVER_NAME` from
`src/memory/memory-annotations.ts`, and `src/persona/persona-prompt.ts`
already imports from `src/memory/memory-prompt.ts`. Adding a
`memory/memory-policy.ts → persona/resolve.ts` runtime edge would
close a `memory/ → persona/ → memory/` cycle. Keeping
`memory-policy.ts` strictly pure-data (type-only imports from
`persona/types.ts` and `cron/types.ts`, both verified to have no
imports from `src/memory/`) avoids the cycle entirely; the loader-aware
wrapper, which does need `loadPersona` from `persona/resolve.ts`, lives
on the `persona/` side of the boundary.

#### `src/memory/memory-policy.ts` — pure-data, no runtime imports of `persona/`

New file: `src/memory/memory-policy.ts` — colocated with the other
memory utilities (`resolve-memory-path.ts`, `memory-prompt.ts`).

```ts
// Type-only imports: no runtime edge, no cycle risk.
import type { PersonaDefinition } from '../persona/types.js';
import type { JobDefinition } from '../cron/types.js';
import type { ResolvedUserConfig } from '../config/user-config.js';

/**
 * Inputs to the memory-enablement decision. All fields optional;
 * absence is significant (e.g., no persona AND no job means a default
 * session, which never gets memory).
 */
export interface MemoryGateInputs {
  /** Loaded persona definition, or undefined for non-persona sessions. */
  readonly persona?: PersonaDefinition;
  /** Loaded job definition, or undefined for non-cron sessions. */
  readonly job?: JobDefinition;
  /** Resolved user config (always present at the call sites). */
  readonly userConfig: ResolvedUserConfig;
}

/**
 * Decides whether the memory MCP server is enabled for this session.
 *
 * Precedence (most restrictive wins):
 *   1. Global kill switch: userConfig.memory.enabled === false → off.
 *   2. Scope: no persona AND no job → off (default sessions are stateless).
 *   3. Per-persona: persona.memory.enabled === false → off.
 *   4. Per-job:     job.memory.enabled === false → off.
 *   5. Otherwise: on.
 *
 * This is the SINGLE point where these signals are combined. All four
 * runtime sites and the orchestrator's relay-derivation site call it.
 */
export function isMemoryEnabledFor(inputs: MemoryGateInputs): boolean {
  if (inputs.userConfig.memory.enabled === false) return false;
  if (!inputs.persona && !inputs.job) return false;
  if (inputs.persona?.memory?.enabled === false) return false;
  if (inputs.job?.memory?.enabled === false) return false;
  return true;
}
```

### 4.2 Loader-friendly variant for the orchestrator

The orchestrator only has persona *names* in scope at relay-derivation
time, not loaded definitions. To avoid scattering `loadPersona` calls,
expose a thin loader-aware wrapper. **It must live on the `persona/`
side of the boundary** — placing it next to `isMemoryEnabledFor` in
`src/memory/memory-policy.ts` would require a runtime
`memory/memory-policy.ts → persona/resolve.ts` import, which closes the
`memory/ → persona/ → memory/` cycle described in §4.1.

#### `src/persona/memory-gate.ts` — new file, loader-aware wrapper

```ts
// src/persona/memory-gate.ts
import type { ResolvedUserConfig } from '../config/user-config.js';
import { isMemoryEnabledFor } from '../memory/memory-policy.js';
import { loadPersona } from './resolve.js';
import { createPersonaName, type PersonaDefinition } from './types.js';

/**
 * Convenience: loads the persona definition by name and runs the gate.
 * Returns false if the persona file cannot be read (fail closed — the
 * orchestrator should not spawn a relay for a persona it cannot load).
 *
 * Lives in `src/persona/` (not `src/memory/`) to avoid a
 * `memory/ → persona/ → memory/` import cycle.
 */
export function isMemoryEnabledForPersonaName(
  name: string,
  userConfig: ResolvedUserConfig,
): boolean {
  if (userConfig.memory.enabled === false) return false;
  let persona: PersonaDefinition;
  try {
    persona = loadPersona(createPersonaName(name));
  } catch {
    return false;
  }
  return isMemoryEnabledFor({ persona, userConfig });
}
```

Callers that already have a loaded `PersonaDefinition` / `JobDefinition`
in hand (the four `session/index.ts` and `docker/pty-session.ts` sites)
import the pure helper from `src/memory/memory-policy.js`. The
orchestrator (§5 site F) imports the loader-aware wrapper from
`src/persona/memory-gate.js`.

The auto-save check (`shouldAutoSaveMemory` in `src/memory/auto-save.ts:27-29`)
also uses the global flag and should be updated to call
`isMemoryEnabledFor(...) && config.userConfig.memory.autoSave`. The
helper assumes the caller already knows the persona/job; auto-save
runs after `createSession`, so the scope is known via `SessionOptions`
or its persisted snapshot. (See §5 site E.)

## 5. Call-site changes

All five sites must call the helper. File-line references reflect the
state of `master` at design time; implementer should re-grep before
editing.

### Site A — `src/session/index.ts:467-468` (persona system prompt)

**Old:**
```ts
const memoryEnabled = config.userConfig.memory.enabled;
const personaAugmentation = buildPersonaSystemPromptAugmentation(resolved.persona, memoryEnabled);
```

**New:**
```ts
const memoryEnabled = isMemoryEnabledFor({
  persona: resolved.persona,
  userConfig: config.userConfig,
});
const personaAugmentation = buildPersonaSystemPromptAugmentation(resolved.persona, memoryEnabled);
```

Behavior change: when a persona has `memory.enabled: false`, the
persona augmentation no longer includes the memory system prompt
fragment. Default-shape personas (`memory` absent) behave identically
to today.

### Site B — `src/session/index.ts:583-608` (bolt-on + cron-job prompt)

`resolved` is currently scoped *inside* the `if (opts.persona)` block
at `session/index.ts:454` (verified). Site B (lines 583-608) runs
outside that block, so the persona definition is unreachable from the
new code unless we hoist it. The hoist must be made explicit:

**Hoist (near the top of the function, before line 454):**
```ts
// Hoist so the persona definition is in scope for site B (memory gate).
let personaDef: PersonaDefinition | undefined = undefined;
```

**Modified site at line 454 (assign into the hoisted binding):**
```ts
if (opts.persona) {
  const resolved = resolvePersona(opts.persona);
  personaDef = resolved.persona;          // NEW: capture for site B
  if (policyDir) {
    logger.warn('Both persona and policyDir specified; using persona.');
  }
  policyDir = resolved.policyDir;
  serverAllowlist = resolved.persona.servers;

  if (!workspacePath) {
    workspacePath = resolved.workspacePath;
  }

  // (Site A — see above) Build persona system prompt augmentation.
  const memoryEnabled = isMemoryEnabledFor({
    persona: resolved.persona,
    userConfig: config.userConfig,
  });
  const personaAugmentation = buildPersonaSystemPromptAugmentation(resolved.persona, memoryEnabled);
  // ... existing prepend logic ...
}
```

**Old (lines 583-608):**
```ts
const memoryConfig = config.userConfig.memory;
if (memoryConfig.enabled && (opts.persona || opts.jobId)) {
  // ... inject MEMORY_SERVER_NAME, build dbPath, mkdir, set mcpServers
  if (!opts.persona) {
    const memoryPrompt = adaptMemoryToolNames(buildMemorySystemPrompt());
    systemPromptAugmentation = systemPromptAugmentation
      ? `${memoryPrompt}\n\n${systemPromptAugmentation}`
      : memoryPrompt;
  }
}
```

**New (lines 583-608):**
```ts
// Resolve per-scope memory enablement. Persona was loaded above and
// captured into `personaDef`; load job lazily by id (most CLI sessions
// have no job).
const job = opts.jobId ? loadJob(createJobId(opts.jobId)) ?? undefined : undefined;
const memoryEnabled = isMemoryEnabledFor({
  persona: personaDef,
  job,
  userConfig: config.userConfig,
});

if (memoryEnabled) {
  // (unchanged: build dbPath, mkdir, sessionConfig.mcpServers[MEMORY_SERVER_NAME] = ...)
  if (!opts.persona) {
    const memoryPrompt = adaptMemoryToolNames(buildMemorySystemPrompt());
    systemPromptAugmentation = systemPromptAugmentation
      ? `${memoryPrompt}\n\n${systemPromptAugmentation}`
      : memoryPrompt;
  }
}
```

Notes:
- The hoist is the recommended shape — it has zero behavior change for
  the persona branch and lets site B read the loaded definition without
  reloading from disk.
- `loadJob` is imported from `src/cron/job-store.js`. Verified sync at
  `src/cron/job-store.ts:26` (returns `JobDefinition | undefined`); the
  added import is straightforward.
- `loadPersona` is similarly sync (`src/persona/resolve.ts:82`); no
  async restructuring is needed anywhere in this design.

### Site C — `src/session/index.ts:297-300` (Docker session CLAUDE.md)

`createDockerSession` does not have a loaded persona/job at this point,
only `options.persona: string | undefined` and `options.jobId: string | undefined`.
Two clean options:

1. **Resolve here.** Load persona/job and call `isMemoryEnabledFor`.
   Adds disk reads inline; symmetry with site B but duplicated work.
2. **Pre-resolve once and pass through.** Compute `memoryEnabled` once
   in a shared early-stage helper used by both `createDockerSession`
   and `buildSessionConfig`.

Recommendation: **option 2.** Add a tiny pre-resolve step:

```ts
// In createDockerSession, before buildDockerClaudeMd:
const personaDef = options.persona
  ? loadPersona(createPersonaName(options.persona))
  : undefined;
const jobDef = options.jobId
  ? loadJob(createJobId(options.jobId)) ?? undefined
  : undefined;
const memoryEnabled = isMemoryEnabledFor({
  persona: personaDef,
  job: jobDef,
  userConfig: config.userConfig,
});

const claudeMdContent = buildDockerClaudeMd({
  personaName: options.persona,
  memoryEnabled,
});
```

`buildSessionConfig` is called *after* this, but we cannot easily pass
the resolved boolean through (it would mean threading a new arg
through `SessionOptions`). Instead, the helper is cheap (no I/O once
the persona/job def is in hand), so call it again inside
`buildSessionConfig`. Both sites must agree because they call the same
pure function with the same inputs.

(Alternative if the duplicate `loadPersona` / `loadJob` is judged
expensive: cache on a per-session struct passed via a new optional
`SessionOptions.preloadedPersona` / `preloadedJob`. Skip until measured.)

### Site D — `src/docker/pty-session.ts:255-258` (PTY CLAUDE.md)

Identical to Site C. The PTY session path also takes `options.persona`
/ `options.jobId` and constructs CLAUDE.md before `buildSessionConfig`.
Apply the same pattern: load `personaDef` / `jobDef`, call
`isMemoryEnabledFor`, pass the boolean to `buildDockerClaudeMd`.

### Site E — `src/memory/auto-save.ts:27-29` (auto-save guard)

**Old:**
```ts
export function shouldAutoSaveMemory(config: IronCurtainConfig): boolean {
  return config.userConfig.memory.enabled && config.userConfig.memory.autoSave;
}
```

**New:**
```ts
export function shouldAutoSaveMemory(
  config: IronCurtainConfig,
  scope: { persona?: PersonaDefinition; job?: JobDefinition },
): boolean {
  if (!isMemoryEnabledFor({ ...scope, userConfig: config.userConfig })) return false;
  return config.userConfig.memory.autoSave;
}
```

Callers must pass scope. The five known callers are (verified at
design time):

| # | File:line | Caller scope and update strategy |
|---|-----------|---------------------------------|
| 1 | `src/index.ts:171` | CLI standalone path. Has `personaName: string \| undefined` in scope. Load with `loadPersona(createPersonaName(personaName))` if defined; pass `{ persona }`. No job in this path. |
| 2 | `src/daemon/ironcurtain-daemon.ts:499` | Cron-job session start. Has `job: JobDefinition` already loaded above (line ~487 builds `patchedConfig` from `job`). Pass `{ job }` directly. |
| 3 | `src/signal/signal-bot-daemon.ts:495` | Signal bot session start. Has `persona: string \| undefined` in scope; load with `loadPersona(createPersonaName(persona))` if defined. No job in this path. |
| 4 | `src/web-ui/dispatch/session-dispatch.ts:134` | Web UI session start. Has `persona: string \| undefined`; same pattern as the Signal callsite. |
| 5 | `src/web-ui/__tests__/json-rpc-dispatch.test.ts:51` | Test mock (`vi.fn().mockReturnValue(false)`). Update the mock to accept the new second argument; the existing `mockReturnValue(false)` works regardless of args. |

For sessions that have outlived their `SessionOptions` and only have a
`SessionMetadata` snapshot (`src/session/session-metadata.ts`), reload
the persona/job from disk using the metadata's `personaName` /
`jobId` fields. None of the five sites identified above need this
fallback — they all run at session-creation time, where the original
options are still in scope.

### Site F — `src/workflow/orchestrator.ts:700-715` (relay derivation)

**Old:**
```ts
private getRequiredServersForScope(instance, scope) {
  const union = new Set<string>();
  // ... iterate persona states, union extractRequiredServers
  return union;
}
```

**New:**
```ts
// Import the loader-aware wrapper from persona/, NOT memory/, to avoid
// an import cycle (see §4.2).
import { isMemoryEnabledForPersonaName } from '../persona/memory-gate.js';

private getRequiredServersForScope(instance, scope) {
  const union = new Set<string>();
  const seenPersonas = new Set<string>();
  let anyPersonaWantsMemory = false;
  for (const stateConfig of Object.values(instance.definition.states)) {
    if (stateConfig.type !== 'agent') continue;
    const stateScope = stateConfig.containerScope ?? DEFAULT_CONTAINER_SCOPE;
    if (stateScope !== scope) continue;
    if (seenPersonas.has(stateConfig.persona)) continue;
    seenPersonas.add(stateConfig.persona);
    const { compiledPolicy } = loadPersonaPolicyArtifacts(
      this.getPolicyDir(instance, stateConfig.persona),
    );
    for (const server of extractRequiredServers(compiledPolicy)) {
      union.add(server);
    }
    // Memory is bolt-on (not in compiled policy). Mint the relay if
    // ANY persona in this scope opts in.
    if (isMemoryEnabledForPersonaName(stateConfig.persona, this.deps.userConfig)) {
      anyPersonaWantsMemory = true;
    }
  }
  if (anyPersonaWantsMemory) union.add(MEMORY_SERVER_NAME);
  return union;
}
```

This closes the relay-spawning gap. The bundle is now minted with
`memory` if any persona in the scope wants it; the per-state policy
swap (`cyclePolicy`) does not need to add memory because it does not
add servers (it only ever uses the minted-server set), and the bolt-on
in `buildSessionConfig` will set `sessionConfig.mcpServers[MEMORY_SERVER_NAME]`
for each state that opts in.

#### Orchestrator dependency wiring

`WorkflowOrchestratorDeps` at **`src/workflow/orchestrator.ts:235-291`**
does **not** currently hold `userConfig`. (Verified: the deps interface
contains `createSession`, `createWorkflowTab`, `raiseGate`,
`dismissGate`, `baseDir`, `checkpointStore`, plus optional Docker /
control-plane hooks. There is no `userConfig` or `config` field today.)
This is a non-trivial change that expands the implementation surface;
the review estimated **~2-day diff rather than 1-day**.

**Schema change (one location):**

Add to `WorkflowOrchestratorDeps` at `src/workflow/orchestrator.ts:235-291`:

```ts
import type { ResolvedUserConfig } from '../config/user-config.js';

export interface WorkflowOrchestratorDeps {
  // ... existing fields ...

  /**
   * Resolved user config. Consulted by `getRequiredServersForScope` to
   * decide whether to mint the memory relay for a shared-container
   * bundle (memory is opt-in per persona; see
   * docs/designs/per-persona-memory-optin.md).
   */
  readonly userConfig: ResolvedUserConfig;
}
```

The orchestrator reads `this.deps.userConfig` (the existing class
already stores `deps`); no separate field on the class is required.

**Production callers that construct `WorkflowOrchestrator` (4 sites; verified by grep):**

| # | File:line | Notes |
|---|-----------|-------|
| 1 | `src/workflow/workflow-command.ts:252` | CLI `workflow start`. Currently builds a `WorkflowOrchestratorDeps` literal at lines 243-250 with no config access. Add `import { loadConfig } from '../config/index.js'` (or `loadUserConfig` from `../config/user-config.js`) and call it once before building deps; pass `userConfig: config.userConfig` (or the resolved value directly). |
| 2 | `src/workflow/workflow-command.ts:355` | CLI `workflow resume`. Same pattern as above (deps literal at 346-353). |
| 3 | `src/web-ui/workflow-manager.ts:319` | Web UI workflow manager. Deps literal at lines ~301-317; same pattern. The web-ui daemon already loads config elsewhere; thread it into `WorkflowManager` via constructor or load it directly here. |
| 4 | `examples/workflow-real-spike.ts:165` | Example / smoke-test script. Deps literal at lines 156-163; same pattern. Low-risk to update. |

**Test fixtures (1 fixture, 14 test files):**

All orchestrator tests share the helper `createDeps` at
**`test/workflow/test-helpers.ts:253-271`**, which builds a
`WorkflowOrchestratorDeps` with sensible defaults and accepts a
`Partial<WorkflowOrchestratorDeps>` overrides argument. Every test file
under `test/workflow/orchestrator*.test.ts` (10 files) plus
`test/workflow/model-selection.test.ts`, `test/workflow/spike.test.ts`,
and `test/workflow/verdict-validation.test.ts` (14 files total)
constructs orchestrators via this helper.

**This is a one-fixture-helper edit, not 14 file edits.** Add a
`userConfig` field to the helper's defaults — e.g., import a
`makeTestUserConfig()` builder (or reuse one from
`test/test-helpers/`) — and every test fixture inherits the value.
Tests that need to assert on memory-gate behavior can override via
the existing `overrides` argument.

```ts
// test/workflow/test-helpers.ts:253 — updated createDeps
export function createDeps(
  tmpDir: string,
  overrides: Partial<WorkflowOrchestratorDeps> = {},
): WorkflowOrchestratorDeps {
  return {
    createSession: vi.fn(async () => new MockSession({ responses: [] })),
    createWorkflowTab: vi.fn(() => createMockTab()),
    raiseGate: vi.fn(),
    dismissGate: vi.fn(),
    baseDir: tmpDir,
    checkpointStore: createCheckpointStore(tmpDir),
    userConfig: makeTestUserConfig(),     // NEW: default to memory-on
    startWorkflowControlServer: async () => {},
    loadPolicyRpc: async () => {},
    ...overrides,
  };
}
```

Two test files construct `WorkflowOrchestrator` *without* going through
`createDeps` (verified by grep): `model-selection.test.ts` (lines 208,
594) and `orchestrator-shared-container.test.ts` (line 173). These
build deps inline and will need a one-line edit each. Everything else
flows through `createDeps`.

**Effort note:** the schema change is one line, but the wiring
(four production callsites loading config, plus the test-helper
update) is a meaningful expansion of the implementation footprint. See
also §11 for the resolved-question note.

## 6. CLI onboarding

The CLI uses `@clack/prompts` consistently across both flows. Match
existing prompt style: `p.confirm` with `initialValue: true` for
default-on, `p.log.info` for inline confirmations, `p.isCancel` for
escape handling.

### 6.1 `ironcurtain persona create <name>`

File: `src/persona/persona-command.ts`, function `runCreate` starts
near line 158. Existing prompt order (after `parseArgs`):
1. Description (line ~187)
2. Server allowlist (line ~210)
3. *(persona dir created, persona.json written, line ~242)*
4. Constitution authoring (line ~250)

**Insert new step between (2) and (3)**, before persona.json is
written. The block ordering is intentional — persona.json should
record the user's memory choice on first write.

```ts
// 3. Memory opt-in (between Server allowlist and persona.json write)
const enableMemory = await p.confirm({
  message: 'Enable persistent memory for this persona?',
  initialValue: true,
});
if (p.isCancel(enableMemory)) {
  p.cancel('Cancelled.');
  process.exit(0);
}
```

Then in the existing `personaDef` literal:
```ts
const personaDef: PersonaDefinition = {
  name,
  description,
  createdAt: new Date().toISOString(),
  ...(servers ? { servers } : {}),
  ...(enableMemory === false ? { memory: { enabled: false } } : {}),
};
```

File-write behavior:
- User accepts default (`enableMemory === true`) → no `memory` field
  written. Future readers default to "on", surviving config-format
  upgrades unchanged.
- User declines (`enableMemory === false`) → `"memory": { "enabled": false }`
  is written explicitly.

Recommendation: do not provide a CLI flag (`--memory / --no-memory`) in
the first cut. The TUI is the canonical surface. Add the flag later
only if we get scripted-creation requests.

### 6.2 `ironcurtain persona edit <name>`

File: `src/persona/persona-command.ts`, function `runEdit` starts at
line 349. Today this prompt only chooses between three constitution
edit modes (`customize / editor / generate`) and offers compilation
afterward. There is no review-loop UX for top-level persona fields
(servers, memory) at edit time.

**Recommendation: minimal addition, not a redesign.** Add a
`select` option to the top-level menu so users can toggle memory
without touching the constitution:

```ts
const editAction = await p.select({
  message: 'How would you like to edit the persona?',
  options: [
    { value: 'customize' as const, label: 'Customize constitution interactively (LLM-assisted)' },
    { value: 'editor' as const, label: 'Edit constitution in $EDITOR' },
    { value: 'generate' as const, label: 'Generate new constitution from description' },
    { value: 'memory' as const, label: 'Toggle persistent memory' },  // NEW
  ],
});
```

Add a `case 'memory'` branch. Use a destructure-omission pattern
instead of a `memory: undefined` spread, so the snippet stays
typecheck-clean if `exactOptionalPropertyTypes` is ever enabled in
`tsconfig.json` (verified absent today, but cheap to be defensive):

```ts
} else if (editAction === 'memory') {
  const currentEnabled = persona.memory?.enabled ?? true;
  const newEnabled = await p.confirm({
    message: 'Enable persistent memory for this persona?',
    initialValue: currentEnabled,
  });
  if (p.isCancel(newEnabled)) {
    p.cancel('Cancelled.');
    return;
  }
  if (newEnabled === currentEnabled) {
    p.outro('No change.');
    return;
  }
  // Destructure-omit `memory` so we can either re-attach it (off case)
  // or drop it entirely (on case). Using `memory: undefined` in a
  // spread literal would not typecheck under exactOptionalPropertyTypes.
  const { memory: _omit, ...rest } = persona;
  const updated: PersonaDefinition =
    newEnabled === false ? { ...rest, memory: { enabled: false } } : rest;
  writeFileSync(getPersonaDefinitionPath(name), JSON.stringify(updated, null, 2) + '\n');
  p.outro(`Memory ${newEnabled ? 'enabled' : 'disabled'} for persona "${name}".`);
  return;
}
```

No `stripUndefined` helper is needed because the destructure pattern
never produces an `undefined` value for `memory` — either the key is
present with a real object, or it is omitted from the type. No
constitution recompilation is needed; memory is not a policy input.

### 6.3 `ironcurtain daemon add-job` and `edit-job`

File: `src/cron/job-commands.ts`, function `runJobReviewLoop` starts at
line 56. This flow uses a review-loop pattern: the user sees a summary
note, picks a field to edit, and loops until "Confirm". Today the
fields are: ID, name, schedule, gitRepo, taskDescription,
taskConstitution (+ generate/customize), notify.

**Insert "Memory" as a new top-level field in the review loop.** Both
the summary note (lines 134-149) and the `select` menu (lines 152-172)
need an entry:

Summary note line additions:
```ts
const memoryStr = job.memory?.enabled === false ? 'off' : 'on (default)';
note(
  [
    `ID:        ${job.id}`,
    // ... existing lines ...
    `Notify:    ${notifyStr}`,
    `Memory:    ${memoryStr}`,           // NEW
    ``,
    // ...
  ].join('\n'),
  isNew ? 'New job' : 'Edit job',
);
```

Select-menu line:
```ts
{ value: 'memory', label: `Edit memory          ${memoryStr}` },  // NEW, near 'notify'
```

New case branch (next to `case 'notify':`). Same destructure-omission
pattern as §6.2 — avoids `memory: undefined` in an object spread:

```ts
case 'memory': {
  const currentEnabled = job.memory?.enabled !== false;
  const enabled = await confirm({
    message: 'Enable persistent memory for this job?',
    initialValue: currentEnabled,
  });
  if (isCancel(enabled)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  const { memory: _omit, ...rest } = job;
  job = enabled === false ? { ...rest, memory: { enabled: false } } : rest;
  break;
}
```

No special handling needed in `saveJob` — the destructure produces a
job object with the `memory` key either present or absent, never
`undefined`. `JSON.stringify` will simply not emit absent keys.

### 6.4 `ironcurtain config` (kill-switch surface)

File: `src/config/config-command.ts`, function `handleMemory` at line
350. Today the Memory submenu only exposes `autoSave`. **Add the
global `enabled` field above it** so the kill switch is discoverable:

```ts
const field = await p.select({
  message: 'Memory',
  options: [
    {
      value: 'enabled',
      label: 'Enabled (kill switch — affects all personas/jobs)',
      hint: (pending.memory?.enabled ?? resolved.memory.enabled) ? 'on' : 'off',
    },
    {
      value: 'autoSave',
      label: 'Auto-save session summary to memory',
      hint: currentAutoSave ? 'on' : 'off',
    },
    { value: 'back', label: 'Back' },
  ],
});
```

Add a case:
```ts
if (field === 'enabled') {
  const currentEnabled = pending.memory?.enabled ?? resolved.memory.enabled;
  const enabled = await p.confirm({
    message: 'Enable memory globally? (turning this off disables memory for all personas and jobs)',
    initialValue: currentEnabled,
  });
  if (isCancelled(enabled)) continue;
  if (enabled !== currentEnabled) {
    pending.memory = { ...pending.memory, enabled: enabled as boolean };
  }
}
```

Update `memoryHint` (line 865) to surface both fields:
```ts
function memoryHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const enabled = pending.memory?.enabled ?? resolved.memory.enabled;
  const autoSave = pending.memory?.autoSave ?? resolved.memory.autoSave;
  if (!enabled) return 'off (kill switch)';
  return `on, auto-save: ${autoSave ? 'on' : 'off'}`;
}
```

### 6.5 First-start wizard

File: `src/config/first-start.ts`. Today there is no memory step; the
note at line 237-239 mentions personas have "persistent memory" as a
feature.

**Recommendation: do not add a memory prompt to first-start.** First-start
is intentionally short, and the natural moment to choose memory is at
persona/job creation. Mention the kill switch only in the
"Customization" note (line 231) so users discover it via `ironcurtain config`.

Suggested note tweak:
```
'  ironcurtain config             — change models, resource limits, memory, etc.\n'
```

### 6.6 Web UI

`src/web-ui/dispatch/persona-dispatch.ts` is currently read-only for
personas (no create/edit RPCs). No web UI changes needed in this
iteration. When persona create/edit is added to the web UI later, it
must surface the memory toggle alongside the description/servers
fields.

## 7. Migration

- **Existing persona.json files without `memory`**: behave as today
  (memory on if globally on). No migration script.
- **Existing job.json files without `memory`**: behave as today
  (memory on if globally on). No migration script.
- **Existing `userConfig.memory.enabled: false`**: continues to disable
  memory globally. This is the kill switch.
- **Default case (everything absent)**: identical behavior to today.

The only behavior change for default-shape configs is the **closing of
the workflow shared-container relay-spawning gap** (§1.2). Previously
in shared-container mode, `memory.enabled: true` did *not* actually
spawn the relay; now it will. Calling this out in release notes is
recommended because workflow runs on shared containers will start
seeing memory tools where they didn't before.

There is no schema-version bump; both `PersonaDefinition` and
`JobDefinition` extensions are additive optional fields, and Zod (for
user-config) is already lenient about unknown / missing fields.

## 8. `ALWAYS_INCLUDED_SERVERS` cleanup

**Recommendation: remove `MEMORY_SERVER_NAME` from
`ALWAYS_INCLUDED_SERVERS` in `src/persona/resolve.ts:17`.** The set
becomes `new Set(['filesystem'])`.

Rationale:
- Memory is now an explicit per-persona opt-in, not a structural
  always-on. Keeping it in this set bypasses the user's stated choice
  and re-introduces the leak symptoms.
- The bolt-on at `session/index.ts:586` (gated by `isMemoryEnabledFor`)
  is the single, clear insertion point for the memory server.
- `applyServerAllowlist` runs before the bolt-on. If the persona has a
  `serverAllowlist` that omits `memory` AND `memory.enabled: true`,
  the bolt-on still re-injects it because the bolt-on writes to the
  same `sessionConfig.mcpServers` map after the allowlist filter. The
  control flow becomes: allowlist filters → policy filter → bolt-on.
- `verifyMemoryServerConfig` (referenced by tests at `memory-integration.test.ts:111`)
  asserts only the *shape* of the memory server config when present,
  so it is unaffected.

The test `applyServerAllowlist always includes memory` at
`memory-integration.test.ts:155-170` is now misnamed; rename it to
`applyServerAllowlist always includes filesystem` and drop the memory
case (or assert that memory is NOT included by allowlist filtering and
that the bolt-on is responsible).

## 9. Test plan

New tests live alongside existing ones. Vitest patterns are uniform
across this repo.

### 9.1 New unit tests: `test/memory-policy.test.ts`

Cover the helper exhaustively:

- `isMemoryEnabledFor` returns false when `userConfig.memory.enabled === false`,
  even with persona/job set.
- Returns false when neither persona nor job is set.
- Returns false when `persona.memory.enabled === false`.
- Returns false when `job.memory.enabled === false`.
- Returns true when persona is set and persona.memory is absent.
- Returns true when persona is set and persona.memory.enabled is true.
- Returns true when job is set and job.memory is absent.
- Returns true when both persona and job are set, neither opting out.
- Returns false when both are set and either opts out (most-restrictive wins).
- `isMemoryEnabledForPersonaName` returns false when persona file is missing
  (fail closed).

### 9.2 Updates to `test/memory-integration.test.ts`

- Rename the `applyServerAllowlist always includes memory` describe
  block to `applyServerAllowlist always includes filesystem`. Remove
  the memory-specific cases; add an assertion that memory is NOT in
  the filtered map.

### 9.3 New session integration tests: `test/session-memory-gate.test.ts`

Build minimal session configs and assert the `sessionConfig.mcpServers`
shape and the `systemPromptAugmentation` content. Use existing test
fixtures from `test/persona-session.test.ts` as a template.

- Persona session, persona has `memory.enabled: false`:
  - `sessionConfig.mcpServers` does NOT contain `memory`.
  - System prompt does NOT contain memory tool guidance.
  - `buildDockerClaudeMd` returns `undefined`.
- Persona session, default persona (no `memory` field):
  - Memory server is present.
  - System prompt contains memory tool guidance.
  - `buildDockerClaudeMd` returns the expected pre-response protocol.
- Cron-job session, default job (no `memory` field):
  - Memory server is present.
  - System prompt contains the memory prompt prepended (non-persona path).
- Default session (no persona, no job):
  - Memory server is NOT present, regardless of `userConfig.memory.enabled`.
  - System prompt does NOT contain memory tool guidance.
  - `buildDockerClaudeMd` returns `undefined`.
- Global kill switch overrides per-persona "on":
  - `userConfig.memory.enabled = false` and persona has no memory field → off.

### 9.4 New workflow orchestrator test (extension to existing)

`test/workflow-orchestrator.test.ts` does **not** exist; orchestrator
tests live under `test/workflow/orchestrator*.test.ts` (10 files).
Add the new cases to **`test/workflow/orchestrator-shared-container.test.ts`**,
which is the file that already exercises shared-container relay
spawning (and thus the path through `getRequiredServersForScope`).
Build the test deps via the shared `createDeps` helper at
`test/workflow/test-helpers.ts:253`, overriding `userConfig` per case
to drive the memory-gate decision.

- Workflow with one persona in scope that has `memory.enabled: false`:
  required servers does NOT include `memory`.
- Workflow with one persona in scope (default config): required
  servers includes `memory`.
- Workflow with two personas in scope, one opting out and one not:
  required servers includes `memory` (any-persona-wants-it semantics).
- Workflow with all personas opting out: required servers does NOT
  include `memory`.
- Workflow with `userConfig.memory.enabled === false` (kill switch):
  required servers does NOT include `memory`, regardless of per-persona
  state.

### 9.5 CLI smoke tests

`test/persona-create-cli.test.ts` (new): end-to-end exercise of the
new prompt step using `@clack/prompts` mocks. Assert that:

- Accepting the default writes a persona.json without a `memory` field.
- Declining writes `"memory": { "enabled": false }`.

`test/job-commands.test.ts` (extension if it exists): same coverage for
`runJobReviewLoop`.

## 10. Doc updates

| File | What to update |
|------|----------------|
| `CLAUDE.md` (top level) | Add a brief note in "Configuration" or "Onboarding a New MCP Server" section pointing at the memory opt-in: "Memory is enabled per-persona / per-job; toggle during creation or via `ironcurtain persona edit` / `daemon edit-job`. Global kill switch is `ironcurtain config → Memory → Enabled`." |
| `src/trusted-process/CLAUDE.md` | No change required — trusted process does not gate memory. |
| `docs/designs/memory-mcp-server.md` (if exists) | Add a "Per-persona / per-job opt-in (2026)" section linking to this doc. |
| `docs/designs/per-persona-memory-optin.md` | This document. |
| Release notes | Call out the workflow-shared-container behavior change (§7): default-shape configs in shared-container mode will start spawning the memory relay where they previously did not. |

`grep -rn "memory.enabled" docs/` to find any other prose references
that need updating.

## 11. Open questions / follow-ups

1. **Should `auto-save` be inferred from the per-persona memory flag?**
   Today `userConfig.memory.autoSave` is global. A persona that opts
   *out* of memory cannot meaningfully auto-save. The helper change in
   §5 (Site E) handles this correctly (no save when memory is off),
   but the user might want `personaDef.memory.autoSave?: boolean` for
   per-persona auto-save toggling. **Defer to follow-up** unless the
   user asks. The schema is forward-compatible: it can be added to
   `PersonaMemoryConfig` later.

2. **Should the persona TUI surface the global kill switch state?**
   If a user sets `userConfig.memory.enabled: false`, then runs
   `ironcurtain persona create` and answers "Yes" to the per-persona
   prompt, the per-persona setting is moot. The TUI could detect this
   and warn ("Note: memory is currently disabled globally — your
   choice will apply if you re-enable it later"). **Recommend
   implementing this warning** because the surprise-cost is low; not
   blocking, but the implementer should add it during persona-create.

3. **Should there be a CLI flag (`--no-memory`) for persona/job
   creation?** Useful for scripted creation; not strictly required for
   v1. Defer until a user asks.

4. **Web UI memory toggle.** Out of scope for this design (the web UI
   has no persona create/edit yet). Future work: when web-UI persona
   editing lands, surface a toggle alongside description/servers.

5. **Should the auto-save guard signature change be exported as a
   typed scope helper?** `shouldAutoSaveMemory` would benefit from a
   `SessionScope` discriminated union (`{ kind: 'persona'; def: PersonaDefinition } | { kind: 'job'; def: JobDefinition } | { kind: 'default' }`)
   that encodes the invariant "exactly one of persona / job / neither"
   in the type system. **Defer**: useful but a separate refactor; the
   `MemoryGateInputs` shape with two optionals is fine for v1 because
   the helper handles all four combinations correctly.

6. **Should the orchestrator log a structured diagnostic when a
   persona's memory opt-out causes the relay to be omitted?** Useful
   for debugging "why is memory not present" in shared-container
   workflows. Cheap to add. **Recommend yes**, via the existing
   diagnostic event channel.

### 11.1 Resolved during review (2026-04-28)

- **Q7 (loadJob/loadPersona sync?)**: Both are sync.
  - `loadJob` at `src/cron/job-store.ts:26` returns
    `JobDefinition | undefined` synchronously.
  - `loadPersona` at `src/persona/resolve.ts:82` returns
    `PersonaDefinition` synchronously (throws on missing file).
  - No async restructuring is required for site B. `buildSessionConfig`
    can call both directly.

- **Import-cycle concern (§4.2)**: Resolved by splitting the helper.
  `isMemoryEnabledFor` (pure-data) lives in `src/memory/memory-policy.ts`;
  `isMemoryEnabledForPersonaName` (loader-aware) lives in a new file
  `src/persona/memory-gate.ts`. See §4.2.

- **Orchestrator deps (§5 site F)**: `WorkflowOrchestratorDeps` does
  not currently hold `userConfig` (verified at
  `src/workflow/orchestrator.ts:235-291`). Four production callers and
  one shared test helper need updates; itemized in §5 site F under
  "Orchestrator dependency wiring." Implementation effort revised from
  ~1 day to ~2 days to reflect the wiring expansion.
