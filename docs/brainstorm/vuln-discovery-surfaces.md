# Vulnerability Discovery — Surfaces, Skills, and Workflow Boundaries

**Date:** 2026-05-01
**Status:** Brainstorm (exploratory — not a design)
**Purpose:** Capture a discussion about whether the existing `vuln-discovery` workflow can absorb other vulnerability surfaces (memory safety in non-C/C++ languages, taint-driven scripting bugs, web vulns) by leaning on language- and bug-class-specific skills, or whether some surfaces structurally need their own workflow.

## Context — where we are today

`src/workflow/workflows/vuln-discovery/workflow.yaml` is a multi-agent state machine that we have been iterating on against C/C++ codebases (libtiff has been the primary punching bag). The states roughly form this pipeline:

```
analyze → orchestrator → harness_design → harness_design_review →
  harness_build → harness_validate → discover → triage → conclude →
  review → report_review
```

The orchestrator routes between states based on agent verdicts. We recently (commit `539a1c7`) split `harness_design` outputs into two design classes:

- **Trigger-driven**. The directive names a falsifiable hypothesis with a specific violation site. The harness sweeps a small number of hypothesis variables. Oracle is the named bounds check / type-narrowing site / state-machine violation actually firing.
- **Coverage-driven**. The directive names an under-exercised dispatch surface — opcode tables, option-flag matrices, message-type dispatchers. The harness sweeps dispatch axes; oracle is "any sanitizer error inside the named region."

Most of the existing workflow vocabulary is tilted toward systems-language fuzzing:

- Tier 1/2/3 harness sizing (isolated function / multi-component / full build with sanitizers)
- ASAN/UBSAN as the canonical oracle pair
- libFuzzer / AFL++ as the canonical tooling
- Bug-class language: type narrowing at storage boundaries, sentinel collisions, integer overflow at allocation sites
- `LLVMFuzzerTestOneInput` as the harness entry-point shape

The agent skills feature (commit `91c3673`, `feat(skills)`) lets us attach SKILL.md files to states. So the question on the table is: how far do those skills carry us?

## The strategic question

Can language- and vulnerability-class-tuned **skills** carry one workflow across many vulnerability surfaces, or do some surfaces need their own workflow?

The surfaces we sketched out:

- **Compiled languages with sanitizers** — C, C++, Rust (UBSan + Miri), Go (race detector + fuzz). Memory safety + logic bugs.
- **JVM languages** — Java, Kotlin. Memory-safety-ish bugs via Jazzer; logic bugs; deserialization.
- **Python with C extensions** — atheris-driven fuzzing into `cffi` / `pybind11` boundaries.
- **Pure scripting languages** — PHP, Python, Ruby. Mostly taint-driven: SQLi, command injection, deserialization gadgets, path traversal.
- **Web vulnerabilities** — XSS, CSRF, SSRF, IDOR, auth bypass against deployed apps. Stateful interactions, threat-model staging, browser context.

We talked through these one at a time and arrived at a confidence gradient.

## Confidence gradient — what skills probably can absorb

### High confidence: memory safety across compiled / managed languages

Same workflow shape, different vocabulary. The structural moves — propose a hypothesis or a coverage region, build a harness, validate it does what it says, run, triage, conclude — all transfer. What changes is the surface vocabulary.

A starter skill set might look like:

- `memory-safety-c-cpp.md` — libFuzzer/AFL++, ASAN/UBSAN, `LLVMFuzzerTestOneInput`, classic CWEs (heap OOB, UAF, integer overflow at alloc).
- `memory-safety-jvm.md` — Jazzer, fuzzing entry-point shape, `FuzzerSecurityIssue*` exceptions as oracles, common JVM bug classes (deserialization, XXE in parser libs, JNI boundary issues).
- `memory-safety-go.md` — native `go test -fuzz`, race detector as oracle, panic-as-bug heuristics, slice-bounds and nil-deref surfaces.
- `memory-safety-rust.md` — cargo-fuzz, Miri for UB, `unsafe` block surveys, leak detection.
- `memory-safety-python-cext.md` — atheris, sanitizer-instrumented Python builds, common cffi/pybind11 footguns.

The orchestrator's design-class vocabulary (trigger-driven vs coverage-driven) generalizes cleanly. "Sweep hypothesis variables, check oracle fires" is the same loop whether the oracle is ASAN or `FuzzerSecurityIssueLow`.

A reason to be optimistic about this category specifically: the LLM has seen thousands of fuzzer harnesses across these ecosystems. The conventions are similar enough — define an entry function, decode bytes into a typed input, drive the target — that a Jazzer harness "feels like" a libFuzzer one with different ceremony. The skill mostly has to nail the ceremony (build system integration, oracle wiring, corpus location) rather than re-teach the model what a fuzz harness is. Where the skill adds the most value is in the bug-class taxonomy specific to the language: `FuzzerSecurityIssue` levels and what each means in Jazzer; the gap between "Go panic" and "Go runtime memory corruption"; what `unsafe` lets you reach in Rust that safe code can't. Those are the things the orchestrator-level prompts shouldn't have to know.

