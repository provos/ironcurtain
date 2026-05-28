# Golden Trace Pipeline: Memory Corruption (v0)

Concrete pipeline plan for turning IronCurtain exploitation workflow runs into SFT-ready golden traces and RL-ready flag schemas. Companion to `sft-and-rl-with-ironcurtain.md`, which covers goals and rationale.

## Scope (v0)

- **Bug class:** memory corruption only. Cleanest oracles (crash, controlled flow, captured flag) and the deepest historical PoC corpus to draw from.
- **Trace shape:** linear runs only. No branching/parallel rollouts.
- **Editing granularity:** tool-call level. No sub-turn paragraph editing.
- **Driver model:** any frontier closed model acceptable; thinking handled via plausible-CoT synthesis post-hoc.
- **Out of scope:** RL training loop, reward shaping, other bug classes, branching rollouts, sub-turn pruning.

## Data Flow

`workflow run → verbatim capture → causal prune → CoT synthesis + validation → flag extraction → restitch & export`

Per scenario, the pipeline emits:
- `trace.jsonl` — verbatim capture
- `golden.jsonl` — causally pruned, restitched, CoT-annotated
- `flags.json` — flag schema (oracle definition for RL)
- `harness/` — re-instantiable target environment
- `metadata.json` — driver model, FSM version, anonymization seed, persona sequence, provenance

## Components

### 1. Exploitation FSM Workflow

- States: `recon → target-analysis → hypothesis-formation → primitive-discovery → primitive-chaining → poc-construction → reliability → oracle-check`.
- **Single global policy throughout** (generic coding persona) — no per-state policy swap, no per-state persona. The FSM gates *transitions* and structures evidence accumulation, not per-state tool access.
- Transitions gated by structured-output verdicts emitted by each state. **Evidence-gated, not script-following** — driver model must demonstrate the required signal before advancing, never advance on turn count or hard-coded sequence.
- Authored as workflow YAML + skill files under `workflows/exploit-memory-corruption/`. Reuses existing workflow factory and checkpointing. No persona / policy hot-swap; no new runtime kernel changes.

**Prior art & learnings**
- **Naptime / Big Sleep** uses *coarse* tool-mediated phases (Code Browser, Debugger, Reporter, Sandbox) over a ReAct loop, not a fine FSM. Their lesson: fine sub-stages caused the model to skip evidence collection to satisfy the next gate. Reconsider whether 8 states is too many; collapse `primitive-discovery` + `primitive-chaining` unless the transition has a hard structured signal.
- **EnIGMA (NYU CTF Bench)**: tool granularity mattered more than state granularity. One loop with rich interactive tools (debugger, disassembler) beat multi-stage competitors. Invest in tool quality at least as much as state decomposition.
- **PentestGPT / HackingBuddyGPT**: LLMs fabricate completion verdicts ~15% even at temperature 0. `oracle-check` must be the only state allowed to declare success, and it must run code rather than reason. Require artifact proof (crash file, controlled RIP) in the structured-output schema, validated by a non-LLM checker.
- **PentestGPT ablation**: the *structured-extraction* module gave most of the gain, not the stage split. Invest heavily in typed transition verdicts.
- **AutoAttacker**: planner/executor split produced infinite re-recon loops on executor failure. Cap re-entries to earlier states (e.g., max 2 returns to `recon`).
- **CIPHER**: multi-persona gave no measurable lift on binary tasks — context-handoff loss exceeded specialization gain. Validates the single-global-policy choice; revisit only with measured evidence.
- **Premature PoC commit** is the dominant failure across Naptime, EnIGMA, PentestGPT. Gate `primitive-discovery → poc-construction` on a "controlled-write at address X with value Y, verified by debugger" record, not a narrative claim.
- Hallucinated ROP gadgets / libc offsets are common. Require every primitive claim to cite a concrete address from actual debugger output captured in state.
- **Per-state checkpointing must persist binary artifacts** (debugger state, memory), not just transcripts (LangGraph security-agent examples).
- **No published FSM-driven multi-persona memory-corruption work exists.** Budget time for empirically-discovered failure modes.

**In or out of IronCurtain**

*Verdict:* In

*Pros:*
- Uses workflow factory, state machine, checkpointing — first-class IronCurtain primitives. A workflow YAML + skills directory under `workflows/exploit-memory-corruption/` follows the established precedent.
- Co-located with the global policy that defines the generic coding persona; out-of-repo placement would force fragile version coupling.
- Simpler than originally sketched (no per-state persona, no policy hot-swap), so the in-repo footprint is small.

*Cons:*
- Domain expertise (exploit dev) is orthogonal to the rest of the workflow corpus; reviewers may lack context.
- Skill files could grow large with bug-class taxonomy content unrelated to runtime concerns.

*Recommendation:* In, as `workflows/exploit-memory-corruption/`. Keep bug-class reference material in skill files, not the FSM definition.

### 2. Verbatim Capture (new runtime code)

> **Status: implemented and merged.** The MITM capture runtime landed in PR #273
> (`src/docker/trajectory-{capture,tap,reassembler,types}.ts` + the `mitm-proxy.ts`
> fan-out). Enable with `--capture-traces`. See [`TRAJECTORIES.md`](../../TRAJECTORIES.md)
> for the on-disk format and the [design doc](../designs/mitm-token-trajectory-capture.md).
> The bullets below are the original plan; the shipped implementation matches it,
> with these deltas worth knowing downstream: capture is gated to completion
> endpoints only (housekeeping traffic excluded); the response body is gzip-decompressed
> on the capture branch and the reassembled message is stored in `bodyUtf8` (not raw
> wire bytes); and the binary session-poison model means a flawed exchange poisons the
> whole session rather than emitting a partial record.

