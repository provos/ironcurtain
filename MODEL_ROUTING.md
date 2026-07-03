# Model Routing

IronCurtain supports redirecting LLM API traffic to a custom upstream — an OpenAI-compatible gateway like [LiteLLM](https://docs.litellm.ai/) fronting [OpenRouter](https://openrouter.ai/), a regional Anthropic endpoint, or a corporate proxy. The same configuration works in both Code Mode and Docker Agent Mode.

## First-class OpenRouter

For OpenRouter specifically there is a dedicated, no-external-proxy path: **named provider profiles**. A profile is a _model preset_ — "run this session on GLM", "on Kimi" — that routes a Docker agent (Claude Code, Codex, Goose) straight through `openrouter.ai` with a bound model map and key, **no LiteLLM sidecar**. See [docs/designs/openrouter-integration.md](docs/designs/openrouter-integration.md) for the full design.

Profiles live in the `modelProviders` section of `~/.ironcurtain/config.json` (see [CONFIG.md](CONFIG.md#model-providers-first-class-openrouter)). An implicit `native` profile — today's canonical Anthropic / OpenAI / ChatGPT routing — is always present and is the fallback.

There are three selection surfaces:

- **Global default** — `modelProviders.default`. Applies to every Docker Agent Mode session that makes no per-session choice (interactive `mux`/`start`, daemon/cron jobs, signal-bot, web-UI-spawned sessions, and workflow orchestrator bundles).
- **`ironcurtain start --provider-profile <name>`** — per-session override for batch and PTY runs.
- **mux `/new` profile picker** — pick a preset when spawning an interactive session; it is rendered as `<name> → <slug> (OpenRouter)` (or `native → Anthropic / OpenAI / ChatGPT`).

**Caching is preserved.** When a mapped slug is `z-ai/*` and no `providerPreference` is set, the MITM injects a default soft pin `provider: { order: ["z-ai"] }` (D3) plus a stable top-level `session_id` for cache affinity (session affinity is on by default) — so GLM-through-Claude-Code gets implicit prompt caching out of the box, unlike the LiteLLM base-URL path where caching silently drops. **Cost bills accurately** for Claude Code: the authoritative OpenRouter `usage.cost` is preferred over the CLI's self-report (Goose/Codex fall back to the static estimate in v0).

The generic base-URL mechanism below (`anthropicBaseUrl` etc. + LiteLLM) **remains the escape hatch** for any other gateway (Bedrock, a regional endpoint, or a non-OpenRouter provider). When an OpenRouter profile is active it takes precedence over `anthropicBaseUrl` for that session; the base-URL override only applies to sessions on the `native` profile.

### Quickstart: GLM-5.2 via OpenRouter

Fresh install → working, cached GLM in four steps:

1. Get an OpenRouter API key (`sk-or-v1-...`) from [openrouter.ai](https://openrouter.ai/).
2. Run `ironcurtain config` → **Model Providers** → **Add profile...** → choose type `openrouter`, name it (e.g. `glm-5.2`), and paste the key.
3. **Set default** to that profile (or pick it later at the mux `/new` picker, or pass `--provider-profile glm-5.2`).
4. Done. Because `DEFAULT_MODEL_MAP` maps `*opus*` / `*sonnet*` / `*haiku*` → `z-ai/glm-5.2` and D3 injects the soft z-ai pin, a session on this profile routes Claude Code to cached GLM-5.2 with no further config.

Per-session instead of default:

```bash
ironcurtain start --provider-profile glm-5.2 "your task"
```

The equivalent minimal `config.json` — no `modelMap` / `providerPreference` needed; the defaults supply GLM mapping + soft z-ai pin + session affinity:

```json
{
  "modelProviders": {
    "default": "glm-5.2",
    "profiles": { "glm-5.2": { "type": "openrouter", "apiKey": "sk-or-v1-..." } }
  }
}
```

**Errors pass through unchanged (m10).** OpenRouter's HTTP errors — 401 (auth) and 429 (rate/quota) — reach the agent verbatim. Claude Code's quota-reset parsing is tuned to Anthropic/LiteLLM phrasing and may not recognize OpenRouter's 429 wording, so a workflow's quota-exhausted short-circuit degrades to a **generic error** rather than a timed pause. Accepted for v0.

## Configuration

Set either an environment variable or the corresponding field in `~/.ironcurtain/config.json`. Env vars take precedence.

| Provider  | Environment variable  | `config.json` field |
| --------- | --------------------- | ------------------- |
| Anthropic | `ANTHROPIC_BASE_URL`  | `anthropicBaseUrl`  |
| OpenAI    | `OPENAI_BASE_URL`     | `openaiBaseUrl`     |
| Google    | `GOOGLE_API_BASE_URL` | `googleBaseUrl`     |

Values must be `http://` or `https://` URLs (e.g. `http://localhost:4000`).

`platform.claude.com` (Claude Code OAuth metadata) is intentionally not redirectable.

## How it works

In **Code Mode**, the AI SDK connects directly to the override — no MITM involved.

In **Docker Agent Mode**, the agent's client still talks to the canonical host (`api.anthropic.com`, etc.) over a trusted TLS channel; the MITM decrypts, swaps the fake sentinel key for the real host-side key, then forwards to the override instead of the canonical host. The agent itself sees nothing unusual.

## Recipe: LiteLLM + OpenRouter

> For OpenRouter, prefer the first-class **provider profiles** above — no sidecar, caching preserved, accurate cost. This recipe remains the escape hatch for other gateways (Bedrock, a regional Anthropic endpoint, a corporate proxy) or for routing Code Mode, which the OpenRouter profiles do not cover.

LiteLLM accepts Anthropic-style `/v1/messages` requests and translates them to any backend. With OpenRouter you get hundreds of models under one key.

### 1. Install the proxy

```bash
mkdir -p ~/src/litellm && cd ~/src/litellm
python3 -m venv venv
./venv/bin/pip install --upgrade pip 'litellm[proxy]'
```

### 2. Configure models

Write `~/src/litellm/config.yaml`. The `model_name` entries on the left must match whatever model IDs IronCurtain will ask for (`agentModelId`, `policyModelId`, workflow overrides, etc.).

```yaml
model_list:
  - model_name: claude-opus-4-7
    litellm_params:
      model: openrouter/z-ai/glm-5.1
      api_key: os.environ/OPENROUTER_API_KEY

  - model_name: claude-sonnet-4-6
    litellm_params:
      model: openrouter/z-ai/glm-5.1
      api_key: os.environ/OPENROUTER_API_KEY

  - model_name: claude-haiku-4-5-20251001
    litellm_params:
      model: openrouter/z-ai/glm-5.1
      api_key: os.environ/OPENROUTER_API_KEY

litellm_settings:
  drop_params: true # silently drop params the backend doesn't support
```

### 3. Start the proxy

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
./venv/bin/litellm --config ./config.yaml --port 4000
```

### 4. Point IronCurtain at it

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
ironcurtain mux
```

Or set `anthropicBaseUrl` in `~/.ironcurtain/config.json` for persistence. One-shot `ironcurtain start "your task"` runs use the same routing when you need a scriptable check.

### 5. Verify

```bash
curl http://localhost:4000/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: anything' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-sonnet-4-6","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'
```

You should get an Anthropic-shaped response back.

## Alternative: direct provider endpoints

Some providers expose an Anthropic-compatible endpoint directly, skipping LiteLLM. [Z.ai's GLM API](https://docs.z.ai/devpack/tool/claude#manual-configuration) is the reference example:

```bash
export ANTHROPIC_API_KEY=<your-zai-key>
export ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
```

Z.ai's docs show `ANTHROPIC_AUTH_TOKEN` (bearer), but their endpoint also accepts `x-api-key`, which is what IronCurtain sends. If you point `ANTHROPIC_BASE_URL` at a third-party that _only_ accepts bearer auth, requests will 401 — put LiteLLM in front to translate.

## Key behaviors

**API key forwarding.** The MITM forwards the host-side `ANTHROPIC_API_KEY` (or OpenAI/Google equivalent) as the auth header. If your gateway enforces its own auth (e.g. LiteLLM's `master_key`), it must either be unset or match `ANTHROPIC_API_KEY`.

**Endpoint allowlist (Docker Agent Mode).** Only `POST /v1/messages` and `/v1/messages/count_tokens` are forwarded to Anthropic-family targets. LiteLLM serves both by default.

**Cost caps bill at the model ID.** `resourceBudget.maxEstimatedCostUsd` uses IronCurtain's cost tables keyed off the model name the agent asked for, not the actual backend. If you route `claude-opus-4-7` to something cheaper, the cost tracker still bills at Opus rates — raise or disable (`null`) the cap accordingly.

## Gotchas

- **Non-Anthropic backends lose Anthropic-native features.** Prompt caching, thinking blocks, 1M-context behavior, and server-side tools (web search, computer use) don't survive the round-trip. Calls still succeed; capabilities silently drop.
- **Weak tool use breaks the agent loop.** IronCurtain relies heavily on tool calling. Models with flaky tool-use support thrash rather than fail cleanly — test with a short task first.

## Troubleshooting

**"model not found" / 404.** A `model_name` in `config.yaml` doesn't match what IronCurtain sent. Check `agentModelId` (and any persona/workflow/auto-approve overrides) and add the missing ID to `model_list`.

**401 at the gateway.** The MITM is forwarding your real `ANTHROPIC_API_KEY`; if LiteLLM's `master_key` is set, it must match that value. Simplest fix: unset `master_key`.

**Override isn't taking effect (Docker Agent Mode).** Session logs should show `[docker] Anthropic: upstream override via ANTHROPIC_BASE_URL → http://localhost:4000`. If it's missing, the env var isn't set where IronCurtain was launched. If you see `ignoring invalid ...` instead, the URL is malformed.

**Override isn't taking effect (Code Mode).** `ANTHROPIC_BASE_URL` must be set in the shell that launches `ironcurtain` (or placed in `.env` at the project root).

## See also

- [docs/designs/openrouter-integration.md](docs/designs/openrouter-integration.md) — first-class OpenRouter provider-profile design
- [CONFIG.md](CONFIG.md) — full `~/.ironcurtain/config.json` reference
- [RUNNING_MODES.md](RUNNING_MODES.md) — Code Mode vs Docker Agent Mode
- [LiteLLM proxy docs](https://docs.litellm.ai/docs/proxy/configs)
- [OpenRouter models](https://openrouter.ai/models)
