# MITM Token Trajectory Capture

## 1. Purpose & motivation

Capture verbatim HTTP exchanges between Docker-mode agents (Claude Code, Goose, etc.) and upstream LLM providers (Anthropic, OpenAI) for use as training-data input. The output is append-only JSONL — one line per HTTP exchange — with byte-exact request and reassembled-response bodies suitable for downstream SFT/RL pipelines.

This design covers the runtime capture stage only. Reassembly to Parquet, prefix dedup, causal pruning, CoT synthesis, anonymization, and chat-template export are all explicitly downstream and live in a separate research repo. See [`docs/brainstorm/golden-trace-pipeline.md`](../brainstorm/golden-trace-pipeline.md), section "### 2. Verbatim Capture", for the constraints this design honors (MITM as capture point; agent-facing side credential boundary; byte-exactness rationale around streaming `input_json_delta` partials).

## 2. Goals & non-goals

**Goals**

- Capture **every** allowed provider HTTP exchange flowing through the Docker MITM proxy.
- Emit **one JSONL line per exchange**, request bytes plus the response — either the raw non-streaming body or a reassembled streaming body — with **byte/wire fidelity** for content.
- Never block, slow, or interrupt the forwarding path. Capture failures must degrade silently.
- Never leak real provider credentials into the captured corpus.
- Be config-gated and default off; have zero cost when disabled.
- Attach workflow state / persona at write time via the existing coordinator persona marker.

**Non-goals**

- **Code Mode / built-in agent capture is out of scope.** The user explicitly wants MITM-only. The Code Mode path (`src/agent/`) has its own SDK call site (`generateText`) which would require a separate `wrapLanguageModel` design; not addressed here.
- Offline JSONL → Parquet / curation / dedup / training-data export. Downstream repo.
- Causal DAG pruning, CoT synthesis, flag schemas, anonymization. Downstream.
- Provider-side metadata not visible to the agent (e.g., upstream-only response headers).
- Capture of registry / passthrough / WebSocket traffic. Provider endpoints only.

## 3. Architecture overview

The capture hook attaches to the inner HTTP server's `request` handler in `src/docker/mitm-proxy.ts`, the function responsible for handling decrypted requests on TLS-terminated provider connections.

**Integration points (cited in `src/docker/mitm-proxy.ts`):**

1. **Request body capture** — line 941–966 already buffers the full request body when `needsBuffer` is true (rewrite or 401-retry path). The capture path **must not change forwarding semantics**: `needsBuffer = needsRewrite || retryBufferOk` (line 758) governs whether the body is read into memory before forwarding, and forcing it on for capture would start 413-ing the streaming uploads at `MAX_REWRITE_BODY_BYTES = 10 MB` (line 189) that today stream straight through. Instead, when `capture.enabled` is true the capture path **tees** the request body between `clientReq` and `upstreamReq`: a `PassThrough` accumulates bytes for the capture record while the original `clientReq.pipe(upstreamReq)` path (line 901) is preserved. The buffered-rewrite path still captures from the same `rawBody` it already produces. In both paths, the snapshot is the **pre-rewrite, pre-key-swap** payload along with the **original immutable `clientReq.headers`** (NOT `modifiedHeaders`), so the captured headers always carry the sentinel `fakeKey`. **No per-record byte cap.** The tee accumulates the full request body regardless of size — partial captures are useless for SFT, so we either capture the whole thing or mark the session poisoned (§9). If memory pressure or a write error prevents recording this exchange completely, the entire session is flagged in its `session-end` manifest entry and discarded by downstream tooling; we never emit a partial record.

2. **Response capture (streaming)** — line 836–843 already pipes the upstream response through `SseExtractorTransform`. Capture cannot sit in-series on that pipeline because Anthropic compresses SSE responses (`content-encoding: gzip` is the default), and the reassembler needs **decompressed** SSE event bytes to parse `message_start`, `content_block_delta`, etc. The forwarding path must continue to deliver the raw compressed bytes to the agent (its SDK decompresses transparently); only the capture branch needs decompression. We fan out: split the upstream into a forwarding branch (raw → `clientRes`) and a capture branch (raw → `zlib` decompressor matched to `content-encoding` → captureTap → reassembler). For `content-encoding: identity` (or absent) the decompressor is bypassed. Supported decompression schemes: `gzip` (`zlib.createGunzip`), `deflate` (`zlib.createInflate`), `br` (`zlib.createBrotliDecompress`). Anthropic also accepts `zstd` in `Accept-Encoding` but Node's built-in `zlib` does not ship a zstd decompressor; if a `zstd` response ever arrives, the session is poisoned with `poisonReason: 'unsupported-encoding'` rather than storing opaque blobs. Decompression errors (truncated gzip, corrupt frame) also poison the session — they're indistinguishable from `mid-stream-abort` semantically.

3. **Response capture (non-streaming)** — line 851–865 already runs a bounded JSON capture for token-stream extraction on `application/json` LLM responses. We reuse the same fan-out shape as the streaming path: split upstream into forwarding and capture branches; the capture branch decompresses per `content-encoding` then accumulates the decompressed bytes as the canonical body. Body is never `JSON.parse`d. Same supported-encoding set and poison semantics as the streaming path.

4. **Capture-endpoint gate (training-relevant exchanges only)** — `api.anthropic.com` hosts both the completion endpoint (`/v1/messages`) and a large volume of Claude Code housekeeping traffic on the same host: MCP-registry catalog pagination (`/mcp-registry/v0/servers`), telemetry batches (`/api/event_logging/v2/batch`), settings/policy lookups (`/api/claude_code/*`), SDK eval pings (`/api/eval/sdk-*`). Empirically these housekeeping exchanges are **~two-thirds of captured bytes** and contain zero model-emitted content — and the `event_logging` batches carry the agent's own action telemetry, which risks leaking fields back into the trajectory corpus through a side channel. Capture must be gated to **training-relevant endpoints only**. The gate is a per-provider allowlist: add `captureEndpoints: EndpointMatcher[]` to `ProviderConfig` (`src/docker/provider-config.ts`), populated with only the completion paths per provider (Anthropic: `/v1/messages`; OpenAI: `/v1/chat/completions`; Google: `*/generateContent`, `*/streamGenerateContent`). A new predicate `isCapturableEndpoint(provider.config, method, path)` — sibling to the existing `isEndpointAllowed` (line 724) and `isLlmMessagesEndpoint` (line 350) — gates the `beginCaptureExchange(...)` call at the capture-decision point (around line 801). **Allowlist, not deny-list**: housekeeping endpoints churn (new `/api/eval/sdk-*` ids every release) while the completion endpoint set is small and stable, so an allowlist fails safe (a new housekeeping path is silently not captured, rather than silently polluting the corpus). The gate is **strictly subtractive** — when `isCapturableEndpoint` returns false, `captureHandle` stays `undefined`, which is already a documented no-op throughout the forwarding / key-swap / 401-retry paths. The agent still receives every response normally; only the capture branch is skipped. Default `captureEndpoints` is `[]` (capture nothing) for any provider that doesn't explicitly opt in.

**Data flow (prose):**

```
Agent container
    ↓ (TLS, sentinel x-api-key)
outerServer CONNECT (mitm-proxy.ts ~line 1281)
    ↓ (TLS terminated)
innerServer 'request' handler (mitm-proxy.ts:692)
    ├──[A] bufferRequestBody (capture rawBody + agent-facing headers)
    │       ↳ ExchangeRecord.request snapshot taken HERE
    ↓
validateAndSwapApiKey (line 733) — fake→real key swap (NOT captured)
requestRewriter (line 968–982) — body mutation (NOT captured)
    ↓
upstreamReq → https.request to api.anthropic.com / api.openai.com
    ↓
upstreamRes
    ├──→ forwarding branch (raw compressed bytes) → extractor → clientRes (agent)
    └──→ capture branch
           ↓
           [zlib decompressor matched to content-encoding; bypassed for identity]
           ↓
           captureTap → SseReassembler (or non-streaming accumulator) → ExchangeRecord
           ↓
           CaptureWriter (async queue) → workflow-runs/.../captures/*.jsonl
```

The capture writer is the only component that may write to disk. It owns an **unbounded** records queue plus an unbounded manifest queue (per §9), drains on a dedicated `setImmediate` loop, and uses `fs.appendFile` (callback form, line-atomic for entries under `PIPE_BUF`). Partial captures are useless for SFT, so the design refuses to drop individual records — failure modes poison the entire session instead (see §9).

**New files** (all under `src/docker/`):

- `trajectory-capture.ts` — public `TrajectoryCaptureWriter` interface, unbounded queue, JSONL serializer, per-session lifecycle.
- `trajectory-reassembler.ts` — SSE → final-message reassembly for Anthropic and OpenAI shapes. Exports `AnthropicReassembler`, `OpenAIReassembler` classes implementing a shared `Reassembler` interface.
- `trajectory-types.ts` — types: `ExchangeRecord`, `CaptureConfig`, internal reassembler state.

The MITM proxy gains:

- A new optional field on `MitmProxyOptions`: `readonly capture?: TrajectoryCaptureWriter | undefined`.
- New internal setters on the `MitmProxy` handle: `setCapturePersona(persona: string | undefined): void` and `setCaptureSessionId(id: SessionId | undefined): void` (both mirror `setTokenSessionId`). These are **internal** implementation details — they are wrapped by the unified `bundle.beginCaptureSession()` / `bundle.endCaptureSession()` surface (see §11) and are **not** called directly by the orchestrator.

## 4. JSONL schema

One line per HTTP exchange. Each line is a single JSON object terminated by `\n`. UTF-8 throughout.