- **Primary capture point: the Docker MITM proxy** (`src/docker/`). Default workflow runs use Docker agent mode (Claude Code / Goose / etc. inside `--network=none` containers); the MITM already terminates TLS, performs sentinel-key swap, and sees every API call uniformly across harnesses. No SDK wrap needed for the default path.
- **Code Mode fallback** (secondary path, only when a workflow runs the built-in agent): wrap the AI SDK v6 model client (`wrapLanguageModel`) in `src/agent/`. Same downstream format, different in-line tap.
- **Capture format: append-only JSONL** at write time, one event per line. Keys: `(workflowRunId, sessionId, workflowState, turnIndex, eventSeq)`. JSONL chosen for crash-safety — line-atomic, partial last line discardable; Parquet writers buffer in memory and corrupt on mid-write death.
- **Captured per HTTP exchange**: full request body (messages array, tool schemas, system prompt, sampling params), full response body (content blocks including any `thinking` / `redacted_thinking` with signatures), raw SSE event log if streaming, provider request ID, model fingerprint, exact stop reason, usage counters. Auth headers stripped before write.
- Workflow state tag attached at capture by the orchestrator (via the existing control-server marker) so per-state partitioning survives reassembly.
- **Reassembly pass (offline, post-run)** transforms JSONL → Parquet + zstd: groups events into sessions, coalesces stream chunks into final assistant messages while preserving the raw SSE log alongside, **dedupes the shared prompt prefix across consecutive turns** of a session (a large compression win on top of zstd), demotes cache-stat counters (`cache_creation_input_tokens` / `cache_read_input_tokens`) to per-turn metadata, retains one canonical tool-schema snapshot per session. **Idempotent and re-runnable** so reassembly logic iterates without re-capturing.
- **Boundary constraint:** capture the *agent-facing* side of the MITM. Record the request body as the agent emitted it (sentinel `x-api-key`) and the response body as forwarded back to the agent. Never record the upstream-side request (which carries the real key) or upstream metadata not surfaced to the agent. Regression test: grep-for-real-key-in-corpus.

**Prior art & learnings**
- **Capture raw provider request/response bodies as opaque blobs** alongside any normalized fields. LangSmith and LangFuse both added `inputs_raw`/`outputs_raw` after lossy normalization burned them. OTel GenAI semconv alone is insufficient.
- **Frequently-missed fields**: provider request ID (`anthropic-request-id`, `x-request-id`), model fingerprint / `system_fingerprint`, exact stop reason vs derived, `service_tier`, beta header set, SDK version. Add at design time.
- **Capture the tool schema as on the wire** — at the MITM tap point the schema is already in the JSON form the model received, free of SDK-side rewriting. AgentBank's traces are unusable for fine-tuning because they stored Python signatures, not the JSON Schema the model saw. Wire capture sidesteps that whole class of bug.
- **Persist sampling params as they appear in the request body**, not the agent's config. SDKs apply defaults that aren't visible at the call site; the wire bytes are ground truth.
- **Capture both streaming and non-streaming responses**; for streams, persist the raw SSE event log (each event with monotonic offset) alongside the assembled final message. The streaming `input_json_delta` partials carry the **ground-truth byte sequence** the model emitted for tool-call JSON; the assembled `tool_use.input` object is a parsed reconstruction, and `JSON.stringify(input)` is lossy (reorders keys, normalizes whitespace, reformats numbers, re-escapes Unicode). For RL methods that compute logprobs/KL against a reference policy (PPO, GRPO, DPO with reference model), those bytes must align to the same tokens the reference policy emitted — reassembled JSON shifts token boundaries and silently breaks the math. SFT tolerates the loss but still trains on different tokens than were demonstrated.
- **Anthropic extended thinking**: store `thinking` blocks **with their `signature`** field verbatim — Anthropic rejects unsigned thinking on resume. Preserve `redacted_thinking` as opaque base64. The order of block types within an assistant message is load-bearing — preserve array order.
- **Tool-call serialization quirks**: Anthropic `tool_use.input` is an object on the wire; OpenAI `tool_calls[].function.arguments` is a JSON-encoded string. **Don't parse-then-restringify** in reassembly — whitespace/key-order divergence from the model's emission matters for token-level SFT. Store bytes as received; normalize only at read time downstream.
- **JSONL won for capture, Parquet won for curation** (AgentInstruct, FireAct, ToolBench all converged here). One event per line, not one trajectory per line — trajectories grow unbounded.
- **Don't gzip inline during capture** (CPU + corruption risk); rotate raw, compress async. Tee through a bounded async queue with drop-with-counter on overflow; never block the MITM proxy thread waiting for disk.
- **Prompt cache state cannot be captured reliably.** Log `cache_control` breakpoints as sent + usage counters (`cache_creation_input_tokens`, `cache_read_input_tokens`) and accept replays won't hit the same cache state. Don't condition training on cache behavior.
- **AgentInstruct pattern to copy**: raw provider I/O + a separate normalized event stream side-by-side. Don't try to make one format serve both.
- **FireAct pattern**: store system prompt as full text on first occurrence + hash thereafter (~40% storage cut on long sessions). **Generalizes to full-prefix deduplication during reassembly** — the longest common messages-array prefix across consecutive turns is typically 90%+ of the payload.
- Expected storage: ~5–15 KB/turn typical, ~50–200 KB/turn with extended thinking + large tool results. Post-reassembly with prefix-dedup + Parquet/zstd, expect another ~5–10× reduction on long sessions.
- **Reassembly idempotence is non-negotiable**: same JSONL must produce bit-identical Parquet. Lets you iterate on reassembly without re-capturing, and serves as a structural test against silent normalization drift.
- **Parquet schema design**: row-per-turn (not row-per-session) so columnar pruning works at query time; nested Arrow types (`LIST<STRUCT>`) for messages content; flatten high-cardinality metadata (`model_id`, `request_id`, `workflow_state`, `usage.*`) to top-level columns for cheap filtering.

