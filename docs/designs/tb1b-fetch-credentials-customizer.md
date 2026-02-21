# TB1b: Fetch Server & User Credentials

**Status:** Proposed
**Date:** 2026-02-19
**Author:** IronCurtain Engineering
**Depends on:** TB1a (Git Server Integration & Role Extensibility)

## 1. Executive Summary

TB1b continues the multi-server buildout started in TB1a (documented in `multi-server-onboarding.md`, phases 1–3). Where TB1a added git server integration with role extensibility and domain-based policy evaluation, TB1b adds two capabilities: (a) a custom HTTP fetch MCP server for retrieving web content with inspectable URL arguments, and (b) per-server user credential configuration so secrets stay out of source-controlled files.

The `fetch-url` role (defined in TB1a) is exercised by the fetch server. User credentials enable token-based auth for git push (deferred from TB1a). Constitution customization is deferred to TB1c.

## 2. Fetch MCP Server

### 2.1 Design Decision: Custom Server

Build a minimal custom server (`src/servers/fetch-server.ts`) rather than depending on the official Python fetch server or community alternatives.

**Rationale:**
- Full control over tool schema (inspectable arguments for policy)
- No Python runtime dependency
- Single file (~100 lines) using `@modelcontextprotocol/sdk`
- Consistent with the Node.js/TypeScript codebase

### 2.2 Tool Schema

Single `http_fetch` tool (GET-only):

```typescript
{
  name: 'http_fetch',
  description: 'Fetch content from a URL via HTTP GET',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'HTTP headers',
      },
      max_length: {
        type: 'number',
        default: 5000,
        description: 'Maximum response body length in characters',
      },
      raw_html: {
        type: 'boolean',
        default: false,
        description: 'When true, return raw HTML instead of converting to markdown',
      },
    },
    required: ['url'],
  },
}
```

**Implementation:** Uses Node's built-in `fetch` (undici). Zero external HTTP dependencies, trivial to sandbox inside bwrap. Does not execute JavaScript — serves static content only. A Playwright-based browser server can be added separately if JS rendering is needed in the future.

Response includes status code, headers (selected), and body (truncated to `max_length`). By default, HTML responses are converted to markdown using `turndown` for readability. Set `raw_html: true` to inspect the original HTML. If `turndown` throws on malformed input, the server falls back to returning the raw HTML body.

The `headers` parameter is annotated with role `none` — the policy engine does not inspect header values. Header-level controls (e.g., blocking `Authorization` headers) are deferred.

The fetch server injects a `User-Agent` header on every request: `IronCurtain/0.1 (AI Agent Runtime)`. This is applied *after* merging agent-provided headers, so the agent cannot override it. Server operators can use this to identify, rate-limit, or block AI agent traffic.

### 2.3 Server Configuration

```jsonc
// src/config/mcp-servers.json
"fetch": {
  "command": "npx",
  "args": ["tsx", "./src/servers/fetch-server.ts"],
  "sandbox": {
    "network": {
      "allowedDomains": ["*"]
    }
  }
}
```

`allowedDomains: ["*"]` means no OS-level network restriction. The policy engine controls what the agent is ALLOWED to fetch (semantic intent). The sandbox layer controls what the process CAN reach (containment). These are separate concerns — `"*"` at the sandbox level means Phase 1c passes all domain-name URLs through to Phase 2 compiled rules. However, IP-address hostnames are **not** matched by `"*"` (see Section 2.4).

### 2.4 SSRF Protection (Structural Invariant)

Raw IP addresses in URLs are treated as a structural invariant in Phase 1c: **any URL whose hostname is an IP address (IPv4 or IPv6) requires explicit allowlist permission**. Domain wildcards like `"*"` do not match IP addresses.

This blocks SSRF attacks targeting internal infrastructure (127.0.0.1, 10.x.x.x, 169.254.169.254, etc.) without maintaining a blocklist. Legitimate IP-based access can be enabled via the server's `allowedDomains` in `mcp-servers.json`:

```jsonc
"allowedDomains": ["*", "192.168.1.100"]  // domain wildcard + explicit IP
```

**Implementation — two changes to existing code:**

1. **`extractServerDomainAllowlists()`** (`src/config/index.ts`) — stop filtering `*` from the allowlist. Currently, `["*"]` is filtered to `[]` which produces no map entry, causing Phase 1c to be skipped entirely. With this change, `["*"]` produces an allowlist entry of `["*"]` so Phase 1c fires.

2. **`domainMatchesAllowlist()`** (`src/trusted-process/policy-engine.ts`) — when the pattern is `*`, check whether the domain is an IP address. If so, skip the wildcard match:

```typescript
function isIpAddress(domain: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(domain) || domain.includes(':');
}

// In domainMatchesAllowlist:
if (pattern === '*') return !isIpAddress(domain);  // was: return true
```

**Resulting behavior by allowlist configuration:**

| `allowedDomains` | Domain URL | IP URL | IP in explicit list |
|---|---|---|---|
| `["*"]` | Phase 1c pass → Phase 2 | **escalate** | n/a |
| `["*", "192.168.1.100"]` | Phase 1c pass → Phase 2 | **escalate** (unless explicit match) | Phase 1c pass → Phase 2 |
| `["github.com"]` | escalate (unless match) | **escalate** | n/a |
| not configured | Phase 1c skipped → Phase 2 | Phase 1c skipped → Phase 2 | n/a |

**Note:** Servers with URL-category roles should always have an `allowedDomains` entry to ensure Phase 1c SSRF protection fires. A config-load-time warning is emitted when a server's tools include `fetch-url` or `git-remote-url` roles but no `allowedDomains` is configured.

**Known limitation:** DNS rebinding (a domain resolving to a private IP) is not detected at the policy layer. This is a network-layer concern that srt/socat can address in a future enhancement.

### 2.5 Redirect Handling

The fetch server follows redirects normally (up to 5 hops to prevent infinite loops). No per-hop policy re-evaluation — if the policy approved the initial URL, the domain's redirect decisions are trusted. This matches browser semantics and avoids false-positive blocks on CDN redirects, URL shorteners, and load balancers.

**Accepted risk:** A server at an allowed domain can redirect to an untrusted domain, and the response will be returned to the agent. This is the same trust model as a browser — approving navigation to a domain implicitly trusts its redirects.

### 2.6 Response Limits

Beyond `max_length` (character truncation of the response body), the fetch server enforces:
- **Hard response size limit:** 10 MB maximum raw response body. Responses exceeding this are aborted mid-stream.
- **Request timeout:** 30 seconds per request (server-side constant, not agent-configurable).

These prevent resource exhaustion from streaming endpoints or slow servers.

### 2.7 Constitution Updates

```markdown
 - The agent may fetch web content via HTTP GET from any domain for reading purposes.
```

### 2.8 Handwritten Scenarios

```typescript
'Fetch GET from any domain -- allow'
'Fetch with raw IP address URL -- escalate (SSRF protection)'
'Unknown fetch tool -- deny (structural invariant)'
```

## 3. User Credential Configuration

### 3.1 Problem

Credentials for MCP servers (git tokens, API keys) must not live in source-controlled files (`mcp-servers.json`). Users need a way to inject per-server secrets.

### 3.2 Design: serverCredentials in User Config

Extend `~/.ironcurtain/config.json` with a `serverCredentials` section:

```jsonc
{
  "agentModelId": "anthropic:claude-sonnet-4-6",
  "policyModelId": "anthropic:claude-sonnet-4-6",
  "anthropicApiKey": "sk-ant-...",

  "serverCredentials": {
    "git": {
      "GH_TOKEN": "ghp_xxxxxxxxxxxx"
    },
    "fetch": {
      "FETCH_API_KEY": "key_xxxxxxxxxxxx"
    }
  }
}
```

### 3.3 Merge Order