There's also a question buried in here about how aggressively to splinter. Do we want one skill per language (`memory-safety-c-cpp.md`) or one skill per language-and-bug-class (`memory-safety-c-cpp-uaf.md`, `memory-safety-c-cpp-integer-overflow.md`)? The bug-class axis is fairly stable across languages — a UAF is a UAF — so the natural cleavage is probably language. But if a single skill grows past some informal length threshold, splitting by bug class is a defensible second cut. We don't need to decide this now; the experiment in the Next Step section will answer it implicitly by showing how big a single skill needs to be before the agent loses focus.

### Medium confidence: logic and auth bugs in code with executable harnesses

Examples: Java auth-bypass via JUnit fixtures that drive Spring Security, Python deserialization gadget chains, Go race conditions outside the obvious data-race detector cases. The harness metaphor still applies; the oracle changes from "sanitizer fires" to "assertion fails" / "wrong return value" / "race detector fires" / "privileged action observed under unprivileged identity."

The trigger-driven / coverage-driven split still feels like it works here, but with strain. "Coverage-driven" against an auth surface means "exercise more of the route → middleware → handler dispatch graph." That's coherent. "Trigger-driven" auth would name a specific bypass hypothesis ("JWT signature check is skipped when alg=none is sent") with the named site being the verification call. Also coherent.

The skill content would be doing more lifting here than in the memory-safety case, because the vocabulary stretch is bigger. The harness is no longer "decode bytes into a typed input and feed it to a parser." It's "construct a request, signed-or-not, with these claims, and observe whether the privileged operation completed." That's still a harness — call it `LLVMFuzzerTestOneInput`'s logic-bug cousin — but the supporting cast (test fixtures, mock dependencies, fake clocks for token-expiry tests, in-memory databases for IDOR-without-network tests) is much richer. A `logic-jvm.md` skill might end up larger than `memory-safety-jvm.md` purely because it has to teach the agent more about the testing infrastructure.

One subtlety: many of the bugs in this category are *not* easy to express as "sweep hypothesis variables." A logic bug in privilege escalation is often a single specific path through the code that does the wrong thing under one specific input shape. The trigger-driven design class fits — name the hypothesis, name the site, build a focused harness — but the "sweep" part of trigger-driven is doing less work. The harness has fewer dials and more setup. We may want the skill to acknowledge that and reframe: "trigger-driven for logic bugs often means *one carefully constructed input*, not a sweep — the hypothesis is the input, the harness's job is to set up the world correctly around it."

### Stretching but probably workable: taint-driven scripting language bugs

This is where we expect the workflow itself starts to creak.

PHP, Python, Ruby SQLi / command injection / deserialization / path traversal. The hypothesis form is no longer "value overflows at site X" — it's "tainted source S reaches sink K through transformation chain T without passing through sanitizer N." The primary tool stops being a fuzzer and becomes a static taint analyzer (CodeQL, semgrep with taint mode, PHPStan-taint, Psalm `TaintedInput`).

To absorb this, the workflow YAML's prompt vocabulary needs to abstract one rung up:

- "harness" → "experiment specification" (covers fuzzer harnesses AND taint queries AND symbex configurations)
- "validate" → "experiment integrity check" (coverage threshold for a fuzzer; query-result sanity check for a taint analyzer; "the source and sink are reachable in the analysis graph at all" for static)
- Tier 1/2/3 stretches awkwardly: Tier 1 = single-file query; Tier 2 = cross-file taint config with project-specific sources/sinks; Tier 3 = full-codebase semantic flow with custom sanitizer models.

Stretchy, but coherent. The thing we'd be giving up is a chunk of concrete grounding in the prompts — "harness" is more vivid than "experiment specification," and we suspect the agent does better with the more concrete word. But maybe the skill carries that concreteness for the surface it knows about.

A second source of strain: dynamic execution. For SQLi or command injection, a confirmed taint path is suggestive but not exploitative. To upgrade a static finding into a confirmed bug, you typically need to actually issue a request and observe the side effect (extra row returned from DB, side-channel timing, marker-string echoed back). That argues for a `discover` state in the taint case that is hybrid static-then-dynamic: the analyzer proposes paths, and the harness exercises each one against an actual running instance of the application. That's not really what `discover` does today; today's `discover` runs a fuzzer and waits for a crash. So the hot loop changes shape: less "run for hours and harvest crashes," more "for each candidate flow, construct a probe and confirm or reject."

Whether that change is "skill carries it" or "workflow vocabulary needs to admit it" is genuinely unclear. The skills-first answer is "the discover-state skill for taint-driven surfaces tells the agent it's running probes against a deployed instance, not a fuzzer." That works as long as the skill has enough authority over the discover-state's behavior to redirect it. If the workflow YAML has hardcoded prompts about "fuzz for at least N minutes," the skill is fighting upstream. We probably need to inspect the current prompts and decide which ones are surface-neutral by accident vs. surface-specific by design.

There's also a tooling question. CodeQL queries, semgrep taint configs, and PHPStan-taint annotations are *very* different artifacts. A skill that says "write a CodeQL query" is doing a lot more work than a skill that says "write a libFuzzer harness," because the model has seen far less CodeQL than C. The skills here may need richer worked examples, more tool-specific scaffolding (a stub query template, a list of common predicates), and more explicit pointers to where to find the project's existing source/sink models. This is fine, just an asymmetry to flag: the skill burden grows as we move down the confidence gradient.

### Probably needs its own workflow: web vulnerabilities against deployed apps

XSS, CSRF, SSRF, IDOR, auth bypass against running web apps. We see three structural mismatches with the current workflow shape:

1. **Surface scoping comes first.** Web work starts from "what routes exist, what auth boundaries exist, what input vectors per route." That's a state the current workflow doesn't have. `analyze` assumes you can already point at code; web `analyze` often needs route enumeration (or proxy-based discovery against a running app) as a *prerequisite phase*. You can't propose a falsifiable hypothesis against `/api/v2/admin/widgets/:id` until you know that route exists and how to reach it.
2. **Threat model is a first-class axis.** Anonymous-attacker XSS, authenticated-low-priv IDOR, and admin-CSRF are different investigations against the same code. The orchestrator currently has no vocabulary for "which actor are we modeling." For systems-language fuzzing, the actor is implicit ("anyone who can deliver a malformed file"). For web, the actor is the most important variable in the entire investigation.
3. **Harnesses are stateful.** Cookies, CSRF tokens, multi-step flows, session fixation. `LLVMFuzzerTestOneInput` is the wrong shape. What you want is a request-replay framework with state — closer to a Burp scanner check or a nuclei template than a libFuzzer harness. The "oracle" also shifts: it's not "did the program crash" but "did a policy-relevant assertion hold" (response code, returned data, side-channel observations).

So the recommended split is:

- One workflow `code-vuln-discovery` (memory-safety + logic + taint-driven across compiled / managed / scripting). Structurally the same shape we have now, generalized vocabulary, surface-specific skills.
- A separate workflow `web-vuln-discovery` for stateful web app testing. Different states (route enumeration / threat model staging come before hypothesis generation), different harness metaphor (request replay), different oracle vocabulary.
- Some skills shared across both (severity rubric, report-writing voice, CWE mapping). The structural states differ.

The signal that would push us back to "one workflow rules them all" is if surface scoping and threat-model staging compress cleanly into `analyze` prompt instructions. We doubt it but haven't tried, and the cost of trying is mostly prompt iteration — comparatively cheap.

A weaker version of "needs its own workflow" worth considering: maybe the structural states of `web-vuln-discovery` are similar enough to `code-vuln-discovery` that the right move is to *parameterize the existing workflow with a "kind"* (`kind: code` vs `kind: web`) that swaps the prompt skeletons for a few specific states (`analyze` becomes `recon`, `harness_design` becomes `probe_design`). That's a workflow-engine feature we don't currently have but is plausibly cheap to build. The cost is one more layer of indirection in workflow YAML; the benefit is sharing the orchestrator and review states. We don't have a strong opinion yet — flagging it as an option to revisit.

## What "skills carry it" actually means in mechanics

It's worth being precise about what mechanism we're imagining when we say "skills carry the surface differences." The skills feature attaches markdown to states. Concretely:

- The orchestrator and per-state agents read their state's prompt, plus any attached skills, plus any task-level inputs.
- Skills are markdown — fragments of advice, vocabulary, worked examples — not executable. They don't change the state graph; they shape what the agent does inside a state.
- Multiple skills can presumably attach. Composition rules are TBD (precedence? merging? all of the above?).

Given that mechanism, the question "can skills carry surface X" reduces to: "can prose attached to existing prompts produce the right behavior at each state without changing the state graph or the routing logic?" For memory-safety across languages, the answer feels obviously yes — the state graph is genuinely the same, only the inside-the-state behavior changes. For taint-driven, the answer is "mostly yes, but `discover` needs more behavioral redirection from prose than other states do, and we should watch whether the prose has enough authority to override the orchestrator's expectations." For web, the answer is "no, because the *state graph itself* needs to change."

The dividing line is structural, not lexical. Skills are powerful at swapping vocabulary; less powerful at restructuring control flow. When a surface needs different control flow, that's the signal to fork the workflow.

## Sketches — concrete enough to argue with

### Sketch 1 — `memory-safety-c-cpp.md` skill outline

This isn't the skill content; it's the section structure we'd expect.

- **Surface overview.** Scope statement: this skill applies to native code with sanitizer support. Out-of-scope: managed runtimes, scripting language wrappers around C extensions (those have their own skill).
- **Common bug classes.** Heap OOB read/write, stack OOB, UAF, double-free, integer overflow at allocation site, type confusion at storage boundaries, sentinel collisions, signed/unsigned mixing, format string. For each: what the typical violation site looks like, what oracle catches it.
- **Tool selection.** When to reach for libFuzzer vs AFL++ vs honggfuzz vs custom; when to add UBSAN; when to use HWASan over ASAN.
- **Tier-by-tier worked examples.** Tier 1 (isolated function): "fuzzing a single parser entry point with structured input." Tier 2 (multi-component): "harness that wires the parser to the renderer to expose state-dependent crashes." Tier 3 (full build): "fuzzing the actual CLI binary with a corpus seeded from real-world samples."
- **Oracle vocabulary.** ASAN error class taxonomy. UBSAN check categories. How to read sanitizer output. When a crash isn't a bug.
- **Hypothesis phrasing recipes.** "Type narrowing at storage X," "off-by-one at boundary Y," "sentinel value Z collides with valid input under condition W." Examples of well-formed and badly-formed hypotheses.
- **Pitfalls.** Things this skill has seen go wrong: harness compiles but doesn't actually exercise the target function, sanitizer-disabled build masks real bugs, corpus seeding accidentally tests the wrong code path.

