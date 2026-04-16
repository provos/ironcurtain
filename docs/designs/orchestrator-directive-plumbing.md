# Orchestrator Directive Plumbing

## Overview

The orchestrator in the `vuln-discovery` workflow writes detailed directives intended to scope the next agent's work — what target to examine, which hypothesis to test, what tier to build at, and WHY. In principle the directive is the orchestrator's primary output: the journal captures history, the directive steers the next step.

In practice, **the directive does not reach the next agent's prompt**. Only the short `agent_status.notes` string (~400 chars) survives the state transition. The `## Directive` section (which runs 1,500–4,000 chars with hypothesis framing, scope, rationale) is dropped. Downstream agents — which do receive the workflow's declared `inputs` (e.g., `analysis`, `journal`, `harness_design`) — improvise the current round's focus from those artifacts plus whatever the journal's last round said.

This document records the investigation that surfaced this defect and outlines the fix.

## Symptom observed

Workflow run `70ae50d4-dd4d-4c16-af31-7e2e7a2483d6` was hunting a specific H.264 decoder vulnerability: `slice_num == 0xFFFF` collides with a `memset(-1)` sentinel in `uint16_t slice_table[]`, confusing the deblocking filter when a real macroblock's `slice_table` entry equals the "unprocessed" sentinel.

