# Docker Agent Mode: provider / MITM / adapter seams

For any feature that changes how Docker agents reach LLM providers (routing, key handling, body rewrite, new provider). Verified 2026-07-03 while designing OpenRouter integration (`docs/designs/openrouter-integration.md`).

## The request chokepoint (single enforcement point)
`src/docker/mitm-proxy.ts` inner request handler, per request, in order:
1. CONNECT host allowlist — `providersByHost.get(host)`; unknown → 403 (~mitm-proxy.ts:1482).
2. Endpoint allowlist — `isEndpointAllowed()` method+path vs `ProviderConfig.allowedEndpoints`; 403 (~884).
3. Fake→real key swap — `validateAndSwapApiKey()` (`header` name OR `bearer`) (~2143-2172).
4. Body rewrite (optional) — `shouldRewriteBody()` gate; `requestRewriter(body, {method,path,agentKind})`; returned `modified` re-serialized. **Rewriter CAN add fields, not just strip** — returns `{modified, stripped}|null` (call site ~1259).
5. Upstream override (optional) — `provider.config.upstreamTarget {hostname,port,pathPrefix,useTls}`; rewrites Host header + prepends pathPrefix; does NOT convert auth scheme (~896-906,944-954). Populated by `applyUpstreamOverrides()` in docker-infrastructure.ts:1923 from `ANTHROPIC_BASE_URL`/config.
6. SSE taps — `resolveSseProvider(host)` (mitm-proxy.ts:340) classifies 'anthropic'|'openai'|'unknown' for token-stream + trajectory capture. **Host-only today** — one host serving multiple wire formats needs path-awareness added.

Rewriter context is `{method,path,agentKind}` — **NO session id**. `tokenSessionId` (mutable per-agent, `setTokenSessionId`) is the stable conversation id snapshotted per-request (~1002,1243) but is NOT passed to the rewriter. Threading it in is a one-field contract change (`RequestBodyRewriter` in provider-config.ts).

## Provider registry
`src/docker/provider-config.ts`: `ProviderConfig` = {host, displayName, allowedEndpoints, captureEndpoints?, keyInjection: {type:'header',headerName}|{type:'bearer'}, fakeKeyPrefix, requestRewriter?, rewriteEndpoints?, upstreamTarget?}. Built-ins: anthropic(+OAuth), openai, codexChatGpt(+auth), google, claudePlatform. `anthropicRequestRewriter` is the reference multi-strip rewriter.