The skill is roughly self-contained. It does not need to know about the workflow states it's attached to — it just provides surface vocabulary the agent can lean on at each state. The workflow's `harness_design` prompt asks "design a harness consistent with the directive"; the skill answers "and here's what 'harness' looks like in this surface." The workflow's `discover` prompt asks "run the experiment and observe oracles"; the skill answers "and here are the sanitizer messages you should expect to see, with worked examples of true positives vs. instrumentation noise."

A useful informal length budget: each section maybe 50-150 lines, total skill ~600-1000 lines of markdown. Big enough to carry real content, small enough that the agent can attend to all of it. If we end up wanting much more, that's a signal to split (per bug class, per tool, etc.).

### Sketch 2 — `taint-driven-php.md` skill outline (the abstraction stretch)

The interesting question here is: what changes between this and the C/C++ skill, and where does the existing vocabulary feel awkward?

- **Surface overview.** PHP web codebases (WordPress plugins, Laravel apps, raw LAMP). In-scope: SQLi, command injection, path traversal, unserialize gadgets, SSRF via `file_get_contents`. Out-of-scope: client-side XSS (web workflow), CSRF token logic (web workflow).
- **Common bug classes.** Each one expressed as **source → transformations → sink**, not as **value → site**. This is the first big shape difference.
- **Tool selection.** PHPStan with taint plugin, Psalm `TaintedInput`, semgrep with custom rules, occasionally CodeQL. Choosing between them is a different decision than choosing libFuzzer vs AFL++ — it's about query language ergonomics and project-specific source/sink modeling overhead.
- **Hypothesis phrasing recipes.** "User-controlled `$_POST['x']` reaches `mysqli_query` through `$user->normalizeName()` without escaping." The form is a flow path, not a value range. The trigger-driven design class still maps — you're naming a specific source-sink pair as the falsifiable hypothesis. The coverage-driven class also maps — you're naming an under-modeled sink class ("we don't have shell-execution sinks modeled in our config; let's see what we find").
- **Tier mapping (where it stretches).** Tier 1 = single-file query against one source-sink pair. Tier 2 = project-aware query with custom sources for the framework's request abstraction and custom sinks for the app's DB layer. Tier 3 = full semantic flow with custom sanitizer models for the project's specific escaping helpers. This works, but Tier 2 and Tier 3 feel less distinct than they do in the fuzzer case — the line between "project-aware query" and "full semantic flow" is fuzzy. We may want to acknowledge that in the skill rather than fight it.
- **Oracle vocabulary.** No sanitizer. The oracle is "the analyzer reports the flow with no false-positive-suppression markers" plus "manual verification that the path is actually exploitable." The validation step is genuinely different — `harness_validate` against a fuzzer means "the harness compiles and reaches the target"; against a taint config it means "the analyzer parses the config, reaches the source, and the sink set is non-empty in the project."
- **Pitfalls.** Custom sanitizers in the codebase that the analyzer doesn't model (false negative). Framework-level escaping that the analyzer over-models (false positive). Reachability in the call graph that doesn't imply reachability via real input vectors.

