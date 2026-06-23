# ToolCallCoordinator concurrency facts (verified 2026-06-18)

Load-bearing for any agent-parallelism design (e.g. evolve sync-parallelism slice).

## The FIFO call mutex serializes EVERY tool call
- `handleToolCall` (`tool-call-coordinator.ts:310-313`) and `handleStructuredToolCall` (`:348-357`) run their **entire** body inside `this.callMutex.withLock(...)`.
- `AsyncMutex` lives at `src/trusted-process/async-mutex.ts` (NOT `src/workflow/`). Fair FIFO via `waitTail` promise chain (`:18`); non-reentrant (`:15`, comment); `withLock` at `:42-49`.
- Consequence: N concurrent agent "lanes" do NOT run their tool calls concurrently — every FS/MCP touch serializes. Only in-agent LLM generation + off-mutex `docker.exec` run truly concurrently. Amdahl-bounds any agent-tool-call parallelism well below N.

## Escalation await is INSIDE the held mutex (the stall trap)
- `handleCallTool` (inside the lock) awaits: `autoApprove(...)` (`tool-call-pipeline.ts:821`), then `deps.onEscalation(...)` (`:866`) OR `waitForEscalationDecision(...)` (`:881`).
- So a single agent-path policy escalation holds the FIFO mutex across the FULL human-response latency, freezing every other concurrent caller. The fix for parallelism is to RELEASE the mutex across the escalation wait (acquire→evaluate→if escalate, release, await human, re-acquire to finish; the RMW caches need the lock only for the tail).
- Deterministic container exec (`bundle.docker.exec`, `orchestrator.ts:2667`) is NOT a coordinator tool call (see `src/trusted-process/CLAUDE.md` "Deterministic container exec") — it never touches the mutex. So a slow evaluator subprocess does NOT stall the mutex; the stall is purely agent-path policy escalation.

## CallCircuitBreaker is per-coordinator, default 20 calls/60s on identical (tool,argsHash)
- N concurrent callers making IDENTICAL reads (e.g. same cognition file) can false-trip and DENY legit work. For parallelism, make the window `workers`-aware by default, not opt-in.

## Orchestrator bundle-mint race (parallel fan-out)
- `ensureBundleForScope` (`orchestrator.ts:834+`) is unguarded check-then-act across awaits (`:838-839` read, `:864` factory await). Its own comment (`:820-824`) says: "no parallel agent-state fan-out today; if it lands, add an in-flight-promise guard." Any concurrent fan-out MUST mint the bundle once before fan-out (or add the in-flight-promise memo) or each lane mints a separate container, defeating `sharedContainer`.

## Orchestrator abort surface = polled boolean, NOT AbortSignal (verified 2026-06-18)
- `bundle.docker.exec` is `src/docker/docker-manager.ts:349-354` — `exec(nameOrId, command, timeoutMs?, execUser?, workdir?)`: timeout only, NO `AbortSignal`. `executeDeterministicState`/`reduceDeterministicCommands` (`orchestrator.ts:2615`, loop body `:2622`) take no signal either.
- The only abort model is a polled `instance.aborted` boolean (set `:1071`; checked `:835`/`:883`/`:916` inside `ensureBundleForScope`). So for any fan-out child-actor design, the abort granularity is `childActor.stop()` (XState never enters the child's NEXT deterministic state) — it CANNOT interrupt a queued-but-not-started exec in a multi-command state, nor a mid-exec one. Finer-grained mid-exec abort = adding an `abortSignal` field through the exec layer = future work, not existing.

## Deterministic container exec is coordinator-LESS (the thin EvalSlot fact)
- `src/trusted-process/CLAUDE.md:17-20`: `container:true` deterministic states run via `docker exec` of TRUSTED workflow-YAML argv — intentionally NOT a coordinator tool call. So a heavy eval step (`evolve` `evaluate`) needs NO coordinator/policy/MITM/CA/fakeKeys/control-server — just `{containerId, docker, workspace}` + cgroup budget. For two-pool eval scheduling, the eval-slot is a THIN target, not a full `DockerInfrastructure` bundle.
- Resource isolation split: `--cpus`/`--memory` cgroup caps are real per-container today; GPU isolation is hardware-dependent (MIG = datacenter-GPU-only + static; time-slicing = no VRAM isolation). Don't list CPU/mem and GPU as one knob.
- `instance.*` shared mutable state keyed by workflowId NOT lane (a separate concurrency audit from the coordinator): `bundlesByScope` (:654), `currentPersonaByBundle` (:668/:994/:1037), `mintedServersByBundle` (:677/:927/:1516), `messageLog` (:634/:1391), `tokens.sessionIds`/`outputTokens` (:717/:1318/:2298/:2494). Token bus subscription (`setupTokenSubscription` :1312) is state-INDEPENDENT (keyed on sessionIds), so per-lane tokens accumulate IF each lane registers — but budget ENFORCEMENT is on parent step transitions (once per batch under fan-out → overshoot window).
