# Comparison: Knostic OpenAnt vs IronCurtain `vuln-discovery`

This document compares the OpenAnt project from Knostic against the bundled `vuln-discovery` workflow shipped in IronCurtain. The goal is to identify what each does well, where their assumptions diverge, and which OpenAnt ideas are worth porting.

Sources:

- OpenAnt repository: https://github.com/knostic/OpenAnt
- OpenAnt blog post: https://www.knostic.ai/blog/openant
- OpenAnt landing page: https://www.knostic.ai/openant
- Local clone (read for line citations): `/tmp/OpenAnt` (commit `ec5213b`, indexed 2026-04-28)
- IronCurtain workflow: `/home/provos/src/ironcurtain/.claude/worktrees/fix-quota-error-routing/src/workflow/workflows/vuln-discovery.yaml`
- IronCurtain docs: `/home/provos/src/ironcurtain/.claude/worktrees/fix-quota-error-routing/WORKFLOWS.md`

---

## 1. What OpenAnt is

OpenAnt is an LLM-powered SAST (Static Application Security Testing) tool that scans an entire repository and emits a list of confirmed-exploitable findings, optimized to drive false positives down to near zero on web-style application code (XSS, SQL injection, command injection, path traversal, IDOR, SSRF, deserialization, prototype pollution, open redirect). It is structured as a sequential, batch pipeline that operates on a unit-of-code granularity (one function per unit, plus its callers/callees), not a hypothesis-driven investigation. See `README.md:5-18` and `libs/openant-core/OPENANT.md:1-3`.

