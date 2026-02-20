# TB1b: Fetch Server, User Credentials & Constitution Customizer

**Status:** Proposed
**Date:** 2026-02-19
**Author:** IronCurtain Engineering
**Depends on:** TB1a (Git Server Integration & Role Extensibility)

## 1. Executive Summary

TB1b completes the multi-server foundation with three capabilities: (a) a custom web-fetch MCP server for HTTP requests with inspectable URL arguments, (b) per-server user credential configuration so secrets stay out of source-controlled files, and (c) an LLM-assisted CLI for users to customize their constitution in natural language.

These build on TB1a's role extensibility and policy engine domain support. The `fetch-url` role (defined in TB1a) is exercised by the fetch server. User credentials enable token-based auth for git push (deferred from TB1a). The constitution customizer writes to the user constitution file (introduced in TB1a).

## 2. Fetch MCP Server

### 2.1 Design Decision: Custom Server

Build a minimal custom server (`src/servers/fetch-server.ts`) rather than depending on the official Python fetch server or community alternatives.

**Rationale:**
- Full control over tool schema (inspectable arguments for policy)
- No Python runtime dependency
- Single file (~100 lines) using `@modelcontextprotocol/sdk`
- Consistent with the Node.js/TypeScript codebase

### 2.2 Tool Schema

Single `fetch` tool:

```typescript
{
  name: 'fetch',
  description: 'Fetch content from a URL via HTTP(S)',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
        default: 'GET',
        description: 'HTTP method',
      },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'HTTP headers',
      },
      body: { type: 'string', description: 'Request body' },
      max_length: {
        type: 'number',
        default: 5000,
        description: 'Maximum response body length in characters',
      },
    },
    required: ['url'],
  },
}
```

Response includes status code, headers (selected), and body (truncated to `max_length`). HTML is converted to markdown for readability.

### 2.3 Server Configuration

```jsonc
// src/config/mcp-servers.json
"fetch": {
  "command": "node",
  "args": ["./src/servers/fetch-server.js"],
  "sandbox": {
    "network": {
      "allowedDomains": ["*"]
    }
  }
}
```

`allowedDomains: ["*"]` means no OS-level network restriction. The policy engine controls what the agent is ALLOWED to fetch (semantic intent). The sandbox layer controls what the process CAN reach (containment). These are separate concerns -- `"*"` at the sandbox level means Phase 1c always passes, and all URL decisions fall to Phase 2 compiled rules from the constitution.

### 2.4 Constitution Updates

```markdown
 - The agent may fetch web content via HTTP GET from any domain for reading purposes.
 - The agent must receive human approval before making HTTP POST, PUT, DELETE, or PATCH requests via fetch.
```

### 2.5 Handwritten Scenarios

```typescript
'Fetch GET from any domain -- allow'
'Fetch POST to any domain -- escalate'
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
  "apiKey": "sk-ant-...",

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
    .record(z.string(), z.record(z.string(), z.string()))
    .optional(),
});

export interface ResolvedUserConfig {
  // ... existing fields ...
  readonly serverCredentials: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
```

### 3.5 Proxy Integration

The proxy runs as a separate child process. Server credentials are passed via the `SERVER_CREDENTIALS` environment variable (JSON string), parsed in the proxy:

```typescript
// mcp-proxy-server.ts
const serverCredentials: Record<string, Record<string, string>> =
  process.env.SERVER_CREDENTIALS ? JSON.parse(process.env.SERVER_CREDENTIALS) : {};

// When spawning each MCP server:
const userCreds = serverCredentials[serverName] ?? {};
const spawnEnv = {
  ...(process.env as Record<string, string>),
  ...(config.env ?? {}),
  ...userCreds,
};
```

### 3.6 Credential Masking

Credential values from `serverCredentials` are masked in all log output (audit log, session log, LLM interaction log). Values matching known credential keys are replaced with `***REDACTED***`.

## 4. LLM-Assisted Constitution Customization

### 4.1 Overview

Users customize their constitution via natural language. An LLM translates intent into policy statements and validates them through the compile-policy pipeline.

### 4.2 CLI Command

```bash
npm run customize-policy
```

### 4.3 Interaction Flow

