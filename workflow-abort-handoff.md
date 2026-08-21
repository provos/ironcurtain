# Workflow abort handoff: the `agent_status` chokepoint

**Status:** mitigation implemented locally; upstream dropped-tool-call trigger remains unresolved.
**Date:** 2026-08-21
**Affected run:** `a822c784-0640-4574-a901-0863e9dc73be` (vuln-discovery, libssh)
**Not to be confused with:** the vLLM token-soup degeneration (separate, and now largely fixed) or the trajectory-capture poisoning (separate, fixed in PR #437).

---

## TL;DR

Every abort this workflow has ever had — **8 of 8** — has the same proximate cause:

```
"Agent failed to provide agent_status block after retry"
```

It is **not** a model-quality problem, **not** a timeout, and **not** upstream degeneration. The
model's turn gets truncated at the API layer — the tool call goes missing from an otherwise
healthy response — and the harness interprets that truncated turn as a _completed_ one. Because
the truncated text contains no `agent_status` block, the state cannot commit its transition.

On 2026-08-21 the workflow aborted after **67 minutes of work** that had already produced real
artifacts on disk. Those files and the prior checkpoint survived; what was lost was artifact
registration, the state transition, and seamless continuation from that work.

---

## The issue

### What the user sees

`harness_build` runs for an hour, the agent exits cleanly (`exit=0`), and the workflow aborts with
a generic `"Workflow reached aborted state"`. `checkpoint.json` records `phase: aborted` with no
useful reason.

### What actually happens

**1. The model's response loses its tool call.**

On this stack (vLLM + DeepSeek-V4-Flash → LiteLLM → Anthropic `/v1/messages` → Claude Code), a
normal agent turn comes back from vLLM as **two OpenAI choices**, which LiteLLM merges into one
Anthropic message:

| choice | content                                  | becomes          |
| ------ | ---------------------------------------- | ---------------- |
| `[0]`  | `finish_reason=stop`, the narration text | `text` block     |
| `[1]`  | `finish_reason=tool_calls`, the call     | `tool_use` block |

Result: `stop_reason: tool_use`, blocks `[thinking, text, tool_use]`. This is what ~every turn in
a healthy run looks like.

On the failing turns, **only choice `[0]` came back.** From litellm's `LiteLLM_SpendLogs`
(2026-08-21):

```
14:38:40  out=306  | finish=stop content=475  tools=0 | finish=tool_calls content=0 tools=1
14:38:48  out=472  | finish=stop content=1506 tools=0                    <-- no second choice
...
14:42:55  out=1015 | finish=stop content=2293 tools=0 | finish=tool_calls content=0 tools=1
14:43:41  out=364  | finish=stop content=1367 tools=0                    <-- no second choice
```

`content=1506` / `content=1367` match the two recorded final messages byte-for-byte.

**2. A truncated turn is indistinguishable from a finished one.**

With no `tool_use` block, LiteLLM emits `stop_reason: end_turn`. Claude Code reads `end_turn` as
"turn complete", stops the agentic loop, and exits `0` with the narration as its final answer.

The text is obviously incomplete to a human — both failures end mid-investigation on a dangling
colon:

> _"...Both call `__sanitizer_cov_8bit_counters_init`. If cov_rt.o's function is linked, it should
> be called. Let me test cov_dump's actual runtime behavior by adding stderr output to cov_rt.c:"_

> _"...But the `__sancov_pcs` section EXISTS (it has data). Let me check for the start/stop symbols
> and read the pc table directly:"_

The model was one tool call from a result. It did not decide it was done.

**3. The retry corrects the wrong thing.**

`src/workflow/orchestrator.ts:2547-2568` — on a missing status block the orchestrator sends
`buildStatusBlockReprompt(...)`, whose text is:

> _"Your final response did not include the required agent_status block. ... If your work is
> finished: stop calling tools and emit a single final message ending with the YAML block below."_

That instructs a **mid-work** agent to wrap up. It assumes the only reason a block is missing is
forgetfulness. Here the agent wasn't finished, so the reprompt is a category error — it responded
with more mid-work narration and stalled identically 4.9 minutes later.

**4. One retry, then the workflow cannot continue.**

After the single retry fails, the orchestrator throws before registering the state's output or
committing its transition. Files already written to disk and the prior checkpoint survive, but the
workflow cannot consume that work or resume seamlessly from the interrupted conversation.

### Evidence that the work was real

At abort time `/workspace/.workflow/harness_build/` contained:

- `harness_sftp_srv.c` — 22,676 bytes
- `seed_corpus/` — **46 files**, purpose-named for the H2 residue-confusion target
  (`residue_stat`, `residue_ext`, `fsetstat`, `readdir`, `symlink`, `rename`, `close`, ...)

That is substantially the deliverable the state was asked for. It remained on disk but was never
registered or handed to the next state because of a missing YAML block.

---

## Scope

```
8 error records, 8 identical:  "Agent failed to provide agent_status block after retry"
11 agent_retry records, all:   reason = missing_status_block
```

| Date             | State                 |
| ---------------- | --------------------- |
| 2026-08-18 01:13 | analyze               |
| 2026-08-18 02:43 | harness_design        |
| 2026-08-18 04:58 | harness_design_review |
| 2026-08-18 05:21 | harness_build         |
| 2026-08-18 09:08 | harness_build         |
| 2026-08-18 17:33 | harness_build         |
| 2026-08-19 23:16 | harness_build         |
| 2026-08-21 14:43 | harness_build         |

`harness_build` has produced `verdict=None` on **every one of its six attempts**. States that
succeeded (`analyze`, `harness_design`, `orchestrator`) show real verdicts — so the mechanism is
not universal; it correlates with long, tool-heavy states.

---

## What this is NOT

Worth stating plainly, because two days went into the wrong suspect.

- **Not degeneration.** The 2026-08-21 run had **253 requests, 26 long generations, zero
  degenerations** after the three vLLM capture-time-layout backports (#52492, #52836, #51318). It
  aborted anyway, at the same chokepoint.
- **Not a timeout.** `exit=0`, 67.6 min against a 3-hour cap.
- **Not the byte watchdog.** Disabled since PR #431; no `api_error`.

Degeneration was previously _one route_ to an unparseable final message (the 2026-08-19 abort
followed a 49,006-token soup response). The dropped tool call is another route. The **single point
of failure is that a missing `agent_status` block prevents the state from committing and handing
off its surviving artifacts.**

---

## Proposed fixes

Ranked by value-to-effort. (1) and (2) are independent and both cheap; (3) is the durable fix.

### 1. Detect an incomplete turn instead of accepting it as final

**Problem:** `end_turn` is ambiguous on this stack — it means both "genuinely done" and "the tool
call went missing".

**Fix:** treat a final response as incomplete when it has no `tool_use` block, no `agent_status`
block, and terminates mid-sentence (trailing `:`, or no terminal punctuation). On that signal,
send a **continuation** (`"continue"`) rather than the status-block reprompt.

**Why it should work:** the model demonstrably wanted to continue — it had named its next action.

**Where:** detection near `src/workflow/status-parser.ts`; branch at
`src/workflow/orchestrator.ts:2547`.

**Caveat:** heuristic. A genuinely-finished turn that happens to end in a colon would get one
spurious `continue`, which is cheap and self-correcting.

### 2. Make the reprompt situation-aware

**Problem:** one reprompt text is used for every cause, and it says "if your work is finished, wrap
up".

**Fix:** two variants — _"your block is missing, here is the format"_ for a plausibly-complete
turn, and _"your turn appears truncated; continue your work"_ for an incomplete one. Also consider
issuing the retry as a **fresh, minimal turn** (work summary + block request) rather than appending
to an exhausted context; format compliance is much likelier in a short clean context.

**Where:** `buildStatusBlockReprompt`, `src/workflow/status-parser.ts:258-264`.

### 3. Artifact-based fallback verdict

**Problem:** a missing block prevents handoff from a state that has already produced its deliverable.

**Fix:** when an agent exits `0` with coherent work and no parseable block, consult the state's
output directory before aborting. If the expected artifacts exist, either synthesize a verdict or
route to a human/orchestrator gate — do not strand 67 minutes and $N of work outside the workflow.

**Why:** this is the difference between "lost the verdict" and "lost the workflow handoff". It
also degrades gracefully for _any_ future cause of an unparseable final message, including ones
not yet seen.

**Where:** the `parseResult.kind !== 'ok'` branch, `src/workflow/orchestrator.ts:2561-2567`.

### 4. Propagate turn-completion signals to the orchestrator

**Problem:** `AgentResponse` (`src/docker/agent-adapter.ts:28`) exposes only `text`, `costUsd`,
`hardFailure`. The Claude Code result envelope carries `stop_reason`, `num_turns`, and
`duration_api_ms`, and the adapter already inspects them — but the orchestrator never sees them, so
it cannot tell a completed turn from a truncated one without resorting to the text heuristic in (1).

**Fix:** surface `stopReason` / `numTurns` on `AgentResponse` and let the orchestrator branch on
the real signal instead of guessing from prose.

**Why this is the right long-term shape:** it turns (1) from a heuristic into a fact check.

### 5. Improve the abort record

`checkpoint.json` records `"reason": "Workflow reached aborted state"`, while the actual error lives
only in `messages.jsonl`. `finalStatus.reason` should carry the specific error. Minor, but it cost
real time during this investigation.

---

## Open question

**Why does the tool-call choice go missing?** Unresolved. It is not degeneration (output is
coherent). Candidates, unranked and untested:

- vLLM's `deepseek_v4` tool-call parser intermittently failing to emit the tool-call choice
- the model closing `</think>` and emitting narration without a call
- a LiteLLM translation edge case when only one choice is returned

Worth investigating on the DGX side, since fixing it upstream removes the trigger entirely. But
**the harness should be robust to it regardless** — a truncated upstream turn should never cost an
hour of completed work.

---

## Reproducing / verifying

```bash
# every abort reason for a run
python3 -c "
import json,collections
rows=[json.loads(l) for l in open('~/.ironcurtain/workflow-runs/<id>/messages.jsonl')]
print(collections.Counter(r['error'] for r in rows if r.get('type')=='error'))"

# the API-level shape of the failing turns (choices + finish reasons)
docker exec litellm-pg psql -U postgres -d litellm -c "
COPY (SELECT \"startTime\", completion_tokens, response::text FROM \"LiteLLM_SpendLogs\"
      WHERE \"startTime\" BETWEEN '<t0>' AND '<t1>' ORDER BY \"startTime\")
TO STDOUT WITH (FORMAT csv, HEADER true);" > turns.csv
# parse as CSV, not TSV — responses contain tabs and newlines
```

Note `LiteLLM_SpendLogs.response` stores **visible content only** and drops the reasoning block; a
~0.04 chars/token ratio is normal, not truncation. `messages` is `{}` (message logging off), so
prompts are only in the trajectory captures.

---

## Longer-term direction

Replace final-response YAML with a coordinator-owned `workflow_commit(verdict, notes, handoff)`
tool tied to the invocation ID. A missing tool call then means the state has not committed yet, so
the orchestrator can continue or replace the executor without parsing prose or synthesizing a
routing verdict.

The current engine-level mitigation applies to any agent state with any `when:` condition; it does
not depend on a state being named `orchestrator`. It first continues status recovery in the same
conversation, then gives a fresh executor one full-prompt replacement attempt. If recovery is
exhausted, an existing direct human-gate error edge pauses for review; without such a gate, the
engine keeps a resumable failed checkpoint and does not invent a routing branch. The
artifact-backed synthetic handoff remains restricted to the explicitly configured
`harness_build -> harness_validate` producer/validator edge.

A universal paused phase or synthetic recovery gate remains a longer-term option, not part of this
targeted mitigation.
