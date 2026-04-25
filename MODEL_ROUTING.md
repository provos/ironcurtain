# Model Routing

IronCurtain supports redirecting LLM API traffic to a custom upstream — an OpenAI-compatible gateway like [LiteLLM](https://docs.litellm.ai/) fronting [OpenRouter](https://openrouter.ai/), a regional Anthropic endpoint, or a corporate proxy. The same configuration works in both Code Mode and Docker Agent Mode.

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
ironcurtain start "your task"
```

Or set `anthropicBaseUrl` in `~/.ironcurtain/config.json` for persistence.

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

- [CONFIG.md](CONFIG.md) — full `~/.ironcurtain/config.json` reference
- [RUNNING_MODES.md](RUNNING_MODES.md) — Code Mode vs Docker Agent Mode
- [LiteLLM proxy docs](https://docs.litellm.ai/docs/proxy/configs)
- [OpenRouter models](https://openrouter.ai/models)
