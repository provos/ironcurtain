# Token-Trajectory Capture

IronCurtain can capture a **verbatim, byte-faithful** log of every exchange between a
Docker-mode agent (Claude Code, Goose, ...) and its upstream LLM provider
(Anthropic, OpenAI, Google) at the MITM proxy. Each captured `/v1/messages`
exchange is recorded as one JSONL line carrying the request the agent emitted
(full system prompt, tool schemas, message history, sampling + thinking config)
and the reassembled response (text, `tool_use`, `thinking` blocks with their
signatures, `stop_reason`, `usage`) — a complete `(input → output)` pair suitable
as SFT/RL training data. Capture is off by default and has zero cost when
disabled.

This document covers the runtime capture stage — the raw trajectories this repo
produces. Curation (causal pruning, CoT synthesis, flag schemas, chat-template
export) is explicitly out of repo. See:

- Design: [`docs/designs/mitm-token-trajectory-capture.md`](docs/designs/mitm-token-trajectory-capture.md) — schema (§4), file layout (§7), credential boundary (§8), crash-safety (§9), config/CLI (§10), workflow tagging (§11), poison taxonomy (§9).
- Downstream pipeline: [`docs/brainstorm/golden-trace-pipeline.md`](docs/brainstorm/golden-trace-pipeline.md) — the SFT/RL plan that consumes these trajectories.
- Schema source of truth: [`src/docker/trajectory-types.ts`](src/docker/trajectory-types.ts).

Capture is **Docker Agent Mode only**. Code Mode (the built-in agent) has its own
SDK call site and is out of scope.

## Enabling capture

Default is `false`. Precedence is **CLI flag > config file > default**.

**Persistent config** (`~/.ironcurtain/config.json`), a single boolean:

```json
{
  "capture": { "enabled": true }
}
```

Surfaced in the interactive editor (`ironcurtain config`). When
`capture.enabled` is false the writer is never constructed — no taps, no
allocations.

**Per-invocation CLI flag** `--capture-traces` (long form only):

```sh
ironcurtain mux --capture-traces
ironcurtain start --capture-traces "your task"           # one-shot/scripted
ironcurtain start -w ./repo --capture-traces "your task" # one-shot workspace
ironcurtain workflow start <name> --capture-traces "your task"
ironcurtain daemon --capture-traces --web-ui              # sticky default for every session this daemon launches
```

There is no `--no-capture-traces`; capture is opt-in only.

**Daemon / programmatic** — the `sessions.create` JSON-RPC method accepts an
optional `captureTraces: boolean` (see `src/web-ui/dispatch/session-dispatch.ts`).
Per-session precedence at the daemon is **JSON-RPC field > daemon `--capture-traces`
> daemon config value**.

The single decision point in every entry path is:

```ts
const captureEnabled = captureTracesOverride ?? userConfig.capture?.enabled ?? false;
```

(see `src/session/index.ts`, `src/workflow/orchestrator.ts`, `src/workflow/workflow-command.ts`).

## Where files land

The natural unit is **one Claude session's exchanges** → one `{sessionId}.jsonl`
file, with a sibling `manifest.jsonl`. Workflows run one session per FSM state
sequentially, so a workflow bundle's captures directory holds several session
files plus one shared manifest. Standalone Docker runs are a single session.
Path helpers live in `src/config/paths.ts`.

**Standalone Docker** (`getSessionCapturesDir`):

```
~/.ironcurtain/sessions/{sessionId}/captures/
  {sessionId}.jsonl       # this session's exchanges
  manifest.jsonl          # one session-start + session-end pair
```

**Workflow shared-container** (`getBundleCapturesDir`) — sits beside `audit.jsonl`
at the bundle root:

```
~/.ironcurtain/workflow-runs/{workflowId}/containers/{bundleId}/captures/
  {sessionId}.jsonl       # one file per Claude session (one per FSM state)
  {sessionId}.jsonl
  manifest.jsonl          # append-only ordering record across all sessions
  manifest.poisoned       # zero-byte marker, present only on bundle-wide disk failure
```

