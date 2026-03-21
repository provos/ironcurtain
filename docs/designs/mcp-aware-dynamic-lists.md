# MCP-Aware Dynamic Lists and All-Server Read-Only Policy

## Problem Statement

Two related gaps exist in the current pipeline:

1. **Dynamic list resolution cannot reach all MCP servers.** The `connectMcpServersForLists()` function in `mcp-connections.ts` connects only to servers hinted by list definitions. But when the constitution generator or a persona session runs under the read-only policy, it cannot issue read-only calls to servers like Google Workspace because the read-only compiled policy (`src/config/generated-readonly/compiled-policy.json`) only covers `filesystem`, `git`, and `github`. Lists that need to call Google Workspace tools (e.g., "fetch my top contacts") have no policy permitting those calls.

2. **The read-only compiled policy is incomplete.** It was hand-compiled once and only covers three servers. New servers (fetch, google-workspace) have been onboarded but the read-only policy was never updated. Any Code Mode session running under the read-only policy (constitution generation, persona creation) cannot use tools from these servers.

3. **List resolver MCP calls are unmediated.** The list resolver currently calls MCP tools directly through the SDK client with no policy enforcement. This is dangerous -- a poorly phrased list resolution prompt could cause the LLM to call mutating tools (delete emails, modify calendar events, push code). The list resolver's MCP calls must be routed through a PolicyEngine loaded with the read-only policy to guarantee only read-only operations are permitted.

The fix is straightforward: update `constitution-readonly.md` to cover all servers, compile it through the same per-server pipeline that `compile-policy` uses (with `--no-mcp` since read-only compilation has no dynamic lists), and route list resolver MCP calls through a PolicyEngine loaded with the read-only compiled artifacts.

## Compilation Ordering

The read-only policy and the main policy have a clear dependency ordering:

1. **`compile-policy:readonly`** (with `--no-mcp`) -- produces read-only rules. The read-only constitution does not reference dynamic lists, so no MCP connections are needed. This step has no dependencies.

2. **`compile-policy`** (main) -- compiles the main constitution, which may include dynamic list definitions. When resolving MCP-backed lists, the list resolver's tool calls are mediated by a PolicyEngine loaded with the read-only compiled artifacts from step 1.

This ordering avoids any circularity: the read-only policy is compiled without MCP, then the main policy uses the read-only artifacts to safely mediate list resolution MCP calls.

## Proposed Changes

### 1. Update `constitution-readonly.md` to Cover All Servers

Add read-only principles for all onboarded servers. Keep the language general -- do not enumerate specific service features.

**File:** `src/config/constitution-readonly.md`

```markdown
# Read-Only Constitution

## Guiding Principles

1. **Read-only exploration**: The agent may only observe and query -- never modify, create, or delete.
2. **Broad read access**: Reading files, listing directories, and querying metadata is permitted anywhere.
3. **GitHub read access**: Querying GitHub repositories, issues, and pull requests is permitted for reading.
4. **Cloud service read access**: Reading messages, contacts, calendar events, files, and document content from connected cloud services is permitted.
5. **Controlled web access**: Fetching URLs from known safe domains is permitted for data gathering. Web search is permitted.
6. **No mutations**: Any operation that creates, modifies, or deletes data must be escalated for human approval.

## Concrete Guidance

 - The agent is allowed to read files and list directories anywhere on the filesystem
 - The agent is allowed to search file contents
 - The agent is allowed to read git log, status, diff, and branch information
 - The agent is allowed to set the git working directory for navigation
 - The agent must ask for approval before adding, removing, or renaming git remotes
 - The agent is allowed to list and read GitHub issues, pull requests, and repository metadata
 - The agent is allowed to read messages, contacts, calendar events, and document content from connected cloud services
 - The agent must ask for approval before sending messages, creating events, uploading files, or modifying any cloud service data
 - The agent is allowed to fetch URLs and perform web searches for data gathering
 - The agent must ask for approval before any write, create, delete, or push operation
 - The agent must ask for approval before modifying git state (commit, checkout, merge, rebase)
```

### 2. Add a `--no-mcp` Flag to `compile-policy`

The read-only compilation must skip MCP connections entirely (it has no dynamic lists to resolve). The `compile-policy` CLI needs a `--no-mcp` flag that suppresses MCP server connections during list resolution.

**File:** `src/pipeline/compile.ts`

Add `--no-mcp` to the argument parser:

```typescript
export interface CompilePolicyCliArgs {
  constitution?: string;
  outputDir?: string;
  server?: string;
  noMcp?: boolean;  // new
}

export function parseCompilePolicyArgs(argv: string[] = process.argv.slice(2)): CompilePolicyCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      constitution: { type: 'string' },
      'output-dir': { type: 'string' },
      server: { type: 'string' },
      'no-mcp': { type: 'boolean' },
    },
    strict: false,
  });
  // ... existing parsing ...
  return {
    // ... existing fields ...
    noMcp: (values['no-mcp'] as boolean | undefined) ?? false,
  };
}
```

In `main()`, when `--no-mcp` is set, pass `mcpServers: undefined` to `PipelineRunConfig` so the pipeline skips MCP connections during list resolution. The existing list resolution code already handles this case: `if (needsMcp && config.mcpServers)` guards the connection.

### 3. Add `npm run compile-policy:readonly` Convenience Script

The existing `compile-policy` script routes through `src/cli.ts`. The readonly variant should follow the same pattern.

**File:** `package.json`

```json
{
  "scripts": {
    "compile-policy:readonly": "tsx src/cli.ts compile-policy --constitution src/config/constitution-readonly.md --output-dir src/config/generated-readonly --no-mcp"
  }
}
```

This makes it easy to regenerate the read-only policy. The resulting artifacts are committed to the repo (they ship with the package as defaults).

### 4. Policy-Mediated List Resolution

The list resolver's MCP calls must be routed through a PolicyEngine loaded with the read-only compiled policy. This ensures the LLM cannot accidentally invoke mutating tools (sending emails, deleting files, pushing code) during list resolution.

**Architecture:** Instead of the list resolver calling MCP tools directly via `connection.client.callTool()`, each tool call is first evaluated by a PolicyEngine. Only calls that the read-only policy allows are forwarded to the MCP server. Denied and escalated calls are blocked with an error message returned to the LLM.

**Design choice:** The PolicyEngine is a required field on `ListResolverConfig`, not a parameter to `bridgeMcpTools`. This keeps the policy decision at the config level (where it belongs) and `bridgeMcpTools` receives it from the config. MCP-backed list resolution without a PolicyEngine is an error.

**File:** `src/pipeline/list-resolver.ts`

```typescript
import { PolicyEngine } from '../trusted-process/policy-engine.js';
import type { ToolCallRequest } from '../types/mcp.js';

export interface ListResolverConfig {
  readonly model: LanguageModel;
  readonly mcpConnections?: ReadonlyMap<string, McpServerConnection>;
  /**
   * PolicyEngine loaded with the read-only policy. Required for MCP-backed
   * list resolution. Ensures only read-only operations are permitted.
   */
  readonly policyEngine?: PolicyEngine;
}
```

The `bridgeMcpTools` function receives the PolicyEngine from the config and gates each call:

```typescript
/**
 * Bridges MCP server tools as AI SDK tools with execute functions
 * that route calls through the policy engine before forwarding.
 */
function bridgeMcpTools(
  serverName: string,
  connection: McpServerConnection,
  policyEngine: PolicyEngine,
): ToolSet {
  const tools: ToolSet = {};
  for (const mcpTool of connection.tools) {
    const qualifiedName = `${serverName}__${mcpTool.name}`;
    const schema = { type: 'object' as const, ...mcpTool.inputSchema };

    tools[qualifiedName] = tool({
      description: mcpTool.description ?? `Tool: ${mcpTool.name}`,
      inputSchema: jsonSchema(schema),
      execute: async (args: unknown) => {
        // Evaluate the call against the read-only policy before forwarding.
        const request: ToolCallRequest = {
          serverName,
          toolName: mcpTool.name,
          arguments: args as Record<string, unknown>,
        };
        const decision = policyEngine.evaluate(request);

        if (decision.decision !== 'allow') {
          return `[POLICY BLOCKED] ${decision.reason}`;
        }

        const result = await connection.client.callTool({
          name: mcpTool.name,
          arguments: args as Record<string, unknown>,
        });
        if (Array.isArray(result.content)) {
          return result.content
            .filter((c: { type: string }) => c.type === 'text')
            .map((c: { text: string }) => c.text)
            .join('\n');
        }
        return JSON.stringify(result.content);
      },
    });
  }
  return tools;
}
```

In `resolveList()`, the PolicyEngine is passed through from the config:

```typescript
if (definition.requiresMcp) {
  if (!config.policyEngine) {
    throw new Error(
      `List "@${definition.name}" requires MCP access but no read-only PolicyEngine ` +
        `was provided. Ensure the read-only policy is compiled first ` +
        `(npm run compile-policy:readonly).`,
    );
  }
  // ... existing MCP connection selection ...
  const mcpTools = bridgeMcpTools(selected.serverName, selected.connection, config.policyEngine);
  rawValues = await resolveViaMcpTools(prompt, config.model, mcpTools, onProgress);
}
```

**PolicyEngine instantiation:** The caller (pipeline-runner or refresh-lists) loads the read-only compiled artifacts and creates a PolicyEngine. The `loadGeneratedPolicy` function takes a `PolicyLoadOptions` object:

```typescript
import { loadGeneratedPolicy, extractServerDomainAllowlists, getPackageGeneratedDir } from '../config/index.js';

// Read-only compiled policy lives in generated-readonly/.
// Tool annotations are shared -- they live in the main generated dir.
const readonlyPolicyDir = resolve(__dirname, '..', 'config', 'generated-readonly');
const mainAnnotationsDir = config.generatedDir;  // or getPackageGeneratedDir() as fallback

const readonlyArtifacts = loadGeneratedPolicy({
  policyDir: readonlyPolicyDir,
  toolAnnotationsDir: mainAnnotationsDir,
  fallbackDir: getPackageGeneratedDir(),
});

// For list resolution, filesystem concepts (protectedPaths, allowedDirectory) are
// irrelevant -- list resolution queries cloud services, not the local filesystem.
// Domain allowlists ARE relevant: they enforce the structural domain gate for
// URL-category roles (e.g., fetch-url, git-remote-url).
const serverDomainAllowlists = config.mcpServers
  ? extractServerDomainAllowlists(config.mcpServers)
  : undefined;

const policyEngine = new PolicyEngine(
  readonlyArtifacts.compiledPolicy,
  readonlyArtifacts.toolAnnotations as StoredToolAnnotationsFile,
  [],                      // protectedPaths: not relevant for cloud service calls
  undefined,               // allowedDirectory: not relevant for cloud service calls
  serverDomainAllowlists,  // structural domain gate for URL-category roles
);
```

Note on the type cast: `loadGeneratedPolicy` returns `ToolAnnotationsFile`, but `PolicyEngine` expects `StoredToolAnnotationsFile`. The on-disk JSON is always the stored format (it may contain conditional role specs). The `StoredToolAnnotationsFile` type extends `ToolAnnotationsFile` with optional conditional fields, so the runtime data is structurally compatible. The cast makes this explicit.

### 5. Staleness Detection

When loading the read-only policy for list resolution, validate that the read-only `compiled-policy.json` covers all servers present in `tool-annotations.json`. This catches the case where a new server has been onboarded but the read-only policy was not recompiled.

This is a warning, not a blocking error -- missing server coverage means the PolicyEngine will deny those tools via `structural-unknown-tool`, which is safe (overly restrictive, not overly permissive).

```typescript
/**
 * Warns if the read-only compiled policy is missing rules for servers
 * that appear in tool-annotations.json. This indicates the read-only
 * policy needs recompilation after a new server was onboarded.
 */
function checkReadonlyPolicyStaleness(
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: ToolAnnotationsFile,
): void {
  const annotatedServers = new Set(Object.keys(toolAnnotations.servers));

  // Collect servers mentioned in compiled rules (via server conditions)
  const coveredServers = new Set<string>();
  for (const rule of compiledPolicy.rules) {
    if (rule.if.server) {
      for (const s of rule.if.server) coveredServers.add(s);
    }
  }

  for (const server of annotatedServers) {
    if (!coveredServers.has(server)) {
      console.error(
        `  Warning: read-only policy has no rules for server "${server}". ` +
          `Run "npm run compile-policy:readonly" to update.`,
      );
    }
  }
}
```

Called once when constructing the list resolver's PolicyEngine, before any list resolution begins.

### 6. Make All MCP Servers Available for List Resolution by Default

Currently, `connectMcpServersForLists()` only connects to servers that are hinted by list definitions or, when any list lacks a hint, connects to all configured servers. The function already handles the "connect all" case correctly. The issue is that `refresh-lists` requires `--with-mcp` to connect to any MCP server at all.

**Change:** Make `--with-mcp` the default for both `compile-policy` and `refresh-lists` when MCP-requiring lists exist. The current `--with-mcp` flag becomes a no-op (kept for backward compatibility), and a new `--no-mcp` flag is added to explicitly skip MCP connections.

