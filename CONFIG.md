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

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agentModelId` | string | `anthropic:claude-sonnet-4-6` | LLM for the agent. Format: `provider:model-name` or bare model name. |
| `policyModelId` | string | `anthropic:claude-sonnet-4-6` | LLM for policy compilation. |

Supported providers: `anthropic`, `google`, `openai`.

## Security

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `escalationTimeoutSeconds` | integer | `300` | Seconds to wait for human approval on escalated tool calls. Range: 30–600. |
| `autoApprove.enabled` | boolean | `false` | Let an LLM auto-approve escalated tool calls instead of waiting for a human. |
| `autoApprove.modelId` | string | `anthropic:claude-haiku-4-5` | Model used for auto-approval decisions. |

## Resource Limits

All budget fields are nullable — set to `null` to disable the limit.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `resourceBudget.maxTotalTokens` | integer \| null | `1000000` | Maximum tokens (input + output) per session. |
| `resourceBudget.maxSteps` | integer \| null | `200` | Maximum agent steps per session. |
| `resourceBudget.maxSessionSeconds` | number \| null | `1800` | Wall-clock timeout in seconds. |
| `resourceBudget.maxEstimatedCostUsd` | number \| null | `5.0` | Estimated cost cap in USD. |
| `resourceBudget.warnThresholdPercent` | integer | `80` | Emit a warning when this percentage of any limit is consumed. Range: 1–99. |

## Auto-Compact

Controls automatic context compaction when the conversation approaches token limits.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `autoCompact.enabled` | boolean | `true` | Enable automatic compaction. |
| `autoCompact.thresholdTokens` | integer | `160000` | Token count at which compaction triggers. |
| `autoCompact.keepRecentMessages` | integer | `10` | Number of recent messages preserved during compaction. |
| `autoCompact.summaryModelId` | string | `anthropic:claude-haiku-4-5` | Model used to generate the summary. |

## Audit Redaction

Controls automatic redaction of sensitive data in audit log entries.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auditRedaction.enabled` | boolean | `true` | Redact credit cards, SSNs, and API keys in `audit.jsonl` entries before writing to disk. |

## Web Search

Configure a web search provider so the agent can search the web via the `web_search` tool.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `webSearch.provider` | string | *(none)* | Active provider: `brave`, `tavily`, or `serpapi`. |
| `webSearch.brave.apiKey` | string | — | Brave Search API key. |
| `webSearch.tavily.apiKey` | string | — | Tavily API key. |
| `webSearch.serpapi.apiKey` | string | — | SerpAPI key. |

### Getting API Keys

- **Brave Search**: https://brave.com/search/api/
- **Tavily**: https://tavily.com/
- **SerpAPI**: https://serpapi.com/

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

| Env Var | Config Field | Description |
|---------|-------------|-------------|
| `ANTHROPIC_API_KEY` | `anthropicApiKey` | Anthropic API key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | `googleApiKey` | Google AI API key |
| `OPENAI_API_KEY` | `openaiApiKey` | OpenAI API key |

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
    "maxEstimatedCostUsd": 5.00,
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
  }
}
```