**In or out of IronCurtain**

*Verdict:* In

*Pros:*
- The MITM proxy is already an IronCurtain runtime component (`src/docker/`); capture is a natural extension, not a new layer.
- Works uniformly across all Docker harnesses (Claude Code, Goose, future agents) — single tap point covers every default workflow run.
- Credential-safety invariant (agent-facing side only) is a runtime concern; out-of-repo capture cannot enforce it.
- Tiny dependency surface (JSONL writer + async queue); no ML libs pulled in. Reassembly to Parquet is offline and out-of-repo.

*Cons:*
- Adds a tee on every API call; misconfigured queue could stall or drop production traffic.
- Capture is dead code for non-training users unless gated.

*Recommendation:* In, gated by `captureRawTraces` config flag (default off). Writer lives adjacent to the MITM in `src/docker/`. The JSONL → Parquet reassembly stage is offline and lives out-of-repo with the rest of the curation pipeline.

### 3. Causal DAG Construction & Pruning (offline)

> **Hard input constraint (verified against captured data).** Reconstruct each turn's
> assistant action from that exchange's **`response.bodyUtf8`** (the source of truth — it
> carries the `thinking` block with its signature), **not** from the echoed assistant
> message in the *next* request's `messages` array. Claude Code strips thinking blocks
> from the history it re-sends (thinking is single-turn-scoped), so a request-side stitch
> yields actions with the reasoning silently removed — the DAG would then prune against
> reasoning-free nodes and the SFT corpus would teach actions without thought. Build the
> trajectory response-side-first; use the request-side `messages` only to confirm ordering
> and tool_result continuity. See `TRAJECTORIES.md` §"The #1 trap".

Nodes are `(tool_call, result)` pairs plus terminal goal-reaching action(s). Edge `r_i → a_j` if `a_j` depends on `r_i`. Three layered detectors:

1. **Citation** — `a_j`'s JSON args contain substrings/identifiers (paths, symbols, line numbers, hashes, error strings) first appearing in `r_i`. Mechanical, cheap, high precision; probably catches the majority of edges in coding-agent traces.
2. **World-state effects** — most exploitation tool calls (gdb, target-binary invocations, pwntools primitives, raw bash inside the harness) never traverse IronCurtain's MCP layer, so the effect mapping cannot live in `src/types/argument-roles.ts`. Instead, build a per-bug-class / per-harness **inventory of `(tool, arg-pattern) → effect-tag`** by post-analyzing observed traces; LLM-assisted classification of unique invocation patterns is the cheapest starting point. Cover filesystem writes, debugger-state mutations, target-process state, fork-server resets, env vars, network. Later reads of a mutated resource are causally downstream until a subsequent effect supersedes it. *v2 alternative:* harness-side instrumentation records actual side-effect deltas per invocation (fs hash diffs, process-tree changes, fd-table changes) — ground truth, no inventory needed; deferred for v0 to avoid harness-engineering blow-up.
3. **LLM-as-judge fallback** — run only on edges the structural detectors flag as ambiguous, not exhaustively.

Walk the DAG backward from goal-reaching nodes, mark ancestors, prune the rest. Restitch survivors: renumber `tool_use` IDs, drop orphaned `tool_result` blocks, collapse assistant turns whose tool calls were all pruned.

**Prior art & learnings**
- **No published end-to-end work on causal-DAG pruning of agent traces** — this is genuinely under-explored. Closest: AgentInstruct uses *suggester-editor* LLM rewriting (avoids dangling-reference problem by regenerating); ToolACE keeps successful root-to-leaf paths only (+12pt pass@1 on equivalent token budgets).
- **Dangling `tool_use_id` references are the #1 silent corruption mode.** Anthropic's API hard-rejects orphaned `tool_result` blocks; OpenAI format silently degrades training. Validate post-restitch with strict schema pass; reject restitched traces that fail validation rather than silently shipping broken data.
- **Over-pruning hurts.** AgentTuning ablation: aggressive step-pruning underperformed moderate (1-hop neighborhood) pruning by 3–6pt. AgentBoard: removing exploratory turns dropped recovery behavior by ~8pt. **Target 60–75% retention; alarm below 50%.** Keep 1–2 failed-probe turns near goal-reaching actions — they teach error recovery.
- **Citation detection recall is ~70–80%, precision >95%** (WebShop, Mind2Web). High false-negative rate is the danger — layer with effect tracking and judge.
- **SWE-bench / SWE-agent** track git-diff deltas as effect markers — directly applicable as the world-state detector. Found ~15% of useful steps have *no* git-visible effect (read-only navigation feeding later writes) — don't prune zero-effect steps unconditionally.
- **τ-bench tracks DB-state hashes**; uses state-divergence between pruned and full execution as causal-relevance proxy. **Borrow as a CI regression test** for the pruning pipeline.
- Coarse-grained "did this tool mutate {fs, git, env, network}" tags match what works in **AutoCodeRover, OpenDevin**. Byte-level taint (PolyTracker) is overkill.
- **LLM-as-judge causal-necessity calibration is poor**: GPT-4-class judges drop to ~65% agreement on causal necessity (near chance), with strong position bias (20pt swing from order alone — MT-Bench). **ToolACE mitigation**: ensemble 3 judges, **asymmetric thresholds — unanimity to prune, majority to keep** (biased toward retention). Randomize order. Budget ~$0.02/edge with Sonnet-class; only invoke when structural detectors disagree.
- **Restitching patterns** (from OpenHands/OpenDevin, trlx, OpenRLHF): renumber `tool_use_id` by monotonic re-indexing (e.g., `toolu_<seq>`); maintain bijection map for the pass; never reuse original IDs (debugging nightmare otherwise); keep assistant turns with surviving text blocks even if all `tool_use` blocks were pruned.
- **Scrub `<thinking>` blocks** referencing pruned tool results at the string level, not just block removal.
- **Concrete pipeline-design recommendations**: 1-hop neighborhood expansion after DAG pruning as insurance against over-trim; track retention rate as a first-class metric; state-divergence regression test as CI gate; strict tool_use_id validation as the terminal step.

