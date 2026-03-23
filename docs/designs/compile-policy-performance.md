# Policy Compilation Performance Investigation

## Problem

`compile-policy` for the `exec-assistant` persona (5 servers) takes 20+ minutes. Expected: 2-4 minutes.

## Data Source

Analysis of `~/.ironcurtain/personas/exec-assistant/generated/llm-interactions.jsonl` — 40 LLM calls totaling 16.4 minutes of LLM time, all sequential.

## Per-Server Breakdown

| Server | LLM Calls | Total Time | Key Steps |
|--------|-----------|------------|-----------|
| filesystem | 5 | 79s | compile(11s) + scenarios(27s) + 3 repair-scenarios(41s) |
| git | 14 | 421s | compile(20s) + 2 scenario batches(76s) + 4 repair-scenarios(83s) + 2 repair-compile(148s) + 3 repair-verify(85s) |
| fetch | 5 | 79s | compile(6s) + scenarios(26s) + 3 repair-scenarios(47s) |
| github | 6 | 116s | compile(10s) + 2 scenario batches(73s) + 3 repair-scenarios(33s) |
| google-workspace | 10 | 295s | compile(32s) + 6 scenario batches(235s) + 3 repair-scenarios(28s) |

## Root Causes

### 1. Ubiquitous scenario repair (15 of 40 LLM calls)

Every single server — even tiny ones like `fetch` (2 rules) — triggers `repair-scenarios`. This means the scenario generator consistently produces scenarios that are structurally invalid and get discarded by `filterAndLogStructuralConflicts()`, triggering replacement generation via `repairScenarios()` in `pipeline-runner.ts:840-871`.

Each repair-scenarios step makes an LLM call via `generateObjectWithRepair()`. With 5 servers × 3 repair calls each = 15 calls purely for replacing bad scenarios.

**Investigation needed**: Why are so many scenarios structurally invalid? Can the generator prompt be improved to avoid producing them in the first place? The structural invariants (hardcoded engine behavior) should be communicated to the generator so it doesn't produce scenarios that conflict with them.

### 2. Sequential scenario batches (google-workspace: 6 batches = 235s)

Scenario generation batches tools in groups of `SCENARIO_BATCH_SIZE=25` (`scenario-generator.ts:29`). For google-workspace with many tools, this produces 6 sequential batches. Each batch is an independent LLM call that could run in parallel.

**Code location**: `scenario-generator.ts:286-340` — sequential `for` loop over batches.

### 3. Git verification failure triggers repair loop (233s)

The `git` server failed verification, triggering the compile-verify-repair loop (`pipeline-runner.ts:938-1098`, `MAX_REPAIRS=2`). This added 2 repair-compile cycles (148s) and 3 repair-verify calls (85s). Some of the repair-compile calls also appear to include schema repair retries (multiple entries for same step).

### 4. All servers run sequentially (16.4 min serial)

`compileAllServers()` in `pipeline-runner.ts:638-681` processes servers in a sequential `for` loop. All 5 servers are independent — their compilation, scenario generation, and verification have no cross-server dependencies.

## Optimization Opportunities

### High impact: Parallelize server compilation

Change `compileAllServers()` from sequential to concurrent (e.g., `Promise.all` or `Promise.allSettled`). Servers are already isolated with per-server output directories. This alone could reduce 16.4 min to ~7 min (time of slowest server: git at 421s).

**Risk**: Low. Servers already write to separate `servers/<name>/` directories. Main concern is concurrent console output readability and API rate limits.

### High impact: Reduce scenario repair calls

Investigate why `filterAndLogStructuralConflicts()` discards so many generated scenarios. If the structural invariants (e.g., path-containment rules, default-deny behavior) were included in the scenario generator's system prompt, the LLM could avoid generating conflicting scenarios in the first place — eliminating most of the 15 repair calls.

**Code locations**:
- `filterAndLogStructuralConflicts()` — need to find what invariants it checks
- `buildGeneratorSystemPrompt()` in `scenario-generator.ts` — where to add invariant awareness

### Medium impact: Parallelize scenario batches

Change `scenario-generator.ts:286-340` from sequential `for` loop to `Promise.all(batches.map(...))`. Batches are independent; deduplication happens after all batches complete. Would help google-workspace (6 batches, 235s → ~52s).

**Risk**: Low. Batches are independent. API rate limits are the main concern.

### Lower impact: Parallelize list resolution

`list-resolver.ts:308-320` resolves lists sequentially. Could use `Promise.all()`. Less impactful for exec-assistant (no dynamic lists), but relevant for other personas.

## Files Involved

- `src/pipeline/pipeline-runner.ts` — orchestration, server loop, repair loop
- `src/pipeline/scenario-generator.ts` — batch generation, `repairScenarios()`
- `src/pipeline/policy-verifier.ts` — verification rounds, judge calls
- `src/pipeline/generate-with-repair.ts` — multi-turn schema repair wrapper
- `src/pipeline/list-resolver.ts` — sequential list resolution
