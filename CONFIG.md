# Configuration Reference

IronCurtain is configured through `~/.ironcurtain/config.json`. All fields are optional — missing fields use sensible defaults.

## Quick Start

```bash
# Interactive editor
ironcurtain config

# Or edit JSON directly
$EDITOR ~/.ironcurtain/config.json
```

## Models

| Field           | Type   | Default                       | Description                                                          |
| --------------- | ------ | ----------------------------- | -------------------------------------------------------------------- |
| `agentModelId`  | string | `anthropic:claude-sonnet-4-6` | LLM for the agent. Format: `provider:model-name` or bare model name. |
| `policyModelId` | string | `anthropic:claude-sonnet-4-6` | LLM for policy compilation.                                          |

Supported providers: `anthropic`, `google`, `openai`.

## Security

| Field                      | Type    | Default                      | Description                                                                  |
| -------------------------- | ------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `escalationTimeoutSeconds` | integer | `300`                        | Seconds to wait for human approval on escalated tool calls. Range: 30–600.   |
| `autoApprove.enabled`      | boolean | `false`                      | Let an LLM auto-approve escalated tool calls instead of waiting for a human. |
| `autoApprove.modelId`      | string  | `anthropic:claude-haiku-4-5` | Model used for auto-approval decisions.                                      |

### Network destination screening

IronCurtain screens every proxy destination again after DNS resolution. Localhost, `.local`, `.internal`,
`.docker.internal`, private/link-local/metadata addresses, empty answer sets, and mixed public/private
answer sets are rejected even when a passthrough domain was approved. This prevents DNS rebinding and
SSRF into the host or VPN network. It also means internal registries and split-DNS names that resolve to
private addresses are intentionally unavailable from ordinary sessions.

Agent images do not bake in a user-specific IronCurtain CA. Each ephemeral container installs the
session-mounted public CA into its system trust store at startup and also receives tool-specific trust
environment variables. The first Docker Agent session after this upgrade may rebuild its agent image.

## Resource Limits

All budget fields are nullable — set to `null` to disable the limit.

| Field                                 | Type            | Default   | Description                                                                |
| ------------------------------------- | --------------- | --------- | -------------------------------------------------------------------------- |
| `resourceBudget.maxTotalTokens`       | integer \| null | `1000000` | Maximum tokens (input + output) per session.                               |
| `resourceBudget.maxSteps`             | integer \| null | `200`     | Maximum agent steps per session.                                           |
| `resourceBudget.maxSessionSeconds`    | number \| null  | `1800`    | Wall-clock timeout in seconds.                                             |
| `resourceBudget.maxEstimatedCostUsd`  | number \| null  | `5.0`     | Estimated cost cap in USD.                                                 |
| `resourceBudget.warnThresholdPercent` | integer         | `80`      | Emit a warning when this percentage of any limit is consumed. Range: 1–99. |

## Nested Docker Workloads

Docker Agent sessions can expose a private Docker daemon to the agent. The capability is off unless
`dockerWorkload.enabled` is true. Configure it with `ironcurtain config` → **Docker Agent** →
**Nested Docker**, in web Settings, or with this JSON:

```json
{
  "dockerWorkload": {
    "enabled": true,
    "networkAccess": "packages"
  }
}
```

Fresh CLI and web enablement explicitly selects `packages`, which supports mediated Docker Hub/GHCR pulls
plus fixed public apt, npm, PyPI, and Cargo downloads through a TLS-terminating MITM proxy. It does not
provide arbitrary `curl`, Git, private registries, authenticated package sources, uploads, or generic web
access. Package responses, caches, built images, and image contents remain untrusted.

Packages permits any process in this nested-Docker session to send bounded workspace or build data through
allowed package paths, permitted request metadata, and timing to fixed public repositories, and to download
untrusted content. IronCurtain does not inject credentials and rejects recognized credential fields and
request bodies. It screens the immediate peer, but a public repository may relay or hairpin elsewhere; use
Images only or Offline to remove this route.

Set `networkAccess` to `images` for mediated Docker Hub/GHCR pulls without Dockerfile `RUN` networking, or
to `offline` to use only images already available to the private runtime:

