# Anvil PRD vs Real Trajectory Capture (analyzed 2026-05-29)

## What Anvil is
- Planned OFFLINE tool (out-of-repo). Flattens multi-state FSM harness runs into single
  autonomous SFT trajectories for GLM-5.1 fine-tune. PRD: `docs/brainstorm/anvil-prd.md`.
- Central thesis: "FSM-aware, trace-complete, read-don't-infer" — provenance is a
  DETERMINISTIC JOIN over captured API traces + FSM YAML, no statistical inference.

## The real capture format (source of truth)
- `src/docker/trajectory-types.ts` `ExchangeRecord` = ONE `/v1/messages` HTTP exchange.
  NOT a per-state record. Fields: request.bodyUtf8 (full system+tools+messages+thinking
  config) + response.bodyUtf8 (reassembled assistant msg w/ thinking+signature). No
  `context_in`/`model_output`/`observations`/`artifacts_out`. No `artifact_id` anywhere.
- Manifest: session-start/session-end pairs w/ persona + fsmState + `poisoned` binary flag.
  One session == one FSM state == one `{sessionId}.jsonl`. Workflow = N session files + 1 manifest.

## Load-bearing reconciliation findings (verified against a real run)
1. **No artifact IDs → cross-state lineage is NOT a deterministic join.** Cross-state flow =
   free-text orchestrator directive (`previousAgentOutput` injected into next prompt by
   `prompt-builder.ts buildScopingSection`) + shared `.workflow/<name>/` files the agent
   reads/writes with its OWN Read/Write tools. Same bytes appear as model-derived `Write`
   tool_use.input in producer session, then as a `tool_result` (observation) for a `Read`
   in consumer session — with NO id linking them. Join key is the file PATH string +
   content match = inference, not a join. This holes the §13.1 "no inference" claim.
2. **Thinking is response-side only** (TRAJECTORIES.md "#1 trap", verified): every echoed
   request history had thinking=0; prior responses had thinking+signature (sig lens
   992/1456/644/1344/3428). Pass 3's "genuine reasoning reused where it stands" only works
   per-turn from each response.bodyUtf8 — there is no cross-turn thinking to reuse.
3. **N exchanges per state, not one.** Real run: fetch=10, summarize=4. PRD §5 "one record
   per state invocation" is wrong by ~10x.
4. **Housekeeping exchanges pollute the corpus.** Exchange[0] of each session = Claude Code
   title-gen call (`tools:[]`, returns `{"title":...}`). Pass 0 must filter non-task calls.
5. **Workflow YAML uses `inputs:`/`outputs:` (named dir tags), NOT `consumes`/`produces`.**
   outputs = directory names under `.workflow/`; orchestrator only checks `hasAnyFiles(dir)`
   — no file→file lineage. vuln-discovery = 17-state hub-and-spoke, orchestrator routes via
   DYNAMIC free-text directives (not static per-state prompts as §4 assumes).
6. **Binary session-poison model** (`poisoned` on session-end) — Anvil Pass 0 must filter
   poisoned sessions + manifest.poisoned dirs. Not mentioned in PRD.

## Real run probed
- `~/.ironcurtain/workflow-runs/164bba2c-.../containers/835b7c0a-.../captures/`
- It's `test-email-summary` (toy 2-state fetch→summarize). NO exploitation content, NO
  recovery/backtrack, NO oracle (ASAN/crash). PRD's hardest claims (§7a recovery typing,
  oracle provenance, Pass 1 instructive-dead-end) are UNVALIDATED by real data → need a
  captured vuln-discovery run before de-risking.
