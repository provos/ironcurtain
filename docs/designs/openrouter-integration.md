# First-Class OpenRouter Support (Named Provider Profiles)

**Status:** Design v3 — rescoped to provider profiles + per-session selection (v2 technical content preserved verbatim)
**Date:** 2026-07-03
**Supersedes (partially):** [`MODEL_ROUTING.md`](../../MODEL_ROUTING.md) LiteLLM recipe for the OpenRouter case (the generic base-URL mechanism stays; OpenRouter gets a dedicated, no-external-proxy path).

> **v3 rescope (read first).** v2 shipped a single global `openrouter` config section with an `enabled` toggle. v3 replaces that with a **named provider-profile registry** (`modelProviders.profiles`) plus **per-session profile selection** at the mux `/new` picker and via `ironcurtain start --provider-profile <name>`. This is a **config-shape + selection-surface** change: the MITM design, rewriter semantics (D1–D8), auth interlocks (B2a–d), Codex TOML layout, trajectory/token-stream seams, appendix fixtures, and gate rigor are all **unchanged** — they are simply re-sourced from *the session's active profile* instead of `config.openrouter`. There is **no migration**: the v2 `openrouter` shape was never released (this spec is pre-implementation), so v3 defines the schema from scratch.
>
> **One-line mental model:** a profile is a *model preset*. `native` (implicit, always present) is today's canonical Anthropic/OpenAI/ChatGPT behavior; an `openrouter`-type profile routes an agent through OpenRouter with a bound model map + key. The `/new` picker presents profiles as presets (`glm-5.2 → z-ai/glm-5.2 (OpenRouter)`).

---

## 1. Motivation

Today, routing IronCurtain's Docker agents (Claude Code, Codex, Goose) to a non-Anthropic model requires standing up an external LiteLLM proxy, hand-writing a `config.yaml`, and losing prompt caching / Anthropic-native features silently (see `MODEL_ROUTING.md` "Gotchas"). This is fragile and burns money: GLM-5.2 driven by Claude Code without prompt caching pays full input price on every turn.

OpenRouter now exposes an **Anthropic-native `/v1/messages` endpoint** ("Anthropic skin") plus an OpenAI-compatible chat endpoint and a beta Responses endpoint — one host, one key, hundreds of models, `cache_control` passthrough, and implicit GLM prompt caching via session affinity. This lets IronCurtain route any agent to any OpenRouter model with **no external proxy**, glob-based model mapping, per-agent model choice, and preserved prompt caching — all configurable from `ironcurtain config` and the web UI.

## 2. Goals / Non-goals

**Goals**

- **G-a** Selecting a **provider profile** routes Claude Code / Codex / Goose through that profile's backend (OpenRouter for `type: 'openrouter'`; native providers for `type: 'native'`) (R1).
- **G-b** Glob model mapping: `*sonnet*` / `*opus*` → `z-ai/glm-5.2` (R2), scoped **per profile**.
- **G-c** Per-agent default model override (R3), scoped per profile.
- **G-d** Configurable from `ironcurtain config` AND the web UI (R4) — CRUD over named profiles + a default selector.
- **G-e** Prompt caching preserved for GLM-through-Claude-Code (R6) and verifiable by a test oracle.
- **G-f** Macro functional tests + docker integration tests that spend **zero** provider tokens, plus one opt-in live cache-hit test (R5).
- **G-g** Fake-sentinel-key discipline across the container boundary is preserved for the OpenRouter host.
- **G-h** Self-contained, gated spec enabling autonomous (re-)implementation (R7).
- **G-i** **Per-session profile selection** at the mux `/new` picker and via `ironcurtain start --provider-profile <name>`, resolving once at session/bundle creation. A global default (`modelProviders.default`) applies when no per-session choice is made (R8).

**Non-goals**

- Routing Code Mode (builtin agent) through OpenRouter. Code Mode already supports base-URL override via the AI SDK; OpenRouter's OpenAI-compatible endpoint works there today with `openaiBaseUrl`. This spec is Docker-Agent-Mode only.
- Multi-key / cost-optimization routing, per-model provider fallback chains beyond the single `provider` preference passthrough.
- Encryption-at-rest for the OpenRouter key beyond the existing `0600` config perms (trusted host).
- Streaming-shape translation. We rely on OpenRouter's per-agent-native endpoint (skin / chat / responses); IronCurtain never transcodes wire formats.

## 3. Background — current architecture (1 page)

Docker Agent Mode runs an external CLI in a `--network=none` (Linux) / `--internal` (macOS) container. The container's LLM client talks TLS to the provider's **canonical host** (`api.anthropic.com`, `api.openai.com`, `chatgpt.com`, …). A host-side **MITM proxy** (`src/docker/mitm-proxy.ts`) terminates that TLS, and per request:

1. **CONNECT allowlist** — only hosts in the provider registry (`src/docker/provider-config.ts`) may be reached; unknown hosts get 403 (`mitm-proxy.ts:1482-1489`).
2. **Endpoint allowlist** — `isEndpointAllowed()` matches method+path against the provider's `allowedEndpoints`; non-matches get 403 (`mitm-proxy.ts:884-890`).
3. **Fake-key swap** — `validateAndSwapApiKey()` replaces the sentinel key (header `x-api-key` or `Authorization: Bearer`) with the real host-side key (`mitm-proxy.ts:2143-2172`). Real credentials never enter the container.
4. **Body rewrite (optional)** — when `shouldRewriteBody()` is true, the JSON body is buffered, parsed, passed to `provider.config.requestRewriter(body, {method, path, agentKind})`, and the returned `modified` object is re-serialized upstream (`mitm-proxy.ts:1253-1269`). The rewriter may **add or remove** fields (currently only strips tools).
5. **Upstream override (optional)** — when `provider.config.upstreamTarget` is set, the request is forwarded to `{hostname,port,pathPrefix,useTls}` instead of the canonical host, with the `Host` header rewritten and `pathPrefix` prepended (`mitm-proxy.ts:896-906,944-954`). Populated today from `ANTHROPIC_BASE_URL` etc. via `applyUpstreamOverrides()` (`docker-infrastructure.ts:1923-1951`).
6. **SSE passthrough + taps** — the raw upstream bytes stream to the agent unchanged; `resolveSseProvider(host)` (`mitm-proxy.ts:340-348`) classifies the stream for **token-stream extraction**, while **trajectory capture** classifies independently via `providerForHost()`/`createReassembler()` (`trajectory-reassembler.ts:1002,1021`). These are two separate seams — both must become path-aware for OpenRouter (§11).

Each **agent adapter** (`src/docker/adapters/*.ts`, interface `agent-adapter.ts`) supplies `getProviders(authKind)` (which `ProviderConfig`s to allowlist), `buildEnv(config, fakeKeys)` (container env, receiving the fake keys), and `buildCommand(...)` (the CLI invocation, including `--model`). The infra bundle (`docker-infrastructure.ts:531-556`) resolves providers → fake keys → real keys → `ProviderKeyMapping[]` and hands them to `createMitmProxy()`.