```ts
interface ExchangeRecord {
  // Identity & provenance
  readonly schemaVersion: 1;
  readonly exchangeId: string;          // ULID; sort-orderable
  readonly sessionId: string;           // SessionId at exchange start
  readonly persona?: string;            // workflow persona at exchange start
  readonly workflowRunId?: string;      // if present in MitmProxyOptions
  readonly bundleId?: string;
  readonly agentKind?: string;          // 'claude-code' | 'goose' | ... — populated from `mode.agent` (a `DockerAgent` from `src/config/user-config.ts:228–229`) at bundle construction in `docker-infrastructure.ts:296` (`getAgent(mode.agent)`), then threaded into `MitmProxyOptions` alongside the existing `agentKind: AgentKind` (which is a distinct field carrying `'workflow' | undefined` per `src/docker/provider-config.ts:19` and `docker-infrastructure.ts:415`). The capture writer reads `mode.agent` from a new `MitmProxyOptions.recordedAgentName` field; the existing `agentKind` field stays unchanged for the rewriter's purposes. The name `recordedAgentName` (not `agentName`) makes the capture-side intent explicit at the type, so a reader doesn't conflate the two adjacent fields. (The two fields exist because `provider-config.ts:AgentKind` is intentionally a closed enum used by the request rewriter for workflow-conditional behavior — overloading it with the broader agent name would couple two unrelated concerns.)

  // Wire metadata
  readonly provider: 'anthropic' | 'openai' | 'unknown';
  readonly method: string;              // 'POST'
  readonly host: string;                // 'api.anthropic.com'
  readonly path: string;                // '/v1/messages'
  readonly requestStartedAt: number;    // epoch ms
  readonly requestFinishedAt: number;
  readonly responseFinishedAt: number;

  // Request — agent-facing side, BEFORE key swap and BEFORE rewriter
  readonly request: {
    readonly headers: Record<string, string>;  // redacted (see §8)
    // For uncompressed `content-encoding: identity` bodies, `bodyUtf8` is the
    // raw bytes decoded as UTF-8 and `bodyBase64` is absent. For compressed
    // bodies (gzip, br, deflate) — or any case where the bytes are not
    // guaranteed to be valid UTF-8 — `bodyUtf8` is the empty string and
    // `bodyBase64` carries the original bytes verbatim. Exactly one of the
    // two is populated per record; the schema contract is that downstream
    // can reconstruct the on-wire bytes from whichever field is present.
    readonly bodyUtf8: string;
    readonly bodyBase64?: string;
    readonly bodyBytes: number;                // original byte length
    readonly contentEncoding?: string;         // captured verbatim, never decoded
  };

  // Response — full, reassembled if streaming
  readonly response: {
    readonly status: number;
    readonly headers: Record<string, string>;  // upstream → agent headers, redacted
    readonly streaming: boolean;
    readonly providerRequestId?: string;       // anthropic-request-id / x-request-id
    readonly stopReason?: string;              // from message_delta / finish_reason
    readonly modelFingerprint?: string;        // system_fingerprint (OpenAI)
    readonly usage?: Record<string, unknown>;  // captured verbatim from message_delta
    // For non-streaming responses with `content-encoding: identity`, bodyUtf8
    // is the raw response body byte-for-byte. For streaming responses, bodyUtf8
    // is the REASSEMBLED message body constructed so it is byte-identical to
    // the equivalent non-streaming response. The raw SSE log is captured
    // separately in `streamRaw`. For compressed responses (gzip/br/deflate
    // -- not used by Anthropic/OpenAI SSE in practice but possible defensively)
    // `bodyUtf8` is the empty string and `bodyBase64` carries the on-wire
    // encoded bytes. Exactly one of the two is populated per record.
    readonly bodyUtf8: string;
    readonly bodyBase64?: string;
    readonly bodyBytes: number;
    readonly streamRaw?: {
      readonly events: ReadonlyArray<{
        readonly eventType: string;       // 'message_start' | 'content_block_delta' | ...
        readonly dataUtf8: string;        // exact data: payload, no parse-restringify
        readonly offsetMs: number;        // since response start
      }>;
    };
  };

  // Capture-side flags
  readonly capture: {
    // True if SSE reassembly succeeded end-to-end (clean message_stop, all
    // content blocks closed, no malformed events). When false, the exchange
    // is incomplete on the wire and the writer poisons the session at
    // session-end (no partial record is emitted; this flag exists only for
    // diagnostic visibility on records that DID reach the writer before
    // poisoning was detected).
    readonly reassemblyOk: boolean;
    readonly reassemblyDiagnostic?: string;
    // True when this record is the successful retry of a 401-refresh retry
    // (line 805 / `retryWithRefreshedToken`). The first attempt's response
    // is discarded by the proxy (drained, not forwarded) and so is NOT
    // captured: the recorded `response` field is the successful retry's
    // response. See §5 for the rationale of single-record-with-flag vs
    // paired exchangeId records.
    readonly retried?: boolean;
  };
}
```

**Concrete example** (Anthropic streaming, abbreviated):

```json
{"schemaVersion":1,"exchangeId":"01HXY3KGNS9MZ4...","sessionId":"sess-9c2","persona":"recon","workflowRunId":"wf-2026-05-24-abcd","provider":"anthropic","method":"POST","host":"api.anthropic.com","path":"/v1/messages","requestStartedAt":1716552123456,"requestFinishedAt":1716552123512,"responseFinishedAt":1716552127090,"request":{"headers":{"x-api-key":"<sentinel>","anthropic-version":"2023-06-01","content-type":"application/json"},"bodyUtf8":"{\"model\":\"claude-sonnet-4-7-20260415\",\"messages\":[...],\"tools\":[...],\"stream\":true}","bodyBytes":15234},"response":{"status":200,"headers":{"content-type":"text/event-stream","anthropic-request-id":"req_abc"},"streaming":true,"providerRequestId":"req_abc","stopReason":"tool_use","usage":{"input_tokens":1234,"output_tokens":56,"cache_creation_input_tokens":890,"cache_read_input_tokens":7000},"bodyUtf8":"{\"id\":\"msg_01...\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-7-20260415\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"Let me check...\",\"signature\":\"sig_xyz\"},{\"type\":\"tool_use\",\"id\":\"toolu_01\",\"name\":\"read_file\",\"input\":{\"path\":\"/etc/hosts\"}}],\"stop_reason\":\"tool_use\",\"stop_sequence\":null,\"usage\":{...}}","bodyBytes":3421,"streamRaw":{"events":[{"eventType":"message_start","dataUtf8":"{\"type\":\"message_start\",\"message\":{...}}","offsetMs":12},{"eventType":"content_block_start","dataUtf8":"{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}}","offsetMs":45}]}},"capture":{"reassemblyOk":true}}
```

## 5. Reassembly algorithm

The reassembler runs on a tap **upstream** of `SseExtractorTransform` and consumes raw byte chunks. It splits on SSE line boundaries (CRLF or LF, same handling as `sse-extractor.ts:97–143`) and dispatches by `event:` / `data:` lines. Each provider has its own state machine. Both reassemblers preserve raw `data:` payload bytes verbatim — no JSON round-trip — and only parse JSON to extract structural fields needed for reassembly (`type`, `index`, `delta.type`).

**Critical byte-fidelity rule**: when concatenating `partial_json` / `arguments` chunks, the reassembler uses **string concatenation of the raw payload substrings** as they appeared on the wire, not a parsed and re-serialized object. The final assembled `tool_use.input` JSON object value is the concatenated string, embedded into the assembled message body as the unparsed token sequence.

### Anthropic SSE → final message

State per exchange:

```ts
type AnthropicState = {
  // Header fields collected from message_start
  messageHeader: string;     // raw substring captured from data of message_start
                              // up to "content":[" — everything BEFORE content blocks
  // Content blocks indexed by block index
  blocks: Map<number, ContentBlockState>;
  // Footer fields from message_delta + message_stop
  stopReason?: string;
  stopSequence?: string | null;
  usageRaw?: string;         // raw substring of "usage":{...}
};

type ContentBlockState =
  | { kind: 'text'; openRaw: string; textChunks: string[] }
  | { kind: 'tool_use'; openRaw: string; partialJsonChunks: string[] }
  | { kind: 'thinking'; openRaw: string; thinkingChunks: string[]; signatureChunks: string[] }
  | { kind: 'redacted_thinking'; openRaw: string }
  | { kind: 'server_tool_use' | 'web_search_tool_result' | ...; openRaw: string; rawDeltas: string[] };
```

Transitions:

1. `message_start` → capture top-level message envelope. The reassembler **does not parse and re-emit** — it locates the position of the empty `"content":[]` and remembers the prefix and suffix substrings so that on finalize it can splice the assembled content array between them.
2. `content_block_start` → record the block's opening object verbatim (i.e., the bytes between the surrounding `{` and `}` in the `content_block` field). Initialize per-kind state.
3. `content_block_delta` →
   - `text_delta`: append `delta.text` value bytes (the JSON-decoded string, since the assembled output will re-encode in the standard JSON form — see invariant 3 below).
   - `input_json_delta`: append `delta.partial_json` bytes **as the raw substring from the wire**. These are concatenated into the assembled tool_use input value without parse-restringify.
   - `thinking_delta`: append `delta.thinking` bytes; `signature_delta`: append `delta.signature` bytes.
4. `content_block_stop` → mark block complete.
5. `message_delta` → capture `delta.stop_reason`, `delta.stop_sequence`, `usage` (raw substring).
6. `message_stop` → trigger finalize.

**Finalize** assembles the message body as:

```
{
  "id":"...","type":"message","role":"assistant",
  "model":"...","content":[
    <block 1 reassembled>,
    <block 2 reassembled>,
    ...
  ],
  "stop_reason":"...","stop_sequence":...,"usage":{...}
}
```

For each block:

- `text` → `{"type":"text","text":<JSON-encoded concatenation of textChunks>}`.
- `tool_use` → `{"type":"tool_use","id":"<from open>","name":"<from open>","input":<concatenation of partialJsonChunks>}` — input value is inserted **as raw bytes**, not parsed. If `partialJsonChunks` is empty, emit `{}`.
- `thinking` → `{"type":"thinking","thinking":<JSON-encoded thinkingChunks>,"signature":<JSON-encoded signatureChunks>}`.
- `redacted_thinking` → reuse `openRaw` verbatim (signature/data already complete in the open event).
- Unknown block kinds → reuse `openRaw` verbatim plus a `_raw_deltas` array for forensic safety; downstream can drop.

