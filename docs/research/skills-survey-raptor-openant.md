# Skills Survey: Raptor and OpenAnt — What to Borrow for `memory-safety-c-cpp.md`

**Date:** 2026-05-02
**Status:** Research complete — ready for skill authoring
**Purpose:** Survey prompt/skill assets in Raptor and OpenAnt for ideas to apply when writing IronCurtain's first surface skill, `memory-safety-c-cpp.md`.

Repos surveyed:
- Raptor: `gadievron/raptor` at commit `8c00309` (HEAD as of 2026-05-02)
- OpenAnt: `knostic/OpenAnt` at commit `6988216` (HEAD as of 2026-05-02)

---

## 1. Executive Summary

Five headline takeaways for the `memory-safety-c-cpp` skill and for the skill strategy generally:

- **Raptor ships a real, multi-file skill taxonomy.** Its `.claude/skills/exploitability-validation/` directory is a reference implementation of how skills can be composed: a top-level `SKILL.md` carries cross-cutting gates and conventions; per-stage files carry task-specific content; a `tiers/personas/` directory carries lightweight role files. The design is directly translatable to IronCurtain's skill attachment model.
- **The most reusable Raptor asset for `memory-safety-c-cpp.md` is the bug-taxonomy in the Stage A `vuln_type` enum and the disqualifier taxonomy in Stage D.** Together they constitute a machine-checkable vocabulary for memory-safety bug classes and false-positive categories — richer and more precise than anything in our current prompts.
- **OpenAnt's most reusable asset is the `>>> ANALYZE THIS FUNCTION ONLY <<<` / `>>> END OF TARGET FUNCTION <<<` delimiter convention and the structured `exploit_path` output schema.** Both are format conventions that cost almost nothing to adopt and directly improve agent focus.
- **Neither project fuses fuzzer-feedback validation with coverage audit in the way our `harness_validate` does.** Raptor's skill content is strongest on post-crash analysis; OpenAnt's is strongest on web/app-layer FP reduction. The memory-safety-c-cpp skill will be building on ground neither project has fully charted.
- **Both projects treat skills as prose, not as executable.** Neither embeds harness templates or worked compiler-flag examples in their skill markdown. Our skill should go further — include concrete ASAN/UBSAN flag strings, `LLVMFuzzerTestOneInput` skeleton, and sanitizer output reading guide — because the agent's in-context performance on those specifics is what the skill is for.

---

## 2. Raptor — What They Ship

**Repo:** `https://github.com/gadievron/raptor`
**Commit surveyed:** `8c00309` (HEAD on 2026-05-02)
**License:** MIT. CodeQL has its own license that prohibits commercial use (noted in `README.md:26`). Everything in `.claude/` is MIT.

### 2.1 Directory structure of prompt/skill assets

```
.claude/
  skills/
    exploitability-validation/
      SKILL.md                    # Cross-cutting gates, execution rules, stage table
      PIPELINE.md                 # Stage flow diagram, working-doc schema
      stage-0-inventory.md        # Inventory + checklist.json generation
      stage-a-oneshot.md          # Rapid one-shot exploitability + PoC
      stage-b-process.md          # Attack trees, hypotheses, PROXIMITY tracking
      stage-c-sanity.md           # Hallucination / code-match verification
      stage-d-ruling.md           # Disqualifier taxonomy + CVSS vector assignment
      stage-e-feasibility.md      # Binary mitigations, one-gadget, SMT feasibility
      stage-f-review.md           # Self-review: "what did I get wrong?"
      stage-1-outputs.md          # CVSS recompute, schema validation, report
    crash-analysis/
      function-tracing/SKILL.md   # C function trace instrumentation
      gcov-coverage/SKILL.md      # gcov workflow
      line-execution-checker/SKILL.md  # Custom line-hit checker
      rr-debugger/SKILL.md        # rr reverse-execution guide
    code-understanding/
      SKILL.md                    # Adversarial code comprehension overview
      map.md / trace.md / hunt.md / teach.md  # Per-mode files
    exploit-dev/
      instructions.md             # Exploit context loading, forbidden-commands list
    coverage.md                   # Standalone coverage notes
  agents/
    crash-analyzer-agent.md       # "Receipts" crash RCA generator
    crash-analyzer-checker-agent.md  # Validator for the RCA
    exploitability-validator-agent.md
    [13 more agents for OSS forensics, coverage, etc.]
  commands/
    agentic.md / validate.md / fuzz.md / crash-analysis.md / ...
tiers/
  personas/
    fuzzing_strategist.md
    offensive_security_researcher.md
    binary_exploitation_specialist.md
    crash_analyst.md
    exploit_developer.md
    patch_engineer.md
    penetration_tester.md
    codeql_analyst.md
    security_researcher.md
  analysis-guidance.md
  exploit-guidance.md
  recovery.md
  validation-recovery.md
```

### 2.2 Major assets and their shape

**`SKILL.md` (exploitability-validation)** — Cross-cutting configuration: execution rules, eight MUST-GATEs, output formatting rules, stage table. This is the "master contract" that all per-stage files reference. The eight gates are the most portable element:

- GATE-1 ASSUME-EXPLOIT: investigate as if exploitable; lazy dismissal forbidden
- GATE-2 STRICT-SEQUENCE: out-of-band ideas go in a separate end section
- GATE-3 CHECKLIST: compliance evidence required
- GATE-4 NO-HEDGING: every "if/maybe/uncertain" claim must be verified or removed
- GATE-5 FULL-COVERAGE: every function in checklist.json must be checked, no sampling
- GATE-6 PROOF: show the vulnerable code verbatim
- GATE-7 CONSISTENCY: `vuln_type`, `severity`, `status` must be consistent with `description`/`proof`
- GATE-8 POC-EVIDENCE: "ran without error" is not evidence; need observable effect

The formatting section forbids emojis and snake_case in prose output — conventions we should adopt verbatim.

**`stage-a-oneshot.md`** — One-shot exploitability check. The most directly relevant asset for memory-safety work. Contains a canonical `vuln_type` enum (lines 120-121):

```
'command_injection', 'sql_injection', 'xss', 'path_traversal', 'ssrf',
'deserialization', 'buffer_overflow', 'heap_overflow', 'stack_overflow',
'format_string', 'use_after_free', 'double_free', 'integer_overflow',
'out_of_bounds_read', 'out_of_bounds_write', 'null_deref', 'type_confusion',
'race_condition', 'memory_leak', 'uninitialized_memory', 'hardcoded_secret',
'weak_crypto', 'other'
```

This is an exact match for the bug classes the `memory-safety-c-cpp` skill needs to cover. The annotation "prefer root-cause CWE over consequence CWE" (e.g., CWE-190 for integer overflow leading to heap overflow, not CWE-122) is a specific precision rule worth adopting.

Also from `stage-a-oneshot.md` (lines 95-100), the `disproved_because` structure enforces GATE-1 by requiring three fields: `investigated`, `conclusion`, `would_reconsider_if`. This prevents dismissals that don't show work.

**`stage-d-ruling.md`** — Disqualifier taxonomy. Five structured false-positive categories:

- D-0: evidence synthesis failure (Stage B disproved the hypothesis)
- D-1: test/mock/example/documentation code
- D-1.5: privilege tautology (root reading a file is not a vulnerability)
- D-2: disqualifying preconditions (chaining required, victim must assist, physical access)
- D-3: hedging language patterns (a checklist of 10+ hedging phrases)
- D-4: no security impact (memory leak only, resource exhaustion, cosmetic)

The CWE precision note in D-5 (prefer root-cause CWE): "An integer overflow leading to heap overflow = CWE-190 (the arithmetic bug), not CWE-122 (the memory consequence). A strncpy using the wrong size constant = CWE-806 (buffer access using size of source buffer), not CWE-120."

The CVSS scoring note (D-5, lines 158-159): "Score the vulnerability's inherent impact, not the binary's mitigations." — Stage E separately tracks `feasibility.impact` (achievable impact, accounting for mitigations). This two-field structure prevents the "hardened binary makes everything Low" failure mode.

**`crash-analyzer-agent.md`** — Halvar Flake's "receipts" pattern. The agent produces numbered hypothesis files; a checker agent validates every claim against empirical rr data. The structural requirement for RCA reports is precise:

```
REJECT your own work if:
- You write "Expected Output:" instead of "Actual RR Output:"
- You write "should show" instead of actually showing it
- You show variable names without actual addresses (0x...)
- Any step is missing the rr commands AND their actual output
```

The mandatory self-check (lines 96-107) counts "Actual RR Output:" occurrences (must be ≥ 3), distinct memory addresses (must be ≥ 5), and greps for red-flag phrases ("expected output", "should show", "likely", "probably"). This is a mechanical quality gate for prose evidence — translatable to our triage rubric.

**`crash-analyzer-checker-agent.md`** — The validator for the crash-analyzer's output. Its "STEP 0: Mechanical Format Verification (MUST DO FIRST)" does the same grep checks before reading any prose. This two-agent pattern (producer writes, checker validates, loop until checker approves) is the most distinctive architectural idea in Raptor.

**`tiers/personas/offensive_security_researcher.md`** — Binary exploitation decision trees. Contains specific heuristics about RELRO, glibc hook removal timelines (hooks removed in 2.34+), the "6 Byte Rule" for strcpy on x86_64, heap exploitation decision trees per glibc version, and format string decision trees. This is a compact reference card for post-ASAN exploitation feasibility. It covers exactly the domain the `memory-safety-c-cpp` skill needs for its "when is a crash actually exploitable?" section.

**`tiers/personas/fuzzing_strategist.md`** — AFL++ parameter guidance: corpus strategy by binary type, crash prioritization order (SIGSEGV with controlled address > heap corruption > assertions > null deref), AFL++ timeout selection, parallel instance counts. This is thin but immediately useful.

### 2.3 Concrete excerpts

**Excerpt 1 — GATE-8 definition** (`.claude/skills/exploitability-validation/SKILL.md:77-79`):
```
GATE-8 [POC-EVIDENCE]: A PoC requires observable evidence: a crash, changed output,
callback, file read, error message, or measurable state change. "Ran without error"
is not evidence. If the expected effect is not observed, either the PoC is wrong
or the bug is not triggered — investigate which.
```