Config lives in `~/.ironcurtain/config.json`, validated by a Zod schema (`src/config/user-config.ts`), resolved into `ResolvedUserConfig` (`config.userConfig`, the single carrier `prepareDockerInfrastructure()` reads — `docker-infrastructure.ts:378,426,534`), edited via `ironcurtain config` (`src/config/config-command.ts`) and (for personas) the web UI daemon (`src/web-ui/`). The web UI has **no config read/write methods today**; the precedent for disk-mutating web methods is `personas.*` (`src/web-ui/dispatch/persona-dispatch.ts`), gated on `ctx.allowPolicyMutation` (`persona-dispatch.ts:219`) and emitting a `changed` event. `saveUserConfig()` (`user-config.ts:887`) deep-merges **exactly one level deep** (`deepMergeConfig`, `user-config.ts:860`: `result[key] = { ...result[key], ...value }`), and an **empty object `{}` for a section deletes it** (the editor's "Disable" sentinel, `user-config.ts:865`). The nearest structural precedent for a per-profile registry is `webSearch` (`user-config.ts:206`): a top-level section with a discriminant field + per-provider sub-blocks carrying masked API keys, handled by a dedicated `computeDiff` branch (`config-command.ts:160`).

**Session selection seam.** `--workspace` threads CLI→infra as the template we follow: `src/index.ts:67,131,194` parses/validates it into `workspacePath`, which flows into `runPtySession({ workspacePath })` (`index.ts:191`, PTY/mux) and `createStandaloneSession({ workspacePath })` (`index.ts:217`, batch). In mux, `/new` renders a directory picker whose `picker-spawn` action (`mux-app.ts:286-308`) validates the chosen dir and calls `spawnSession({ workspacePath })` (`mux-app.ts:301`), which spawns a **child `ironcurtain` process** via a PTY bridge that appends `--workspace <path>` to the child argv (`pty-bridge.ts:129`). So a per-session profile choice in mux is delivered the same way: the picker appends `--provider-profile <name>` to the child argv (§ Session-selection plumbing).

**Key seam for this feature:** the MITM rewriter runs at a single chokepoint that sees the fully-assembled request body for **every** agent turn — including Claude Code's background Haiku calls. This makes it the correct single enforcement point for model mapping and `session_id` injection.

---

## 4. External interface contracts (baked-in facts — no re-research needed)

### 4.1 OpenRouter host & endpoints

- Single host: **`openrouter.ai`** port **443**.
- `POST /api/v1/messages` — **Anthropic skin**. Accepts Anthropic Messages format (tools, streaming, thinking, `cache_control`). `model` accepts any OpenRouter slug (e.g. `z-ai/glm-5.2`). Streams **Anthropic-native SSE** event types. **Used by Claude Code.**
- `POST /api/v1/chat/completions` — OpenAI chat format. `data: [DONE]` terminator. **Used by Goose.**
- `POST /api/v1/responses` — beta OpenAI Responses API. **Used by Codex.**
- `GET /api/v1/models`, `GET /api/v1/key`, `GET /api/v1/generation` — metadata (allowlist as needed per agent; see §9).
- Keep-alive SSE comment lines `: OPENROUTER PROCESSING` appear on streams and **must be tolerated** (they already are: MITM streams raw bytes; the agent SDKs ignore comment lines).

### 4.2 Authentication

- OpenRouter authenticates via **`Authorization: Bearer <key>`** only. Keys look like `sk-or-v1-...`.
- Claude Code, given `ANTHROPIC_BASE_URL`, sends its credential as `Authorization: Bearer` **iff** the credential comes from `ANTHROPIC_AUTH_TOKEN` (NOT `ANTHROPIC_API_KEY`, which is sent as `x-api-key`). **We therefore inject the sentinel via `ANTHROPIC_AUTH_TOKEN` and use a `bearer` `keyInjection` on the OpenRouter provider.**
- Codex sends `Authorization: Bearer $OPENROUTER_API_KEY` (bearer). Goose sends `Authorization: Bearer $OPENROUTER_API_KEY` (bearer).

### 4.3 Prompt caching (GLM via OpenRouter)

- GLM caching is **implicit** (no `cache_control` needed) but requires landing on the **Z.ai first-party provider endpoint**. Cache reads report via `usage.prompt_tokens_details.cached_tokens` and bill ~0.19× input.
- Cache affinity through OpenRouter is achieved by any of:
  - **(a)** automatic sticky routing (hash of first system msg + first non-system msg) — fragile for agents whose system prompt is stable but first user msg varies;
  - **(b)** explicit **top-level `session_id`** body field OR **`x-session-id`** header (≤256 chars) — **recommended for agents; this is our mechanism**;
  - **(c)** provider pinning via body `provider`. A **soft** pin `provider: { order: ["z-ai"] }` (fallbacks allowed) is enough for cache-endpoint affinity — **we inject this by default when the mapped slug is `z-ai/*` and no `providerPreference` is configured (D3)**. **Strict** pinning `provider: { order: ["z-ai"], allow_fallbacks: false }` or `provider: { only: ["z-ai"] }` fails rather than routing off z-ai — **our opt-in strict cache-pinning config.**
- For **Anthropic model slugs** routed through OpenRouter, explicit `cache_control` passthrough works on the `/v1/messages` skin — so we must **NOT strip** `cache_control` blocks.
- **Anthropic-only pre-release beta fields** (e.g. `context_management`) may be rejected by non-Anthropic upstreams. Claude Code suppresses these when `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` is set — **we set this env var when routing Claude Code to OpenRouter** (belt); the MITM rewriter also strips a known denylist of such top-level fields (suspenders).

### 4.4 Usage accounting (always on)

Every OpenRouter completion response carries `usage` with: `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, `cache_write_tokens`, `cost` (authoritative USD), `cost_details.cache_discount`. Present in both the final SSE `message_delta`/usage event (Anthropic skin) and the terminal chunk (chat/responses).

### 4.5 Claude Code model-override env vars (behind `ANTHROPIC_BASE_URL`)

`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` (the Haiku one also drives background calls). Behind a gateway Claude Code budgets 200K context unless the model name carries a `[1m]` suffix; `CLAUDE_CODE_AUTO_COMPACT_WINDOW` tunes compaction.

### 4.6 Codex config (user-level only)

`~/.codex/config.toml` must contain, at user level (project-local `model_providers` are ignored). **TOML structure is order-sensitive: root keys (`model`, `model_provider`) MUST appear BEFORE any `[table]` header — otherwise they bind to the table.** The generator must emit root keys first, then the `[model_providers.openrouter]` table:

```toml
model = "z-ai/glm-5.2"
model_provider = "openrouter"

[model_providers.openrouter]
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "responses"
```

`wire_api = "chat"` is a hard error since Feb 2026; Codex speaks **Responses only**. Some slugs reject certain tool schemas (known rough edge; out of our control — surfaced as a normal agent error).

> **Implementation note (§9.2 file layout).** `src/docker/adapters/codex.ts` `generateMcpConfig()` builds `codex-config.toml` as a `string[]` joined by `\n`, and `docker/entrypoint-codex.sh:19` copies it to `$CODEX_HOME/config.toml`. When OpenRouter is on, the generator must PREPEND the two root keys (`model = <slug>`, `model_provider = "openrouter"`) before the FIRST existing `[table]` line (today the first table is `[projects."/workspace"]`), and APPEND the `[model_providers.openrouter]` block. A real TOML parser reading the result must see `model` and `model_provider` as top-level keys. **The §12.3 test MUST parse the generated string with a real TOML parser** (no TOML parser is currently a dependency — add `smol-toml` as a `devDependency`) and assert top-level `model_provider === 'openrouter'` and `model === <expected slug>`, precisely to catch the "keys captured by a preceding table" failure.

### 4.7 Goose (native OpenRouter provider)

`GOOSE_PROVIDER=openrouter`, `GOOSE_MODEL=<slug>`, `OPENROUTER_API_KEY=<key>`. Host `https://openrouter.ai` (override via `OPENROUTER_HOST`), path `api/v1/chat/completions`, headers `Authorization: Bearer`, optional `HTTP-Referer` / `X-Title`. Goose injects `cache_control` only for `anthropic/`-prefixed models (correct — leave it).

---

## 5. Design decisions (A–G)

### A. Where model mapping happens — **MITM-side body rewrite (single enforcement point) + agent env hints**

**Decision.** Model mapping is enforced in the MITM `requestRewriter`, which rewrites the top-level `model` field of every completion request per the ordered glob `modelMap`. This is the single chokepoint that covers all three agents, all endpoint shapes, and Claude Code's background Haiku calls. **Complementarily**, we set the Claude Code `ANTHROPIC_DEFAULT_*_MODEL` env hints so the agent's own context budgeting and `[1m]` handling behave correctly (env hints alone are insufficient — they do not catch every internal call and are agent-specific, hence the MITM as source of truth).

**Rationale.** The rewriter already runs on the parsed body for `/v1/messages` (`mitm-proxy.ts:1253-1269`) and can add/replace fields, not just strip. Enforcing at the MITM means the mapping is agent-agnostic, testable in isolation, and impossible for the agent to bypass. Env hints are a UX nicety layered on top, never the security/routing boundary.

**Rejected:** *env-hints-only.* Rejected because (1) it does not exist for Goose/Codex in the glob form we want, (2) Claude Code's `ANTHROPIC_DEFAULT_HAIKU_MODEL` covers background calls but a user-supplied `ANTHROPIC_MODEL` per-turn override could still leak an unmapped slug, and (3) it splits the routing logic across three adapters instead of one module.

### B. How Claude Code reaches OpenRouter — **new `openrouterProvider`, container talks to `openrouter.ai` directly (option b)**

**Decision.** The container is configured with `ANTHROPIC_BASE_URL=https://openrouter.ai/api` and a fake `ANTHROPIC_AUTH_TOKEN`. The MITM intercepts `openrouter.ai` CONNECT natively via a **new `openrouterProvider` ProviderConfig** (host `openrouter.ai`, bearer key injection, allowlist `/api/v1/messages`, rewriter for model-map + session_id + beta-strip). No upstream redirect, no Host-header surgery: the agent's canonical host *is* the real upstream.

**Rationale.**
- **Auth path is clean.** Claude Code sends `Authorization: Bearer <sentinel>` because we use `ANTHROPIC_AUTH_TOKEN`; the MITM's existing `bearer` swap injects the real `sk-or-v1-...`. Option (a) — keep talking to `api.anthropic.com`, redirect upstream to `openrouter.ai` — would require converting `x-api-key` → `Bearer` *and* rewriting Host/path, a bespoke transform the current `upstreamTarget` machinery does not do (it rewrites Host/path/TLS but not the auth *scheme*).
- **Endpoint allowlist is honest.** With option (b) the allowlist names the real endpoints the agent hits (`openrouter.ai/api/v1/messages`), instead of allowlisting `api.anthropic.com` paths that are lies.
- **Telemetry endpoints.** Claude Code's `api.anthropic.com` housekeeping calls (`/api/hello`, `/api/claude_code/settings`, telemetry, MCP registry — `provider-config.ts:485-497`) are **not** served by OpenRouter and would 404/hang if redirected. In option (b), when OpenRouter routing is ON, we **do not allowlist `api.anthropic.com` at all** for Claude Code — the agent's telemetry attempts are simply blocked at CONNECT (they are non-essential; Claude Code tolerates their absence, same as today's least-privilege posture for Codex telemetry).
- **Trajectory capture / token-stream.** Because one host now serves three wire formats depending on path, BOTH classifiers become **path-aware** (see §11): the token-stream `resolveSseProvider()` and the trajectory-capture `providerForHost()`/`createReassembler()`. `openrouter.ai` + `/api/v1/messages → 'anthropic'`, `/api/v1/responses → 'openai'` (ResponsesReassembler), `/api/v1/chat/completions → raw-bytes-only` (no reassembler, v0). This is a bounded, well-tested change.

**Rejected:** *option (a) upstream-redirect.* Rejected for the auth-scheme-conversion and honest-allowlist reasons above. Documented here so a re-implementer does not "simplify" toward it.

### C. Config schema — a **named provider-profile registry** (`modelProviders`)

**Decision.** A `modelProviders` top-level section (see §6) holding an optional `default` profile name and a `profiles` record keyed by user-chosen name. Each profile is a **discriminated union on `type`**; v1 types are `'native'` and `'openrouter'`. The `openrouter` variant carries EXACTLY the fields v2's single section defined — `apiKey`, `modelMap`, `perAgent`, `providerPreference`, `sessionAffinity` — with identical semantics and defaults (D1–D4 unchanged, now scoped per profile). An **implicit, always-present profile named `native`** (`type: 'native'`) represents today's canonical behavior; users cannot shadow it (validation rejects a user-defined profile named `native`) or delete it. The **active** profile for a session is resolved once (§ Session-selection plumbing) as: explicit per-session choice → `modelProviders.default` → `native`. **Enablement is not a boolean** — it is "the active profile's `type` is `openrouter`"; when the active profile is `native`, behavior is byte-identical to today (the old §8.4 no-op).

**Rationale.** Users think in *presets*, not toggles: "run this session on GLM" or "on Kimi" is a named choice, and different sessions want different backends concurrently. A registry makes the model choice a first-class, per-session, scriptable selection while keeping the OpenRouter transform logic (§7) untouched — it is simply parameterized by *the active profile* rather than a global block. The whole `modelProviders` top-level key joins the `SENSITIVE_FIELDS` set (top-level-key granular, `user-config.ts:433`), so `computeMissingDefaults()` never back-fills it (matching `serverCredentials`/`webSearch`), while explicit writes via `saveUserConfig()` persist — see M6 / §6. Env `OPENROUTER_API_KEY` fills/overrides `apiKey` for **every** `openrouter`-type profile (most users share one key across profiles); a profile-specific config `apiKey` is used only when the env var is unset.

**Rejected:** *a single global `openrouter` section with an `enabled` toggle (v2's shape).* Rejected because it cannot express "this session on GLM, that session on Kimi", forces a global mode flip, and models enablement as a boolean rather than a selection. Migrating away from it later (once released) would cost a config-migration path; defining the registry up front avoids that entirely — and there is **no released `openrouter` shape to migrate from** (pre-implementation).

**Rejected:** *reusing `anthropicBaseUrl`.* Rejected because base-URL override is a generic escape hatch with no model mapping, no caching guarantee, and no per-agent semantics; conflating them would make the UX depend on the user understanding MITM internals.

**Deferred (see §16):** *per-persona profile binding.* It collides with workflow shared-container mode, where the MITM provider registry, rewriter config, and container env (`ANTHROPIC_BASE_URL`, fake keys) are fixed at bundle creation and only **policy** hot-swaps between personas via the control server — there is no provider/env hot-swap seam. The `type` discriminator is the extension point for future providers (Z.ai-direct is the natural next type — same bearer + Anthropic-skin pattern).

### D. Prompt caching guarantee — **`session_id` injection at the MITM, keyed on the agent conversation id**

**Decision.** When the active profile is `openrouter`-type with `sessionAffinity` on and the mapped model is a GLM-family slug (`z-ai/*`), the rewriter injects a **top-level `session_id`** into the request body. The value is **`${cacheKey}:${requestedModelId}` truncated to 256 chars** (D4), where `cacheKey` is the proxy's current `tokenSessionId` (the stable per-agent conversation id already threaded through the MITM) and `requestedModelId` is the **requested** (pre-remap) model id. Including the requested model id separates Claude Code's background Haiku affinity from the main conversation's cache (so a Haiku turn does not evict the Sonnet-mapped main context) without splitting the main cache — it is deterministic (no randomness), stable across turns of one conversation for a given requested model, and distinct when the requested model differs. `cache_control` blocks on Anthropic-model requests are **never stripped**.

**Default z-ai pin (D3, R6).** When the mapped slug matches `z-ai/*` AND `providerPreference` is **not** configured, the rewriter injects `provider: { "order": ["z-ai"] }` **by default** (fallbacks still allowed — this is a soft pin sufficient for cache affinity without failing the request if z-ai is briefly unavailable). A user-configured `providerPreference` **replaces** this default entirely. `{ only: ["z-ai"] }` or `{ order: ["z-ai"], allowFallbacks: false }` is the opt-in **strict mode** (fail rather than route off z-ai). Known Anthropic-only beta fields are stripped (denylist, see §7). See §8 for the full transform and the test oracle.

**Rationale.** `session_id` is OpenRouter's documented, agent-recommended cache-affinity mechanism (§4.3b). Keying on `tokenSessionId` reuses an existing, correctly-scoped identifier (already snapshotted per-request at `mitm-proxy.ts:1002,1243` for exactly this "don't split a conversation" reason). It requires **threading the session id into the rewriter context** — the one interface change this feature makes to the rewriter contract (§7). Defaulting the z-ai pin (D3) makes caching work out-of-the-box (R1 quickstart): a fresh user who enables OpenRouter and pastes a key gets cached GLM with no further config.

**Workflow-mode caveat (m9).** In shared-container workflow fan-out, `bundle.setTokenSessionId()` is best-effort and racy across concurrent lanes (`orchestrator.ts:2475,2480` — the long-lived MITM is shared, so a lane's `cacheKey` snapshot can reflect a peer's id). This degrades cache **affinity** only (a cache miss, higher cost), never correctness — the routed model and body are still valid. Accepted for v0.

### E. Cost accounting — **prefer OpenRouter's authoritative `usage.cost`; add a GLM matcher as fallback**

**Decision.** Two-part (v0 scope narrowed per D6):
1. Add a `z-ai` / `glm` matcher to `MODEL_PRICING` (`resource-budget-tracker.ts:78`) so estimation is sane even without response cost.
2. For the **Anthropic-skin SSE path only** (Claude Code), prefer the **authoritative `usage.cost`**. In Docker mode, per-turn cost flows from the adapter's self-reported `costUsd` (`docker-agent-session.ts:307-310`) — which is **wrong** for GLM (Claude Code reports Anthropic-model cost). Extend the Anthropic-skin SSE usage extractor (in `sse-extractor.ts`, NOT `mitm-proxy.ts`) to surface `cost` / `cached_tokens` on the token-stream bus, and have the Docker session **sum** those per-request costs and prefer the cumulative sum over the CLI's self-report when the active profile is openrouter-type and the sum > 0. **Goose/Codex (chat/responses) use the static matcher in v0** — the OpenAI-shape SSE extractor emits raw events only today.

**Rationale.** The response `cost` is ground truth and free (always present). The static matcher is a cheap guard for the estimation path, for Code Mode, and for Goose/Codex in v0. See §10 for the precise plumbing and the fallback ordering.

### F. Codex + Goose routing

**Decision.**
- **Codex.** `createCodexAdapter(userConfig)` (signature changed, m3). `generateMcpConfig()` writes `codex-config.toml` with root keys FIRST (`model = <codexSlug>`, `model_provider = "openrouter"`) then the `[model_providers.openrouter]` table (§4.6/B1). **Codex slug = `perAgent.codex ?? DEFAULT_GLM_SLUG`** (no native model field → never passthrough an unmapped OpenAI id, D2). `buildEnv()` sets `OPENROUTER_API_KEY=<fake sentinel>`. `getProviders()` returns `openrouterProvider` (bearer) instead of the ChatGPT providers. Allowlist: `POST /api/v1/responses`, `GET /api/v1/models` (see §9).
- **Goose.** `buildEnv()` sets `GOOSE_PROVIDER=openrouter`, `GOOSE_MODEL=<gooseSlug>`, `OPENROUTER_API_KEY=<fake sentinel>`, where **`gooseSlug = perAgent.goose ?? resolveMappedModel(gooseModel, modelMap) ?? DEFAULT_GLM_SLUG`** (D2). `getProviders()` returns `openrouterProvider`. Allowlist: `POST /api/v1/chat/completions`. Host `openrouter.ai` is intercepted natively.

**Rationale.** Both agents natively speak to `openrouter.ai` with bearer auth — the same `openrouterProvider` serves all three agents; only the allowlisted endpoint subset differs per agent (handled by `getProviders` returning a per-agent-tailored variant, see §7).

### G. Web UI — a new `config.*` dispatch surface, gated

**Decision.** A new dispatch module `src/web-ui/dispatch/config-dispatch.ts` exposes read + mutation methods for the `modelProviders` section only (scope-limited): `config.getModelProviders` (read; masks every profile's key) and `config.setModelProviders` (mutation; gated on `ctx.allowPolicyMutation`, following the `personas.*` precedent exactly). A new `Settings` view in the Svelte frontend renders the profile list + add/edit/delete + default selector; the mock server gets canned handlers; unit + e2e tests cover it.

**Rationale.** Mirrors the established `personas.*` gated-mutation pattern (`persona-dispatch.ts:219,286`) for **the gate + change-event only** (m15): `personas.*` mutations are gated on `ctx.allowPolicyMutation` (else `POLICY_MUTATION_FORBIDDEN`) and emit a `changed` event. Note personas do **NOT** persist via `saveUserConfig` — they write persona files. So the persistence half is new here: `config.setModelProviders` writes the **whole `modelProviders` section** via `saveUserConfig()` (per-profile M5 mask-unchanged guard prevents a masked round-trip from clobbering a stored key). Writing the whole section is required — not optional — because `deepMergeConfig` replaces the `profiles` record wholesale (§6 merge note), so a partial write would drop unmentioned profiles. Scoping to only `modelProviders` keeps the wire surface minimal and avoids exposing the full config over WS.

---

## 6. Config schema (Zod-ready)

Add to `src/config/user-config.ts`.

```ts
// --- Constants (exported) ---
export const OPENROUTER_HOST = 'openrouter.ai';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';        // Claude Code ANTHROPIC_BASE_URL
export const OPENROUTER_API_V1 = 'https://openrouter.ai/api/v1';        // Codex/Goose base_url
export const DEFAULT_GLM_SLUG = 'z-ai/glm-5.2';
/** The implicit, always-present profile name. Reserved: users may not define it. */
export const NATIVE_PROFILE_NAME = 'native';

/** A single ordered glob→slug mapping rule. First match wins. */
const modelMapRuleSchema = z.object({
  /** Glob matched (case-insensitively) against the REQUESTED model id. `*` = any run of chars. */
  match: z.string().min(1),
  /** OpenRouter slug to route to, e.g. "z-ai/glm-5.2". */
  model: z.string().min(1),
});

/** Provider-preference passthrough for cache pinning (OpenRouter `provider` body field). */
const providerPreferenceSchema = z
  .object({
    /** Ordered provider slugs to try, e.g. ["z-ai"]. */
    order: z.array(z.string().min(1)).optional(),
    /** Restrict routing to exactly these provider slugs. */
    only: z.array(z.string().min(1)).optional(),
    /** Allow OpenRouter to fall back to other providers. Default true. */
    allowFallbacks: z.boolean().optional(),
  })
  .optional();

/** An openrouter-type profile: EXACTLY v2's `openrouter` section fields, sans `enabled`. */
const openrouterProfileSchema = z.object({
  type: z.literal('openrouter'),
  /** OpenRouter API key (sk-or-v1-...). Env OPENROUTER_API_KEY takes precedence. Sensitive. */
  apiKey: z.string().min(1).optional(),
  /** Ordered glob→slug rules; first match wins. */
  modelMap: z.array(modelMapRuleSchema).optional(),
  /** Per-agent model override. WINS over modelMap for that agent (D1 precedence). */
  perAgent: z
    .object({
      'claude-code': z.string().min(1).optional(),
      goose: z.string().min(1).optional(),
      codex: z.string().min(1).optional(),
    })
    .optional(),
  /** Provider-preference passthrough (cache pinning). */
  providerPreference: providerPreferenceSchema,
  /** Inject a stable top-level session_id for GLM cache affinity. Default true. */
  sessionAffinity: z.boolean().optional(),
});

/** A native-type profile: today's canonical Anthropic/OpenAI/ChatGPT routing. No fields. */
const nativeProfileSchema = z.object({ type: z.literal('native') });

/** v1 profile union. New provider types extend this discriminator (§16). */
const providerProfileSchema = z.discriminatedUnion('type', [nativeProfileSchema, openrouterProfileSchema]);

const modelProvidersSchema = z
  .object({
    /** Name of the profile used when no per-session choice is made. Must name an existing
        profile or "native". Absent => "native". */
    default: z.string().min(1).optional(),
    /** User-named profiles. A profile named "native" is REJECTED (reserved). */
    profiles: z
      .record(z.string().min(1), providerProfileSchema)
      .refine((p) => !(NATIVE_PROFILE_NAME in p), {
        message: `"${NATIVE_PROFILE_NAME}" is a reserved profile name and cannot be redefined.`,
      })
      .optional(),
  })
  // `default`, when present, must resolve to an existing profile or the reserved native name.
  .refine(
    (mp) => mp.default === undefined || mp.default === NATIVE_PROFILE_NAME || !!mp.profiles?.[mp.default],
    { message: 'modelProviders.default must name a configured profile or "native".', path: ['default'] },
  )
  .optional();
```

Wire into `userConfigSchema` (`user-config.ts:270`): add `modelProviders: modelProvidersSchema,`.

Add `'modelProviders'` handling to the **resolution** (`mergeWithDefaults()`, `user-config.ts:689`) and to **`ResolvedUserConfig`**. Note: `modelProviders` is **NOT** added to `USER_CONFIG_DEFAULTS` (`user-config.ts:17`) — its defaults live only in the resolution logic below, so `computeMissingDefaults()` (which iterates `USER_CONFIG_DEFAULTS`) never back-fills a `modelProviders` block to disk.

```ts
/** Resolved openrouter profile = v2's ResolvedOpenRouterConfig fields, minus `enabled`
    (enablement is now "the active profile's type is openrouter"). */
export interface ResolvedOpenRouterProfile {
  readonly type: 'openrouter';
  readonly apiKey: string;                         // '' when unset
  readonly modelMap: readonly { readonly match: string; readonly model: string }[];
  readonly perAgent: Readonly<Record<DockerAgent, string | undefined>>;
  readonly providerPreference:
    | { readonly order?: readonly string[]; readonly only?: readonly string[]; readonly allowFallbacks?: boolean }
    | undefined;
  readonly sessionAffinity: boolean;
}
export interface ResolvedNativeProfile {
  readonly type: 'native';
}
/** The resolved active profile the whole feature reads (§7–§11). */
export type ResolvedProviderProfile = ResolvedNativeProfile | ResolvedOpenRouterProfile;

// on ResolvedUserConfig:
readonly modelProviders: {
  readonly default: string;                        // resolved name; 'native' when UNSET. An invalid
                                                   //   `default` (naming a missing profile) is NOT
                                                   //   guarded here — it is a HARD load error (F10).
  readonly profiles: Readonly<Record<string, ResolvedProviderProfile>>;  // ALWAYS includes 'native'
};
```

(Plain `Record` chosen over `ReadonlyMap` to match `ResolvedUserConfig.serverCredentials`, which is a `Readonly<Record<...>>` — codebase convention is nested records, not Maps, for resolved config.)

Resolution rules (`mergeWithDefaults()`):
- **`profiles`**: `config.modelProviders?.profiles` resolved entry-by-entry; each `openrouter` entry resolved per the field rules below. The implicit **`native` profile is always injected** (`{ type: 'native' }`) into the resolved record — it is present even when `modelProviders` is absent entirely. A user-defined `native` key is rejected at the schema layer, so it can never collide.
- **`default`**: `config.modelProviders?.default ?? NATIVE_PROFILE_NAME`. This is **not** a soft guard: the Zod `.refine` on `modelProvidersSchema` runs inside `validateConfig` during `loadUserConfig` (`user-config.ts:490-507`, which `throw`s on any schema/refine failure), so a **hand-edited `default` naming a missing profile is a HARD load error** — `loadUserConfig` throws with the refine's message (`modelProviders.default must name a configured profile or "native"`), it does **not** silently fall back to `native`. Because the config already loaded successfully by the time resolution runs, the `.refine` guarantees a configured `default` names an existing profile or `native`, so the resolved value is always a key present in the resolved `profiles` record. (The `?? NATIVE_PROFILE_NAME` only covers the **unset** case, never an invalid one.)
- **Per openrouter-profile field resolution** (unchanged from v2 semantics, now per profile):
  - `apiKey`: **`process.env.OPENROUTER_API_KEY || profile.apiKey || ''`** (env fills/overrides EVERY openrouter profile; applied in the `applyEnvOverrides()` block near `user-config.ts:816`).
  - `modelMap`: `profile.modelMap ?? DEFAULT_MODEL_MAP` where
    `DEFAULT_MODEL_MAP = [{ match: '*opus*', model: DEFAULT_GLM_SLUG }, { match: '*sonnet*', model: DEFAULT_GLM_SLUG }, { match: '*haiku*', model: DEFAULT_GLM_SLUG }]`.
    **`modelMap: []` is meaningful:** because resolution uses `??` (not `||`), an explicit empty array is preserved — "no glob mapping; rely on `perAgent` only" (glob never matches, so per D1 only `perAgent`/passthrough applies). Both UIs' help text must surface this ("empty map = per-agent-only mode").
  - `sessionAffinity`: `profile.sessionAffinity ?? true`.
  - `perAgent`: `{ 'claude-code': ..., goose: ..., codex: ... }` (each `?? undefined`).
  - `providerPreference`: passed through (or `undefined`).

Add `'modelProviders'` to `SENSITIVE_FIELDS` (`user-config.ts:433`). `SENSITIVE_FIELDS` is **top-level-key granular** — the whole `modelProviders` key joins the set. This suppresses back-fill by `computeMissingDefaults()` (`user-config.ts:544` skips sensitive keys); it does **not** suppress persistence — an explicitly-set profile `apiKey` written via `saveUserConfig()` is persisted (G8's gated web write and the CLI editor depend on this). In `computeDiff` each profile's key is masked via `maskApiKey` (see §12.6 / M5).

**Merge note (`saveUserConfig` → `deepMergeConfig`, one level deep — verified `user-config.ts:860,868`).** For `modelProviders`, `deepMergeConfig` spreads one level: `result.modelProviders = { ...existing.modelProviders, ...changes.modelProviders }`. Because the spread is shallow, `changes.modelProviders.profiles` **replaces** `existing.modelProviders.profiles` wholesale — a partial write that omits a profile drops it. **This is acceptable and intended**: both editors (CLI + web UI) read the resolved `profiles`, mutate one, and write back the **whole** `profiles` record, exactly as the config editor writes whole sections today (`webSearch`, `serverCredentials`). No two-level merge is added. The empty-object sentinel still applies: `saveUserConfig({ modelProviders: {} })` deletes the section (reverts everything to `native`).

### Active-profile resolution (session-time, not config-time)

The **active** profile for a session is resolved once at session/bundle creation from a `providerProfileName?: string`:
```
activeName   = providerProfileName ?? resolvedConfig.modelProviders.default   // default already == 'native' when unset
activeProfile = resolvedConfig.modelProviders.profiles[activeName]
```
An unknown `providerProfileName` (not a key of the resolved `profiles` record) is a **hard error before container launch**: `Unknown provider profile "<name>". Available: native, <configured names…>.` The resolved `activeProfile: ResolvedProviderProfile` is **stamped onto the per-session `config.activeProviderProfile`** (§9 F1 config-stamping — never bound at adapter-factory time), and that stamped value is what §7–§11 read. When `config.activeProviderProfile.type === 'native'`, the OpenRouter machinery is never installed (byte-identical to today). See § Session-selection plumbing.

### Example `~/.ironcurtain/config.json`

```json
{
  "preferredMode": "docker",
  "preferredDockerAgent": "claude-code",
  "modelProviders": {
    "default": "glm-5.2",
    "profiles": {
      "glm-5.2": {
        "type": "openrouter",
        "apiKey": "sk-or-v1-REDACTED",
        "modelMap": [
          { "match": "*opus*", "model": "z-ai/glm-5.2" },
          { "match": "*sonnet*", "model": "z-ai/glm-5.2" },
          { "match": "*haiku*", "model": "z-ai/glm-5.2" }
        ],
        "perAgent": { "goose": "z-ai/glm-5.2", "codex": "z-ai/glm-5.2" },
        "providerPreference": { "order": ["z-ai"], "allowFallbacks": false },
        "sessionAffinity": true
      },
      "kimi": {
        "type": "openrouter",
        "modelMap": [{ "match": "*", "model": "moonshot/kimi-k3" }]
      }
    }
  }
}
```

Here `glm-5.2` is the global default; `kimi` shares the env `OPENROUTER_API_KEY` (no per-profile `apiKey`). The `glm-5.2` profile's `providerPreference` is the **explicit strict** form; it is **optional** (omit it and D3 injects the default soft pin `{ order: ["z-ai"] }` for `z-ai/*` slugs). The quickstart minimal profile (§13/M7) is just `{ "type": "openrouter", "apiKey": "sk-or-v1-..." }` — defaults supply GLM mapping + soft z-ai pin + session affinity. `native` need not be listed; it is always present and is the fallback when `default` is unset.

---

## 7. Model-mapping + rewriter module

New file: **`src/docker/openrouter.ts`** (encapsulates all OpenRouter-specific transform logic; adapters and the infra bundle depend on this, not on inline logic — per CLAUDE.md "encapsulate risky operations").

### 7.1 Glob resolution

```ts
/** Compile a `modelMap` glob to a RegExp anchored full-string, case-insensitive. `*` => `.*`. */
export function globToRegExp(glob: string): RegExp; // escape regex metachars except '*'

/**
 * Resolve the OpenRouter slug for a requested model id under an ordered map.
 * First matching rule wins. Returns `undefined` when nothing matches. Per D1,
 * the CALLER resolves final slug as `perAgentDefault ?? resolveMappedModel(...) ??
 * <passthrough>` — i.e. an agent-specific perAgent default takes precedence over
 * a glob match; this function only performs the glob lookup.
 */
export function resolveMappedModel(
  requestedModelId: string,
  modelMap: readonly { match: string; model: string }[],
): string | undefined;
```

### 7.2 Rewriter context change (the one contract change)

The rewriter context gains an optional `cacheKey` (the stable conversation id) so `session_id` injection is possible. Extend `RequestBodyRewriter`'s context in `provider-config.ts`:

```ts
export type RequestBodyRewriter = (
  body: Record<string, unknown>,
  context: {
    method: string;
    path: string;
    agentKind?: AgentKind;
    cacheKey?: string;               // NEW: stable per-conversation id for session_id injection
  },
) => RewriteResult | null;
```

At the call site (`mitm-proxy.ts:1259`, currently `rewriter(parsed, { method: reqMethod, path: reqPath, agentKind })`), pass `cacheKey: sidForToolResults` — reuse the `const sidForToolResults = tokenSessionId;` snapshot already taken at `mitm-proxy.ts:1243` (before rewrite, so a concurrent `setTokenSessionId` flip cannot split this request). All existing rewriters ignore the new field (backward-compatible). The **requested** model id needed by D4 is `body.model` as the rewriter first reads it, before it remaps — no extra context field is required for it.

### 7.3 The OpenRouter rewriter

```ts
/** Top-level fields Anthropic clients may send that non-Anthropic upstreams reject. */
export const ANTHROPIC_ONLY_BETA_FIELDS: readonly string[] = ['context_management'];

export interface OpenRouterRewriterConfig {
  readonly modelMap: readonly { match: string; model: string }[];
  readonly perAgentDefault: string | undefined;
  readonly providerPreference:
    | { order?: readonly string[]; only?: readonly string[]; allowFallbacks?: boolean }
    | undefined;
  readonly sessionAffinity: boolean;
}

/**
 * Builds a RequestBodyRewriter that, for an OpenRouter completion request:
 *  0. If `body.model` is not a string, return null immediately (no-op; nothing
 *     to remap — e.g. a non-completion request that slipped through). (m7)
 *  1. Captures `requestedModelId = body.model` (the pre-remap id), then rewrites
 *     top-level `model`. Resolution (D1/D2 precedence):
 *        slug = perAgentDefault
 *             ?? resolveMappedModel(requestedModelId, modelMap)
 *             ?? requestedModelId          // passthrough: leave requested id unchanged
 *     i.e. an agent-specific `perAgentDefault` WINS over the glob `modelMap`.
 *  2. Injects top-level `session_id` = `${cacheKey}:${requestedModelId}` truncated
 *     to 256 chars (D4) when sessionAffinity, the mapped slug is `z-ai/*`, cacheKey
 *     is present, and `session_id` is not already set. Deterministic (no randomness).
 *  3. Injects top-level `provider`:
 *       - if `providerPreference` is configured -> use it (replaces default), when
 *         `provider` is absent from the body;
 *       - else if the mapped slug is `z-ai/*` -> inject the DEFAULT soft pin
 *         `{ order: ["z-ai"] }` (fallbacks allowed) when `provider` is absent (D3, R6).
 *  4. Strips ANTHROPIC_ONLY_BETA_FIELDS top-level keys.
 *  5. NEVER touches `cache_control` blocks inside messages.
 * Returns null when no change was made (so the caller skips re-serialization).
 * `stripped` lists the applied transforms for logging.
 */
export function makeOpenRouterRewriter(cfg: OpenRouterRewriterConfig): RequestBodyRewriter;
```

`stripped` labels are human-readable: `model:z-ai/glm-5.2`, `session_id:<8charprefix>`, `provider:pin` (configured) / `provider:default-z-ai` (D3 default), `beta:context_management`.

**Wire mapping for `providerPreference`.** Config `allowFallbacks` maps to the wire field `allow_fallbacks` (snake_case); `only` → `only`; `order` → `order`. The D3 default injects exactly `{ "order": ["z-ai"] }` (no `allow_fallbacks` key, so fallbacks are on).

### 7.4 Provider config factory

```ts
/** Endpoint subset an agent uses on OpenRouter. */
export type OpenRouterEndpointKind = 'messages' | 'chat' | 'responses';

/**
 * Build the openrouterProvider for a given agent's endpoint kind and rewriter.
 * host: 'openrouter.ai'; keyInjection: bearer; fakeKeyPrefix: 'sk-or-v1-ironcurtain-'.
 * allowedEndpoints / captureEndpoints / rewriteEndpoints per endpoint kind:
 *   messages   -> POST /api/v1/messages, POST /api/v1/messages/count_tokens (D5)  (+ GET /api/v1/models)
 *   chat       -> POST /api/v1/chat/completions                                   (+ GET /api/v1/models)
 *   responses  -> POST /api/v1/responses                                          (+ GET /api/v1/models)
 * The rewriter is attached to the COMPLETION POST path only
 * (requestRewriter + rewriteEndpoints = [the completion POST path]);
 * count_tokens is allowlisted but NOT rewritten/captured — the proxy passes
 * through whatever OpenRouter returns (2xx or 4xx). captureEndpoints = the
 * single completion POST path per kind.
 */
export function makeOpenRouterProvider(
  kind: OpenRouterEndpointKind,
  rewriter: RequestBodyRewriter,
): ProviderConfig;
```

Notes:
- `fakeKeyPrefix = 'sk-or-v1-ironcurtain-'` — structurally valid OpenRouter key shape so any client-side format check passes; swapped host-side.
- `captureEndpoints` = the same single POST path (so trajectory capture keeps working). **Trajectory reassembly does NOT go through `resolveSseProvider`** — it uses the host+path classification in `trajectory-reassembler.ts` (`providerForHost()`:1002 and `createReassembler()`:1021, called from `trajectory-tap.ts:153,237`), which must be made path-aware for `openrouter.ai` — see §11. The token-stream tap (`resolveSseProvider`) is a separate seam, also path-aware — see §11.

### 7.5 Real-key resolution

Extend `resolveRealKey()` (`docker-infrastructure.ts:1447`) with a case for `openrouter.ai` → **`config.activeProviderProfile.apiKey`** (the active `ResolvedOpenRouterProfile.apiKey`). `resolveRealKey` **already receives the per-session `config`** (`resolveRealKey(host, config, oauthAccessToken)`, `:1447`), so **no signature change is needed** — it simply reads the stamped `config.activeProviderProfile` (stamped as the FIRST step of `prepareDockerInfrastructure`, before auth detection — see §9.7 Resolution and the F1 config-stamping note in §9). Because the same host serves all three agents, this single case covers them. The `default` branch currently logs and returns `''` for unknown hosts; adding the explicit case both supplies the key and avoids that warning. Note `isManagedOAuthHost` (`docker-infrastructure.ts:551-554`) checks `ANTHROPIC_HOSTS`/`CODEX_CHATGPT_HOSTS` only — `openrouter.ai` is not in either set, so no OAuth token manager is attached to the OpenRouter mapping (correct; OpenRouter uses a static bearer key).

---

## 8. Concrete request transforms (input → output)

### 8.1 Model rewrite + session_id injection (Claude Code, `/api/v1/messages`)

`cacheKey = "7f3c2a9e-1b4d-4e8a-9c22-abcdef012345"`, `sessionAffinity=true`, `providerPreference={order:["z-ai"],allowFallbacks:false}` (strict mode, explicitly configured), map `*sonnet* → z-ai/glm-5.2`. The requested model id is `claude-sonnet-4-6`, so the injected `session_id` is `"<cacheKey>:claude-sonnet-4-6"` (D4).

**Input body (from agent):**

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 4096,
  "context_management": { "edits": [] },
  "system": [
    { "type": "text", "text": "You are IronCurtain's agent.",
      "cache_control": { "type": "ephemeral" } }
  ],
  "messages": [ { "role": "user", "content": "List the files." } ]
}
```

**Output body (forwarded upstream):**

```json
{
  "model": "z-ai/glm-5.2",
  "max_tokens": 4096,
  "system": [
    { "type": "text", "text": "You are IronCurtain's agent.",
      "cache_control": { "type": "ephemeral" } }
  ],
  "messages": [ { "role": "user", "content": "List the files." } ],
  "session_id": "7f3c2a9e-1b4d-4e8a-9c22-abcdef012345:claude-sonnet-4-6",
  "provider": { "order": ["z-ai"], "allow_fallbacks": false }
}
```

Changes: `model` remapped; `context_management` removed (beta strip); `cache_control` **preserved**; `session_id` (= `<cacheKey>:<requestedModelId>`) + `provider` injected. `stripped = ["model:z-ai/glm-5.2","beta:context_management","session_id:7f3c2a9e","provider:pin"]`.

Note the config's `allowFallbacks` maps to the wire field `allow_fallbacks` (snake_case). `only` maps to `only`; `order` to `order`.

**Default-pin variant (D3).** With the SAME inputs but `providerPreference` **unset**, the output is identical except the injected `provider` is the default soft pin `{ "order": ["z-ai"] }` (no `allow_fallbacks`), and the `stripped` provider label is `provider:default-z-ai`. This is the out-of-box behavior a fresh user gets after enabling OpenRouter (R6 / quickstart).

### 8.2 session_id stability across turns (D4 oracle)

- **Turn 2 of the same conversation, same requested model** (same `cacheKey`, same `requestedModelId`) → **same** `"session_id": "7f3c2a9e-...:claude-sonnet-4-6"`.
- **A different requested model** in the same conversation (e.g. Claude Code's background `claude-haiku-...` call, same `cacheKey`) → a **different** `session_id` (`"7f3c2a9e-...:claude-haiku-..."`), separating background-Haiku cache affinity from the main conversation's.
- **A different conversation** (different `cacheKey`) → a different id.
- **Workflow fan-out caveat (m9):** across concurrent lanes the `cacheKey` snapshot is best-effort (`orchestrator.ts:2475,2480`), so affinity may degrade to a cache miss — never incorrect routing.

The oracle (§12.2 test 3) asserts stability under same conversation+model, and difference under a changed requested model.

### 8.3 Auth-header conversion (all agents)

The agent sends `Authorization: Bearer sk-or-v1-ironcurtain-<random>`. `validateAndSwapApiKey` (bearer branch, `mitm-proxy.ts:2161-2170`) matches the sentinel and rewrites to `Authorization: Bearer sk-or-v1-<realkey>`. No `x-api-key` involved.

### 8.4 No-op case (active profile is `native`)

If the session's active profile is `type: 'native'`, `getProviders()` returns the canonical providers unchanged and `buildEnv()` sets no OpenRouter env — the rewriter is never installed, zero behavior change. This is the resolution result whenever no per-session profile is chosen and `modelProviders.default` is unset (default resolves to `native`).

---

## 9. Docker / adapter changes (per agent)

All three adapters read the session's resolved **active profile** — but **NOT** via the adapter factory. The adapter registry is **process-global with first-registration-wins caching** (`agent-registry.ts:11-17,41-59`: `registerBuiltinAdapters` skips any adapter already in the `Map`, so the FIRST session's adapter instance is reused for the life of the process), and the daemon (`ironcurtain-daemon.ts:537`), the signal bot (`signal-bot-daemon.ts:506`), and the web-UI session-dispatch all spawn **multiple sessions in ONE process**. Binding the active profile at factory time would therefore leak session A's profile into session B. **The active profile is delivered per-session via config-stamping instead** (the exact precedent is `config.dockerAuth`, `src/config/types.ts:119-122`, stamped onto the per-session `IronCurtainConfig` by `prepareDockerInfrastructure` at `docker-infrastructure.ts:447`):

- The resolved active profile is stamped onto the per-session `IronCurtainConfig` as **`config.activeProviderProfile: ResolvedProviderProfile`** (add this field to `IronCurtainConfig` in `src/config/types.ts`, alongside `dockerAuth` at :119-122). Because every session path passes a session-specific `config` copy, the stamp is session-local — no cross-session leakage.
- Adapters that need the profile receive it by reading `config.activeProviderProfile` from the `IronCurtainConfig` they are already handed in `buildEnv(config, fakeKeys)` / `getProviders(...)` / `generateMcpConfig(...)`. The concrete signature changes are in §9's per-agent sections and §7.5; see the resolution ordering in §9.7 (Resolution).

**FORBIDDEN:** binding the active profile at adapter-factory or registry time (e.g. threading it through `createClaudeCodeAdapter`/`createCodexAdapter`/`createGooseAdapter` and closing over it). The process-global, first-registration-wins registry (`agent-registry.ts:11-17,41-59`) shared across the multi-session daemon/signal/web-UI hosts makes any factory-time binding a cross-session leak. The profile MUST reach the adapter through the per-session stamped `config`, never through a captured factory argument.

**Signature changes (the profile must reach functions that currently lack a `config`/profile input).** `buildEnv(config, fakeKeys)` already receives the per-session `config` (`agent-adapter.ts:280`) and simply reads `config.activeProviderProfile`. Two adapter methods do NOT take `config` today and must be threaded it (config-threading chosen over any factory-captured value, per the forbid above):

- `getProviders(authKind?: DockerAuthKind)` → **`getProviders(config: IronCurtainConfig, authKind?: DockerAuthKind)`** (`agent-adapter.ts:271`; the call site in `docker-infrastructure.ts` that resolves providers→fake keys→real keys, `docker-infrastructure.ts:531-556`, already holds `config` and passes it through). `getProviders` reads `config.activeProviderProfile` to decide whether to return `[makeOpenRouterProvider(...)]` or the native providers.
- `generateMcpConfig(socketPath: string)` → **`generateMcpConfig(socketPath: string, config: IronCurtainConfig)`** (`agent-adapter.ts:223`, Codex impl `adapters/codex.ts:91`; the caller already has `config`). Codex reads `config.activeProviderProfile` to decide whether to emit the OpenRouter TOML root keys + `[model_providers.openrouter]` table (§9.2/B1).
- `resolveRealKey(host, config, oauthAccessToken)` **already receives `config`** (`docker-infrastructure.ts:1447`) — **no signature change**; it reads `config.activeProviderProfile.apiKey` for the `openrouter.ai` case (§7.5).

References below to `openrouter.<field>` mean `config.activeProviderProfile.<field>` **when `config.activeProviderProfile.type === 'openrouter'`**. When `config.activeProviderProfile.type === 'openrouter'` (replaces v2's "when `openrouter.enabled`"):

### 9.1 Claude Code (`adapters/claude-code.ts`)

- `getProviders(authKind)` → `[makeOpenRouterProvider('messages', rewriter)]` (drop `anthropicProvider` / `claudePlatformProvider`; the OAuth branch — `[anthropicOAuthProvider, claudePlatformOAuthProvider]` at `claude-code.ts:245-248` — is also dropped when the active profile is openrouter-type: OpenRouter uses its own bearer key, not Anthropic OAuth).
- **`detectCredential()` (NEW method on the adapter, B2a).** Claude Code has none today (`docker-infrastructure.ts:435` falls through to `detectAuthMethod()`, which throws when no Anthropic OAuth/API key exists). Add `detectCredential(config)` that, when the active profile is openrouter-type, returns an **API-key-style `AuthMethod`** (`{ kind: 'apikey', ... }`) keyed on the profile's `apiKey` being non-empty (mirrors the Codex/Goose `detectCredential` in §9.2/9.3). This guarantees an OpenRouter-only user (no Anthropic creds) never trips `detectAuthMethod()`. When the active profile is `native`, return `undefined`/fall through to preserve today's OAuth+API-key detection.
- **`authKind = 'apikey'` (B2b).** With `detectCredential` returning `apikey`, `config.dockerAuth.kind` is `'apikey'`, so `getProviders(config, 'apikey')` (new signature, F1) and the API-key `buildEnv` branch are selected. No OAuth token manager is constructed for `openrouter.ai`: `isManagedOAuthHost` (`docker-infrastructure.ts:551-554`) matches only `ANTHROPIC_HOSTS`/`CODEX_CHATGPT_HOSTS`, and `openrouter.ai` is in neither — verified, no change needed there.
- `buildEnv()` in OpenRouter mode sets:
  - `ANTHROPIC_BASE_URL=https://openrouter.ai/api`
  - `ANTHROPIC_AUTH_TOKEN=<fakeKeys.get('openrouter.ai')>` (bearer, NOT `ANTHROPIC_API_KEY`)
  - `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`
  - The three model-hint vars, each computed **per tier** from the requested-model probe string (m2):
    - `ANTHROPIC_DEFAULT_SONNET_MODEL = perAgent['claude-code'] ?? resolveMappedModel('claude-sonnet', modelMap) ?? unset`
    - `ANTHROPIC_DEFAULT_OPUS_MODEL = perAgent['claude-code'] ?? resolveMappedModel('claude-opus', modelMap) ?? unset`
    - `ANTHROPIC_DEFAULT_HAIKU_MODEL = perAgent['claude-code'] ?? resolveMappedModel('claude-haiku', modelMap) ?? unset`
    (the `DEFAULT_MODEL_MAP` `*sonnet*`/`*opus*`/`*haiku*` globs match these probe strings; "unset" = omit the var when nothing resolves). These are hints for the agent's own context budgeting only; the MITM does the authoritative remap. Do **not** set `IRONCURTAIN_MODEL`/`--model` to the OpenRouter slug (leave the requested Anthropic id so the agent's prompts/heuristics stay coherent).
  - **B2c — auth-var exclusivity:** in OpenRouter mode, `buildEnv()` sets NEITHER `CLAUDE_CODE_OAUTH_TOKEN` NOR `IRONCURTAIN_API_KEY` — only `ANTHROPIC_AUTH_TOKEN=<fake>`. This holds **even when host OAuth creds exist** (OpenRouter mode overrides OAuth detection). Look up the fake key by `openrouter.ai`, not `api.anthropic.com` (the current guard at `claude-code.ts:262` reads `fakeKeys.get('api.anthropic.com')`).
- **B2d — entrypoint third branch (`docker/entrypoint-claude-code.sh`).** Today the script (lines 55-90) has two branches keyed on `CLAUDE_CODE_OAUTH_TOKEN`: if set → settings.json without `apiKeyHelper`; else → settings.json WITH `apiKeyHelper: "echo $IRONCURTAIN_API_KEY"` (line 82). In OpenRouter mode neither var is set, so the else-branch would write an `apiKeyHelper` echoing an empty string — which competes with the `ANTHROPIC_AUTH_TOKEN` bearer. Add a **third branch**: when `ANTHROPIC_AUTH_TOKEN` is set (and `CLAUDE_CODE_OAUTH_TOKEN` is not), write settings.json **without** `apiKeyHelper` (Claude Code reads the bearer token from `ANTHROPIC_AUTH_TOKEN` directly). Branch order: `CLAUDE_CODE_OAUTH_TOKEN` set → OAuth block; elif `ANTHROPIC_AUTH_TOKEN` set → no-helper block; else → `apiKeyHelper` block.
- Endpoint allowlist consequence: `api.anthropic.com` telemetry is not allowlisted when the active profile is openrouter-type (decision B). Session startup must complete with `api.anthropic.com` **unreachable** (asserted in G10, §12.4).
- **Precedence (m6):** an openrouter-type active profile beats any `anthropicBaseUrl`/upstream override for Claude Code — the `anthropicProvider`/`claudePlatformProvider` are not even in `getProviders`' return list, so `applyUpstreamOverrides()` has nothing to target. One rule: when the active profile routes through OpenRouter, it is the sole routing for the affected agent.

### 9.2 Codex (`adapters/codex.ts`)

- **Factory signature change (m3).** `createCodexAdapter()` currently takes no args (`codex.ts:79`) and `agent-registry.ts:56` calls it as `createCodexAdapter()`. Change to `createCodexAdapter(userConfig?: ResolvedUserConfig)` (matching `createClaudeCodeAdapter`/`createGooseAdapter`) and update the registry call to `createCodexAdapter(userConfig)`. This is in-scope for G5.
- **Mapped slug (D2).** Codex has **no native model field in IronCurtain config** (no `codexModel`). It therefore must **never passthrough an unmapped OpenAI id**. The Codex slug is:
  `codexSlug = perAgent.codex ?? DEFAULT_GLM_SLUG` (state this formula verbatim; §12.3 asserts the no-`perAgent` case resolves to `DEFAULT_GLM_SLUG`, and `modelMap` does NOT participate for Codex).
- `getProviders()` → `[makeOpenRouterProvider('responses', rewriter)]` (drop `codexChatGptProvider` / `codexAuthProvider`).
- **`generateMcpConfig()` TOML (B1 layout).** The generator builds `codex-config.toml` as a joined `string[]` (`codex.ts:95-109`), copied to `$CODEX_HOME/config.toml` by `docker/entrypoint-codex.sh:19` (`CODEX_HOME=/home/codespace/.codex`). When the active profile is openrouter-type, the generated file MUST place the two root keys **before any `[table]`**:
  ```toml
  model = "<codexSlug>"
  model_provider = "openrouter"
  # ...existing root keys (cli_auth_credentials_store, project_doc_fallback_filenames)...

  [projects."/workspace"]
  # ...existing...

  [model_providers.openrouter]
  base_url = "https://openrouter.ai/api/v1"   # = OPENROUTER_API_V1 constant (m8)
  env_key = "OPENROUTER_API_KEY"
  wire_api = "responses"

  [mcp_servers.ironcurtain]
  # ...existing...
  ```
  Concretely: prepend `model`/`model_provider` to the existing root-key lines (before the first `[projects."/workspace"]` table) and append the `[model_providers.openrouter]` table. §12.3 parses the result with a real TOML parser (`smol-toml`, dev-dep) and asserts top-level `model_provider === 'openrouter'` and `model === <codexSlug>`.
- `buildEnv()` sets `OPENROUTER_API_KEY=<fakeKeys.get('openrouter.ai')>`; drops the Codex OAuth token env (`IRONCURTAIN_CODEX_ACCESS_TOKEN` etc.).
- `detectCredential()`: when the active profile is openrouter-type, credential presence = the profile's `apiKey` non-empty (no `codex login` needed); else preserve today's detection.

### 9.3 Goose (`adapters/goose.ts`)

- **Mapped slug (D2).** Goose HAS a native model input (`gooseModel`, resolved from config). The Goose slug is:
  `gooseSlug = perAgent.goose ?? resolveMappedModel(gooseModel, modelMap) ?? DEFAULT_GLM_SLUG` (state verbatim; §12.3 asserts the no-`perAgent`/no-`modelMap`-match case resolves to `DEFAULT_GLM_SLUG`, never a passthrough of an unmapped OpenAI-shaped id).
- `getProviders()` → `[makeOpenRouterProvider('chat', rewriter)]`.
- `buildEnv()` sets `GOOSE_PROVIDER=openrouter`, `GOOSE_MODEL=<gooseSlug>`, `OPENROUTER_API_KEY=<fakeKeys.get('openrouter.ai')>`. Generalize the existing `gooseProvider` switch to accept `'openrouter'` (add to a broader provider union used only inside the adapter; the config-level `GOOSE_PROVIDERS` enum is unchanged — OpenRouter routing is driven by the active profile, not `gooseProvider`).
- `detectCredential()`: when the active profile is openrouter-type, credential = the profile's `apiKey` non-empty; else preserve today's provider-specific detection.

### 9.4 Endpoint allowlist summary (active profile openrouter-type)

| Agent | Host | Allowed endpoints |
|---|---|---|
| Claude Code | `openrouter.ai` | `POST /api/v1/messages`, `POST /api/v1/messages/count_tokens` (D5), `GET /api/v1/models` |
| Goose | `openrouter.ai` | `POST /api/v1/chat/completions`, `GET /api/v1/models` |
| Codex | `openrouter.ai` | `POST /api/v1/responses`, `GET /api/v1/models` |

Capture endpoints = the single **completion** POST path per agent (count_tokens is allowlisted but not captured/rewritten; the proxy passes its 2xx/4xx through unchanged, and Claude Code degrades gracefully when it fails — D5).

### 9.5 Fail-fast on missing key (m5)

When the active profile is openrouter-type but its resolved `apiKey` is empty (neither `OPENROUTER_API_KEY` env nor the profile's config `apiKey` set), session start MUST throw a clear error **before container launch** — in the infra bundle prep, at the point `resolveRealKey('openrouter.ai', ...)` would otherwise return `''` (i.e. in `createDockerInfrastructure` right after the provider→key resolution loop at `docker-infrastructure.ts:540-556`, or in a small guard in the OpenRouter provider path). Message: `Provider profile "<name>" is OpenRouter but no API key is configured. Set OPENROUTER_API_KEY or the profile's apiKey in ~/.ironcurtain/config.json.` Add a test (§12.3) asserting the throw. (Note: `detectCredential` in §9.1-9.3 already blocks the no-key case at auth detection for each adapter; this bundle-level guard is the belt-and-suspenders catch for a profile selected programmatically.)

### 9.6 PTY-mode parity (m12)

`ironcurtain mux` (PTY mode, `pty-session.ts`) uses the **same** `buildEnv`/infra bundle as batch mode, so OpenRouter routing applies identically — no PTY-specific code. §12.3's env assertions therefore cover both modes; no separate PTY test is required. (The mux `/new` picker selects a *profile name* that becomes `--provider-profile` on the child argv, which the child parses into `providerProfileName` exactly as a batch `ironcurtain start --provider-profile` invocation does — see § Session-selection plumbing.)

### 9.7 Session-selection plumbing

The active profile is chosen **once per session** and threaded from the entry point to infra prep, mirroring how `--workspace` threads today (verified seams cited). Three surfaces feed a single `providerProfileName?: string`:

**(1) Global default.** `modelProviders.default` (resolved to `native` when unset). Used when no per-session choice is made.

> **Scope of `modelProviders.default` (F2 — SUPERVISOR DECISION: option (a), "all Docker Agent Mode sessions honor the global default").** Because the active profile is resolved from `config.userConfig.modelProviders.default` inside `prepareDockerInfrastructure` (§9.7 Resolution) — the single infra-prep entry that **every** Docker Agent Mode session funnels through — the global `default` applies to **all** of them: interactive sessions (`ironcurtain mux` PTY, batch `ironcurtain start`), daemon/cron jobs (`ironcurtain-daemon.ts:537` → `createStandaloneSession`), signal-bot sessions (`signal-bot-daemon.ts:506` → `createStandaloneSession`), web-UI-spawned sessions, **AND workflow orchestrator bundles** (`orchestrator.ts:1405` → `createDockerInfrastructure` → `prepareDockerInfrastructure`). None of these need to pass `providerProfileName`; absent an explicit choice they inherit `default`. A **per-session override** (`providerProfileName`) exists **only where a surface exposes it** — the mux `/new` picker and `ironcurtain start --provider-profile <name>`; the daemon/cron, signal-bot, and web-UI paths pass no `providerProfileName` today and so ride the global default (adding a surface there is future work, not v1). **Workflows inherit the global default too, even though per-PERSONA binding is deferred (§16)** — one profile applies to the whole shared-container run; the m9 session-affinity caveat (§5-D) already covers the shared-container cache consequence of that single-profile-per-bundle reality. Code Mode / builtin sessions are unaffected (§9.7 F4 note; §2 non-goal).

**(2) CLI parity — `ironcurtain start --provider-profile <name>`.** Add `'provider-profile': { type: 'string' }` to the `start` option table (`src/index.ts:63-73`, alongside `workspace`/`persona`) and to `startSpec` help. Parse it into `const providerProfileName = values['provider-profile']` (next to `rawWorkspace`, `index.ts:101`). Thread it into **both** session paths exactly like `workspacePath`:
- PTY/mux path: `runPtySession({ ..., providerProfileName })` (`index.ts:191`); add `providerProfileName?: string` to `PtySessionOptions` (`pty-session.ts:40`) and pass it into `prepareDockerInfrastructure` (see resolution below).
- Batch path: `createStandaloneSession({ ..., providerProfileName })` (`index.ts:217`); add `providerProfileName?: string` to `SessionOptions` — next to `workspacePath` at `src/session/types.ts:421` (the `SessionOptions` interface opens at `:361`).

**(3) Mux `/new` picker step.** In mux, `/new` today renders a directory picker; its `picker-spawn` action validates the dir and calls `spawnSession({ workspacePath })` (`mux-app.ts:301`), which spawns a **child `ironcurtain` process** via `createPtyBridge`, appending `--workspace <path>` to the child argv (`pty-bridge.ts:129`). Add a **profile-picker step** after (or combined with) the directory step:

- **Config-load seam (F5 — mux does not load user config today).** `MuxAppOptions` (`mux-app.ts:31-46`) carries no `ResolvedUserConfig`, and mux never reads one — so the picker has no profile data to show. Follow the **persona-picker precedent** (`scanPersonas()` → `enterPickerMode(personas)`, `mux-app.ts:430,443-444`): mux **loads the resolved config** (`loadUserConfig()` / the resolver) **at startup (or lazily on `/new`)** and derives a **profile snapshot** `{ name: string; type: 'native' | 'openrouter'; primaryModelLabel: string; isDefault: boolean }[]` from `modelProviders`. That snapshot array is what the profile picker renders — mirroring how `scanPersonas()` produces the persona list the persona picker consumes. Pass the snapshot into the picker/input handler the same way `enterPickerMode(personas)` receives the persona list (`mux-app.ts:444`).
- The picker lists `native` + each configured profile from the snapshot, marking the `isDefault` entry (`modelProviders.default`), each rendered as a *preset* (name + `primaryModelLabel`, e.g. `glm-5.2 → z-ai/glm-5.2 (OpenRouter)`; for a wildcard-only map show the wildcard target; for `native` show `native (Anthropic / OpenAI / ChatGPT)`). The `primaryModelLabel` is computed when the snapshot is built, from `perAgent['claude-code'] ?? resolveMappedModel('claude-sonnet', modelMap) ?? DEFAULT_GLM_SLUG` (the same probe the Sonnet hint uses).
- Selection sets `action.providerProfileName`; `spawnSession` gains a `providerProfileName?` field (`mux-app.ts:101-106`) passed into `createPtyBridge`, which appends `--provider-profile <name>` to the child argv (add to `PtyBridgeOptions` and the extracted `buildSpawnArgs` — F6, `pty-bridge.ts:80-140`, next to the existing `--workspace`/`--persona`/`--model` pushes). The child then parses it via surface (2). **No new IPC** — reuses the existing argv-to-child mechanism.

**Resolution (single point, config-stamped — see F1 in §9).** In `prepareDockerInfrastructure` (`docker-infrastructure.ts:378`), resolving and **stamping** the active profile is the **FIRST step**, explicitly **before auth detection at `docker-infrastructure.ts:435`** (the `adapter.detectCredential ? adapter.detectCredential(config) : detectAuthMethod(config)` call). This ordering is load-bearing: B2a's Claude Code `detectCredential(config)` reads `config.activeProviderProfile` to return an API-key `AuthMethod` for an OpenRouter-only user, so the stamp must already be present when `:435` runs. Resolve from `config.userConfig.modelProviders` + the threaded `providerProfileName` per § "Active-profile resolution":
```
activeName    = providerProfileName ?? config.userConfig.modelProviders.default   // default already == 'native' when unset
activeProfile = config.userConfig.modelProviders.profiles[activeName]
config.activeProviderProfile = activeProfile   // STAMP (mirrors config.dockerAuth stamp at :447)
```
An unknown `providerProfileName` (not a key of the resolved `profiles` record) throws the clear error listing available profiles **before container launch** (and before the stamp). Safe to mutate `config` — callers always pass a session-specific copy (the same invariant the `config.dockerAuth` stamp relies on, `:445-447`). After stamping, the adapters (§9) and `resolveRealKey` (§7.5) read `config.activeProviderProfile` directly — nothing else is threaded. Standalone sessions own their bundle, so a per-session profile is clean — there is no shared-container ambiguity (contrast the per-persona non-goal, §16). Add `providerProfileName?: string` to `prepareDockerInfrastructure`'s parameters (or carry it on the `mode`/options object it already receives) so both PTY and batch paths supply it uniformly.

**Unknown-name error.** Surfaced identically on all three surfaces (CLI, mux picker child, programmatic): `Unknown provider profile "<name>". Available: native, <configured names…>.` The picker only offers valid names, so the error is primarily a guard for `--provider-profile` typos and stale scripts.

**Resume semantics (F3 — SUPERVISOR DECISION: persist the resolved name, warn-ignore a conflicting flag on resume).** Mirrors the existing `--workspace`/`--persona` resume precedent exactly. **Both resume paths persist their own metadata structure — the field is added to BOTH** (resume flows through `runPtySession` for PTY/mux AND `createStandaloneSession` for batch, `src/index.ts:195,220`):
- **Persist at first start.** The resolved active-profile **name** (the resolved `activeName` — `'native'` or a configured profile name, NOT the whole profile object; storing the resolved name, not "no intent", is what makes the supervisor's "keeps its original profile" hold when `default` later changes) is written into the persisted session metadata:
  - **PTY path:** `SessionSnapshot` (`src/docker/pty-types.ts:27-44`, carries `workspacePath` `:37` + `agent` `:39`, written at `pty-session.ts:761-770`). **Add `readonly providerProfileName?: string;`** next to `workspacePath` and populate it in the snapshot object at `pty-session.ts:761`.
  - **Batch path:** `SessionMetadata` (`src/session/types.ts:121-136`, carries `persona` `:123` + `workspacePath` `:124`; written via `saveSessionMetadata`, `session/index.ts:46`). **Add `readonly providerProfileName?: string;`** next to `workspacePath` and populate it when the session's metadata is saved. (This structure's docstring — "stores the original user intent … so on resume the persona can be re-resolved with updated policies" — is the exact model: store the intent/name, re-resolve on resume.)
- **Restore on resume.** Restore the profile the same way each path restores `workspacePath`:
  - **PTY:** `validateResumeSession()` (`pty-session.ts:105`) returns the snapshot; `runPtySession` restores `workspacePath` at `pty-session.ts:222` (`isResume ? resumeSnapshot.workspacePath : options.workspacePath`). Do the same: `providerProfileName = isResume ? resumeSnapshot.providerProfileName : options.providerProfileName`.
  - **Batch:** `createStandaloneSession` restores `workspacePath` from `loadSessionMetadata` at `session/index.ts:127-134` (`...(metadata.workspacePath !== undefined ? { workspacePath: metadata.workspacePath } : {})`). Add the parallel `providerProfileName` restore there. In both cases the resumed session re-resolves against **its original** name.
- **Warn-ignore a conflicting flag.** When resuming, a passed `--provider-profile` is ignored with a warning, exactly like `--workspace`/`--persona` today (`src/index.ts:118-125`: `if (resumeSessionId && rawWorkspace) { process.stderr.write("Note: --workspace is ignored when resuming…") }`). Add a third warn: `if (resumeSessionId && providerProfileName) { …"Note: --provider-profile is ignored when resuming; original profile is restored." }`. The mux `resume-spawn` path (`mux-app.ts:315-324`) already omits per-session selection args on resume — no change needed there beyond not appending `--provider-profile`.
- **Default-change independence.** If `modelProviders.default` changed on disk **after** the session first started, the **resumed session keeps its original profile** (it re-resolves from the persisted `providerProfileName`, not from the current `default`). A session first started with **no** explicit choice persists the resolved name (e.g. `'native'` or the then-current `default`), so a later `default` flip does not silently re-route a resumed conversation. Caveat: if the resumed profile NAME no longer exists in `profiles` (user deleted it between runs), resume re-resolution hits the same unknown-name hard error as a stale `--provider-profile` — acceptable (the user deleted the profile the conversation was pinned to).

**Builtin / Code Mode inertness (F4).** Profile resolution lives **only** in `prepareDockerInfrastructure` (§9.7 Resolution), which builtin/Code Mode sessions never reach. So `--provider-profile` and an `openrouter`-type `modelProviders.default` are **silently inert** for builtin sessions — Code Mode routing through OpenRouter is out of scope (§2). To avoid a confusing silent no-op, **emit a one-line warning** when `--provider-profile` is passed with the builtin agent (i.e. `providerProfileName` is set but the resolved session mode is not `docker`): `Note: --provider-profile applies only to Docker Agent Mode; ignored for the builtin (Code Mode) agent.` (a warn, not a hard error — the flag is harmless, just ineffective). The `openrouter`-type `default` case stays silently inert (no per-invocation flag to warn on).

## 10. Cost accounting

1. **Static matcher.** Add to `MODEL_PRICING` (`resource-budget-tracker.ts:78`, before broad matches):
   `{ match: 'glm-5.2', pricing: { inputPerMillion: 0.6, outputPerMillion: 2.2, cacheReadPerMillion: 0.11 } }` and a broader `{ match: 'z-ai/', ... }` guard. (Approximate; adjust to current OpenRouter GLM pricing — the table is explicitly "approximate by design".)
2. **Authoritative cost (v0 scope — D6).** The authoritative `usage.cost` extraction is specified for the **Anthropic-skin SSE path only** (Claude Code, `/api/v1/messages`). The SSE usage parsing lives in **`src/docker/sse-extractor.ts`** (`SseExtractorTransform`, the Anthropic path around `sse-extractor.ts:230,319`) — **not** in `mitm-proxy.ts` (the `mitm-proxy.ts:491` `extractFromJsonResponse` handles only the **non-streaming JSON** response). Extend the Anthropic-skin SSE usage extraction to read `usage.cost` and `usage.prompt_tokens_details.cached_tokens` and publish them on the token-stream bus as fields on the existing usage event (emitted on the `message_end`-equivalent event). **Goose (chat) and Codex (responses) fall back to the static matcher in v0** — the OpenAI-shape SSE extractor emits raw events only today and is not extended here (documented limitation, not a bug).

   **Accumulation semantics.** The Docker session **sums** the per-request `usage.cost` values observed on token-stream `message_end` events attributed to its session id, and **prefers that cumulative sum** over the CLI's self-reported `costUsd` (`docker-agent-session.ts:307-310`, which sets `this.cumulativeCostUsd = response.costUsd`) **when the active profile is openrouter-type AND the observed sum > 0**. Fallback order: **authoritative cumulative sum → CLI `costUsd` → static estimate**. (This is a named session-level test in §12.3 and part of G6 validation.)

Document in `MODEL_ROUTING.md` that with first-class OpenRouter the cost is now accurate for Claude Code (unlike the LiteLLM base-URL path, where the cap bills at the requested model id); Goose/Codex use the static estimate in v0.

---

## 11. Token-stream / trajectory-capture changes

`openrouter.ai` serves three wire formats depending on path, so provider classification must become **path-aware in TWO independent seams**: (1) the token-stream tap's `resolveSseProvider` in `mitm-proxy.ts`, and (2) the trajectory-capture classifier in `trajectory-reassembler.ts`. In addition, (3) `isLlmMessagesEndpoint` must recognize the OpenRouter paths.

### 11.1 Token-stream tap: `resolveSseProvider` (`mitm-proxy.ts:340-348`)

Becomes **path-aware** for `openrouter.ai`:

```ts
export function resolveSseProvider(hostname: string, path?: string): SseProvider {
  if (hostname === 'api.anthropic.com' || hostname === 'platform.claude.com') return 'anthropic';
  if (hostname === 'api.openai.com') return 'openai';
  if (hostname === 'openrouter.ai') {
    const p = (path ?? '').split('?')[0];
    return p.endsWith('/messages') ? 'anthropic' : 'openai';  // /api/v1/messages => anthropic skin
  }
  return 'unknown';
}
```

`resolveSseProvider` has **exactly one** call site: `mitm-proxy.ts:1022` (verified — not two). Update that single site to pass `path`. The Anthropic reassembler already handles the Anthropic-native SSE shape the skin emits; the OpenAI token-stream path stays stubbed (v0) as today. Keep-alive `: OPENROUTER PROCESSING` comment lines are inert (SSE comment lines start with `:` and carry no `event:`/`data:`).

### 11.2 Trajectory-capture classifier (`trajectory-reassembler.ts`)

Trajectory capture does **NOT** use `resolveSseProvider`. It classifies by host via `providerForHost()` (`trajectory-reassembler.ts:1002-1008`) and picks a reassembler via `createReassembler()` (`:1021-1026`), both called from `trajectory-tap.ts:153,237` — host-only today, with **deliberately no chat-completions reassembler**. The `ExchangeRecord` already carries the request `path` (`trajectory-types.ts:46`, verified), so make both functions **path-aware** for `openrouter.ai`:

- `providerForHost` / `createReassembler` gain a `path` parameter (thread the `ExchangeRecord.path` from `trajectory-tap.ts:153,237`).
- `openrouter.ai` + `/api/v1/messages` → `'anthropic'` + `AnthropicReassembler`.
- `openrouter.ai` + `/api/v1/responses` → `'openai'` + the existing `ResponsesReassembler` (verified to exist, `trajectory-reassembler.ts:717`).
- `openrouter.ai` + `/api/v1/chat/completions` → captured **raw-bytes-only** (no reassembler; `createReassembler` returns `undefined`, and the tap falls back to verbatim byte capture). This is explicitly documented v0 behavior — there is intentionally no Chat Completions reassembler.

§12.2 asserts a captured OpenRouter `/api/v1/messages` exchange reassembles (`providerForHost(...) !== 'unknown'`).

### 11.3 `isLlmMessagesEndpoint` (`mitm-proxy.ts:369-372`) — M2

This helper currently matches only exact `/v1/messages` | `/v1/chat/completions`. It gates two OpenRouter-relevant behaviors: request-side `tool_result` extraction (`mitm-proxy.ts:1244`) and non-streaming JSON usage extraction (`mitm-proxy.ts:1027`). Extend it to also match the three OpenRouter paths `/api/v1/messages`, `/api/v1/chat/completions`, `/api/v1/responses` (query-string already stripped at line 370). §12.2 asserts `tool_result` extraction fires through the OpenRouter `/api/v1/messages` path.

---

## 12. Testing plan (file-by-file)

All functional/integration tests are **token-free** except the single opt-in live test. The macro tests reuse the real `MitmProxy` via the `sendConnect`/`makeHttpsRequest`/`makeLocalRewriteProvider` (`test/mitm-proxy.test.ts:1553`) TLS-CONNECT harness. `createSseUpstream` is **module-private in `test/mitm-proxy-token-stream.test.ts`** — either extract it into `test/helpers/` (preferred, so both the token-stream and OpenRouter suites share it) or copy the pattern into the new test file. New OpenRouter test files live under `test/docker/` (vitest's `test/**` glob includes it).

> **Test-path note (M3): the suite is FLAT under `test/`** — existing files referenced below are `test/user-config.test.ts`, `test/config-command.test.ts`, `test/resource-budget-tracker.test.ts`, `test/docker-agent-adapter.test.ts`, `test/goose-adapter.test.ts`, `test/codex-adapter.test.ts` (there is **no** `claude-code-adapter.test.ts`; Claude-Code adapter assertions go in `test/docker-agent-adapter.test.ts` or the new OpenRouter suite), and the mock helper is `test/helpers/docker-mocks.ts`. New files under `test/docker/` are fine.

### 12.1 Pure unit tests — `test/docker/openrouter.unit.test.ts`

- `globToRegExp` / `resolveMappedModel`: `*sonnet*`→match, first-rule-wins ordering, case-insensitivity, no-match→undefined, literal-dot safety (`gpt-4.1` not treated as regex).
- `makeOpenRouterRewriter`:
  - rewrites `model` per the D1 resolution (`perAgentDefault ?? resolveMappedModel(...) ?? requested id passthrough`); leaves the requested id unchanged when neither resolves.
  - **D1 precedence (pin this):** when both `perAgentDefault` and a matching `modelMap` rule are present, `perAgentDefault` WINS (resolution `perAgentDefault ?? resolveMappedModel(...) ?? requested`). Add a dedicated test asserting the perAgent value is chosen over the glob match.
  - **`modelMap: []` semantics:** with an empty map and a `perAgentDefault`, the perAgent default is used (glob returns undefined). With an empty map and no `perAgentDefault`, the requested id passes through unchanged.
  - **D4 session_id keying:** injects `session_id = `${cacheKey}:${requestedModelId}`` (truncated to 256) for `z-ai/*`; same conversation + same requested model → identical id; **different requested model → different id** (Haiku vs Sonnet separation); **does not** inject for a non-GLM mapped slug; does not overwrite an existing `session_id`; skips when `sessionAffinity=false` or `cacheKey` absent.
  - **D3 provider injection:** with `providerPreference` unset and a `z-ai/*` mapped slug → injects the default soft pin `{ order: ["z-ai"] }` (no `allow_fallbacks`, label `provider:default-z-ai`); with `providerPreference` set → injects it verbatim (correct `allow_fallbacks` snake_case), replacing the default; skips when the body already has `provider`; **no** default pin for a non-`z-ai/*` mapped slug.
  - strips `context_management`; **preserves** `cache_control` blocks (assert deep-equal on `system[].cache_control`).
  - **m7 no-op:** returns `null` when `body.model` is absent/non-string, and when nothing changed.
- Config schema (`modelProviders` registry): `userConfigSchema.safeParse` accepts the §6 two-profile example; rejects a `modelMap` entry with empty `match`; **rejects a user-defined profile named `native`** (reserved); **rejects `default` naming a non-existent profile** (`.refine`), and **accepts** `default: "native"` or `default: <configured name>`. `mergeWithDefaults()` (m1 — the real function name): the resolved `profiles` record **always contains `native`** (even when `modelProviders` is absent); `default` resolves to `native` when unset; per openrouter-profile — applies `DEFAULT_MODEL_MAP` when absent, preserves an explicit `modelMap: []` (D1), `sessionAffinity` default true, env `OPENROUTER_API_KEY` precedence over the profile's config `apiKey` **for every openrouter profile**; `modelProviders` is not in `USER_CONFIG_DEFAULTS` and `computeMissingDefaults` never back-fills it (M6).
- Active-profile resolution: `providerProfileName` → that profile; unset → `modelProviders.default`; that unset → `native`. An **unknown `providerProfileName` throws** the "Unknown provider profile … Available: native, …" error (pure function, testable without infra).
- `makeOpenRouterProvider`: bearer injection; correct allowlist per `kind`; rewrite endpoints set.

### 12.2 Macro functional tests — `test/docker/openrouter-mitm.test.ts`

Fake OpenRouter upstream = a local HTTP server (via the `makeLocalRewriteProvider`/`upstreamTarget`-to-local pattern) that **echoes the received body** in its response and can serve canned SSE (Anthropic-skin + chat + responses) from fixtures. Behind the real `MitmProxy` with an `openrouterProvider` whose `upstreamTarget` points at the local server (`mitm-proxy.test.ts:1553`). Assertions, end to end through TLS CONNECT:

1. **Key swap**: agent sends `Authorization: Bearer sk-or-v1-ironcurtain-<x>`; upstream receives `Authorization: Bearer sk-or-v1-<realkey>`.
2. **Model rewrite**: agent posts `model:"claude-sonnet-4-6"` to `/api/v1/messages`; echoed upstream body has `model:"z-ai/glm-5.2"`.
3. **session_id stability (D4)**: two POSTs with the same proxy `tokenSessionId` **and same requested model** → identical `session_id` (`<sid>:claude-sonnet-4-6`); a POST with a **different requested model** (e.g. `claude-haiku-...`) → different `session_id`; a `setTokenSessionId` flip → different `session_id`.
4. **cache_control preserved / beta stripped**: echoed body keeps `system[].cache_control`, drops `context_management`.
5. **provider pin**: with `providerPreference` set, echoed body has `provider:{order:["z-ai"],allow_fallbacks:false}`; **D3 default** — with `providerPreference` unset and a `z-ai/*` slug, echoed body has `provider:{order:["z-ai"]}` (no `allow_fallbacks`).
6. **usage/cost extraction**: canned Anthropic-skin SSE with a terminal usage event carrying `cost` + `prompt_tokens_details.cached_tokens` → the token-stream bus receives those values.
7. **keep-alive tolerance**: canned SSE interleaves `: OPENROUTER PROCESSING\n\n` comment lines; the client still receives a well-formed stream and reassembly does not error.
8. **allowlist**: `POST /api/v1/chat/completions` on a `messages`-kind provider → 403.
9. **count_tokens passthrough (D5)**: `POST /api/v1/messages/count_tokens` is allowlisted on the `messages`-kind provider; the proxy passes through whatever the upstream returns. Assert: upstream returns **404** for count_tokens → the 404 passes through unchanged, AND a subsequent `POST /api/v1/messages` call succeeds (count_tokens failure does not poison the connection/session). (Claude Code degrades gracefully — count_tokens is advisory.)
10. **trajectory reassembly (M1)**: a captured OpenRouter `/api/v1/messages` exchange, run through the path-aware classifier, yields `providerForHost('openrouter.ai', '/api/v1/messages') === 'anthropic'` (`!== 'unknown'`) and `createReassembler(...)` returns an `AnthropicReassembler` that reassembles the canned stream without error.
11. **tool_result extraction through OpenRouter path (M2)**: a request body with a `tool_result` block POSTed to `/api/v1/messages` fires `isLlmMessagesEndpoint`-gated extraction (`mitm-proxy.ts:1244`) — assert the tool_result is observed on the bus (proves the extended `isLlmMessagesEndpoint` matches `/api/v1/messages`).

Fixtures: `test/docker/fixtures/openrouter-messages-stream.sse`, `openrouter-chat-stream.sse`, `openrouter-responses-stream.sse` (verbatim field shapes per Appendix A / §18).

### 12.3 DockerAgentSession-level tests — `test/docker/openrouter-agent-session.test.ts`

Using the scripted docker-exec mocks (`test/helpers/docker-mocks.ts`, pattern from `test/docker-agent-session-retry.test.ts`) and mock infra. Assert that with an **openrouter-type active profile**, each adapter's `buildEnv()` produces the expected env and `getProviders()` returns exactly the `openrouterProvider` with the correct allowlist:

- **Claude Code:** `ANTHROPIC_BASE_URL=https://openrouter.ai/api`; `ANTHROPIC_AUTH_TOKEN` = fake key; `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`; the three `ANTHROPIC_DEFAULT_*_MODEL` hints per the m2 per-tier formulas.
  - **B2c auth-var exclusivity:** the env map contains **NO** `CLAUDE_CODE_OAUTH_TOKEN` and **NO** `IRONCURTAIN_API_KEY` — only `ANTHROPIC_AUTH_TOKEN`. Assert this holds even when the test config carries host OAuth creds (an openrouter profile overrides OAuth).
  - **B2a:** `detectCredential(config)` with an openrouter-type active profile returns `{ kind: 'apikey' }` keyed on the profile's `apiKey` non-empty; returns `none`/throws-worthy only when the key is empty (feeds m5 fail-fast).
- **Codex:** `OPENROUTER_API_KEY` = fake key; no Codex OAuth env (`IRONCURTAIN_CODEX_ACCESS_TOKEN` absent). **B1/D2:** parse the generated `codex-config.toml` with `smol-toml` and assert top-level `model_provider === 'openrouter'` and `model === (perAgent.codex ?? DEFAULT_GLM_SLUG)`. Add the no-`perAgent` case → `model === DEFAULT_GLM_SLUG` (never an unmapped OpenAI id).
- **Goose:** `GOOSE_PROVIDER=openrouter`; `GOOSE_MODEL === (perAgent.goose ?? resolveMappedModel(gooseModel, modelMap) ?? DEFAULT_GLM_SLUG)`. Add the no-`perAgent`/no-`modelMap`-match case → `GOOSE_MODEL === DEFAULT_GLM_SLUG`.
- **All:** the fake key never equals the real key; the **real** `OPENROUTER_API_KEY` value is absent from every container env map.
- **m5 fail-fast:** an openrouter-type active profile with an empty resolved `apiKey` → infra bundle prep throws the clear error (before container launch); assert the message.
- **Selection plumbing (G13, new):** with two configured profiles + a `native`:
  - a session created with `providerProfileName: 'kimi'` uses **that profile's** rewriter/keys (env `GOOSE_MODEL`/mapped model reflect `moonshot/kimi-k3`, not the default profile);
  - a session created with **no** `providerProfileName` and `modelProviders.default: 'glm-5.2'` uses the default profile;
  - a session with `providerProfileName: 'native'` (or no profiles configured at all) installs **no** OpenRouter env — byte-identical to today;
  - a session with `providerProfileName: 'does-not-exist'` **throws** "Unknown provider profile … Available: native, glm-5.2, kimi" before container launch.
  This exercises the resolution point in infra prep (the pure resolver is separately unit-tested in §12.1).
- **Cross-session isolation (F1 — no factory-time leakage):** in a **single process**, prepare infra for session A with `providerProfileName: 'glm-5.2'` and session B with `providerProfileName: 'kimi'` (both share the same process-global adapter registry). Assert each session's stamped `config.activeProviderProfile` and resulting rewriter/provider set reflect **its own** profile — session A remaps to `z-ai/glm-5.2`, session B to `moonshot/kimi-k3` — with **no** bleed from A into B (this is the guard against binding the profile at adapter-factory/registry time; the registry caches the adapter instance across both sessions, so a factory-captured profile would make B observe A's mapping). Also cover A=`glm-5.2` then B=`native`: B installs **no** OpenRouter env even though A did.
- **Non-interactive default reach (F2 — option (a)):** invoke infra prep the way the **daemon/cron/signal** paths do (via `createStandaloneSession`/`prepareDockerInfrastructure` with **no** `providerProfileName`) against a config whose `modelProviders.default: 'glm-5.2'`. Assert the stamped `config.activeProviderProfile` is the `glm-5.2` profile and the resulting env/rewriter route through OpenRouter — proving the global default applies to a non-interactive session with no per-session selection surface. (The interactive default case is already covered above; this one exercises the daemon-style invocation explicitly.)
- **Resume restore (F3 — both metadata structures):** (a) a first-start session with `providerProfileName: 'kimi'` writes `providerProfileName === 'kimi'` into its persisted metadata — assert for the PTY path (`SessionSnapshot`) and the batch path (`SessionMetadata`); (b) the restore re-resolves the resumed session to the `kimi` profile even when the on-disk `modelProviders.default` has since changed to `glm-5.2` (the resumed session keeps its original profile) — PTY via `validateResumeSession`+`runPtySession`, batch via `loadSessionMetadata`+`createStandaloneSession`; (c) a resume that also passes `--provider-profile glm-5.2` **warn-ignores** it (the resumed session still uses `kimi`) — assert the warning text and the effective profile; (d) a first-start session with **no** explicit choice persists the then-resolved name (e.g. `'native'`) and a later `default` flip does not re-route the resume; (e) resuming a session whose persisted profile name was since **deleted** hits the unknown-name hard error (documented acceptable behavior).
- **D6 cost accumulation (named test):** `"prefers summed authoritative usage.cost over CLI costUsd when an OpenRouter profile is active"` — drive a Claude Code session whose MITM bus emits two `message_end` events with `usage.cost` values (e.g. `0.012` then `0.008`) while the CLI self-reports `costUsd: 0.5`; assert the session's cumulative cost is `0.020` (the sum), not `0.5`. Add the fallback cases: active profile is native → CLI `costUsd`; observed sum `=== 0` → CLI `costUsd`; no CLI cost → static estimate. This test is part of G6.

**Picker-level test (mux has precedent — `test/mux-input-handler.test.ts`).** The mux input handler is unit-tested by asserting emitted action objects (`handler.handleKey(...) → { kind, ... }`). Add a test in `test/mux-input-handler.test.ts` (or a new `test/mux-provider-picker.test.ts` following the same pattern) that: given a profile snapshot derived from a resolved config with profiles `{ glm-5.2, kimi }` and `default: glm-5.2`, the profile-picker step lists `native` + both profiles with `glm-5.2` marked default, and selecting `kimi` emits a spawn action carrying `providerProfileName: 'kimi'` (which `mux-app` forwards to `createPtyBridge` as `--provider-profile kimi`).

**Argv-append test (F6 — no "if present" hedge; there are NO `createPtyBridge`/`PtyBridgeOptions` tests today, verified).** The child-argv construction is currently **inline** in `createPtyBridge` (`pty-bridge.ts:125-140`, the `spawnArgs` array) and there is no existing test to mirror. **Mandate: extract the argv construction into a testable pure function `buildSpawnArgs(opts: PtyBridgeOptions): string[]`** (moving the `spawnArgs` push logic out of `createPtyBridge`, which then calls it) and add a unit test in `test/pty-bridge.test.ts` asserting that with `providerProfileName: 'kimi'` set, the returned argv contains `'--provider-profile', 'kimi'` (and does not when unset), alongside the existing `--workspace`/`--persona`/`--model` pushes. **On the `--provider-profile` arg-parse in `index.ts`:** `--workspace` parsing itself is **not unit-tested today** (no `index.ts` arg-parse test exists — the only workspace-parse coverage is an integration test), so **no new `index.ts` parse test is required** — the `buildSpawnArgs` pure-function test plus the G12 `ironcurtain start --provider-profile <name>` / `--provider-profile bogus` smoke are the required coverage for the flag path.

### 12.4 Real-Docker integration test (gated on docker) — `test/docker/openrouter-connect.integration.test.ts`

Gated via `INTEGRATION_TEST` + `docker-available` probe (`test/helpers/docker-available.ts`). Host-side fake OpenRouter server bound to the host. Two scenarios, both **zero-token**:

**Scenario A — CONNECT/allowlist/swap proof.** A minimal `curl`-in-container harness (or the existing network-isolation pattern) proves: (a) container CONNECT to `openrouter.ai:443` succeeds through the proxy and reaches the fake upstream over the UDS/MITM path; (b) CONNECT to `api.anthropic.com` is **refused** with an openrouter-type active profile — and that Claude Code **session startup completes** with `api.anthropic.com` unreachable (B2 / G10 assertion); (c) the bearer sentinel is swapped.

**Scenario B — real-agent token-free turn (D8).** Run the **real claude-code container** (existing image) against the host-side fake OpenRouter upstream, which serves a **canned Anthropic-skin SSE completion** (from the §18 fixtures — no real model, no tokens). Assert:
  - (a) the **upstream-observed request body** shows the **rewritten model** (`z-ai/glm-5.2`) + the injected `session_id` (`<sid>:<requestedModel>`);
  - (b) the auth header on the upstream request is the **swapped real key** (`Authorization: Bearer sk-or-v1-<realkey>`), not the sentinel;
  - (c) the agent **turn completes** (exit 0 / a parsed result envelope).
  This exercises the full container→MITM→rewriter→fake-upstream path with a real CLI and spends zero provider tokens.

### 12.5 Opt-in live cache-hit test — `test/docker/openrouter-live.integration.test.ts`

Gated on `OPENROUTER_API_KEY && LLM_INTEGRATION_TEST`. Runs a two-turn Claude Code (or raw `/api/v1/messages`) exchange against real OpenRouter with `providerPreference={only:["z-ai"]}` and asserts the **second** turn's `usage.prompt_tokens_details.cached_tokens > 0`. This is the only test that spends tokens; skipped by default.

### 12.6 Web UI tests

**Wire DTO contract (M5 — masked-key round-trip, per profile).** Specify the two methods' Zod shapes in the spec so the mock server and backend agree. The section is **whole-section** (the `deepMergeConfig` shallow-spread requires it — §6 merge note):

- `config.getModelProviders` — **request:** `{}` (no params). **response** (`GetModelProvidersDto`): `{ default: string; profiles: Record<string, ProfileDto> }` where each `ProfileDto` is the resolved profile with **every openrouter profile's `apiKey` masked** via the `maskApiKey` pattern (`config-command.ts:86` → `sk-...xyz` or `none`). The `native` profile is included (`{ type: 'native' }`, no key). i.e. an openrouter `ProfileDto` = `{ type: 'openrouter', apiKey: <masked>, modelMap, perAgent, providerPreference, sessionAffinity }`.
- `config.setModelProviders` — **request** (`SetModelProvidersDto`): `{ default?: string; profiles: Record<string, ProfileDto> }` — the **whole** profiles record. **`native` key handling (F7 — get/set round-trip asymmetry).** `config.getModelProviders` **returns** the implicit `native` profile in its `profiles` map (`{ type: 'native' }`), so a naive get→edit→set round-trip sends `native` back. Therefore `config.setModelProviders` **ACCEPTS and silently DROPS a `profiles.native` entry whose value is exactly `{ "type": "native" }`** (it is not persisted — `native` is always implicit; dropping it before the `saveUserConfig` write keeps the round-trip working without the frontend having to strip it). It **REJECTS any other value under the `native` key** (e.g. `{ "type": "openrouter", … }` or extra fields) as an RPC validation error, matching the schema's reserved-`native` intent. All non-`native` keys go through the normal Zod validation (including the reserved-name `.refine`, which never fires now because `native` is dropped pre-validation). Per-profile `apiKey` handling is the M5 contract **applied per profile**: **absent / null / equal-to-the-returned-mask → "unchanged"** (keep that profile's stored key), **empty string `""` → "clear"**, any other string → set. **response:** the updated (masked) `GetModelProvidersDto`. Persists the whole `modelProviders` section via `saveUserConfig` (per-profile mask-equality guard prevents a round-trip from clobbering stored keys) and emits `config.changed`. **The mock server mirrors this exactly** (accept-and-drop `{"type":"native"}`, reject any other `native` value).

Backend unit — `src/web-ui/__tests__/config-dispatch.test.ts`:
- `config.getModelProviders` masks every openrouter profile's key; `native` present and key-less.
- `config.setModelProviders` returns `POLICY_MUTATION_FORBIDDEN` when `allowPolicyMutation=false`; when true, persists the whole section via `saveUserConfig` and emits `config.changed` (gate + change-event pattern, per m15/§5-G).
- **M5 round-trip test (per profile):** "save the DTO **without touching any key** (each openrouter profile's `apiKey` = the mask returned by get) preserves every stored real key" — load, get (masked), set-back verbatim, assert each on-disk key is unchanged. **This get→set round-trip includes the `native` entry get returns (F7): setting it back verbatim (`{ "type": "native" }`) succeeds — the entry is silently dropped, not rejected — and does not error.** Also: a profile with `apiKey: ""` clears that profile's key; a new string sets it; a profile omitted from the request is **dropped** (whole-record replace — assert this so the frontend is forced to send the complete set).
- **`native`-key F7 asymmetry test:** `config.setModelProviders` with `profiles.native = { type: 'native' }` is **accepted, drops the `native` entry, and does not persist it**; `profiles.native = { type: 'openrouter', … }` (or any other value) is **rejected** as an RPC error.
- **F10 delete-repoints-default test:** a `config.setModelProviders` whose `profiles` **omits the profile that `default` currently names** persists `modelProviders.default: 'native'` (the backend re-points it in the same write) — assert the on-disk `default` is `'native'`, never the dangling name, and that a subsequent `loadUserConfig` does not throw.
- **Validation passthrough:** `config.setModelProviders` with `default` naming a non-existent profile **in the same request** (i.e. the request itself sets a bad `default`, not the delete-repoint case) is rejected (the same Zod `.refine`), surfaced as an RPC error. (A non-`{type:'native'}` value under `native` is the F7 rejection above; a plain `{type:'native'}` under `native` is accepted-and-dropped, not rejected.)
- Add `'config.getModelProviders'` / `'config.setModelProviders'` to `MethodName` (`web-ui-types.ts:30`) and route via a new `config-dispatch.ts` imported into `json-rpc-dispatch.ts` (the real dispatch entry file — top-level `src/web-ui/json-rpc-dispatch.ts`), adding `if (method.startsWith('config.')) return configDispatch(ctx, method, params, client)` mirroring the `personas.` branch at `json-rpc-dispatch.ts:40`.

Frontend unit + e2e (`packages/web-ui`):
- **M4 — full-field parity, per profile.** The `Settings` view must render a **profile list** with add/edit/delete + a **default selector**, and for each openrouter profile **round-trip ALL fields** of `ResolvedOpenRouterProfile`: `apiKey` (masked field), `modelMap` (add/remove rows), `perAgent` (per-agent slug inputs), `providerPreference` (order/only/allowFallbacks), `sessionAffinity` (toggle). The `native` profile is shown but **not editable or deletable**. The form-round-trip test asserts every field of an edited profile survives a get→edit→set→get cycle, and that unedited profiles are preserved (the view always sends the whole record).
- `mock-ws-server` (`packages/web-ui/scripts/mock-ws-server.ts`) gets canned `config.getModelProviders` / `config.setModelProviders` handlers **mirroring the per-profile M5 mask-unchanged contract exactly** (so the e2e round-trip behaves like production).
- **e2e (m13):** Playwright is present (`packages/web-ui/package.json` script `e2e`); drive the form via `npm run e2e -w packages/web-ui` against the mock server (`POST :7401/__reset`). (If the e2e harness is not wired for this view in time, the form-round-trip unit test is the required coverage and e2e may be deferred — but the `e2e` script is the correct command when included.)

---

## 13. Documentation updates

- **`MODEL_ROUTING.md`** — Add a top section "First-class OpenRouter" pointing here; keep the generic base-URL mechanism; note the OpenRouter path now preserves caching and bills accurately (for Claude Code). **Plus a mandated `## Quickstart: GLM-5.2 via OpenRouter` subsection (M7 / R1)** — the exact fresh-install → working-cached-GLM sequence (G11's grep validates this heading):
  1. Get an OpenRouter key (`sk-or-v1-...`) from openrouter.ai.
  2. Run `ironcurtain config` → **Model Providers** → **Add profile** → type `openrouter`, name it (e.g. `glm-5.2`), paste the key → **Set as default** (or pick it at `/new`).
  3. Done — because D3 defaults the z-ai soft pin and `DEFAULT_MODEL_MAP` maps `*sonnet*`/`*opus*`/`*haiku*` → `z-ai/glm-5.2`, a session on this profile routes Claude Code to cached GLM-5.2 with no further config. Per-session: `ironcurtain start --provider-profile glm-5.2 "…"`, or select it in the mux `/new` profile picker.

  Include the equivalent minimal `config.json` snippet:
  ```json
  { "modelProviders": { "default": "glm-5.2", "profiles": { "glm-5.2": { "type": "openrouter", "apiKey": "sk-or-v1-..." } } } }
  ```
  (with no `modelMap`/`providerPreference`, the defaults apply: GLM mapping + soft z-ai pin + session affinity). Keep the D3 out-of-box caching property front and center.
- **`CONFIG.md`** — Document the `modelProviders` section: the `default` name, the `profiles` record, the `native`/`openrouter` `type` discriminator, the always-present implicit `native` profile, per-openrouter-profile fields + defaults, env `OPENROUTER_API_KEY` (fills every openrouter profile), and the `modelMap: []` per-agent-only mode from D1. **State `default`'s reach explicitly (F2): it applies to ALL Docker Agent Mode sessions — interactive (mux/batch), daemon/cron jobs, signal-bot sessions, web-UI-spawned sessions, and workflow orchestrator bundles** — while the per-session override (`--provider-profile`, the mux `/new` picker) only exists where a surface exposes it. Note `--provider-profile` and the mux `/new` picker as the per-session selection surfaces.
- **`README.md`** — One line under model routing: "Route Docker agents through model-provider profiles (e.g. GLM-5.2 via OpenRouter) with `ironcurtain config` → Model Providers, then pick a profile at `/new` or `--provider-profile`."
- **`src/docker/CLAUDE.md`** — Add `openrouterProvider` to the provider-config bullet; note the **path-aware** `resolveSseProvider` (token stream) AND `providerForHost`/`createReassembler` (trajectory capture); note `isLlmMessagesEndpoint` now matches the `/api/v1/*` OpenRouter paths.
- **Error/quota passthrough note (m10).** Document that OpenRouter's HTTP errors (401 auth, 429 rate/quota) pass through **unchanged** to the agent. Claude Code's quota-reset parsing (`adapters/claude-code.ts:358`, the `QUOTA_RESET_REGEX`) is tuned to Anthropic/litellm phrasing and may not recognize OpenRouter's 429 wording — so a workflow's `quotaExhausted` short-circuit degrades to a **generic error** rather than a timed pause. Accepted for v0.
- **CLAUDE.md "Onboarding a New MCP Server"** is unrelated; no change.

---

## 14. Gates

Each gate: **scope**, **acceptance (observable)**, **validation command(s)**, **dependencies**.

**G1 — Config schema & resolution (`modelProviders` registry).**
Scope: §6 discriminated-union schema (`native`/`openrouter`), the reserved-`native` + `default`-must-exist `.refine`s, `ResolvedProviderProfile`/`ResolvedOpenRouterProfile`, resolution (in `mergeWithDefaults()`, m1 — always-present `native`, `default ?? 'native'`), env precedence (every openrouter profile), `SENSITIVE_FIELDS` (top-level `modelProviders` key, M6), and the pure **active-profile resolver** (`providerProfileName → default → native`; unknown-name throw). `modelProviders` is NOT added to `USER_CONFIG_DEFAULTS`.
Acceptance: §6 two-profile example parses; a user-defined `native` profile is rejected; `default` naming a missing profile is rejected; resolved `profiles` always contains `native`; defaults applied per openrouter profile when fields absent; explicit `modelMap: []` preserved (D1); `OPENROUTER_API_KEY` env beats every profile's config `apiKey`; the `modelProviders` key is **never back-filled by `computeMissingDefaults`**; an **explicitly-set profile `apiKey` DOES persist** via `saveUserConfig` (G8 depends on this); each profile key masked in `computeDiff` (M6); the active-profile resolver returns the right profile for explicit/default/native and throws on an unknown name.
Validate: `npm test -- test/user-config.test.ts` (add cases) ; `npm run lint` ; `npm run build`.
Deps: none.

**G2 — OpenRouter transform module (`src/docker/openrouter.ts`).**
Scope: §7 glob resolution, rewriter (D1 precedence, D3 default pin, D4 session_id keying, m7 no-op), provider factory; `RequestBodyRewriter` context gains `cacheKey`.
Acceptance: all §12.1 unit assertions pass, including the D1 perAgent-beats-modelMap precedence test; `cache_control` preserved; `session_id = <cacheKey>:<requestedModel>` stable/keyed (D4); D3 default z-ai soft pin when `providerPreference` unset; beta stripped; `null` on no-op.
Validate: `npm test -- test/docker/openrouter.unit.test.ts` ; `npm run lint`.
Deps: G1.

**G3 — MITM wiring.**
Scope: pass `cacheKey: sidForToolResults` at `mitm-proxy.ts:1259` (reuse the `:1243` snapshot); path-aware `resolveSseProvider` (§11.1) + its single call site (`mitm-proxy.ts:1022`); path-aware `providerForHost`/`createReassembler` (§11.2); **extend `isLlmMessagesEndpoint` to the three `/api/v1/*` paths (§11.3, M2)**; Anthropic-skin SSE usage extractor reads `cost`/`cached_tokens` (§10.2, in `sse-extractor.ts`).
Acceptance: §12.2 macro tests 1–11 pass end-to-end through the real MITM (incl. test 9 count_tokens passthrough, test 10 reassembly `!= 'unknown'`, test 11 tool_result extraction through the OpenRouter path).
Validate: `npm test -- test/docker/openrouter-mitm.test.ts` ; `npm test -- test/mitm-proxy.test.ts test/mitm-proxy-token-stream.test.ts test/mitm-proxy-extraction.test.ts` (no regressions).
Deps: G2.

**G4 — `resolveRealKey` + infra bundle.**
Scope: `openrouter.ai` case in `resolveRealKey` (`docker-infrastructure.ts:1447`, reads **`config.activeProviderProfile.apiKey`** off the per-session stamped config — no signature change, F1); the profile-resolution-and-stamp as the FIRST step of `prepareDockerInfrastructure`, **before auth detection at `:435`** (F1); `config.activeProviderProfile: ResolvedProviderProfile` added to `IronCurtainConfig` (`src/config/types.ts`, alongside `dockerAuth`); fake-key generation for the new provider host; m5 fail-fast guard.
Acceptance: bundle build with an openrouter-type active profile produces a `ProviderKeyMapping` for `openrouter.ai` with a `sk-or-v1-ironcurtain-` fake key and the real config/env key; fake ≠ real; no OAuth token manager attached (`isManagedOAuthHost` false for `openrouter.ai`); openrouter active profile + empty key → clear throw before container launch (m5).
Validate (m4 — standalone infra test, NOT the G5 session test): add cases to an infra-level test file (`test/docker-infrastructure.test.ts`) exercising `resolveRealKey('openrouter.ai', ...)` and the `ProviderKeyMapping` assembly directly ; `npm test -- test/docker-infrastructure.test.ts` ; `npm run lint`.
Deps: G2.

**G5 — Adapter changes (all three agents).**
Scope: §9 `getProviders` / `buildEnv` / Claude-Code `detectCredential` (B2a) / entrypoint third branch (B2d) / Codex `createCodexAdapter(userConfig)` signature + registry call (m3) + config.toml root-key-first layout (B1) / Goose env; **adapters read the active profile from the per-session stamped `config.activeProviderProfile` (config-stamping, NOT a factory-captured value — F1); the `getProviders(config, authKind?)` and `generateMcpConfig(socketPath, config)` signatures gain `config` (F1)**; D2 slug formulas for Codex (`perAgent.codex ?? DEFAULT_GLM_SLUG`) and Goose (`perAgent.goose ?? resolveMappedModel(gooseModel, modelMap) ?? DEFAULT_GLM_SLUG`); gated on `config.activeProviderProfile.type === 'openrouter'`; native-profile path byte-identical to today.
Acceptance: §12.3 assertions pass (incl. B2c auth-var exclusivity, TOML parsed with `smol-toml`, D2 no-perAgent fallbacks); with a native active profile, existing adapter tests unchanged; real `OPENROUTER_API_KEY` value never in container env.
Validate: `npm test -- test/docker/openrouter-agent-session.test.ts` ; `npm test -- test/docker-agent-adapter.test.ts test/goose-adapter.test.ts test/codex-adapter.test.ts` (existing adapter suites — no `claude-code-adapter.test.ts` exists) ; `npm run lint`.
Deps: G4.

**G6 — Cost accounting.**
Scope: §10 GLM matcher + Anthropic-skin authoritative-cost preference in Docker session (D6 — summed `usage.cost` over CLI `costUsd`; Goose/Codex static in v0).
Acceptance: static estimate resolves for `z-ai/glm-5.2`; the named §12.3 test "prefers summed authoritative usage.cost over CLI costUsd when an OpenRouter profile is active" passes (cumulative = sum of `message_end` cost events, not the CLI self-report); fallback order authoritative-sum → CLI `costUsd` → static holds.
Validate: `npm test -- test/resource-budget-tracker.test.ts` (add GLM case) ; `npm test -- test/docker/openrouter-agent-session.test.ts -t "cost"` ; `npm test -- test/docker/openrouter-mitm.test.ts -t "cost"`.
Deps: G3.

**G7 — CLI editor (`ironcurtain config`) — Model Providers menu.**
Scope: new "Model Providers" top-level menu section — a **profile list** (add / edit / delete openrouter profiles; set default; `native` shown but not editable/deletable). Per-openrouter-profile field editing covers every `ResolvedOpenRouterProfile` field: `apiKey` entry, `modelMap` add/remove (with the `modelMap: []` per-agent-only mode surfaced in help text, D1), `perAgent` defaults (`claude-code`/`goose`/`codex`), `providerPreference` (order/only/allowFallbacks), and `sessionAffinity`. Editing writes the **whole** `modelProviders` section (read-modify-write the full `profiles` record — required by the shallow `deepMergeConfig`). **Delete-repoints-default (F10):** when the user **deletes the profile that `modelProviders.default` currently points to**, the editor **re-points `default` to `'native'` in the same write** — never persisting a `default` that names a missing profile (which would make the next `loadUserConfig` a HARD error, §6/F10). A dedicated `computeDiff` branch for `modelProviders` (mirroring the `serverCredentials`/`webSearch` per-key branches at `config-command.ts:145,160` — **NOT** the generic `nestedSections` loop, which uses reference equality at `config-command.ts:139` and would spuriously diff nested profiles): iterate profiles, mask each `apiKey`, deep-compare (`JSON.stringify`) nested arrays/objects so a no-op edit yields an empty diff (m14); compact modelMap row rendering; keys masked in diff.
Acceptance: adding/editing a profile and saving writes the expected `modelProviders` block (whole `profiles` record); setting default persists `modelProviders.default`; deleting the last openrouter profile leaves `native` intact; **deleting the profile `default` points to re-points `default` to `'native'` in the same write (F10) — the persisted config never has a dangling `default`**; `computeDiff` shows changes with every profile key masked; **a no-op edit produces an empty diff** (m14 test).
Validate: `npm test -- test/config-command.test.ts` (add cases, incl. the no-op-empty-diff test **and the F10 delete-repoints-default test**) ; manual smoke: `printf '\n' | tsx src/cli.ts config` reaches the Model Providers menu without throwing (documented, not automated in CI).
Deps: G1.

**G8 — Web UI backend (`config.*` dispatch).**
Scope: `config.getModelProviders` / `config.setModelProviders` (per-profile M5 masked-key DTO contract, whole-section write, **F7 `native`-key accept-and-drop / reject-other**, **F10 delete-repoints-default: when the request drops the profile `default` names, re-point `default` to `'native'` before persisting**), `MethodName` union (`web-ui-types.ts:30`), new `config-dispatch.ts` imported into the top-level `json-rpc-dispatch.ts` with a `config.` routing branch, `POLICY_MUTATION_FORBIDDEN` gate, `config.changed` event.
Acceptance: §12.6 backend assertions pass, **including the per-profile M5 "save without touching any key preserves the stored keys" round-trip** (per-profile mask-equality = unchanged; `""` = clear; omitted profile = dropped), **the F7 `native`-key asymmetry (accept-and-drop `{type:'native'}`, reject any other `native` value)**, **the F10 delete-repoints-default case (a set that omits the current `default`'s profile persists `default: 'native'`, never a dangling name)**, the validation-passthrough rejection (bad `default`), and the gate-forbidden case.
Validate: `npm test -- src/web-ui/__tests__/config-dispatch.test.ts` ; `npm run lint`.
Deps: G1.

**G9 — Web UI frontend (Settings view — Model Providers).**
Scope: `Settings.svelte` + `ViewId` entry rendering a **profile list** (add/edit/delete openrouter profiles + default selector; `native` shown, not editable/deletable); mock-ws-server handlers mirroring the per-profile M5 contract; unit + e2e.
Acceptance (M4): the form **round-trips every field of an openrouter `ResolvedOpenRouterProfile`** — `apiKey` (masked), `modelMap`, `perAgent`, `providerPreference`, `sessionAffinity` — through a get→edit→set→get cycle; unedited profiles preserved (whole-record send); `native` rendered non-editable; keys rendered masked; save calls `config.setModelProviders`.
Validate: `npm test -w packages/web-ui` ; `npm run build:web-ui` ; (m13) e2e via `npm run e2e -w packages/web-ui` when the Settings-view e2e is wired (else the unit round-trip test is the required coverage and e2e is deferred — do not gate on a non-existent script).
Deps: G8.

**G10 — Docker integration (token-free).**
Scope: §12.4 — Scenario A (CONNECT allowlist + bearer-swap + `api.anthropic.com`-unreachable startup, B2) AND Scenario B (real claude-code container vs fake OpenRouter upstream serving canned Anthropic-skin SSE, D8). Run with an openrouter-type active profile selected.
Acceptance: Scenario A — CONNECT to `openrouter.ai` succeeds and reaches the fake upstream; `api.anthropic.com` refused with the openrouter profile active; Claude Code startup completes with `api.anthropic.com` unreachable. Scenario B (D8) — upstream-observed body shows rewritten model + injected session_id; auth header is the swapped real key; the agent turn completes (exit 0 / parsed result). Zero tokens.
**Report requirement (D7):** the completion report MUST list which environment-gated tests actually **RAN vs SKIPPED** (a docker-unavailable environment skips G10 — record that explicitly rather than reporting a vacuous pass).
Validate: `INTEGRATION_TEST=1 npm test -- test/docker/openrouter-connect.integration.test.ts` (skips when docker unavailable).
Deps: G5, G13.

**G13 — Session-selection plumbing + `/new` picker + `--provider-profile`.**
Scope: § "Session-selection plumbing" — `providerProfileName` through `SessionOptions` (the field goes next to `workspacePath` at `src/session/types.ts:421`, within the `SessionOptions` interface that opens at `:361`) and `PtySessionOptions` (`pty-session.ts:40`) into `prepareDockerInfrastructure`; the active-profile resolution-and-stamp point as the FIRST step of infra prep (calls the G1 resolver, stamps `config.activeProviderProfile`, throws on unknown name before container launch — F1); `ironcurtain start --provider-profile <name>` (`src/index.ts` option table + threading into both `runPtySession` and `createStandaloneSession`); the mux `/new` profile-picker step (`mux-input-handler`/`mux-app` action carrying `providerProfileName`) → `buildSpawnArgs`/`createPtyBridge` argv append `--provider-profile <name>` (`pty-bridge.ts`, next to `--workspace`/`--persona`/`--model`); **mux config-load seam (F5): `MuxAppOptions` / `/new` loads the resolved config so the picker has a profile snapshot**; **resume restore (F3): `providerProfileName` persisted in BOTH `SessionSnapshot` (PTY, `pty-types.ts:27-44`) and `SessionMetadata` (batch, `session/types.ts:121-136`) and restored on resume in both paths, warn-ignoring a conflicting `--provider-profile`**.
Acceptance: §12.3 selection-plumbing assertions pass (explicit profile used; unset → default; native → no OpenRouter env; unknown → throw with available-profiles list); **the F1 cross-session-isolation assertion passes (two sessions, one process, distinct profiles, no leakage)**; **the F2 non-interactive default-reach assertion passes (daemon-style invocation with no `providerProfileName` applies `modelProviders.default`)**; **the F3 resume assertions pass for BOTH metadata structures (`SessionSnapshot` PTY + `SessionMetadata` batch): resumed session keeps its original persisted profile name; a conflicting `--provider-profile` on resume is warn-ignored; a `default` change after start does not alter the resumed session)**; the picker-level test (§12.3) emits a spawn action with the chosen `providerProfileName`; the `buildSpawnArgs` unit test asserts `--provider-profile <name>` is appended (F6); `--provider-profile` on `start` threads to the resolved active profile in both PTY and batch paths.
Validate: `npm test -- test/mux-input-handler.test.ts` (add picker case) ; `npm test -- test/pty-bridge.test.ts` (new — `buildSpawnArgs` unit test, F6) ; `npm test -- test/docker/openrouter-agent-session.test.ts -t "profile"` ; `npm run lint`. (No live tokens — all resolution/selection is pre-container.)
Deps: G5.

**G11 — Documentation.**
Scope: §13 doc edits, including the mandated `## Quickstart: GLM-5.2 via OpenRouter` heading (M7) and the m10 error-passthrough note.
Acceptance: `MODEL_ROUTING.md` (incl. the Quickstart heading), `CONFIG.md`, `README.md`, `src/docker/CLAUDE.md` updated; grep proves the sections exist.
Validate: `grep -q "First-class OpenRouter" MODEL_ROUTING.md && grep -q "Quickstart: GLM-5.2 via OpenRouter" MODEL_ROUTING.md && grep -q '"modelProviders"' CONFIG.md`.
Deps: G1–G10, G13 substantially complete.

**G12 — Full-feature revalidation (final gate).**
Scope: whole feature green.
Acceptance: full suite passes; lint + format clean; build (incl. web UI) succeeds; `ironcurtain config` smoke reaches the Model Providers menu; `ironcurtain start --provider-profile <name>` selects the profile and `--provider-profile bogus` errors clearly; no native-profile regressions.
**Report requirements (D7):**
- The completion report MUST list which environment-gated tests actually **RAN vs SKIPPED** (same wording as G10 — fixes the vacuous-pass problem).
- **R6 live verification:** if `OPENROUTER_API_KEY` is present in the implementing environment, run the §12.5 live test **once** and record `cached_tokens > 0`; otherwise record the skip explicitly as **"R6 live verification: SKIPPED (no key)"**.
Validate: `npm run format:check && npm run lint && npm run build && npm test`.
Deps: G1–G11, G13.

**Opt-in (not part of CI gating):** live cache-hit — `OPENROUTER_API_KEY=... LLM_INTEGRATION_TEST=1 npm test -- test/docker/openrouter-live.integration.test.ts` asserts `cached_tokens > 0` on turn 2 (this is the test G12's R6 verification runs when a key is present).

---

## 15. Implementation order (for the autonomous agent)

1. **G1** config schema/resolution + active-profile resolver (foundation; everything reads it).
2. **G2** `src/docker/openrouter.ts` transform module + rewriter-context change (pure, fully unit-tested).
3. **G3** MITM wiring (cacheKey threading, path-aware SSE, usage extraction) + macro tests.
4. **G4** `resolveRealKey` + infra bundle fake/real key for `openrouter.ai`.
5. **G5** adapters (Claude Code, then Codex, then Goose), reading `config.activeProviderProfile` (config-stamped, not factory-bound — F1).
6. **G13** session-selection plumbing (`providerProfileName` threading, `--provider-profile`, `/new` picker) — resolves + stamps `config.activeProviderProfile` in infra prep (F1) and unblocks G10's profile-selected run.
7. **G6** cost accounting.
8. **G7** CLI editor (Model Providers menu).
9. **G8** web UI backend, then **G9** frontend.
10. **G10** docker integration.
11. **G11** docs.
12. **G12** full revalidation.

Rationale: pure/testable core first (G1–G2), then the security-critical MITM plumbing (G3–G4) with its macro oracle, then the agent-facing surface (G5) and its selection plumbing (G13), then peripheral concerns (cost/UI/docs). Each gate is independently validatable and depends only on earlier gates.

---

## 16. Out of scope

- **Per-persona profile binding.** Binding a provider profile to a persona is deferred. It collides with workflow **shared-container mode**: the MITM provider registry, the rewriter config, and the container env (`ANTHROPIC_BASE_URL`, fake keys) are all fixed at **bundle creation**, and only **policy** hot-swaps between personas via the control server (`src/trusted-process/control-server.ts`) — there is **no provider/env hot-swap seam**. Selecting a profile per persona would require either a bundle per persona (defeats shared-container) or a MITM re-provision mid-run (does not exist). v1 keeps selection at session/bundle granularity, which standalone sessions own cleanly (§9.7). See §5-C's deferred note.
- **Provider types beyond `native` / `openrouter`.** The `type` discriminator (§6) is the extension point. **Z.ai-direct** is the natural next type — same bearer + Anthropic-skin pattern, so it slots in as a new discriminated-union member + a new `makeXProvider`/rewriter without touching selection plumbing. Not built in v1.
- Code Mode routing through OpenRouter (use `openaiBaseUrl` today).
- Multi-provider cost-optimized routing / fallback chains beyond the single `provider` preference.
- Streaming wire-format transcoding (we rely on OpenRouter's native per-agent endpoints).
- Rewriting `cache_control` semantics for non-GLM slugs.
- Encryption-at-rest of the profile API key beyond `0600` perms.
- Auto-detecting the "best" GLM provider endpoint (we pin `z-ai` via profile config when caching is required).
- OpenRouter attribution headers (`HTTP-Referer` / `X-Title`) — optional; not injected in v0 (can be added to `buildEnv` for Goose later if desired).

---

## 17. Open questions

None. Resolved during design:

- *Config shape* → a **named profile registry** `modelProviders.profiles` (discriminated union on `type`: `native`/`openrouter`) with an implicit always-present `native` profile and a `default` name; enablement = the active profile's type is `openrouter`. No global `enabled` toggle, no released `openrouter` shape to migrate from (§5-C, §6).
- *Per-session selection* → resolved once at session/bundle creation from `providerProfileName` (explicit) → `modelProviders.default` → `native`, surfaced via `ironcurtain start --provider-profile <name>` and the mux `/new` profile picker (both thread through the same `--provider-profile` argv seam that `--workspace` uses), §9.7 / G13.
- *`saveUserConfig` deeper shape* → `deepMergeConfig` is one-level-deep (verified `user-config.ts:860`), so the `profiles` record is replaced wholesale on write; both editors write the whole `profiles` record (acceptable — matches how sections are written today), §6 merge note.
- *Auth scheme for Claude Code* → `ANTHROPIC_AUTH_TOKEN` (bearer), not `ANTHROPIC_API_KEY` (§4.2, §9.1).
- *One host, three wire formats* → per-agent `openrouterProvider` variants + path-aware classification in BOTH the token-stream tap (`resolveSseProvider`) AND trajectory capture (`providerForHost`/`createReassembler`), plus `isLlmMessagesEndpoint` extended to the `/api/v1/*` paths (§7.4, §11).
- *Where session_id comes from* → the proxy's `tokenSessionId` (as `cacheKey`) combined with the requested model id as `${cacheKey}:${requestedModelId}` (D4), threaded into the rewriter context via the new `cacheKey` field (§7.2, D).
- *Telemetry endpoints* → not allowlisted when the active profile is openrouter-type; Claude Code tolerates their absence (§5-B); startup completes with `api.anthropic.com` unreachable (G10).
- *Cost correctness* → prefer the summed authoritative `usage.cost` from the Anthropic-skin response over the CLI self-report (Claude Code); Goose/Codex static in v0 (§10, D6).
- *Caching out-of-box* → D3 defaults the z-ai soft pin + `DEFAULT_MODEL_MAP`, so an openrouter profile with just a key is sufficient (§5-D, quickstart M7).

---

## 18. Appendix A — Verbatim terminal SSE usage fixtures (normative)

These are the **normative** field shapes for the §12.2 canned-SSE fixtures — do not invent field names. The JSON **field names** below are normative (values are illustrative). Sources: OpenRouter usage accounting (§4.4). All three carry `usage` with `cost`, `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`.

**A.1 Anthropic-skin (`/api/v1/messages`) — terminal `message_delta` with usage (the path we extract, D6).**
```
event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":1024,"output_tokens":128,"cache_read_input_tokens":900,"prompt_tokens_details":{"cached_tokens":900},"cost":0.0123,"cost_details":{"cache_discount":0.0041}}}

event: message_stop
data: {"type":"message_stop"}
```
(Note the Anthropic-native usage keys `input_tokens`/`output_tokens`/`cache_read_input_tokens` coexist with the OpenRouter additions `prompt_tokens_details.cached_tokens` and `cost` — extract `cost` and `prompt_tokens_details.cached_tokens`.)

**A.2 Chat Completions (`/api/v1/chat/completions`, Goose) — final chunk + `[DONE]` (raw-capture only in v0).**
```
data: {"id":"gen-x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1024,"completion_tokens":128,"prompt_tokens_details":{"cached_tokens":900},"cost":0.0123,"cost_details":{"cache_discount":0.0041}}}

data: [DONE]
```

**A.3 Responses (`/api/v1/responses`, Codex) — terminal `response.completed` event (raw-capture only in v0).**
```
event: response.completed
data: {"type":"response.completed","response":{"id":"resp_x","status":"completed","usage":{"input_tokens":1024,"output_tokens":128,"input_tokens_details":{"cached_tokens":900},"cost":0.0123,"cost_details":{"cache_discount":0.0041}}}}
```

Keep-alive comment lines (`: OPENROUTER PROCESSING`) may be interleaved anywhere between events in all three fixtures (§12.2 test 7). For the D8/§12.4 Scenario B fixture, the fake upstream serves A.1 as the full Anthropic-skin completion so the real claude-code CLI parses a valid result.