```json
{
  "dockerWorkload": {
    "enabled": true,
    "networkAccess": "offline"
  }
}
```

| Field                          | Type            | Default when enabled     | Description                                                                        |
| ------------------------------ | --------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `dockerWorkload.enabled`       | boolean         | `false`                  | Enable private nested Docker for Docker Agent sessions.                            |
| `dockerWorkload.networkAccess` | string          | Fresh enable: `packages` | `packages`, `images`, or `offline`; changes apply only to new sessions.            |
| `containerRuntime`             | string          | `auto`                   | `auto`, `docker`, or `apple-container`; nested Docker with `docker` is macOS-only. |
| `dockerResources.memoryMb`     | integer \| null | `8192`                   | Ordinary container memory ceiling; numeric values are inherited by nested Docker.  |
| `dockerResources.cpus`         | number \| null  | `4`                      | Ordinary container CPU ceiling; numeric values are inherited by nested Docker.     |

For backward compatibility, an existing enabled block with no old or new network choice migrates to
`images`; old `imageIngress: "public-registry"` also becomes `images`, while `preloaded-only` becomes
`offline`. The superseded `networkAccess: "public"` becomes the narrower `packages` mode. A disabled block
with no prior choice remains unchanged until the first CLI or web enable, which explicitly writes
`packages`.

On macOS, nested Docker admits a resolved Docker Desktop or Apple Container runtime and checks that the
selected runtime is available before provisioning. Docker Desktop supports `offline`, `images`, and
`packages`; its networked modes reuse the same registry/package policy engines as Apple Container through
fixed-target, bundle-scoped relays. A Docker resolution on another host fails closed. If an ordinary Docker resource is `null`,
nested Docker keeps its safe fallback instead of inheriting an unlimited value. The setting is global for
Docker Agent execution: standalone sessions and each workflow infrastructure bundle receive their own
private nested daemon when enabled.

### Connecting nested containers

An admitted session exports `IRONCURTAIN_DOCKER_NETWORK=ironcurtain`. Attach every service and
client container to that managed internal network; Docker's embedded DNS then resolves container
names and aliases:

```bash
docker run -d --name target --network "$IRONCURTAIN_DOCKER_NETWORK" <service-image>
docker run --rm --network "$IRONCURTAIN_DOCKER_NETWORK" <client-image> http://target:<port>/
```

For Compose, declare the existing managed network as the default:

```yaml
networks:
  default:
    external: true
    name: ${IRONCURTAIN_DOCKER_NETWORK}
```

The nested daemon has no default bridge. Do not use `-p`/`--publish` or `--network host`: neither
publishes an inner service to macOS. The Mac host and the agent shell cannot reach the service at
`localhost`; connect from a sibling container by its service name or network alias. IronCurtain gives
this guidance to the agent only after the nested-Docker capability is successfully admitted for the
new session. This is the supported service topology, not a security boundary: the agent has Docker
administrator authority over its bundle-local daemon.

## Auto-Compact

Controls automatic context compaction when the conversation approaches token limits.

| Field                            | Type    | Default                      | Description                                            |
| -------------------------------- | ------- | ---------------------------- | ------------------------------------------------------ |
| `autoCompact.enabled`            | boolean | `true`                       | Enable automatic compaction.                           |
| `autoCompact.thresholdTokens`    | integer | `160000`                     | Token count at which compaction triggers.              |
| `autoCompact.keepRecentMessages` | integer | `10`                         | Number of recent messages preserved during compaction. |
| `autoCompact.summaryModelId`     | string  | `anthropic:claude-haiku-4-5` | Model used to generate the summary.                    |

## Audit Redaction

Controls automatic redaction of sensitive data in audit log entries.

| Field                    | Type    | Default | Description                                                                              |
| ------------------------ | ------- | ------- | ---------------------------------------------------------------------------------------- |
| `auditRedaction.enabled` | boolean | `true`  | Redact credit cards, SSNs, and API keys in `audit.jsonl` entries before writing to disk. |

## Local LLM Statistics

Content-free usage collection is enabled by default. Configure it with `ironcurtain config` → **LLM Statistics**, the
web UI Settings view, or JSON:

| Field                      | Type            | Default | Description                                                     |
| -------------------------- | --------------- | ------- | --------------------------------------------------------------- |
| `statistics.enabled`       | boolean         | `true`  | Collect and persist content-free LLM usage statistics locally.  |
| `statistics.retentionDays` | integer \| null | `90`    | Delete older exchanges asynchronously; `null` disables pruning. |

Restart a long-running daemon after changing these settings so its statistics runtime is reconfigured.

The database is `~/.ironcurtain/statistics/llm-usage.sqlite3`; its local HMAC pseudonymization key is
`~/.ironcurtain/statistics/identity.key`. Stored fields include token counts, timing, provider/protocol/model routing,
outcomes, refusals, and provider-reported cost metadata. Prompt, completion, thinking, and tool content; HTTP bodies;
credentials; and arbitrary headers are not stored. User/config-derived labels and non-public routes are HMACed;
bounded provider and model identifiers remain readable so statistics can be grouped usefully.

Use `ironcurtain statistics delete --before <ISO-date-or-epoch-ms>` or `ironcurtain statistics delete --all` for manual
deletion. These commands perform logical SQLite row deletion, not secure erasure: bytes may remain in free pages, WAL
files, filesystem snapshots, or backups. They do not rotate or delete `identity.key`.

## Web Search

Configure a web search provider so the agent can search the web via the `web_search` tool.

| Field                      | Type   | Default  | Description                                       |
| -------------------------- | ------ | -------- | ------------------------------------------------- |
| `webSearch.provider`       | string | _(none)_ | Active provider: `brave`, `tavily`, or `serpapi`. |
| `webSearch.brave.apiKey`   | string | —        | Brave Search API key.                             |
| `webSearch.tavily.apiKey`  | string | —        | Tavily API key.                                   |
| `webSearch.serpapi.apiKey` | string | —        | SerpAPI key.                                      |

### Getting API Keys

- **Brave Search**: https://brave.com/search/api/
- **Tavily**: https://tavily.com/
- **SerpAPI**: https://serpapi.com/

## Model Providers (first-class OpenRouter)

