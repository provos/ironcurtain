# Parallel Server Compilation

## Overview

`compileAllServers()` in `pipeline-runner.ts:610-682` processes servers sequentially in a `for` loop. Per the performance investigation (`compile-policy-performance.md`), all 5 exec-assistant servers are independent -- their compilation, scenario generation, and verification have no cross-server dependencies. Sequential execution means total time = sum of all servers (~16.4 min). Parallel execution would reduce this to time of slowest server (~7 min for git).

This document designs the parallelization of `compileAllServers()` with options for each design choice.

## Identified Concurrency Hazards

Before discussing options, these are the shared-mutable-state issues that any solution must address:

1. **`logContext.stepName`** -- `PipelineRunner` holds a single `LlmLogContext` with a mutable `stepName` field. All servers write to it (e.g., `compile-git`, `verify-fetch`) and it feeds into the LLM logging middleware. Concurrent writes would produce garbled log entries.

2. **`ora` spinners** -- `withSpinner()` in `pipeline-shared.ts` creates `ora` spinners that write to `process.stderr`. Multiple concurrent `ora` spinners overwrite each other's terminal lines because `ora` uses `\r` cursor-return to update in place. This produces unreadable output.

3. **`console.error()` interleaving** -- `compileServer()` uses `console.error()` for status messages (e.g., `[1/5] Compiling server: filesystem`, repair warnings). Concurrent servers would interleave these arbitrarily.