**Excerpt 2 — crash-analyzer-agent "receipts" requirement** (`.claude/agents/crash-analyzer-agent.md:55-60`):
```
The analysis MUST include:
2) MANDATORY: The actual verbatim output from running rr commands. For EVERY step
   in the pointer chain, you must include:
   a) The rr commands you will run
   b) The ACTUAL OUTPUT from running those commands showing real pointer values (e.g., "pointer=0x60e000000100")
   c) You must NOT write "expected output" - you must actually RUN the commands and paste the real output
```

**Excerpt 3 — value-level prediction requirement** (`stage-b-process.md:51-56`):
```
Predictions must be value-level, not pattern-level.
BAD: "Supplying 24+ bytes overwrites the return address."
GOOD: "At offset 24, RIP=0x4141414141414141 → SIGSEGV at attacker-controlled address."
BAD: "User input reaches the SQL query."
GOOD: "Input `' OR 1=1--` in the `username` parameter returns 200 with all user rows."
```

**Excerpt 4 — offensive_security_researcher glibc timeline** (`tiers/personas/offensive_security_researcher.md:50-58`):
```
Chain Break                  | Impact
Full RELRO                   | No GOT, no .fini_array, no .init_array
glibc 2.34+                  | No __malloc_hook, no __free_hook
glibc 2.38+                  | %n may be blocked (check empirically)
strcpy on x86_64             | Can only write 6 bytes per address
No info leak + ASLR          | Can't find addresses to write
Stack canary + no leak       | Can't overflow past canary
```

**Excerpt 5 — Stage D CWE precision rule** (`stage-d-ruling.md:160-162`):
```
Prefer the root-cause CWE over the consequence CWE. An integer overflow leading to
heap overflow = CWE-190 (the arithmetic bug), not CWE-122 (the memory consequence).
A strncpy using the wrong size constant = CWE-806 (buffer access using size of source
buffer), not CWE-120 (generic buffer overflow).
```

### 2.4 What is reusable for `memory-safety-c-cpp.md`

**Adopt directly:**

1. The `vuln_type` enum from `stage-a-oneshot.md` as the canonical bug-class vocabulary for the skill's "Common bug classes" section. Map each to an oracle (ASAN error class, UBSAN check, TSAN data race) and a CWE. The alias normalization (`uaf → use_after_free`, `toctou → race_condition`) is worth carrying forward.

2. GATE-4 (NO-HEDGING) and GATE-8 (POC-EVIDENCE) as skill-level behavioral gates. The exact phrasing is good: "if your analysis contains 'if', 'maybe', 'uncertain'... verify the claim or remove it." The list of hedging phrases in Stage D-3 is the best known list of LLM weasel words for this domain.

3. The CWE precision rule (root-cause over consequence). Our triage currently doesn't distinguish; adding it to the skill's "Severity" section costs one paragraph and prevents a recurring misclassification.

4. The `offensive_security_researcher.md` decision trees for post-sanitizer exploitability. The glibc hook removal timeline, the "6 Byte Rule," and the per-glibc heap exploitation decision trees are dense, accurate, and not widely documented in one place. The memory-safety-c-cpp skill should include a "Is this bug actually exploitable?" subsection that adapts this content for the discovery-not-exploitation context (i.e., "here are the factors that affect whether a confirmed sanitizer crash is a real security risk in the threat model").

5. The PROXIMITY 0-10 scoring table from `stage-b-process.md`. Our `discover` state doesn't have a quantitative proximity measure; adding one to the discover findings format would let the orchestrator make better routing decisions (PROXIMITY ≤ 2 → probably need a hypothesis revision; PROXIMITY ≥ 6 → route straight to triage).

**Adapt:**

6. The crash-analyzer "receipts" pattern. We don't use rr, but the principle — "every claim in a root-cause analysis must have actual tool output, not expected output" — belongs in the discover state's output rubric. The mechanical self-check (count rr outputs ≥ 3, count distinct addresses ≥ 5) could become: "count ASAN stack frames cited verbatim ≥ 2; count fuzzer-output lines quoted ≥ 1; no 'should show' phrases."

7. The Stage F self-review prompts ("What did I get wrong? Misclassifications, missed instances, wrong-index bugs, disproven claims still marked confirmed, confirmed claims with weak evidence") for a potential pre-conclude review stage.

### 2.5 What other skills could be extracted from Raptor's assets

- **`binary-exploit-feasibility.md`**: The `offensive_security_researcher.md` persona plus `stage-e-feasibility.md` together form the basis of a skill on post-sanitizer exploitability assessment (RELRO/PIE/canary analysis, glibc version timeline, one-gadget constraint checking). Relevant to `triage` state when the finding is a raw ASAN crash.
- **`crash-rca.md`**: The crash-analyzer / checker pattern could become a two-state skill attached to a future `crash_analysis` state. The rr-debugger, gcov-coverage, and function-tracing sub-skills are already factored into separate SKILL.md files.
- **`code-adversarial-reading.md`**: The code-understanding skill's five gates (READ-FIRST, ATTACKER-LENS, FULL-FLOW, VARIANT-COMPLETE, EVIDENCE-ONLY) and the map/trace/hunt/teach mode decomposition could attach to the `analyze` state as a surface-neutral skill.

---

## 3. OpenAnt — What They Ship

**Repo:** `https://github.com/knostic/OpenAnt`
**Commit surveyed:** `6988216` (HEAD on 2026-05-02)
**License:** Apache 2.0 (permissive; verbatim copies allowed with attribution).