**File:** `src/pipeline/refresh-lists.ts`

```typescript
interface RefreshListsOptions {
  readonly listName?: string;
  readonly withMcp: boolean;  // now defaults to true
}

function parseRefreshArgs(args: string[]): RefreshListsOptions | null {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h' },
      list: { type: 'string' },
      'with-mcp': { type: 'boolean' },
      'no-mcp': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false,
  });
  // ...
  return {
    listName: values.list as string | undefined,
    withMcp: values['no-mcp'] ? false : true,
  };
}
```

**File:** `src/pipeline/pipeline-runner.ts` (`resolveServerLists`)

No changes needed -- it already connects to MCP servers when `config.mcpServers` is provided and lists require MCP. The `config.mcpServers` is always passed from `compile.ts`.

### 7. Graceful Server Connection Failures

`connectMcpServersForLists()` already returns `null` entries for servers that fail to connect. However, the current behavior throws if *no* MCP server connects and a list requires one. For the "all servers available by default" model, some servers may legitimately be unavailable (Docker not running, credentials not configured).

**File:** `src/pipeline/mcp-connections.ts`

Wrap the individual server connection in a try-catch so a single server failure doesn't prevent other servers from connecting:

```typescript
const entries = await Promise.all(
  [...neededServers].map(async (serverName): Promise<[string, McpServerConnection] | null> => {
    const serverConfig = mcpServers[serverName];
    if (!serverConfig) {
      console.error(`  ${chalk.yellow('Warning:')} MCP server "${serverName}" not configured -- skipping`);
      return null;
    }
    try {
      // ... existing connection logic ...
      return [serverName, { client, tools: toolsResult.tools }];
    } catch (err) {
      console.error(`  ${chalk.yellow('Warning:')} Failed to connect to "${serverName}" -- skipping: ${(err as Error).message}`);
      return null;
    }
  }),
);
```

This is already partially the case (the function uses `Promise.all` and filters nulls), but adding the try-catch around the connect/listTools calls ensures transport failures don't reject the entire batch.

## How the Read-Only Policy Compilation Fits Into the Existing Pipeline

The read-only policy compilation uses the **exact same code path** as the normal `compile-policy`, with `--no-mcp` to skip MCP connections:

```
compile.ts (CLI) -- with --constitution, --output-dir, and --no-mcp flags
  --> loadPipelineConfig({ constitution, outputDir })
  --> PipelineRunner.run({ constitutionKind: 'constitution', mcpServers: undefined, ... })
    --> runPerServer()
      --> compileAllServers() -- loops over each server in tool-annotations.json
        --> compileServer() -- per-server compile-verify-repair cycle
      --> mergeServerResults() -- combine into single compiled-policy.json
      --> resolve dynamic lists: skipped (no mcpServers, no lists expected)
```

The only differences are:
- **Input:** `constitution-readonly.md` instead of `constitution.md`
- **Output:** `src/config/generated-readonly/` instead of `~/.ironcurtain/generated/`
- **MCP:** No MCP connections (read-only constitution has no dynamic lists)
- **Semantics:** The read-only constitution is more permissive for reads and more restrictive for writes (everything mutating escalates).

## How MCP Servers Are Made Available to List Resolution

The data flow for MCP-backed list resolution (during main `compile-policy`):

```
compile-policy (main, without --no-mcp)
  --> loadPipelineConfig() provides mcpServers (from mcp-servers.json)
  --> PipelineRunner.run() receives mcpServers in PipelineRunConfig
  --> resolveServerLists() checks if any list has requiresMcp: true
    --> connectMcpServersForLists(definitions, mcpServers)
      --> connects to servers matching list hints (or all if unhinted)
      --> returns Map<serverName, McpServerConnection>
    --> loads read-only compiled artifacts from generated-readonly/
    --> creates PolicyEngine with read-only policy + domain allowlists
    --> checkReadonlyPolicyStaleness() warns if servers are uncovered
    --> resolveAllLists() uses connections + PolicyEngine for tool-use resolution
      --> bridgeMcpTools() wraps each tool call with policy evaluation
      --> only read-only operations are forwarded; mutations return error text to LLM
    --> disconnectMcpServers() cleans up
```

After changes:
- `refresh-lists` connects to MCP servers by default (was opt-in via `--with-mcp`).
- `compile-policy` already passes `mcpServers` through; no change needed.
- `connectMcpServersForLists()` gracefully handles unavailable servers.
- The read-only policy mediates all list resolver MCP calls, blocking mutations.