When spawning an MCP server, environment variables are merged:

1. `process.env` (system environment)
2. `mcp-servers.json` `env` field (static per-server config)
3. `config.json` `serverCredentials[serverName]` (user-specific secrets)

Later values override earlier ones. A user can override a default env var from `mcp-servers.json` with their own credential.

### 3.4 Type Definitions

```typescript
// src/config/user-config.ts
const userConfigSchema = z.object({
  // ... existing fields ...
  serverCredentials: z
    .record(z.string(), z.record(z.string(), z.string().min(1)))
    .optional(),
});

export interface ResolvedUserConfig {
  // ... existing fields ...
  readonly serverCredentials: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
```

Inner values use `.min(1)` to reject empty strings that would silently fail to authenticate. `serverCredentials` is added to `SENSITIVE_FIELDS` (see 3.8).

In `mergeWithDefaults()`, `serverCredentials` defaults to `{}` when absent from the config file, so `ResolvedUserConfig.serverCredentials` is always a non-optional record.

### 3.5 Proxy Integration

The proxy runs as a separate child process (one per backend server via `SERVER_FILTER`). Server credentials flow through a carefully scoped pipeline:

**Data path:** `config.userConfig.serverCredentials` -> `Sandbox.initialize()` -> per-server `proxyEnv.SERVER_CREDENTIALS` -> proxy-side env merge.

```typescript
// sandbox/index.ts -- pass ONLY the current server's credentials
for (const serverName of Object.keys(config.mcpServers)) {
  const serverCreds = config.userConfig.serverCredentials[serverName];
  mcpServers[serverName] = {
    // ...existing fields...
    env: {
      ...proxyEnv,
      SERVER_FILTER: serverName,
      // Per-server isolation: each proxy only receives its own credentials
      ...(serverCreds ? { SERVER_CREDENTIALS: JSON.stringify(serverCreds) } : {}),
    },
  };
}

// mcp-proxy-server.ts -- parse flat credential map, scrub from process.env
const serverCredentials: Record<string, string> =
  process.env.SERVER_CREDENTIALS ? JSON.parse(process.env.SERVER_CREDENTIALS) : {};
delete process.env.SERVER_CREDENTIALS;  // Prevent leakage to MCP server children

// When spawning each MCP server:
const spawnEnv = {
  ...(process.env as Record<string, string>),
  ...(config.env ?? {}),
  ...serverCredentials,  // flat map since we filtered per-server in sandbox
};
```

**Security invariants:**
1. Each proxy process receives credentials ONLY for its own server (least privilege).
2. `SERVER_CREDENTIALS` is deleted from `process.env` immediately after parsing, before any MCP server children are spawned.
3. Credentials are merged last in the env chain, so they override both system env and static `mcp-servers.json` values.

### 3.6 Config File Permissions

`~/.ironcurtain/config.json` contains secrets (`anthropicApiKey`, `serverCredentials`). The `readOrCreateConfigFile()` function must set file permissions to `0o600` on creation, and `loadUserConfig()` should warn if the file is group- or world-readable.

### 3.7 Server Name Validation

After both `loadUserConfig()` and `mcp-servers.json` are loaded in `loadConfig()`, warn if any `serverCredentials` key does not match a server name in `mcp-servers.json`. This check cannot happen in `loadUserConfig()` because it does not have access to server names. This catches typos (e.g., `"Git"` instead of `"git"`) that would otherwise silently fail to inject credentials.

### 3.8 Schema Changes

Add `serverCredentials` to `SENSITIVE_FIELDS` to prevent the backfill mechanism from writing a default value into `config.json`. The Zod schema should enforce non-empty credential values:

```typescript
const userConfigSchema = z.object({
  // ...existing fields...
  serverCredentials: z
    .record(z.string(), z.record(z.string(), z.string().min(1)))
    .optional(),
});
```

### 3.9 Credential Masking