### 3.1 Directory structure of prompt/skill assets

```
libs/openant-core/
  prompts/
    vulnerability_analysis.py      # Stage 1 system prompt + get_analysis_prompt()
    verification_prompts.py        # Stage 2 system prompt + get_verification_prompt()
    prompt_selector.py             # Routing between prompts
  utilities/
    dynamic_tester/
      test_generator.py            # LLM-based Dockerfile+test-script generator
      docker_executor.py           # Container orchestration + sanitization
      attacker_server.py           # Port-9999 capture server for SSRF tests
  context/
    application_context.py        # App-type classification
    OPENANT_TEMPLATE.md            # Manual override schema
  OPENANT.md                       # Pipeline documentation
  OPENANT_TWO_STAGE_PLANNING.md    # Design rationale
  PIPELINE_MANUAL.md               # Operator guide
```

### 3.2 Major assets and their shape

**Stage 1 prompt (`prompts/vulnerability_analysis.py`)** — The system prompt is five lines:

```python
STAGE1_SYSTEM_PROMPT = """You are a security analyst. Analyze code for real vulnerabilities.

Be skeptical. Most code is not vulnerable. Only flag something as VULNERABLE if you can:
1. Construct a specific attack payload
2. Show exactly how it reaches a dangerous operation
3. Explain what unauthorized capability an attacker gains

If you can't do all three, it's probably not vulnerable."""
```

This is deliberately minimal — the OPENANT_TWO_STAGE_PLANNING.md documents the evolution from "complex, multi-step instructions" to this. The design choice is explicit: "Simple, direct prompts produce better results." This is a finding in itself: OpenAnt's skill content lives almost entirely in the user prompt structure and the application context injection, not in elaborate system prompt instructions.

The user prompt is more structured. The key conventions (see `get_analysis_prompt()`, lines 122-141):

- The `>>> ANALYZE THIS FUNCTION ONLY <<<` / `>>> END OF TARGET FUNCTION <<<` delimiters around the primary function code, with caller/callee context in a separate clearly-labeled block: `Context (for understanding only - do NOT analyze these for vulnerabilities)`.
- The instruction "State the exact function you are analyzing" before any claim, to prevent drift into context functions.
- The five-bucket verdict (`safe | protected | bypassable | vulnerable | inconclusive`) with `bypassable` as a distinct intermediate (security controls exist but can be circumvented).

**Stage 2 prompt (`prompts/verification_prompts.py`)** — The "attacker simulation" framing:

```python
VERIFICATION_SYSTEM_PROMPT = """You are a penetration tester. You only report vulnerabilities you can actually exploit."""
```

The user prompt injects the attacker constraint explicitly (lines 128-137): "You are an attacker on the internet. You have a browser and nothing else. No server access, no admin credentials, no ability to modify files on the server." The constraint is modulated by `app_context.requires_remote_trigger` — for CLI tools, the constraint explicitly states the attacker cannot run CLI commands locally.

The verifier produces a structured `exploit_path` (from `finding_verifier.py`, lines 144-170):
```
entry_point: str
data_flow: [str]               # step-by-step flow
sink_reached: bool
attacker_control_at_sink: "full" | "partial" | "none"
path_broken_at: str | null     # where the path broke if not reached
```

This is the most structurally reusable OpenAnt asset. The `path_broken_at` field documents not just "did it work" but "where exactly did it stop" — analogous to our PROXIMITY scoring but in the failure direction.

**Application context (`context/application_context.py`)** — Classifies the target as `web_app | cli_tool | library | agent_framework` and injects class-specific guidance into both Stage 1 and Stage 2 prompts. The most important injection is the remote-attacker constraint for CLI tools (lines 144-152 in `vulnerability_analysis.py`): local users are explicitly excluded from the attacker model when `not app_context.requires_remote_trigger`. This is surface-neutral FP reduction done correctly.

**Dynamic tester (`utilities/dynamic_tester/test_generator.py`)** — The system prompt (lines 32-96) is a detailed Docker-based exploit test generator. It contains CWE-specific guidance for test generation (the `_get_cwe_guidance()` method covers CWE-22, 78, 79, 89, 94, 134, 200, 502, 918 — path traversal, command injection, XSS, SQLi, code injection, format string, info disclosure, deserialization, SSRF). Each CWE gets a 5-10 line block describing the test structure for that class. Example for CWE-89 (SQL injection): capture the database query with a logging interceptor; inject `' OR '1'='1` as the payload; check whether extra rows are returned.

**`OPENANT_TWO_STAGE_PLANNING.md`** — Design rationale document. Worth reading as a primary source on the philosophy: "Simple, direct prompts produce better results. We removed earlier complex multi-step instructions." And the key Stage 2 insight (lines 74-77): changing from "code analysis mode" to "attacker simulation mode" was the breakthrough for false-positive reduction. This is a convergent finding with Raptor's GATE-1 (ASSUME-EXPLOIT) — both projects discovered independently that role-playing as the attacker, rather than asking "is this code vulnerable?" in the abstract, produces more accurate verdicts.

