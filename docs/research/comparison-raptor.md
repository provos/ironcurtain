# Comparison: RAPTOR vs IronCurtain `vuln-discovery`

A side-by-side look at gadievron/raptor and our `vuln-discovery` workflow. This is not a feature checklist — it's a structural comparison of how each system organises an LLM-driven vulnerability discovery pipeline, where they overlap, and where each is pointedly different.

References to raptor source are paths inside a clone of `https://github.com/gadievron/raptor` at commit `c6bf445` (HEAD on 2026-04-28). References to our workflow are line numbers in `src/workflow/workflows/vuln-discovery.yaml`.

---

## 1. What raptor is

RAPTOR ("Recursive Autonomous Penetration Testing and Observation Robot") is an autonomous offensive/defensive security framework that runs on top of Claude Code. It chains static analysis (Semgrep, CodeQL), binary analysis (AFL++, GDB, rr), LLM-powered exploitability validation, exploit-PoC generation, and patch generation into one workflow. Authors: Gadi Evron, Daniel Cuthbert, Thomas Dullien (Halvar Flake), Michael Bargury, John Cartwright. ([README.md:32-38](https://github.com/gadievron/raptor/blob/main/README.md))

The architecture is explicitly two-layered:

- **Python execution layer** — runs Semgrep / CodeQL / AFL++ subprocess work, parses SARIF, deduplicates findings, manages costs, dispatches LLM API calls. Does not "make decisions"; it "executes" ([README.md:236-245](https://github.com/gadievron/raptor/blob/main/README.md)).
- **Claude Code decision layer** — `.claude/commands/`, `.claude/skills/`, `.claude/agents/`, `tiers/`. Slash commands, skills, sub-agents, persona files. Decides what to investigate, interprets results, judges exploitability.

The `/agentic` command is the headline end-to-end flow: parallel Semgrep+CodeQL → dedup → per-finding LLM validation across Stages A→D → self-review (Stage F) → optional consensus second-opinion → exploit PoC → patch → cross-finding root-cause grouping ([.claude/commands/agentic.md:1-118](https://github.com/gadievron/raptor/blob/main/.claude/commands/agentic.md)). `/validate` is the same Stages-0→F validation pipeline as a standalone step ([.claude/skills/exploitability-validation/PIPELINE.md](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/PIPELINE.md)).

Public mentions:

- Dark Reading wrote up RAPTOR's patching capability with quotes from the authors. ([darkreading.com](https://www.darkreading.com/vulnerabilities-threats/new-raptor-framework-uses-agentic-ai-create-patches))
- Halvar Flake's blog post "Ask your LLM for receipts: What I learned teaching Claude C++ crash triage" (Dec 2025) describes the "receipts + validator agent" methodology that became RAPTOR's `crash-analysis` flow. ([addxorrol.blogspot.com](http://addxorrol.blogspot.com/2025/12/ask-your-llm-for-receipts-what-i.html))
- Hacker News thread, Nov 2025. ([news.ycombinator.com/item?id=46119042](https://news.ycombinator.com/item?id=46119042))
- tl;dr sec #307 covered it alongside FuzzForge AI and aliasrobotics/cai. ([tldrsec.com/p/tldr-sec-307](https://tldrsec.com/p/tldr-sec-307))

The headline real-world use is Halvar Flake using RAPTOR to generate patches for the FFmpeg "Project Zero" vulnerabilities; the patches "required some tweaks before finalisation" (per the Dark Reading writeup).

---

## 2. Architecture & agent design

### Top-level entry surface

Three command groups, all surfaced to Claude Code as slash commands:

1. **`/agentic`** — full workflow. Backed by `libexec/raptor-agentic`, which is a Python wrapper over `raptor_agentic.py` orchestrating Phase 1 (scan via `packages/static-analysis/scanner.py`), Phase 2 (`packages/exploitability_validation/`), Phase 3 (`packages/llm_analysis/agent.py`), Phase 4 (`packages/llm_analysis/orchestrator.py`). ([docs/ARCHITECTURE.md:806-832](https://github.com/gadievron/raptor/blob/main/docs/ARCHITECTURE.md), [packages/llm_analysis/orchestrator.py](https://github.com/gadievron/raptor/blob/main/packages/llm_analysis/orchestrator.py))
2. **`/validate`** — runs the Stages 0–F exploitability-validation pipeline standalone. Called via `libexec/raptor-validation-helper`. Each stage is a markdown skill file under `.claude/skills/exploitability-validation/`.
3. **Specialist commands** — `/understand` (attack-surface mapping, `--map` / `--trace` / `--hunt`); `/codeql` (CodeQL deep analysis with Z3 SMT pre-screening); `/fuzz` (AFL++); `/crash-analysis` (rr-replay + LLM root-cause); `/oss-forensics`; `/exploit`; `/patch`.

### The Stages 0–F validation pipeline (the part most comparable to our `vuln-discovery`)

Every finding goes through this sequence ([.claude/skills/exploitability-validation/PIPELINE.md:14-30](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/PIPELINE.md)):

| Stage | Type | Purpose | Output |
|-------|------|---------|--------|
| 0 | mechanical | Source inventory, SHA-256 per file, function extraction | `checklist.json` |
| A | LLM | One-shot exploitability + PoC sketch | `stage-a.json` (merged into `findings.json`) |
| B | LLM | Attack trees, hypotheses, `attack-paths.json`, PROXIMITY 0–10 score | 5 working docs |
| C | LLM | Sanity check — verify code matches, file exists, flow real, code reachable | `stage-c.json` |
| D | LLM | Ruling — apply D-1..D-4 disqualifiers, assign CVSS vector | `stage-d.json` |
| E | mechanical | Binary feasibility: PIE/RELRO/NX/Canary, glibc version, one-gadget, Z3 SMT | `stage-e.json` |
| F | LLM | Self-review for misclassification, weak evidence, missed instances | `stage-f.json` |
| 1 | mechanical | CVSS scoring, schema validation, report generation | `validation-report.md` |

Each stage has up to three sub-phases: `X0` (mechanical Python prep), `X` (LLM reasoning), `X1` (mechanical validation). Driven by `libexec/raptor-validation-helper {0,A,B,C,D,E,F}`. The convention is documented explicitly: letters = LLM reasoning, numbers = mechanical Python ([SKILL.md:130-150](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/SKILL.md)).

### MUST-GATEs

`SKILL.md:62-81` defines eight gates that all stages reference:
- GATE-1 ASSUME-EXPLOIT — investigate as if exploitable; lazy dismissal forbidden
- GATE-2 STRICT-SEQUENCE — out-of-band ideas go in a separate end section
- GATE-3 CHECKLIST — track compliance evidence
- GATE-4 NO-HEDGING — verify any "if/maybe/uncertain" claim or remove it
- GATE-5 FULL-COVERAGE — every function in `checklist.json` must be checked, no sampling
- GATE-6 PROOF — show the vulnerable code
- GATE-7 CONSISTENCY — `vuln_type`, `severity`, `status` must match `description`/`proof`
- GATE-8 POC-EVIDENCE — "ran without error" is not evidence; need observable effect

These are referenced per-stage (e.g. `stage-a-oneshot.md:134` lists "GATES APPLY: 1, 4, 6, 7, 8").

### Sub-agents

`.claude/agents/` holds 16 named sub-agents. Notable for our comparison:

- `exploitability-validator-agent.md` — orchestrates the 0–F pipeline, loads `SKILL.md` first. ([.claude/agents/exploitability-validator-agent.md:1-22](https://github.com/gadievron/raptor/blob/main/.claude/agents/exploitability-validator-agent.md))
- `crash-analyzer-agent.md` — produces a root-cause hypothesis from rr trace + gcov + ASAN trace. Numbered hypothesis files: `root-cause-hypothesis-YYY.md`. ([.claude/agents/crash-analyzer-agent.md:1-30](https://github.com/gadievron/raptor/blob/main/.claude/agents/crash-analyzer-agent.md))
- `crash-analyzer-checker-agent.md` — second LLM reads the hypothesis file, "with extreme care and thoroughness, validate and vet each individual statement against the empirical data available". Has explicit "STEP 0: Mechanical Format Verification (MUST DO FIRST)". The hypothesis-validate-rebuttal loop continues until checker approves. ([.claude/agents/crash-analyzer-checker-agent.md:1-30](https://github.com/gadievron/raptor/blob/main/.claude/agents/crash-analyzer-checker-agent.md))

### Specialist personas

`tiers/personas/*.md` — Mark Dowd, Halvar Flake, Charlie Miller, Patch Engineer, Fuzzing Strategist, etc. — loaded on demand via Claude Code's progressive context loading. Not state-machine roles; they are framings for individual prompts.

### Z3 SMT integration

Two distinct uses of Z3 ([README.md:123-135](https://github.com/gadievron/raptor/blob/main/README.md), [SKILL.md:213-258](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/SKILL.md)):

1. **CodeQL dataflow pre-screening** (`packages/codeql/smt_path_validator.py`) — before calling the LLM on a CodeQL finding, check whether the path constraints are jointly satisfiable. `unsat` → drop the finding (false positive); `sat` → produce concrete candidate inputs that go into the LLM prompt as `DataflowValidation.prerequisites`.
2. **One-gadget feasibility** (`packages/exploit_feasibility/smt_onegadget.py`) — checks whether a one-gadget's register/memory constraints are satisfiable against the actual crash state. Used during Stage E feasibility analysis.

Both are optional and degrade gracefully (`smt_available=False`) if `z3-solver` is not installed.

`stage-e-feasibility.md:152-258` documents the SMT path validator in detail, including the `--profile` flag for choosing bitvector width (`uint32`, `uint64`, etc.), the `_anon_N` free-variable handling for unparseable function calls, and the `unknown_reasons` error taxonomy.

### Cost / throughput controls

- `RAPTOR_MAX_COST=5.00` env var caps total spend. ([README.md:201-203](https://github.com/gadievron/raptor/blob/main/README.md))
- Per-task `budget_cutoff` in `packages/llm_analysis/tasks.py` (e.g. `ExploitTask.budget_cutoff = 0.85`, `ConsensusTask.budget_cutoff = 0.70`).
- Multi-provider model roles: `analysis`, `code`, `consensus`, `fallback`. Configured in `~/.config/raptor/models.json` or from env vars. ([README.md:151-198](https://github.com/gadievron/raptor/blob/main/README.md))

### Cross-finding analysis

`GroupAnalysisTask` in `packages/llm_analysis/tasks.py:179-233` runs after per-finding analysis: takes findings sharing a `criterion`/`criterion_value` (e.g. same root cause, same module), sends them as a batch to an LLM, asks "shared root cause? attack chaining? inconsistencies?".

### Self-consistency / retry

`RetryTask` in `packages/llm_analysis/tasks.py:236-318` is Stage F's mechanical complement: runs `_check_self_consistency`, finds findings where `is_exploitable` contradicts the `reasoning` text or where score lands in 0.3–0.7 (low confidence), and re-prompts with the contradiction quoted back: `"IMPORTANT: Your previous analysis of this finding contradicted itself: ..."`.

### Consensus

`ConsensusTask` (same file, lines 109–176) runs a *second model* on findings the primary marked exploitable and applies majority-of-three or any-of-two-says-exploitable rules. `primary["consensus"] = "disputed"|"agreed"`. This is opt-in via model role configuration.

---

## 3. Source code availability & maturity

- **License:** MIT, with a caveat — CodeQL has its own license that does not permit commercial use ([README.md:26](https://github.com/gadievron/raptor/blob/main/README.md), `LICENSE`).
- **Repo:** [gadievron/raptor](https://github.com/gadievron/raptor) — public, no required gating.
- **Activity (as of 2026-04-28):** stargazerCount 2383, forkCount 367, watchers 26, 9 open issues, 416 commits total.
- **First commit:** 2025-10-17. **First tagged release:** v3.0.0 on 2026-04-23.
- **Contributor distribution** (`git shortlog -sn HEAD`):
  - John Cartwright — 150 commits
  - Gadi Evron — 68
  - Claude — 46 (yes, the model is in `git log`)
  - mbrg (Michael Bargury) — 40
  - Daniel Cuthbert — 31
  - Michael Bargury — 23
  - Halvar Flake (Thomas Dullien) — 4
  - 14 other contributors with 1–7 commits each
- **Pace:** dense (2026-04-26 alone: 8 commits centralising `core/git`, `core/hash`, `core/exec` removal). 22 commits in the 24 hours preceding the snapshot. Significant late-stage work on the SMT path validator (PRs #225, #239, #241, #244, #247) and parallel CodeQL DB cache (#245).
- **Open governance discussion** ([issue #252](https://github.com/gadievron/raptor/issues/252)): authors openly debating whether to adopt a `bleeding`→`main` branch model and `feat:/fix:/security:/docs:` commit conventions. Quote: "we just forgo the rules and throw stuff out there. It works for most things but RAPTOR really grew faster than ourselves... We are currently seeing over 800 clones a day."
- **CI:** `.github/workflows/tests.yml`, `.github/workflows/bash-test.yml`. The repo has CodeQL scanning enabled on itself.
- **Notable PR #219** — "fix(web): enforce WebClient target scope across redirects" — fixed a self-found scoping bug in their own web scanner.

This is unambiguously a real, maintained project — fast-moving, multi-author, with active community uptake. It is also explicitly self-described as duct-taped: "It is not polished software. It was built in free time, held together with enthusiasm and duct tape, and it works well enough that we can't stop using it." ([README.md:36](https://github.com/gadievron/raptor/blob/main/README.md))

---

## 4. Side-by-side comparison

The most fair comparison is RAPTOR's `/validate` Stages 0–F pipeline against our `vuln-discovery` state machine, because both take "code in scope" → "validated finding with severity" with LLM reasoning at the core. RAPTOR's `/agentic` pipeline (which prepends Semgrep+CodeQL scan + dedup) is partly out-of-scope for us — we don't currently embed static analysis as a discovery seed.

| Concern | RAPTOR (`/validate` + `/agentic`) | `vuln-discovery` |
|---|---|---|
| **Discovery seed** | SARIF findings from Semgrep / CodeQL (or pre-existing findings JSON). Discovery is *driven* by static-analysis hits. ([.claude/commands/agentic.md:1-21](https://github.com/gadievron/raptor/blob/main/.claude/commands/agentic.md)) | LLM hypothesis-driven: orchestrator forms hypotheses from analyse-stage's "function catalog with assumption inventory" + "cross-cutting data flow analysis" (vuln-discovery.yaml lines 48-67). No static analyser in the loop. |
| **Scope / threat model** | Implicit in the SARIF results; user passes `--repo` and optionally `--understand` runs the attack-surface map first. Threat model is per-finding, derived during Stages B/D. | Explicit: task description is the source of truth for scope, vulnerability class, and threat model. Every agent re-reads it. (vuln-discovery.yaml lines 17-22: "Every agent must re-read the task description and let it override defaults in these prompts.") |
| **Hypothesis generation** | Stage A produces "candidate_reasoning" + PoC sketch per finding. Stage B builds full attack trees (`attack-tree.json`), `hypotheses.json` with predictions, `disproven.json`, `attack-paths.json`. Predictions must be value-level not pattern-level ([stage-b-process.md:50-56](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-b-process.md)). | Orchestrator forms hypotheses from analyse output and routes each to a tiered harness. Hypothesis is owned by the orchestrator's directive, not a separate file. The "Active hypothesis" lives in the journal status header (vuln-discovery.yaml lines 117-123). |
| **Harness construction** | Stage 0 creates `$OUTPUT_DIR/build/` for standalone PoC compilation. ASAN required. Stage A compiles PoCs in the sandbox via `libexec/raptor-run-sandboxed`. Single tier: just "compile and run with ASAN". ([stage-a-oneshot.md:165-177](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-a-oneshot.md)) | Three explicit tiers: T1 isolated function with stubs; T2 multi-component link-real-files; T3 full build with crafted protocol input (vuln-discovery.yaml lines 215-225). Tier choice is gated to hypothesis scope: cross-component → T2 minimum. |
| **Fuzzer-feedback as a first-class concern** | `/fuzz` exists for binary fuzzing via AFL++ (`raptor_fuzzing.py`) but is NOT part of the validation pipeline by default. A finding in `/agentic` is exercised by hand-built PoCs in Stage A. The validator does not gate on fuzzer-feedback metrics. | Central design constraint. `harness_design` requires the design to name "(a) fuzzer-feedback mechanism, (b) audit-coverage tool, (c) the exact metric field name the validator will read from the fuzzer's status output (e.g., libFuzzer `cov`, AFL++ `edges_found`)" (vuln-discovery.yaml lines 358-368). `harness_validate` step 4 fails approval unless target-code fuzzer-feedback count ≥ 1000 (vuln-discovery.yaml lines 551-562). |
| **Coverage discipline (target reached)** | Stage E uses `analyze_binary` for binary protections; coverage is via `gcov`/`llvm-cov` during `/crash-analysis`, but the `/validate` pipeline does not require coverage proof for the target function before declaring `not_disproven`. | "Target function reached: Run the harness coverage command. Verify the target function (not just the target file) appears with non-zero hits. If the file has coverage but the function does not, the call chain is broken — fail." (vuln-discovery.yaml lines 549-550) |
| **Validation gate before discovery starts** | Stage A runs immediately. The harness is the PoC itself; if compile+run works, you're in. | `harness_validate` is a separate state with its own `maxVisits: 4` cap; only approves on six explicit checks (vuln-discovery.yaml lines 538-563). Discover state is gated on harness approval. |
| **Sanity check for hallucination** | Stage C is a full mechanical sanity check: file exists, code matches verbatim, flow is real, code is reachable. "Open each file. Read the actual line. Verify verbatim. Do not rely on memory." Run by `libexec/raptor-validation-helper C`. ([stage-c-sanity.md:30-45](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-c-sanity.md)) | No equivalent dedicated sanity stage. The orchestrator's "Audit on return" rules check tier-vs-hypothesis match and require execution evidence (vuln-discovery.yaml lines 159, 165-179) but do not separately verify code-quote accuracy. |
| **Severity discipline** | Stage D mandates CVSS v3.1 vector per finding with explicit AV/AC/PR/UI/S/C/I/A. Score computed by `packages.cvss.compute_base_score` — "Do not estimate the score manually." Distinguishes inherent CVSS impact from binary mitigations (Stage E `feasibility.impact`). ([stage-d-ruling.md:142-165](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-d-ruling.md)) | Triage agent computes CVSS 3.1 anchored on demonstrated evidence (vuln-discovery.yaml line 703: "Severity score. CVSS 3.1, anchored on demonstrated evidence. Justify each metric against observations, not theoretical ceilings."). The "demonstrated vs theoretical" rule is explicit; no separate Python score computation. |
| **False-positive controls** | Stage D-1 (test/mock files), D-1.5 (privilege tautology), D-2 (preconditions chaining), D-3 (hedging language patterns), D-4 (no security impact). Each disqualifier is logged with code so audit trails distinguish "disproven hypothesis" from "test code" from "no impact" ([stage-d-ruling.md:58-140](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-d-ruling.md)). GATE-7 forbids inconsistent vuln_type/severity/description. | Triage agent enforces "Effect realism" categories: attacker-uncontrolled target state → genuine impact; round-tripped attacker input → no impact; constant/zeroed memory → no impact; non-exploitable error path → no impact (vuln-discovery.yaml lines 691-696). Triage's `insufficient` verdict bounces back to discover with a specific gap. |
| **Self-review** | Stage F is a dedicated LLM self-review pass: "What did I get wrong? Misclassifications, missed bug instances, wrong-index bugs, disproven claims still marked confirmed, confirmed claims with weak evidence" ([stage-f-review.md:48-58](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-f-review.md)). Plus mechanical `RetryTask` re-runs analyses with low confidence (0.3–0.7) or self-contradiction. | No standalone self-review pass. The orchestrator's "Audit on return" provides per-state quality gates (vuln-discovery.yaml line 159, 165-179, 195-201) but the agent does not review its own prior outputs. |
| **Consensus / second-opinion** | `ConsensusTask` runs a second model on each `is_exploitable: true` finding. 1 consensus model: any-says-exploitable wins; 2+ consensus: majority. Output marks `consensus: agreed/disputed`. Requires multi-provider config. | Not present. Single-model run; we do allow `harness_design_review` (visit cap 3) which is a fresh LLM call but on the design only (vuln-discovery.yaml lines 392-441). |
| **Journal / state** | Per-finding "carry-forward" — each stage writes `stage_X_summary` onto each finding object. Five working docs in Stage B (attack-tree, hypotheses, disproven, attack-paths, attack-surface) act as a knowledge graph. Append-only `disproven.json` records why hypotheses failed. | Single append-only `journal.md` at `.workflow/journal/journal.md`. Per-round Evidence/Assessment/Decision sections; status header updated in place. Only the orchestrator writes to it (vuln-discovery.yaml lines 109-145). |
| **Human gates** | None in the validation pipeline by default — `/agentic` runs end-to-end, you read the report. The `cli/--no-execute`-style escape valve is missing; user can always Ctrl-C. `prep_only` mode just means "no LLM available, here are the findings, you analyse." | Three named human gates: `human_escalation` (orchestrator stuck), `harness_design_escalation` (visit cap on design loop), `harness_validate_escalation` (visit cap on validation loop), `report_review` (final). Each takes APPROVE/FORCE_REVISION/ABORT events (vuln-discovery.yaml lines 274-295, 443-494, 812-830). |
| **Stall detection** | Implicit — `RAPTOR_MAX_COST` cuts the run; per-task `budget_cutoff` skips remaining work. No explicit "we've visited this state 3 times" rule. | Explicit: "Stall detection. If the same state has been visited 3+ times without progress, results contradict across layers, or you are uncertain about strategy, set verdict `escalate` rather than burning more rounds." (vuln-discovery.yaml line 235). State `maxVisits` enforced by the engine, with `isStateVisitLimitReached` guards routing to escalation gates. |
| **Model selection** | Multi-provider: Anthropic, OpenAI, Gemini, Mistral, Ollama. Roles: `analysis`, `code`, `consensus`, `fallback`. Different models per task type. Cost-table opinion: Ollama is fine for analysis, unreliable for exploit C code. ([README.md:151-205](https://github.com/gadievron/raptor/blob/main/README.md), [docs/ARCHITECTURE.md:972-1066](https://github.com/gadievron/raptor/blob/main/docs/ARCHITECTURE.md)) | Single model per workflow run (`anthropic:claude-opus-4-7`, vuln-discovery.yaml line 9). All states share it. |
| **Evaluation methodology** | Mostly anecdotal: FFmpeg "Project Zero" patches as the headline result; `docs/FUZZING_QUICKSTART.md:270-280` reports "Without autonomous: 6.12% coverage, 0 crashes / With autonomous: 48.98%, 1 crash" on `raptor_testbench`. No public CVE list in repo. No reproducibility harness. | No published evaluation; the workflow exists alongside design docs but no benchmark CVE list. Both are pre-evaluation in this regard. |
| **Sandbox / safety** | Compiles and runs PoCs through `libexec/raptor-run-sandboxed` (user-namespace based, `docs/sandbox.md`). PoCs must be "harmless" (`id` not `rm -rf`). | All execution happens inside the Docker agent container (workflow setting `mode: docker`, line 6). The host MITM + MCP proxies mediate filesystem and network. |

---

## 5. What raptor appears to do better

Concrete, with file references.

1. **Static-analysis seeding.** `/agentic` starts from Semgrep + CodeQL hits and dedups across both. ([.claude/commands/agentic.md:9-13](https://github.com/gadievron/raptor/blob/main/.claude/commands/agentic.md), [packages/static-analysis/scanner.py](https://github.com/gadievron/raptor/blob/main/packages/static-analysis)). For broad codebase sweeps this gives a finite, prioritised candidate list to validate, instead of asking the model to invent hypotheses from cold. We have nothing equivalent — `analyse` produces a function catalog and the orchestrator picks something to chase.

2. **Z3 SMT pre-screening that actually trims the candidate set.** [`packages/codeql/smt_path_validator.py`](https://github.com/gadievron/raptor/blob/main/packages/codeql) checks whether CodeQL dataflow path constraints are satisfiable *before* the LLM is invoked; `unsat` → drop, `sat` → inject the concrete witness as `DataflowValidation.prerequisites`. This is a real cost and false-positive lever, not a marketing item. Documented thoroughly with profile-mismatch failure modes (`stage-e-feasibility.md:198-258`).

3. **Hallucination check as a separate stage.** Stage C ([stage-c-sanity.md:36-80](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-c-sanity.md)) — file exists, code matches *verbatim*, flow is real, code is reachable — is its own LLM stage with its own pass/fail criteria, run with `libexec/raptor-validation-helper C` doing per-finding `checklist_verified` lookups against the inventory. Our orchestrator audits the *outcome* of agents but does not separately verify that the agent's quoted code actually exists.

4. **Self-review as a dedicated LLM stage, plus mechanical retry.** Stage F ([stage-f-review.md:48-58](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-f-review.md)) explicitly asks "What did I get wrong?" with concrete prompts (misclassifications, wrong-index bugs, missed instances). `RetryTask` ([packages/llm_analysis/tasks.py:236-318](https://github.com/gadievron/raptor/blob/main/packages/llm_analysis/tasks.py)) re-prompts findings whose `is_exploitable` contradicts their reasoning text, quoting the contradiction back at the model. Our workflow has no equivalent.

5. **Consensus across providers.** `ConsensusTask` ([packages/llm_analysis/tasks.py:109-176](https://github.com/gadievron/raptor/blob/main/packages/llm_analysis/tasks.py)) runs a second model on each `is_exploitable: true` finding and applies majority/any-says-yes voting. Output annotates `consensus: disputed/agreed`. Single-provider runs miss the "model A's hallucination corrected by model B" effect entirely.

6. **CVSS rigor — vectors first, scores by code.** Stage D requires the CVSS 3.1 vector per finding; the numeric score is then computed by `packages.cvss.compute_base_score`, "Do not estimate the score manually." ([stage-d-ruling.md:165](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-d-ruling.md)). They additionally separate inherent severity (CVSS) from achievability (Stage E `feasibility.impact`), preventing the "hardened binary makes everything Low" failure mode.

7. **Cross-finding analysis as a first-class task.** `GroupAnalysisTask` ([packages/llm_analysis/tasks.py:179-233](https://github.com/gadievron/raptor/blob/main/packages/llm_analysis/tasks.py)) explicitly asks "shared root cause? attack chaining? inconsistencies?" across findings sharing a criterion. We exit at the first confirmed finding with no equivalent stage.

8. **Disqualifier taxonomy with audit codes.** Stage D's D-0/D-1/D-1.5/D-2/D-3/D-4 ([stage-d-ruling.md:42-140](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-d-ruling.md)) lets a downstream consumer distinguish "ruled out because test code" from "ruled out because privilege tautology" from "ruled out because no security impact". Our triage's `insufficient` is a single bucket.

9. **Crash-triage receipts pattern (Halvar's contribution).** `crash-analyzer-agent` produces numbered hypothesis files; `crash-analyzer-checker-agent` "with extreme care and thoroughness, validate and vet each individual statement against the empirical data" with a mandatory "STEP 0: Mechanical Format Verification" before reading prose. The validator-rebuttal loop continues until checker approves. Documented with rationale at [addxorrol.blogspot.com](http://addxorrol.blogspot.com/2025/12/ask-your-llm-for-receipts-what-i.html). We don't have a similar two-agent vet-the-evidence-line-by-line setup.

10. **Operational maturity around real codebases.** rr deterministic replay, gcov/llvm-cov coverage manifests, ASAN as default, sandboxed PoC compilation/execution via `libexec/raptor-run-sandboxed`, `--privileged` devcontainer for rr support ([README.md:64-76](https://github.com/gadievron/raptor/blob/main/README.md)). Our workflow assumes the agent figures this out per run.

11. **Multi-provider model dispatch with cost roles.** `analysis` / `code` / `consensus` / `fallback` roles ([README.md:188-198](https://github.com/gadievron/raptor/blob/main/README.md)) plus `RAPTOR_MAX_COST` and per-task `budget_cutoff`. Cheaper models for analysis, frontier model for exploit C code. We use one model for everything.

---

## 6. What we appear to do better

1. **Tiered harness as a first-class concept, not "compile a PoC."** Three explicit tiers with hypothesis-scope-matching rules:
   > "Hypothesis names ONE function → Tier 1 / Hypothesis involves a value flowing between 2+ functions, or a sentinel/type used across components → Tier 2 minimum / Hypothesis requires real initialization, protocol framing, or global state → Tier 3 / Never use Tier 1 for a cross-component hypothesis. If in doubt, go higher." (vuln-discovery.yaml lines 222-225)
   
   RAPTOR's Stage A approach — extract a function, compile with ASAN, run a hand-built PoC — is roughly Tier 1 only. There is no equivalent in the validation pipeline of "the hypothesis crosses functions, therefore link the real source files."

2. **Fuzzer-feedback as a load-bearing validation gate.** The most concrete divergence:
   > "Approval requires evidence that the fuzzer's evolutionary feedback loop is reaching the target code — not just that an audit-coverage tool reports a line-coverage percentage. Audit coverage (`llvm-cov`, `gcov`, or the stack's equivalent) is orthogonal to fuzzer-feedback (libFuzzer's PC-guard counter, AFL++'s coverage map, or a runtime agent's instrumented-class report). A harness whose wrapper is the only unit with fuzzer-feedback instrumentation will report healthy line coverage AND burn millions of iterations on blind random mutation. Gate on the fuzzer's own self-reported feedback metric." (vuln-discovery.yaml lines 540-542)
   
   Concrete numeric thresholds: "Target-code fuzzer-feedback count ≥ 1000 (default)" and "Audit-coverage line coverage of the target source file ≥ 20%" (vuln-discovery.yaml lines 555-557). RAPTOR's `/fuzz` exists but is decoupled from `/validate` — a finding can be "validated" by Stage A without ever touching a fuzzer, and the validator has no way to detect "instrumentation-only-on-the-wrapper" silent failure.

3. **Detector-evidence ≠ impact-evidence is hard-coded.** Our orchestrator's audit rule:
   > "Detector evidence vs. impact evidence. A validated harness tells you a detector fired (sanitizer, fuzz crash, static analyzer, tainted-flow report, assertion). That proves the detector caught something; it does NOT prove an attacker can demonstrate impact in the real system... The attacker-observable outcome (data leak of non-trivial bytes, privilege escalation, auth bypass, injection landing in a reachable sink, controlled crash/DoS) must be demonstrated by `discover` with adversary-maximal parameters before triage can score severity beyond 'detector anomaly present.' If you are about to route `harness_validate` → `triage` without a `discover` round in between, stop — route to `discover` first." (vuln-discovery.yaml line 231)
   
   RAPTOR has GATE-8 ("PoC requires observable evidence"), but Stage A's `poc_success` verdict on a sanitiser crash will skip Stage B's deeper investigation via the "fast path" ([stage-b-process.md:90-95](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-b-process.md)). Our workflow forbids that shortcut.

4. **Triage's `insufficient` verdict closes the discover/triage loop.** Triage isn't a binary approve/reject:
   > "If triage returned `insufficient`: the triage agent found discover's evidence too thin for the severity it implied (e.g., a confidentiality claim anchored on zeroed padding instead of observed heap contents, or a theoretical OOB extent without a demonstration at adversary-maximal parameters). Route back to `discover` with a directive naming the **specific gap** triage identified. Do NOT retry triage without new discover output — that just reproduces the same insufficient assessment." (vuln-discovery.yaml line 199)
   
   Plus the realism categories: "Attacker's own input echoed / round-tripped back → no impact / Constant or neutral state (zeroed memory, schema-sanitized placeholder, default config, empty collection) → no impact / Non-exploitable error path (crash or assertion the attacker can't steer) → no impact" (vuln-discovery.yaml lines 691-696). RAPTOR's D-1..D-4 disqualifiers are similar in spirit but trigger at the per-finding ruling, not as a discover-loop feedback edge.

5. **Severity fidelity in the report.** The `conclude` agent is a translator, not a scorer:
   > "Severity for each finding MUST match triage's assessment in `.workflow/triage/triage.md` verbatim — same CVSS vector, same numeric score, same justification. Do not re-score. Do not strengthen 'Medium' into 'Medium-High' for emphasis. Do not add confidentiality-impact claims triage did not make. If triage did not assign a severity (e.g., finding returned `insufficient` or escalate), the report does not assign one either." (vuln-discovery.yaml line 737)
   
   Plus contradiction handling: "score at the **weaker** demonstrated level. Do not reconcile with 'the vulnerability is real, the sanitizer confirmed it' — that is papering over." (vuln-discovery.yaml line 741). RAPTOR's Stage 1 mechanically computes from final vectors; that prevents arithmetic drift but does not prevent Stage F from polishing language upward.

6. **Explicit "no findings is a valid outcome".** vuln-discovery.yaml line 233: "'No exploitable vulnerability found' is a valid and valuable outcome." With a dedicated `Findings without demonstrated impact` section in the report (vuln-discovery.yaml lines 770-778). RAPTOR's report structure assumes findings; "prep_only mode" exists but means "no LLM available," not "we looked and there's nothing."

7. **Human-gate cadence.** Three checkpointed human gates inside the workflow:
   - `human_escalation` when stuck (vuln-discovery.yaml lines 274-291)
   - `harness_design_escalation` on visit-cap (lines 443-466)
   - `harness_validate_escalation` on visit-cap (lines 468-494)
   - `report_review` at the end (lines 812-830)
   
   Each has APPROVE/FORCE_REVISION/ABORT events with explicit `resetVisitCounts` actions (line 460-462). RAPTOR runs end-to-end and asks the user to read the report after.

8. **State-machine visit caps that route to escalation, not to `complete`.** `harness_design_review.maxVisits: 3` (vuln-discovery.yaml line 396), `harness_validate.maxVisits: 4` (line 538), with the cap-guard transition ordered *before* the rejection transition so the cap wins on the Nth visit (line 437-441). RAPTOR has no equivalent — the loop is "until the LLM is satisfied or `RAPTOR_MAX_COST` triggers."

9. **Scoping directives as a contract.** Every downstream agent has a `First action` clause:
   > "if a 'Scoping from the previous agent' section is present at the top of this message, read its Directive and Notes subsections — they tell you what specifically to focus on this round... if it is missing or vague, STOP and report back with an `escalate`-style agent_status rather than improvising from the task description alone." (vuln-discovery.yaml line 34, similar at lines 300, 604, 650, 686)
   
   This makes the orchestrator's directive a typed, required input instead of a vibe. RAPTOR's stage prompts read prior stage outputs but don't have an explicit "stop and escalate if scope is unclear" gate.

10. **Threat model in the system prompt, re-applied per agent.** vuln-discovery.yaml lines 17-22: "Every agent must re-read the task description and let it override defaults in these prompts. Where a prompt says 'target file' or 'external entry point,' substitute what the task actually specifies." RAPTOR's threat model is implicit per-finding and emerges in Stage B/D rather than being declared up-front by the user.

---

## 7. Lessons to consider for our workflow

Each tagged: **(a) cheap-and-clear-win**, **(b) interesting-but-needs-design**, **(c) intentional-divergence-don't-copy**.

1. **(a) Mechanical sanity-check stage between analyse and discover.** Add a stage that opens the file, finds the line range the analyst quoted, and verifies the code matches verbatim. RAPTOR's Stage C is one focused LLM call with an explicit pass/fail rubric (file exists, code matches, flow real, reachable). Cost is negligible compared to a wasted harness round chasing a fabricated function. Reference: [stage-c-sanity.md:36-80](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-c-sanity.md).

2. **(a) Explicit disqualifier codes in triage.** Today triage emits `approved` / `insufficient` / `escalate`. Add a `disqualifier` enum on `insufficient` rulings — `test_code`, `privilege_tautology`, `chained_precondition`, `hedged`, `no_security_impact`, `attacker_input_round_tripped`, `zeroed_memory`. Lets the report distinguish "we couldn't demonstrate impact" from "the bug doesn't have impact." RAPTOR's D-0..D-4 plus realism categories (vuln-discovery.yaml line 691 already has prose for this) is the model.

3. **(a) Self-review pass before `conclude`.** A stage between `triage` and `conclude` that re-reads `findings.md`, `triage.md`, and `journal.md` and asks: "What did I get wrong? Did I miss instances of the same pattern in other parts of the analysis function catalog? Are any 'mitigated' verdicts only text-anchored? Are any CVSS vectors inconsistent with the demonstration?" Pattern from [stage-f-review.md:48-58](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-f-review.md). Single LLM call, low marginal cost, catches the failure mode where the orchestrator never re-examined an early `blocked` verdict.

4. **(b) Z3 path-condition pre-screening for analyse outputs.** When `analyse` flags a "type narrowing at storage boundaries" or "unbounded growth meeting fixed-size storage" pattern (vuln-discovery.yaml lines 56-67), it knows the type widths involved. Encode the visible guards as bitvector predicates and ask Z3 "are these jointly satisfiable in the dangerous region?" before committing a harness round. Output: a witness value to seed the fuzzer with. RAPTOR's [`smt_path_validator.py`](https://github.com/gadievron/raptor/blob/main/packages/codeql) is the reference. Needs design because:
   - Where does the predicate extraction live? (Probably an `analyse`-stage output we already produce.)
   - What's the trigger gate? (Tier-1 hypotheses with "type narrowing" or "unbounded growth" tags.)
   - Failure handling — `unsat` should not be authoritative if the predicate set is incomplete; trust only with the same caveats Halvar's docs apply.

5. **(b) Consensus / second-opinion gate on `triage approved`.** Run the triage prompt against a second model (e.g. a different provider) when the first model returned `approved` with HIGH severity. If they disagree, the orchestrator routes the case to `human_escalation` instead of `conclude`. Pattern from [`packages/llm_analysis/tasks.py:109-176`](https://github.com/gadievron/raptor/blob/main/packages/llm_analysis/tasks.py). Needs design because:
   - We currently use a single model per workflow (vuln-discovery.yaml line 9).
   - Adding a second provider means credentials, cost tracking, and a way to express "disagreement" in the journal.
   - Probably opt-in via a workflow setting rather than always-on.

6. **(b) "Receipts + checker" pattern for triage.** Halvar Flake's blog post argues that LLM hallucinations course-correct when forced to cite verifiable substeps. Our triage's nine-item rubric (vuln-discovery.yaml line 688) already moves in this direction; we could go further by splitting it: triage-A produces the report, triage-B reads triage-A's claims and validates each against discoveries/journal/coverage. The crash-analyzer/checker pattern in `.claude/agents/` is the reference. Worth designing carefully — adding a stage is cheap, but the checker's correction loop needs a max-iteration guard and an "agree to disagree → escalate" path.

7. **(c) Static-analysis seeding (Semgrep + CodeQL).** RAPTOR's `/agentic` is a different shape of workflow — the seed is a SARIF candidate list, the question is "is this real and exploitable?" Our `vuln-discovery` is hypothesis-driven from code reading. Adopting Semgrep+CodeQL would mean a new entry-point workflow (`vuln-validate`?) rather than a change to this one. Keep them separate. The Z3 pre-screening idea (#4) is the part of CodeQL integration worth importing in isolation.

8. **(c) Stage A's "PoC succeeds → fast-path Stage B" shortcut.** RAPTOR's [stage-b-process.md:90-95](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-b-process.md) auto-approves findings where Stage A's PoC succeeded with high confidence. We deliberately forbid this (vuln-discovery.yaml line 231: "If you are about to route `harness_validate` → `triage` without a `discover` round in between, stop"). Don't import; our rule is correct given the detector-evidence-vs-impact-evidence distinction.

9. **(c) Single `findings.json` with carry-forward stage summaries.** RAPTOR mutates a single growing JSON object; each stage adds `stage_X_summary`. We use append-only `journal.md` plus per-state artifacts. Their model reduces cross-file lookups but creates a brittle merge surface (the prep scripts have to merge per-stage updates correctly, see [stage-a-oneshot.md:104-127](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-a-oneshot.md)). Our journal-and-artifact model is auditable and survives state-machine revisions; don't unify.

10. **(c) Persona files (Mark Dowd / Charlie Miller / etc.).** We have a `persona` system already (`src/persona/`), but for `vuln-discovery` every state uses `persona: global`. Switching agents to specialised personas is a future option, not a clear win — the cost is more YAML, more compile cycles, more places for guidance to drift. Keep watching but don't import yet.

11. **(a) Stall-detection PR borrowed from RAPTOR's `RetryTask`: re-run findings whose `is_exploitable` contradicts the reasoning text.** We have stall-detection as orchestrator prose (vuln-discovery.yaml line 235), not as a programmatic check. Adding a small step between discover and triage that reads `findings.md` and flags "the prose says 'cannot be triggered' but the verdict is `approved`" is cheap. Reference: [`packages/llm_analysis/tasks.py:236-318`](https://github.com/gadievron/raptor/blob/main/packages/llm_analysis/tasks.py).

12. **(a) Coverage manifest convention.** RAPTOR's `core.inventory` produces a `checklist.json` with SHA-256 per file and per-function records, plus `checked_by` fields that track which agent visited each function. After multiple runs you can ask "what did the LLM never read?" Our `analyse` agent could emit a similar artifact (the function catalog already exists in prose); a structured form would let `report_review` flag coverage gaps mechanically rather than as a prose recommendation. Reference: [stage-0-inventory.md:30-69](https://github.com/gadievron/raptor/blob/main/.claude/skills/exploitability-validation/stage-0-inventory.md).

13. **(b) CVSS computation by code, vector by LLM.** Today triage emits a CVSS string and an interpretation. Adding a small Python module (or library call) that takes the vector and returns the score deterministically prevents one specific failure mode: the model "rounds" or "approximates" and the score drifts away from the vector. The validation report then verifies vector + score round-trip. Cheap once the vector is structured; the design question is where the validator runs (in-workflow, post-workflow CI?).

---

## 8. Open questions / things I couldn't determine

1. **CVE list / evaluation evidence.** RAPTOR's headline result is "FFmpeg Project Zero patches" via Halvar Flake's hand-driven session. I could not find a published evaluation list (e.g. "ran on N OSS projects, found M issues, P false positives") in the repo or Halvar's blog. The fuzzing benchmark in `docs/FUZZING_QUICKSTART.md:270-280` is one binary (raptor_testbench, internal). The Hacker News thread had only one comment. So I cannot say whether `/agentic` produces 5% or 50% false-positive rates in practice; only that the disqualifier taxonomy is designed to catch them.

2. **How often Stage F actually changes verdicts.** The `RetryTask` is in the code path; whether it routinely fires (i.e. how often the LLM actually contradicts itself on real findings) is not measured anywhere I could find. Same for `ConsensusTask` — agreement rates between providers are not published.

3. **Real-world `/validate` rounds-to-conclusion.** The pipeline is sequential 0→A→B→C→D→E→F→1 with no inner state-machine loops; if Stage C fails for many findings the pipeline doesn't bounce back to A. Whether that matters depends on Stage A's hallucination rate, which I couldn't measure from a static read.

4. **Sandbox completeness.** [`docs/sandbox.md`](https://github.com/gadievron/raptor/blob/main/docs/sandbox.md) describes a user-namespace based sandbox for `libexec/raptor-run-sandboxed`. Whether it actually contains a malicious PoC at the host-FS / host-network level on Linux as advertised, vs. our Docker `--network=none` model — I'd need to test, not just read.

5. **`/agentic`'s actual orchestration shape.** `packages/llm_analysis/orchestrator.py` is 628 lines; I read the surface (task dispatch, prior_results threading, consensus voting) but not the parallelism / cost-tracking internals. Whether it backs off on rate limits cleanly or burns budget on retries is unclear.

6. **Severity of the `git log` "Claude" author.** 46 commits authored by `Claude`. The repo evidently allows model-authored PRs at a non-trivial rate. I did not check whether they pass review or whether self-merges happen. Issue #252 ("Proper Engineering Approaches") suggests the authors are aware they're in startup-velocity mode and discussing how to mature the process.

7. **Whether the FFmpeg patches were upstreamed and accepted.** Halvar's tweet ([halvarflake/status/1985245014914429064](https://x.com/halvarflake/status/1985245014914429064)) is paywalled to me; the Dark Reading article says "patches required some tweaks before finalisation." Acceptance status by the FFmpeg project unclear from this side.

8. **Consensus model effect.** RAPTOR's "1 consensus model: any-says-exploitable" rule ([packages/llm_analysis/tasks.py:160-164](https://github.com/gadievron/raptor/blob/main/packages/llm_analysis/tasks.py)) is conservative-by-design. With two consensus models it switches to majority. The choice is presented without an evaluation behind it; I don't know whether they validated this on real data.

---

## Sources

- [gadievron/raptor on GitHub](https://github.com/gadievron/raptor)
- [README.md](https://github.com/gadievron/raptor/blob/main/README.md)
- [docs/ARCHITECTURE.md](https://github.com/gadievron/raptor/blob/main/docs/ARCHITECTURE.md)
- [.claude/skills/exploitability-validation/](https://github.com/gadievron/raptor/tree/main/.claude/skills/exploitability-validation)
- [.claude/commands/](https://github.com/gadievron/raptor/tree/main/.claude/commands)
- [packages/llm_analysis/tasks.py](https://github.com/gadievron/raptor/blob/main/packages/llm_analysis/tasks.py)
- [packages/exploit_feasibility/](https://github.com/gadievron/raptor/tree/main/packages/exploit_feasibility)
- [packages/codeql/](https://github.com/gadievron/raptor/tree/main/packages/codeql)
- [v3.0.0 release notes](https://github.com/gadievron/raptor/releases/tag/v3.0.0)
- [issue #252 — governance discussion](https://github.com/gadievron/raptor/issues/252)
- [Dark Reading — RAPTOR patches FFmpeg](https://www.darkreading.com/vulnerabilities-threats/new-raptor-framework-uses-agentic-ai-create-patches)
- [Halvar Flake — "Ask your LLM for receipts"](http://addxorrol.blogspot.com/2025/12/ask-your-llm-for-receipts-what-i.html)
- [Hacker News thread](https://news.ycombinator.com/item?id=46119042)
- [tl;dr sec #307](https://tldrsec.com/p/tldr-sec-307)
