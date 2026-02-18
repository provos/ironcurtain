# MCP Roots Integration Design

## Problem

The compiled policy (`src/config/generated/compiled-policy.json`) grants access to directories beyond the sandbox -- for example, `~/Downloads` for read/write/delete and `~/Documents` for read-only. However, the filesystem MCP server is launched with only the sandbox directory as a CLI argument:

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/ironcurtain-sandbox"]
  }
}
```

The filesystem server rejects any request targeting a path outside its configured directories *before* IronCurtain's policy engine can evaluate it. This means the policy rules for `~/Downloads` and `~/Documents` are dead code -- they can never match because the server-side check fires first.

Additionally, the compiled policy includes a catch-all `escalate-read-outside-permitted-areas` rule that escalates reads outside all permitted areas to a human for approval. Even when a human approves, the filesystem server rejects the call because the target directory was never in its allowed list.

## Solution

Use the MCP Roots protocol to dynamically communicate policy-referenced directories to the filesystem MCP server. At connection time, roots are seeded from the compiled policy. When a human approves an escalation for a path outside the current roots, the containing directory is added as a new root and the server is notified via `notifications/roots/list_changed` before the call is forwarded.

This creates defense in depth: the MCP server enforces broad directory boundaries, and the policy engine enforces fine-grained per-role rules within those boundaries.

## Key Design Decisions

1. **Extract directories from compiled policy, not the constitution.** The compiled policy is the canonical source of truth at runtime. Parsing the constitution's prose would be fragile and redundant since the pipeline already distills it into structured rules.

2. **Standalone extraction function, not a PolicyEngine method.** Directory extraction is a startup concern, not a per-request concern. It operates on the `CompiledPolicyFile` data structure directly. Putting it in PolicyEngine would conflate construction-time setup with the evaluation interface.

3. **Always include the sandbox directory.** The `ALLOWED_DIRECTORY` is the unconditional baseline that the structural invariant auto-allows. Even if no compiled rule references it explicitly, it must be a root.

4. **Each process computes its own roots from the compiled policy.** Both the proxy (`mcp-proxy-server.ts`) and the in-process mode (`TrustedProcess`) already load the compiled policy at startup. Each computes its initial roots directly -- no env var needed to pass pre-computed roots between processes.

5. **Keep CLI args as fallback.** If the filesystem server does not support the roots protocol, the CLI arg still provides the sandbox directory. When roots are provided, the filesystem server ignores CLI args entirely, so there is no conflict.

6. **Dynamic root expansion on escalation approval.** When a human approves an escalation, the containing directory of the target path is added as a new root and the filesystem server is notified via `notifications/roots/list_changed`. The `listChanged` capability is declared as `true` at connection time to signal that root updates may occur. The implementation must ensure the server has processed the updated roots before forwarding the approved call.

## Extraction and Conversion Functions

### `src/trusted-process/policy-roots.ts`

A new module with pure functions for root extraction, conversion, and path-to-directory mapping.

```typescript
import { resolve, dirname } from 'node:path';
import type { CompiledPolicyFile } from '../pipeline/types.js';

/**
 * Root entry for the MCP Roots protocol.
 * Mirrors the MCP SDK's Root type without importing it directly,
 * keeping this module free of SDK dependencies.
 */
export interface PolicyRoot {
  /** Absolute directory path (not a file:// URI yet -- callers convert). */
  readonly path: string;
  /** Human-readable label for debugging and audit logs. */
  readonly name: string;
}

/**
 * Extracts the set of directories that the compiled policy references
 * in `allow` or `escalate` rules with `paths.within` conditions.
 * These directories, plus the sandbox, form the initial roots that
 * MCP servers should accept.
 *
 * `deny` rules are excluded -- they never grant access, so exposing
 * denied directories as roots would widen the server-side boundary
 * without purpose.
 *
 * Catch-all rules without `paths.within` (like
 * `escalate-read-outside-permitted-areas`) are also excluded from
 * initial roots. Those are handled dynamically: when a human approves
 * an escalation, the target directory is added as a root at that time.
 *
 * @param compiledPolicy - The loaded compiled policy artifact.
 * @param allowedDirectory - The sandbox directory (always included).
 * @returns Deduplicated array of PolicyRoot entries, sandbox first.
 */