### 3.3 Concrete excerpts

**Excerpt 1 — Stage 1 system prompt** (`prompts/vulnerability_analysis.py:16-23`):
```python
STAGE1_SYSTEM_PROMPT = """You are a security analyst. Analyze code for real vulnerabilities.

Be skeptical. Most code is not vulnerable. Only flag something as VULNERABLE if you can:
1. Construct a specific attack payload
2. Show exactly how it reaches a dangerous operation
3. Explain what unauthorized capability an attacker gains

If you can't do all three, it's probably not vulnerable."""
```

**Excerpt 2 — function delimiter convention** (`prompts/vulnerability_analysis.py:124-141`):
```python
>>> ANALYZE THIS FUNCTION ONLY <<<
```{language}
{primary_code}
```
>>> END OF TARGET FUNCTION <<<

Context (for understanding only - do NOT analyze these for vulnerabilities):
```{language}
{context_code}
```
```

**Excerpt 3 — structured exploit_path schema** (`finding_verifier.py:144-170`):
```python
{
    "entry_point": "...",
    "data_flow": ["step 1", "step 2"],
    "sink_reached": true/false,
    "attacker_control_at_sink": "full|partial|none",
    "path_broken_at": "...|null"
}
```

**Excerpt 4 — attacker simulation constraint** (`verification_prompts.py:128-137`):
```
You are an attacker on the internet. You have a browser and nothing else.
No server access, no admin credentials, no ability to modify files on the server.

Try to exploit this code using MULTIPLE different approaches. Think about:
- What different inputs can you control?
- What different properties/fields can you manipulate?
- What different endpoints or entry points exist?
```

**Excerpt 5 — Stage 2 verdict instruction** (`verification_prompts.py:157-160`):
```
IMPORTANT:
- Only conclude PROTECTED or SAFE if ALL approaches fail. If ANY approach succeeds, conclude VULNERABLE.
- A vulnerability must harm someone OTHER than the attacker.
```

### 3.4 What is reusable for `memory-safety-c-cpp.md`

**Adopt directly:**

1. The `>>> ANALYZE THIS FUNCTION ONLY <<<` / `>>> END OF TARGET FUNCTION <<<` delimiter convention in the `analyze` agent's output. This is a minor formatting change with real impact: downstream agents reading `analysis.md` need unambiguous markers to extract the target function from its context. A skill can prescribe this convention without touching the workflow YAML.

2. The three-condition exploitability test from the Stage 1 system prompt ("construct a specific attack payload / show how it reaches a dangerous operation / explain what unauthorized capability the attacker gains") as a falsification trigger for the `discover` state's output schema. A discover finding that can't answer all three is `blocked`, not `approved`.

3. The `path_broken_at` field as an addition to `discover`'s structured output. Currently our `findings.md` is free-form; adding a `path_broken_at: str | null` field (parallel to `sink_reached: bool` and `attacker_control_at_sink`) gives the orchestrator a specific routing signal when `discover` returns `blocked`.

4. The explicit "harm someone other than the attacker" condition from `verification_prompts.py:159`. This is a concise phrasing for a condition our triage state handles verbosely — worth adding as a one-line rule to the memory-safety skill's "Oracle vocabulary" section.

**Does not apply:**

The web-attacker simulation ("you have a browser and nothing else") is excellent for web vulns and irrelevant for C memory safety, where the attacker model is "delivers a malformed file to a parser" or "sends a crafted network packet." The skill should state the correct attacker constraint positively, not borrow OpenAnt's constraint.

The CWE-specific test generation guidance in `test_generator.py` covers web-layer CWEs (22, 78, 79, 89) and misses memory-safety CWEs (190, 122, 416, 125, 787, 119). The pattern — CWE-specific guidance sections with test-structure hints — is worth copying; the content is not directly applicable.

### 3.5 What other skills could be extracted from OpenAnt's assets

- **`application-context.md`**: The `web_app | cli_tool | library | agent_framework` classification with its remote-attacker constraint rules could become a surface-neutral skill attached to the `analyze` state's cold start. The skill would instruct the analyst to classify the target type and inject the correct attacker-model constraint into the analysis output header.
- **`dynamic-test-generation.md`**: The structured Docker test scaffold with the capture-server pattern (for SSRF/exfiltration validation) is directly relevant for a future `web-vuln-discovery` workflow's `probe_execute` state. Not immediately relevant for `memory-safety-c-cpp`.
- **`verdict-bucket-convention.md`**: OpenAnt's five-bucket system (`safe | protected | bypassable | vulnerable | inconclusive`) is a clean triage vocabulary that could replace or supplement our `approved | rejected | blocked | reanalyze | escalate | insufficient` vocabulary in the discover state. The `bypassable` bucket — "controls exist but can be circumvented" — is a gap in our current vocabulary.

---

## 4. MoakAI — Note

MOAK is closed source with no published prompts, skill files, or agent definitions. All architectural information comes from marketing copy in their React SPA bundle. Per the `comparison-moak-ai.md` research note, MOAK's most reusable ideas are architectural (patched-twin differential oracle, Contrarian sub-agent, Collector information firewall) rather than prompt-level assets. There is nothing to excerpt for `memory-safety-c-cpp.md`. See `comparison-moak-ai.md` for the full structural comparison.