The `manifest.jsonl` is the **canonical ordering source**: walk it in `seq`
order and stream the matching `{sessionId}.jsonl` files. Filesystem timestamps
and filename collation are not relied on.

## The record schema

One JSON object per line, UTF-8, `\n`-terminated. Types are in
`src/docker/trajectory-types.ts` (`ExchangeRecord`).

```ts
interface ExchangeRecord {
  schemaVersion: 1;
  exchangeId: string;            // sort-orderable
  sessionId: string;
  persona?: string;              // workflow persona at exchange start
  workflowRunId?: string;
  bundleId?: string;
  recordedAgentName?: string;    // 'claude-code' | 'goose' | ...

  provider: 'anthropic' | 'openai' | 'unknown';
  method: string;                // 'POST'
  host: string;                  // 'api.anthropic.com'
  path: string;                  // '/v1/messages?beta=true'
  requestStartedAt: number;      // epoch ms
  requestFinishedAt: number;
  responseFinishedAt: number;

  request: {
    headers: Record<string, string>;   // credential headers redacted (§8)
    bodyUtf8: string;                   // raw UTF-8 body when content-encoding identity
    bodyBase64?: string;                // present iff body is compressed / not valid UTF-8
    bodyBytes: number;
    contentEncoding?: string;           // captured verbatim, never decoded
  };

  response: {
    status: number;
    headers: Record<string, string>;    // redacted
    streaming: boolean;
    providerRequestId?: string;         // request-id / anthropic-request-id
    stopReason?: string;
    modelFingerprint?: string;          // OpenAI system_fingerprint
    usage?: Record<string, unknown>;    // verbatim from message_delta
    bodyUtf8: string;                   // non-streaming: raw body; streaming: REASSEMBLED message
    bodyBase64?: string;
    bodyBytes: number;
    streamRaw?: { events: { eventType: string; dataUtf8: string; offsetMs: number }[] };
  };

  capture: {
    reassemblyOk: boolean;              // false ⇒ record was NOT written; session poisoned
    reassemblyDiagnostic?: string;
    retried?: boolean;                  // true ⇒ response is from a 401 OAuth refresh-retry
  };
}
```

Exactly one of `bodyUtf8` / `bodyBase64` is populated per side. For a streaming
response, `bodyUtf8` is the reassembled message built so it is **byte-identical
to the equivalent non-streaming response** (raw substring concatenation, never
`JSON.parse → JSON.stringify`); the raw SSE event log is preserved separately in
`streamRaw`.

The `manifest.jsonl` entries (`ManifestEntry`) come in `session-start` /
`session-end` pairs:

```ts
type ManifestEntry =
  | { schemaVersion: 1; event: 'session-start'; seq; sessionId; persona?; fsmState?; ts }
  | { schemaVersion: 1; event: 'session-end';   seq; sessionId; persona?; fsmState?; ts;
      exchanges: number;        // record count, computed at write-time
      bytesWritten: number;
      poisoned: boolean;        // true ⇒ discard the whole session downstream
      poisonReason?: 'reassembly-failure' | 'disk-error' | 'queue-overflow'
                   | 'mid-stream-abort' | 'infrastructure-teardown'
                   | 'unsupported-encoding' | 'unknown';
      closedReason?: 'infrastructure-teardown';   // synthetic teardown end-marker
    };
```

A real workflow manifest (verbatim):