4. **LLM log file** -- The JSONL logger appends to a shared `llm-interactions.jsonl` file. Concurrent `appendFileSync` calls are safe at the OS level (atomic for small writes on most platforms), but `stepName` corruption (hazard #1) would make entries misleading.

---

## Decision 1: Concurrency Strategy

### Option A: `Promise.allSettled` with no concurrency limit (recommended)

Run all servers concurrently via `Promise.allSettled(filteredEntries.map(...))`. Each server gets its own `compileServer()` call. `allSettled` naturally handles partial failures -- all servers run to completion regardless of individual failures.

**Pros:**
- Simplest implementation -- replaces the `for` loop with a single `map` + `allSettled`
- Maximum parallelism for wall-clock time reduction
- `allSettled` gives per-server `{status, value/reason}` results without try/catch per entry
- No new dependencies

**Cons:**
- All servers hit the LLM API simultaneously (5 servers x multiple calls each)
- For providers with strict rate limits, could trigger 429s
- Typical exec-assistant has 5 servers; this is fine. A persona with 20+ servers might overwhelm the API.

### Option B: Concurrency-limited pool via `p-limit`

Use `p-limit(N)` to cap concurrent server compilations. Default N=3, configurable.

**Pros:**
- Protects against API rate limits
- Predictable resource usage
- `p-limit` is a tiny, well-established ESM package (zero dependencies)

**Cons:**
- New dependency (though very small)
- Requires choosing a default concurrency value
- For the common case (5 servers), the difference between N=3 and N=5 is small -- only the last 2 servers wait for a slot

### Option C: Sequential with opt-in parallelism (`--parallel` flag)

Keep the current sequential loop as default. Add a `--parallel [N]` CLI flag to enable concurrency.

**Pros:**
- Zero risk to existing behavior
- Users with rate-limit concerns stay on the safe path
- Progressive adoption

**Cons:**
- Most users won't discover the flag and will keep suffering slow builds
- Two code paths to maintain
- The sequential path provides no value -- parallel is strictly better when spinners are handled

### Decision

**Option B: `p-limit` on servers.** While 5 servers is fine unbounded, the server count will grow to 20-30 over time. A server-level `p-limit` provides a coarse concurrency cap, and pairs with the global LLM semaphore (Decision 4) which handles the actual API bottleneck. Default server concurrency of 5-10 keeps resource usage predictable without sacrificing much parallelism.

---

## Decision 2: CLI UI Approach

This is the most consequential design choice. The current UI uses `ora` spinners that assume sequential execution -- each spinner owns the terminal's last line.

### Option A: Multi-line status table (recommended)

Replace `ora` spinners during parallel compilation with a persistent multi-line status display. Each server gets a fixed line showing its current state. Use ANSI escape codes to update lines in place.

```
  filesystem  [compiling]    (12s)
  git         [scenarios]    (45s)   batch 3/6
  fetch       [done]         14 rules, 8 scenarios (18s)
  github      [verifying]    (32s)   round 2/3
  gworkspace  [scenarios]    (28s)   batch 1/6
```

States: `cached`, `compiling`, `lists`, `scenarios`, `verifying`, `repairing N/2`, `done`, `failed`.

Implementation: a `ParallelProgressDisplay` class that:
- Allocates N lines on stderr at the start
- Exposes `update(serverName, state, detail?)` called by each server's progress callbacks
- Uses `\x1B[{N}A` (cursor up) + `\x1B[2K` (clear line) to redraw specific lines
- On non-TTY stderr (CI, piped output), falls back to simple line-by-line logging (one line per state transition)

**Pros:**
- Clear at-a-glance view of all servers
- No interleaving -- each server has a dedicated line
- Professional UX similar to Docker Compose, Turborepo, nx
- Non-TTY fallback ensures CI compatibility

**Cons:**
- Most implementation effort (~100-150 lines for the display class)
- Must replace `withSpinner()` calls inside `compileServer` with the new progress API when running in parallel mode
- ANSI escape code handling needs care for terminal width, color support

### Option B: Per-server log prefixes

Keep `ora` spinners but prefix all output with `[serverName]`. Accept that spinners will overwrite each other, but the prefix makes it possible to follow the interleaved output.

```
  [filesystem] Compiling rules (3s)
  [git] Compiling rules (5s)
  [filesystem] Compiling rules: 14 rules (11s)
  [fetch] Compiling rules (2s)
  [git] Compiling rules: 22 rules (20s)
  ...
```

**Pros:**
- Minimal changes -- just add a prefix to existing spinner text
- Works on all terminals including non-TTY

**Cons:**
- Visually noisy and hard to follow with 5+ servers
- `ora` spinners still fight over cursor position -- the spinner animation will be broken
- Users cannot quickly see which servers are still in progress

### Option C: Suppress per-server output; show only summary

During parallel compilation, suppress all spinner output. Show a single top-level spinner: `Compiling 5 servers in parallel... (45s)`. After all complete, print a summary table.

```
  Compiling 5 servers in parallel... (127s)

  filesystem  14 rules  8 scenarios   18.2s
  git         22 rules  15 scenarios  127.4s  (2 repairs)
  fetch        4 rules  6 scenarios   14.8s
  github      18 rules  12 scenarios  42.1s
  gworkspace  28 rules  20 scenarios  95.6s
```

**Pros:**
- Very simple implementation -- one `ora` spinner + summary table
- No interleaving issues at all
- Clean output

**Cons:**
- User gets no feedback for minutes during long compilations
- Cannot tell if compilation is stuck or progressing
- No ability to see which server is in the repair loop (important diagnostic info)
- The single spinner hides whether the slowdown is one server or all of them

### Decision

**Option A** for TTY output with **Option C's summary** as the non-TTY fallback. The multi-line display is the right UX for an operation that takes minutes, especially as server count grows to 20-30. The implementation cost is moderate and self-contained in a single new class.

The key interface change: `compileServer()` currently calls `withSpinner()` directly. In parallel mode, it would instead call a `ProgressReporter` interface that the parallel orchestrator provides. The `ProgressReporter` would be backed by either the multi-line display (TTY) or line-based logging (non-TTY). In sequential mode (single server filter), `withSpinner()` continues to work as-is.

---

## Decision 3: Error Handling Strategy

### Option A: `Promise.allSettled` + aggregate report (recommended)

Use `Promise.allSettled` so all servers run to completion. Collect failures, report them at the end.

```typescript
const settled = await Promise.allSettled(
  filteredEntries.map(([name, data]) => this.compileServer(...))
);

const results: ServerCompilationResult[] = [];
const failures: Array<{ server: string; error: Error }> = [];

for (const [i, outcome] of settled.entries()) {
  if (outcome.status === 'fulfilled') {
    results.push(outcome.value);
  } else {
    failures.push({ server: filteredEntries[i][0], error: outcome.reason });
  }
}
```

**Pros:**
- One failed server never blocks another
- Complete failure report at the end
- Matches the existing pattern (current code already has `failedServers` array and continues past failures)

**Cons:**
- A server that fails early still consumed API tokens before failing
- If the first server fails for a reason that would affect all (e.g., invalid API key), we waste time on the others

### Option B: `Promise.allSettled` with shared abort signal

Same as Option A but pass a shared `AbortController` signal. If the first failure is a non-retryable error (auth failure, network down), abort remaining servers.

**Pros:**
- Fails fast on systemic errors (saves tokens and time)
- Still allows independent failures for server-specific issues (verification failure, bad scenarios)

**Cons:**
- More complex -- need to classify errors as systemic vs. server-specific
- Abort signal must be threaded through to LLM calls (AI SDK supports this)
- Risk of aborting servers that would have succeeded

### Option C: First-failure-aborts-all via `Promise.all`

Use `Promise.all` which rejects on the first failure.

**Pros:**
- Simplest error semantics

**Cons:**
- One server's verification failure kills all other in-progress compilations
- Verification failures are expected and recoverable -- aborting is wrong
- Wastes all progress from partially-complete servers

### Decision

**Option A.** It matches the existing error handling semantics exactly (`failedServers` array, continue past failures). Option B (shared abort on systemic errors) is a nice refinement to add later — the abort signal can be threaded through without changing the structure.

---

## Decision 4: Rate Limiting / Concurrency Control

### Option A: No explicit rate limiting (recommended for initial)

Let all servers hit the API concurrently. Rely on the API provider's built-in retry/backoff (AI SDK has `maxRetries` support).

**Pros:**
- Simplest implementation
- Anthropic's API handles concurrent requests well for typical workloads
- AI SDK already retries on 429 with exponential backoff

**Cons:**
- Could slow all servers down if rate-limited (backoff affects every concurrent request)
- No visibility into whether rate limiting is occurring

### Option B: Concurrency limit on LLM calls (not servers)

Instead of limiting how many servers run concurrently, limit total concurrent LLM calls across all servers. Use a shared semaphore/`p-limit` instance passed to all compilation steps.

**Pros:**
- Precise control -- limits the actual bottleneck (LLM API calls), not the coarser unit (servers)
- Allows servers to do non-LLM work (caching checks, artifact writing) without blocking
- A server in a repair loop doesn't block another server's initial compilation

**Cons:**
- Requires threading a semaphore through to every LLM call site
- Significantly more invasive change
- May not be necessary -- the API can usually handle 5-10 concurrent calls

### Option C: Per-provider token bucket

Implement a token-bucket rate limiter that respects per-provider rate limits (Anthropic: 4000 RPM, Google: varies, OpenAI: varies). Configure limits in user config.

**Pros:**
- Correct solution for heavy workloads
- Prevents 429 errors entirely

**Cons:**
- Significant implementation effort for a problem that may not exist in practice
- Rate limits vary by API tier and change over time
- Over-engineered for 5 servers making ~40 total calls

### Decision

**Option B: Global semaphore on LLM calls.** With server counts growing to 20-30, even a server-level `p-limit` of 5-10 (Decision 1) could produce 5-10 concurrent LLM calls — and this multiplies further when scenario batch parallelism is added later. A shared `p-limit` instance passed to all LLM call sites caps total concurrent API requests (e.g., default 5-8) regardless of how many servers or batches are in flight. This is the single throttle point that makes it safe to freely add more parallelism (scenario batches, list resolution) without worrying about rate limits at each call site.

The semaphore is created once in `compileAllServers()` and threaded through to `compileServer()` and into the LLM call wrappers (`generateObjectWithRepair`, scenario generation, verification). Each call site wraps its LLM invocation with `await llmSemaphore(() => llmCall(...))`. Non-LLM work (cache checks, file I/O, artifact writing) runs outside the semaphore so servers can make progress even when all LLM slots are occupied.

---

## Decision 5: Shared Mutable State Resolution

### The `logContext.stepName` problem

`PipelineRunner` has one `logContext` object. `compileServer()` mutates `logContext.stepName` at each pipeline step. With concurrent servers, these writes race.

### Option A: Per-server log context (recommended)

Create a new `LlmLogContext` per server. This requires either:
- Cloning the context object at the start of each `compileServer()` call
- Changing the LLM logging middleware to accept the step name per-call rather than reading from a shared mutable reference

The cleanest approach: give `compileServer()` its own `logContext` instance. The logger middleware already reads `stepName` at call time -- if each server has its own context, there is no race.

**Pros:**
- Correct by construction -- no shared mutable state
- Log entries accurately reflect which server each LLM call belongs to
- Minimal changes to logging middleware

**Cons:**
- Need to create a per-server `LanguageModel` wrapper (since the logging middleware is bound to a specific context at construction time in `createPipelineLlm`)

### Option B: Thread step name through call chain

Instead of mutating shared state, pass `stepName` as a parameter through each method. The logger reads it from the call context rather than a shared object.

**Pros:**
- Pure -- no shared mutable state, no per-server instances
- Makes data flow explicit

**Cons:**
- Requires changing many function signatures
- Large diff for a logging concern

### Option C: Async local storage (Node.js `AsyncLocalStorage`)

Use `AsyncLocalStorage` to scope the step name to each async context. The logger reads from the async store.

**Pros:**
- Zero changes to function signatures
- Automatic scoping to async chains

**Cons:**
- Adds complexity with a non-obvious mechanism
- AsyncLocalStorage has performance overhead
- Harder to debug when context is lost

### Decision

**Option A.** The `LlmLogContext` is tiny (just `{ stepName: string }`). Creating one per server and wrapping the model with a per-server logger middleware is straightforward. The `createPipelineLlm` function already binds the context — we just need to call it per-server (or clone the relevant binding).

### Concrete per-server model threading (Issue 1 expansion)

The decision above understated the scope of the change. `this.model` is not just a `LanguageModel` -- it is a `LanguageModel` wrapped via `wrapLanguageModel()` with logging middleware that closes over a specific `LlmLogContext` reference (see `createPipelineLlm` in `pipeline-shared.ts:249-260`). Creating a per-server `LlmLogContext` requires creating a per-server **wrapped `LanguageModel`**, because the middleware binding is done at model-construction time, not at call time.

The per-server model must then be threaded to every call site that currently reads `this.model`. Here is the complete list of sites in `compileServer()` and its private helper methods that consume `this.model`:

1. **`compileServerPolicyRules()`** (line 1154): `new ConstitutionCompilerSession({ ..., model: this.model })` -- initial rule compilation
2. **`generateTestScenarios()` -> `generateScenarios()`** (line 1354): `generateScenarios(..., this.model, ...)` -- scenario generation LLM calls
3. **`repairScenarios()`** (line 846-856): `repairScenarios(..., this.model, ...)` -- pre-loop structural repair
4. **`new PolicyVerifierSession()`** (line 888-894): `new PolicyVerifierSession({ ..., model: this.model })` -- initial verification
5. **`verifyPolicy()`** (lines 900, 1061): passed as the `llm` parameter -- verification LLM judge calls
6. **`compilePolicyRulesWithPointFix()` / `compilePolicyRulesWithRepair()`** (lines 996, 1209): `this.model` used for repair recompilation
7. **`resolveServerLists()` -> `resolveAllLists()`** (line 1302): `model: this.model` -- dynamic list resolution LLM calls
8. **Rebuilt `PolicyVerifierSession` after repair** (line 1044-1050): `new PolicyVerifierSession({ ..., model: this.model })` -- re-verification after repair

#### Alternatives for per-server model creation

**Alternative A: `createPerServerModel()` helper in `pipeline-shared.ts` (recommended)**

Add a new exported function alongside `createPipelineLlm`:

```typescript
function createPerServerModel(
  baseLlm: LanguageModel,
  logPath: string,
  serverName: string,
): { model: LanguageModel; logContext: LlmLogContext } {
  const logContext: LlmLogContext = { stepName: `init-${serverName}` };
  const model = wrapLanguageModel({
    model: baseLlm,
    middleware: createLlmLoggingMiddleware(logPath, logContext),
  });
  return { model, logContext };
}
```

`createPipelineLlm()` continues to create the base (unwrapped) LLM and the `logPath`. In `compileAllServers()`, after creating the `PipelineLlm`, extract the unwrapped base model and store it. For each server, call `createPerServerModel(baseLlm, logPath, serverName)` to get a per-server `{ model, logContext }` pair. The per-server `model` and `logContext` are passed into `compileServer()` as new parameters, replacing all 8 call sites above.

**Pros:**
- Clean separation: one function for "create the base LLM + log path", another for "wrap it for a specific server"
- Base LLM (the expensive part: API key resolution, provider instantiation) is created once
- Only the lightweight middleware wrapping is per-server
- `createPipelineLlm()` needs a minor refactor to also expose the unwrapped base model

**Cons:**
- `compileServer()` signature grows by two parameters (`model` and `logContext`)
- All 8 call sites must be updated from `this.model` to the parameter

**Alternative B: Per-server `PipelineRunner` instances**

Instead of threading model/logContext as parameters, create a lightweight `PipelineRunner` per server. The constructor already accepts `PipelineModels`. Each server gets its own runner with its own `model` and `logContext`.

**Pros:**
- Zero signature changes to `compileServer()` or its helpers -- they continue using `this.model` and `this.logContext`
- The 8 call sites are unchanged

**Cons:**
- `PipelineRunner` is a large class (~400 lines) -- instantiating N copies is conceptually misleading since they share most config
- The runner would need to share the `cacheStrategy` and base config, making the "per-server" framing confusing
- Violates the principle that a runner orchestrates all servers

**Alternative C: `model` field on `ServerCompilationUnit`**

Extend `ServerCompilationUnit` to include `model: LanguageModel` and `logContext: LlmLogContext`. `compileServer()` reads from `unit.model` instead of `this.model`. This keeps the threading contained to the existing data-passing pattern.

**Pros:**
- Single parameter change (the `unit` already threads all per-server data)
- Natural extension of the existing pattern -- `unit` is the per-server context
- Keeps `compileServer()`'s parameter count unchanged

**Cons:**
- `ServerCompilationUnit` mixes domain data (annotations, constitution) with infrastructure concerns (model, logContext) -- mild cohesion issue
- The `logContext` is mutable state inside an otherwise `readonly` interface

**Decision: Alternative A** (`createPerServerModel()` helper). It maintains a clean separation between base LLM creation (once) and per-server middleware wrapping (cheap, per-server). The signature change to `compileServer()` is explicit about what changed and why. Alternative C is a reasonable runner-up.

### `this.cacheStrategy` concurrency audit (Issue 2)

`this.cacheStrategy` is a `PromptCacheStrategy` instance created via `createCacheStrategy()` in `prompt-cache.ts`. Both implementations (`AnthropicCacheStrategy` and `NoOpCacheStrategy`) are **stateless** -- the interface comment even documents this: "Implementations are stateless -- safe to share across turns" (line 19). Each method is a pure function:

- `wrapSystemPrompt(prompt)` returns a new object or the input string -- no mutation
- `wrapTools(tools)` returns a new object via `Object.fromEntries()` -- no mutation
- `applyHistoryBreakpoint(messages)` returns a shallow copy -- no mutation of input

**Conclusion: `this.cacheStrategy` is safe for concurrent use.** No per-server instances needed. A single shared instance can be used by all concurrent `compileServer()` calls without any risk of data races. The `compileServer()` code uses it at two sites (line 749 for compiler system prompt, line 877 for verifier system prompt, and line 1033 for repair verifier prompt, plus line 1360 for scenario generation) and all calls are pure projections.

### MCP proxy contention -- dismissed (Issue 3)

The original design considered whether two servers could contend on the same underlying MCP server via `resolveServerLists()`. **This concern is dismissed.** Each server entry in `tool-annotations.json` corresponds to a distinct MCP server process. Two servers never refer to the same underlying MCP server -- that does not make sense in practice. The `resolveServerLists()` function connects to its own proxy per invocation and shuts it down in the `finally` block. No cross-server contention exists.

---

## Decision 6: Progress Reporting Interface

The `compileServer()` method currently calls `withSpinner()` directly for each sub-step (compile, verify, repair). In parallel mode, `withSpinner()` must be replaced with something that coordinates across servers.

### Option A: `ProgressReporter` interface injected into `compileServer` (recommended)

Define an interface that abstracts progress reporting:

```typescript
interface ServerProgressReporter {
  /** Report a state change for this server. */
  update(phase: CompilationPhase, detail?: string): void;
  /** Mark a sub-step as complete with timing. */
  complete(phase: CompilationPhase, summary: string, elapsed: number): void;
  /** Report a warning or diagnostic that would have been console.error(). */
  warn(message: string): void;
  /** Mark this server as failed. */
  fail(phase: CompilationPhase, error: Error): void;
  /** Mark this server as fully complete. */
  done(summary: string): void;
}

type CompilationPhase =
  | 'cached'
  | 'compiling'
  | 'lists'
  | 'scenarios'
  | 'repair-scenarios'
  | 'verifying'
  | 'repair-compile'
  | 'repair-verify'
  | 'done';
```

Two implementations:
- `SpinnerProgressReporter`: wraps `ora` for sequential mode (preserves current behavior exactly)
- `ParallelProgressReporter`: backed by the multi-line display for parallel mode

`compileServer()` receives a `ServerProgressReporter` instead of calling `withSpinner()` directly.

**Pros:**
- Clean separation between progress logic and compilation logic
- `compileServer()` doesn't know whether it's running sequentially or in parallel
- Easy to test -- mock the reporter
- Sequential mode is unchanged in behavior

**Cons:**
- Requires refactoring `compileServer()` to use the reporter instead of `withSpinner()`
- More abstraction layers

### Option B: Override `withSpinner` globally

When in parallel mode, replace the `withSpinner` function with a version that routes to the parallel display. Use a module-level flag or closure.

**Pros:**
- Minimal changes to `compileServer()` -- it keeps calling `withSpinner()`
- Quick to implement

**Cons:**
- Global mutable state (which mode are we in?)
- `withSpinner` would need to know which server it's reporting for -- requires changing its signature anyway
- Fragile and hard to test

### Option C: Event emitter pattern

`compileServer()` emits events (`compile:start`, `compile:done`, `verify:start`, etc.). The orchestrator subscribes and routes to the appropriate display.

**Pros:**
- Fully decoupled -- compilation code doesn't reference display at all
- Events can be logged, aggregated, or forwarded

**Cons:**
- Loose typing on events (unless using a typed emitter library)
- More indirection than necessary for a known set of states
- Overkill for 6 phases

### Decision

**Option A.** The `ServerProgressReporter` interface is the right abstraction boundary. It makes `compileServer()` display-agnostic without adding unnecessary indirection. The two implementations (spinner vs. parallel display) are small and focused.

### Complete output audit of `compileServer()` (Issue 4 expansion)

The original `CompilationPhase` list was missing phases and did not account for the ~15 bare `console.error()` calls in `compileServer()`. Here is a line-by-line audit of every user-visible output point in `compileServer()` (lines 688-1136) and its private helpers, mapped to the updated phase model:

#### Phase: `cached` (early return, line 736)
- `showCached(...)` -- reports cache hit. Maps to `reporter.complete('cached', ...)`

#### Phase: `compiling` (lines 749-760)
- `withSpinner("Compiling rules", ...)` in `compileServerPolicyRules()` (line 1161)
- `validateRulesOrThrow()` may emit rule validation warnings via `console.error(chalk.yellow(...))` (line 265) -- maps to `reporter.warn()`

#### Phase: `lists` (lines 763-766)
- `withSpinner("Resolving dynamic lists", ...)` in `resolveServerLists()` (line 1296)

#### Phase: `scenarios` (lines 794-819)
- `withSpinner("Generating test scenarios", ...)` in `generateTestScenarios()` (line 1346)
- May show `showCached(...)` if scenarios are cached (line 1342)

#### Phase: `verifying` -- pre-loop structural filtering (lines 822-871)
- `filterAndLogStructuralConflicts()` emits via `console.error()`:
  - Structural conflict warnings for handwritten scenarios (line 215)
  - Discarded scenario messages (lines 215, 230, 244) -- ~3 console.error paths
- Default role fallback warnings (line 230)
- Schema mismatch discard warnings (line 244)

#### Phase: `repair-scenarios` (lines 839-871)
- `repairScenarios()` progress callback goes to `console.error(chalk.dim(...))` (line 854)
- `filterAndLogStructuralConflicts()` on replacement scenarios (line 859)
- Repair count summary: `console.error(chalk.dim("Repaired N discarded..."))` (line 867-869)

#### Phase: `verifying` -- initial verification (lines 873-927)
- `withSpinner("Verifying", ...)` wrapping `verifyPolicy()` (line 897)
- `verifyPolicy()` internal `onProgress` callbacks update spinner text
- On failure: `logVerboseFailures()` emits 2+ `console.error()` calls (lines 1373-1381):
  - "Verification FAILED:" header
  - Judge summary text
  - Per-failure detail lines

#### Phase: `repair-compile` (repair loop, lines 946-1053)
- Empty line: `console.error('')` (line 947)
- Handwritten scenario warnings: `console.error(chalk.yellow(...))` (line 959)
- Scenario correction count: `console.error(chalk.dim(...))` (line 966)
- `withSpinner("repair N/M: Recompiling", ...)` (line 993)
- "No rule-blamed failures" skip message: `console.error(chalk.dim(...))` (line 1052)

#### Phase: `repair-verify` (repair loop, lines 1055-1103)
- `withSpinner("repair N/M: Verifying", ...)` (line 1058)
- On failure: `logVerboseFailures()` again (line 1087)
- `filterAndLogStructuralConflicts()` on repair probes (line 1090)

#### Phase: `done` (lines 1106-1135)
- Final server summary: `console.error("serverName: N rules, M scenarios")` (line 1122)

#### Total bare `console.error()` call sites: ~15

All of these must be routed through the `ServerProgressReporter`. The `warn(message)` method handles the ~15 diagnostic/warning outputs that are neither phase transitions nor spinner completions. In sequential mode, `SpinnerProgressReporter.warn()` simply calls `console.error()`. In parallel mode, `ParallelProgressReporter.warn()` buffers the message and either appends it to the server's status line detail, or accumulates it for display after the multi-line table is torn down (see Decision 7 below for the error display strategy).

The updated `CompilationPhase` type now includes:
- `repair-scenarios`: pre-loop structural repair (was missing)
- `repair-compile`: rule recompilation during repair loop (was lumped into `repairing`)
- `repair-verify`: re-verification during repair loop (was lumped into `repairing`)

This granularity matters because the multi-line display should distinguish "recompiling rules" from "re-verifying" -- they have different durations and the user needs to know which sub-step is active.

---

## Decision 7: LLM Semaphore Threading (Issue 5)

Decision 4 chose a global `p-limit` semaphore on LLM calls. This section specifies exactly where and how the semaphore wraps in the call chain.

### LLM call sites in `compileServer()`

There are 5 distinct code paths that make LLM API calls:

1. **`ConstitutionCompilerSession.compile()` / `.recompile()` / `.repairPointFix()`** -- uses `generateText()` internally (multi-turn session)
2. **`generateScenarios()`** -- calls `generateObjectWithRepair()` per batch
3. **`repairScenarios()`** -- calls `generateObjectWithRepair()` once
4. **`PolicyVerifierSession.judgeRound()`** -- calls `generateText()` (multi-turn session, potentially with one internal schema-repair retry)
5. **`resolveAllLists()`** -- calls `generateText()` per list (knowledge-based) or tool-use loop (MCP-backed)

All of these ultimately call `generateText()` from the AI SDK on the `LanguageModel` object.

### Option A: Semaphore-wrapped `LanguageModel` proxy (recommended)

Create a `LanguageModel` wrapper that intercepts the `doGenerate()` and `doStream()` methods to acquire the semaphore before delegating to the underlying model. This is transparent to all callers -- they receive what looks like a normal `LanguageModel` but with built-in concurrency control.

```typescript
function createThrottledModel(
  model: LanguageModel,
  semaphore: pLimit.Limit,
): LanguageModel {
  return {
    ...model,
    doGenerate: (options) => semaphore(() => model.doGenerate(options)),
    doStream: (options) => semaphore(() => model.doStream(options)),
  };
}
```

The per-server model creation (from Decision 5) already creates a wrapped model. The semaphore wrapping composes as an additional layer:

```
baseLlm -> wrapLanguageModel(loggingMiddleware) -> createThrottledModel(semaphore)
```

**Pros:**
- Zero changes to any call site -- semaphore is invisible to `compileServer()`, `generateScenarios()`, `verifyPolicy()`, etc.
- Composes naturally with the per-server model wrapping from Decision 5
- Cannot accidentally forget to wrap a call site -- all LLM calls go through the model
- Future call sites automatically get throttled

**Cons:**
- The `LanguageModel` interface is from the AI SDK -- spreading it with method overrides relies on the interface shape being stable. However, `doGenerate` and `doStream` are the only two methods that perform I/O, and they are the defined contract.
- Semaphore scope is per-API-call, not per-logical-operation. A multi-turn session with 3 rounds acquires/releases the semaphore 3 times, which is correct (other servers can interleave between rounds).

### Option B: Semaphore wrapping at `generateObjectWithRepair` level

Wrap the semaphore around the top-level pipeline helpers (`generateObjectWithRepair`, `generateScenarios`, `verifyPolicy`). Each function takes a semaphore parameter and wraps its own LLM calls.

**Pros:**
- Explicit about where throttling happens
- Semaphore scope is per-logical-operation (e.g., "compile rules for server X")

**Cons:**
- Must thread the semaphore parameter to 5 separate call sites + their internal helpers
- `generateObjectWithRepair` has a repair loop with multiple `generateText()` calls -- wrapping the outer function means the semaphore is held for the entire multi-turn repair, blocking other servers unnecessarily
- `PolicyVerifierSession.judgeRound()` has an internal schema-retry -- same holding problem
- Easy to forget a call site (e.g., `resolveAllLists` has its own `generateText` calls)

### Option C: Semaphore at each `generateText()` call site

Pass the semaphore to every function and wrap each individual `generateText()` call.

**Pros:**
- Maximum granularity -- semaphore held only for the duration of each API call
- Explicit about every throttle point

**Cons:**
- Extremely invasive -- 10+ call sites across 5 files would need modification
- `generateText()` is called inside `ConstitutionCompilerSession`, `PolicyVerifierSession`, `generateObjectWithRepair`, `resolveAllLists` -- many of these are library-like utilities that should not know about pipeline concurrency
- Fragile -- any new `generateText()` call must remember to wrap

### Decision

**Option A: Semaphore-wrapped `LanguageModel` proxy.** The semaphore wrapping at the model level is the only option that requires zero changes to call sites and cannot be accidentally bypassed. It composes cleanly with the per-server model creation:

```
baseLlm
  -> createPerServerModel(logPath, serverName)   // per-server log context
  -> createThrottledModel(semaphore)              // global concurrency limit
```

The semaphore is created once in `compileAllServers()`, and each per-server model is wrapped with it before being passed to `compileServer()`. Multi-turn sessions naturally release the semaphore between rounds, allowing other servers to make progress.

---

## Decision 8: Error Output and Multi-Line Display Interaction (Issue 6)

When a server fails verification or encounters errors, the current code writes multi-line diagnostic output (stack traces, per-failure detail, judge analysis) directly to `console.error()`. In parallel mode, this output would corrupt the multi-line status table. This section specifies how error and diagnostic output interacts with the parallel display.

### Output categories

1. **Phase transitions and progress** -- handled by `ServerProgressReporter.update()`/`complete()` -- update the server's status line in the table. No issue.

2. **Inline warnings** (~15 `console.error()` calls) -- things like "Discarded scenario (structural conflict)", "Warning: handwritten scenario conflicts...", scenario correction counts. These are informational and do not require immediate user attention.

3. **Verbose failure output** -- `logVerboseFailures()` writes multi-line blocks: "Verification FAILED:" header, judge summary paragraph, per-failure lines with expected/actual. This can be 10-50 lines.

4. **Fatal errors** -- `compileServer()` throws an Error with a message. Caught by `compileAllServers()` which logs: `Server "X" failed: message`.

5. **Stack traces** -- uncaught exceptions from LLM API errors, JSON parse failures, etc. These can be 20+ lines with nested cause chains.

### Option A: Buffer-and-flush after table teardown (recommended)

During parallel execution, all output from categories 2-5 is buffered per-server in the `ServerProgressReporter`. The multi-line status table only shows phase/state. When all servers complete (or on fatal error), the `ParallelProgressDisplay.finish()` method:

1. Clears the multi-line table from the terminal
2. Prints the final summary table (same format as Option C in Decision 2)
3. For each server that had warnings or errors, prints a clearly delimited block:

```
--- filesystem (5 warnings) ---
  Discarded scenario (structural conflict): "delete outside sandbox" -- structural-protected-path always returns deny
  Discarded (default role fallback): "git_branch list" -- operation: missing, valid values: ["list", "create", "delete"]
  ...

--- git (FAILED) ---
  Verification FAILED:
  The policy is missing an escalate rule for git_tag operations outside the sandbox...

  FAIL: "git_tag create outside sandbox"
    Expected: escalate, Got: deny (rule: default-deny)

  Error: Verification FAILED for server "git" -- artifacts written for inspection but policy may need review.
```

The `ServerProgressReporter` interface gets a `warn(message: string)` method (already added in the updated interface above). In the `ParallelProgressReporter` implementation, `warn()` appends to a per-server `string[]` buffer. `fail()` captures the error. After `finish()`, all buffered content is flushed.

**Pros:**
- Multi-line table is never corrupted by interleaved output
- All diagnostic info is preserved and organized by server
- User can scroll through per-server details after the compilation completes
- Summary table gives immediate pass/fail status; details follow for investigation

**Cons:**
- Warnings and errors are delayed until all servers complete -- a user watching a 7-minute compilation won't see that `filesystem` had warnings until `git` (the slowest) finishes
- Buffer memory for large error output (negligible in practice -- text is small)

### Option B: Dedicated error region below the table

Reserve terminal space below the status table for scrolling error output. The table stays at the top (fixed N lines), and errors append below it. Similar to how `docker compose up` shows logs below the service status.

**Pros:**
- Errors are visible immediately as they occur
- Table stays readable

**Cons:**
- Significantly more complex terminal management -- must track the boundary between fixed and scrolling regions
- Terminal resize handling becomes harder
- If multiple servers error simultaneously, their output still interleaves in the scrolling region
- Not all terminals support scroll regions (`\x1B[r` CSI)

### Option C: Collapse table on first error, switch to prefixed log mode

When any server encounters an error or warning, tear down the multi-line table and switch to the per-server prefix mode (Option B from Decision 2) for the remainder of the run. This is a graceful degradation.

**Pros:**
- Simple to implement -- just a mode switch flag
- Errors are immediately visible
- No complex terminal region management

**Cons:**
- Losing the table mid-compilation is jarring -- the user goes from clean status to noisy interleaved output
- Common case (warnings on discarded scenarios) would trigger the switch frequently, making the table almost never survive to completion
- Defeats the purpose of having a table in the first place

### Decision

**Option A: Buffer-and-flush after table teardown.** Warnings and inline diagnostics are not urgent -- the user cannot act on them while compilation is still running. The multi-line table's primary value is showing "which servers are still working and what phase they're in." Keeping it clean is worth the trade-off of delayed diagnostic output. The `SpinnerProgressReporter` (sequential mode) continues to emit warnings immediately via `console.error()` for backward compatibility.

**Stack trace handling:** The `fail()` method on `ServerProgressReporter` captures the full `Error` object including stack. The parallel display shows only the error message on the summary line (e.g., `git [FAILED] Verification FAILED for server "git"`). The full stack trace is included in the per-server detail block printed after teardown, but only when `--verbose` is set or when the error is not a known pipeline error (e.g., `RuleValidationError` and verification failures do not need stack traces; unexpected errors like network failures or JSON parse errors do).

---

## Component Diagram

```
compileAllServers()
  |
  +-- createPipelineLlm() -> { baseLlm, logPath, cacheStrategy }
  +-- create llmSemaphore = pLimit(N)
  |
  |-- (parallel mode? i.e., filteredEntries.length > 1)
  |     |
  |     +-- Yes: create ParallelProgressDisplay(serverNames)
  |     |         for each server:
  |     |           { model, logContext } = createPerServerModel(baseLlm, logPath, serverName)
  |     |           throttledModel = createThrottledModel(model, llmSemaphore)
  |     |           reporter = new ParallelProgressReporter(display, serverName)
  |     |           launch compileServer(unit, config, hash, throttledModel, logContext, reporter)
  |     |         Promise.allSettled(all, pLimit(serverConcurrency))
  |     |         display.finish()  -> tear down table, flush buffered warnings/errors
  |     |         print summary table
  |     |         print per-server diagnostic blocks (if any)
  |     |
  |     +-- No (single server):
  |           { model, logContext } = createPerServerModel(baseLlm, logPath, serverName)
  |           throttledModel = createThrottledModel(model, llmSemaphore)
  |           reporter = new SpinnerProgressReporter(serverName)
  |           compileServer(unit, config, hash, throttledModel, logContext, reporter)
  |
  +-- compileServer(unit, config, hash, model, logContext, reporter)
        |-- check cache -> reporter.complete('cached', ...) and return
        |-- reporter.update('compiling')
        |-- compile rules (LLM call via per-server model)
        |   +-- reporter.warn() for any rule validation warnings
        |-- reporter.complete('compiling', ...)
        |-- reporter.update('lists')  (if list definitions exist)
        |-- resolve dynamic lists (LLM calls)
        |-- reporter.complete('lists', ...)
        |-- reporter.update('scenarios')
        |-- generate scenarios (LLM calls via per-server model)
        |   +-- reporter.warn() for discarded scenarios
        |-- reporter.complete('scenarios', ...)
        |-- reporter.update('repair-scenarios')  (if structural discards exist)
        |-- repairScenarios (LLM call)
        |   +-- reporter.warn() for discarded replacements
        |-- reporter.complete('repair-scenarios', ...)
        |-- reporter.update('verifying')
        |-- verifyPolicy (LLM judge calls)
        |   +-- reporter.warn() for verbose failures
        |-- reporter.complete('verifying', ...)
        |-- repair loop (up to 2 iterations):
        |     |-- reporter.warn() for scenario corrections, handwritten warnings
        |     |-- reporter.update('repair-compile', "attempt N/2")
        |     |-- recompile rules (LLM call)
        |     |-- reporter.complete('repair-compile', ...)
        |     |-- reporter.update('repair-verify', "attempt N/2")
        |     |-- re-verify (LLM judge call)
        |     |   +-- reporter.warn() for verbose failures
        |     |-- reporter.complete('repair-verify', ...)
        |-- reporter.done(summary) or reporter.fail(phase, error)
```

## Files Changed

| File | Change |
|------|--------|
| `src/pipeline/pipeline-runner.ts` | Refactor `compileAllServers()` to parallel with `p-limit`. `compileServer()` takes per-server `model`, `logContext`, and `reporter` parameters. Replace all `this.model` (8 sites) with parameter. Replace all `this.logContext.stepName = ...` (7 sites) with parameter. Replace all `withSpinner()` calls (5 sites) and `console.error()` calls (~15 sites) with `reporter.*()` calls. |
| `src/pipeline/pipeline-shared.ts` | Add `createPerServerModel()` helper. Refactor `createPipelineLlm()` to also expose unwrapped base model. Extract `ServerProgressReporter` interface and `CompilationPhase` type. Add `SpinnerProgressReporter` class. Add `createThrottledModel()` helper. |
| `src/pipeline/parallel-progress.ts` | **New file.** `ParallelProgressDisplay` class (multi-line TTY rendering, non-TTY line-based fallback, buffer-and-flush for warnings/errors) + `ParallelProgressReporter` class. |
| `src/pipeline/types.ts` | Add `CompilationPhase` type (if not co-located with reporter interface) |
| `package.json` | Add `p-limit` dependency |

## Migration Plan

1. **Phase 1: Extract progress interface + `createPerServerModel()`.** Define `ServerProgressReporter`, `CompilationPhase`, and `SpinnerProgressReporter`. Add `createPerServerModel()` and `createThrottledModel()` to `pipeline-shared.ts`. Refactor `createPipelineLlm()` to expose the unwrapped base model. Refactor `compileServer()` to accept `model`, `logContext`, and `reporter` as parameters. Replace all `this.model` references (8 sites), `this.logContext.stepName` mutations (7 sites), `withSpinner()` calls (5 sites), and `console.error()` calls (~15 sites) in `compileServer()` and its helpers with the new parameters and reporter methods. Create the semaphore in `compileAllServers()` and wrap the per-server model. Sequential behavior is preserved exactly via `SpinnerProgressReporter`. This is a pure refactor with no behavior change -- verifiable by running the pipeline and confirming identical output and LLM log entries.

2. **Phase 2: Parallel execution.** Add `p-limit` dependency. Implement `ParallelProgressDisplay` and `ParallelProgressReporter` with buffer-and-flush error handling. Change `compileAllServers()` to use `p-limit` for server concurrency + `Promise.allSettled` when more than one server is being compiled. Single-server filter continues to use `SpinnerProgressReporter`. Add final summary table and per-server diagnostic output after table teardown.

3. **Phase 3: Polish.** Non-TTY fallback (line-based logging, one line per state transition). Stack trace handling (`--verbose` flag controls full trace vs. message-only). Summary table formatting. Integration test verifying parallel output does not interleave.

## Open Questions

1. **Scenario batch parallelism.** The performance doc also identifies sequential scenario batches within a single server (google-workspace: 6 batches). This is an orthogonal optimization that composes well with server-level parallelism but should be a separate change to limit blast radius.