## Adapters (`src/docker/adapters/*.ts`, iface agent-adapter.ts)
- `getProviders(authKind)` → which ProviderConfigs to allowlist.
- `buildEnv(config, fakeKeys: Map<host,fakeKey>)` → container env; real keys NEVER enter container.
- `buildCommand(msg, sysPrompt, {sessionId,firstTurn,modelOverride})` → CLI argv incl. `--model`.
- claude-code: `--model`/`IRONCURTAIN_MODEL`; env `NODE_EXTRA_CA_CERTS`; OAuth via `CLAUDE_CODE_OAUTH_TOKEN` else `IRONCURTAIN_API_KEY`.
- goose: env `GOOSE_PROVIDER`/`GOOSE_MODEL` read at container start (can't switch model per-turn); `getProviderConfig(gooseProvider)` switch (anthropic|openai|google).
- codex: writes `codex-config.toml`; Responses-only (`wire_api="chat"` dead); `getProviders` returns codexChatGpt+auth.
Registered in `agent-registry.ts` `registerBuiltinAdapters()`.

## Real-key resolution
`resolveRealKey(host, config, oauthAccessToken)` docker-infrastructure.ts:1447 — host→`config.userConfig.<x>ApiKey`; OAuth hosts return the token. Bundle build at ~531-556 does providers→fakeKeys→realKeys→ProviderKeyMapping[]→createMitmProxy.

## Cost (Docker mode)
Per-turn cost = adapter's self-reported `AgentResponse.costUsd` (docker-agent-session.ts:307-310), from Claude Code `total_cost_usd`. **WRONG when routing to a different backend** (bills at requested model). Static estimator `MODEL_PRICING` (resource-budget-tracker.ts:78, first-substring-match) is the other cost source. Authoritative per-response cost (e.g. OpenRouter `usage.cost`) is available at the MITM response tap but not currently surfaced to the session.

## Test harness (token-free macro tests)
`test/mitm-proxy.test.ts`: `sendConnect()` (CONNECT via UDS), `makeHttpsRequest()` (TLS over CONNECT'd socket), `startCapturingUpstream()` / `makeLocalRewriteProvider(port)` (real MitmProxy + local HTTP upstream via `upstreamTarget useTls:false`, echoes/captures body). This is THE pattern for proving key-swap + body-rewrite + upstream-forward end-to-end without a real provider. `localhostDnsLookup` resolves all hosts→127.0.0.1.

## Config
`src/config/user-config.ts`: Zod `userConfigSchema` (all optional) → `resolveUserConfig` → `ResolvedUserConfig` (all present). Env precedence in ~816-821. Nested sections use `z.object({...}).optional()` (see webSearch/signal/memory). `SENSITIVE_FIELDS` (:433) = never back-filled to disk. CLI editor `config-command.ts` (@clack), `computeDiff` topLevelKeys+nestedSections lists must be extended for new fields.

## Model-catalog autocomplete (design docs/designs/... scratchpad; not yet impl)
- `@clack/prompts@1.6.0` DOES export `autocomplete<Value>(opts)`/`autocompleteMultiselect` (returns `Value|symbol`; **selection-from-options only** — no free-text submit per the type surface, so "clear"/legacy-slug needs a sentinel `{value:'',...}` / injected option). `Option` = `{value,label?,hint?}`; opts have `initialUserInput`,`maxItems`,`validate`,`filter`.
- OpenRouter models catalog: PUBLIC `GET ${OPENROUTER_API_V1}/models` (no key), slug = `.data[].id`. `OPENROUTER_API_V1='https://openrouter.ai/api/v1'`, `DEFAULT_GLM_SLUG='z-ai/glm-5.2'` (user-config.ts:277,279).
- Shared catalog module belongs in `src/config/` (leaf; CLI editor `config-command.ts` is same-dir, `web-ui/dispatch/config-dispatch.ts` already imports `../../config/user-config.js`). Browser CANNOT import `src/config/` (separate npm workspace) → must go via RPC. Node global `fetch`, no new dep.
- New RPC pattern: add to `MethodName` (web-ui-types.ts:30), routed by `method.startsWith('config.')` in json-rpc-dispatch.ts:42 → `configDispatch` switch; DTO in web-ui-types.ts + mirror `packages/web-ui/src/lib/types.ts`; store action in `stores.svelte.ts`; mock case in `packages/web-ui/scripts/mock-ws-server.ts` `handleMethod` (mock = e2e source of truth); web-ui `features/` combobox gets data via PROPS (features MUST NOT import stores). Settings testids: `map-model-N`,`map-match-N`,`peragent-<agent>`.
- Hard-block-vs-fallback resolved by keying enforcement on catalog `source` (`live`/`cache`=block, `bundled`=warn); validate CLIENT-SIDE in both frontends (settings-helpers.ts pure `validateSlugs`; CLI at autocomplete confirm), NOT server-side (`setModelProviders` persists anything — trusted host, avoids browser/daemon source skew).

## Web UI config mutation precedent
No config read/write WS methods exist. `personas.*` is the gated-mutation precedent: `MethodName` union (web-ui-types.ts:30), prefix-routed in `json-rpc-dispatch.ts`, dispatch module `dispatch/persona-dispatch.ts`, gate `requirePolicyMutation(ctx)` → `ctx.allowPolicyMutation` else `POLICY_MUTATION_FORBIDDEN` (surfaced in `DaemonStatusDto.allowPolicyMutation`), emits `*.changed`. Mock server `packages/web-ui/scripts/mock-ws-server.ts` `handleMethod` switch + `broadcast()`.