MCP server stderr lines are scanned for known credential values before writing to the session log. Matching substrings are replaced with `***REDACTED***`. This is inline string replacement in the proxy's stderr handler — not a dedicated utility class.

Audit log redaction is not implemented. The path from credential to tool argument is indirect (server echoes credential in response → enters LLM context → agent passes as argument) and unreliable to catch via string matching. See `docs/SECURITY_CONCERNS.md` §8 for the full threat analysis and design rationale.

## 4. Implementation Phases

Phase numbering continues from TB1a (phases 1–3).

### Phase 4: Fetch Server

**New files:**
- `src/servers/fetch-server.ts` -- minimal fetch MCP server using Node built-in `fetch` + `turndown`

**New dependency:**
- `turndown` -- HTML-to-markdown conversion (optional, controlled by `raw_html` parameter)

**Files changed:**
- `src/config/mcp-servers.json` -- add fetch server entry
- `src/config/index.ts` -- stop filtering `*` in `extractServerDomainAllowlists()`
- `src/config/constitution.md` -- add fetch-specific guidance
- `src/pipeline/handwritten-scenarios.ts` -- add fetch scenarios
- `src/trusted-process/policy-engine.ts` -- modify `domainMatchesAllowlist()` so `*` does not match IP addresses

**Pipeline run:** `npm run compile-policy` with filesystem + git + fetch.

### Phase 5: User Credential Configuration

**Files changed:**
- `src/config/user-config.ts` -- add `serverCredentials` to schema, `ResolvedUserConfig`, `SENSITIVE_FIELDS`, and `mergeWithDefaults()` (default `{}`); set 0o600 permissions on config file creation; warn on world-readable permissions
- `src/config/index.ts` -- validate `serverCredentials` keys against `mcp-servers.json` server names in `loadConfig()` (after both configs are loaded)
- `src/trusted-process/mcp-proxy-server.ts` -- read `SERVER_CREDENTIALS` env var (flat per-server map), delete from `process.env` before spawning children, merge into spawn env; inline credential masking in stderr handler
- `src/sandbox/index.ts` -- pass per-server credentials (not all credentials) to each proxy via `SERVER_CREDENTIALS`

## 5. Test Strategy

### Fetch Server Tests

- Server starts and responds to MCP protocol
- `http_fetch` tool listed with correct schema
- GET request returns status, headers, body
- `User-Agent` header is always `IronCurtain/0.1 (AI Agent Runtime)`, even when agent sets a custom `User-Agent`
- `max_length` truncation works
- Invalid URL returns structured error
- HTML-to-markdown conversion via turndown (default)
- Malformed HTML falls back to raw content when turndown throws
- `raw_html: true` returns original HTML without conversion
- Response exceeding 10 MB hard limit is aborted
- Request timeout fires after configured duration
- Redirects followed up to 5 hops; infinite redirect loop returns error
- SSRF: IP-address URLs escalated by policy engine (structural invariant)
- SSRF: `*` wildcard does not match IP-address hostnames
- SSRF: explicit IP in allowlist passes policy

### User Credentials Tests

- `serverCredentials` parsed from user config
- Merge order: system env < server env < user credentials
- Missing `serverCredentials` defaults to empty
- `SERVER_CREDENTIALS` env var round-trips through JSON serialization
- Each per-server proxy receives ONLY its own credentials (not other servers')
- `SERVER_CREDENTIALS` deleted from `process.env` before child MCP server spawn
- Config file created with 0o600 permissions
- Warning emitted for group/world-readable config file
- Warning emitted for `serverCredentials` keys not matching any server in `mcp-servers.json`
- Empty credential values rejected by schema validation
- `serverCredentials` not backfilled into config file (in `SENSITIVE_FIELDS`)
- Known credential values in session log stderr lines are replaced with `***REDACTED***`

### Integration Tests

- All three servers (filesystem, git, fetch) connect and list tools
- Full compile-policy produces coherent artifacts for all servers
- Cross-server policy evaluation (read file → commit → push → fetch) works correctly
