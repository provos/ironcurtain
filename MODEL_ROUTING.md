# Model Routing

IronCurtain supports redirecting LLM API traffic to a custom upstream — an OpenAI-compatible gateway, a regional Anthropic endpoint, a corporate proxy, or an aggregator like [LiteLLM](https://docs.litellm.ai/) fronting [OpenRouter](https://openrouter.ai/). This lets you:

- Route to models not offered by the canonical provider (e.g. GLM, DeepSeek, Llama)
- Centralize billing, quotas, and logging across many agents
- Develop against a local mock during testing

Both running modes honor the same configuration, so the redirect works whether you use the builtin Code Mode agent or Docker Agent Mode.

## Configuration

Set either an environment variable or the corresponding field in `~/.ironcurtain/config.json`. Env vars take precedence.

| Provider  | Environment variable  | `config.json` field |
| --------- | --------------------- | ------------------- |
| Anthropic | `ANTHROPIC_BASE_URL`  | `anthropicBaseUrl`  |
| OpenAI    | `OPENAI_BASE_URL`     | `openaiBaseUrl`     |
| Google    | `GOOGLE_API_BASE_URL` | `googleBaseUrl`     |

Values must be full URLs, e.g. `http://localhost:4000` or `https://gateway.internal/anthropic`. Only `http://` and `https://` are accepted.

`platform.claude.com` (Claude Code OAuth usage endpoints) is intentionally not redirectable — OAuth metadata must go to the real platform host.

## How it works

**Code Mode (builtin agent).** The agent uses the Vercel AI SDK. The base URL is passed directly to the provider factory (`createAnthropic`, `createOpenAI`, `createGoogleGenerativeAI`), so the SDK opens the connection straight to your override. No MITM is involved.

**Docker Agent Mode.** The agent runs in a container with no network egress — all outbound traffic goes through IronCurtain's TLS-terminating MITM proxy on a mounted socket. The MITM still intercepts connections to the canonical host (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`) so the agent's unmodified client keeps working — but once decrypted, the request is forwarded to the override host instead. The real API key is injected on the way out, so your gateway receives traffic indistinguishable from a direct call.

Either way, the agent itself doesn't need to know anything has changed.

## Recipe: LiteLLM + OpenRouter

LiteLLM can accept Anthropic-style `/v1/messages` requests and translate them to any backend. Combined with OpenRouter you get access to hundreds of models under one key.

### 1. Install the proxy

```bash
mkdir -p ~/src/litellm && cd ~/src/litellm
python3 -m venv venv
./venv/bin/pip install --upgrade pip 'litellm[proxy]'
```

### 2. Configure models

Write `~/src/litellm/config.yaml`. The `model_name` entries on the left are what IronCurtain will ask for — they must match whatever your `agentModelId` (and any other model IDs) resolves to.

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

general_settings:
  # Uncomment to require clients to send this as the bearer / x-api-key.
  # master_key: sk-local-change-me
```

### 3. Start the proxy

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
./venv/bin/litellm --config ./config.yaml --port 4000
```

### 4. Point IronCurtain at it

Either export the env var before running:

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
ironcurtain start "your task"
```

…or set it persistently via `ironcurtain config` or in `~/.ironcurtain/config.json`:

```json
{
  "anthropicBaseUrl": "http://localhost:4000"
}
```

That's it. The agent sends requests to LiteLLM, which forwards them to OpenRouter, which routes to GLM (or whichever model you mapped). The same config applies to Docker Agent Mode — no extra plumbing.

### 5. Verify

```bash
curl http://localhost:4000/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: anything' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 64,
    "messages": [{"role":"user","content":"ping"}]
  }'