```
1. User runs `npm run customize-policy`
2. System displays current constitution (base + user)
3. User types: "I want git push to always require approval,
   and allow fetching from any .gov domain without approval"
4. LLM generates proposed user constitution entries:
   - "The agent must receive human approval before any git push operation."
   - "The agent may fetch web content from *.gov domains without approval."
5. System shows diff of constitution-user.md
6. User confirms or edits
7. System writes ~/.ironcurtain/constitution-user.md
8. System runs compile-policy to regenerate artifacts
9. System shows compilation result (pass/fail)
10. On failure: offer to revert
```

### 4.4 LLM Prompt

```typescript
// src/pipeline/constitution-customizer.ts

function buildCustomizationPrompt(
  currentConstitution: string,
  currentUserConstitution: string | undefined,
  toolAnnotations: ToolAnnotation[],
  userRequest: string,
): string {
  return `You are helping a user customize their IronCurtain security policy.

## Current Base Constitution
${currentConstitution}

${currentUserConstitution ? `## Current User Customizations\n${currentUserConstitution}` : '## No existing user customizations.'}

## Available Tools
${formatAnnotationsForPrompt(toolAnnotations)}

## User Request
"${userRequest}"

## Instructions
Generate the updated user constitution section. Rules:
1. Only modify the user customization section, never the base constitution.
2. Each line should be a clear, specific policy statement.
3. Use concrete terms the policy compiler can translate to rules:
   - "allow" / "deny" / "require approval" (maps to escalate)
   - Reference specific tools (git push, git commit) or categories (git operations)
   - Reference domains when relevant (github.com, *.gov)
4. Avoid vague statements. "Be careful with git" is not enforceable.
5. Return the complete user constitution section (not just the changes).
`;
}
```

### 4.5 Implementation Notes

- Standalone CLI command, separate from the main agent.
- After approval, writes `~/.ironcurtain/constitution-user.md` and invokes `compile-policy`.
- If compilation fails (verification errors), shows errors and offers to revert.
- User constitution path configurable: `userConstitutionPath` in `config.json`.
- Constitution versioning: user constitution only adds guidance, never modifies base principles. If a base update conflicts, compile-policy fails, alerting the user.

## 5. Implementation Phases

### Phase 4: Fetch Server

**New files:**
- `src/servers/fetch-server.ts` -- minimal fetch MCP server

**Files changed:**
- `src/config/mcp-servers.json` -- add fetch server entry
- `src/config/constitution.md` -- add fetch-specific guidance
- `src/pipeline/handwritten-scenarios.ts` -- add fetch scenarios

**Pipeline run:** `npm run compile-policy` with filesystem + git + fetch.

### Phase 5: User Credential Configuration

**Files changed:**
- `src/config/user-config.ts` -- add `serverCredentials` to schema and `ResolvedUserConfig`
- `src/trusted-process/mcp-proxy-server.ts` -- read `SERVER_CREDENTIALS` env var, merge into spawn env
- `src/sandbox/index.ts` -- pass `SERVER_CREDENTIALS` to proxy env

### Phase 6: Constitution Customizer CLI

**New files:**
- `src/pipeline/constitution-customizer.ts` -- LLM-assisted customization logic
- CLI entry point (npm script)

**Files changed:**
- `package.json` -- add `customize-policy` script

## 6. Test Strategy

### Fetch Server Tests

- Server starts and responds to MCP protocol
- `fetch` tool listed with correct schema
- GET request returns status, headers, body
- POST request works with body and headers
- `max_length` truncation works
- Invalid URL returns structured error
- HTML-to-markdown conversion

### User Credentials Tests

- `serverCredentials` parsed from user config
- Merge order: system env < server env < user credentials
- Missing `serverCredentials` defaults to empty
- `SERVER_CREDENTIALS` env var round-trips through JSON serialization
- Credential values masked in audit log entries

### Constitution Customizer Tests

- User constitution file loaded alongside base
- Combined hash changes when either file changes
- Compile-policy succeeds with user constitution additions
- Revert works when compilation fails

### Integration Tests

- All three servers (filesystem, git, fetch) connect and list tools
- Full compile-policy produces coherent artifacts for all servers
- Cross-server policy evaluation (read file → commit → push → fetch) works correctly