export function extractPolicyRoots(
  compiledPolicy: CompiledPolicyFile,
  allowedDirectory: string,
): PolicyRoot[] {
  const seen = new Set<string>();
  const roots: PolicyRoot[] = [];

  // Sandbox is always the first root.
  const resolvedSandbox = resolve(allowedDirectory);
  seen.add(resolvedSandbox);
  roots.push({ path: resolvedSandbox, name: 'sandbox' });

  for (const rule of compiledPolicy.rules) {
    if (rule.then === 'deny') continue;
    if (!rule.if.paths?.within) continue;

    const dir = resolve(rule.if.paths.within);
    if (seen.has(dir)) continue;

    seen.add(dir);
    roots.push({ path: dir, name: rule.name });
  }

  return roots;
}

/**
 * Converts PolicyRoot entries to MCP Root objects with `file://` URIs.
 */
export function toMcpRoots(
  policyRoots: PolicyRoot[],
): Array<{ uri: string; name: string }> {
  return policyRoots.map(r => ({
    uri: `file://${r.path}`,
    name: r.name,
  }));
}

/**
 * Extracts the containing directory for a filesystem path.
 * Used to derive the root directory when a human approves an
 * escalation -- the approved path's parent directory becomes a root
 * so the filesystem server will accept the forwarded call.
 *
 * If the path is itself a directory (no extension, ends with /),
 * it is returned as-is after resolution.
 */
export function directoryForPath(filePath: string): string {
  const resolved = resolve(filePath);
  // If path ends with / or has no extension hint, treat as directory.
  // Otherwise use dirname to get the containing directory.
  if (resolved.endsWith('/')) return resolved.slice(0, -1);
  return dirname(resolved);
}
```

### Design notes on the extraction logic

- **`resolve()` before deduplication.** Two rules might reference the same directory with different relative/absolute forms. Resolving first ensures deduplication is reliable.
- **`deny` rules excluded.** A `deny` rule for a directory does not imply the server should accept files from that directory. Only `allow` and `escalate` rules indicate that file operations in those directories are potentially valid.
- **Catch-all escalation rules excluded from initial roots.** Rules like `escalate-read-outside-permitted-areas` have no `paths.within` condition -- they match *any* path. Including them would mean "allow access everywhere", defeating the purpose of roots. Instead, these are handled dynamically when a human approves the escalation.
- **Sandbox always first.** The sandbox is the primary working directory. Listing it first makes log output easier to scan.

## Changes to MCPClientManager

The `connect` method gains an optional `roots` parameter. When provided, the client declares the `roots` capability with `listChanged: true` and registers a handler for the `roots/list` request. The roots array is mutable -- new roots can be added after connection via `addRoot()`.

```typescript
// src/trusted-process/mcp-client-manager.ts