The investigation:
- **Correctly identified the hypothesis** in the `analyze` phase (Hotspot #1)
- **Correctly specified the sweep** in the `harness_design` phase — `nslices ∈ {32, 65535, 65536}` with P-slice coverage
- **Incorporated human FORCE_REVISION feedback** steering back to Hotspot #1 after a dead-end
- **Never ran the combination `nslices=65535` × P-slices a single time** across 8 rounds and 152+ config invocations

Round 5 `discover` ran 5 configs, all with `nslices=1`. Round 7 `discover` ran a 147-config stress matrix, all with `--nslices 1`. The orchestrator's directives across those rounds did ask for the boundary sweep; the discover agent never saw them.

## Root cause

In the workflow YAML, downstream states declare their inputs explicitly:

```yaml
harness_design:
  inputs:
    - analysis
    - journal
discover:
  inputs:
    - analysis
    - harness_build
    - journal
```

These inputs are files on disk that the workflow engine makes available to the agent. The orchestrator's output is **not** a file — it's the agent's response text, split into:
- A free-form body containing the `## Directive for next agent` section
- An `agent_status:` YAML block with `verdict` and `notes` fields

When the orchestrator transitions to the next state, the workflow engine composes the next agent's prompt. It includes:
- The state's role prompt
- The declared inputs (analysis, journal, etc.)
- A short "Previous Agent Output" context — which is the `notes` field from the orchestrator's `agent_status`, ~400 characters

The full `## Directive` section — the hypothesis framing, the tier rationale, the component scope, the WHY — is thrown away.

Scanning `messages.jsonl` for `agent_sent` prompts targeting the `discover` state in Rounds 4, 5, 7: the string `slice_num` appears **zero times** across those prompts despite being the entire subject of the investigation at those rounds. The orchestrator's directives at those rounds contained it; the prompts the discover agent actually received did not.

## Evidence

| Round | State dispatched | Orchestrator directive length | Directive visible in next agent's prompt? |
|-------|------------------|-------------------------------|--------------------------------------------|
| 1 | analyze | 5 lines (cold start) | Yes (initial composition) |
| 2 | harness_design v1 | 3,441 chars | Yes (first routing in session) |
| 3 | discover | 2,800 chars | Yes |
| 4 | harness_design v2 | 1,900 chars | **No** |
| 4 | discover | 2,100 chars | **No** — "slice_num" string absent |
| 5 | discover | 2,400 chars | **No** — "slice_num" string absent |
| 6 | harness_design v4 | 3,100 chars | **No** |
| 7 | discover | 2,700 chars | **No** (though tool-call reads recovered some) |

The orchestrator wrote directives averaging ~2,500 characters per round. The downstream agents received `notes:` strings averaging ~400 characters. The signal-to-noise ratio at the state boundary is roughly 1:6 — 83% of the orchestrator's scoping work is silently discarded.

## Secondary effects the plumbing bug produced

1. **Discover improvises from the journal.** In Round 5, lacking any visible directive, discover re-derived "what should I test" from the journal's Round 4 summary, which emphasized Hotspot #2's reorder chain. It ran single-slice configs relevant to Hotspot #2, not the 65535-slice sweep the design called for.

2. **Hypothesis silently closes on pivot.** In Round 6, `harness_design` v4 pivoted focus to Hotspots #6/#7. Because Round 5 discover had reported "blocked" on #1/#4 (without actually testing them with the new emitter), the orchestrator treated the hypothesis as closed. The orchestrator's Round 6 directive did say "Hotspot #1/#4 still open, rerun with new harness" — but that directive never reached the discover agent either.

3. **Orchestrator directive quality degrades over time.** After observing (consciously or not) that its detailed directives don't seem to change downstream behavior, the orchestrator's outputs #6/#7/#8 became bare `agent_status` blocks with no structured `## Directive` section. The feedback loop is broken: the orchestrator invests effort in directives, those directives are discarded, the orchestrator learns to invest less.

4. **FORCE_REVISION feedback decays.** The human's FORCE_REVISION at round 3.5 correctly landed in the v3 harness_design prompt. But by round 6, when the harness was redesigned, that feedback was 9+ hours stale and not re-instilled.

## The fix: thread the directive through state transitions

The workflow engine needs to forward the orchestrator's `## Directive` section (or the full message body) to the next agent's prompt, not just the `notes` string. Possible shapes:

### Option A: Parse `## Directive` section from orchestrator output

Extract the text between `## Directive for next agent` and the next `##` heading (or `agent_status:`) and pass it as the `previousAgentOutput` context for the next agent. Requires a structural convention in the orchestrator's output format, which is already in the prompt template.

**Pros:** Minimal change. The orchestrator already writes this section. Downstream prompts can reference it as "Directive from the orchestrator" rather than "notes."

**Cons:** Parsing is regex-fragile. If the orchestrator shifts the heading to `## Directive` or `## Next Agent Directive`, the extraction breaks silently.

### Option B: Full body (minus the status block) as previousAgentOutput

When composing the next agent's prompt, use the orchestrator's entire response text with the `agent_status:` YAML block stripped. This preserves the directive plus any context the orchestrator chose to include (journal summary, assessment, reasoning).

**Pros:** No structural convention required. Whatever the orchestrator writes flows through. Aligns with the "orchestrator is the router" philosophy — the router's output steers the next step.

**Cons:** Larger prompts downstream. Requires downstream prompts to tolerate longer context. The orchestrator's assessment/journal-update text might be redundant with the journal file itself.

### Option C: Structured directive as a workflow artifact

Treat the orchestrator's directive as a declared output: the orchestrator writes `.workflow/orchestrator/directive.md` each round. Downstream states declare `orchestrator_directive` as an input and read the file like any other artifact.

**Pros:** Visible in the artifact tree; versionable via the existing artifact versioning; explicit in the YAML.

**Cons:** More invasive. Requires changes to every downstream state's `inputs` declaration. Changes the orchestrator prompt to tell it to write a file. Stronger mechanism than needed for a prompt-context concern.

## Recommendation

**Option B** (full body minus status block) is the minimum-change fix that most reliably captures the orchestrator's scoping. It treats the orchestrator's output the same way other agent outputs are implicitly the context for the next agent, rather than collapsing it into the `notes` field's 400-character window.

Downstream agent prompts should be lightly updated to reference "Context from the orchestrator" (or similar) rather than "notes from the prior agent," so the agent understands this text is authoritative scoping, not a summary.

## What this does not fix

Several related issues remain even after the plumbing is corrected:

1. **Orchestrator directive degradation.** When the orchestrator writes a bare `agent_status` block with no directive, there's nothing useful to forward. Separate fix needed: the orchestrator prompt should structurally require a directive section, and the engine could validate its presence.

2. **Stale hypothesis tracking.** When a harness is redesigned and the hypothesis space shifts, there's no explicit tracker of "this hypothesis needs a new harness capability, keep it open." Separate fix: a hypothesis ledger in the journal, updated mechanically.

3. **Discover's "just trust the directive" prompt.** The discover prompt says "The orchestrator's directive tells you what to test" without a fallback. When the directive is weak or missing (even post-plumbing-fix), discover has no rule like "exhaust the design's sweep matrix before improvising." Separate fix: harden the discover prompt.

## Investigation artifacts

- Workflow run: `~/.ironcurtain/workflow-runs/70ae50d4-dd4d-4c16-af31-7e2e7a2483d6/`
- Artifacts from the run: `/Users/provos/src/FFmpeg/.workflow/`
- Related workflow YAML: `src/workflow/workflows/vuln-discovery.yaml`
- Related prompt-composition code: `src/workflow/prompt-builder.ts`, `src/workflow/orchestrator.ts` (`executeAgentState`)