**In or out of IronCurtain**

*Verdict:* Out

*Pros:*
- Pure offline JSONL → JSONL transform. No runtime primitives required.
- Most observed tools (gdb, target binaries, harness-internal bash) never traverse IronCurtain's MCP layer — no `argument-roles.ts` extension would catch them. Effect inventory must be per-bug-class / per-harness, built post-hoc.
- Heavy LLM-judge / graph dependencies would bloat IronCurtain's surface area.
- Iteration cadence (judge swaps, inventory refinement) does not match runtime release cadence.

*Cons:*
- Schema drift risk if the verbatim-trace contract evolves separately from the consumer.

*Recommendation:* Whole DAG construction, effect inventory, pruning, and restitching live in a sibling repo consuming a versioned trace-schema contract. No `argument-roles.ts` changes needed.

### 4. Plausible-CoT Synthesis (offline)

> **Synthesize only where real thinking is absent.** Captured Claude Code traces already
> carry genuine `thinking` blocks (with signatures) on a substantial fraction of turns —
> empirically ~30% in early runs, and higher with `interleaved-thinking` enabled. For those
> turns the model's *actual* reasoning is in `response.bodyUtf8`; prefer it over a synthesized
> rationalization. Plausible-CoT synthesis is the fallback for the turns that thought silently
> (no `thinking` block emitted), not a blanket pass over every turn. This both cuts annotator
> cost and avoids overwriting authentic reasoning with a weaker reconstruction. (Frontier
> drivers without exposed thinking still need synthesis on every turn — the split is
> per-driver.)

- Annotator: open reasoning model with visible thinking (DeepSeek R1, QwQ, Qwen3-thinking class).
- Input: `(prior conversation, observed action) → synthesized CoT`.
- **Validation loop:** feed CoT back through annotator (or held-out validator); confirm predicted next action matches observed. Drop CoTs that fail to reproduce. Cheap quality gate against confabulation.
- **Runs only on the post-prune golden path.** Never synthesize CoT for dead-end branches — wastes compute and teaches the model to confabulate justifications for bad actions.

**Prior art & learnings**
- **STaR (Zelikman et al. 2022)**: the canonical validator pattern is exactly what's proposed — "does the rationale lead to the observed answer?" Original pass-through was ~70–80%; the rest were garbage even when the answer matched (reasoning unrelated to answer).
- **Quiet-STaR (Zelikman et al. 2024)**: add a *contrastive* validator — synthesized CoT must improve next-token logprob over no-rationale baseline. Cheap port; filters "plausible but inert" CoT that the basic forward-replay misses.
- **PRM800K / Lightman et al. 2023**: per-step process supervision dramatically beats outcome-only. Validate intermediate tool-call subgoals along the trace, not just the final action; catches mid-trace confabulation.
- **Orca-2**: GPT-4-synthesized rationales had ~15–25% factually-inconsistent steps even when the final answer was right. Outcome-replay alone *underestimates* corruption — manually audit ~100 random kept traces early.
- **MetaMath**: rationalization (answer-conditioned CoT) leaked the answer ~30% of the time ("since the answer is X, we…"). **Hard rule**: never show the annotator the observed action. Generate CoT forward-only from prior context; validate by replay. If conditioning on the action for cost reasons, run an adversarial classifier or n-gram check for argument leakage (paths, function names, addresses) in the synthesized CoT.
- **R1 traces are longer, more self-correcting ("wait, actually…"), more diverse** than QwQ (which tends to loop) and Qwen3-thinking (stylistically uniform). For exploit reasoning where backtracking is realistic, R1 looks more authentic — but rotate annotators across traces to avoid single-teacher style fingerprinting (Orca-2 and WizardMath both observed this).
- **Almost no published precedent for synthetic CoT on *agentic* tool-using traces.** xLAM and AgentInstruct/Orca-3 are closest but report no rigorous per-step validation. **Treat the validator metrics as a research contribution, not a sanity check.**
- **Single-turn validators don't transfer** to agentic settings — a plausible CoT can rationalize almost any tool call. **Require argument-level reproduction** (exact path, exact flags), not tool-name match.
- **Track pass-rate per workflow state**; states with <40% pass-rate likely have insufficient context for any rationalization — exclude rather than force-fit.
- **Expect 10–20% subtle errors** to persist past replay validation. Plan a manual audit pass on the kept set before declaring the corpus done.

**In or out of IronCurtain**

*Verdict:* Out

*Pros:*
- Zero coupling to runtime: input is post-pruned JSONL, output is annotated JSONL.
- Requires open reasoning models (R1, QwQ, Qwen3-thinking) and validator infra unrelated to mediation.
- Iteration loop (annotator rotation, contrastive validator tuning, manual audit) is research-paced, not release-paced.