```

You should get an Anthropic-shaped response back.

## Key behaviors

**The real API key flows through.** The MITM injects your host-side `ANTHROPIC_API_KEY` (or OpenAI/Google equivalent) as the auth header on the forwarded request. If the gateway enforces its own auth via `master_key`, set that value to exactly match `ANTHROPIC_API_KEY`. Simpler: leave `master_key` unset and let the gateway accept the passthrough.

**Endpoint filtering still applies (Docker Agent Mode).** Even with a redirect, only paths in the provider's allowlist are forwarded. For Anthropic that's `POST /v1/messages`, `POST /v1/messages/count_tokens`, and Claude Code's internal metadata endpoints. LiteLLM serves `/v1/messages` by default, so this is transparent.

**Server-side tool stripping still runs (Docker Agent Mode).** Anthropic-native server-side tools (web search, computer use) are stripped from `/v1/messages` bodies before forwarding, because the gateway can't execute them. Custom/MCP tools pass through untouched.

**Model IDs must match on both sides.** Every model the agent might ask for — `agentModelId`, `policyModelId`, `autoApprove.modelId`, `autoCompact.summaryModelId`, workflow `model:` overrides — needs a matching `model_name` entry in `model_list`, or the gateway returns "model not found". The simplest scheme is to map every Anthropic ID you use to a single backend model, as above.

**Use the `:cloud`-style suffix if you need Ollama routing.** Workflow YAML accepts loose model IDs like `glm-5.1:cloud` that the strict config validator rejects. LiteLLM can serve these by listing them as `model_name` entries pointing to whatever backend slug you want.

**Cost caps still count.** `resourceBudget.maxEstimatedCostUsd` uses IronCurtain's own per-token cost tables, keyed off the model name the agent asked for (not the backend route). If you're routing `claude-opus-4-7` to a cheaper model, the cost tracker will still bill at Opus rates — disable the cost cap (`null`) or raise it accordingly.

## Gotchas

- **Non-Anthropic backends lose features.** Prompt caching, thinking blocks, fine-grained tool-use streaming, and 1M-context behavior are Anthropic-native. Routing a Claude model ID through LiteLLM to, say, GLM silently drops those — calls still succeed, but the agent loses capabilities. Test with a short task before a long run.
- **Weak tool use wrecks the agent loop.** IronCurtain depends heavily on tool calling. Backend models with flaky tool-use support will thrash rather than fail cleanly.
- **Streaming edge cases.** LiteLLM synthesizes Anthropic-style SSE events from the upstream stream. It works in practice but has occasionally been a source of bugs — if the agent stalls mid-response, try `litellm_settings.drop_params: true` plus the backend's non-streaming endpoint first.
- **HTTP vs HTTPS.** Both schemes work. `http://localhost:4000` is fine for a local proxy. In Docker Agent Mode, the MITM opens the override connection from the host's network, so `localhost` reaches a proxy on the host — no extra exposure needed.
- **Claude Platform OAuth is not redirected.** Session heartbeats to `platform.claude.com/v1/oauth/hello` always go to the canonical host. If you're using OAuth (`CLAUDE_CODE_OAUTH_TOKEN`), the gateway only sees `/v1/messages` traffic, not OAuth lifecycle traffic.

## Troubleshooting

**"model not found" / 404 from the gateway.** The `model_name` entries in `config.yaml` don't match what IronCurtain is sending. Check `agentModelId` in `~/.ironcurtain/config.json` (and workflow YAML, persona configs, etc.). Add the missing ID to `model_list`.

**401 / auth failures at the gateway.** The MITM is forwarding the real `ANTHROPIC_API_KEY`; if LiteLLM has `master_key` set, it must match. Either unset `master_key`, change it to match `ANTHROPIC_API_KEY`, or change `ANTHROPIC_API_KEY` to the master key value.

**Request succeeds but agent behaves oddly.** The backend is a different model family than Claude — tool-use formatting, stop sequences, or system-prompt handling may differ. Test with `curl` first, then try a simple IronCurtain task with verbose logging.

**Override isn't taking effect (Docker Agent Mode).** Check the daemon/session logs for a line like `[docker] Anthropic: upstream override via ANTHROPIC_BASE_URL → http://localhost:4000`. If it's missing, the env var isn't set in the environment where IronCurtain is running. If the URL is malformed, you'll see `ignoring invalid ...` instead; fix the value.

**Override isn't taking effect (Code Mode).** `ANTHROPIC_BASE_URL` must be set in the shell that launches `ironcurtain start` (or the daemon). `.env` loaded via `dotenv/config` at `src/index.ts` covers this for installed binaries.

## See also

- [CONFIG.md](CONFIG.md) — full `~/.ironcurtain/config.json` reference
- [RUNNING_MODES.md](RUNNING_MODES.md) — Code Mode vs Docker Agent Mode
- [WORKFLOWS.md](WORKFLOWS.md) — per-state model overrides
- [LiteLLM proxy docs](https://docs.litellm.ai/docs/proxy/configs)
- [OpenRouter models](https://openrouter.ai/models)