import {
  ListRootsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export interface McpRoot {
  uri: string;
  name: string;
}

interface ManagedServer {
  client: Client;
  transport: StdioClientTransport;
  roots?: McpRoot[];               // Mutable roots list (if roots enabled)
  rootsRefreshed?: () => void;     // Resolves when server fetches updated roots
}

export class MCPClientManager {
  private servers = new Map<string, ManagedServer>();

  async connect(
    name: string,
    config: MCPServerConfig,
    roots?: McpRoot[],
  ): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env
        ? { ...process.env as Record<string, string>, ...config.env }
        : undefined,
    });

    const capabilities: Record<string, unknown> = {};
    if (roots) {
      capabilities.roots = { listChanged: true };
    }

    const client = new Client(
      { name: 'ironcurtain', version: '0.1.0' },
      { capabilities },
    );

    // Mutable copy -- addRoot() pushes to this array.
    const mutableRoots = roots ? [...roots] : undefined;
    const managed: ManagedServer = { client, transport, roots: mutableRoots };

    // When the server asks for roots, return the current set.
    // If a rootsRefreshed callback is registered (from addRoot),
    // resolve it so the caller knows the server has the latest roots.
    if (mutableRoots) {
      client.setRequestHandler(ListRootsRequestSchema, async () => {
        if (managed.rootsRefreshed) {
          managed.rootsRefreshed();
          managed.rootsRefreshed = undefined;
        }
        return { roots: mutableRoots };
      });
    }

    await client.connect(transport);
    this.servers.set(name, managed);
  }

  /**
   * Adds a root directory to a connected server and waits for the
   * server to fetch the updated root list. This ensures the server's
   * allowed directories include the new root before any tool call
   * that depends on it is forwarded.
   *
   * No-op if the root URI is already present.
   */
  async addRoot(serverName: string, root: McpRoot): Promise<void> {
    const server = this.servers.get(serverName);
    if (!server?.roots) return;

    // Deduplicate
    if (server.roots.some(r => r.uri === root.uri)) return;
    server.roots.push(root);

    // Wait for the server to call roots/list after we notify it.
    const refreshed = new Promise<void>(resolve => {
      server.rootsRefreshed = resolve;
    });
    await server.client.sendRootsListChanged();
    await refreshed;
  }

  // ... listTools, callTool, closeAll unchanged
}
```

### Synchronization: why `addRoot` awaits acknowledgment

After calling `sendRootsListChanged()`, the server asynchronously sends a `roots/list` request to fetch the updated roots. If we forward the tool call immediately, the server might process it before the roots update completes. By waiting for our `roots/list` handler to fire, we know the server has received the updated root set before we send the tool call.

## Changes to Proxy Mode (mcp-proxy-server.ts)

The proxy already loads the compiled policy and has `ALLOWED_DIRECTORY` in its environment. It computes roots directly -- no additional env var from the sandbox needed.

### Initialization

```typescript
// In mcp-proxy-server.ts main(), after loading policy:

const { compiledPolicy, toolAnnotations } = loadGeneratedPolicy(generatedDir);

// Compute initial roots from compiled policy
import { extractPolicyRoots, toMcpRoots, directoryForPath } from './policy-roots.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const policyRoots = extractPolicyRoots(compiledPolicy, allowedDirectory ?? '/tmp');
const mcpRoots = toMcpRoots(policyRoots);

// Track per-client mutable roots and acknowledgment callbacks
interface ClientState {
  client: Client;
  roots: Array<{ uri: string; name: string }>;
  rootsRefreshed?: () => void;
}
const clientStates = new Map<string, ClientState>();
```

### Client connection with roots

```typescript
for (const [serverName, config] of Object.entries(serversConfig)) {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env
      ? { ...(process.env as Record<string, string>), ...config.env }
      : undefined,
    stderr: 'pipe',
  });

  // ... existing stderr handling ...

  const roots = [...mcpRoots]; // Mutable copy per client
  const state: ClientState = { client: undefined!, roots };

  const client = new Client(
    { name: 'ironcurtain-proxy', version: '0.1.0' },
    { capabilities: { roots: { listChanged: true } } },
  );
  state.client = client;

  client.setRequestHandler(ListRootsRequestSchema, async () => {
    if (state.rootsRefreshed) {
      state.rootsRefreshed();
      state.rootsRefreshed = undefined;
    }
    return { roots: state.roots };
  });

  await client.connect(transport);
  clientStates.set(serverName, state);

  // ... existing tool listing ...
}
```

### Escalation-triggered root expansion

In the escalation approval branch, before forwarding the call:

```typescript
if (evaluation.decision === 'escalate') {
  // ... existing escalation handling ...

  if (decision === 'approved') {
    escalationResult = 'approved';
    policyDecision.status = 'allow';
    policyDecision.reason = 'Approved by human during escalation';

    // Expand roots to include the target directory so the filesystem
    // server accepts the forwarded call.
    const state = clientStates.get(toolInfo.serverName);
    if (state) {
      const paths = Object.values(argsForTransport).filter(
        (v): v is string => typeof v === 'string',
      );
      for (const p of paths) {
        const dir = directoryForPath(p);
        const uri = `file://${dir}`;
        if (!state.roots.some(r => r.uri === uri)) {
          state.roots.push({ uri, name: `escalation-approved` });
          const refreshed = new Promise<void>(resolve => {
            state.rootsRefreshed = resolve;
          });
          await state.client.sendRootsListChanged();
          await refreshed;
        }
      }
    }
  }
}
```

## Changes to In-Process Mode (TrustedProcess)

The `TrustedProcess` class computes roots in its constructor and passes them through the updated `connect` signature. After escalation approval, it calls `addRoot` before forwarding.

```typescript
// In src/trusted-process/index.ts