*Cons:*
- Schema for CoT block placement must agree with the capture format; coordination needed.
- Out-of-repo placement means the IronCurtain audit log and these CoTs evolve independently.

*Recommendation:* Out, in the training-pipeline sibling repo. Pin the consumed trace-schema version in its manifest.

### 5. Flag Schema (memory-corruption template)

Class-level template, parameterized per target:

| Flag | Predicate style | Notes |
|---|---|---|
| `triggered_crash` | programmatic | crash signature in harness stderr / dmesg |
| `controlled_pc` | programmatic | instruction pointer matches expected canary pattern |
| `leaked_address` | programmatic | agent surfaces parsed address from target memory |
| `arbitrary_read` | programmatic | agent extracts known canary string |
| `arbitrary_write` | programmatic | target state mutated to expected value |
| `code_execution` | programmatic | harness flag string surfaced by agent |

Per-target parameters fill addresses, canary values, harness check commands. Schema accommodates per-flag weights and inter-flag dependencies; partial-credit semantics deferred to the RL trainer.

LLM-as-judge fallback reserved for cognitive milestones without clean observables (e.g., "agent identified the vulnerable function") — accept judge variance only where programmatic checks aren't feasible.

**Prior art & learnings**
- **CGC POV format — nonce-based negotiation is the single most copyable anti-cheat pattern.** Judge sends fresh random values per trial; PoV must echo them via the primitive. Prevents replay/hardcoding entirely. **Adopt for `controlled_pc`, `arbitrary_read`, `leaked_address`** — add a `nonce_source` field to every value-match predicate.
- **Magma three-tier ladder** (reached → triggered → detected) maps cleanly to the stepwise schema. Layer the primitive flags above `detected`.
- **LAVA-M magic-value oracles proved fragile** — fuzzers learned the magic constants without exercising the bug. **Do not gate flags on input-side magic values, only on runtime state.**
- **`controlled_pc` specifically**: don't check only RIP — check that RIP equals a *nonce-derived* value handed the agent that run. `0x4141…` is the canonical false positive (partial overwrite of saved RBP lands RIP in unmapped region containing `0x41`). Big Sleep: run the candidate exploit N times, require consistent crash signature.
- **pwn.college pattern**: oracle on flag-file read post-exec (unforgeable side effect) rather than RIP=X detection. Consider: rather than detect RIP=X, require the agent to land RIP at a stub that reads a per-run secret.
- **Crash classification: signal ≠ bug.** SIGSEGV from stack exhaustion, SIGBUS from misalignment, SIGILL from corrupted code pointer all look exploitable to naive triagers. **Require ASAN/HWASAN report parsing** (`==ERROR==` + bug class), not wait-status alone. Honggfuzz stack-hash dedups over-merge and under-merge — normalize addresses to module+offset first.
- **Magma harness pattern**: fork-server, only count crashes *between* input-feed and response-read — avoids attributing setup/teardown SIGSEGVs to the input. Reset between trials or use one-shot mode for oracle evaluation.
- **Anti-canary-attack**: agent can craft input containing canary bytes directly so memory dumps "find" them without the bug firing. Mitigations: place canaries in memory the input cannot reach (guard pages adjacent to victim object, allocated *after* input consumed); check canary *location* (not just value).
- **`leaked_address` oracle**: don't grep stdout for `0x7f…` (too common). CGC Type 2 required exact-bytes match of a randomized secret. Equivalent: place a per-run random 8-byte cookie at a known offset, require exact-bytes echo.
- **`code_execution` oracle**: strongest is side-effect-based, not state-based. Spawn child that touches a file at a per-run random path or connects to a per-run UDS — file/socket existence is unforgeable without actual code exec. Avoid "shellcode contains `/bin/sh`" string checks.
- **Reliability / flake**: disable ASLR (`personality(ADDR_NO_RANDOMIZE)`) for milestones before `leaked_address`; **leave ASLR on for `code_execution`** so leak→exploit chain is tested honestly (Big Sleep's approach). **≥3 trials with ≥2 successes per flag** (CGC required 4-of-10). Pin glibc + kernel image hash. Force `setvbuf(stdout, NULL, _IONBF, 0)` or read via ptrace.
- **Reward-shape warning** (Tartarus, ILF): monotone-cumulative reward (sum of unlocked flags) leaks milestone structure — agents game lower flags repeatedly. **Use first-time-unlock bonus + small per-step shaping, not cumulative.**
- **Concrete `flags.json` schema additions**: `nonce_source`, `trials` + `min_successes` (default 3/2), `evidence` field (`asan_report` | `ptrace_regs` | `side_effect_file` | `nonce_echo` | `llm_judge`), and **soft (weight-multiplier) dependencies** not hard gating — per CGC partial-credit lesson.

**In or out of IronCurtain**

*Verdict:* Out

*Pros:*
- Pure research artifact: a JSON schema parameterized per target. No runtime call sites.
- Domain knowledge (ASAN parsing, CGC POV negotiation, anti-canary semantics) is exploit-research expertise, distinct from mediation-runtime expertise.
- Per-bug-class schemas will proliferate (heap-OOB, UAF, type confusion, integer overflow); keeping them out avoids bloating the IronCurtain repo with research content.

*Cons:*
- The oracle-check workflow state will reference flag fields; schema drift could break workflow runs.
- A canonical schema location helps both IronCurtain consumers and downstream RL trainers.

*Recommendation:* Out, co-located with the target/harness set (component 6) in a research repo. Version the schema and pin from the workflow YAML.

### 6. v0 Target & Harness Set

Mix of:
- **3–5 historical memory-corruption CVEs** with public PoCs, picked for clean programmatic oracles (e.g., heap overflow with controllable crash signature, stack BOF with known canary, simple use-after-free).
- **Newly-discovered bugs** from IronCurtain workflow runs or partner researchers — no anonymization burden, highest-quality training signal.

Each target ships: vulnerable code or binary, Docker harness re-instantiable for RL rollouts, programmatic oracle implementation, anonymization seed (rename map) for the historical ones.

**Prior art & learnings**
- **Magma is the strongest fit for v0**: 138 real CVEs across 9 OSS targets (libpng, libtiff, libxml2, openssl, php, poppler, sqlite3, lua, tcpdump), forward-ported into a single modern codebase. Canary instrumentation gives a clean oracle distinct from "did it crash." Build the v0 set primarily from Magma.
- **OSS-Fuzz reproducers** as supplementary: every fixed bug has a minimized PoC, build script, and fixing commit. Pick `crash_type: Heap-buffer-overflow READ/WRITE` with small reproducers (<1KB). Avoid `Timeout`, `Out-of-memory`, `LeakSanitizer`.
- **DARPA CGC corpus** is procedurally rich but runs on a custom syscall ABI — re-hosting via Trail of Bits' `cb-multios` (Linux port) is ~a week of harness work.
- **Skip for v0**: LAVA-M (single-source magic-byte injections — models overfit to magic-byte search; Klees et al. CCS '18 showed LAVA-M scores don't predict real-CVE performance), Juliet (synthetic CWE patterns, no exploit primitive), NYU CTF Bench (mostly web/crypto/rev), CyberSecEval (capability eval, not training-grade).
- **Reproducibility reality check**: Mu et al. (CCS '18) found only ~25% of memory-corruption CVEs reproduce without major effort. Drivers: glibc tcache (post-2.26), ASLR entropy changes, compiler hardening defaults (`-D_FORTIFY_SOURCE=2`, stack canaries, PIE), kernel `vm.mmap_min_addr`. **Pin everything**: exact Ubuntu point release, glibc, kernel ABI, compiler flags. Use `debian/snapshot.debian.org` for date-locked apt sources.
- **Concrete v0 CVE candidates with clean harnesses**: CVE-2014-0160 (Heartbleed; info-leak, deterministic), CVE-2017-9445 (systemd-resolved heap OOB write), CVE-2016-10190 (FFmpeg, in Magma), CVE-2015-8317 / CVE-2017-5969 (libxml2, in Magma), CVE-2018-19518 / CVE-2019-7317 (Magma canaries). **Avoid kernel CVEs in v0** (Dirty COW, Dirty Pipe) — kernel-version coupling and KASLR make harnessing brittle.
- **Anti-flake harness configuration**: disable ASLR (`setarch -R` or `randomize_va_space=0`), pin malloc behavior (`MALLOC_ARENA_MAX=1` or pinned tcmalloc), single-threaded (or `taskset -c 0` + `SCHED_FIFO`), oracle on sanitizer-fingerprint not segfault exit, `ulimit -c 0`, `ASAN_OPTIONS=abort_on_error=1`.
- **Docker isolation gotchas**: default seccomp blocks `ptrace`, `personality`, `process_vm_readv/writev`, `perf_event_open`, `keyctl` — exploit dev/triage tools (gdb, pwntools' `gdb.attach`) fail silently. Use `--security-opt seccomp=unconfined` for harness containers. `/proc/<other>/mem` needs `--cap-add=SYS_PTRACE`. ASAN needs `CAP_SYS_PTRACE` or `vm.mmap_rnd_bits` ≤28 (modern kernels default to 32; symptom: "Shadow memory range interleaves with an existing memory mapping"). AppArmor blocks `mmap` of executable anonymous pages (disable for harness containers). `--pid=host` leaks too much; per-rollout `--pid=container:harness`.
- **Magma canaries fire on near-miss inputs ~5–10%** (false positives per the paper) — **combine canary signal with sanitizer-hash oracle.**
- **Suggested v0 composition**: **3 Magma CVEs + 1 recent OSS-Fuzz bug + 1 CGC binary**. Gives heap-OOB + UAF + info-leak + stack-smash diversity without drowning in harness engineering.
- **No accepted "minimum viable" memory-corruption training set published**; Magma's 9-target subset is the closest community reference. **AIxCC (DARPA, 2024)** released a CRS harness over nginx/jenkins/sqlite/etc. — worth mining for harness patterns even if their targets are too heavy for v0.

**In or out of IronCurtain**

*Verdict:* Out

*Pros:*
- Vulnerable binaries, CVE harnesses, sanitizer configs, kernel/glibc pinning are exploit-research artifacts with their own review velocity and CI needs.
- Dragging Magma / OSS-Fuzz / CGC harness builds into IronCurtain CI would bloat repo size and add fuzzing/sanitizer toolchains to the dependency surface.
- Anonymized historical targets carry their own licensing and provenance concerns better handled in a dedicated repo.
- Each harness is just a Docker image the workflow mounts — clean contract boundary.

*Cons:*
- Harness contract (oracle interface, evidence-file layout) must agree with the workflow; cross-repo changes need coordination.

*Recommendation:* Out, in a `vuln-harnesses` research repo. Workflow pins harness-image digests.

### 7. Anonymization & Variant Generation

- Strip CVE identifiers, version banners, original symbol names from historical targets before the workflow ever sees them.
- Force trace diversity via `N anonymization seeds × M sampling temperatures × K FSM persona configurations` per target. Critical multiplier given the small universe of validated historical exploits.
- **Shortcut-trace filter:** LLM-as-judge classifies each trace as `discovered` (search → hypothesis → test → refine) vs `recognized` (driver model recognized the target and skipped to the known exploit). Recognition traces are discarded — they look correct but lack the procedural reasoning the SFT corpus needs to capture.

**Prior art & learnings**
- **Surface renames are insufficient.** EvalPlus / HumanEval+ (Liu et al., NeurIPS 2023) and contamination work (Yang et al., 2023) show models recover memorized solutions even after variable/function renaming when *structural fingerprints* remain (loop nesting, magic constants, error-string literals). For CVEs the equivalents are: vulnerable-function call sequences (e.g., `SSL3_RT_HEARTBEAT`), magic offsets, RFC-derived constants, distinctive error messages — **all must go**.
- **Bug fingerprints leak harder than names.** Lopez et al. ("Lost in Translation," 2024) and CodeLMSec (Hajipour et al., 2024): Codex / CodeLlama re-emit known-CVE patches given the surrounding 20-line context even with renamed symbols. **Anonymize a wider radius** than the vuln site — at minimum the enclosing translation unit, plus any callers naming the protocol/version.
- **Heartbleed and Shellshock are the hard cases.** Riddell et al. (2024) "Do LLMs Recognize Your Code?" and Karmakar & Robbes (MSR 2022): frontier models recognize OpenSSL/Bash CVEs from *any* fragment containing payload-length arithmetic or `parse_and_execute`. **No published anonymization scheme has fully defeated recognition on these in agent settings.** Assume residual leakage; the shortcut-trace filter is the load-bearing defense, not the rewrite.
- **Measure recognition, don't trust vibes.** **Min-K% Prob** (Shi et al., ICLR 2024) and **DE-COP** (Duarte et al., 2024) are the practical membership-inference probes — run on anonymized vs original to get a leakage delta. **Counterfactual completion**: blank vulnerable line, measure exact-match recovery rate; >5% recovery means anonymization failed.
- **Keep transforms purely lexical** (rename, dead-string scrub, version-banner strip). **Do not touch field order, alignment attributes, or call graph** — Banescu et al. (USENIX 2017) on Tigress / OLLVM: control-flow flattening and opaque predicates frequently change struct layout via padding and let DCE remove the vulnerable path.
- **Diminishing returns on variant count hit fast.** LiveCodeBench / BabyLM analyses: >3 seeds × >2 temperatures rarely changes recognition rates. **N=3, M=2, K=2 is a reasonable starting grid.**
- **Shortcut-trace LLM-as-judge is weakly calibrated.** Zheng et al. (MT-Bench, 2023): ~80% agreement with humans on reasoning-vs-recall distinctions, with systematic bias toward calling fluent traces "discovered." Mitigations: **dual-judge with disagreement-flag → human review**; **calibrate on a held-out set of known-recognized traces** (give judge the original CVE writeup + trace and confirm it flags those); track judge-agreement rate as a workflow health metric, not a one-time validation.

**In or out of IronCurtain**

*Verdict:* Out

*Pros:*
- Anonymization is a lexical transform pass over harness source; shortcut-trace filter is an LLM-judge over already-captured JSONL. Neither needs runtime primitives.
- Membership-inference probes (Min-K%, DE-COP), counterfactual completion measurement, dual-judge calibration are all research-pipeline concerns.
- Co-located with the harness set (component 6), where the source-to-anonymize lives.

*Cons:*
- The shortcut-trace filter consumes post-pruned traces; another schema-coupling point with the IronCurtain capture format.

*Recommendation:* Out, in the `vuln-harnesses` repo (anonymization) and training-pipeline repo (shortcut filter). Both consume versioned schemas from IronCurtain.

### 8. Export

- Neutral intermediate JSONL with full provenance fields.
- Per-target-model serializers (Anthropic / OpenAI / Hermes / Mistral chat-template + tool-use formats) run as a downstream stage. Don't bake any specific chat template into the capture path.
- Failed traces retained and exported separately, labeled with FSM termination reason — useful for negative-example contrastive SFT and for diagnosing FSM weak points.

**Prior art & learnings**
- **Critical provenance fields** (AgentInstruct, ToolACE): `trace_id`, `source_run_id`, `policy_version_hash`, `model_id+version`, `tool_schema_hash`, `seed`, `sampler_params`. AgentInstruct teams couldn't reproduce regressions when only `model_name` was stored — minor checkpoint bumps silently changed traces.
- **Per-turn `tool_schema_snapshot`** as actual JSON schema, not a pointer (ToolBench retrospective: pointers go stale, replays produce arg-shape mismatches).
- **Separate `oracle_verdict` + `verdict_source` from trace success.** OpenHermes-2.5 cleanup found ~12% of "successful" traces had wrong tool args that happened not to crash. Store grader model and rubric version.
- **Preserve `turn_index → original_message_id` mapping** for post-dedup filtering and class-balance audits. ShareGPT's flat lists destroyed this.
- **Glaive-v2 / Hermes-2-Pro pattern wins for multi-target serialization**: one canonical message graph (role, content blocks, tool_call objects with stable IDs, tool_result with `call_id` reference) → N thin serializers. **ShareGPT-as-intermediate aged badly** — collapsing tool calls into stringified JSON inside `gpt` turns lost call/result pairing and broke parallel tool use entirely.
- **Keep `tool_call_id` as opaque string from capture**, not regenerated. Anthropic ↔ OpenAI round-tripping with regenerated IDs broke multi-turn traces in ToolLLM exports. Anthropic: `tool_use.id` (`toolu_*`) ↔ `tool_result.tool_use_id`; OpenAI: `tool_calls[].id` ↔ `tool.tool_call_id`.
- **Parallel tool calls vary by format**: Anthropic = N `tool_use` blocks; OpenAI = `tool_calls[]` array; Hermes = one `<tool_call>` block per call. **Mistral / Llama-3.1 require all parallel results bundled before the next assistant turn** — splitting produces template-render errors silently swallowed by `apply_chat_template`.
- **Don't bake chat templates into capture.** Llama-3.1, Qwen2.5, Mistral all shipped revised `tokenizer_config.json` post-release that changed tool-call delimiters. Datasets pre-rendered to strings became unusable. **`apply_chat_template(tools=...)` is the only durable target** — store messages in its expected shape and let the tokenizer render at train time, pinning `tokenizer_revision`.
- **Failed/negative traces are mostly noise for SFT.** ToolACE and Gorilla-OpenFunctions explicitly excluded failures from SFT; gains came from DPO/KTO pairs (`chosen=success, rejected=failure` on same prompt). Export failures separately with a `failure_mode` taxonomy (`bad_args`, `hallucinated_tool`, `wrong_tool`, `parse_error`) so they're available for preference training.
- **Versioning**: treat the intermediate JSONL as **immutable + content-addressed**; serializers are pure functions versioned alongside target `tokenizer_revision`. ToolBench's lack of this caused the v1→v2 "same dataset, different numbers" reproducibility crisis. Emit a `manifest.json` per export with `{intermediate_hash, serializer_version, tokenizer_revision, tool_format_spec}`.
- **Formats that aged badly**: ShareGPT `from/value` schema (lost tool semantics), stringified JSON tool calls inside content (unparseable after model paraphrasing), OpenAI singular `function_call` (silently dropped parallel calls). MCP has no standardized SFT export schema yet — **Anthropic Messages API tool-use shape is the closest stable superset** and converts cleanly to all four targets.

**In or out of IronCurtain**

*Verdict:* Out

*Pros:*
- Per-target chat-template serializers (Anthropic / OpenAI / Hermes / Mistral) require pulling in tokenizer configs and tracking `tokenizer_revision` — pure ML toolchain concerns.
- Failure taxonomy and DPO/KTO pair construction are training-data concerns, not mediation concerns.
- Content-addressed manifest design and pure-function serializers are cleanest as their own library with semver discipline.

*Cons:*
- The neutral intermediate format must agree with both the IronCurtain capture schema and the pruning pipeline's output — three-way coordination.

*Recommendation:* Out, in the training-pipeline repo. Treat the intermediate JSONL as a versioned contract owned there; IronCurtain only commits to a stable capture format.

## Architectural Placement

- **In-line on runtime path:** verbatim capture wrapper only (`src/agent/`).
- **Offline batch pipeline:** new module, e.g., `src/training-pipeline/`. Mirror the layering rules for `src/pipeline/`: offline-only, types-only imports from runtime, never runtime-imported by `session/`, `sandbox/`, `trusted-process/`, `workflow/`, etc.
- **FSM workflow:** standard workflow under `workflows/exploit-memory-corruption/`. No special runtime treatment beyond what the workflow system already provides.

## Phasing

Ordered so each phase produces a usable artifact even if downstream phases are unbuilt.

1. **Verbatim capture wrapper** — unblocks all downstream work; produces raw traces immediately.
2. **Memory-corruption FSM workflow** — first end-to-end run against a single seed target.
3. **Flag schema authoring** for the memory-corruption class.
4. **v0 target / harness set** — 3–5 targets with reliable oracles.
5. **Causal DAG construction + pruning.**
6. **CoT synthesis + validation loop.**
7. **Restitching + export.**
8. **Variant generator + shortcut-trace filter.**
9. **Iterate FSM and pipeline** against the full v0 target set; measure golden-trace yield per workflow run.

## Open Questions

- **Capture wrap point** — confirm it sits on the agent-process side of the Docker MITM so the captured stream contains sentinel credentials only.
- **Programmatic oracle implementation** — per target: instrument the harness directly, parse stdio, or attach an external debugger probe? Likely target-dependent; standardize the interface, not the mechanism.
- **Workflow driver model selection** — single frontier model across all targets (cleaner comparability) or per-target choice (richer trace diversity)?
- **Storage strategy** — full token streams are large. Compression scheme, sharding, retention policy. Likely: keep raw for golden-eligible runs, retain metadata-only for the rest.
- **FSM persona granularity** — eight states is a starting guess; the right number is whatever cleanly partitions tool-access policy without over-fragmenting the trace.

## Risks & Mitigations

- **Memorization leakage from historical targets** → anonymization at workflow input + shortcut-trace filter on the way out.
- **Plausible-CoT confabulation** → synthesize only on causally-pruned traces; validate every CoT by replaying it forward and confirming the original action.
- **Harness flakiness inflates failure rate** → reliability gate before a target enters the v0 set; flaky harnesses produce noisy oracles that poison both SFT filtering and RL reward.
- **FSM over-constrains the driver model** (forces script-following, kills trace authenticity) → transitions must be evidence-gated, never time-based or fixed-sequence.
- **Storage explosion** → compression, sharded JSONL, retain raw only for golden-eligible runs.
- **PII / credential leakage in tool results** → relies on the existing MITM sentinel-swap; if the capture boundary is wrong, this assumption silently breaks. Treat as a structural invariant to verify, not an empirical observation.