The big shape difference: the C/C++ skill's hypothesis recipes are "value at site"; the PHP skill's are "flow path." If both skills sit under the same workflow, the orchestrator prompts need to phrase things abstractly enough that both fit, or we lean on the skill to do the translation locally (turn the orchestrator's "propose a falsifiable hypothesis" into the surface-appropriate form).

A second shape difference worth flagging: the *output* of the discover phase. For the fuzzer, the artifact is a crash file plus a sanitizer trace. It's effectively binary — the oracle either fired or it didn't, and if it fired you have a deterministic repro. For the taint analyzer, the artifact is a list of flow paths, each annotated with the analyzer's confidence, plus a request to manually verify which ones are exploitable. The triage state has more work to do here, and the skill needs to teach the agent to triage analyzer output critically rather than treating reported flows as confirmed bugs. That's a meaningful extension to what `triage` currently expects to do.

A third shape difference: corpus has no analog. The fuzzer skill talks at length about seed corpus, dictionary files, and structure-aware mutators. The taint skill replaces all of that with "source models" (where do we mark inputs as tainted?) and "sink models" (where do we mark dangerous operations as receiving taint?). The conceptual roles are similar — both control what the experiment exercises — but they live in totally different parts of the toolchain. The skill probably devotes a major section to source/sink modeling that has no peer in the C/C++ skill.

### Sketch 2.5 — what `code-vuln-discovery` looks like as a unified workflow

If `code-vuln-discovery` absorbs memory-safety + logic + taint-driven across a half-dozen languages, what does the workflow YAML actually look like? Some implications worth sketching:

- The workflow takes an explicit `surface` input at start (e.g. `surface: memory-safety-c-cpp`, `surface: taint-driven-php`, `surface: logic-jvm`). The orchestrator uses this to attach the right skill set.
- Each surface declares its skill bundle in a manifest somewhere (`workflows/code-vuln-discovery/surfaces/memory-safety-c-cpp.yaml`?). The bundle names the per-state skills, the persona overlays, and any surface-specific MCP server requirements (e.g., "this surface needs a libFuzzer MCP server available").
- The state graph is fixed across surfaces. Routing logic in the orchestrator is fixed across surfaces (with potentially small surface-aware tweaks like "for taint-driven surfaces, the discover loop is many-short-runs instead of one-long-run").
- The constitution is shared but with surface-specific guidance. We could either compile per-surface policy artifacts and switch them at workflow start, or compile one policy that's the union of what any surface might need. Probably per-surface — minimum-privilege wins over convenience.

The risk in a unified workflow is *prompt-bloat*. Every state's prompt has to be at least somewhat surface-aware, and skills have to redirect surface-specific behavior in every state. If the cumulative skill content is larger than the workflow YAML itself, we should reconsider whether the unification is paying for itself. Conversely, if surfaces share 80%+ of behavior across all states, unification is clearly winning.

### Sketch 3 — `web-vuln-discovery` state machine (rough)

Names of states, one-line descriptions. Highlight where it diverges from `code-vuln-discovery`.

```
scope_target → threat_model_select → recon → orchestrator →
  probe_design → probe_design_review → probe_execute → probe_validate →
  exploit_construct → triage → conclude → review → report_review
```

- `scope_target` — what is the target? Single endpoint, full app, specific feature? What auth do we have? **(New — no analog in code-vuln-discovery.)**
- `threat_model_select` — anonymous-attacker, authenticated-low-priv, authenticated-admin, multi-tenant escape? **(New — orchestrator-level concept that doesn't exist in code-vuln-discovery.)**
- `recon` — route enumeration, parameter discovery, tech-stack fingerprinting. May involve crawling, may involve reading source if available, may involve a passive proxy. **(New — replaces `analyze` with a much more interactive phase.)**
- `orchestrator` — same role as in code-vuln-discovery, different vocabulary.
- `probe_design` / `probe_design_review` — analogous to `harness_design` / `harness_design_review`. Stateful request sequence specs replace fuzzer harnesses. Probes carry auth context, expected response patterns, success oracles.
- `probe_execute` / `probe_validate` — analogous to `harness_build` / `harness_validate`, but the probe is just a request sequence; there's nothing to compile. `probe_validate` checks that the request sequence reaches the target endpoint and gets a sensible-looking baseline response, before the actual probe variants are run.
- `exploit_construct` — additional state where a confirmed finding is upgraded into a demonstrable exploit (chained PoC, screenshot, repro instructions). **(New — code-vuln-discovery folds this into `triage` / `conclude`, but for web it's substantial enough to deserve its own state because the exploit is often what convinces a downstream reader the bug is real.)**
- `triage`, `conclude`, `review`, `report_review` — same-shaped as code-vuln-discovery but the report templates differ (CVSS-with-attack-vector, repro steps, mitigation suggestions framed in HTTP/web terms).

The biggest divergences are at the front (scope + threat model + recon as three distinct states) and the addition of `exploit_construct`. The middle and back are recognizably the same shape.

A few specific things this state machine implies that we should be aware of:

- **Recon is open-ended in a way analyze isn't.** Code analysis terminates: at some point you've read the relevant files. Recon against a deployed app can theoretically continue forever (every new route surfaces new parameters, every new parameter surfaces new sub-states). The orchestrator needs a notion of "recon complete enough to start probing" that doesn't have a clean static analog. Maybe a budget (time / requests / route-count threshold). Maybe a coverage criterion (every advertised route fingerprinted at the auth boundary level).
- **Threat model is reversible.** It's natural to discover during probing that a hypothesized anonymous-attacker bug is actually only reachable by an authenticated user, which moves it from one threat model to another. The state machine should not treat threat-model selection as a one-shot early decision; it should be revisitable from `triage` if findings push back on it.
- **Probe execution is naturally rate-limited.** A fuzzer running locally is bound only by CPU. A probe sequence against a production-adjacent instance is bound by what the target can absorb, what the WAF will tolerate, and (for LLM-driven probing) what the agent can decide is "enough" without waiting for human input. The discover loop here may need explicit pacing logic that has no analog in fuzzing.
- **Authorization mid-flight.** Some web findings cross a confidentiality boundary in a way that fuzzing typically doesn't. If the probe successfully reads admin data, the agent now has admin data in its context. That's an escalation surface IronCurtain's policy layer cares about. The web workflow may need its own escalation triggers ("about to read what looks like another tenant's data; pause for human approval").

### Sketch 4 — vocabulary that probably needs to be lifted one rung up

If we go skills-first for `code-vuln-discovery`, here are terms in the current YAML prompts that may need generalizing — or may not, depending on whether we want the skill or the workflow YAML to do the translation work.

| Current term | Generalized candidate | Tradeoffs |
|---|---|---|
| "harness" | "experiment specification" | More general but less concrete. Loses the "thing you compile and run" implication that's load-bearing for fuzzing. Could keep "harness" and let the skill define what it means per surface — the agent has been trained on enough security material to handle the metaphor. |
| "harness_validate" | "experiment integrity check" | Same tradeoff. "harness_validate" is shorter and more vivid. |
| "Tier 1/2/3" | "scope: function / module / system" | More abstract, less scarred-by-experience. The numbered tiers carry implicit conventions ("Tier 3 means sanitizers on, full build") that the abstract scope words don't. |
| "ASAN/UBSAN fires" | "oracle triggered" | The orchestrator-level prompts probably want the abstract version; the skills can ground it. |
| "LLVMFuzzerTestOneInput" | "harness entry point" | Easy generalization — the term is C/C++-specific anyway and probably already lives in skills more than orchestrator prompts. |
| "trigger-driven / coverage-driven" | (keep as-is) | These already generalize cleanly. |
| "input corpus" | "input set" or keep as-is | "Corpus" is jargon but it's universal-enough fuzzing jargon that we don't lose much. For taint-driven work it doesn't apply at all, so the skill should suppress / replace it. |
| "sanitizer" | "oracle instrumentation" | Probably unnecessary generalization. The skill can say "your oracle here is the analyzer's TaintedInput report" without forcing the orchestrator prompt to use abstract language. |

We don't want to pick winners here. The tradeoff is: more abstract orchestrator prompts buy generality but lose grounding; the agent may under-perform on the concrete-vocabulary surfaces (C/C++) if we abstract too aggressively. A middle path is to keep the orchestrator prompts written in concrete C/C++-flavored language (because that's where most of our test investment is) and have non-C/C++ skills explicitly remap terms in their preamble: "in this surface, 'harness' means a CodeQL query specification."

That middle path has its own risk: the orchestrator's design-class routing decisions are made *before* a skill has fully translated the surface, so there may be cases where the orchestrator prompt itself needs to know about the surface to route correctly. We haven't worked through whether that's a real issue or not.

A third path worth naming: keep the orchestrator prompts concrete but write *parallel* prompt skeletons per surface, selected at workflow-start based on a declared `surface` input. This avoids the "abstract everything" tax and avoids the "skill fights orchestrator" failure mode, at the cost of duplicating prompt content across surfaces. Prompt drift between the duplicates is the obvious risk. If we find that 80% of the orchestrator prompt is identical across surfaces and only 20% varies, abstraction probably wins; if it's 50/50, parallel skeletons probably wins. We don't know the ratio yet.

One subtle point on the abstraction direction: when we say "lift the vocabulary one rung up," we have a choice about which rung. "Harness" is concrete-fuzzer-flavored. "Experiment specification" is one rung up — generic across fuzzers, taint queries, and probes. "Investigation artifact" would be two rungs up — generic across all of those plus, e.g., a manual analysis writeup. Going one rung is probably right; going two starts to drain meaning out of the prompts. If we ever find ourselves typing "investigation artifact" in a prompt, that's a sign we've over-abstracted.

## How this lands in the broader IronCurtain architecture

A few notes on how this interacts with parts of IronCurtain that already exist:

**Policy compilation per workflow.** Each workflow already has its own constitution and compiled policy artifacts. If we add `web-vuln-discovery` as a separate workflow, we need its own constitution. Web work needs different defaults than code work — outbound HTTP to an explicit target host has to be allowable, but the constitution should be vocally clear that "the target host" is one specific allowlisted endpoint, not the open internet. The policy compilation pipeline should already handle this (it accepts a `--constitution` and `--output-dir`); the work is in writing the constitution thoughtfully. For `code-vuln-discovery`, if it absorbs taint-driven and memory-safety surfaces, the constitution may need to declare both fuzz-execution and analyzer-invocation tool surfaces, and we should think about whether they share a common policy or need separate compiled outputs per surface.

**Sandboxing model.** Memory-safety fuzzing benefits enormously from running the target process under sanitizers, which is essentially a containerization-within-containerization concern. We already run agents in Docker; the *target* under fuzzing also wants its own resource constraints (memory cap, CPU cap, no network). For taint-driven static analysis, the sandboxing concern flips — the analyzer is heavyweight but trustable; the surface is the *codebase being analyzed*, which we don't want to execute. For web work, the sandbox needs to mediate outbound to one specific target. These three sandbox shapes are different, and each surface's skill probably wants to know about the sandbox shape it's living inside, even if it doesn't choose it.

**Multi-agent orchestration.** The current workflow uses persona-based agents (the orchestrator, the harness designer, the harness reviewer, etc.). The persona concept survives surface changes — there's still an orchestrator, still a designer, still a reviewer — but the persona prompts may need surface-specific overlays. That's again a skill concern (or maybe a persona-level skill, which is a cleaner attachment point than per-state skills for some content).

**Audit log and severity rubric.** These are essentially surface-neutral. A high-severity bug is a high-severity bug whether it's a heap OOB or an SSRF. The shared severity skill / report-writing skill probably attaches at workflow-end states and needs minimal surface-specific variation. If anything goes here, it's the CWE class taxonomy (memory safety has different CWEs than injection) and that's a small skill.

**Resource budgets.** Memory-safety fuzzing wants long-running budgets and lots of CPU. Taint-driven static analysis wants short-but-many-invocations budgets and lots of disk I/O. Web probing wants modest CPU but careful pacing. The `ResourceBudgetTracker` already supports per-session budgets; we may want per-workflow defaults. That's more of a configuration-shape concern than a skills-vs-workflow concern, but it's downstream of the same surface-categorization decision.

## Where this leaves us

Tentative: skills-first for the language and bug-class axis within `code-vuln-discovery`, separate workflow for web. The split point is roughly "is there compileable / runnable / queryable code we can point an analyzer at" vs "is the target a stateful running service with auth boundaries." That's a coarse heuristic and we'll probably find counterexamples (e.g., API fuzzing of a running service might fit into web; fuzzing a wasm module looks like code-vuln-discovery but has its own oracle quirks).

We have not validated any of this empirically. The next experiment is the smallest one that would tell us whether the skills-first path holds up at all.

Some specific things this brainstorm explicitly *does not* answer that future-us should not assume are settled:

- Whether the orchestrator's routing logic itself needs a "surface-aware" mode, or whether routing decisions are surface-neutral.
- Whether `harness_design_review` (a separate state today) makes sense for taint queries and probe specs, or whether the review burden is shaped differently for non-fuzzer artifacts.
- Whether the report templates at the back of the workflow (`report_review`) need more variation than just CWE/severity vocabulary swaps. A memory-safety bug report and a SQLi bug report have very different "convince a downstream reader" surface area.
- Whether we want the workflow to run *cross-surface* — e.g., during memory-safety fuzzing of a C extension, opportunistically notice that the Python wrapper has a path traversal bug and follow that thread. We currently can't, and probably shouldn't try to in v1, but it's a feature shape that we should be aware we're foreclosing.

## Authorship and maintenance economics

The skills-first vs separate-workflow choice has a non-obvious cost dimension that's worth thinking through.

**Skills-first (one workflow, many skills).** Initial cost is mostly skill authoring — for each new surface, write one skill, attach to existing states. Each skill is independent; skill drift doesn't propagate. Workflow YAML stays small. Adding a new surface is "write a skill," which is a self-contained unit of work that one person can do in one sitting (probably). Risk: the workflow's prompts become a least-common-denominator that fits all surfaces but doesn't excel at any. Risk: regression in one skill is invisible from the workflow's perspective; we need per-skill evaluation harnesses.

**Separate workflow per surface.** Initial cost is higher — full state machine, prompts, possibly persona overlays per workflow. But each workflow can be tuned for its surface without compromise. Adding a new surface is "write a workflow," which is a much larger unit of work. Risk: shared concerns (severity rubric, escalation, reporting) drift across workflows over time; bug fixes have to be ported. Risk: the catalog of workflows balloons and discoverability suffers.

**Hybrid (a few workflows, many skills per workflow).** What this brainstorm tentatively recommends. Two workflows, with skills carrying the language-and-bug-class axis inside each. Initial cost is moderate; the surface count we expect to support fits in two workflows for the foreseeable future. Drift surface is small (only two workflows to keep aligned); per-skill evaluation is still possible. Risk: if the boundary between code and web turns out to be wrong (e.g., API fuzzing of a deployed service) we've baked in a split that's hard to renegotiate.

The factor that pushes us toward hybrid rather than skills-only is the structural divergence in `web-vuln-discovery` — multiple new states at the front, plus state revisitability for threat-model changes, plus the `exploit_construct` state. Trying to express all of that as skill-level prose attached to a state machine designed for code work feels like fighting the abstraction. The factor that pushes us away from "many separate workflows" is that we don't actually *want* a separate workflow per language. There's no `memory-safety-c-cpp` workflow distinct from a `memory-safety-jvm` workflow; they really are the same investigation with different vocabulary.

## Adjacent considerations

A few topics that came up in the discussion but didn't fit neatly into the confidence gradient.

**Skills as documentation, skills as runtime-active prompts, skills as both.** A `memory-safety-c-cpp.md` that the agent reads at every state versus one that's loaded once at the start of the workflow versus one that's selected per-state has different content shapes. A document the agent re-reads many times can be longer; one consumed once needs to be tighter. This affects how we author the skill, not just what we put in it.

**Cross-surface knowledge transfer.** If the agent finds a bug in libtiff's color-decoding path and we run a similar workflow against libwebp, can the prior finding inform the new run? Skills are static markdown; "what did we learn last time" is dynamic. There may be a separate axis of "learnings" or "case studies" that's adjacent to skills but not the same thing. We're not building this and we shouldn't, but it's worth noticing the gap.

**Workflow forks vs workflow extensions.** If we go with two workflows (`code-vuln-discovery` and `web-vuln-discovery`), some shared content (severity rubric, report writing) probably wants to live somewhere that *both* workflows pick up. We don't currently have a "shared workflow component" abstraction. Cross-workflow skills are one possible shape; a "library of skills" referenceable from any workflow is another.

**Surface detection as a workflow itself.** Imagine a small upfront `surface-classify` workflow that takes a target description and outputs a `surface` declaration suitable for feeding into `code-vuln-discovery` or `web-vuln-discovery`. This avoids putting surface detection inside the discovery workflow itself, where a wrong call can cascade. We're definitely not building this on day one but the option is worth filing.

**Per-target setup costs.** Every fuzzing engagement has setup overhead — picking the right corpus, finding sample inputs, getting the build to compile with sanitizers. Web has setup overhead too — getting credentials, finding a non-prod environment, configuring the proxy. Taint has setup overhead — modeling the project's sources and sinks. These costs are uneven across surfaces and they affect what "running the workflow" actually means in practice. The skills can teach the agent to expect and budget for setup, but the workflow's resource budgeting needs to admit that early states (analyze, harness_design) can take a *lot* of time before the first real probe runs.

## Open questions

We are deliberately not resolving these — they're parked for the next iteration.

- **How do skills attach to states?** Per-state? Per-surface? Both? What's the precedence when multiple skills apply? (E.g., a `language-java.md` skill plus a `bug-class-deserialization.md` skill plus a `state-harness_design.md` skill could all be relevant to one prompt.)
- **How does the orchestrator know which surface it's working in?** Inferred from the task description (fragile), declared in workflow inputs (rigid), picked at workflow-start time via an LLM-backed surface classifier (more flexible, more moving parts), or set by an explicit early state (`detect_surface` analog of `scope_target`)?
- **For the taint-driven case, does `harness_validate` even make sense?** Or does it become `query_validate` with different success criteria? If we fork it, we need a third workflow; if we generalize it, we pay the abstraction cost everywhere.
- **For the memory-safety-across-languages case, is "Tier 1/2/3" the right vocabulary?** Or should it be something more abstract (`function / module / system`)? The numbered tiers carry institutional baggage from libFuzzer practice; abstract names lose that grounding but generalize.
- **How much skill content can be shared across languages with the same bug class?** Does `memory-safety-c-cpp.md` and `memory-safety-rust.md` share 80% of their content? If so, do we factor out shared content into a `memory-safety-common.md` and have language-specific skills reference it? (This is a skill-system architecture question that affects whether we want skill composition / inheritance at all.)
- **For web vulns specifically, do we want an LLM-driven workflow at all?** Or is this better served by mature existing tools (ZAP, Burp, nuclei) wrapped in the IronCurtain mediation layer with the agent doing only the high-level orchestration ("run the ZAP active scan, then triage findings against this threat model")? That's a different design altogether — IronCurtain as a wrapper around web-pentest tools rather than an LLM-driven web-pentest workflow.
- **How do we evaluate workflow success?** Memory-safety has clear oracles — sanitizer fired, repro available. Web vulns have less clear ones — was it actually exploitable, was it a false positive, did the agent confuse a 403 for confirmation of an IDOR? Taint-driven static is even murkier — the analyzer reported a flow, but that's a report, not a confirmed bug. The workflows we end up with may differ less in their state machines than in their *evaluation harnesses* — what counts as ground truth varies enormously by surface.
- **Does `analyze` belong in `code-vuln-discovery` at all in its current form?** It's currently doing double duty: surface scoping and hypothesis seeding. If we generalize the workflow, those may want to split.
- **What about hybrid surfaces?** A Python web app with C extensions has memory-safety bugs in the C, taint-driven bugs in the Python, and web vulns in the routing layer. Does the workflow need to support changing surface mid-run, or do we treat each surface as a separate workflow invocation?
- **How do the skills interact with the policy layer?** IronCurtain's policy engine treats different MCP servers and tool calls differently. A taint-driven workflow needs aggressive read access to the project tree; a web workflow needs network access to a target host; a fuzzing workflow needs to spawn long-running native processes. Whether each surface needs its own constitution / compiled policy is an open question — it might be cleaner to have one constitution per workflow, and then the workflow YAML implicitly defines its surface's policy needs.
- **Are there surfaces we haven't named that we should consider before locking the split?** Smart contracts (Solidity, Move), kernel modules, eBPF programs, hardware HDL (Verilog), GPU shaders, ML model security (prompt injection, training data poisoning) — each of these has its own oracle vocabulary and workflow shape. We're not committing to supporting any of them, but if the abstractions we pick now exclude them by accident, we should know it.
- **Where do skills end and tools begin?** A skill is a markdown prompt fragment. A tool is an MCP server providing executable capability. Some of the surface differences (e.g., "use Jazzer instead of libFuzzer") are partly skill (knowing to use it, knowing the output format) and partly tool (having Jazzer available to call). The split between "the agent reads about Jazzer in a skill" vs "the agent calls a `jazzer` MCP tool" affects what kind of investment we put where.
- **What's the authoring cost of a new skill?** If a competent skill is 600-1000 lines of careful markdown with worked examples, that's a meaningful chunk of work — probably a week or more for the first one in a new family, faster for subsequent ones once the template settles. We should size our ambition accordingly; we are not going to ship eight surface skills in one quarter.
- **How do we test a skill?** Skills are markdown — we can't unit-test them. We can run the workflow with the skill against a known-vulnerable target and check that the agent finds the bug. That's an end-to-end test, slow, expensive, and noisy. Without per-skill testing, regression detection is weak. This is a real problem for the maintenance economics.
- **What happens at workflow boundaries when a finding crosses surfaces?** Some bugs are inherently cross-surface (a memory-safety bug in a JVM JNI call has C and Java parts). Our split puts both inside `code-vuln-discovery`, which is fine — but the skill selection becomes more nuanced. Do we attach two skills (`memory-safety-c-cpp.md` and `memory-safety-jvm.md`) and trust the agent to pick the right vocabulary at each step, or do we have a `memory-safety-jni.md` that subsumes both?

## Next step

The smallest experiment that would give us signal: pick one non-C/C++ surface where we already have a known bug — probably a memory-safety bug in a JVM library that Jazzer can reach — author a `memory-safety-jvm.md` skill, and run the existing `vuln-discovery` workflow against it with no other changes except the skill. If the agent can find the bug end-to-end with just a skill swap, that's strong evidence the skills-first path is real. If it stumbles on workflow-vocabulary mismatches (orchestrator prompts demanding C++-shaped artifacts, harness_validate prompts assuming sanitizer output), we learn exactly which prompts need lifting one rung up. Either outcome is cheap and informative, and the artifacts produced (the skill, the failure logs, any prompt rewrites we end up needing) feed directly into the next iteration. If the experiment goes well we run a second one against a taint-driven PHP target — the case we expect to be the *hardest* successful skills-first case — to see whether the strain points we predicted are real. The web case we don't experiment on yet; we only commit to the second workflow if the first two go through cleanly and we've talked ourselves into the structural divergence being real.
