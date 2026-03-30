# Adding an MCP Server to IronCurtain

This guide walks through how to add a new [MCP](https://modelcontextprotocol.io/) server to IronCurtain so its tools are available to the agent and governed by the policy engine.

## Overview

Adding a server involves four steps:

1. **Register** the server in the MCP server configuration
2. **Configure credentials** (if the server needs API keys or OAuth tokens)
3. **Annotate** the server's tools so the policy engine understands their arguments
4. **Update the constitution** and recompile policy to define what the agent can and cannot do

## Step 1: Register the Server

Add an entry to `src/config/mcp-servers.json`:

```json
{
  "my-server": {
    "description": "What this server does",
    "command": "npx",
    "args": ["-y", "@example/my-mcp-server"],
    "env": {
      "SOME_ENV_VAR": "value"
    },
    "sandbox": false
  }
}
```

**Fields:**
- `command` / `args` — How to start the server process (stdio transport)
- `env` — Environment variables passed to the server process
- `sandbox` — OS-level sandbox configuration (`false` to disable, or an object with `filesystem` and `network` restrictions)
- `description` — Human-readable summary shown in help output

For Docker-based servers (e.g., GitHub's MCP server), use `-e VAR_NAME` (without `=value`) in `args` so Docker forwards the variable from the host environment.

## Step 2: Configure Credentials

If the server requires API keys or OAuth tokens, add credential hints so the first-start wizard can prompt users.

**For API keys:** Add an entry to `SERVER_CREDENTIAL_HINTS` in `src/config/config-command.ts` and a prompt step in `src/config/first-start.ts`. Credentials are stored in `~/.ironcurtain/config.json` under `serverCredentials.<serverName>.<ENV_VAR>` and injected at runtime.

**For OAuth:** Use `ironcurtain auth` to set up OAuth credentials. See [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) for OAuth details.

## Step 3: Annotate Tool Arguments

The policy engine needs to know the *role* of each tool argument (e.g., is it a file path? a URL? a branch name?) to enforce policy rules correctly. Run the annotation pipeline for your new server:

```bash
ironcurtain annotate-tools --server my-server
```

This connects to the server, discovers its tools, and uses an LLM to classify each argument. The result is merged with existing annotations for other servers and written to `~/.ironcurtain/generated/tool-annotations.json`.

**For IronCurtain developers:** The repository ships pre-generated annotations in `src/config/generated/`. After annotating, copy the updated file back so it ships with the package:

```bash
cp ~/.ironcurtain/generated/tool-annotations.json src/config/generated/tool-annotations.json
```

**Flags:**
- `--server <name>` — Annotate only this server (default workflow)
- `--all` — Re-annotate all servers
- `--help` — Show usage

After annotation, review the generated file to verify the LLM classified arguments correctly. Annotations are part of the Trusted Computing Base — incorrect classifications can lead to policy bypasses.

### Argument Roles

The annotation pipeline assigns roles from a registry (`src/types/argument-roles.ts`). Common roles include:

| Role | Meaning |
| --- | --- |
| `read-path` | File/directory path used for reading |
| `write-path` | File/directory path used for writing |
| `delete-path` | File/directory path used for deletion |
| `url` | A URL (subject to domain allowlists) |
| `github-owner` | A GitHub owner/org name |
| `none` | Argument has no security-relevant semantics |

If your server introduces new resource-identifier semantics not covered by existing roles, extend the registry in `src/types/argument-roles.ts`.

## Step 4: Update Constitution and Compile Policy

Add rules for the new server's tools to your constitution (`src/config/constitution.md` or a custom constitution file). For example:

```markdown
## My Server Rules

- Read-only operations on my-server are safe and can be allowed automatically.
- Any mutation operations require human approval.
```

Then compile the updated policy:

```bash
ironcurtain compile-policy
```

This generates `compiled-policy.json` with enforceable rules, test scenarios, and verification. Review the compiled output to confirm the rules match your intent.

### Adding Tests

**Handwritten scenarios** (`src/pipeline/handwritten-scenarios.ts`) are reserved for universal safety invariants that must hold regardless of the user's constitution — currently filesystem sandbox containment rules. Only add scenarios here if your server introduces a new universal invariant (e.g., a hard safety boundary that no constitution should be able to override).

**Policy unit tests** (`test/policy-engine.test.ts`) are where server-specific policy tests belong. Add test fixtures in `test/fixtures/test-policy.ts` with representative tools and rules, then write tests verifying your server's tools are correctly allowed/escalated/denied under the current compiled policy.

## Verification

After completing all steps:

1. **Build:** `npm run build`
2. **Test:** `npm test`
3. **Manual check:** Start a session and verify the new server's tools appear and policy decisions are correct:
   ```bash
   ironcurtain start "list the tools available from my-server"
   ```

## Quick Reference

| Step | Command |
| --- | --- |
| Annotate one server | `ironcurtain annotate-tools --server <name>` |
| Annotate all servers | `ironcurtain annotate-tools --all` |
| Compile policy | `ironcurtain compile-policy` |
| Refresh dynamic lists | `ironcurtain refresh-lists` |
| Run tests | `npm test` |
