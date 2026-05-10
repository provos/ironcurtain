# MOAK vs. IronCurtain `vuln-discovery` — Comparison

A research note comparing MOAK ("Mother of All KEVs"), a five-agent autonomous-exploitation pipeline, with IronCurtain's bundled `vuln-discovery` workflow at `src/workflow/workflows/vuln-discovery.yaml`.

The two systems superficially overlap (multi-agent, LLM-driven, vulnerability-focused) but solve disjoint problems: MOAK *exploits a known CVE*, our workflow *discovers an unknown bug in code-in-scope*. Most of what one does well is irrelevant to the other. The interesting comparisons are in the few places where they overlap structurally — judging, harness/environment construction, the discipline imposed on the LLM by separated roles.

## 1. What moak.ai is

MOAK is a stealth-mode product from a Sequoia-backed cybersecurity startup, founded by Yair Saban and Niv Hoffman. The site presents it as "the first agentic AI workflow to exploit hundreds of dangerous vulnerabilities in minutes" ([moak.ai](https://moak.ai/), site `<meta>` tag and SPA hero text). Their pitch, taken verbatim from the React SPA bundle at `https://moak.ai/assets/App-ClOOK4Yr.js`:

> "AI attackers aren't coming - they are here. To prove it, we built MOAK - an agentic workflow that autonomously exploits 98% of open source KEVs (Known Exploited Vulnerabilities) using publicly available models." (moak.ai, "MOAK" page)

> "MOAK is a security research initiative created by a stealth cybersecurity startup." (moak.ai, footer / about)

The scope is explicitly *Known Exploited Vulnerabilities* from CISA's KEV catalog (a few hundred per year of attacker-validated CVEs), not the full ~30k/year CVE firehose. Input is a CVE ID. Output is a working exploit captured against a containerized victim plus a "Confidence Score" rendering on a public dashboard. The marketing framing is policy-oriented — they explicitly position MOAK as a counter-argument to Anthropic's claim that public models lack offensive capability ("Anthropic recently announced that Mythos, their next model, has dangerous exploitation capabilities… We have proven that public models like Opus 4.6 and GPT 5.4 already unlock the ability to autonomously exploit almost any vulnerability the moment it drops" — moak.ai). Founder Yair Saban posted on LinkedIn that "Anthropic got it wrong" ([Yair Saban LinkedIn post](https://www.linkedin.com/posts/yair-saban-30615870_anthropic-moak-glasswing-activity-7448067178278494209-XM3i)).

The headline numbers from the site's "How Does MOAK Work?" article:

- 178 KEVs attempted, 174 successfully exploited (≈98% success), all containerizable targets (moak.ai, "How Does MOAK Work?" / "AI Comparison Deep Dive" section).
- Earlier batch of 122 KEVs run unattended over a weekend → 103 exploited, 84% first-try, 82% in under an hour (moak.ai, "MOAK: Mother of All KEVs" narrative).
- React2Shell exploited end-to-end in 21 minutes with no human in the loop (moak.ai, `#react2shell` page; also covered in [resilientcyber.io](https://www.resilientcyber.io/p/the-industrialization-of-exploitation)).
- Most KEVs in high-level languages (Python, JavaScript, Java, PHP); they note "similar results were achieved in tests of native C application CVEs," and flag closed-source / Firefox-class targets as needing more HITL (moak.ai, "How Does MOAK Work?").
- The same success rate measured on "KEVs that were disclosed after the knowledge cutoff" of the models used (moak.ai).

Press / commentary corroborating these claims: [Chris Hughes' Resilient Cyber piece](https://www.resilientcyber.io/p/the-industrialization-of-exploitation), [CyCognito blog](https://www.cycognito.com/blog/mythos-moak-ctem-and-the-end-of-cve-chasing/), [demo video on YouTube](https://www.youtube.com/watch?v=ccLukSFnFM8), [Crunchbase profile of Yair Saban](https://www.crunchbase.com/person/yair-saban). Their public dashboard at `moak.ai/#dashboard` continuously runs new CVEs and labels each as "Fully Exploited by AI" or annotated with the level of HITL required.

## 2. Architecture & agent design

Five sequential agents, plus a swarm of sub-agents inside the Researcher and a verifier sub-agent inside the Judge. The text below is taken from the SPA bundle at `https://moak.ai/assets/App-ClOOK4Yr.js` (the `#how-it-works` page).

### Agent 1 — Collector ("information source")

Sole input is a CVE ID. Collects:
- CVE description.
- Source code of vulnerable and patched versions.

Hard-coded constraint: "Strict guardrails block access to any external exploit databases or PoC repositories. The pipeline works from first principles." (moak.ai)

> "To simulate exploitation of a new CVE, we created architectural guardrails that ensure the collector only accesses information from specific sources that don't include POCs or exploitation details at all… As far as we know, this is the first workflow that has these guardrails and fully simulates an exploit of a new disclosed CVE." (moak.ai)

After this stage the rest of the pipeline runs with no external data access.

### Agent 2 — Researcher ("the mad scientist")

Distills exploitation primitives from the diff between vulnerable and patched code, then explores multi-primitive chains as a graph. The graph is the central data structure. Quoting moak.ai:

> "To find the full primitives chain of the vulnerability, the Researcher builds a graph of possible primitive chains, acting as the mind map of the research. It then spawns a multi-model sub-agent swarm that combines Claude, GPT, and Gemini models responsible for researching and expanding the primitives graph."

Sub-agent roles ("Each sub-agent has a distinct role"):

- **Prioritizer** — "scores all active leads by chain relevance."
- **Lead Researchers** — "each takes a top-scored lead and digs deep. Scoped to only their lead and its predecessors in the graph."
- **Contrarian** — "designed to assume all existing leads are wrong, this sub-agent ignores them and finds an alternative path from scratch."
- **Verifier** (this is the *intra-Researcher* verifier, distinct from the Judge's separate verifier) — "statically verifies whether any lead has completed a full exploitation chain."

Mixture-of-Agents (MoA) discipline: "Agents rotate roles between runs - a form of role diversification that reduces groupthink and prevents any single model's biases from anchoring the research." (moak.ai)

Output is "the exploitation recipe" passed downstream.

### Agent 3 — Environment Builder ("the architect")

Builds a Docker environment that reproduces the vulnerable system. Two specific behaviors:

1. Provisions only what the vulnerability needs — "ensuring no unnecessary primitives or bypasses exist (for example, privileged admin access to the server being available to the next agent, the Exploiter)." (moak.ai). This is an explicit cheat-prevention mechanism.
2. "A secret flag is inserted that the Exploiter must capture to prove the exploitation was successful. The flag location is specific to the vulnerability type - a flag file for a read file vulnerability, a record in a database table for an SQL injection, and so on." (moak.ai)
3. Builds a *parallel patched copy* of the same environment.

> "Once the final Docker environment is composed and verified as functional, an identical copy is created with the patched version of the vulnerable application. This allows later verification that the exploit targets the actual vulnerability rather than an unrelated flaw." (moak.ai)

### Agent 4 — Exploiter ("the hacker")

> "The Researcher created the recipe to the exploit, and the Exploiter cooks it… It builds a program that exploits the vulnerability based on the chain the Researcher provided. Then, it spawns a sub-agent that validates the exploitation by running it against the environment, validating that the flag is correct and making sure it doesn't work on the patched environment. If the exploitation fails, the error logs are returned to the Exploiter as feedback, and it runs in a loop until it succeeds." (moak.ai)

Two-condition success criterion: flag captured on vulnerable image AND flag *not* captured on patched image. This is a differential test, structurally analogous to a fuzz oracle but binary.

### Agent 5 — Judge ("the police officer")

Cross-cutting auditor. Three concrete jobs documented:

1. Anti-cheat surveillance over Builder and Exploiter — "we noticed that the Builder sometimes created an environment with an alternative high-privilege access path (like a web server with admin capabilities), and the exploit used that instead of the actual vulnerability. The Judge supervises both the Exploiter and Builder agents to prevent these workarounds." (moak.ai)
2. HITL grading — "If human-in-the-loop (HITL) is required for the exploitation, the Judge assesses the level of HITL needed based on exploitation complexity and determines how close the autonomous workflow came to succeeding." (moak.ai)
3. Calibration via PoC comparison (when one exists) — "A separate verifier sub-agent searches for public proofs of concept, if any exist, and evaluates the lab exploitation quality against them." (moak.ai)

Final output: "an exploitability score alongside a structured judgement report." (moak.ai, the public dashboard renders this as "AI Exploitation Status" + "Confidence Score").

The dashboard's audit checklist (visible as flat strings in the SPA, rendered as a six-step animation):

> "Verify exploit targets the *real vulnerability* / Validate *attack path* uses no prior knowledge / Confirm *patched version* blocks the exploit / Check for *hardcoded flags* or shortcuts / Assess *exploitation complexity* & realism / Assign *AI Exploitation Status* & Confidence Score" (moak.ai SPA, `Is` component)

### Models

> "We noticed a dramatic increase in success rate when using the latest public models released at the beginning of 2026 - Claude Opus 4.6, OpenAI GPT-5.4, and Google Gemini 3.1 Pro… To investigate further, we created an exploitation benchmark of KEVs which were published after all of the models' knowledge cutoffs (September '25)." (moak.ai)

Roles are not statically pinned to a single model; the Researcher swarm rotates Claude/GPT/Gemini across roles between runs.

## 3. Source code availability

Closed.

> "To prevent misuse, we have chosen not to publish the workflow as open source at this time. Please contact us if you are interested in accessing it for academic or research purposes." (moak.ai, "How Does MOAK Work?" / safety footer)

> "For safety reasons, we do not publish full or indicative artifacts regarding the exploitation itself." (moak.ai, dashboard tooltip)

There is no GitHub organisation or repo associated with the project, no released paper, no published prompts, no released benchmark dataset, no sample exploit. The site has a JS bundle (the source of every quote in this document) but no semantically interesting content beyond the marketing copy and the per-CVE "Confidence Score" rendering. The dashboard does, however, expose API endpoints — `/cve/{id}/public-detail`, `/cve/{id}/summary` — that return per-run summaries and a sanitized "captions" object showing the agent tree, but with the actual exploit code redacted. That sanitized output is the closest thing to public artifacts.

Note: the [arxiv preprint 2509.01835 "From CVE Entries to Verifiable Exploits"](https://arxiv.org/html/2509.01835v1) (CVE-Genie) is a *different* project with strikingly similar architecture (Processor / Builder / Exploiter / CTF Verifier with paired developer-critic agents and CTF-style flag verification). It is open about its approach — 11 sub-agents, ablation tables, $2.77/CVE on a 841-CVE evaluation, 50.8% reproduction rate, plans to release source and dataset. CVE-Genie is academic and reproduction-focused; MOAK is product-focused and on a different rev (98% on KEVs, 174/178). They appear to be parallel inventions of the same idea.

Public press footprint for MOAK:
- [moak.ai](https://moak.ai/) — site (SPA, no static text, content lives in `assets/App-*.js`).
- [Demo video — YouTube `ccLukSFnFM8`](https://www.youtube.com/watch?v=ccLukSFnFM8).
- [Resilient Cyber — "The Industrialization of Exploitation"](https://www.resilientcyber.io/p/the-industrialization-of-exploitation).
- [CyCognito — "Mythos, MOAK, CTEM and the End of CVE Chasing"](https://www.cycognito.com/blog/mythos-moak-ctem-and-the-end-of-cve-chasing/).
- [LinkedIn announcement by Yair Saban](https://www.linkedin.com/posts/yair-saban-30615870_anthropic-moak-glasswing-activity-7448067178278494209-XM3i).
- [Crunchbase company profile](https://www.crunchbase.com/organization/moak).

## 4. Side-by-side comparison

The two systems are not symmetric. MOAK reproduces an *already-disclosed* vulnerability inside a synthetic environment it controls. Our `vuln-discovery` searches for an *undisclosed* vulnerability inside a target codebase the user provides. The table below compares them on the dimensions the task requested; "N/A" means a dimension is meaningful for one but not the other.

| Dimension | MOAK | `vuln-discovery` |
|---|---|---|
| **Input** | A CVE ID. ([moak.ai](https://moak.ai/), Collector description: "Starting from just a CVE ID…"). | A free-form task description that defines scope (file/dir/module), vuln class, threat model. `vuln-discovery.yaml` lines 17-22 elevate this to a hard rule: "The task description is the source of truth for: Scope… Goal… Threat model." |
| **Output** | A working exploit + flag capture + Confidence Score on a public dashboard. | A `.workflow/report/report.md` with confirmed findings, "findings without demonstrated impact," mitigated issues, and coverage gaps (`vuln-discovery.yaml` lines 749-797). |
| **Hypothesis generation** | Diff-driven and known-good: the patch tells the Researcher exactly what to attack. The Researcher then expands a primitive graph from there. | Discovery-driven: no patch exists. `analyze` builds a "function catalog with assumption inventory" and "cross-cutting data flow analysis" (lines 48-67). The orchestrator's `directive` to `harness_design` and `discover` is what scopes a hypothesis (lines 97-105). The directive is *required*: "If you cannot write a concrete, specific directive… set verdict to `escalate`" (line 99). |
| **Tiering** | None. There is one environment shape (Docker container reproducing the vulnerable system, plus its patched twin). | Three explicit tiers (lines 215-225): Tier 1 isolated function test, Tier 2 multi-component, Tier 3 full build with sanitizers and protocol framing. Tier selection is a function of hypothesis scope: "Hypothesis names ONE function → Tier 1; Hypothesis involves a value flowing between 2+ functions… → Tier 2 minimum; Hypothesis requires real initialization, protocol framing, or global state → Tier 3" (lines 222-225). |
| **Harness construction** | Environment Builder constructs Docker images. Cheat-prevention is explicit: "no unnecessary primitives or bypasses" (e.g., refuses to expose admin paths the exploit could shortcut through). Patched twin built for differential validation. | A separate `harness_design` → `harness_design_review` → `harness_build` → `harness_validate` pipeline (lines 293-595). Design-review is itself an LLM checklist agent with eight pass/fail items (lines 403-418). Validate has a maxVisits of 4 with explicit human-gate escalation (line 538, 468-494). |
| **Fuzzer-feedback validation** | None — MOAK does not fuzz. The Exploiter writes a deterministic exploit and tries it against the live victim; the loop is "errors → re-write" until the flag fires. | First-class concern. The orchestrator audits return from `harness_validate` for two preconditions (line 159): "(a) the target function reached with non-zero coverage, AND (b) the fuzzer's self-reported feedback metric (e.g., libFuzzer `cov:` / AFL++ edge count) recorded in `validation.md` passed the threshold." `harness_validate`'s step 4 is load-bearing: "Fail approval unless BOTH: (a) Target-code fuzzer-feedback count ≥ **1000**… (b) Audit-coverage line coverage of the target source file ≥ **20%**" (lines 555-557). |
| **Discover/triage loop** | Exploiter loops until flag captured, then Judge runs once. Single round of validation per attempt. | Hypothesis-driven loop: orchestrator → discover → orchestrator → triage → orchestrator. Discover has three verdict outcomes (`approved` / `rejected` / `blocked`) each with explicit re-routing logic (lines 165-179). Triage has its own three-verdict outcome (`approved` / `insufficient` / `escalate`, lines 705-711) and the orchestrator must respond to `insufficient` by re-routing to `discover` with a specific gap, never by re-running triage (lines 198-201). |
| **Journal / state** | Not described. The dashboard caches per-CVE final state. | Persistent investigation journal at `.workflow/journal/journal.md` (lines 113-145). Two parts: a status header updated in place and an append-only log per round. The orchestrator's *Evidence* and *Decision* sections are mandatory and the journal is "the investigation's permanent record" (line 142). The orchestrator is constitutionally a router and forbidden from reading source code (lines 86-87). |
| **Human gates** | None during exploitation — autonomous all the way through. The Judge produces a HITL grade *post-hoc* describing how much human help would have been needed. | Three explicit human gates: `harness_design_escalation`, `harness_validate_escalation`, `human_escalation`, plus a final `report_review` (lines 274-291, 443-494, 812-830). The pre-flight workflow expects to escalate when the design or validation loop hits its cap (e.g., `harness_validate.maxVisits: 4` line 538). |
| **Severity discipline** | Single Confidence Score. No CVSS, no impact decomposition. | Strict triage with nine mandatory items including reproduction, effect realism, attacker control surface, channel reality, production hardening, external exploitability trace, duplicate/CVE check, and CVSS 3.1 anchored on "demonstrated evidence" (lines 689-704). Conclude carries a "Severity fidelity" rule: "Severity for each finding MUST match triage's assessment in `.workflow/triage/triage.md` verbatim — same CVSS vector, same numeric score, same justification. Do not re-score" (line 737). |
| **False-positive controls** | (a) Patched twin must *not* exploit. (b) Judge anti-cheat against environment shortcuts (admin paths). (c) Judge "Check for hardcoded flags or shortcuts" audit step. | (a) `harness_validate` step 4 distinguishes fuzzer-feedback coverage from audit coverage to detect "wrapper-only instrumentation" silent failures (lines 542-556). (b) Triage's "Effect realism" rule rejects observations that are attacker's own input echoed, zeroed memory, schema-sanitized placeholder, or non-exploitable error path (lines 691-696). (c) Conclude's "Contradiction handling" rule scores at the weaker demonstrated level when a Tier-1 detector fires but Tier-3 effect is absorbed (line 741). (d) Detector-vs-impact split: orchestrator is forbidden from routing harness_validate → triage without a discover round in between (line 231). |
| **Model selection** | Claude Opus 4.6, GPT-5.4, Gemini 3.1 Pro across the Researcher swarm; MoA role rotation. | Single model: `anthropic:claude-opus-4-7` (line 9). Per-state override possible per WORKFLOWS.md but unused. |
| **Evaluation methodology** | 178 KEVs, 174 succeeded ("How Does MOAK Work?"). Earlier batch: 122 → 103 first-try (84%). Carve-outs: container-only targets, mostly high-level languages. Validates against post-cutoff CVEs to control for memorization. | No public benchmark. The workflow is self-evaluating through the structural rules (was a discover round run? was fuzzer-feedback above threshold?). Calibration is the human's job at the report-review gate. |
| **Scope** | Closed — CVE ID only. The user does not steer the investigation mid-flight. | Open — task description steers everything. The orchestrator's directive replans every round. |

## 5. What MOAK appears to do better

Five concrete things, most of them anchored in the fact that they *have* a ground-truth artifact (the patch) and we don't.

1. **The patched twin as a built-in differential oracle.** Every exploit attempt is checked against both the vulnerable and patched images. The patched-twin condition collapses an entire class of false positives into a single binary check: did this only work because the bug exists, or is something else wrong? (moak.ai, Builder & Exploiter descriptions). We don't have a "patched twin" because we don't know what the bug is yet — but in cases where the user is doing a fix-validation pass, the same idea is applicable to us and we don't model it.
2. **Cheat-prevention as a first-class agent.** The Judge explicitly watches for the Builder accidentally provisioning a privileged path the exploit then uses ("the Builder sometimes created an environment with an alternative high-privilege access path… the exploit used that instead of the actual vulnerability"). This is a category of false positive that does happen in real fuzz environments (over-privileged harnesses, leaked test backdoors) and we have no equivalent guardrail.
3. **Architectural information firewall.** Collector is the *only* agent allowed to touch the network, and it is restricted from reading PoC databases ("Strict guardrails block access to any external exploit databases or PoC repositories. The pipeline works from first principles" — moak.ai). We rely on the policy engine plus prompt instructions to prevent the discover agent from grepping the web for prior PoCs, but we don't wall off the boundary by agent role.
4. **Mixture-of-Agents with role rotation in the research swarm.** The Researcher swarm rotates Claude/GPT/Gemini across the Prioritizer/Lead Researcher/Contrarian/Verifier roles between runs to "reduce groupthink." We use one model (`anthropic:claude-opus-4-7`) for every state. MoA is plausibly a useful trick *specifically for the discover agent* where adversarial framing matters; it is overkill for analyze or for orchestrator routing.
5. **A "Contrarian" sub-agent whose job is to assume the leading hypothesis is wrong.** This is a clean distillation of an idea our orchestrator gestures at (the "blocked" verdict requires execution-based evidence, line 169) but doesn't enact: have a worker whose only job is to refute. We bake the refutation discipline into the orchestrator's prompt; MOAK gives it a dedicated agent.

## 6. What `vuln-discovery` appears to do better

Mostly downstream of the fact that we are searching, not reproducing.

1. **Tiering matched to hypothesis scope with explicit "no Tier 1 for cross-component" rule.** From `vuln-discovery.yaml` line 225: "Never use Tier 1 for a cross-component hypothesis. If in doubt, go higher." MOAK has a single environment shape — it can afford to because the patch points it at the right component. We can't, so we encode the matching rule.
2. **Fuzzer-feedback metric as a load-bearing gate, separate from audit coverage.** The harness_validate prompt makes this explicit at line 542: "Audit coverage… is orthogonal to fuzzer-feedback (libFuzzer's PC-guard counter, AFL++'s coverage map, or a runtime agent's instrumented-class report). A harness whose wrapper is the only unit with fuzzer-feedback instrumentation will report healthy line coverage AND burn millions of iterations on blind random mutation." MOAK doesn't fuzz — but for any system that does, this distinction is the difference between real progress and silent failure, and we encode it precisely.
3. **Detector-evidence-vs-impact-evidence split.** Line 231: "A validated harness tells you a detector fired (sanitizer, fuzz crash, static analyzer, tainted-flow report, assertion). That proves the detector caught something; it does NOT prove an attacker can demonstrate impact in the real system… If you are about to route `harness_validate` → `triage` without a `discover` round in between, stop — route to `discover` first." MOAK's flag-capture model collapses these — flag-capture is impact by definition. For us, where the "bug" might be an OOB read landing in zeroed padding, the split matters.
4. **Triage with nine mandatory items and CVSS anchored on demonstrated evidence.** Lines 689-704. Triage explicitly distinguishes between adversary-uncontrolled target state (genuine impact), attacker's own input echoed back (no impact), zeroed memory (no impact), and crashes the attacker can't steer (no impact). The "Effect realism" rule (lines 691-696) is not present in MOAK because MOAK doesn't *need* it — flag capture is unambiguous.
5. **Severity fidelity in the report writer.** Conclude (lines 736-745) is forbidden from re-scoring, strengthening "Medium" to "Medium-High," or adding confidentiality claims triage didn't make. This is a discipline against report-writer-LLM creep that MOAK doesn't seem to encode (or doesn't disclose).
6. **Append-only journal with status-header and per-round Evidence/Assessment/Decision.** Lines 113-145. The orchestrator alone writes it; never edits prior rounds. This makes investigation history auditable in a way MOAK's per-CVE summary endpoint doesn't.
7. **Hard router rule on the orchestrator.** Lines 85-87: "You are a ROUTER. Do NOT read source code files, do NOT analyze code, do NOT write code." This separation prevents the most expensive failure mode in long-running multi-agent loops, which is the orchestrator agent quietly re-doing the work of its sub-agents. MOAK's published descriptions of Researcher/Judge don't surface this discipline (which doesn't mean they don't have it, just that it isn't on the website).
8. **Visit caps with cap-precedes-rejection ordering.** The `harness_validate.maxVisits: 4` (line 538) plus the fact that the cap-guarded transition is ordered *before* the rejection transitions (lines 587-595, with a comment on line 587) means the cap actually fires. The lint catalog (`WF008` in WORKFLOWS.md line 204) flags this exact mistake at workflow-validation time. MOAK has no equivalent disclosed bound.
9. **Human gates in the loop.** Three of them, with documented APPROVE/FORCE_REVISION/ABORT semantics and a "feedback-driven directives" pattern (lines 209-210). MOAK has no human in the loop by design.
10. **Code-availability and reproducibility.** Open source; people can read the YAML. MOAK is closed.

## 7. Lessons to consider for our workflow

Each tagged: **(a) cheap-and-clear win**, **(b) interesting-but-needs-design**, **(c) intentional-divergence-don't-copy**.

### (a) Cheap-and-clear wins

- **Add an explicit "anti-cheat" check in `harness_validate`.** MOAK's Judge specifically watches for the harness providing an unintended privileged path the exploit short-circuits through. Translation for us: when validating a Tier-2/Tier-3 harness, additionally verify the harness does *not* expose a weaker-than-intended entry point that would let `discover` succeed without exercising the hypothesized bug. This is a one-paragraph addition to `harness_validate`'s prompt and one new checklist item in `harness_design_review`. Concrete trigger to test: the discover agent returning `approved` after Tier-3 having reached the *target* function via a non-attacker-reachable wrapper.
- **Document and lint a "Collector-style" information firewall.** The discover prompt (line 615) already says "Do not attempt to find vulnerabilities by reading code alone — that is not your job." Add an explicit injunction that discover must not reach the network for prior PoCs/CVE writeups. Backstop it in policy by removing network egress from the discover persona's compiled policy. Cheap because the policy infrastructure already exists (`src/persona/`).
- **Add a "Contrarian" pass to discover.** When the orchestrator routes `discover` → `discover` after a `blocked` verdict, instruct the second invocation to act as a Contrarian: "assume your prior-round conclusion is wrong; find an alternative input that triggers the hypothesized bug." This is a prompt-level change, no new state.
- **Severity-fidelity rule for `harness_validate`'s `notes` field.** Mirror the conclude.md "Severity fidelity" rule (line 737) in the validate output: the validator must not editorialize about exploitability ("approved with caveats") — it already prohibits this implicitly (line 563), but the rule is worth promoting to the same status as severity-fidelity in conclude.

### (b) Interesting-but-needs-design

- **Patched-twin differential when in fix-validation mode.** Sometimes the user invokes `vuln-discovery` to *validate a fix*: "I just landed commit X to mitigate CVE-Y; was that fix sufficient?" In that mode, MOAK's pattern is exactly right — build harnesses against both pre-fix and post-fix trees, demand that discover succeed on pre-fix and fail on post-fix. We don't model this mode at all. It would be a new workflow setting (`mode: fix-validation`) plus tier-aware twin-environment construction. The lint catalog would need a new check that fix-validation runs include both refs.
- **MoA-style model rotation specifically for discover.** Discovery is the place where adversarial framing is most useful. A rotating-model variant of discover (alternating Opus / GPT / Gemini between rounds) would match MOAK's swarm pattern. Cost is real (we'd need provider plumbing for non-Anthropic models in agent sessions); benefit is unclear without measurement. Probably worth a small ablation before committing.
- **Per-CVE confidence score rendering for the daemon web UI.** MOAK's dashboard renders an "AI Exploitation Status" plus a Confidence Score per run. We have an investigation report; we don't have a single calibrated number. Producing one would require defining what "confidence" means structurally (was discover invoked? did harness_validate pass thresholds? did triage return approved? was an HITL gate hit?). The arithmetic is straightforward; the design question is whether single-number summaries help reviewers or mislead them.
- **Make the `notes` field of `agent_status` carry a structured artifact reference rather than free text.** MOAK's per-agent output is heavily structured (the dashboard tooltips imply per-agent JSON: research_summary, env_summary, exploitation_summary, agent_tree, captions). Our `notes` is prose. Adding optional structured fields per state (planned: yes/no, hypothesis: …, tier: …) could reduce orchestrator misrouting. Cost: orchestrator prompt changes plus YAML schema bump. Benefit: less reliance on free-form interpretation.

### (c) Intentional-divergence-don't-copy

- **No human in the loop, by design.** MOAK runs autonomously start to finish. Our workflow has three human gates plus a final report review. These are not deficiencies. MOAK's autonomy works because (1) its task is bounded — reproduce a known patched bug — and (2) the differential oracle is a deterministic ground-truth check. We are searching for unknown bugs in attacker-relevant code, with attacker-realism judgments that humans currently make better than LLMs. Removing our gates would invert the value proposition.
- **Single environment shape.** MOAK uses one Docker shape per CVE because the patch tells it where to point. If we collapsed our three tiers into one, we'd mostly be running expensive Tier-3 builds for hypotheses that fit in Tier-1, or Tier-1 unit tests for cross-component bugs that need Tier-2 minimum. Tiering is load-bearing for us.
- **Closed source for safety reasons.** MOAK's stated reason for not publishing is "to prevent misuse." Our project is research code intended for defenders investigating their own software; we publish. Whether MOAK's own posture is good policy is debatable (their own quote — "MOAK demonstrates that any threat actor can use publicly available AI models to weaponize critical vulnerabilities into exploits in minutes" — is the strongest argument *against* the security-through-obscurity defense), but it's their call.
- **CTF-flag-capture as the success oracle.** Beautifully clean for known-bug reproduction, structurally useless for unknown-bug discovery. We use sanitizer-fired-AND-attacker-controlled-impact-demonstrated, which is the right oracle for our problem.
- **A single CVSS-free Confidence Score.** Sufficient for "is this CVE realistically exploitable on day zero" (a yes/no business question for a CISO). Insufficient for a vulnerability report that has to feed a triage queue, an upstream vendor, and a customer remediation plan. Don't downgrade our triage discipline.

## 8. Open questions / things I couldn't determine

- **What policy/sandbox engine MOAK uses to mediate the agents' tool access**, if any. They run Docker containers ("controlled, isolated environments"); they don't say whether agents talk to those containers via a policy-mediated tool layer. We do (IronCurtain itself). This is the single most relevant comparison point that I cannot make from public sources.
- **Whether their guardrail against PoC databases is policy-enforced or prompt-asserted.** "Architectural guardrails" suggests policy, but they don't show how.
- **Cost per CVE.** CVE-Genie reports $2.77/CVE on a 841-CVE benchmark; MOAK doesn't disclose. Their LinkedIn comments call MOAK "dirt cheap" without numbers.
- **The full CVE list for the 178/174 batch.** They publish "Confidence Scores" per CVE on the dashboard but I did not enumerate the corpus. The dashboard's `/cve/{id}/public-detail` and `/cve/{id}/summary` endpoints likely expose this; I did not crawl them.
- **Whether they have any qualitative analysis of failure modes** (the four CVEs that didn't exploit out of 178). The CVE-Genie paper does this rigorously (build failures 36%, timeouts 40%, insufficient context 24% — `arxiv 2509.01835`). MOAK does not.
- **The `Confidence Score` formula.** Probably something like `f(judge_verdict, hitl_level, public_poc_match)`, but the SPA doesn't expose it.
- **Whether the research swarm size scales with vulnerability complexity** or is fixed. The text says "spawns a multi-model sub-agent swarm" without a number.
- **Whether the Researcher's primitive graph is the same data structure as the Judge's "structured judgement report"** or a different one. The site doesn't say; the dashboard's `agent_tree` field hints at the former.
- **Whether prompts are published anywhere for academic reviewers.** They offer "academic or research purposes" access on request. I did not pursue.
- **Whether the demo video at `youtube.com/watch?v=ccLukSFnFM8` shows additional architectural detail** beyond the website. WebFetch couldn't extract description content; I did not attempt to transcribe.
- **The relationship, if any, between MOAK and CVE-Genie.** They share enough architecture (multi-agent CVE reproduction, paired developer/critic, CTF flag verification, patched-twin differential) that they may be aware of each other; the timing on MOAK's launch lines up with the CVE-Genie preprint (September 2025). This may be coincidence (the architecture is convergent given the constraints) or a known prior-art relationship MOAK doesn't cite.

---

Sources (every external claim cites one):
- [moak.ai homepage and JS bundle](https://moak.ai/) — primary source for all MOAK architecture quotes
- [Resilient Cyber: "The Industrialization of Exploitation" by Chris Hughes](https://www.resilientcyber.io/p/the-industrialization-of-exploitation)
- [CyCognito: "Mythos, MOAK, CTEM and the End of CVE Chasing"](https://www.cycognito.com/blog/mythos-moak-ctem-and-the-end-of-cve-chasing/)
- [Yair Saban LinkedIn announcement post](https://www.linkedin.com/posts/yair-saban-30615870_anthropic-moak-glasswing-activity-7448067178278494209-XM3i)
- [MOAK demo video on YouTube](https://www.youtube.com/watch?v=ccLukSFnFM8)
- [Crunchbase company profile for MOAK](https://www.crunchbase.com/organization/moak)
- [Crunchbase profile for Yair Saban](https://www.crunchbase.com/person/yair-saban)
- [arxiv 2509.01835 — "From CVE Entries to Verifiable Exploits"](https://arxiv.org/html/2509.01835v1) (CVE-Genie, distinct from MOAK but architecturally similar)
- Local: `/home/provos/src/ironcurtain/.claude/worktrees/fix-quota-error-routing/src/workflow/workflows/vuln-discovery.yaml`
- Local: `/home/provos/src/ironcurtain/.claude/worktrees/fix-quota-error-routing/WORKFLOWS.md`