Block order is preserved by sorting on the wire `index` field. The assembled JSON is built via direct string interpolation, never `JSON.stringify(messageObject)`.

### OpenAI SSE → final message

State per exchange:

```ts
type OpenAIState = {
  envelope: string;                      // first chunk's id/model/system_fingerprint
  choiceContent: string[];               // concat delta.content per choice
  toolCalls: Map<number, ToolCallState>; // keyed by tool_calls[].index
  finishReason?: string;
  usage?: string;                        // raw substring if present in final chunk
};

type ToolCallState = {
  id?: string;
  name?: string;
  argumentsChunks: string[];             // raw arguments substrings, verbatim
};
```

Transitions: split SSE `data:` lines, parse each, accumulate. `[DONE]` → finalize.

Finalize emits a single Chat Completion response shape with `choices[0].message.content` as the concatenated text, `tool_calls[]` ordered by index, each with `function.arguments` = `argumentsChunks.join('')`. The arguments string is **never** `JSON.parse`d and re-serialized.

### Failure modes

If the reassembler encounters an event sequence it cannot interpret (e.g., a block ends without `content_block_start`, unknown delta type), it sets `capture.reassemblyOk = false`, writes a diagnostic, and **the partial record is NOT written to the trajectory file**. The session is marked poisoned with `poisonReason: 'reassembly-failure'` and the `session-end` manifest entry carries the flag (§9). Downstream tooling discards the entire session; we do not emit a partial record because a partial trace is worse than no trace for SFT. The raw event log accumulated up to the failure point is held in-memory only for the writer's diagnostic logging and is **not** flushed to disk — committing a partial wire log to a "poisoned" file would tempt downstream tools to salvage it, which is exactly the failure mode the binary-session model prevents.

### 401 refresh-retry semantics

`forwardRequest` (mitm-proxy.ts:765) is invoked twice on the OAuth refresh path: once with the agent's original bearer, and a second time via `retryWithRefreshedToken` (line 1778) carrying the refreshed token. The first response is consumed and drained by the proxy (lines 805–826) — it is **never** forwarded to the agent — and its body is just the upstream's 401 error envelope, not provider content. Capturing the first attempt would produce a `(request, response)` tuple where the recorded request headers match an attempt the agent did not observe completing, and the recorded `usage` numbers would belong to a 401 error envelope rather than the model call.

**Decision: one record per exchange, with a `capture.retried: true` flag on the record whose response came from the successful retry.** The recorded `request` headers and body remain the agent's original (pre-refresh) request — that is the only request the agent emitted from its own perspective; the refresh is a proxy-side artifact transparent to the agent. The recorded `response` is the successful retry's response, and `capture.retried = true` marks the record so downstream training pipelines can decide whether to keep, deweight, or drop it. The discarded 401 response is not captured: there is no agent-observable second exchange to pair it with, and emitting an orphan record would create a misleading paired structure in the corpus.

Rationale for not emitting paired records under a shared `exchangeId`: the proxy presents a single logical exchange to the agent (one `request`, one `response`); two records would over-represent rare refresh events in token-weighted statistics and force every downstream consumer to dedup. The flag is cheap and the lost diagnostic (which 401 triggered the refresh) is recoverable from the proxy's own log.

## 6. Byte-fidelity invariants

For every captured exchange:

1. **No `JSON.parse` → `JSON.stringify` on captured content.** The reassembler may parse SSE events to read structural fields (`type`, `index`), but the **value strings concatenated into the assembled body must be raw wire bytes**, not re-serialized objects.
2. **No key reordering, whitespace normalization, or number reformatting** in request or response bodies. Request body is captured as `rawBody` (the post-`bufferRequestBody`, pre-rewrite buffer) decoded as UTF-8; for streaming responses the assembled body is built from raw substrings, so any agent-side whitespace/number representation is preserved within each leaf.
3. **`content_block` array order preserved** by sorting on the wire `index`.
4. **Anthropic `thinking.signature` and `redacted_thinking.data` preserved opaquely.** Signatures are reassembled by concatenation; `redacted_thinking` blocks are written through verbatim from `content_block_start.content_block`.
5. **`tool_use.input` (Anthropic) and `tool_calls[].function.arguments` (OpenAI) are stored as raw delta byte sequences.** No round-trip.
6. **Compressed responses are decompressed before reassembly.** Byte-fidelity means byte-equal to **what the model's SDK observed** after standard HTTP transport decoding, not the gzip-encoded wire bytes. Anthropic serves `/v1/messages` SSE with `content-encoding: gzip` by default; if capture stored those raw, every record would be a base64 blob requiring decompression + SSE parsing downstream, defeating the purpose. Instead: the MITM tees the upstream response, pipes the capture branch through a `zlib` decompressor matched to the `content-encoding` (`gzip` / `deflate` / `br`), and the reassembler operates on decompressed bytes. `bodyUtf8` holds the reassembled message exactly as the SDK saw it. The `content-encoding` header on the captured record is preserved as metadata so downstream knows the wire was compressed, but the body field carries the model-visible content. **Decompression failures poison the session** with `poisonReason: 'reassembly-failure'`; truncated gzip is indistinguishable from a mid-stream abort. **`zstd` is not supported by Node's built-in `zlib`**: if Anthropic ever serves zstd-compressed SSE, the session is poisoned with `poisonReason: 'unsupported-encoding'`. `bodyBase64` is reserved for the rare case where the **decompressed** content itself is not valid UTF-8 (e.g., a future binary content-block payload); compressed wire bytes are never stored as the canonical body representation. The same decompression rule applies defensively to request bodies, though in practice agent requests are uncompressed `application/json`.

**Tests enforcing these invariants** (detailed in §12):

- `test/docker/trajectory-streaming-fidelity.test.ts`: parametric fixture that sends a recorded non-streaming response and the equivalent SSE stream through the reassembler. Asserts `bodyUtf8` byte-equality after capture. Multiple fixtures: text-only, text+tool_use, text+thinking+tool_use, parallel tool_use, multi-text-delta with embedded Unicode.
- `test/docker/trajectory-bytes-roundtrip.test.ts`: feeds known-tricky JSON encodings (numbers with trailing zeros `1.50`, non-ASCII keys, sorted-vs-unsorted maps) through the reassembler and asserts the concatenated `partial_json` matches the on-wire substrings.
- ESLint rule (or grep-based CI check) forbidding `JSON.stringify(` calls inside `src/docker/trajectory-reassembler.ts` outside an explicit allow-list of header-envelope serializations.

## 7. File layout, naming, rotation

A trajectory's natural unit is **one Claude session's exchanges**. Workflows run sessions sequentially across FSM states (one session per state); standalone Docker runs are a single session. Layout is per-session, with a sibling manifest in both modes — uniform across standalone and workflow, single code path.

**Standalone Docker** (`docker-agent-session.ts`):

```
~/.ironcurtain/sessions/{sessionId}/captures/
  {sessionId}.jsonl       # the session's exchanges
  manifest.jsonl          # trivial one-pair manifest (session-start + session-end)
```

**Workflow shared-container** (`docker-infrastructure.ts` creates one *dispatcher* per bundle; per-session files open and close on session lifecycle):

```
~/.ironcurtain/workflow-runs/{workflowId}/containers/{bundleId}/captures/
  {sessionId}.jsonl       # one file per Claude session (multiple per bundle)
  manifest.jsonl          # append-only ordering record across all sessions
```

This sits alongside `audit.jsonl` at the bundle root (matching `getBundleAuditLogPath` in `src/config/paths.ts:529`). Every captured exchange is appended to the file matching its `sidAtCapture` (snapshotted at `mitm-proxy.ts:692`). The dispatcher maintains `Map<SessionId, FileHandle>`, opens on first record for a sessionId, closes on the session-end signal from the orchestrator (workflow) or session shutdown (standalone), and emits manifest entries on both session boundaries.

**Manifest schema** (`manifest.jsonl`):

```jsonl
{"schemaVersion":1,"event":"session-start","seq":1,"sessionId":"...","fsmState":"recon","persona":"...","ts":"2026-05-27T..."}
{"schemaVersion":1,"event":"session-end","seq":1,"sessionId":"...","fsmState":"recon","ts":"2026-05-27T...","exchanges":42,"bytesWritten":482301,"poisoned":false}
{"schemaVersion":1,"event":"session-start","seq":2,"sessionId":"...","fsmState":"target-analysis","persona":"...","ts":"..."}
{"schemaVersion":1,"event":"session-end","seq":2,"sessionId":"...","fsmState":"target-analysis","ts":"...","exchanges":17,"bytesWritten":120453,"poisoned":true,"poisonReason":"reassembly-failure"}
```