import { extractPolicyRoots, toMcpRoots, directoryForPath } from './policy-roots.js';
import type { McpRoot } from './mcp-client-manager.js';

export class TrustedProcess {
  // ... existing fields ...
  private mcpRoots: McpRoot[];

  constructor(private config: IronCurtainConfig, options?: TrustedProcessOptions) {
    const { compiledPolicy, toolAnnotations } = loadGeneratedPolicy(config.generatedDir);
    this.policyEngine = new PolicyEngine(
      compiledPolicy, toolAnnotations, config.protectedPaths, config.allowedDirectory,
    );

    const policyRoots = extractPolicyRoots(compiledPolicy, config.allowedDirectory);
    this.mcpRoots = toMcpRoots(policyRoots);

    this.mcpManager = new MCPClientManager();
    this.auditLog = new AuditLog(config.auditLogPath);
    this.escalation = new EscalationHandler();
    this.onEscalation = options?.onEscalation;
  }

  async initialize(): Promise<void> {
    for (const [name, serverConfig] of Object.entries(this.config.mcpServers)) {
      logger.info(`Connecting to MCP server: ${name}...`);
      await this.mcpManager.connect(name, serverConfig, this.mcpRoots);
      logger.info(`Connected to MCP server: ${name}`);
    }
  }

  async handleToolCall(request: ToolCallRequest): Promise<ToolCallResult> {
    // ... existing policy evaluation and escalation handling ...

    // After escalation is approved, expand roots before forwarding:
    if (escalationResult === 'approved') {
      const paths = Object.values(transportRequest.arguments).filter(
        (v): v is string => typeof v === 'string',
      );
      for (const p of paths) {
        const dir = directoryForPath(p);
        await this.mcpManager.addRoot(transportRequest.serverName, {
          uri: `file://${dir}`,
          name: 'escalation-approved',
        });
      }
    }

    // ... existing forwarding logic ...
  }
}
```

## Changes to Configuration

### Keep CLI args unchanged

The filesystem server CLI args continue to include the sandbox directory. This serves as a fallback for MCP servers that do not support the roots protocol. When roots are provided, the filesystem server ignores CLI args entirely, so there is no conflict.

### No changes to `mcp-servers.json` or `loadConfig()`

The static config remains the same. The dynamic roots overlay is computed at runtime from the compiled policy. This keeps the configuration layered: static defaults in JSON, dynamic policy-derived roots computed at startup.

### No changes to `src/sandbox/index.ts`

The proxy computes its own roots from the compiled policy it already loads. No additional env var or data passing is needed.

## Component Flow

### Startup

```
Process startup (proxy or in-process)
    |
    v
loadGeneratedPolicy(generatedDir)
    |
    v
extractPolicyRoots(compiledPolicy, allowedDirectory)
    |  Returns: [{ path: ".../sandbox", name: "sandbox" },
    |            { path: "/home/provos/Downloads", name: "allow-rwd-downloads" },
    |            { path: "/home/provos/Documents", name: "allow-read-documents" }]
    v
toMcpRoots(policyRoots)
    |  Returns: [{ uri: "file:///.../sandbox", name: "sandbox" },
    |            { uri: "file:///home/provos/Downloads", name: "..." },
    |            { uri: "file:///home/provos/Documents", name: "..." }]
    v
Client({ capabilities: { roots: { listChanged: true } } })
client.setRequestHandler(ListRootsRequestSchema, () => ({ roots }))
client.connect(transport)
    |
    v
Filesystem MCP server calls roots/list
    |
    v
Server receives [sandbox, ~/Downloads, ~/Documents]
Server accepts files within any of those directories
```

### Escalation with dynamic root expansion

```
Agent requests read_file({ path: "/etc/hosts" })
    |
    v
PolicyEngine.evaluate() → escalate (catch-all rule)
    |
    v
Human prompted → approves
    |
    v
directoryForPath("/etc/hosts") → "/etc"
    |
    v