```jsonl
{"schemaVersion":1,"event":"session-start","seq":1,"sessionId":"86256733-...","ts":"2026-05-28T18:48:01.627Z"}
{"schemaVersion":1,"event":"session-end","seq":1,"sessionId":"86256733-...","ts":"2026-05-28T18:48:39.108Z","exchanges":14,"bytesWritten":2045659,"poisoned":false}
{"schemaVersion":1,"event":"session-start","seq":2,"sessionId":"1832cceb-...","ts":"2026-05-28T18:48:39.118Z"}
{"schemaVersion":1,"event":"session-end","seq":2,"sessionId":"1832cceb-...","ts":"2026-05-28T18:48:49.834Z","exchanges":4,"bytesWritten":454240,"poisoned":false}
```

> Note: in current single-global-policy workflow runs the manifest `fsmState`
> field may be absent on `session-start` even though the per-record `persona`
> is populated (e.g. `"persona":"global"`). The schema supports `fsmState` /
> `persona` on the manifest as the canonical FSM map; populate them via
> `beginCaptureSession({ sessionId, persona, fsmState })` for multi-state runs.

An abbreviated real `ExchangeRecord` (Anthropic streaming, bodies elided):

```json
{
  "schemaVersion": 1,
  "exchangeId": "d7871955-90f9-49b3-8bf1-0b6353259408",
  "sessionId": "1832cceb-8545-4304-8daa-b794af5fc179",
  "persona": "global",
  "workflowRunId": "e59cac79-3be3-485c-8609-c9fe28d23207",
  "bundleId": "f2b02fb6-1274-4902-bbe8-d1ab322f3c03",
  "recordedAgentName": "claude-code",
  "provider": "anthropic",
  "method": "POST",
  "host": "api.anthropic.com",
  "path": "/v1/messages?beta=true",
  "requestStartedAt": 1779994119327,
  "responseFinishedAt": 1779994120232,
  "request": {
    "headers": { "authorization": "<redacted>", "anthropic-version": "2023-06-01", "content-type": "application/json", "...": "..." },
    "bodyUtf8": "{\"model\":\"claude-...\",\"system\":[...],\"tools\":[...],\"messages\":[...],\"thinking\":{...},\"stream\":true}",
    "bodyBytes": 5532
  },
  "response": {
    "status": 200,
    "headers": { "content-type": "text/event-stream; charset=utf-8", "content-encoding": "gzip", "request-id": "req_011...", "set-cookie": "<redacted>", "...": "..." },
    "streaming": true,
    "providerRequestId": "msg_019ZEDikxjeSLoXYsoGoWTEk",
    "stopReason": "end_turn",
    "usage": { "input_tokens": 1328, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 17 },
    "bodyUtf8": "{\"id\":\"msg_019...\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"...\",\"signature\":\"...\"},{\"type\":\"text\",\"text\":\"...\"}],\"stop_reason\":\"end_turn\",\"usage\":{...}}",
    "bodyBytes": 579,
    "streamRaw": { "events": [ { "eventType": "message_start", "dataUtf8": "{...}", "offsetMs": 12 }, "..." ] }
  },
  "capture": { "reassemblyOk": true }
}
```

## What is captured vs not

Verified against real captured data. A single `/v1/messages` record is a
complete `(input → output)` SFT pair:

**Request side (`request.bodyUtf8`):**

- **Full system prompt** — Claude Code's 4-block `system` array (~32 KB total in
  a real capture, not elided by prompt caching).
- **All tool definitions** with full JSON schemas as the model received them on
  the wire (30 tools in a real capture). This sidesteps the SDK-rewriting bug
  class — the schema is captured exactly as sent, not reconstructed from a
  language-level signature.
- **Full `messages` history** including `tool_result` blocks.
- **Sampling params + `thinking` config** as they appear in the request body
  (e.g. `{"type":"enabled","budget_tokens":31999}`), not the agent's config —
  the wire bytes are ground truth.

**Response side (`response.bodyUtf8` + `streamRaw`):**

- `text`, `tool_use`, and **`thinking` blocks with non-empty `signature`** (a
  real capture carried a 1308-char signature). Block array order is preserved.
- `stop_reason`, `usage` (including `cache_creation_input_tokens` /
  `cache_read_input_tokens`), `providerRequestId`, model fingerprint.