Fields:
- `event`: `"session-start" | "session-end"`
- `seq`: monotonic counter scoped to the captures directory (defines session ordering)
- `sessionId`, `fsmState` (optional), `persona` (optional), `ts` (ISO 8601)
- on `session-end` only:
  - `exchanges` (record count, computed at write-time per §9.6)
  - `bytesWritten`
  - **`poisoned: boolean`** — `true` when any exchange in this session failed to be captured completely (reassembly aborted, disk write error, queue pathology, agent abort mid-stream, etc.). Downstream tooling discards every session with `poisoned: true`.
  - **`poisonReason: 'reassembly-failure' | 'disk-error' | 'queue-overflow' | 'mid-stream-abort' | 'infrastructure-teardown' | 'unknown'`** — present iff `poisoned: true`. Diagnostic, not load-bearing.
  - optional `closedReason: 'infrastructure-teardown'` when the entry was emitted by `close()` as the synthetic safety-net end-marker rather than by an explicit `endSession()` call. Such sessions are implicitly poisoned (the orchestrator's `finally` did not run cleanly), so `poisoned: true` and `poisonReason: 'infrastructure-teardown'` are set on the same entry.
- Append-only JSONL, same crash-safety story as the trajectory files. Downstream tolerates a truncated trailing line.

The manifest is the **canonical ordering source** for downstream concatenation: walk `manifest.jsonl` in `seq` order, stream the matching `{sessionId}.jsonl` files. Filesystem timestamps and filename collation are not relied on.

**Directory-level poison marker** (`manifest.poisoned`): zero-byte file at the captures-directory root, written by the dispatcher when a manifest `appendFile` error fires. Its existence is the **bundle-wide kill switch** — downstream walkers MUST treat the entire captures directory as discarded when the marker is present, without needing to parse every session's `session-end` poison flag. This sidesteps the case where the manifest itself is partial/corrupted and individual session-end entries cannot be trusted to reflect directory-level health. See §9 step 4.

**No rotation by the runtime, no per-file cap.** Per-session files grow for the session lifetime and close cleanly at session end. Sessions are binary at the session level: either complete-and-usable, or marked `poisoned: true` on the `session-end` manifest entry and discarded wholesale by downstream tooling. We never silently truncate a file or insert a sentinel mid-trace — a truncated SFT trace is poisoned data, worse than no trace at all.

New helpers in `src/config/paths.ts`:

```ts
export function getSessionCapturesDir(sessionId: string): string;
export function getBundleCapturesDir(workflowId: string, bundleId: BundleId): string;
export function getSessionCaptureFile(capturesDir: string, sessionId: string): string;
export function getCaptureManifestFile(capturesDir: string): string;
```

## 8. Credential boundary

**Invariant**: the captured corpus must never contain a real provider credential.

The capture site sits **before** `validateAndSwapApiKey` (mitm-proxy.ts:733). At line 942–943, `bufferRequestBody` produces `rawBody`. We snapshot `rawBody` plus `clientReq.headers` (the original, pre-clone). At this point:

- `x-api-key` header (Anthropic API key flow) holds the sentinel `fakeKey`.
- `authorization` header (Anthropic OAuth flow, OpenAI bearer flow) holds `Bearer ${fakeKey}`.

Then `modifiedHeaders = { ...headers }` is created (line 732), then `validateAndSwapApiKey(modifiedHeaders, provider)` (line 733) **mutates `modifiedHeaders`** in-place to inject the real key. Capture must read from the original `clientReq.headers`, **not** from `modifiedHeaders`. The capture snapshot is taken **inside `processRequest()`** between `bufferRequestBody` (line 943) and the `if (needsRewrite)` block (line 968) — but the headers source must be the immutable original.

Defense in depth — **header redaction at write time**:

The writer applies a redaction filter to both request and response headers before serialization:

1. Drop any header whose name (case-insensitive) is in the deny-list: `authorization`, `x-api-key`, `proxy-authorization`, `cookie`, `set-cookie`.
2. Replace dropped header values with literal `<redacted>` to preserve schema shape.
3. The sentinel fake key is itself fingerprint-safe (it's 192 random bits per `fake-keys.ts`), but redaction is unconditional — never trust that the snapshot was on the right side of the swap.

**Regression test design** (two tiers — see §12 for full test catalog):

The credential boundary is defended by two tests at different scopes. The **writer-input unit test** is the per-PR CI gate; the end-to-end MITM test is opt-in and runs nightly.

*Per-PR unit test* (`test/docker/trajectory-credential-leakage.unit.test.ts`):

- Drives `(headers, rawBody)` tuples directly through the dispatcher's redaction filter — no proxy, no TLS, no Docker. Constructs adversarial inputs that include the literal string `sk-ant-test-REALKEY12345-DO-NOT-LEAK` in (a) `authorization` header, (b) `x-api-key` header, (c) the request body (simulating a leaked credential in the agent payload), (d) an upstream error message reflected back through `reassemblyDiagnostic`, and (e) the `streamRaw.events` payload from a synthesized SSE stream.
- Reads every byte of the writer's emitted JSONL; greps bytewise (not parsed) for `REALKEY12345`. Must yield zero matches.
- Fast (≪ 1 s), no Docker, no TLS, no `socketMetadata` — runs on every PR. This is the **load-bearing credential-leakage gate**: any refactor that mistakenly captures from `modifiedHeaders`, fails to redact a header, or leaks a key through a diagnostic fails CI here.

*Nightly end-to-end test* — covered in §12 as test #7 (`trajectory-e2e.test.ts`). The end-to-end test additionally exercises the credential boundary, but its primary purpose is wire-level integration; the unit test above is the redaction CI gate.

## 9. Crash safety + async write path

`TrajectoryCaptureWriter` is a **dispatcher**: one instance per bundle (workflow) or per session (standalone), managing per-session file handles and a single manifest. **This is the internal dispatcher API** — the public lifecycle surface that the orchestrator and standalone session call is `bundle.beginCaptureSession()` / `bundle.endCaptureSession()` on `DockerInfrastructure` (see §11). The dispatcher methods below are not called directly by orchestrator code; they are wrapped by the bundle's unified methods. Exposed here in full for unit-testing the dispatcher in isolation.

```ts
export interface TrajectoryCaptureWriter {
  /** [internal] Open per-session file lazily, append a `session-start` manifest entry. Wrapped by bundle.beginCaptureSession(). */
  beginSession(opts: { sessionId: SessionId; fsmState?: string; persona?: string }): void;
  /** Enqueue a record. Returns immediately. Never throws. Routed to the file matching `record.sessionId`. */
  write(record: ExchangeRecord): void;
  /** Update persona stamped on subsequent records within the active session. */
  setPersona(persona: string | undefined): void;
  /** [internal] Drain pending writes for the session (two-phase, see below), close the file, append a `session-end` manifest entry. Wrapped by bundle.endCaptureSession(). */
  endSession(sessionId: SessionId): Promise<void>;
  /**
   * Drain queue, close all open files, close manifest. Emits a synthetic
   * `session-end` entry (with `closedReason: 'infrastructure-teardown'`)
   * for any session that is still open when `close()` is called — this
   * is the safety net for crash / abort / SIGINT paths where the
   * orchestrator's `finally` block did not run.
   */
  close(): Promise<void>;
  /** Aggregate diagnostics across all sessions. */
  stats(): { written: number; dropped: number; queued: number; bytesWritten: number; openSessions: number };
}
```

**Lifecycle hooks** (the public surface is `bundle.beginCaptureSession()` / `bundle.endCaptureSession()`; see §11. The hooks below describe how the orchestrator and standalone session use that surface, and how teardown reconciles state when the orchestrator's `finally` block doesn't run):

- **Workflow**: orchestrator calls `bundle.beginCaptureSession({...})` before starting a state's session and **`await bundle.endCaptureSession(id)` in the `finally` block of `executeAgentState`** — verified at `orchestrator.ts:2176–2196`. The current code's `bundle?.setTokenSessionId(undefined)` on line 2186 fires sync-only in `finally` (which is fine for it: it just nulls a closure variable); the new `endCaptureSession` MUST be awaited **before** `session.close()` is awaited, so the `session-end` manifest entry is durable even if `session.close()` throws. Concretely: in `finally`, first `await bundle.endCaptureSession(endedSessionId).catch(...)`, then `await session.close().catch(...)`. Both calls are wrapped in `.catch` so neither prevents the other from running.
- **Standalone Docker**: `docker-agent-session.ts` (`close()` at line 425) calls `await bundle.endCaptureSession(sessionId)` before `destroyDockerInfrastructure(this.infra)`.
- **Infrastructure teardown safety net** (covers crash / Ctrl-C / abort paths where neither `finally` nor `close()` runs): `destroyDockerInfrastructure` (`docker-infrastructure.ts:624`) and `destroyWorkflowInfrastructure` (`orchestrator.ts:950`) MUST call `await writer.close()` after `mitmProxy.stop()` returns. `writer.close()` walks `Map<SessionId, FileHandle>`, drains the queue, and emits a **synthetic `session-end` entry** for every still-open session with `closedReason: 'infrastructure-teardown'`. Without this safety net, a SIGINT during an agent step leaves the manifest with an orphan `session-start` whose matching `session-end` is missing — and downstream walks the manifest in `seq` order and silently skips over the orphan, treating the file as nonexistent. Order of operations in `destroyDockerInfrastructure`: stop containers → stop proxies → `await writer.close()` → remove runtime root.

**Drain semantics for `endCaptureSession` (two-phase)** — `bundle.endCaptureSession(sessionId)` internally drives the dispatcher's `endSession(sessionId)`, which executes:

- **Phase A (synchronous, at call site)**: flip a per-session `endRequested = true` flag. Any subsequent `write()` for that sessionId is rejected (no-op + one-shot log; this should not normally happen). Crucially, **the captureTap for any in-flight response keyed to this sessionId is allowed to complete** — `endRequested` only blocks **new** writes, not the finalization of in-flight reassembly.
- **Phase B (async, returns `Promise<void>`)**: await `Promise.all` of two things:
  1. the records-queue cursor has advanced past every record tagged with this sessionId that was already enqueued at the moment of the flip, **and**
  2. every in-flight `captureTap → reassembler` Promise for this sessionId has either resolved (normal `_flush`) or rejected/aborted (which would have already poisoned the session via the `mid-stream-abort` path).

  Once both settle, enqueue the `session-end` manifest entry. This entry is the **only** place the per-session counter snapshot is materialized.

The reassembler MUST expose its per-session in-flight Promises so the dispatcher can await them. The natural shape is a dispatcher-owned `Map<SessionId, Set<Promise<void>>>` of in-flight reassembly Promises — the captureTap registers each Promise on attachment and removes it on settle. Spelling this out here (rather than letting the implementer bolt it on later) keeps the two-phase semantics enforceable.

**Pipeline**:

1. `write()` looks up `record.sessionId` in `Map<SessionId, FileHandle>`. If absent (a programming error — `beginSession` was not called), the **session is marked poisoned** with `poisonReason: 'unknown'` for the missing sessionId so the eventual `session-end` carries it, the record is discarded, and a one-shot `warn` log fires. Otherwise the record is appended to the per-session **unbounded** queue.
2. **No drop-oldest ring buffer, but a high-watermark tripwire on the records queue.** Both the records queue and the manifest queue are conceptually unbounded — individual records are never dropped — but the records queue defends `§2` goal #3 ("never block, slow, or interrupt the forwarding path") with an explicit tripwire. The naive "unbounded queue, OOM beats corruption" framing previously here violated the goal: under realistic backpressure (slow NFS-backed home dir, fsync stalls, or multi-session shared-container bundles with many concurrent agents) an unbounded queue grows monotonically and eventually OOMs the IronCurtain host process — which **is** the proxy host, so OOM blocks/interrupts forwarding. Resolution: a **high-watermark tripwire** that keeps the queue effectively bounded while preserving binary-session semantics.

   - **High-watermark** (default: **1024 records**): when the records queue length crosses this threshold, the dispatcher **poisons every currently-open session in the bundle** using the already-reserved `queue-overflow` poison reason, and rejects all subsequent `write()` calls until the queue drains.
   - **Low-watermark** (default: **256 records**): once the queue drops back below the low-watermark, new `beginCaptureSession()` calls are accepted again. (In-progress poisoned sessions still finish their `session-end` emit; new sessions get fresh state.)
   - Upstream forwarding continues uninterrupted throughout — the tripwire is queue-internal, never propagated back into the proxy's hot path.

   The key distinction from the original bounded ring buffer is that overflow **poisons whole sessions** instead of dropping individual records: partial captures are still useless for SFT, but we never sacrifice goal #3 to defend that invariant. Defaults are intentionally **tunable only by code change** (not exposed in `CaptureConfig`) — simplicity priority, and the right knob for users who hit the watermark is to disable capture entirely. Manifest entries stay on a separate unbounded queue (per step 5 below) — its worst case is `2 × N_sessions × 300 B`, harmless even at workflow scale, so no watermark there.
3. A drain loop scheduled via `setImmediate` serializes one record at a time with `JSON.stringify` (this is the **only** allowed `JSON.stringify` in the capture path; it serializes the *envelope*, with `bodyUtf8` being a regular string field — so the inner bytes are escape-encoded once, not re-parsed).
4. The serialized line plus `\n` is written via `fs.appendFile` (callback form) on the per-session file handle. `appendFile` is line-atomic on POSIX for writes ≤ `PIPE_BUF` (4096 bytes); larger writes are non-atomic across processes, but the writer is the only writer to its files. Within a single process, `appendFile` calls are serialized in-order by Node's filesystem queue. **Disk errors have two distinct blast radii:**
   - **Trajectory-file `appendFile` error** (`ENOSPC`, `EIO`, etc. on a per-session `{sessionId}.jsonl`): poisons exactly the one session. `poisonReason: 'disk-error'` is set; no further records are written for that session; subsequent `write()` calls for the session no-op; the `session-end` entry still emits (with the poison flag) on `endSession` so the manifest is consistent. Other open sessions in the same bundle are unaffected.
   - **Manifest `appendFile` error**: bundle-wide blast radius. The manifest is the **canonical ordering source** for downstream concatenation (§7) and is shared across every session in the captures directory; a manifest write failure makes the entire directory untrustworthy. Resolution: **poison every currently-open session** in the directory (each with `poisonReason: 'disk-error'`); reject all subsequent `bundle.beginCaptureSession()` calls for that directory (they no-op + log); and write a sibling **`manifest.poisoned`** file (zero-byte marker) at the captures-directory root so downstream walkers detect the directory-level poison even without parsing every session's `session-end`. The marker file's existence is the directory-level kill switch — see §7 alongside the manifest schema.
5. **Manifest entries live on a separate, unbounded queue.** A manifest entry is bounded by session-lifecycle events (`session-start` + `session-end` per session, optionally a synthetic teardown end-marker), each well under 300 bytes. Per-bundle worst case is `2 × N_sessions × 300 B` — for a workflow with 50 states that's 30 KB — so an unbounded queue is harmless. The drain loop services both, preserving the property that a `session-end` entry for session S appears after every record for S that has already been enqueued — `endSession` waits for the records queue to drain to its session's last entry before enqueuing the manifest end-marker.
6. **Counters on `session-end` are incremented at write-time, not enqueue time.** `exchanges` and `bytesWritten` on the `session-end` manifest entry are computed inside the `fs.appendFile` callback for each record — only when a record has actually been written to disk is the per-session counter bumped. If the writer is destroyed mid-drain, the synthetic `session-end` from `close()` reflects only the records that actually reached disk, and the file's line count matches the manifest's `exchanges` field by construction. (Such sessions are also poisoned via `closedReason: 'infrastructure-teardown'` — see §9 lifecycle hooks.)
7. **Poison sources** (any of these mark the session poisoned and set the matching `poisonReason` on `session-end`):
   - `reassembly-failure` — SSE reassembler aborts (orphan `content_block_stop`, unknown delta type, mid-stream truncation in a way that prevents valid byte-equality reassembly). Sets `capture.reassemblyOk: false` on whatever record was being assembled; that record is **not** written.
   - `mid-stream-abort` — agent disconnects or upstream resets before `message_stop` arrives. Detection is bound to the captureTap's lifecycle:
     - The captureTap is implemented as a Node `Transform` whose **`_flush()` is the only "completed cleanly" signal** — `_flush` runs iff the upstream side closed cleanly after a final chunk.
     - Any `'close'` event arriving on the captureTap before `_flush` runs, or any `'error'` event on `upstreamRes` (mitm-proxy.ts:791) or on the captureTap itself, is treated as `mid-stream-abort`: the dispatcher poisons the session for the captureTap's `captureSessionId` and drops the in-flight record without writing. `clientRes.on('close')` (mitm-proxy.ts:887) triggers `upstreamReq.destroy()` (line 889), which propagates as an `error`/`close` on `upstreamRes` and thence on the captureTap — the unified detection point handles agent disconnect and upstream reset uniformly.
     - **401-retry interaction**: the captureTap is attached only to the **second** (successful) `forwardRequest` invocation, per resolved §13 item 10. The drained 401 response is invisible to capture and is **not** an abort signal — the captureTap's lifecycle is bound to the successful attempt only.
   - `disk-error` — any `fs.appendFile` callback error on the records or manifest file.
   - `queue-overflow` — records queue crossed the high-watermark (default 1024); the dispatcher poisons every currently-open session in the bundle, rejects new `write()` calls until the queue drains below the low-watermark (default 256), and forwarding continues uninterrupted. See §9 step 2 for full semantics. **Sessions are poisoned in whole, never individual records.**
   - `infrastructure-teardown` — synthetic `session-end` from `close()` for any session whose `endSession` was not called by the orchestrator.
   - `unknown` — write to a session that was never started (`beginSession` missing).
8. Append-only. No truncation. A crash mid-write leaves at most one truncated final line in either the trajectory file or the manifest, which downstream consumers discard via standard JSONL trailing-line-tolerant parsing. The session containing the truncated line is inherently poisoned (no `session-end` matching `session-start`) and is filtered downstream by the same poison-filter mechanism.

**Never block the proxy thread**: every operation on the writer's hot path (`write`, `setPersona`) is O(1) synchronous (map lookup, push to queue). Disk I/O is exclusively in the drain loop. Listener errors are swallowed (same contract as `SseExtractorTransform.emitSafe`).

**Memory model**: no per-record cap; records queue defended by the high-watermark tripwire described in §9 step 2 (poison whole sessions on overflow, never truncate records). In practice records are 5–200 KB and the queue stays small; outliers (large extended-thinking responses, big code attachments in tool results) are exactly the data we want to capture in full. The watermark is what reconciles "never silently corrupt training data" with §2 goal #3 ("never block the proxy"): the queue still grows under load, but a runaway is converted into bundle-wide session poisoning before it can OOM the proxy host.

**Gap acknowledged**: the request-handler snapshot at `mitm-proxy.ts:692` only fires when an HTTP request is actually received on the inner TLS server. A CONNECT that completes the TLS handshake but where the agent then aborts without sending an HTTP request (TLS handshake error mid-stream, agent dial-and-abandon, keep-alive idle close) produces no record. For training-data capture this is acceptable: there is no agent-emitted request to capture, and there is no useful labeled exchange.

## 10. Configuration

New field in `~/.ironcurtain/config.json` under a new top-level `capture` section:

```ts
interface CaptureConfig {
  readonly enabled: boolean;                 // default: false
}
```

A single boolean. **No size caps, no queue caps, no truncation knobs.** Partial captures are useless for SFT training data, so the design refuses to offer knobs that would silently produce them. The right knob for memory pressure or disk pressure is to disable capture entirely, not to cap individual records.

Surfaced via `src/config/user-config.ts` (`UserConfig`, `ResolvedUserConfig`) and the interactive `ironcurtain config` editor (`src/config/config-command.ts`).

**Default placement** — like other opt-in features (e.g., `memory.llmBaseUrl`), `capture` is **absent** from `USER_CONFIG_DEFAULTS` (`src/config/user-config.ts:17–49`); the `?? false` in the resolver expression is the authoritative default. The config-file shape, parsed through `userConfigSchema` (`src/config/user-config.ts:234–264`), gains:

```ts
const captureSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .optional();

// inside userConfigSchema = z.object({...})
capture: captureSchema,
```

Matching the existing pattern (cf. `memorySchema` at `user-config.ts:152–159`), all fields are `.optional()` and the whole section is `.optional()` so an absent `capture` key is valid.

When `capture.enabled === false`, the writer is **not constructed** — no field on `MitmProxyOptions.capture`, no taps installed, no allocations. Zero cost.

When the user toggles it from the interactive editor, the change takes effect at the next session start; existing sessions continue with their construction-time setting. (Live-toggle is a downstream nicety; not in v0.)

### CLI override

A boolean CLI flag enables capture for a single invocation regardless of the persistent config setting. Precedence is **CLI flag > config file > default `false`**. Flag name: `--capture-traces` (long form only; no abbreviation, since capture is a heavy operational decision, not a casual toggle).

Surface area:

- `ironcurtain start [--capture-traces] "task"` — single-session standalone Docker.
- `ironcurtain start -w <path> [--capture-traces] "task"` — same, with workspace.
- `ironcurtain workflow start <name> [--capture-traces] "task"` — workflow mode. The orchestrator threads the resolved flag into every session's `MitmProxyOptions.capture` for the run; capture is decided at workflow-run start and applies uniformly to all FSM states.
- `ironcurtain daemon [--capture-traces] [--web-ui]` — daemon mode. The flag is sticky for the daemon's lifetime and becomes the default for every session the daemon launches.
- The daemon's `sessions.create` JSON-RPC method (see `src/web-ui/dispatch/session-dispatch.ts:32` and `:60–63`) accepts an optional `captureTraces: boolean` field in its payload so the web UI / programmatic callers can override per-session. The existing `sessionCreateSchema` (`z.object({ persona: z.string().min(1).optional() })`) gains `captureTraces: z.boolean().optional()`. **The dispatcher does not currently thread arbitrary options into `createStandaloneSession()` (see lines 124–180); wiring `captureTracesOverride` from the new schema field through to the standalone-session factory is new work and must be called out as such on implementation.** Precedence at the daemon is **JSON-RPC field > daemon-process CLI flag > daemon's config-resolved value**.

**No `--no-capture-traces` flag.** Capture is opt-in only and the default is `false`. There is no scenario where a user sets the config to `true` and then needs to disable per-invocation. If that requirement appears later, add the negation flag then.

**Implementation seam.** Each command's argument parser sets `captureTracesOverride: boolean | undefined` on its options object. The session / workflow / daemon factory resolves the effective value:

```ts
const captureEnabled = captureTracesOverride ?? userConfig.capture?.enabled ?? false;
```

This is the single decision point; the writer is constructed only when `captureEnabled === true`, matching the "zero cost when disabled" invariant above.

## 11. Workflow state tagging

The MITM proxy is long-lived across workflow state transitions in shared-container mode (already true — see `setTokenSessionId` and the `currentPersona` mechanism in `tool-call-coordinator.ts`). The orchestrator already hot-swaps the coordinator's `currentPersona` via the control server's `POST /__ironcurtain/policy/load` endpoint (`src/trusted-process/control-server.ts:42`).

We mirror the existing `setTokenSessionId` pattern but use a **separate, capture-dedicated session id** to avoid coupling capture attribution to the token-stream-bus extractor's lifecycle. **Crucially, the orchestrator interacts with capture through a single unified surface** rather than three independent setters that must be called in lockstep.

**Public lifecycle surface (unified)**:

The `DockerInfrastructure` / `PreContainerInfrastructure` bundle (see `src/docker/docker-infrastructure.ts:101–208`) gains exactly two new methods — and these are the **only** capture-lifecycle calls the orchestrator makes:

```ts
interface PreContainerInfrastructure {
  // ... existing fields ...
  /**
   * Begin capture for a session. Atomically:
   *   1. sets the proxy's captureSessionId (via internal MitmProxy.setCaptureSessionId)
   *   2. sets the proxy's capturePersona (via internal MitmProxy.setCapturePersona)
   *   3. opens the per-session trajectory file and appends a `session-start`
   *      manifest entry (via internal writer.beginSession)
   *
   * No-op when capture is disabled (writer is undefined). MUST be called
   * before the agent process is unblocked, so the first exchange the
   * agent emits is already tagged with the right session.
   */
  beginCaptureSession(opts: {
    sessionId: SessionId;
    persona?: string;
    fsmState?: string;
  }): void;

  /**
   * End capture for a session. Drives the dispatcher's two-phase
   * endSession (§9: flip endRequested, drain in-flight reassembly,
   * enqueue `session-end` with counter snapshot). MUST be awaited
   * BEFORE session.close() so the manifest entry is durable even if
   * session.close() throws.
   *
   * No-op when capture is disabled.
   */
  endCaptureSession(sessionId: SessionId): Promise<void>;
}
```

Placement rationale: the bundle already owns `setTokenSessionId` as a thin wrapper (`docker-infrastructure.ts:554–556`) and the dispatcher is bundle-scoped (§7); centralising the public surface on the bundle keeps the orchestrator depending only on `DockerInfrastructure` and never on `MitmProxy` directly. The `MitmProxy.setCaptureSessionId` / `MitmProxy.setCapturePersona` setters and the dispatcher's `beginSession` / `endSession` methods become **internal implementation details** — they're still present on the underlying interfaces (for testing the dispatcher in isolation), but no orchestrator code calls them directly.

**Internal mechanics** (not the orchestrator's concern, documented for implementer):

- Inside `mitm-proxy.ts`, a new closure variable `captureSessionId` lives next to `tokenSessionId` at line 512, with `setCaptureSessionId(...)` flipping it (mirrors lines 1636–1638). The snapshot at the `request` handler entry (`mitm-proxy.ts:692`) reads `captureSessionId`, **not** `tokenSessionId`. Without this split, `tokenSessionId` is overloaded across two consumers (the token-stream-bus extractor at line 836 and the capture dispatcher); a workflow shared-container flip of `setTokenSessionId` for any extractor reason would silently re-attribute in-flight captured exchanges to the wrong session. The two variables happen to point at the same id in current usage, but the decoupling is a contract — future extractor work must not be able to corrupt the capture corpus. **`setTokenSessionId` is explicitly NOT unified into `beginCaptureSession`** — token-stream-bus is a different code path (per resolved §13 item 13) and must stay decoupled.
- `beginCaptureSession` calls (1) `mitmProxy.setCaptureSessionId(sessionId)`, (2) `mitmProxy.setCapturePersona(persona)`, (3) `writer.beginSession({sessionId, fsmState, persona})` — in that fixed order, synchronously, so they cannot diverge.
- `endCaptureSession` calls `writer.endSession(sessionId)` (which handles two-phase drain per §9), then `mitmProxy.setCaptureSessionId(undefined)` and `mitmProxy.setCapturePersona(undefined)` after the drain promise resolves. The unification replaces the previous orchestrator-side ritual of calling three setters atomically.
- **Both `captureSessionId` and `persona` are snapshotted at the inner-HTTPS server's `request` handler entry (`mitm-proxy.ts:692`)** — the earliest point at which IronCurtain sees an incoming exchange. Two locals declared at the top of the handler closure (`sidAtCapture`, `personaAtCapture`) are naturally scope-captured by all downstream call sites (`bufferRequestBody`, upstream-response callbacks, capture writer), so no parameter threading is required. The existing `sidAtAttach` snapshot at line 836 remains untouched — it serves the token-stream-bus extractor (a different code path) and is additive, not replaced.
- **Parallel keep-alive correctness**: each `request` event on the inner server is its own closure invocation, so `sidAtCapture` and `personaAtCapture` are independent per-exchange snapshots even when multiple HTTP/1.1 keep-alive exchanges fan in concurrently on the same TLS socket. A future "efficiency refactor" that hoists either snapshot to a higher closure scope would break per-exchange attribution; the per-handler scoping is load-bearing.
- `bundleId` comes from `MitmProxyOptions` at construction time; `workflowRunId` is added as a new optional field on `MitmProxyOptions`.

**Orchestrator usage** (workflow):

In `orchestrator.ts:executeAgentState`, around `bundle?.setTokenSessionId(agentSessionId)` (line 2002):

```ts
const agentSessionId = session.getInfo().id;
bundle?.setTokenSessionId(agentSessionId);
bundle?.beginCaptureSession({
  sessionId: agentSessionId,
  persona: stateConfig.persona,
  fsmState: stateId,
});
// launch agent ...
```

And in `finally` (lines 2176–2196), replacing `bundle?.setTokenSessionId(undefined)`:

```ts
} finally {
  instance.activeSessions.delete(session);
  const endedSessionId = session.getInfo().id;
  await bundle?.endCaptureSession(endedSessionId).catch((err) => {
    writeStderr(`[workflow] endCaptureSession failed for "${stateId}": ${toErrorMessage(err)}`);
  });
  await session.close().catch(/* existing handler */);
  bundle?.setTokenSessionId(undefined);
  // ... existing cleanup ...
}
```

Note `endCaptureSession` is awaited **before** `session.close()` (per §9 lifecycle hooks) but `setTokenSessionId(undefined)` retains its existing post-close position — it remains a separate concern. **This is an intentional reorder of the current `finally` block**: `orchestrator.ts:2176–2196` today runs `session.close()` first and `setTokenSessionId(undefined)` after, which a reader reviewing this PR will see is being changed. The reorder is required to preserve the §9 invariant that the `session-end` manifest entry is durable even if `session.close()` throws — without `endCaptureSession` running first, a close-time exception would leave the session with no end marker and downstream would silently skip the trajectory file. Not accidental.

**`MitmProxyOptions.sessionId` resolution (was `routingId` seed)**: today `mitm-proxy.ts:162` declares `readonly sessionId?: SessionId` on `MitmProxyOptions`. Its only consumer inside `mitm-proxy.ts` is line 512 — `let tokenSessionId = options.sessionId` — which is the **initial value** of the mutable closure variable. In workflow shared-container mode `docker-infrastructure.ts:412` passes `bundleId as unknown as SessionId` as that initial value, with a comment acknowledging that "the orchestrator overrides this per-agent via `setTokenSessionId()` around each `executeAgentState`, so the bundleId default is only an initial placeholder." Outside that initial-seed usage there is no consumer of `MitmProxyOptions.sessionId`. The field is therefore **routinely stale by design** in workflow mode, and its name is misleading — readers reasonably assume it carries the current session id throughout the proxy's lifetime.

**Resolution: rename `MitmProxyOptions.sessionId` → `MitmProxyOptions.initialTokenSessionId`** with a doc-comment that it may become stale and is replaced by `setTokenSessionId(...)` and (with this design) `setCaptureSessionId(...)` for the live values. The rename touches: the `MitmProxyOptions` type (`mitm-proxy.ts:162`), the assignment at `mitm-proxy.ts:512` (`let tokenSessionId = options.initialTokenSessionId`), the two construction sites in `docker-infrastructure.ts:424` and `:434`, and `claude-code.ts:217` (single-session mode where the field is genuinely the only id). Not removed outright because the seed is still useful in single-session standalone mode, where `bundleId === sessionId` and no `setTokenSessionId` call is required between construction and the first request. `captureSessionId` does **not** get a corresponding initial-seed option: the orchestrator must call `setCaptureSessionId(...)` before the agent emits its first exchange, and in single-session mode `docker-agent-session.ts` calls it explicitly at session start.

**Single-session** (non-workflow): `beginSession` is called once at session start with `persona: undefined`; `endSession` at session close. The manifest contains a single session-start / session-end pair. The capture writer functions identically — same code path as workflow.

**Manifest as canonical FSM mapping**: the `fsmState` and `persona` fields on each `session-start` entry are the only place the workflow-state → session mapping is preserved at write time. Workflow checkpoints (`checkpoint.json`) technically carry the same information, but parsing them just to recover trace ordering is brittle. The manifest is a purpose-built sidecar — small, append-only, JSONL — and is the source of truth downstream tooling reads.

## 12. Testing strategy

Unit tests (vitest, fast, no Docker):

1. **Byte-equality streaming-vs-non-streaming** (`trajectory-streaming-fidelity.test.ts`) — described in §6. Parametric over fixtures: `text-only`, `text+single_tool_use`, `text+parallel_tool_use`, `thinking+text+tool_use`, `redacted_thinking`, `multi-text-delta with Unicode/escapes/numbers like 1.50`, `OpenAI text+tool_calls`, and `message_delta-after-content_block_stop` (the Anthropic SDK occasionally emits the `usage`-bearing `message_delta` event *after* the final `content_block_stop` rather than before — the reassembler must accept this ordering without dropping the usage field). For each, the test asserts `assembled === reference` at the byte level. **This is the primary correctness gate.**

2. **Real-key leakage regression** — described in §8. Two tests at different scopes:
   - **(a) Writer-input unit test** (`trajectory-credential-leakage.unit.test.ts`) — runs on every PR. Drives `(headers, rawBody)` tuples directly through the dispatcher's redaction filter; no proxy, no Docker, no `socketMetadata` dependency from `mitm-proxy.ts:695–698`. This is the credential-leakage CI gate.
   - **(b) End-to-end variant** — covered by test #7 below. Exercises the redaction boundary at wire level but runs only nightly / pre-release because it requires a stub HTTPS upstream and full MITM CA + CONNECT setup.

3. **Schema validation** (`trajectory-schema.test.ts`) — Zod schema for `ExchangeRecord`; every record produced by the writer parses cleanly. Negative cases: malformed events should produce a valid record with `capture.reassemblyOk: false`. Includes a positive case where `request.bodyBase64` is populated (compressed/non-UTF-8 body) and `request.bodyUtf8` is empty — schema must accept exactly-one-of populated, never both, never neither.

4. **Session poisoning on failure** (`trajectory-poison.test.ts`) — three sub-cases asserting that partial captures never silently corrupt the corpus:
   - **(a) Disk error**: stub `fs.appendFile` to fail with `ENOSPC` on the Nth record; assert subsequent `write()` calls for the affected session no-op, the `session-end` manifest entry carries `poisoned: true` and `poisonReason: 'disk-error'`, the on-disk JSONL contains exactly N-1 records (the failed write was not emitted), and `exchanges` matches that count.
   - **(b) Reassembly failure**: feed a malformed SSE stream (mid-stream truncation, orphan `content_block_stop`) and assert the in-progress record is **not** written, the session is marked poisoned with `poisonReason: 'reassembly-failure'`, and the `session-end` carries the flag.
   - **(c) Counter consistency under load**: write 10,000 records back-to-back, then call `endSession`. Assert the on-disk JSONL line count equals `session-end.exchanges` exactly (per §9.6's write-time counter invariant). No drop-counter to test — the unbounded queue means records are never lost mid-session.

5. **Append-only and line-atomic** (`trajectory-file.test.ts`) — write N records, simulate a crash by destroying the writer mid-drain, reopen and append more. Reading the file yields exactly the records that completed their `appendFile` callback, plus at most one truncated trailing line that fails JSON parse — downstream is expected to skip such lines.

6. **Reassembler error fallback** (`trajectory-reassembler-fallback.test.ts`) — feed malformed SSE event sequences (orphan `content_block_stop`, unknown delta type, premature `[DONE]`); assert `capture.reassemblyOk = false` with `streamRaw.events` populated.

7. **Infrastructure-teardown safety net** (`trajectory-teardown.test.ts`) — `beginSession`, write a handful of records, then call `close()` directly without `endSession`. Assert: (a) a synthetic `session-end` entry appears in the manifest with `closedReason: 'infrastructure-teardown'`; (b) the entry's `exchanges` count matches the on-disk JSONL line count; (c) repeating with two open sessions emits exactly two synthetic end-markers. Covers the Ctrl-C / abort / crash path described in §9.

8. **Capture-session-id decoupling** (`trajectory-session-id-decoupling.test.ts`) — set `tokenSessionId = A`, `captureSessionId = B`, write a synthesized exchange. Assert the captured record carries `sessionId = B`. Then flip `tokenSessionId = C` mid-exchange (between request snapshot and response capture) and assert the record still carries `B`. Defends against future refactors that re-merge the two ids.

Integration test (slower, opt-in):

9. **End-to-end via a stub upstream** (`trajectory-e2e.test.ts`) — full MITM proxy in TCP mode, a `https.Server` standing in for `api.anthropic.com` returning recorded SSE, a Node `https` client standing in for the agent. Drives the exchange end-to-end and asserts a JSONL line appears in the configured captures directory with the expected `sessionId`, `persona`, byte-equal `request.bodyUtf8`, and reassembled `response.bodyUtf8`. Uses the existing `dnsLookup` test hook from `MitmProxyOptions`. Also covers credential leakage at wire level (real-key in the upstream connection, fake-key in the captured headers). Runs nightly or pre-release, **not** every PR — the per-PR credential-leakage gate is test #2(a).

CI hooks:

- The `JSON.stringify` lint rule scoped to `src/docker/trajectory-reassembler.ts`.
- The writer-input credential-leakage unit test (#2(a)) runs in every PR — this is the binding gate against accidental real-key leakage. The end-to-end test (#9) runs nightly.

## 13. Open questions

1. **Per-record vs per-block streaming write?** Current design buffers the entire response in memory before serializing the record. For very long streams (>30 s, >100 KB output) this delays the write. Alternative: write a `header` line at exchange start and append `event` lines, then a `footer` line at exchange end. This complicates downstream parsing. **Default: per-exchange, single line.** Revisit if memory or latency become issues.

2. **OpenAI parallel tool calls index gaps.** The OpenAI SDK occasionally emits `tool_calls[].index` that skips values (e.g., 0, 2 with no 1). Reassembly currently sorts by `index` and emits the present entries. Need to confirm against recorded traces whether the wire actually contains such gaps or whether they're an SDK artifact. If the wire is gap-free, we should validate.

3. **Anthropic prompt caching headers.** `cache_control` breakpoints are part of the request body and are captured naturally. `cache_creation_input_tokens` / `cache_read_input_tokens` appear in `message_delta.usage` — captured via the `usageRaw` substring. Confirm they survive reassembly unchanged.

4. **Should we capture the `requestRewriter`'s effect for diagnostic purposes?** The rewriter strips a tool (`schedule`) when `agentKind === 'workflow'`. Capturing only the pre-rewrite body means the corpus shows tools the model never actually saw. Decision: **capture pre-rewrite (agent-emitted) bytes** — that's the agent's intent. A downstream `agentKind`-conditional replay can apply the same rewriter to reconstruct what the model received. Document this in the corpus schema notes.

5. **Persona / session attribution race during state transitions** *(resolved — see §11).* Snapshot both `captureSessionId` and `persona` at the inner-HTTPS server's `request` handler entry (`mitm-proxy.ts:692`), not at response start. The handler closure scopes the snapshot across all downstream byte handling, so any later orchestrator flip cannot reattribute an in-flight exchange. Even though orchestrated workflows don't intentionally flip mid-exchange, this defends against subtle races (HTTP keep-alive across exchanges, abort-retry, concurrent CONNECT tunnels still draining) and makes every received byte tagged from the first instant.

6. **Poisoned-session visibility to the user.** `ironcurtain workflow inspect` should surface the count of poisoned sessions and their `poisonReason` distribution from the manifest. Likely via a small JSON sidecar `captures/stats.json` written by the dispatcher's `close()` aggregating the manifest. A poisoned session is visible operational information — silent poisoning is worse than silent drops were.

7. **OpenAI `usage` field is in the final chunk with `stream_options: { include_usage: true }`.** Without that option, usage is absent. Should the request rewriter inject `include_usage: true` for captured runs? That would mutate the agent's request — undesirable. Accept the absent-usage case and let downstream tooling deal with it.

8. **Writer scope: per-session file + manifest** *(resolved — see §7, §9, §11).* Per-session `{sessionId}.jsonl` files plus a single append-only `manifest.jsonl` per captures directory. One dispatcher instance per bundle (workflow) or per session (standalone) maintains `Map<SessionId, FileHandle>`, opens on `beginSession`, closes on `endSession`, and writes manifest entries on both boundaries. Manifest is the canonical ordering / FSM-state-mapping record. Standalone and workflow share the same code path.

9. **Streaming-capture vs forced buffering** *(resolved — see §3).* Capture must not change forwarding semantics. The earlier "force buffering when capture is on" formulation would have 413'd request bodies > `MAX_REWRITE_BODY_BYTES` (10 MB) that today stream through unmodified — breaking long-prompt-with-embedded-files / cache_control / multi-turn uploads. Resolution: tee a `PassThrough` between `clientReq` and `upstreamReq` for the streaming path; the buffered-rewrite path still captures from the same `rawBody` it already produces. The tee accumulates the full body with **no per-record cap** — partial captures are useless for SFT (see item 17), so we capture the whole thing or poison the session. The forwarded request continues unaffected in all cases.

10. **401 OAuth refresh-retry record shape** *(resolved — see §5, §4).* The proxy retries 401s once via `retryWithRefreshedToken` (mitm-proxy.ts:1778), and the first attempt's response is drained-not-forwarded. Two records under a shared `exchangeId` would over-represent rare refresh events in token-weighted statistics and force every downstream consumer to dedup; an unpaired first-attempt record would carry a 401-error-envelope `usage` mismatched against the request's token count. Resolution: one record per agent-observable exchange, with `capture.retried: true` flagged on the record whose response came from the successful retry. The drained 401 response is not captured.

11. **Manifest entries on a shared ring buffer** *(resolved — see §9; superseded by items 17 and 18).* A shared records-and-manifest ring buffer's drop-oldest policy can drop a `session-end` (orphan file) or drop records while the `session-end` survives (counter mismatch). Initial resolution: two queues — drop-oldest for records, unbounded for manifest. **Final resolution under item 17 (binary session model)**: the records queue uses the high-watermark tripwire (poison whole sessions on overflow, never drop individual records); the manifest queue stays unbounded (its worst case is tiny). Counters on `session-end` are still incremented at write-time inside the `fs.appendFile` callback, so the line count and the `exchanges: N` field agree by construction. The `endSession` ordering invariant ("`session-end` for session S appears after every record for S already enqueued at the moment of the flip") is upheld by the two-phase `endCaptureSession` semantics described in §9 — Phase A flips `endRequested`, Phase B awaits both queue-cursor advancement and in-flight reassembly Promises before enqueuing the manifest end-marker.

12. **Crash / abort safety net for `session-end`** *(resolved — see §9).* The `finally` in `executeAgentState` (orchestrator.ts:2186) only sync-cancels `setTokenSessionId(undefined)`; crashes / Ctrl-C / `destroyDockerInfrastructure` from an abort path bypass it. Resolution: (a) `endSession` is awaited in `finally` **before** `session.close()`; (b) `destroyDockerInfrastructure` and `destroyWorkflowInfrastructure` call `await writer.close()` after `mitmProxy.stop()`, which emits synthetic `session-end` entries with `closedReason: 'infrastructure-teardown'` for any still-open sessions.

13. **Dispatcher session id decoupled from token-stream-bus id** *(resolved — see §11; further consolidated by item 18).* `tokenSessionId` is overloaded (token-stream-bus extractor + new capture dispatcher); a future extractor-related flip would silently misattribute capture records. Resolution: separate `captureSessionId` closure variable, separate `setCaptureSessionId(...)` setter (internal), snapshot at `mitm-proxy.ts:692` reads `captureSessionId` (not `tokenSessionId`). The orchestrator never calls `setCaptureSessionId` directly — it calls `bundle.beginCaptureSession({sessionId, ...})` which sets all three capture-related fields atomically (see item 18). `setTokenSessionId` remains a separate orchestrator-facing call; it is **not** unified with capture because token-stream-bus is a different code path and the two must stay decoupled.

14. **`MitmProxyOptions.sessionId` semantics** *(resolved — see §11).* The field is routinely stale in workflow shared-container mode — its only consumer is `let tokenSessionId = options.sessionId` (mitm-proxy.ts:512) as an initial seed, and the orchestrator immediately overrides it via `setTokenSessionId`. The name is misleading. Resolution: rename to `MitmProxyOptions.initialTokenSessionId` with a doc-comment that it may become stale and is replaced by `setTokenSessionId(...)` / `setCaptureSessionId(...)` for the live values. Not removed outright because single-session standalone mode legitimately uses the seed (no `setTokenSessionId` flip between construction and first request).

15. **Credential-leakage test cannot require Docker** *(resolved — see §8, §12).* The MITM proxy requires CA + CONNECT + `socketMetadata` (mitm-proxy.ts:695–698), so an in-process credential leakage test that drives the full proxy is heavyweight and cannot reasonably run in PR CI. Resolution: two-tier testing. The writer-input unit test (#2(a) in §12) drives `(headers, rawBody)` tuples through the dispatcher's redaction layer with no proxy involvement — fast, runs every PR, is the credential-leakage CI gate. The end-to-end test (#9) stays opt-in and runs nightly / pre-release.

16. **`bodyUtf8` honesty for compressed bytes** *(resolved — see §4, §6).* The original schema stored compressed bytes lossily as UTF-8. The field name is misleading and the data is silently corrupted. Resolution: add an optional `bodyBase64` companion to both `request` and `response`; exactly one of `(bodyUtf8, bodyBase64)` is populated per record. Compressed responses populate `bodyBase64`; uncompressed UTF-8 responses populate `bodyUtf8`.

19. **Compressed-SSE byte-fidelity gap** *(resolved — see §3, §6 invariant 6).* Initial draft of invariant 6 said compressed responses populate `bodyBase64` verbatim, on the assumption that Anthropic / OpenAI don't gzip in practice. Wrong — Anthropic serves `/v1/messages` SSE with `content-encoding: gzip` by default, and the assumption made ~every `/v1/messages` record a useless base64 blob. Resolution: tee the upstream response into a forwarding branch (raw → client) and a capture branch (raw → `zlib` decompressor → captureTap → reassembler). The reassembler operates on decompressed bytes; `bodyUtf8` holds the reassembled SSE message as the SDK observed it. The `content-encoding` header is preserved on the record as metadata. Decompression failures and unsupported encodings (zstd) poison the session.

17. **Binary session model: no partial captures** *(resolved — see §3, §4, §7, §9, §10).* For SFT training data, a partial trace is poisoned data — token boundaries shift, tool_use IDs dangle, the assistant message ends mid-content-block. Silently truncating individual records produces a corpus that looks trainable but isn't, and the drop-counter / `truncatedRequestBody` / `truncatedResponseBody` machinery in earlier drafts honestly marked the damage but didn't undo it. Resolution: every session is binary at the session level — either complete-and-usable, or marked `poisoned: true` with a `poisonReason` on the `session-end` manifest entry and discarded wholesale by downstream tooling. Removed: all byte caps (`maxRequestBodyBytes`, `maxResponseBodyBytes`), the stream-event cap (`maxStreamEvents`), the per-file cap (`maxFileBytes`), the bounded ring buffer with drop-oldest. Added: `poisoned` / `poisonReason` fields on `session-end`, session-poison on disk error / reassembly failure / mid-stream abort / queue overflow / infrastructure teardown. The records queue is conceptually unbounded but defended by a high-watermark tripwire (default 1024 records, low-watermark 256) that poisons whole sessions on overflow rather than dropping individual records — this reconciles "never silently corrupt training data" with §2 goal #3 ("never block the proxy"). `CaptureConfig` collapses to a single `enabled: boolean`.

18. **Unified capture-lifecycle surface on the bundle** *(resolved — see §11).* Earlier drafts had the orchestrator perform a three-call ritual on every state transition: `bundle.setCaptureSessionId(sid)`, `bundle.setCapturePersona(persona)`, `writer.beginSession({sessionId, fsmState, persona})` — atomically, in fixed order, before unblocking the agent. Three names, three call sites, three opportunities for future refactors to drop one. This is exactly the complexity the binary-session model is supposed to eliminate. Resolution: a single `bundle.beginCaptureSession({sessionId, persona, fsmState})` method on `DockerInfrastructure` performs all three operations internally, in fixed order, so they cannot diverge. The symmetric `bundle.endCaptureSession(sessionId): Promise<void>` replaces both the old `setCaptureSessionId(undefined)` semantics and the dispatcher's `endSession(sid)`, and drives the two-phase drain (see §9). The internal setters (`MitmProxy.setCaptureSessionId`, `MitmProxy.setCapturePersona`, `TrajectoryCaptureWriter.beginSession` / `endSession`) remain present on the underlying interfaces for unit-testing isolation, but the public lifecycle surface — what the orchestrator and standalone session call — is exactly the two bundle methods. `setTokenSessionId` is **NOT** unified into this surface: it's a different code path (token-stream-bus extractor, per resolved item 13) and must stay decoupled. Bundle placement (vs putting the methods on `MitmProxy` itself) follows the existing `setTokenSessionId` thin-wrapper pattern at `docker-infrastructure.ts:554–556` — the orchestrator already holds a bundle handle and never imports `MitmProxy` directly.

20. **Capture-endpoint allowlist (housekeeping noise)** *(resolved — see §3 integration point 4).* The first working capture runs revealed that `api.anthropic.com` carries far more than completions: MCP-registry catalog pagination, `event_logging/v2/batch` telemetry, `claude_code/{settings,policy_limits}` lookups, and `eval/sdk-*` pings — empirically ~two-thirds of captured bytes, with zero model-emitted content, and the `event_logging` batches risk leaking agent action telemetry back into the corpus. Resolution: gate `beginCaptureExchange(...)` (around `mitm-proxy.ts:801`) on a new `isCapturableEndpoint(provider.config, method, path)` predicate backed by a per-provider `captureEndpoints` allowlist on `ProviderConfig` (completion paths only: Anthropic `/v1/messages`, OpenAI `/v1/chat/completions`, Google `*/generateContent` + `*/streamGenerateContent`). Default `[]` (capture nothing) for unlisted providers. Allowlist not deny-list — housekeeping paths churn per release while completion endpoints are small and stable, so the allowlist fails safe. Strictly subtractive: a false result leaves `captureHandle` undefined, already a no-op across the forwarding / key-swap / 401-retry paths; the agent's response is unaffected.

21. **Manifest `fsmState` / `persona` not persisted** *(resolved — implementation defect, no design change).* First workflow capture runs produced `session-start` manifest entries carrying only `seq` / `sessionId` / `ts`, dropping the `fsmState` and `persona` fields that §7's manifest schema and §11's `writer.beginSession({sessionId, fsmState, persona})` contract both require. Per-record `persona` tagging worked, so the data was recoverable, but the manifest was not the canonical FSM mapping §11 promises. The design was already correct; the dispatcher's `session-start` serializer simply omitted the two fields. Fix is to thread them through `beginSession` into the emitted entry.