addRoot / roots.push({ uri: "file:///etc", name: "escalation-approved" })
    |
    v
client.sendRootsListChanged()
    |
    v
Server calls roots/list → receives [...existing, { uri: "file:///etc" }]
Server updates allowed directories
    |
    v
client.callTool("read_file", { path: "/etc/hosts" })
    |
    v
Server accepts (path within /etc root) → returns file content
```

## Defense in Depth

After this change, three layers enforce directory boundaries:

1. **Filesystem MCP server** (roots-based): Rejects requests to paths outside the declared roots. This is the broadest gate. Roots expand over time as escalations are approved.
2. **PolicyEngine structural invariants**: Protected path checks. Auto-allows all paths within the sandbox.
3. **PolicyEngine compiled rules**: Fine-grained per-role decisions (e.g., allow reads in `~/Documents` but deny writes).

### Example: write to ~/Documents (denied)

A request to write to `~/Documents/secret.txt` would:
- Pass the filesystem server (root includes `~/Documents`)
- Pass the structural invariants (not a protected path, not in sandbox)
- Hit compiled rule evaluation: `allow-read-documents` does not match (wrong role: `write-path` not in `["read-path"]`)
- Hit `deny-write-outside-permitted-areas` and be denied

### Example: read outside all permitted areas (escalated, then approved)

A request to read `/etc/hosts` would:
- Policy engine evaluates → `escalate-read-outside-permitted-areas` matches
- Human is prompted and approves
- `/etc` is added as a root; server is notified and acknowledges
- Call is forwarded to filesystem server, which now accepts paths within `/etc`
- File content returned to agent

### Example: read outside all permitted areas (escalated, then denied)

A request to read `/etc/shadow` would:
- Policy engine evaluates → `escalate-read-outside-permitted-areas` matches
- Human is prompted and denies
- No root expansion occurs
- Call is rejected; filesystem server never sees it

## Testing Strategy

### Unit tests for `extractPolicyRoots`

Test the extraction function in isolation with synthetic `CompiledPolicyFile` data.

```typescript
// test/policy-roots.test.ts

