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

| Env var                              | Meaning                                                                                                                                                                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRONCURTAIN_MITM_STREAM_DELAY_MS`   | Gap to inject (stall modes) or inter-emit interval (drip mode), in ms. Unset / `0` / non-numeric ⇒ disabled.                                                                                                                                                                           |
| `IRONCURTAIN_MITM_STREAM_DELAY_MODE` | `mid-stream` (default): forward the first chunk, then inject one gap before the next — faithful to a _complete_ stall ("Response stalled **mid-stream**"). `first-token`: hold the first chunk. `drip`: re-pace the whole response to a trickle — a _very slow but not stalled_ model. |
| `IRONCURTAIN_MITM_STREAM_DELAY_HOST` | Optional substring filter on the upstream host (e.g. `anthropic`, `openrouter`) so only one provider path is delayed.                                                                                                                                                                  |
| `IRONCURTAIN_MITM_STREAM_DRIP_BYTES` | `drip` mode only: bytes emitted per `…_DELAY_MS` tick (default `1`). Higher = faster trickle.                                                                                                                                                                                          |

`stall` modes (`mid-stream`/`first-token`) exercise the **byte watchdog**
(raw-byte idle, ~180 s); `drip` keeps raw bytes flowing so the byte watchdog
stays quiet and exposes the **stream watchdog** (decoded-SSE-event idle,
~300 s) — the mechanism that bites very slow models. See Findings below.

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

## Findings (Claude Code 2.1.201, native Anthropic)

Two independent client-side idle watchdogs guard a completion stream. Each
**aborts and retries** the request when its threshold is crossed; whichever
fires first wins. Neither is a total-duration cap — disable the governing one
and a slow request runs indefinitely (verified below). Method: inject a
delay/drip and read the retry cadence in the MITM log (a re-issued completion
POST == an abort); the inter-POST interval is that mechanism's threshold.

| Watchdog                                              | Measures                                  | Threshold |
| ----------------------------------------------------- | ----------------------------------------- | --------- |
| **byte watchdog** (`CLAUDE_ENABLE_BYTE_WATCHDOG`)     | idle on the **raw byte** stream           | ~180 s    |
| **stream watchdog** (`CLAUDE_ENABLE_STREAM_WATCHDOG`) | idle on **decoded SSE events** (progress) | ~300 s    |

| Scenario (injected)              | baseline        | `STREAM_WATCHDOG=0`   | `BYTE_WATCHDOG=0` |
| -------------------------------- | --------------- | --------------------- | ----------------- |
| complete stall (no bytes at all) | ~180 s (byte)   | ~180 s (unchanged)    | ~300 s (stream)   |
| slow trickle (`drip`, 1 B / 2 s) | ~300 s (stream) | **no abort** (>400 s) | —                 |

The **stall** case is dominated by the byte watchdog at ~180 s, so
`STREAM_WATCHDOG=0` looks inert there (the byte watchdog still fires). The
**drip** case keeps the byte watchdog happy (raw bytes every 2 s) but the agent
decodes no SSE events, so the **stream watchdog** fires at ~300 s — and
`CLAUDE_ENABLE_STREAM_WATCHDOG=0` disables it: the request then streams past
300 s with no abort. `API_TIMEOUT_MS=900000` moves neither threshold (so the
~300 s is the stream watchdog, not a request-duration timeout).

> OpenRouter (`openrouter.ai`) was only tested with a raw stall, where a ~300 s
> abort fired that neither `STREAM_WATCHDOG=0` nor `API_FORCE_IDLE_TIMEOUT=0`
> moved — the non-Anthropic path likely uses a different mechanism and needs a
> `drip` re-test before drawing conclusions.

## Bearing on PR #376 (`CLAUDE_ENABLE_STREAM_WATCHDOG=0`) — effective for slow models

PR #376 disables the **stream (event-idle) watchdog**: the one that fires ~300 s
after the last _decoded_ SSE event and emits "Response stalled mid-stream"
(matching #367's `duration_ms: 305993`). That is exactly the "very slow model"
failure — a model that goes >300 s without producing a decodable event (slow
first token, a long mid-response thinking pause) trips it even while the
connection is alive and bytes trickle. **The env var prevents that abort**
(verified: a 1 B/2 s drip that baseline aborts at ~300 s runs indefinitely with
it set). It does **not** help a raw-connection stall (byte watchdog, ~180 s),
but that is a genuinely dead stream, not a slow model.

Relationship to #372: both are valid fixes for the same "Response stalled
mid-stream" symptom from different angles. #372 removes a _cause_ of the event
idle (a parent turn waiting on background subagents produces no events);
#376 removes the _abort_ on event idle. A genuinely slow model produces sparse
events for reasons unrelated to subagents, so #372 doesn't cover it and #376
does — which is why the follow-up was needed.