The headline architectural idea is a **two-stage pipeline**: Stage 1 ("Detect") asks the LLM "is this code vulnerable?" with a simple prompt; Stage 2 ("Attack") forces the LLM to role-play as an attacker with only a browser and prove that the finding is exploitable. The slogan is "Stage 1 detects. Stage 2 attacks. What survives is real." (`README.md:5`). The blog post (https://www.knostic.ai/blog/openant) reports this eliminates "as much as 99.98% of false positives" on popular open-source projects.

The product comes from Knostic, an AI-security startup whose primary product line is governance for LLM-powered coding agents and MCP servers (https://www.knostic.ai). OpenAnt is explicitly positioned as orthogonal to Anthropic Claude Code Security and OpenAI Aardvark / Codex Security: per `README.md:13`, "we have zero intention of competing with them." The framing in the marketing copy is that OpenAnt is for OSS maintainers who want a free way to scan their own code, not a commercial competitor in the agent-security space.

Initial public commit was 2026-02-26 (per `git log`); first tagged release does not exist (no git tags) but `CHANGELOG.md:46` records "[2026-04-14] — Initial public release" and the most recent commit at clone time was 2026-04-27.

The repository ships:

- A Go CLI (`apps/openant-cli/`) that thins-shells over a Python core
- A Python "core" library (`libs/openant-core/`) with parsers, prompts, an agentic enhancer, a Stage-2 verifier, and a Docker-based dynamic tester
- Native parsers for Go (Go binary using `go/ast`), Python, JavaScript/TypeScript (Node), C/C++, PHP, Ruby, Zig (all six "beta" except Python and Go)

---

## 2. Architecture & agent design

### Pipeline shape (sequential, deterministic, no orchestrator agent)

OpenAnt's pipeline is a fixed 8-step sequence, encoded in Python orchestration (`libs/openant-core/core/scanner.py`) and exposed by the Go CLI as `openant scan`:

| Step | Component | Module | Source |
|------|-----------|--------|--------|
| 1 | Parse | language-specific parsers | `libs/openant-core/parsers/<lang>/` |
| 2 | Generate units | `unit_generator.*` per language | e.g. `parsers/python/unit_generator.py` |
| 3 | Entry-point reachability filter | `EntryPointDetector` + `ReachabilityAnalyzer` | `utilities/agentic_enhancer/{entry_point_detector.py,reachability_analyzer.py}` |
| 4 | Application context generation | `ApplicationContext` | `context/application_context.py` |
| 5 | Context enhancement (agentic) | `ContextAgent` | `utilities/agentic_enhancer/agent.py` |
| 6 | Stage 1: Detection | LLM call per unit | `prompts/vulnerability_analysis.py:166-202` |
| 7 | Stage 2: Verification | LLM agent w/ tools | `utilities/finding_verifier.py:288-427` |
| 8 | Dynamic testing | Docker exploit per finding | `utilities/dynamic_tester/` |

There is no orchestrator agent. There is no journal. The state machine is implicit in the order of Python function calls in `core/scanner.py`. Steps 3, 4, 5, 7, 8 are optional (`PIPELINE_MANUAL.md:182-184`).

The "two-stage" branding in `OPENANT.md` refers specifically to Stage 6 (detection) and Stage 7 (verification). The other steps are framing/filtering scaffolding.

### Stage 1 prompt design — deliberately simple

`libs/openant-core/prompts/vulnerability_analysis.py:16-23` gives the system prompt:

```
You are a security analyst. Analyze code for real vulnerabilities.

Be skeptical. Most code is not vulnerable. Only flag something as VULNERABLE if you can:
1. Construct a specific attack payload
2. Show exactly how it reaches a dangerous operation
3. Explain what unauthorized capability an attacker gains

If you can't do all three, it's probably not vulnerable.
```

The user prompt (`vulnerability_analysis.py:166-202`) uses 5-way verdicts: `safe | protected | bypassable | vulnerable | inconclusive`. The output schema requests `function_analyzed`, `finding`, `reasoning`, `attack_vector`, `confidence`, `cwe_id`, `cwe_name` — see `vulnerability_analysis.py:191-199`. Notable: the prompt explicitly asks the model to **state the function it is analyzing** before anything else (`vulnerability_analysis.py:172`), to stop the model from drifting into context-function vulns.

`OPENANT_TWO_STAGE_PLANNING.md:14` calls out the design philosophy: "Simple, direct prompts produce better results" — they removed earlier complex multi-step instructions.

### Stage 2 — "attacker simulation" with codebase tools

This is the most distinctive piece. `prompts/verification_prompts.py:16` system prompt: "You are a penetration tester. You only report vulnerabilities you can actually exploit." User prompt (`verification_prompts.py:78-161`) instructs the model: "You are an attacker on the internet. You have a browser and nothing else. No server access, no admin credentials, no ability to modify files on the server."

The agent runs up to 20 iterations (`finding_verifier.py:66 — MAX_ITERATIONS = 20`) using Claude Opus with five tools (`finding_verifier.py:71-183`):

- `search_usages` — find call sites
- `search_definitions` — find function definitions
- `read_function` — read full function source by ID
- `list_functions` — list functions in a file
- `finish` — emit verdict + structured `exploit_path` (entry_point, data_flow, sink_reached, attacker_control_at_sink, path_broken_at)

The structured `exploit_path` schema (`finding_verifier.py:144-170`) is what makes the verifier auditable: the model has to fill in entry_point, data_flow steps, whether the sink was reached, and where the path broke if it didn't.

The verifier's threading and rate limiting are real production code (`finding_verifier.py:332-347` — a global token bucket `RateLimiter` shared across worker threads, plus AnthropicErrorHandler propagation). It is built to run dozens of units in parallel.

Stage 2 verifies **all** Stage 1 findings, not just the vulnerable ones — so it can also flip protected → vulnerable when the model finds a bypass, as documented in `OPENANT_TWO_STAGE_PLANNING.md:198-203` (the Playwright/Puppeteer symlink-bypass corrections).

### Agentic enhancer — pre-classifies units

Before Stage 1, an "agentic enhancer" (`utilities/agentic_enhancer/agent.py`) uses Claude Sonnet with the same five exploration tools to label each unit as one of:

- `exploitable` — vulnerable + reachable from user input
- `vulnerable_internal` — vulnerable but only reachable internally
- `security_control` — defensive code (auth, validation)
- `neutral` — no security relevance

`agent.py:9-12` and `prompts.py` describe the scheme. The point is to **pre-filter** the dataset before paying for Stage 1: a 1,000-unit repo on `--processing-level exploitable` may shrink to ~10 units sent to Stage 1 (`OPENANT.md:34-39`). On the OpenSSL run reported in the blog, 15,232 units → 49 exposed → 28 potentially vulnerable → 3 confirmed exploitable, total cost $442.65 (https://www.knostic.ai/blog/openant).

### Application context — false-positive reduction by app type

`context/application_context.py` classifies the repo as one of `web_app | cli_tool | library | agent_framework`. The classification is fed back into Stage 1 and Stage 2 prompts (`vulnerability_analysis.py:154-159` and `verification_prompts.py:69-74`) with model-specific guidance — most importantly, for CLI tools the verifier is told the attacker has NO ability to run CLI commands locally, which short-circuits an entire class of false positives (path traversal via CLI args, etc.).

Manual override via `OPENANT.md` or `OPENANT.json` in the repo root (`PIPELINE_MANUAL.md:578` references `context/OPENANT_TEMPLATE.md`).

### Dynamic tester — Docker-isolated exploit confirmation

`libs/openant-core/utilities/dynamic_tester/`:

- `test_generator.py:32-108` — Claude Sonnet system prompt that generates a Dockerfile + test script + requirements + (optionally) docker-compose.yml from a finding
- `docker_executor.py:62-110` — pre-stages the vulnerable source file into the build context, sanitizes LLM-generated compose files
- `docker_executor.py:220` and `README.md:184-194` — containers run with `--read-only`, `--no-new-privileges`, `--memory 512m`, `--cpus 1`, isolated network, no host volume mounts, 120s timeout
- `result_collector.py` — parses container stdout, classifies as `CONFIRMED | NOT_REPRODUCED | BLOCKED | INCONCLUSIVE | ERROR`
- `docker_templates/attacker_server.py` — port-9999 capture server for SSRF / exfiltration tests, wired in via `docker-compose` `testnet` bridge network

The contract: the test container must print exactly one JSON object to stdout with `status`, `details`, `evidence[]` (`README.md:154-181`). On build/run failure, the error is fed back to Sonnet for **one** retry (`__init__.py:213-225`, `test_generator.py:245-298`). CWE-specific guidance in `test_generator.py:162-183` tailors the test for CWE-22, 78, 79, 89, 94, 134, 200, 502, 918.

### What OpenAnt does NOT have

Nothing in the repo references fuzzing, harnesses, sanitizer instrumentation (`grep -ri 'fuzz\|harness\|coverage' --include='*.py'` returns only doc-string mentions of "scan coverage" and `--memory 512m` for Docker). There is no `harness_validate`, no fuzzer-feedback metric, no LibFuzzer / AFL integration, no coverage-guided exploration. The dynamic tester is **one-shot exploit demonstration**, not iterative search. The blog acknowledges this gap explicitly for memory-safety bugs in C: "the quality of the generated test design is not always robust... particularly pronounced in C codebases" (https://www.knostic.ai/blog/openant).

---

## 3. Source code availability & maturity

| Attribute | Value | Source |
|-----------|-------|--------|
| License | Apache 2.0 | `/tmp/OpenAnt/LICENSE` |
| First public commit | 2026-02-26 | `git log --format=%ci \| tail -1` |
| First public release | 2026-04-14 | `CHANGELOG.md:46` |
| Latest commit (at clone) | 2026-04-27 (`ec5213b`) | `git log -1` |
| Total commits | 26 | `git log --oneline \| wc -l` |
| Tags / numbered releases | None | `git tag` returns empty |
| Stars | 503 | https://github.com/knostic/OpenAnt |
| Forks | 77 | https://github.com/knostic/OpenAnt |
| Open issues | 7 | https://github.com/knostic/OpenAnt/issues |
| Distinct authors | 7 | `git log --format=%an \| sort -u` |
| Test files | 7 (~1,089 lines total) | `libs/openant-core/tests/` |
| CI | gitleaks workflow only | `.github/workflows/gitleaks.yaml` |

Authors: Alexander Raihelgaus, Gadi Evron, Imri Goldberg, Nahum Korda, Sounil Yu, ar7casper, yotamelo (`git log --format=%an | sort -u`). Acknowledgments in `README.md:32-34` attribute research/ideation to Nahum Korda (former CTO at security firms; now affiliated with Knostic).

The codebase is moderate-sized: ~9,500 lines of Python in `libs/openant-core/` (core, prompts, utilities, parsers), ~3,000 lines of Go in `apps/openant-cli/`. Tests cover narrow concerns: dedup logic, CWE tagging, evidence-tier rollup, agreement filtering, the Docker scaffold, silent-401 handling. There is no end-to-end test of a real LLM run.

The CHANGELOG `Unreleased` section as of 2026-04-27 reads like recent shipping fixes — disclosure source-fidelity, CWE tagging, dynamic-test scaffolding, Docker UUID prefixes, agreement-filter on final verdict — i.e. the project is actively iterating on production-grade plumbing, not just research code.

Open issues (#16, #17, #18, #21) include feature requests around Express anonymous-handler parsing, diff-based analysis, LLM-driven reachability review, and Windows compatibility. None are claims of false positives in the wild.

**Verdict:** OpenAnt is roughly two months old as a public project, batch-pipeline shaped, with one significant author and a small support cast. It is more mature than a research prototype (parallelism, checkpointing, rate limiting, Docker isolation are all real) but less mature than an enterprise SAST product (no test of the LLM logic, no released CVEs cited by ID, no signed releases).

---

## 4. Side-by-side comparison

| Axis | OpenAnt | IronCurtain `vuln-discovery` |
|------|---------|------------------------------|
| **Shape** | Sequential 8-step pipeline, deterministic ordering | State machine with orchestrator router and human gates (`vuln-discovery.yaml:78-272`) |
| **Granularity** | One function per unit; pipeline runs on every unit independently | One investigation per workflow run; targets a *task description* that scopes a file/dir/subsystem (`vuln-discovery.yaml:17-22`) |
| **Scope of vulns** | Web-app vuln classes: XSS, SQLi, IDOR, SSRF, command/path injection, prototype pollution, deserialization (`OPENANT.md:374-381`) | Vuln class is a parameter — task description names the class and threat model (`vuln-discovery.yaml:18-20`); prompts are deliberately class-agnostic with cross-cutting type-narrowing / sentinel / unbounded-growth patterns mentioned (`vuln-discovery.yaml:55-67`) |
| **Hypothesis generation** | Implicit in Stage 1's classification on each unit; no named hypothesis | Explicit: orchestrator must produce a directive naming "the hypothesis to test and any specific trigger conditions" (`vuln-discovery.yaml:163-164`); refusing to write a directive is itself a signal to escalate (`vuln-discovery.yaml:99-105`) |
| **Harness construction** | None. Dynamic tester generates a one-shot Docker exploit per finding | Tiered: T1 isolated function, T2 multi-component, T3 full build with sanitizers (`vuln-discovery.yaml:215-225`); design → review → build → validate sub-loop |
| **Fuzzer-feedback validation** | None | Hard requirement: `harness_validate` step 4(a) gates approval on the fuzzer's self-reported coverage metric crossing a threshold (default ≥1000 PC-guard hits / edge counts), step 4(b) on audit-coverage ≥20% (`vuln-discovery.yaml:551-562`) |
| **Discover/triage loop** | No iteration. Stage 1 → Stage 2 → done. Dynamic tester only retries once on build failure (`__init__.py:213`) | Discover and triage are separate states with distinct verdicts and re-routing rules; triage's `insufficient` verdict bounces back to discover with a named gap (`vuln-discovery.yaml:199-201`, `707-708`) |
| **Journal / state** | None — Python workspace files (`pipeline_output.json`, `experiment_*.json`); no narrative log of what was tried | Append-only investigation journal at `.workflow/journal/journal.md` with status header and per-round Evidence/Assessment/Decision sections (`vuln-discovery.yaml:111-142`) |
| **Human gates** | None in the pipeline. The `VULNERABILITY_HUNTING_PROTOCOL.md:10-12` lists "Always ask user before selecting a repository" / "Report results and request approval before each major stage" — but this is a protocol document for human operators driving the CLI, not a state-machine gate | Three formal `human_gate` states (`human_escalation`, `harness_design_escalation`, `harness_validate_escalation`, `report_review`) with `APPROVE`/`FORCE_REVISION`/`ABORT` events and counter-reset actions (`vuln-discovery.yaml:274-291`, `443-466`, `468-494`, `812-830`) |
| **Severity discipline** | Stage 1 emits CWE; verifier emits `attacker_control_at_sink ∈ {full, partial, none}`. No CVSS scoring in prompts. Final verdict bucket: vulnerable / bypassable / protected / safe / inconclusive | Triage agent runs CVSS 3.1 anchored on demonstrated evidence, and is required to triage 9 specific axes (reproduction, effect realism, control surface, adjacency, channel reality, hardening, external trace, dup/CVE check, severity score) (`vuln-discovery.yaml:688-704`) |
| **False-positive controls** | (a) Stage 2 attacker simulation with browser-only constraint; (b) `application_context` (CLI tool / library bypass); (c) Stage 2 `path_broken_at` field; (d) Dynamic test `BLOCKED` outcome | (a) Detector-vs-impact distinction baked into orchestrator prompt (`vuln-discovery.yaml:230-232`); (b) triage's "effect realism" categories — attacker-input round-tripped vs. zeroed memory vs. uncontrollable error (`vuln-discovery.yaml:691-696`); (c) `discover` `blocked` requires execution evidence, not text reasoning (`vuln-discovery.yaml:629-630`) |
| **Model selection** | Hardcoded: Opus for Stage 1+2 (`finding_verifier.py:65 — VERIFIER_MODEL = "claude-opus-4-6"`), Sonnet for agentic enhancer (`agent.py:29`) and dynamic tester (`test_generator.py:19 — claude-sonnet-4-20250514`) | Per-state and per-workflow model overrides via `model:` field (`WORKFLOWS.md:291-343`); workflow defaults to `anthropic:claude-opus-4-7` (`vuln-discovery.yaml:9`) |
| **Eval methodology** | Tested against fixture datasets: object-browser (25 units, 0 false positives reported in `OPENANT.md:425-436`), Flowise 13 units, geospatial 12 units, GitHub patches (33 samples, 75.8% accuracy in `OPENANT.md:439-447`); blog reports OpenSSL/WordPress/LangChain/Rails/Grafana cost figures but no precision/recall numbers | No published evaluation; the workflow has no fixture-based scorecard. (See "Open questions" below.) |
| **Concurrency** | Per-step `ThreadPoolExecutor`, default 8 workers (`scan.go:58`), shared `RateLimiter` token bucket (`utilities/rate_limiter.py`) | Workflow is single-investigation, sequential by design; `sharedContainer: true` (`vuln-discovery.yaml:8`) shares one Docker bundle across states |
| **Sandbox** | Docker `--read-only --no-new-privileges --memory 512m`, isolated network, no host mounts (`docker_executor.py:215-225`, `README.md:184-194`) | Docker shared container with `--network=none` (per IronCurtain's docker mode), policy-engine-mediated tool calls, agent runs Claude Code with proxied filesystem MCP |

### Where the two converge

Both projects:

- Use Claude Opus for the heaviest reasoning step
- Distinguish "detector caught something" from "attacker can demonstrate impact" (the design rationale is identical even though OpenAnt's name is "attacker simulation" and IronCurtain's is "detector evidence vs impact evidence" — `vuln-discovery.yaml:230-232`)
- Run untrusted exploit code in a Docker container with read-only filesystem, no privilege escalation, capped memory
- Insist that exploitability claims have execution evidence, not just code reading

The convergence is striking enough that it's worth naming: **both teams independently identified that "make the LLM prove the exploit, not just describe it" is the load-bearing trick for cutting false positives in LLM-driven vuln discovery.** OpenAnt does it via the role-play constraint ("you have a browser and nothing else"). IronCurtain does it via a tier-aware harness pipeline that gates approval on real fuzzer feedback.

### Where they fundamentally diverge

OpenAnt is a **scanner** for repositories: feed it a repo, get a list of findings ranked by severity. The unit of work is a function. The output is `pipeline_output.json` and a markdown report.

IronCurtain `vuln-discovery` is an **investigator** for hypotheses: feed it a target (a file/dir/subsystem) plus a vulnerability class plus a threat model, and it iterates until it confirms-or-disconfirms a vulnerability of that class. The unit of work is a hypothesis. The output is a journal of what was tried plus a triaged report.

This is reflected at every level. OpenAnt's `experiment.py` runs all units in parallel and writes a flat results list. IronCurtain's orchestrator routes between states and updates a single journal. OpenAnt has no concept of "tier" because every code path through the pipeline is the same regardless of vuln class; IronCurtain's tier exists specifically because memory-safety bugs need real builds with sanitizers and protocol-injection bugs need full-stack drivers.

---

## 5. What OpenAnt appears to do better

These are concrete, anchored. No platitudes.

**1. Reachability filtering before paying for LLM analysis.** `utilities/agentic_enhancer/{entry_point_detector.py,reachability_analyzer.py}` builds a real call graph from the parser's `analyzer_output.json`, identifies HTTP/CLI/WebSocket/decorator entry points, and BFS-traverses the reverse call graph. `OPENANT.md:34-39` and the blog post claim a 60-95% unit reduction on real repos. IronCurtain `vuln-discovery` has no equivalent: the `analyze` agent does call-graph tracing manually as part of its prompt (`vuln-discovery.yaml:40` — "trace backward from the in-scope functions") but it's done by the LLM, not by code, and doesn't compose with cost-driven filtering.

**2. CodeQL pre-filter as a free signal.** `REPOSITORY_INSPECTION_PROTOCOL.md:114-178` and processing-level `codeql` (`OPENANT.md:33-49`) **exclude** units that CodeQL already flags, on the principle that those are caught by traditional SAST and OpenAnt should chase the misses. This is a clever inversion of the usual "use CodeQL to seed your LLM" pattern. IronCurtain has no CodeQL or any other static-analysis seeding.

**3. Application-context-driven prompt customization.** `prompts/vulnerability_analysis.py:144-152` generates different "where does input come from" question text for `cli_tool`/`library` vs `web_app`. A CLI tool's local-user attacker model is fundamentally different from a web app's remote-attacker model, and OpenAnt encodes that in the prompt. IronCurtain's `vuln-discovery` punts the entire threat-model statement to the human's task description (`vuln-discovery.yaml:18-22`), which is *more* flexible but easier for a careless operator to leave under-specified.

**4. Structured `exploit_path` schema in the verifier's `finish` tool.** `finding_verifier.py:144-170` requires the verifier to emit `entry_point`, `data_flow[]`, `sink_reached: bool`, `attacker_control_at_sink: full|partial|none`, `path_broken_at: string|null`. This makes the verifier output mechanically auditable. IronCurtain's `triage.md` is a free-form markdown document constrained only by "produce 9 items"; a tighter schema would help downstream tools consume triage results.

**5. Dedup, evidence-tier rollup, and CWE tagging are explicit modules.** `tests/test_dedup.py`, `test_evidence_tier.py`, `test_cwe_tagging.py`. The `CHANGELOG.md` "Unreleased" section calls out call-graph-aware deduplication, dynamic > verified > static evidence-tier ordering, and systematic CWE tagging on every finding. These are unglamorous but real reporting concerns IronCurtain doesn't address.

**6. Atomic, language-aware unit packaging.** Each "unit" carries primary code + its caller/callee deps + file boundary markers (`>>> ANALYZE THIS FUNCTION ONLY <<<` / `>>> END OF TARGET FUNCTION <<<` in `vulnerability_analysis.py:124-141`) so the LLM can never get confused about which function it is supposed to analyze. IronCurtain has no equivalent format — the `analyze` agent writes free-form markdown and downstream agents have to re-extract.

**7. Ground-truth challenger.** `utilities/ground_truth_challenger.py` is a documented module for arbitrating Stage 1 vs Stage 2 disagreements with a third LLM call. Whether or not it changes verdicts in practice is unclear from the code I read, but the *concept* — explicit reconciliation when two LLM rounds disagree — is something IronCurtain's `differential_validate` only partially addresses.

**8. Post-hoc dedup of findings via call graph.** Per `CHANGELOG.md` Unreleased section: "When two findings share a sink/vector and the call graph records an edge between them, they collapse into a single finding." IronCurtain does not deduplicate findings — each `discover → triage → conclude` arm produces independent output.

**9. Sanitization of LLM-generated docker-compose.** `docker_executor.py:41-59` `_sanitize_compose()` strips obsolete `version:` keys and rewrites remote `image:` references to local builds. This is the kind of detail you only learn by running real LLM-generated infra and watching it fail. IronCurtain's harness build agent is told to install dependencies eagerly (`vuln-discovery.yaml:521`) but doesn't have the same defensive post-processing on build artifacts.

---

## 6. What we appear to do better

**1. Tiered harness construction with explicit fuzzer-feedback gating.**

Quote from `vuln-discovery.yaml:551-562`:

> Run a short representative fuzz burst (30–60s) from the seed corpus. Capture the fuzzer's own reported coverage metric:
> - libFuzzer: stderr prints `#N ... cov: C ft: F`. Record `C`.
> - AFL++: `afl-fuzz` reports `map density` / `edges found`; `afl-showmap` on a sample prints non-zero map entries. Record the edge count.
> ...
> Fail approval unless BOTH:
> (a) Target-code fuzzer-feedback count ≥ **1000** (default; configurable via directive). A count in the tens is the signature of wrapper-only instrumentation.
> (b) Audit-coverage line coverage of the target source file ≥ **20%** (default; configurable via directive) after the burst.

OpenAnt has nothing like this. Its dynamic tester runs a hand-coded exploit for ≤120 seconds and reports CONFIRMED/NOT_REPRODUCED. There is no concept of fuzzer feedback, no concept of "the harness compiled but coverage shows the target function was never reached." For memory-safety bugs in C and for any non-trivial protocol-state vuln, this matters: a Tier-3 harness with libFuzzer and ASAN gated on `cov:` ≥ 1000 will find bugs OpenAnt's one-shot Docker test cannot.

**2. The orchestrator forces a directive or escalates.**

Quote from `vuln-discovery.yaml:97-105`:

> A clear, actionable instruction for whichever agent you are dispatching to. ... Aim for 1,500–4,000 characters of concrete scoping, not a one-liner.
>
> **The directive is REQUIRED.** If you cannot write a concrete, specific directive — if the best you can produce is "continue investigating" or "pick something reasonable" — the investigation is stalled. Set verdict to `escalate` and in the escalation describe what's unclear

This is a structural defense against an LLM that pattern-matches on "looks productive" and burns rounds. OpenAnt has no analog because OpenAnt has no orchestrator agent. The pipeline runs no matter what; the operator is the one who notices it's making no progress.

**3. Fuzzer-feedback approval bug as a documented prompt-conformance failure.**

Quote from `vuln-discovery.yaml:159`:

> If (b) is absent from an `approved` validation report, that is a prompt-conformance failure in `harness_validate` itself — do NOT bounce back to it. The state's own prompt forbids approval without (b), so repeat invocations are unlikely to self-correct, and `harness_validate`'s approved transition is declared before the visit-cap escalation guard, so the guard never fires on approved verdicts (a buggy validator can keep re-entering the harness pipeline until the workflow-level round cap kicks in). Instead, set verdict `escalate` and route to `human_escalation` so a human can diagnose...

This is the kind of operational hardening that comes from running the workflow and watching it fail. OpenAnt's verification step has no analogous failure mode (it doesn't have multi-round reentry between harness states), but the discipline of *naming* a specific failure mode and prescribing the routing fix is something OpenAnt's prompts mostly don't do.

**4. Severity is anchored on demonstrated evidence, not theoretical maximum.**

Quote from `vuln-discovery.yaml:684`:

> **Core rule.** Severity is anchored on what discover actually observed, never on the theoretical maximum implied by the vulnerable code. A detector firing on an isolated harness (sanitizer, fuzz crash, static analyzer, tainted-flow report, assertion, SAST rule) proves the detector caught something — it does NOT prove attacker-visible impact. Confidentiality/integrity/availability claims require discover to have observed the corresponding effect in a production-equivalent environment. When the demonstrated observation is weaker than the theoretical ceiling, score the demonstrated level and label the ceiling as such.

OpenAnt's verifier prompt says "Only conclude PROTECTED or SAFE if ALL approaches fail. If ANY approach succeeds, conclude VULNERABLE" (`verification_prompts.py:158-160`) — a similar idea, but expressed as a verdict rule rather than as a CVSS scoring discipline. The triage step in `vuln-discovery.yaml:688-704` requires nine itemized axes; OpenAnt's verifier has five tools and a free-form `explanation` field.

**5. Triage `insufficient` is its own verdict with a routing rule.**

Quote from `vuln-discovery.yaml:707-708`:

> - **insufficient**: Evidence does not support the severity the finding would warrant, OR discover has not demonstrated the attacker-visible effect at all. Notes MUST name the specific experiment discover needs to run — the parameter to sweep, the mitigation to exercise, the adjacency to verify, the hardening profile to rebuild under. Generic requests ("do more discovery") are not acceptable; the orchestrator needs a directive it can hand to discover verbatim.

This is the workflow's analog of OpenAnt's Stage 2 returning "protected." But where OpenAnt just emits the verdict and the run ends, IronCurtain returns to the loop with a *named* missing experiment. For deep memory-safety bugs where the first attempt at a harness misses a code path, this iteration is essential; OpenAnt's pipeline cannot self-correct in this way.

**6. Detector evidence vs impact evidence as a workflow-level rule, not a verdict label.**

Quote from `vuln-discovery.yaml:230-232`:

> **Detector evidence vs. impact evidence.** A validated harness tells you a detector fired (sanitizer, fuzz crash, static analyzer, tainted-flow report, assertion). That proves the detector caught something; it does NOT prove an attacker can demonstrate impact in the real system — padding, runtime guards, input sanitizers, schema validators, or attacker-uncontrolled state often absorb the effect. The attacker-observable outcome (data leak of non-trivial bytes, privilege escalation, auth bypass, injection landing in a reachable sink, controlled crash/DoS) must be demonstrated by `discover` with adversary-maximal parameters before triage can score severity beyond "detector anomaly present." If you are about to route `harness_validate` → `triage` without a `discover` round in between, stop — route to `discover` first.

OpenAnt has no such routing rule because there's no router. Stage 2 either confirms or doesn't. There is no "the sanitizer fired but you haven't shown the attacker sees the leaked bytes" interlock.

**7. Memory-safety / type-narrowing / sentinel-collision focus in the analysis prompt.**

Quote from `vuln-discovery.yaml:55-67` (cross-cutting data-flow analysis section in the `analyze` agent):

> - **Type narrowing at storage boundaries.** Where does a wider type get stored into a narrower container...
> - **Sentinel and magic value reachability.** Identify every sentinel or magic value used in the code...
> - **Check-use separation.** Where is a value validated in one place and consumed in another? Can the value change between the check and the use...
> - **Unbounded growth meeting fixed-size storage.** Where does a counter or accumulator grow without a hard cap?
> - **Arithmetic result range vs destination range.** Where can a multiplication, addition, or shift produce a value that exceeds the range of its destination type or comparison operand?

These are the patterns that find CVE-grade memory bugs in C. OpenAnt's prompts do not enumerate them. OpenAnt's "supported" languages list (`README.md:25-31`) flags C/C++ as **beta** and the blog post acknowledges memory-management complexity is "particularly pronounced in C codebases" — so OpenAnt is, structurally, the worse fit for `libavcodec`-style bug hunting.

**8. Sandboxed agent execution via policy engine, not just Docker.**

This is an IronCurtain-platform property rather than a `vuln-discovery` workflow property, but it deserves mention: every tool call from the `vuln-discovery` agents passes through the policy engine before reaching the MCP server (`CLAUDE.md:32` in the worktree root). OpenAnt's agents use raw `anthropic.Anthropic` clients with no mediation (`finding_verifier.py:274`). For an open-source vuln scanner this is fine; for a workflow that lets agents `execute_code` and write to the workspace, it's a real defense-in-depth difference.

---

## 7. Lessons to consider for our workflow

Tagged: (a) cheap-and-clear-win, (b) interesting-but-needs-design, (c) intentional-divergence-don't-copy.

### (a) Cheap-and-clear-win

**L1. Steal the `>>> ANALYZE THIS FUNCTION ONLY <<<` / `>>> END OF TARGET FUNCTION <<<` markers in the analyze agent.** OpenAnt's `vulnerability_analysis.py:124-141` uses these explicit markers to prevent the LLM from confusing target code with context code. The `analyze` agent in `vuln-discovery.yaml:48-67` enumerates "function catalog" entries but doesn't use markers to delimit them in the eventual prompt to downstream agents. When `harness_design` reads `analysis.md`, it should get function-by-function blocks bracketed unambiguously. **Action:** add a section-marker convention to the `analyze` agent's output schema.

**L2. Application-context awareness in the orchestrator's first directive.** OpenAnt asks the user (or detects automatically) whether the target is `web_app | cli_tool | library | agent_framework` and threads that into Stage 1/2 prompts. Our `vuln-discovery.yaml` punts everything to the task description. The orchestrator's cold-start branch (`vuln-discovery.yaml:88-91`) could call out application type as a required field in the task or default-derive it from the workspace. **Action:** add a one-line "application type / threat model class" hint to the cold-start journal header.

**L3. Verdict-bucket simplification on triage.** OpenAnt's 5-bucket verdict (`safe | protected | bypassable | vulnerable | inconclusive`) is simpler than CVSS for early-stage findings. Our triage produces CVSS, which is correct for confirmed findings, but for the routing decision back to `discover` we mostly only care about a coarser axis: confirmed / detector-only / mitigated / insufficient. **Action:** consider a coarser-grained `severity_bucket` field on triage output that maps to the routing decision, with CVSS as a secondary detail. This is small but might reduce orchestrator misrouting.

**L4. Structured `exploit_path` field on `discover` output.** OpenAnt's `finding_verifier.py:144-170` defines `entry_point / data_flow[] / sink_reached / attacker_control_at_sink / path_broken_at`. Our `discover` writes free-form findings to `findings.md`. Add a YAML block at the top of each finding with these five fields. **Action:** edit the `discover` prompt to require the structured block; have triage validate it before scoring.

**L5. CWE-specific guidance in the discover prompt, gated on the task's vulnerability class.** OpenAnt's `dynamic_tester/test_generator.py:162-183` has a `_get_cwe_guidance()` switch keyed on CWE id (22, 78, 79, 89, 94, 134, 200, 502, 918). When the task description names a class, the discover prompt could append the relevant guidance string. This costs almost nothing and gives the model concrete payload-shape hints. **Action:** add a guidance map keyed on CWE; include only the matching entry in the discover prompt.

**L6. Sanitize LLM-generated build artifacts in `harness_build`.** OpenAnt's `_sanitize_compose()` (`docker_executor.py:41-59`) catches obsolete `version:` keys and remote-image references in compose files. Our `harness_build` agent generates Dockerfile/Makefile/CMakeLists snippets that nobody post-processes. Easy place for a small `sanitize` helper. **Action:** add a deterministic post-processor for common LLM-generated build-file mistakes (CFLAGS scope errors, missing `mkdir -p`, etc.) before `harness_validate` runs.

### (b) Interesting-but-needs-design

**L7. Pre-flight reachability filter for the analyze agent.** OpenAnt's `EntryPointDetector` + `ReachabilityAnalyzer` materially reduces cost. For our workflow, on a single-task investigation, the savings are smaller (we only analyze one subsystem) but the correctness benefit is real: knowing exactly which functions are reachable from the threat model's entry points should be a *deterministic* output, not the LLM's interpretation. The design question is where it lives — a deterministic state before `analyze`, or a tool the `analyze` agent can call. The former requires picking a parser per language; the latter introduces another LLM-callable that needs policy rules. **Action:** prototype a deterministic pre-analyze step that builds a call graph from `tree-sitter` and emits an entry-point list, bind it to the workflow as a `deterministic` state with `isPassed` guard. Estimate: 1-2 weeks of work for one language (Python or Go). Skip C/C++ initially because their parsers are messier.

**L8. CodeQL inversion as a routing hint.** Run CodeQL on the target before the `analyze` agent starts; let `analyze` know which functions CodeQL already flagged. This complements rather than replaces our analysis — we should still be free to investigate CodeQL hits when the task targets a class CodeQL also flags, but for cross-cutting bugs we should *deprioritize* CodeQL hits on the assumption that traditional SAST has them covered. The interesting design question: should this be advisory-only (a section in `analysis.md`) or a hard filter? OpenAnt makes it a hard filter; for a hypothesis-driven investigator, advisory is probably right. **Action:** add a deterministic CodeQL state before `analyze` for languages where CodeQL has good security packs. Pipe the SARIF into `analysis.md` as a "prior SAST findings" appendix.

**L9. Ground-truth-challenger / discover-vs-triage reconciliation step.** When `discover` returns `approved` but `triage` returns `insufficient`, we currently bounce back to `discover`. OpenAnt's `ground_truth_challenger.py` is a third-LLM arbitrator. Worth considering for our workflow when the same discover-finding-triage-pair has bounced 2+ times: invoke a separate "arbiter" that reads both rounds and decides whether the disagreement is real (route to human) or an artifact of imprecise prompts (re-route discover with a sharper directive). **Action:** design a `triage_arbiter` state, gated on `triage → discover` having looped twice on the same finding. Consider whether this is worth the round-cost vs. just escalating.

**L10. Application-context manual override file (`OPENANT.md`-style).** OpenAnt lets repos check an `OPENANT.md` or `OPENANT.json` into their root to override the LLM's automatic classification. For our workflow, an `IRONCURTAIN.md` in the workspace could declare task-specific exclusions ("do not flag CLI-args path traversal") that the workflow honors across rounds. The design question is precedence: task description vs. workspace override vs. agent inference. **Action:** spec out a workspace-level config the orchestrator reads at cold start; map it onto the journal status header.

**L11. Per-step cost reporting matching OpenAnt's `*.report.json`.** OpenAnt writes a `{step}.report.json` after every pipeline step with timing, cost, and metadata, then aggregates into a `scan.report.json` (`scan.go:21-25`). Our workflow run-layout (`WORKFLOWS.md:54-65`) has `messages.jsonl` and per-state session metadata but does not aggregate cost or duration into a workflow-level summary report. **Action:** add a workflow-level cost/duration aggregator to the orchestrator's `done` state. Surface it in `inspect` and the web UI.

### (c) Intentional-divergence-don't-copy

**L12. The 5-bucket Stage 1 verdict (`safe | protected | bypassable | vulnerable | inconclusive`) is the wrong granularity for our use case.** OpenAnt has it because it is doing flat per-unit classification across thousands of units. Our workflow runs *one* investigation per workflow execution; the orchestrator decides what to do next based on richer context (journal, prior rounds, triage). Adding a 5-bucket verdict would just be a synonym for the existing `verdict:` strings (`approved | rejected | blocked | reanalyze | escalate | ...`). **Don't copy.**

**L13. The browser-only attacker constraint as the primary FP filter.** OpenAnt's "you have a browser and nothing else" trick works great for web-app vulnerabilities. It generalizes poorly to memory-safety bugs in `libavcodec` where the attacker delivery channel is "a malicious MP4 file" or "a malformed network packet," and to local-privesc bugs where the attacker *is* a local user. Our task description is the right place to specify the threat model — it lets us cover the full attacker-model spectrum. **Don't copy** the global constraint; *do* keep encouraging task descriptions to specify the channel concretely.

**L14. Stage 1 / Stage 2 / Dynamic-test as a flat sequence with fixed retries.** This shape is fine for a scanner because the user accepts that some findings will be wrong and they'll triage by hand. Our workflow is supposed to be more autonomous. Collapsing analyze/discover/triage into "Stage 1 + Stage 2" would lose the routing flexibility that lets us escalate to human, bounce to a higher tier, or ask for more discover work on the same finding. **Don't copy.**

**L15. CWE as the primary deduplication key.** OpenAnt's recent change (`CHANGELOG.md` Unreleased: "Dedup matches on CWE instead of `attack_vector` text") works because their findings are flat per-function classifications. Our workflow produces one investigation per run; we don't have a deduplication problem at the same granularity. If we ever do (e.g., a workflow that scans a whole codebase function-by-function), CWE-keyed dedup is fine; for the current `vuln-discovery` shape, deduplication should be on hypothesis identity, not CWE. **Don't copy directly.**

**L16. Attacker capture server on port 9999 in the dynamic tester.** OpenAnt's `attacker_server.py` is a good idea for SSRF/exfiltration testing. We could absolutely use it. But the design assumption — multi-service `docker-compose` with a `testnet` bridge — conflicts with our `--network=none` policy for agent containers. Adapting it would mean letting the harness pipeline open a controlled network channel. Worth discussing as a separate design but **don't copy as-is**: the network-mode mismatch is real.

---

## 8. Open questions / things I couldn't determine

**Q1. OpenAnt's actual false-positive rate on representative real-world repos.** The blog cites "as much as 99.98%" but the units are ambiguous (per finding? per code unit before/after Stage 2?) and the only concrete object-level number is "0/25 on object-browser." `OPENANT.md:425-447` shows 75.8% accuracy on the 33-sample GitHub-patches benchmark, which is much weaker than 99.98% suggests. I could not reconcile these numbers from public sources.

**Q2. Has OpenAnt actually disclosed any CVEs?** `README.md:6` says "we are pretty proud of this product and are in the vulnerability disclosure process for its findings." The `report/test_output/disclosures/` directory has a credible-looking IDOR finding in paperless-ngx. But I could not find a published CVE, advisory, or merged patch in the upstream paperless-ngx repo attributable to Knostic OpenAnt as of the search date. The marketing claim outpaces verifiable disclosure history.

**Q3. How does OpenAnt's parser handle modern JavaScript (decorators, dynamic imports, monorepos, framework-specific routes)?** Issue #21 ("JavaScript parser misses Express.js anonymous route handler callbacks") suggests there are real reachability blind spots in the JS parser. I did not exercise the parsers, only read them. This matters because reachability filtering is the first big cost optimization, and a parser that misses entry points produces unreachability false negatives that cascade.

**Q4. Real cost of the agentic enhancer on a dirty repo.** `agent.py:32` sets `MAX_ITERATIONS = 20`, and the blog post notes "we have observed cases where actual expenses are nearly double the initial estimate" due to error-recovery cycles. I could not measure this without running the tool against a real repo with API spend authorization.

**Q5. How well does the dynamic tester actually work?** The `__init__.py:213-225` retry mechanism is one-shot. If an LLM-generated Dockerfile has a build error that the LLM can't fix in one retry, the whole finding is dropped. I could not measure how often this triggers in practice. In an open-source SAST context this is probably fine; in a high-stakes triage context it would not be.

**Q6. Does our `vuln-discovery` workflow actually beat OpenAnt on a fair head-to-head benchmark?** I have no published evaluation for our workflow. The asymmetric memory-safety / hypothesis-driven framing means a fair benchmark is hard to design — OpenAnt's benchmarks use pre-curated "vulnerable" datasets per language, not a fixed set of CVE reproductions across multiple bug classes. To make a fair comparison we'd need a corpus of real CVEs (or research bugs) tagged by class (memory-safety / web / privesc) and run both pipelines with comparable budgets. **This is a gap in our own evidence base, not just a gap in my research.** It would be a high-value next step.

**Q7. Whether OpenAnt's 99.98% FP-elimination claim survives on memory-safety bugs in C.** Their published numbers are for object-browser (Go), Flowise (JS), Geospatial (Python), GitHub patches (mixed). C/C++ is "beta" per `README.md:31` and the blog acknowledges memory-management complexity is "particularly pronounced." This is probably the area where our tier-aware harness pipeline most outperforms — but I don't have OpenAnt benchmarks on C codebases to verify.

**Q8. Whether OpenAnt's "global rate limiter" handles 429 responses well.** `utilities/rate_limiter.py` exists but I did not read it in detail. Given that PR #198 in IronCurtain (`git log` recent commits) was specifically about quota-exhaustion handling, this is a parallel concern. Worth comparing implementations if we touch ours again.

---

Sources:

- [OpenAnt repository](https://github.com/knostic/OpenAnt)
- [OpenAnt blog post — technical details](https://www.knostic.ai/blog/openant)
- [OpenAnt landing page](https://www.knostic.ai/openant)
- [OpenAnt GitHub issues](https://github.com/knostic/OpenAnt/issues)
- [DeepWiki OpenAnt overview](https://deepwiki.com/knostic/OpenAnt)
- [Free OSS scan offer page](https://www.knostic.ai/blog/oss-scan)
- [Knostic company page](https://www.knostic.ai)