describe('extractPolicyRoots', () => {
  it('always includes the sandbox directory as the first root', () => {
    const policy = makePolicyFile([]); // no rules
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toEqual([{ path: '/tmp/sandbox', name: 'sandbox' }]);
  });

  it('extracts directories from allow rules with paths.within', () => {
    const policy = makePolicyFile([
      makeRule({ then: 'allow', paths: { roles: ['read-path'], within: '/home/user/Downloads' } }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(2);
    expect(roots[1].path).toBe('/home/user/Downloads');
  });

  it('extracts directories from escalate rules with paths.within', () => {
    const policy = makePolicyFile([
      makeRule({ then: 'escalate', paths: { roles: ['read-path'], within: '/home/user/Desktop' } }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(2);
  });

  it('excludes deny rules', () => {
    const policy = makePolicyFile([
      makeRule({ then: 'deny', paths: { roles: ['delete-path'], within: '/home/user/important' } }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(1); // sandbox only
  });

  it('excludes catch-all rules without paths.within', () => {
    const policy = makePolicyFile([
      makeRule({ then: 'escalate' }), // no paths condition -- catch-all
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(1); // sandbox only
  });

  it('deduplicates directories referenced by multiple rules', () => {
    const policy = makePolicyFile([
      makeRule({ then: 'allow', paths: { roles: ['read-path'], within: '/home/user/Downloads' } }),
      makeRule({ then: 'allow', paths: { roles: ['write-path'], within: '/home/user/Downloads' } }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(2); // sandbox + Downloads (once)
  });
});
```

### Unit tests for `toMcpRoots`

```typescript
describe('toMcpRoots', () => {
  it('converts paths to file:// URIs', () => {
    const mcpRoots = toMcpRoots([
      { path: '/tmp/sandbox', name: 'sandbox' },
      { path: '/home/user/Downloads', name: 'downloads' },
    ]);
    expect(mcpRoots).toEqual([
      { uri: 'file:///tmp/sandbox', name: 'sandbox' },
      { uri: 'file:///home/user/Downloads', name: 'downloads' },
    ]);
  });
});
```

### Unit tests for `directoryForPath`

```typescript
describe('directoryForPath', () => {
  it('returns dirname for a file path', () => {
    expect(directoryForPath('/etc/hosts')).toBe('/etc');
  });

  it('returns the directory itself for a trailing-slash path', () => {
    expect(directoryForPath('/home/user/Documents/')).toBe('/home/user/Documents');
  });

  it('resolves relative paths before extracting directory', () => {
    expect(directoryForPath('relative/file.txt')).toBe(resolve('relative'));
  });
});
```

### Unit tests for `MCPClientManager.addRoot`

```typescript
describe('MCPClientManager.addRoot', () => {
  it('deduplicates roots with the same URI', async () => {
    // After connecting with initial roots, adding a duplicate should be a no-op
  });

  it('notifies the server and waits for roots/list before returning', async () => {
    // Verify sendRootsListChanged is called and addRoot blocks
    // until the roots/list handler fires
  });
});
```

### Integration test

A new integration test should verify the end-to-end flow with a real filesystem server. Create two temp directories: one as the sandbox (passed as CLI arg and ALLOWED_DIRECTORY) and one as an "external" directory. Configure a compiled policy that allows reads in the external directory. Verify that `read_file` on a file in the external directory succeeds -- confirming roots were communicated to the server.

A second integration test should verify escalation-triggered root expansion: configure a policy where reads outside permitted areas escalate, approve the escalation, and verify the file read succeeds after root expansion.

## Migration Notes

### Files to modify

| File | Change |
|---|---|
| `src/trusted-process/policy-roots.ts` | **New.** `extractPolicyRoots()`, `toMcpRoots()`, `directoryForPath()`. |
| `src/trusted-process/mcp-client-manager.ts` | Add optional `roots` parameter to `connect()`. Declare `roots` capability with `listChanged: true`. Register `roots/list` handler. Add `addRoot()` method with acknowledgment synchronization. |
| `src/trusted-process/mcp-proxy-server.ts` | Compute roots from own compiled policy. Declare `roots` capability on downstream clients. Expand roots on escalation approval before forwarding. |
| `src/trusted-process/index.ts` | Compute roots in constructor. Pass to `MCPClientManager.connect()`. Call `addRoot()` after escalation approval. |
| `test/policy-roots.test.ts` | **New.** Unit tests for extraction, conversion, and directory extraction. |

### Files unchanged

| File | Reason |
|---|---|
| `src/sandbox/index.ts` | Proxy computes its own roots. No env var needed. |
| `src/config/index.ts` | No changes to `loadConfig()` or `loadGeneratedPolicy()`. |
| `src/config/mcp-servers.json` | CLI args retained as fallback. |
| `src/trusted-process/policy-engine.ts` | Evaluation logic unchanged. Roots are a transport concern, not a policy concern. |
| `src/pipeline/*` | Compilation pipeline unchanged. No new artifacts. |
| `src/config/constitution.md` | Constitution unchanged. |

### Migration order

This is a single self-contained change. All modifications can land in one PR. The roots capability is additive -- it does not break existing behavior when the filesystem server does not support roots (the server would simply not call `roots/list`), and when it does support roots, the CLI args become redundant but harmless.

### Risks

- **Filesystem server version.** The `@modelcontextprotocol/server-filesystem` package must support the Roots protocol. If the installed version predates roots support, the server will never call `roots/list` and behavior falls back to CLI args only. This is safe but means the policy-allowed directories outside the sandbox remain unreachable. The fix is to upgrade the server package.
- **Path format on non-POSIX systems.** The `file://` URI construction uses a simple prefix. On Windows, paths like `C:\Users\...` would need `file:///C:/Users/...` form. This is not a concern for the current Linux-only deployment.
- **Escalation root granularity.** When a human approves an escalation for `/etc/hosts`, the entire `/etc` directory becomes a root. This is broader than the single file, but the policy engine still controls what operations are allowed within that directory. A future refinement could use more granular roots, but the MCP Roots protocol operates at directory level.
- **Root accumulation.** Escalation-approved roots persist for the lifetime of the session. They are not revoked. This is acceptable because each escalation required explicit human approval, and the policy engine continues to enforce rules regardless of root state.