Route Docker agents (Claude Code, Codex, Goose) through named **provider profiles** — model presets that map an agent to an OpenRouter model with a bound key, no LiteLLM sidecar. See [MODEL_ROUTING.md](MODEL_ROUTING.md#first-class-openrouter) for the quickstart and [docs/designs/openrouter-integration.md](docs/designs/openrouter-integration.md) for the design. Edit via `ironcurtain config` → **Model Providers**, or the web UI Settings view.

An implicit profile named `native` — today's canonical Anthropic / OpenAI / ChatGPT routing — is always present, cannot be redefined or deleted, and is the fallback when no default is set.

| Field                                               | Type    | Default                              | Description                                                                                                  |
| --------------------------------------------------- | ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `modelProviders.default`                            | string  | `native`                             | Profile used when no per-session choice is made. Must name a configured profile or `native`.                 |
| `modelProviders.profiles`                           | object  | `{}`                                 | User-named profiles, keyed by name. A profile named `native` is rejected (reserved).                         |
| `modelProviders.profiles.<name>.type`               | string  | —                                    | Discriminator: `openrouter` or `native`.                                                                     |
| `modelProviders.profiles.<name>.apiKey`             | string  | —                                    | OpenRouter key (`sk-or-v1-...`). `OPENROUTER_API_KEY` env takes precedence. Sensitive; masked in the editor. |
| `modelProviders.profiles.<name>.modelMap`           | array   | `*opus/sonnet/haiku* → z-ai/glm-5.2` | Ordered glob→slug rules (first match wins), matched case-insensitively against the requested model.          |
| `modelProviders.profiles.<name>.perAgent`           | object  | —                                    | Per-agent model override (`claude-code`, `goose`, `codex`). Wins over `modelMap` for that agent.             |
| `modelProviders.profiles.<name>.providerPreference` | object  | soft z-ai pin                        | Cache pinning passthrough (`order` / `only` / `allowFallbacks`). Replaces the D3 default when set.           |
| `modelProviders.profiles.<name>.sessionAffinity`    | boolean | `true`                               | Inject a stable top-level `session_id` for GLM cache affinity.                                               |

**Defaults (per openrouter profile).** When `modelMap` is omitted it defaults to `DEFAULT_MODEL_MAP`: `*opus*`, `*sonnet*`, and `*haiku*` → `z-ai/glm-5.2`. `sessionAffinity` defaults to `true`. When the mapped slug is `z-ai/*` and `providerPreference` is unset, the MITM injects a soft pin `provider: { order: ["z-ai"] }` for cache affinity. An openrouter profile with just `{ "type": "openrouter", "apiKey": "sk-or-v1-..." }` therefore routes Claude Code to cached GLM-5.2 with no further config.

**`OPENROUTER_API_KEY` env.** When set, it fills `apiKey` for **every** openrouter profile and takes precedence over any per-profile config `apiKey` (share one key across profiles). A profile's config `apiKey` is used only when the env var is unset. The env value is applied at resolve time and is **never persisted** to `config.json` — editing `modelProviders` via `ironcurtain config` or the web UI strips it from the write, so the env secret is never baked into the file.

**`modelMap: []` (per-agent-only mode).** An explicit empty array is preserved (resolution uses `??`, not `||`): the glob never matches, so routing relies on `perAgent` only.

**Reach of `default`.** The global default applies to **all** Docker Agent Mode sessions — interactive (`ironcurtain mux` PTY and batch `ironcurtain start`), daemon/cron jobs, signal-bot sessions, web-UI-spawned sessions, **and workflow orchestrator bundles** (one profile per shared-container run). A **per-session override** exists only where a surface exposes it: `ironcurtain start --provider-profile <name>` and the mux `/new` profile picker. Code Mode (builtin agent) is unaffected — profiles apply only to Docker Agent Mode.

**Hard load error on a dangling default.** A hand-edited `default` naming a profile that does not exist is a **hard error at config load** (`modelProviders.default must name a configured profile or "native".`) — it does not silently fall back to `native`. The `ironcurtain config` editor and web UI re-point `default` to `native` in the same write when you delete the profile it named, so they never persist a dangling default.

```json
{
  "modelProviders": {
    "default": "glm-5.2",
    "profiles": {
      "glm-5.2": {
        "type": "openrouter",
        "apiKey": "sk-or-v1-...",
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

Here `glm-5.2` is the default; `kimi` shares the env `OPENROUTER_API_KEY` (no per-profile `apiKey`) and uses a strict wildcard map. `native` need not be listed.

## Server Credentials

Per-server environment variables injected securely at runtime. The proxy strips `SERVER_CREDENTIALS` from the environment before spawning child processes, so credentials never leak to MCP servers that don't need them.

```json
{
  "serverCredentials": {
    "github": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxxx" },
    "fetch": { "API_KEY": "key_yyyy" }
  }
}
```

Keys must match server names in `mcp-servers.json`. A warning is emitted for unmatched keys.

## API Keys

API keys can be set via environment variables (preferred) or in the config file. Environment variables take precedence.

| Env Var                        | Config Field                            | Description                                                                                                     |
| ------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`            | `anthropicApiKey`                       | Anthropic API key                                                                                               |
| `ANTHROPIC_BASE_URL`           | `anthropicBaseUrl`                      | Override the Anthropic upstream endpoint (typically paired with a LiteLLM key)                                  |
| `GOOGLE_GENERATIVE_AI_API_KEY` | `googleApiKey`                          | Google AI API key                                                                                               |
| `OPENAI_API_KEY`               | `openaiApiKey`                          | OpenAI API key                                                                                                  |
| `OPENROUTER_API_KEY`           | `modelProviders.profiles.<name>.apiKey` | OpenRouter key; fills every openrouter profile (see [Model Providers](#model-providers-first-class-openrouter)) |

In Docker mode, IronCurtain auto-detects OAuth credentials from `~/.claude/.credentials.json` (created by `claude login`) and prefers them over API keys. Set `IRONCURTAIN_DOCKER_AUTH=apikey` to force API key mode.

### Routing through a non-Anthropic gateway

For OpenRouter, prefer the first-class [Model Providers](#model-providers-first-class-openrouter) section above — no sidecar, prompt caching preserved, accurate cost. For any other gateway, IronCurtain talks to Anthropic via the official SDK with `x-api-key` auth; run [LiteLLM](https://docs.litellm.ai/) as a local sidecar that translates Anthropic-format requests to your target provider, then point IronCurtain at it:

```bash
export ANTHROPIC_API_KEY="<your-litellm-virtual-key>"
export ANTHROPIC_BASE_URL="http://127.0.0.1:4000"
ironcurtain mux
```

LiteLLM handles model-name translation (e.g. mapping `claude-sonnet-4-6` to your chosen OpenRouter / Bedrock / OpenAI model). One-shot `ironcurtain start "your task"` runs use the same routing when you need a scriptable check. See LiteLLM's docs for sidecar setup.

## Memory

Controls the persistent memory server, automatically enabled for persona and cron job sessions. When an Anthropic API key is available, the memory server uses it for LLM-based summarization, duplicate detection, and compaction via Anthropic's OpenAI-compatible endpoint. Without an LLM key, the server works but uses extractive fallbacks.

| Field               | Type    | Default                         | Description                                               |
| ------------------- | ------- | ------------------------------- | --------------------------------------------------------- |
| `memory.enabled`    | boolean | `true`                          | Enable the memory MCP server for persona/cron sessions.   |
| `memory.llmBaseUrl` | string  | _(Anthropic endpoint)_          | OpenAI-compatible API endpoint for memory LLM operations. |
| `memory.llmApiKey`  | string  | _(falls back to Anthropic key)_ | API key for the memory LLM endpoint.                      |

The memory server can also be configured via environment variables (`MEMORY_DB_PATH`, `MEMORY_NAMESPACE`, `MEMORY_LLM_*`). See the [memory-mcp-server README](packages/memory-mcp-server/README.md) for standalone usage.

## Skills

User-global SKILL.md packages live under `~/.ironcurtain/skills/<name>/`. Each agent's discovery path differs (Claude Code is pointed at the staging dir via `--add-dir`; Goose scans `~/.config/goose/skills/<name>/SKILL.md`); IronCurtain bind-mounts the staged skills (read-only) at the path the active agent's native discovery walks. There's nothing to configure in `config.json` — drop a directory containing a `SKILL.md` file (with `name` and `description` frontmatter) and any supporting files, and it's automatically picked up on next session start. See [WORKFLOWS.md](WORKFLOWS.md#skills) for the layering rules and the workflow-bundled skills variant.

## Multi-Provider Support

Use the `provider:model-name` format in config and provide the API key for each provider you use:

```json
{
  "agentModelId": "anthropic:claude-sonnet-4-6",
  "policyModelId": "google:gemini-2.5-flash",
  "googleApiKey": "AIza..."
}
```

Supported providers: `anthropic`, `google`, `openai`. Environment variables take precedence over config file values.

## File Permissions

The config file is created with `0600` (owner-only read/write) permissions. A warning is emitted if the file is group- or world-readable, since it may contain API keys.

## Example Configuration

```json
{
  "agentModelId": "anthropic:claude-sonnet-4-6",
  "policyModelId": "anthropic:claude-sonnet-4-6",
  "escalationTimeoutSeconds": 300,
  "resourceBudget": {
    "maxTotalTokens": 1000000,
    "maxSteps": 200,
    "maxSessionSeconds": 1800,
    "maxEstimatedCostUsd": 5.0,
    "warnThresholdPercent": 80
  },
  "autoCompact": {
    "enabled": true,
    "thresholdTokens": 160000,
    "keepRecentMessages": 10,
    "summaryModelId": "anthropic:claude-haiku-4-5"
  },
  "autoApprove": {
    "enabled": false,
    "modelId": "anthropic:claude-haiku-4-5"
  },
  "auditRedaction": {
    "enabled": true
  },
  "webSearch": {
    "provider": "brave",
    "brave": { "apiKey": "BSA..." }
  },
  "memory": {
    "enabled": true
  }
}
```
