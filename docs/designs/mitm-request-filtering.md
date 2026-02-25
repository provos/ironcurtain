# Strip Server-Side Tools from API Requests

## Context

The MITM proxy intercepts HTTPS traffic but only inspects HTTP method+path and swaps API keys. It does not inspect request bodies. Claude Code sends `POST /v1/messages` requests with a `tools` array that can include **server-side tools** (e.g., `web_search_20250305`) that execute on Anthropic's infrastructure. These bypass both network isolation and the MCP policy engine — the agent fetched live news stories with zero MCP tool calls recorded.

**Goal**: Buffer and inspect `POST /v1/messages` request bodies, strip server-side tools from the `tools` array before forwarding upstream.

## How Server-Side Tools Are Identified

In the Anthropic Messages API, the `tools` array contains two kinds of entries:
- **Custom tools** (MCP-bridged, should pass): `{ "name": "read_file", "input_schema": {...} }` — no `type` field, or `type: "custom"`
- **Server-side tools** (should be stripped): `{ "type": "web_search_20250305" }`, `{ "type": "computer_20250124", ... }` — have a `type` field that is not `"custom"`

## Changes

### 1. `src/docker/provider-config.ts` — Add rewriter types and Anthropic filter

- Add `RequestBodyRewriter` type: `(body, {method, path}) => {modified, stripped[]} | null`
- Add optional `requestRewriter` and `rewriteEndpoints` fields to `ProviderConfig`
- Add `stripServerSideTools()` function — filters `tools` array, removes entries with a `type` field that isn't `"custom"`, returns null if nothing stripped
- Add `shouldRewriteBody(config, method, path)` predicate — returns true only for POST requests to paths listed in `rewriteEndpoints` when `requestRewriter` is set
- Update `anthropicProvider`: set `requestRewriter: stripServerSideTools` and `rewriteEndpoints: ['/v1/messages']`

### 2. `src/docker/mitm-proxy.ts` — Conditional body buffering

The inner server handler currently does `clientReq.pipe(upstreamReq)` unconditionally.

- Add module-level `bufferRequestBody(req, maxBytes): Promise<Buffer>` — collects chunks, rejects if >10MB
- Extract current forwarding logic into `forwardRequestDirect()` (nested in `createMitmProxy` for closure access to `activeUpstreamRequests`)
- Add `handleRewrittenRequest()` (also nested) — buffers body, parses JSON, calls `provider.config.requestRewriter()`, updates `content-length`, writes modified body via `upstreamReq.end(finalBody)`
- Modify inner server handler: after key swap, call `shouldRewriteBody()` to branch between pipe and rewrite paths
- Log stripped tools: `[mitm-proxy] POST api.anthropic.com/v1/messages — stripped server-side tools: web_search_20250305`
- On parse failure: log warning, forward original body as-is (fail-open for compatibility)

### 3. `test/mitm-proxy.test.ts` — Tests

- `describe('stripServerSideTools')`: no tools field → null, empty tools → null, all custom → null, mixed → strips server-side only, all server-side → empty array, preserves non-tools fields
- `describe('shouldRewriteBody')`: no rewriter → false, GET → false, non-rewrite path → false, POST /v1/messages with Anthropic → true

## Edge Cases

| Scenario | Behavior |
|---|---|
| Malformed JSON body | Forward as-is, log warning |
| No `tools` field | Rewriter returns null, forward unchanged |
| All tools are custom | Rewriter returns null, forward unchanged |
| All tools are server-side | `tools` becomes `[]`, forwarded |
| Body > 10MB | 413 response, no upstream request |
| Provider has no `requestRewriter` | Zero-copy `pipe()` path (no buffering) |

## Files

| File | Change |
|---|---|
| `src/docker/provider-config.ts` | Add types, `stripServerSideTools`, `shouldRewriteBody`, update `anthropicProvider` |
| `src/docker/mitm-proxy.ts` | Add `bufferRequestBody`, extract `forwardRequestDirect`, add `handleRewrittenRequest`, branch in handler |
| `test/mitm-proxy.test.ts` | Unit tests for stripping logic and predicate |

## Verification

1. `npm test` — all tests pass
2. `npm run lint && npm run format:check`
3. `npm run build`
4. Manual: `npm start`, ask agent to search the web — should get no results (web_search stripped), session log should show "stripped server-side tools"