- The raw SSE event log (`streamRaw.events`) with per-event monotonic offsets
  alongside the reassembled body.

**Handling:**

- **gzip / deflate / br are auto-decompressed** on the capture branch so
  `bodyUtf8` is what the SDK observed; the original `content-encoding` is kept as
  metadata. `zstd` is not supported by Node's `zlib` → such a session is poisoned
  (`unsupported-encoding`).
- **Credentials are redacted** at write time — `authorization`, `x-api-key`,
  `proxy-authorization`, `cookie`, `set-cookie` are replaced with `<redacted>`
  (see `redactHeaders` in `trajectory-types.ts`). Capture also reads the
  agent-facing request *before* the fake→real key swap, so a real provider key
  never reaches the snapshot regardless.

**Not captured:**

- **Only completion endpoints.** Capture is gated by a per-provider
  `captureEndpoints` allowlist on `ProviderConfig` (`isCapturableEndpoint`):
  Anthropic `/v1/messages`, OpenAI `/v1/chat/completions`, Google
  `*/generateContent` + `*/streamGenerateContent`. Claude Code housekeeping
  traffic on the same host — MCP-registry pagination, `event_logging/v2/batch`
  telemetry, `claude_code/{settings,policy_limits}`, `eval/sdk-*` — is
  deliberately excluded (~two-thirds of bytes, zero model content, and the
  telemetry batches would leak the agent's own action log back into the corpus).
  Allowlist, not deny-list: a new housekeeping path fails safe (silently not
  captured).
- Registry / passthrough / WebSocket traffic.
- The upstream-side request (which carries the real key) and any upstream-only
  metadata the agent never saw.
- The drained 401 response on an OAuth refresh-retry: the record is the
  successful retry's response, flagged `capture.retried: true`.

## Using the trajectories for SFT

Each captured record already contains the prompt and the completion. The
reconstruction per turn is:

- **Input** = `JSON.parse(request.bodyUtf8)` → `{ system, tools, messages, thinking, ... }`.
- **Output** = `JSON.parse(response.bodyUtf8)` → the assistant message
  (`content` blocks, `stop_reason`, `usage`).

### The #1 trap: thinking lives only on the response side

Claude Code **strips thinking blocks from the message history it echoes in
subsequent requests** — thinking is single-turn-scoped. Verified in a real
capture: a later request's echoed `messages` contained 2 assistant turns with
`tool_use` blocks but **0 thinking blocks**, while each turn's original
response record carried the full thinking block plus signature.

Consequence for any trajectory builder:

- **Reconstruct each turn's completion from that turn's own `response.bodyUtf8`**
  (source of truth — it has the thinking). Do **not** rebuild completions by
  concatenating the *next* request's echoed `messages`; that view is
  thinking-stripped and lossy.
- A naive request-side stitch trains on actions without reasoning. Always pair
  request N's prompt with response N's body.
- Preserve `thinking.signature` verbatim (Anthropic rejects unsigned thinking on
  resume) and `redacted_thinking` as opaque bytes. Keep content-block array
  order.

### Other rules

- **Don't parse-then-restringify** `tool_use.input` (Anthropic, object on wire)
  or `tool_calls[].function.arguments` (OpenAI, JSON-encoded string). The
  reassembler already preserves the exact wire bytes; re-serializing shifts
  token boundaries and breaks logprob/KL math for RL. Normalize only at read
  time downstream.
- **Multi-turn coherence**: keep `tool_use.id` ↔ `tool_result.tool_use_id`
  pairings intact; dangling tool-result references are the #1 silent corruption
  mode (Anthropic hard-rejects them).
- **Per-target chat-template serialization** (Anthropic / OpenAI / Hermes /
  Mistral) is a downstream stage — don't bake a chat template into anything that
  reads this corpus. See the golden-trace pipeline doc, "### 8. Export".

## The binary session model

There is no such thing as a partial-but-usable session. A session is either
**complete-and-usable** or **`poisoned: true`** on its `session-end` manifest
entry — discard the whole session, do not salvage it. A truncated SFT trace
(shifted token boundaries, dangling tool IDs, an assistant message cut
mid-content-block) is worse than no trace.

Poison sources (`PoisonReason`): SSE `reassembly-failure`, `disk-error`,
records-queue `queue-overflow` (the high-watermark tripwire poisons every open
session in the bundle rather than dropping individual records — see
`trajectory-capture.ts`, `HIGH_WATERMARK`), agent/upstream `mid-stream-abort`,
`unsupported-encoding` (zstd), and `infrastructure-teardown` (a synthetic
`session-end` emitted by `close()` for a session whose orchestrator `finally`
didn't run — e.g. SIGINT). On a poisoned record the in-progress exchange is
**not written**; the flag exists for diagnostics only.

Downstream filtering:

1. If `manifest.poisoned` exists at the captures-directory root, **discard the
   entire directory** — the manifest itself is untrustworthy.
2. Otherwise walk `manifest.jsonl` in `seq` order; for each `session-end` with
   `poisoned: true`, skip that session's `{sessionId}.jsonl`.
3. An orphan `session-start` with no matching `session-end` (crash mid-write) is
   implicitly poisoned — the `seq` walk skips it.
4. JSONL is append-only and crash-tolerant: a truncated trailing line should be
   skipped by a standard trailing-line-tolerant parser. The `exchanges` count on
   `session-end` equals the on-disk line count by construction (counters bump in
   the `appendFile` callback, not at enqueue).

## Relationship to the golden-trace pipeline

This repo owns exactly one stage: **raw verbatim capture**. Everything else —
JSONL → Parquet reassembly, prefix dedup, causal-DAG pruning, plausible-CoT
synthesis, flag/oracle schemas, anonymization, and per-target chat-template
export — is downstream and out of repo, consuming a versioned trace-schema
contract. See [`docs/brainstorm/golden-trace-pipeline.md`](docs/brainstorm/golden-trace-pipeline.md):

```
workflow run → [verbatim capture]  ← this repo's boundary
             → causal prune → CoT synthesis + validation → flag extraction → restitch & export   (out of repo)
```

The capture format is the stable contract IronCurtain commits to; curation
tooling pins its schema version. `schemaVersion: 1` on every record and manifest
entry is the versioning seam.

## Prior art & open research

We examined **`reproducible-trajectories`** (ASSERT-KTH, Martin Monperrus;
PyPI `reproducible-trajectories`, MIT) as the closest comparable. It is a
fundamentally different layer of the stack, and the comparison sharpens what is
distinctive about IronCurtain's capture.

**What it does and how it differs:**

- **Different capture point and provenance, not the wire.** It parses the
  *client-side* session logs that coding-agent CLIs already write
  (`~/.claude/projects/**/*.jsonl` for Claude Code; `~/.codex/sessions/` for
  Codex; `~/.pi/agent/sessions/` for pi), and normalizes Codex/pi into a
  Claude-shaped event schema. IronCurtain captures the *provider HTTP exchange*
  at the MITM. The practical consequence is decisive for training data: in a
  Claude Code session log the system prompt appears in a single `type:"system"`
  housekeeping event and thinking blocks are sparse (single-turn-scoped, same
  stripping behavior we verified), whereas IronCurtain's per-`/v1/messages`
  record carries the full ~32 KB system prompt, all tool schemas, and the
  response-side thinking-with-signature on *every* turn. Their format is built
  for *behavioral analysis of the final commit* (which files were read/modified,
  was the edit reproducible); ours is built for *token-level SFT/RL*.

- **"Reproducible" means deterministic-replay verification, not re-runnable
  inference.** Their thesis: an AI-produced commit should be replayable like a
  deterministic build. `verify-trajectories` walks a repo, finds commits tagged
  `trajectory: <uuid>`, replays the trajectory's `Write`/`Edit` ops on the
  parent-commit file state, and checks the result byte-matches the actual commit
  (`reproducible` / `not_reproducible` / `no_operations` / `trajectory_not_found`).
  This is *provenance verification of file edits*, not replaying the LLM call.
  IronCurtain captures no edit-replay notion — and for byte-exact SFT it doesn't
  need one, since the model I/O itself is the artifact.

- **Strong on privacy/provenance plumbing, which we lack.** `filter-trajectories`
  strips tool calls referencing paths outside the repo (or an explicit deny
  list) and drops the paired results, keeping a valid trace.
  `share-trajectories` scans local sessions, keeps only single-git-repo edits,
  checks GitHub public-ness, and uploads with a `metadata.json`
  (`git_email`, public repo URLs). A pre-commit hook ties a trajectory id into
  the commit message and POSTs it to a central collection endpoint. None of this
  has an analogue in IronCurtain.

**What to adopt / stay compatible with:**

1. **Commit ↔ trajectory provenance binding is worth borrowing.** Their
   `trajectory: <uuid>` / `<trajectory>...</trajectory>` commit convention plus
   `add-trajectories-to-repo` (copy a repo-safe trajectory into `trajectories/`)
   is a clean way to attach a trajectory to the artifact it produced. For
   IronCurtain workflow runs that end in a commit, stamping the run's
   `sessionId` / `workflowRunId` into the commit message would let a downstream
   tool join code outcomes to token trajectories — useful for outcome-labeled
   SFT/RL (good-commit vs reverted-commit as a reward signal).
2. **Repo-containment filtering as an anonymization input.** Their
   "all edits within a single git repo" + "outside-cwd path stripping" is
   exactly the privacy gate the golden-trace pipeline's anonymization stage
   needs. Worth mirroring as a corpus pre-filter rather than reinventing.
3. **No format to be compatible with for our purpose.** Their schema is the
   Claude Code client log shape (good for read/modified-file analysis), not a
   token-level training format, and it omits the wire-level fields the
   golden-trace pipeline already calls out as load-bearing (full system prompt
   per turn, on-wire tool schemas, response-side thinking+signature, raw SSE).
   So there is nothing in their schema we should conform to; the Anthropic
   Messages API shape we already capture remains the right intermediate (it is
   the cleanest superset that serializes to OpenAI/Hermes/Mistral).

**Follow-up research questions surfaced by the comparison:**

- **Edit-reproducibility as a free oracle.** Their `verify-trajectories` replay
  is a programmatic, non-LLM correctness check. Could a memory-corruption /
  coding workflow emit an analogous deterministic replay verdict (does replaying
  the captured tool calls against the harness reproduce the captured outcome?)
  as a cheap quality gate *before* a trajectory enters the SFT corpus —
  complementing the golden-trace pipeline's flag/oracle stage?
- **Outcome labeling via commit binding.** If we adopt the commit↔trajectory
  link, does the eventual commit's downstream fate (merged, reverted, CI-passing)
  give a cheaper, less-confabulated success label than LLM-as-judge for
  filtering SFT and constructing DPO/KTO pairs?
- **Cross-agent normalization.** They normalize Claude Code, Codex, and pi into
  one event schema at the *client-log* layer. Since IronCurtain captures at the
  *wire* layer, can we normalize across providers (Anthropic Messages vs OpenAI
  Chat Completions vs Google generateContent) into a single canonical message
  graph at capture/reassembly time, rather than deferring all of it to the
  export stage?
- **Corpus sharing & privacy gate.** Their repo-containment + public-repo check
  + central upload is a working crowd-sourcing model. If IronCurtain trajectories
  are ever pooled, their filter pipeline (path-scope stripping, single-repo
  containment, public-ness check) is the prior art to start from rather than
  build cold.