## Implementation Steps

### PR 1: Read-only constitution update, `--no-mcp` flag, and compilation

1. **Update `src/config/constitution-readonly.md`** -- add general read-only principles for all onboarded servers.
2. **Add `--no-mcp` flag to `src/pipeline/compile.ts`** -- when set, suppress `mcpServers` in `PipelineRunConfig`.
3. **Add `compile-policy:readonly` script** to `package.json` using `--constitution`, `--output-dir`, and `--no-mcp` flags.
4. **Run `npm run compile-policy:readonly`** to regenerate `src/config/generated-readonly/compiled-policy.json` and `test-scenarios.json`.
5. **Commit the regenerated artifacts** -- they ship with the package.

### PR 2: Policy-mediated list resolution

1. **Update `src/pipeline/list-resolver.ts`** -- add `policyEngine` to `ListResolverConfig`, route `bridgeMcpTools` execute calls through `policyEngine.evaluate()`, error if MCP-backed resolution is attempted without a policy engine.
2. **Add `checkReadonlyPolicyStaleness()`** -- warn when read-only policy is missing rules for annotated servers.
3. **Update `src/pipeline/pipeline-runner.ts`** -- load read-only compiled artifacts via `loadGeneratedPolicy({ policyDir, toolAnnotationsDir })`, create PolicyEngine with `protectedPaths: []`, `allowedDirectory: undefined`, and `serverDomainAllowlists` from MCP server config.
4. **Update `src/pipeline/refresh-lists.ts`** -- same: load read-only policy and pass PolicyEngine to resolver.
5. **Add tests** verifying that mutating tool calls are blocked during list resolution.

### PR 3: Default MCP connections for list resolution

1. **Update `src/pipeline/refresh-lists.ts`** -- flip `withMcp` default to `true`, add `--no-mcp` flag.
2. **Update `src/pipeline/mcp-connections.ts`** -- add try-catch around individual server connections.
3. **Update CLI help text** in `refresh-lists.ts` to reflect the new defaults.
4. **Update `src/cli.ts` examples** if needed.

PR 1 must land first. PR 2 depends on PR 1 (needs the read-only compiled artifacts). PR 3 is independent of PR 2 and can be reviewed in parallel with it.

## Key Files to Modify

| File | Change |
|------|--------|
| `src/config/constitution-readonly.md` | Add general read-only principles for all servers |
| `src/pipeline/compile.ts` | Add `--no-mcp` flag, suppress mcpServers when set |
| `src/pipeline/list-resolver.ts` | Add `policyEngine` to config, route MCP calls through policy |
| `src/pipeline/pipeline-runner.ts` | Load read-only artifacts, create PolicyEngine for list resolution |
| `src/pipeline/refresh-lists.ts` | Default `withMcp` to `true`, add `--no-mcp`, load read-only policy |
| `src/pipeline/mcp-connections.ts` | Try-catch around individual server connections |
| `src/config/generated-readonly/compiled-policy.json` | Regenerated (committed artifact) |
| `src/config/generated-readonly/test-scenarios.json` | Regenerated (committed artifact) |
| `package.json` | Add `compile-policy:readonly` script |

## Non-Goals

- **Per-server output directories for read-only policy.** The read-only `generated-readonly/` dir does not need `servers/` subdirectories since the per-server artifacts are intermediate build products. Only the merged `compiled-policy.json` and `test-scenarios.json` are needed at runtime.

  *However*, the per-server pipeline will write to `outputDir/servers/<name>/` as part of its normal operation. These intermediate files will be created in `generated-readonly/servers/` during compilation and should be `.gitignore`d or cleaned up post-compilation. The simplest approach is to let them exist (they are useful for debugging) and add `src/config/generated-readonly/servers/` to `.gitignore`.

- **Automatic recompilation of read-only policy.** The read-only policy is compiled manually by developers when new servers are onboarded. It does not need to be part of the regular `compile-policy` flow.

- **Dynamic lists in the read-only policy.** The read-only constitution does not reference dynamic lists. The `--no-mcp` flag ensures no MCP connections are attempted. If a future read-only constitution somehow produces list definitions, the pipeline handles them normally (knowledge-based lists work without MCP; MCP-backed lists would fail due to `--no-mcp`).

- **Escalation handling in list resolution.** When the read-only policy returns `escalate` for a list resolver MCP call, it is treated the same as `deny` -- the call is blocked and an error message is returned to the LLM. There is no human in the loop during offline pipeline execution.