---

## 5. Cross-Cutting Patterns

### What both projects do similarly

**Attacker-role framing beats passive-analyst framing.** Both Raptor (GATE-1: ASSUME-EXPLOIT) and OpenAnt (Stage 2: "you are a penetration tester who only reports what you can exploit") converge on forcing the LLM into an adversarial role rather than asking "is this code vulnerable?" The mechanism differs — Raptor uses a gate the agent must explicitly comply with; OpenAnt uses a persona in the system prompt — but the behavioral effect is the same: the model is pushed to find counterexamples to its own tentative findings, not to generate them.

**Observable-effect requirements, not just code-reading.** Raptor's GATE-8 and OpenAnt's verification rubric both insist that evidence be executable, not textual. "Ran without error" is not evidence in either system. The fact that both arrived at this independently is strong signal it belongs in our skill as a first-class rule.

**Structured output reduces hallucination.** Raptor's per-stage JSON schemas (stage-a.json, stage-b.json through stage-f.json) and OpenAnt's `exploit_path` schema both force the model to fill in structured fields before making prose claims. The structure disciplines the reasoning. Our discover state's free-form `findings.md` is the weakest point in this regard — both projects suggest it should have at least a structured header block.

**Function-level unit scope.** Both explicitly scope analysis to one function at a time (Raptor's `checklist.json` per-function entries; OpenAnt's `>>> ANALYZE THIS FUNCTION ONLY <<<` markers). Our `analyze` state builds a catalog but doesn't enforce per-function scope on downstream agents reading it.

### Where they differ

**System complexity.** Raptor's skill system is multi-file, multi-stage, with YAML front matter on each file, Python prep scripts for each stage, and mechanical validators. OpenAnt's prompt assets are a few Python files with simple string formatting. For IronCurtain's skill format — markdown attached to states — Raptor's multi-file structure is the better reference model (we already have the multi-file precedent from commit `91c3673`). OpenAnt's simplicity is a data point that minimum-viable prompts can work; it doesn't generalize to our use case because we're not doing flat per-function batch scanning.

**Bug class scope.** Raptor's Stage A `vuln_type` enum covers memory-safety classes explicitly (`buffer_overflow`, `heap_overflow`, `stack_overflow`, `format_string`, `use_after_free`, `double_free`, `integer_overflow`, `out_of_bounds_read`, `out_of_bounds_write`, `null_deref`, `type_confusion`). OpenAnt's Stage 1 CWE list in the user prompt covers web-layer classes (22, 77, 78, 79, 89, 94, 502, 798). OpenAnt explicitly marks C/C++ as "beta" in its language support.

**Post-crash depth.** Raptor ships `rr-debugger/SKILL.md`, `gcov-coverage/SKILL.md`, `function-tracing/SKILL.md`, and the crash-analyzer / checker pair. OpenAnt has no equivalent — its dynamic tester is a one-shot Docker test, not a crash-reanalysis pipeline. For memory-safety work, Raptor is the deeper reference.

**Philosophy on prompt complexity.** OpenAnt's OPENANT_TWO_STAGE_PLANNING.md documents a deliberate move away from complex instructions: "Simple, direct prompts produce better results." Raptor's SKILL.md is dense (eight gates, 10 execution rules, style conventions). The IronCurtain design is closer to Raptor's philosophy for the workflow YAML, but for skills, OpenAnt's finding is worth taking seriously: don't add gate 9, 10, 11 to the skill just because you can.

### Shared idioms worth encoding

Both projects use these patterns that our skill should encode:

- **Falsification trigger**: before claiming "approved," the agent must attempt to disprove. This is Raptor's GATE-1 and OpenAnt's "try MULTIPLE approaches, only conclude SAFE/PROTECTED if ALL fail."
- **Dismissal documentation**: a `disproved_because` or `path_broken_at` field that records what was tried and why it failed. Lazy dismissal without documentation is forbidden in both.
- **Source-sink tracing**: both prompt for an explicit `source → [transforms] → sink` data-flow format, not a prose narrative.
- **Hedging phrase elimination**: Raptor's D-3 checklist (10+ specific hedging phrases that must be verified before use) is the most systematic implementation; OpenAnt's GATE-4 equivalent is the system prompt's "If you can't do all three, it's probably not vulnerable."

---

## 6. Recommendations for IronCurtain

### 6.1 For `memory-safety-c-cpp.md` specifically

**Copy (with attribution):**

