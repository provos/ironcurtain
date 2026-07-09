# MITM stream-delay debug knob

A host-side debug affordance for reproducing and testing Claude Code's
streaming idle / stall behavior (issue #367, "Response stalled mid-stream")
**without needing a real slow model**. It injects a controllable idle gap into
the agent-facing forwarding stream at the MITM proxy, so the watchdog can be
exercised deterministically against any model.

## Why

Issue #367 manifests as `API Error: Response stalled mid-stream` when a model
response goes idle long enough for Claude Code to abort it. Reproducing that
faithfully otherwise requires a genuinely slow provider/model. This knob lets
us pause the response stream at the proxy for an arbitrary duration and observe
exactly which mechanism fires, on which provider path, and which env var (if
any) suppresses it.

## The knob (`src/docker/stream-delay.ts`, wired in `mitm-proxy.ts`)

Off by default; zero-cost when unset (no Transform installed). Enabled via host
environment variables read by the **host-side** MITM proxy:

| Env var                              | Meaning                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRONCURTAIN_MITM_STREAM_DELAY_MS`   | Idle gap to inject, in ms. Unset / `0` / non-numeric ⇒ disabled.                                                                                                                                              |
| `IRONCURTAIN_MITM_STREAM_DELAY_MODE` | `mid-stream` (default): forward the first chunk, then inject the gap before the next chunk — faithful to "Response stalled **mid-stream**". `first-token`: hold the first chunk (stall before any body byte). |
| `IRONCURTAIN_MITM_STREAM_DELAY_HOST` | Optional substring filter on the upstream host (e.g. `anthropic`, `openrouter`) so only one provider path is delayed.                                                                                         |

Applies only to LLM completion endpoints (`isLlmMessagesEndpoint`: `/v1/messages`,
`/api/v1/messages`, …). It sits at the tail of the forwarding pipe, so the
trajectory-capture fan-out branch is unaffected and captured traces stay
byte-faithful. A loud `NOT FOR PRODUCTION` warning is logged when active.

## Companion: watchdog env passthrough (`adapters/claude-code.ts`)

To exercise the watchdog knobs without rebuilding the container image, the
Claude Code adapter forwards a curated allowlist of streaming-watchdog tuning
vars from the host env into the container when set (no-op otherwise):

`CLAUDE_STREAM_IDLE_TIMEOUT_MS`, `CLAUDE_ENABLE_STREAM_WATCHDOG`,
`CLAUDE_ENABLE_BYTE_WATCHDOG`, `API_FORCE_IDLE_TIMEOUT`.

## How to run an experiment

```bash
# Baseline: inject a 320s idle gap into the native Anthropic response stream.
IRONCURTAIN_MITM_STREAM_DELAY_MS=320000 \
IRONCURTAIN_MITM_STREAM_DELAY_MODE=mid-stream \
IRONCURTAIN_MITM_STREAM_DELAY_HOST=anthropic \
tsx src/cli.ts start --agent claude-code -m anthropic:claude-haiku-4-5 \
  "Count from 1 to 40, one number per line, and output nothing else."

# Same, but disabling a specific watchdog (forwarded into the container):
CLAUDE_ENABLE_BYTE_WATCHDOG=0 IRONCURTAIN_MITM_STREAM_DELAY_MS=320000 ... tsx src/cli.ts start ...
```

**Observing the outcome.** The `claude -p` verdict (including
`Response stalled mid-stream`) is emitted inside the container on process exit,
so it only appears in the session log once the turn ends. The host-side signal
available in real time is the **retry cadence**: when the watchdog aborts a
stalled request it re-issues a new completion POST, visible in the MITM log
(`POST …/v1/messages … → FORWARDED`). The interval between those POSTs is the
active abort threshold.

## Findings (Claude Code 2.1.201)

Measured by injecting a 320 s mid-stream gap and reading the retry cadence.
When a mechanism aborts the held request it re-issues the completion POST; the
inter-POST interval is that mechanism's threshold.

**Native Anthropic path**

| Config                            | Abort / retry cadence          |
| --------------------------------- | ------------------------------ |
| baseline (defaults)               | **~180 s**                     |
| `CLAUDE_ENABLE_STREAM_WATCHDOG=0` | **~180 s** (identical)         |
| `CLAUDE_ENABLE_BYTE_WATCHDOG=0`   | **~300 s** (threshold shifted) |

The first client-side abort is the **byte watchdog** (`CLAUDE_ENABLE_BYTE_WATCHDOG`,
~180 s of stream idle → abort + retry). Turn it off and the fallback is a hard
**~300 s client-side request timeout** inside Claude Code (the agent opens a new
connection and re-POSTs at 300 s, with no MITM- or upstream-side error).

**OpenRouter path** (`openrouter.ai`, byte watchdog off by default there)

| Config                            | Cadence    |
| --------------------------------- | ---------- |
| baseline                          | **~300 s** |
| `CLAUDE_ENABLE_STREAM_WATCHDOG=0` | **~300 s** |
| `API_FORCE_IDLE_TIMEOUT=0`        | **~300 s** |

The ~300 s hard client request timeout governs; none of the idle-watchdog knobs
move it.

**The ~300 s ceiling is a hard client-side request timeout.** It persisted with
the byte watchdog off, `API_FORCE_IDLE_TIMEOUT=0`, `API_TIMEOUT_MS=900000`, and
even with the MITM's own inner-server `requestTimeout`/`headersTimeout`/`timeout`
disabled — the agent simply reconnects and retries at 300 s. So it is neither
the stream watchdog, nor `API_TIMEOUT_MS`, nor a MITM/upstream timeout, and it
caps this harness's usable injected-gap at ~300 s.

## Bearing on PR #376 (`CLAUDE_ENABLE_STREAM_WATCHDOG=0`)

**The env var has no measurable effect on the stall/abort behavior on either
provider path in 2.1.201.** The stream idle watchdog it disables is dominated by
(a) the byte watchdog (~180 s, native) and (b) the hard ~300 s client request
timeout (both paths), each of which fires first. The only knob that changed
anything was `CLAUDE_ENABLE_BYTE_WATCHDOG`.

Caveat: the observed aborts are **abort-and-retry**, not fatal — a genuinely
slow-but-progressing model resets the idle timer on each byte and never exhausts
retries. The terminal "Response stalled mid-stream" only appears once retries
are exhausted, which needs a _permanent_ stall (as injected here). This matches
the conclusion of #372/#367: the fatal `analyze` stall was the background-subagent
issue (fixed by `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`), not the stream watchdog.