- Raptor's `vuln_type` enum as the canonical bug-class vocabulary. Extend it with any classes our existing prompts name but Raptor doesn't (e.g., "type-narrowing-at-storage-boundary" is our vocabulary; Raptor's closest is `type_confusion`).
- Raptor's CWE precision rule (root-cause CWE over consequence CWE), the glibc hook removal timeline from `offensive_security_researcher.md`, and the Full RELRO trap note.
- The "observable-effect requirement" language from GATE-8 verbatim: "A PoC requires observable evidence: a crash, changed output, callback, file read, error message, or measurable state change. 'Ran without error' is not evidence."
- OpenAnt's three-condition exploitability test ("construct a specific attack payload / show how it reaches a dangerous operation / explain what unauthorized capability the attacker gains") as a falsification trigger for discover findings.
- OpenAnt's `>>> ANALYZE THIS FUNCTION ONLY <<<` delimiter convention for `analysis.md` function entries.

**Do NOT copy:**

- OpenAnt's "browser-only attacker" framing. For C memory safety, the attacker model is "delivers malformed input to a parsing path," not "sends HTTP requests." The skill should state the correct delivery channel positively.
- Raptor's full eight-gate structure as a gates list in the skill. The gates work in Raptor because they're a master contract referenced by all per-stage files. In our model, the skill attaches to one or a few states; encoding all eight gates in one skill is overkill. Select the three or four most relevant (GATE-4 NO-HEDGING, GATE-6 PROOF, GATE-8 POC-EVIDENCE, and our own coverage gate) and embed them in the relevant sections.
- Raptor's Stage E binary-mitigation analysis. The detailed RELRO/PIE/NX/canary analysis in stage-e-feasibility.md is relevant for exploit development, not for vulnerability discovery. Our `triage` state already handles the "is this actually exploitable?" question; the skill should point at triage, not duplicate Stage E.
- Raptor's multi-model consensus pattern. Interesting architecturally but requires provider plumbing we don't have; out of scope for the first skill.

**Structure proposal for `memory-safety-c-cpp.md`:**

Based on the section sketch in `docs/brainstorm/vuln-discovery-surfaces.md` (lines 129-143) and what we learned from both projects, the skill should have:

1. **Surface scope** (one paragraph). "This skill applies when the target is native C or C++ code with ASAN/UBSAN support. Not applicable to managed runtimes, JVM, or Python C extensions (those have their own skills)."
2. **Bug-class vocabulary** (table format, ~15 entries). Map from bug class name → oracle → CWE → typical violation site. Use Raptor's `vuln_type` enum as the backbone. Each entry: 2-3 lines.
3. **Tool selection** (decision table). libFuzzer vs AFL++ vs honggfuzz vs custom. When to add UBSAN alongside ASAN. When to use HWASan over ASAN. When to use sanitizer-less builds for throughput. This is not in either project at useful depth for our workflow; write fresh.
4. **Tier-by-tier harness conventions** (3 subsections, each ~10-20 lines). Tier 1 skeleton (`LLVMFuzzerTestOneInput`, ASAN flags, link only the target object). Tier 2 conventions (link-real-objects, ASAN on all TUs). Tier 3 conventions (full build with CMake/Meson overrides, corpus seeding, structure-aware mutation). Include exact compiler flag strings for each tier.
5. **Oracle vocabulary** (the most important section, ~80 lines). ASAN error class taxonomy (heap-buffer-overflow vs stack-buffer-overflow vs use-after-free vs double-free vs initialization-order vs global-buffer-overflow). UBSAN check categories and how to read them. TSAN data-race reports. How to distinguish true positives from instrumentation artifacts. When a sanitizer crash is not a security bug (assertion in unreachable path, NULL-deref on malloc failure, etc.). This section adapts Raptor's Stage D-4 (no security impact) and the `offensive_security_researcher.md` chain-break analysis.
6. **Hypothesis phrasing recipes** (10-15 examples). Model: "The hypothesis must be falsifiable. Use: '[Type narrowing]: `int16_t` accumulator in `jpeg_decode_row()` wraps at 32767 when decoding a crafted progressive scan; ASAN should fire with heap-buffer-overflow at `frame->pixels[accum]`.' Not: 'There might be overflow in the JPEG decoder somewhere.'" Borrow Raptor's value-level prediction requirement.
7. **Discover output rubric** (4-5 items). Adapt Raptor's GATE-8 and OpenAnt's `exploit_path` schema. Require: crash output quoted verbatim, ASAN stack trace top frame cited, `path_broken_at` field if blocked, attacker delivery channel named.
8. **Common pitfalls** (~10 bullets). Harness compiles but doesn't exercise target function (wrapper-only instrumentation — this is already in our workflow prompts; repeat it in the skill). Sanitizer-disabled build masking real bugs. Corpus seeding accidentally testing the wrong code path. Instrumented build is much slower — don't confuse fuzzer throughput degradation with coverage regression.

Target length: 600-900 lines of markdown. Raptor's single-surface SKILL.md is ~300 lines of gates/config; the per-stage files add another ~100-150 each. Our skill is one document doing the work of both levels, so 700 lines is a reasonable estimate.

### 6.2 Other skills to extract — cross-referencing with vuln-discovery-surfaces.md

The surfaces doc lists a starter skill set. Based on the survey, here are the priorities with one-line rationales:

| Skill | Priority | Rationale |
|---|---|---|
| `memory-safety-c-cpp.md` | Immediate | Covers our primary test surface (libtiff, libavcodec-class targets); both repos have relevant but incomplete coverage of this domain; first skill experiment as specified in the surfaces doc |
| `memory-safety-jvm.md` | Second | Jazzer/JQF harness vocabulary is not in either repo; the workflow shape transfers cleanly per the surfaces doc; good experiment to validate skills-first path |
| `code-adversarial-reading.md` | Third | Raptor's code-understanding SKILL.md (gates U1-U5, map/trace/hunt/teach modes) is a near-complete draft; surface-neutral, attaches to `analyze` state; low authoring cost |
| `binary-exploit-feasibility.md` | Fourth | Raptor's `offensive_security_researcher.md` + `stage-e-feasibility.md` provide substantial raw material; attaches to `triage` state for the "is this sanitizer crash actually exploitable?" question |
| `taint-driven-php.md` | Later | Surfaces doc rates this "stretchy but probably workable"; neither repo provides PHP taint content; higher authoring cost; try memory-safety JVM first to validate the skills-first path before committing |

Skills NOT on the immediate list per the surfaces doc's reasoning: web vulns (need separate workflow), Rust (`cargo-fuzz` + Miri have different oracle vocabulary; write after C/C++ and Go experiments show the pattern), Go (`go test -fuzz` is simpler but race detector adds new oracle vocabulary).

### 6.3 Format and conventions — a concrete proposal

Based on both projects' formats and the IronCurtain skill mechanism (commit `91c3673`), propose the following template for all surface skills:

```markdown
---
name: <surface-name>
description: <one-line scope statement>
attaches-to: [<list of states this skill is relevant to>]
---

## Scope

[One paragraph: what this skill covers, what it explicitly does not cover.]

## Bug-class vocabulary

[Table: bug class | oracle | root-cause CWE | typical violation site]

## Tool selection

[Decision guidance: when to reach for each tool, which sanitizer combos matter]

## Harness conventions

[Per-tier or per-tool sections with concrete flag strings and skeleton code]

## Oracle vocabulary

[How to read tool output, true-positive vs artifact, what is and is not a security bug]

## Hypothesis recipes

[5-10 well-formed and badly-formed examples, value-level, falsifiable]

## Discover output rubric

[What a discover finding must include before it can be `approved`]

## Common pitfalls

[Bullets: things that cause silent failure or false positives in this surface]
```

Key conventions to apply consistently across skills:
- Bug-class IDs should match Raptor's `vuln_type` enum where the enum covers the class; extend with hyphenated names for classes the enum doesn't have (e.g., `type-narrowing-at-storage-boundary`).
- Hypothesis recipes must be value-level (per Raptor's Stage B requirement): name a specific value, type, or address, not a pattern.
- "Observable effect required" must appear in every skill's oracle section (Raptor GATE-8 / OpenAnt three-condition test).
- Hedging phrases to avoid: include Raptor's D-3 list (or a subset) as a skill-level note; the model should recognize these as signals to verify, not to include.
- Worked-example density: aim for at least one well-formed and one badly-formed hypothesis per skill (both repos suffer from not having this; our skills should fix it).

---

## 7. Open Questions

1. **How does the skill interact with the `analyze` agent's output format?** The `>>> ANALYZE THIS FUNCTION ONLY <<<` delimiter idea from OpenAnt requires the `analyze` agent to emit function entries in that format. Does that go in the skill, or does it require a workflow YAML prompt edit? If it goes in the skill, does the skill attach to `analyze`, or does it attach to `harness_design` (where the function entry is consumed)? This is a mechanics question that needs a decision before authoring starts.

2. **Should the skill include actual C code skeletons?** Both Raptor and OpenAnt put code in their prompt assets (Raptor's crash-analyzer SKILL has C macro expansion instructions; OpenAnt's test_generator.py embeds full Dockerfile templates). Including a `LLVMFuzzerTestOneInput` skeleton in the skill's Tier 1 section would be high-value for the agent but raises the question of whether skills should contain code blobs. The skill mechanism (markdown files) technically supports this; the question is whether it's idiomatic.

3. **What is the precedence rule when skills conflict with workflow YAML prompts?** The surfaces doc notes the risk that "the skill is fighting upstream" when the workflow's prompts have hardcoded vocabulary (`harness_validate` prompting for libFuzzer output). We don't have a specified precedence rule. This needs to be established before skills are deployed, or we risk subtle skill-vs-YAML conflicts that are hard to debug.

4. **Should `memory-safety-c-cpp.md` attach to all states or only to a subset?** The `attaches-to` field in the proposed template implies we have a choice. Attaching to `harness_design`, `harness_validate`, `discover`, and `triage` makes sense. Attaching to `analyze` (to inject the `>>> ANALYZE THIS FUNCTION ONLY <<<` convention) may or may not be appropriate. Attaching to `orchestrator` risks bloating the most expensive context. A decision on this determines the authoring scope.

5. **How do we evaluate whether the skill is working?** Both Raptor and OpenAnt lack per-skill evaluation harnesses (their tests are at the pipeline level). The surfaces doc raises this as the hardest open question. The practical answer is probably: run the `vuln-discovery` workflow against a known-vulnerable version of libtiff (CVE-2016-10092 or similar) with and without the skill attached; compare whether the agent finds the bug faster, with fewer harness-loop rounds, and with better hypothesis phrasing. This needs a specific target selection and a success criterion before skill authoring begins, otherwise "does the skill work?" has no answer.

---

## What to do next

Write a one-paragraph scope statement and bug-class vocabulary table for `memory-safety-c-cpp.md` against a specific known-vulnerable libtiff CVE, attach it to `harness_design` and `discover` only, run the workflow, and measure whether hypothesis quality improves before committing to the full skill format.
