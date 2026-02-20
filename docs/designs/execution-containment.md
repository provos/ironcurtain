# TB0: Execution Containment Design Specification

## Overview

IronCurtain's policy engine operates at the MCP protocol layer: it inspects structured tool-call arguments and makes allow/deny/escalate decisions. This is effective for tools with semantically inspectable arguments (filesystem reads, git operations) but insufficient for exec-like tools where the agent writes code and then runs it. A test runner tool call looks legitimate (`run_tests(path: "/sandbox/repo")`) even when the test file contains `curl` exfiltration or `rm -rf /`.

Execution containment adds a second security layer using `@anthropic-ai/sandbox-runtime` to wrap MCP server processes in OS-level sandboxes. The sandbox restricts what side effects a running process can have: filesystem scope, network access, and process isolation. This is the hard boundary that catches everything the policy engine cannot see -- compromised MCP servers, indirect code execution, symlink race conditions, and network exfiltration.

The integration happens in the MCP proxy server (`mcp-proxy-server.ts`), which is the process that actually spawns real MCP server child processes. Each sandboxed server is spawned via a separate `srt` CLI process with its own settings file, giving each server fully independent sandbox infrastructure (filesystem restrictions, network proxy, and process isolation).

## Key Design Decisions

1. **Sandbox wrapping in the proxy process, not the parent.** The MCP proxy server (`mcp-proxy-server.ts`) is the process that spawns real MCP servers via `StdioClientTransport`. It writes per-server settings files and spawns each sandboxed server via the `srt` CLI. The parent session process does not interact with sandbox-runtime at all. This keeps the security boundary self-contained in the proxy.

2. **Per-server `srt` process for true network isolation.** `SandboxManager` is a singleton per Node.js process — its network proxy infrastructure (HTTP + SOCKS5) is process-wide. Empirical testing confirmed that `customConfig.network` in `wrapWithSandbox()` does NOT provide per-command network isolation. Each sandboxed MCP server therefore gets its own `srt` process with independent proxy infrastructure. This trades memory (~50 MB per `srt` process) for correct per-server network isolation. The proxy process itself never calls `SandboxManager.initialize()` — it only uses the stateless `isSupportedPlatform()` and `checkDependencies()` methods for the availability check.

3. **Sandbox-by-default with explicit opt-out.** When the `sandbox` field is omitted from an MCP server config, the server runs sandboxed with restrictive defaults: write access only to the session sandbox directory, no network. Servers must explicitly set `"sandbox": false` to opt out. This matches the secure-by-default principle: the dangerous state (no sandbox) requires deliberate action.

4. **Shell escaping via `shell-quote` for command string construction.** MCP server configs store `command` and `args` separately (e.g., `"command": "node"`, `"args": ["./servers/exec server.js"]`). Both `wrapWithSandbox()` and the `srt` CLI need a single shell-safe command string. Arguments may contain spaces, shell metacharacters (`$`, `` ` ``, `!`, `*`), or quotes. We use `shell-quote` (already a transitive dependency via `@anthropic-ai/sandbox-runtime`) to join command + args into a properly escaped string. The `srt` CLI also accepts a `-c` flag for pre-escaped command strings, which we use to avoid double-escaping.

    ```typescript
    import { quote } from 'shell-quote';

    // Safe: produces 'node ./servers/exec\ server.js'
    const cmdString = quote([config.command, ...config.args]);

    // Pass to srt with -c to avoid srt's own join-with-spaces behavior
    // srt -s <settings> -c <cmdString>
    ```

    `StdioClientTransport` uses `cross-spawn` with `shell: false`, taking `command` and `args` separately. The integration spawns the `srt` CLI directly: `command = 'srt'`, `args = ['-s', settingsPath, '-c', cmdString]`. This preserves stdio passthrough for MCP's JSON-RPC protocol while letting `srt` handle sandbox setup internally.

5. **Platform graceful degradation with configurable strictness.** On unsupported platforms (Windows, Linux without bubblewrap), the default behavior is to log a warning and continue without sandbox wrapping. A `sandboxPolicy` config field (`"enforce" | "warn"`) controls this: `"enforce"` fails hard if the sandbox is unavailable, `"warn"` (default) logs and continues. This accommodates development on non-Linux machines while allowing production deployments to mandate sandboxing.

6. **Session sandbox directory auto-mapped to `allowWrite`.** Each session already creates `~/.ironcurtain/sessions/{sessionId}/sandbox/`. The sandbox wrapper automatically includes this directory in `allowWrite` for all sandboxed servers. Additional `allowWrite` paths from the server config are appended. This means zero configuration for the common case while still allowing custom profiles for specialized servers like git.

7. **Sandbox-blocked operations annotated in MCP error responses.** When a sandboxed MCP server attempts an OS operation the sandbox blocks, the server process receives an EPERM error and returns it as an MCP error response. The proxy detects sandbox-characteristic error patterns (EPERM/EACCES after the policy engine allowed the call) and prefixes the error text with `[SANDBOX BLOCKED]` before returning it to the agent. This gives the LLM a clear signal that the operation was blocked by OS-level containment (not a server bug), discouraging retries. The audit log records `sandboxed: true` on the entry for forensic filtering.

## Interface Definitions

### Configuration Schema

```typescript
// src/config/types.ts

/**
 * Network access configuration for a sandboxed MCP server.
 *
 * Invariant: when `allowedDomains` is empty, no network access is permitted.
 * `deniedDomains` takes precedence and is checked first.
 */
export interface SandboxNetworkConfig {
  /** Domains the server may connect to. Supports wildcards (e.g., "*.github.com"). */
  readonly allowedDomains: string[];
  /** Domains explicitly blocked even if they match an allowed pattern. */
  readonly deniedDomains?: string[];
}

/**
 * Filesystem access configuration for a sandboxed MCP server.
 *
 * Invariant: `allowWrite` always includes the session sandbox directory
 * (injected at runtime, not specified here). Paths listed here are
 * *additional* write-allowed directories beyond the sandbox.
 *
 * Reads are allowed by default. Use `denyRead` to block sensitive
 * paths like ~/.ssh or ~/.gnupg.
 */
export interface SandboxFilesystemConfig {
  /** Additional directories the server may write to, beyond the session sandbox. */
  readonly allowWrite?: string[];
  /** Directories the server may not read. */
  readonly denyRead?: string[];
  /** Directories the server may not write to, even within allowed paths. */
  readonly denyWrite?: string[];
}

/**
 * Per-server sandbox configuration.
 *
 * Discriminated on presence/shape:
 * - `false`: server opts out of sandboxing entirely
 * - `object`: server is sandboxed with the specified overrides
 * - `undefined` (omitted): server is sandboxed with restrictive defaults
 *   (session sandbox write-only, no network)
 */
export type ServerSandboxConfig = false | {
  /** Filesystem restrictions beyond the automatic session sandbox directory. */
  readonly filesystem?: SandboxFilesystemConfig;
  /**
   * Network access. `false` means no network (default).
   * An object specifies allowed/denied domains.
   */
  readonly network?: false | SandboxNetworkConfig;
};

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** OS-level sandbox configuration. Omit for restrictive defaults, `false` to opt out. */
  sandbox?: ServerSandboxConfig;
}

/**
 * Controls behavior when sandbox-runtime is unavailable on the current
 * platform (e.g., Windows, Linux without bubblewrap).
 *
 * - "enforce": refuse to start servers that require sandboxing
 * - "warn": log a warning and start the server without sandbox (default)
 */
export type SandboxAvailabilityPolicy = 'enforce' | 'warn';

export interface IronCurtainConfig {
  auditLogPath: string;
  allowedDirectory: string;
  mcpServers: Record<string, MCPServerConfig>;
  protectedPaths: string[];
  generatedDir: string;
  constitutionPath: string;
  escalationDir?: string;
  sessionLogPath?: string;
  llmLogPath?: string;
  agentModelId: string;
  escalationTimeoutSeconds: number;
  userConfig: ResolvedUserConfig;
  /**
   * Controls behavior when OS-level sandboxing is unavailable.
   * Default: "warn" -- log and continue without sandbox.
   */
  sandboxPolicy?: SandboxAvailabilityPolicy;
}
```

### mcp-servers.json Schema Examples

```jsonc
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/ironcurtain-sandbox"],
    // Opt out: fully mediated by policy engine, MCP Roots needs dynamic paths
    "sandbox": false
  },
  "exec": {
    "command": "node",
    "args": ["./servers/exec-server.js"],
    // Explicit strict sandbox: no network, write only to session sandbox
    "sandbox": {
      "network": false
    }
    // filesystem.allowWrite is empty -> only session sandbox dir (auto-injected)
  },
  "git": {
    "command": "node",
    "args": ["./servers/git-server.js"],
    "sandbox": {
      "filesystem": {
        "allowWrite": [".git"]  // Relative paths resolved against session sandbox
      },
      "network": {
        "allowedDomains": ["github.com", "*.github.com"]
      }
    }
  },
  "test-runner": {
    "command": "node",
    "args": ["./servers/test-runner.js"]
    // sandbox omitted -> restrictive defaults (sandbox-dir only, no network)
  }
}
```

### Sandbox Integration Module

```typescript
// src/trusted-process/sandbox-integration.ts

import type { MCPServerConfig, ServerSandboxConfig, SandboxAvailabilityPolicy } from '../config/types.js';

/**
 * Result of resolving a server's sandbox configuration.
 * Discriminated union: sandboxed servers carry the resolved config,
 * unsandboxed servers carry the reason they were exempted.
 */
export type ResolvedSandboxConfig =
  | { readonly sandboxed: true; readonly config: ResolvedSandboxParams }
  | { readonly sandboxed: false; readonly reason: 'opt-out' | 'platform-unavailable' };

/**
 * Fully resolved sandbox parameters ready for SandboxManager.wrapWithSandbox().
 * All relative paths have been resolved to absolute paths.
 * The session sandbox directory has been injected into allowWrite.
 */
export interface ResolvedSandboxParams {
  readonly allowWrite: readonly string[];
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  readonly network: false | { readonly allowedDomains: readonly string[]; readonly deniedDomains: readonly string[] };
}

/**
 * Resolves the effective sandbox configuration for a single MCP server.
 *
 * Applies defaults when `sandbox` is omitted, injects the session
 * sandbox directory into allowWrite, and resolves relative paths.
 *
 * @param serverConfig - The MCP server configuration from mcp-servers.json
 * @param sessionSandboxDir - Absolute path to the session's sandbox directory
 * @param platformAvailable - Whether sandbox-runtime is available on this platform
 * @param policy - How to handle unavailable sandboxes
 * @returns Resolved configuration indicating whether the server will be sandboxed
 */
export function resolveSandboxConfig(
  serverConfig: MCPServerConfig,
  sessionSandboxDir: string,
  platformAvailable: boolean,
  policy: SandboxAvailabilityPolicy,
): ResolvedSandboxConfig;

/**
 * Transforms a server's spawn parameters (command + args) into a
 * sandbox-wrapped command suitable for StdioClientTransport.
 *
 * For sandboxed servers: writes a per-server srt settings file to a
 * temp directory, shell-escapes command+args via `shell-quote`, and
 * returns `{ command: 'srt', args: ['-s', settingsPath, '-c', escapedCmd] }`.
 *
 * For unsandboxed servers: returns the original command/args unchanged.
 *
 * Shell escaping uses the `quote()` function from `shell-quote`
 * (transitive dependency via @anthropic-ai/sandbox-runtime) to safely
 * handle args containing spaces, shell metacharacters ($, `, !, *),
 * and quotes.
 *
 * @returns New command and args for StdioClientTransport, or the
 *   originals if the server is not sandboxed.
 */
export function wrapServerCommand(
  serverName: string,
  command: string,
  args: readonly string[],
  sandboxConfig: ResolvedSandboxConfig,
  settingsDir: string,
): { command: string; args: string[] };

/**
 * Writes a per-server srt settings JSON file.
 *
 * Each sandboxed server gets its own settings file at
 * `{settingsDir}/{serverName}.srt-settings.json` containing:
 * - network.allowedDomains / deniedDomains
 * - filesystem.allowWrite / denyRead / denyWrite
 *
 * Returns the absolute path to the written file.
 */
export function writeServerSettings(
  serverName: string,
  config: ResolvedSandboxParams,
  settingsDir: string,
): string;

/**
 * Checks sandbox dependencies and returns a structured result.
 *
 * Wraps SandboxManager.isSupportedPlatform() and checkDependencies()
 * into a single call. Does NOT throw — callers inspect the result and
 * decide based on sandboxPolicy.
 */
export function checkSandboxAvailability(): {
  platformSupported: boolean;
  errors: string[];
  warnings: string[];
};

/**
 * Cleans up per-server settings files created by writeServerSettings().
 * Called during proxy shutdown. Safe to call even if no files were written.
 */
export function cleanupSettingsFiles(settingsDir: string): void;
```

### Audit Entry Extension

```typescript
// Addition to src/types/audit.ts AuditEntry

export interface AuditEntry {
  // ... existing fields ...
  /** Whether the MCP server process was running inside an OS-level sandbox. */
  sandboxed?: boolean;
}
```

## Component Diagram

```
Session Factory (createSession)
  |
  |-- Creates session config with sandboxDir, passes to Sandbox
  |
  v
Sandbox (src/sandbox/index.ts)
  |
  |-- Spawns MCP proxy server as child process via UTCP Code Mode
  |-- Passes MCP_SERVERS_CONFIG (including sandbox fields) as env var
  |-- Passes ALLOWED_DIRECTORY (session sandbox dir) as env var
  |
  v
MCP Proxy Server (src/trusted-process/mcp-proxy-server.ts)
  |
  |-- main() startup:
  |   1. Parse MCP_SERVERS_CONFIG from env
  |   2. checkSandboxAvailability() -> { platformSupported, errors, warnings }
  |   3. If enforce + errors: throw fatal (proxy refuses to start)
  |   4. For each server: resolveSandboxConfig(serverConfig, allowedDirectory, ...)
  |   5. For sandboxed servers: writeServerSettings() -> per-server .srt-settings.json
  |   6. For each server: wrapServerCommand() -> { command, args }
  |   7. new StdioClientTransport({ command, args, env: {...process.env, ...config.env}, ... })
  |
  |-- Policy evaluation (unchanged)
  |-- Tool call forwarding (unchanged)
  |
  |-- shutdown():
  |   1. Close all MCP client connections
  |   2. cleanupSettingsFiles()  // remove per-server settings
  |   3. Close audit log
  |
  v
MCP Servers (filesystem, exec, git, etc.)
  |
  |-- Unsandboxed: spawned directly as today
  |-- Sandboxed: spawned via `srt -s <settings> -c <escaped-cmd>`
      |-- Each srt process has its own SandboxManager + proxy infrastructure
      |-- Filesystem: kernel-enforced allowWrite/denyRead (per-server)
      |-- Network: proxy-filtered allowed domains (per-server, truly isolated)
      |-- Process: namespace isolation (Linux), seccomp-bpf
```

### Data Flow for Sandbox Configuration

```
mcp-servers.json           Session Factory
      |                         |
      v                         v
  MCPServerConfig         sessionSandboxDir
  (with .sandbox field)         |
      |                         |
      +-----------+-------------+
                  |
                  v
        resolveSandboxConfig()
                  |
                  v
        ResolvedSandboxConfig
         /                  \
  sandboxed: true      sandboxed: false
       |                    |
       v                    v
  writeServerSettings()  pass original
       |                 command/args
       v
  {serverName}.srt-settings.json
       |
       v
  wrapServerCommand()
       |
       +-- quote([command, ...args])   // shell-quote escaping
       |
       v
  { command: 'srt', args: ['-s', settingsPath, '-c', escapedCmd] }
       |
       v
  StdioClientTransport({
    command, args,
    env: { ...process.env, ...(config.env ?? {}) },  // always full env
    stderr: 'pipe'
  })
```

## Detailed Integration: MCP Proxy Server Changes

The proxy server (`mcp-proxy-server.ts`) is the primary integration point. Here is the modified server-connection loop (pseudocode showing the structural changes, not a literal diff):

```typescript
import { quote } from 'shell-quote';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// New env var for platform policy
const sandboxPolicy = (process.env.SANDBOX_POLICY ?? 'warn') as SandboxAvailabilityPolicy;

// Phase 1: Check sandbox availability (once for all servers)
const { platformSupported, errors: depErrors, warnings: depWarnings } = checkSandboxAvailability();

// Log warnings to session log (not stderr — that's the MCP JSON-RPC transport)
for (const warning of depWarnings) {
  logToSessionLog(`[sandbox] WARNING: ${warning}`);
}

// Phase 1b: Enforce policy — fail fast if sandbox required but unavailable
if (sandboxPolicy === 'enforce' && (!platformSupported || depErrors.length > 0)) {
  const reasons = !platformSupported
    ? [`Platform ${process.platform} not supported`]
    : depErrors;
  throw new Error(
    `[sandbox] FATAL: sandboxPolicy is "enforce" but sandboxing is unavailable:\n` +
    reasons.map(r => `  - ${r}`).join('\n') + '\n' +
    `Install with: sudo apt-get install -y bubblewrap socat`
  );
}

// Phase 2: Resolve sandbox configs for all servers
const resolvedSandboxConfigs = new Map<string, ResolvedSandboxConfig>();

for (const [serverName, config] of Object.entries(serversConfig)) {
  const resolved = resolveSandboxConfig(
    config,
    allowedDirectory,
    platformSupported && depErrors.length === 0,
    sandboxPolicy,
  );
  resolvedSandboxConfigs.set(serverName, resolved);
}

// Phase 3: Write per-server srt settings files (temp dir, cleaned up on shutdown)
const settingsDir = mkdtempSync(join(tmpdir(), 'ironcurtain-srt-'));

for (const [serverName, resolved] of resolvedSandboxConfigs) {
  if (resolved.sandboxed) {
    writeServerSettings(serverName, resolved.config, settingsDir);
  }
}

// Phase 4: Connect to MCP servers, wrapping commands for sandboxed ones
for (const [serverName, config] of Object.entries(serversConfig)) {
  const resolved = resolvedSandboxConfigs.get(serverName)!;
  const { command, args } = wrapServerCommand(
    serverName,
    config.command,
    config.args,
    resolved,
    settingsDir,
  );

  const transport = new StdioClientTransport({
    command,
    args,
    // ALWAYS pass full process.env — never rely on getDefaultEnvironment()
    // which strips vars that srt and MCP servers may need (NODE_PATH, etc.)
    env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
    stderr: 'pipe',
  });

  // ... rest of connection logic unchanged ...
}

// Shutdown addition:
async function shutdown(): Promise<void> {
  for (const state of clientStates.values()) {
    try { await state.client.close(); } catch { /* ignore */ }
  }
  // Each srt process cleans up its own proxy infrastructure when its child exits.
  // We just need to remove our temp settings files.
  cleanupSettingsFiles(settingsDir);
  try { await server.close(); } catch { /* ignore */ }
  await auditLog.close();
  process.exit(0);
}
```

## Per-Server Network Isolation via `srt` CLI

### The Singleton Problem (Empirically Validated)

`SandboxManager` is a module-level singleton. Its network proxy infrastructure (HTTP proxy + SOCKS5) is process-wide: one set of allowed domains. Different servers need different network access (exec: none, git: github.com only).

**We validated empirically** (see `test/sandbox-exploration.ts`) that `customConfig.network` in `wrapWithSandbox()` does NOT provide per-command network isolation:

- Test: `SandboxManager.initialize()` with `allowedDomains: ['example.com']`, then `wrapWithSandbox(curlGithub, undefined, { network: { allowedDomains: [] } })`
- Result: curl to github.com **succeeded** through the proxy (EXIT:0)
- Root cause: The proxy's domain filter is set once at `initialize()` time. `customConfig.network` is ignored — the proxy infrastructure doesn't restart per command.

The union-of-domains approach (previously proposed) was rejected because it is a security compromise: a sandboxed exec server running agent-written code could discover the socat bridge socket and reach domains intended only for the git server. This is exactly the class of attack that sandboxing exists to prevent.

### Solution: Per-Server `srt` Processes

Each sandboxed MCP server is spawned via the `srt` CLI with its own settings file:

```
srt -s /tmp/ironcurtain-srt-XXXX/exec.srt-settings.json -c "node ./servers/exec-server.js"
srt -s /tmp/ironcurtain-srt-XXXX/git.srt-settings.json -c "node ./servers/git-server.js"
```

Each `srt` process:
1. Loads its own `SandboxRuntimeConfig` from the settings file
2. Calls `SandboxManager.initialize()` internally (starts its own HTTP+SOCKS proxies on random ports)
3. Wraps the command with `wrapWithSandbox()` using its config
4. Spawns the sandboxed child with `stdio: 'inherit'` (transparent to MCP JSON-RPC)
5. Cleans up its own proxy infrastructure when the child exits

**Consequence**: An exec server with `network: { allowedDomains: [] }` gets an `srt` process with zero allowed domains. Its socat bridges go nowhere. Even if the sandboxed process discovers the Unix socket, the proxy rejects all connections. The git server's separate `srt` process allows `github.com` on entirely separate proxy ports.

### Memory/Process Overhead

Each `srt` process adds:
- One Node.js process (~30-50 MB RSS)
- One HTTP proxy server on a random localhost port
- One SOCKS5 proxy server on a random localhost port
- Two socat bridge processes (Linux) forwarding Unix sockets

For a typical 2-3 sandboxed server deployment, this is ~100-150 MB additional memory. This is acceptable for a security boundary. Unsandboxed servers (`"sandbox": false`) have zero overhead.

### Per-Server Settings Files

Settings files are written by the proxy to a temp directory at startup:

```json
// /tmp/ironcurtain-srt-XXXX/exec.srt-settings.json
{
  "network": {
    "allowedDomains": [],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.gnupg"],
    "allowWrite": ["/home/user/.ironcurtain/sessions/abc/sandbox"],
    "denyWrite": []
  }
}
```

```json
// /tmp/ironcurtain-srt-XXXX/git.srt-settings.json
{
  "network": {
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.gnupg"],
    "allowWrite": [
      "/home/user/.ironcurtain/sessions/abc/sandbox",
      "/home/user/.ironcurtain/sessions/abc/sandbox/.git"
    ],
    "denyWrite": []
  }
}
```

The proxy cleans up this temp directory on shutdown. On crash, OS temp cleanup handles it.

## Lifecycle Management

### Initialization Sequence

```
1. Proxy process starts (spawned by Code Mode)
2. Parse SANDBOX_POLICY from env (default: "warn")
3. checkSandboxAvailability() -> { platformSupported, errors, warnings }
4. If enforce + (unsupported or errors): throw fatal, proxy exits
5. Log any warnings to session log
6. For each server in MCP_SERVERS_CONFIG:
   a. resolveSandboxConfig() -> ResolvedSandboxConfig
7. Create temp settings dir: mkdtempSync()
8. For each sandboxed server:
   a. writeServerSettings() -> per-server .srt-settings.json
9. For each server:
   a. wrapServerCommand() -> { command, args }
      (sandboxed: command='srt', args=['-s', settingsPath, '-c', escapedCmd])
      (unsandboxed: original command/args)
   b. new StdioClientTransport({ command, args, env: {...process.env, ...config.env} })
   c. client.connect(transport)
10. Proxy enters normal MCP server mode
```

Note: The proxy process does NOT call `SandboxManager.initialize()` itself. Each `srt` child process handles its own initialization independently. The proxy only needs `SandboxManager.isSupportedPlatform()` and `checkDependencies()` (which are synchronous, stateless checks).

### Shutdown Sequence

```
1. Proxy receives SIGINT or SIGTERM
2. Close all MCP client connections (existing behavior)
   -> This closes stdio to each srt process
   -> Each srt process sees its child exit and runs its own cleanup
3. cleanupSettingsFiles(settingsDir) — remove temp settings directory
4. Close audit log
5. process.exit(0)
```

### Crash Recovery

If the proxy process crashes without calling `cleanupSettingsFiles()`:
- Each `srt` process detects its stdin closing (the pipe from the proxy). The MCP server child exits, `srt` receives the exit event, and runs `SandboxManager.cleanupAfterCommand()` + `process.exit()`. Each `srt` process cleans up its own proxy infrastructure.
- Settings files in `/tmp/ironcurtain-srt-XXXX/` are cleaned up by OS temp directory rotation.
- Sandboxed child processes (the actual MCP servers) are killed when their parent `srt` process dies because the stdio pipe closes.

## Platform Graceful Degradation

### Detection

At proxy startup, check platform support and dependencies before resolving any sandbox configs. `checkDependencies()` returns `{ warnings: string[], errors: string[] }` (not a boolean — errors are fatal, warnings are advisory).

```typescript
// At proxy startup — checked ONCE, result shared across all servers
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

const platformAvailable = SandboxManager.isSupportedPlatform();
let dependencyErrors: string[] = [];
let dependencyWarnings: string[] = [];

if (platformAvailable) {
  const check = SandboxManager.checkDependencies();
  dependencyErrors = check.errors;     // e.g., ["bwrap not installed", "socat not installed"]
  dependencyWarnings = check.warnings;  // e.g., ["ripgrep not found — violation search disabled"]
}
```

### Behavior by Policy

| Platform | bubblewrap+socat | sandboxPolicy | Behavior |
|----------|-----------------|---------------|----------|
| Linux | installed | "enforce" | Sandbox active |
| Linux | installed | "warn" | Sandbox active |
| Linux | missing | "enforce" | **Fatal error**, proxy refuses to start |
| Linux | missing | "warn" | Warning logged, servers start unsandboxed |
| macOS | n/a | any | Sandbox active (uses Seatbelt) |
| Windows | n/a | "enforce" | **Fatal error**, proxy refuses to start |
| Windows | n/a | "warn" | Warning logged, servers start unsandboxed |

### Error Paths for `enforce` Policy

The `enforce` policy causes hard failures at **two distinct points**, and each must produce clear, actionable error messages:

**1. At proxy startup (dependency check):**

```typescript
if (sandboxPolicy === 'enforce') {
  if (!platformAvailable) {
    throw new Error(
      `[sandbox] FATAL: sandboxPolicy is "enforce" but OS-level sandboxing ` +
      `is not supported on this platform (${process.platform}). ` +
      `Supported: Linux (with bubblewrap+socat), macOS.`
    );
  }
  if (dependencyErrors.length > 0) {
    throw new Error(
      `[sandbox] FATAL: sandboxPolicy is "enforce" but required dependencies ` +
      `are missing:\n${dependencyErrors.map(e => `  - ${e}`).join('\n')}\n` +
      `Install with: sudo apt-get install -y bubblewrap socat`
    );
  }
}
```

When the proxy throws during `main()`, it exits with a non-zero code. The parent process (Code Mode via UTCP) sees the child process exit and propagates the error. The error message goes to the session log, not to the MCP JSON-RPC transport.

**2. At per-server config resolution (`resolveSandboxConfig()`):**

If a server requires sandboxing (no `"sandbox": false`) but the platform check already determined sandbox is unavailable, the behavior depends on `sandboxPolicy`:

```typescript
function resolveSandboxConfig(
  serverConfig: MCPServerConfig,
  sessionSandboxDir: string,
  platformAvailable: boolean,
  policy: SandboxAvailabilityPolicy,
): ResolvedSandboxConfig {
  if (serverConfig.sandbox === false) {
    return { sandboxed: false, reason: 'opt-out' };
  }

  if (!platformAvailable) {
    if (policy === 'enforce') {
      // This shouldn't be reached if startup check caught it,
      // but defense-in-depth for edge cases
      throw new Error(
        `[sandbox] Server requires sandboxing but platform is unavailable ` +
        `and sandboxPolicy is "enforce".`
      );
    }
    return { sandboxed: false, reason: 'platform-unavailable' };
  }

  // ... resolve sandbox config normally ...
}
```

**The key invariant**: with `enforce`, the proxy either starts fully sandboxed or doesn't start at all. There is no partial state where some servers are sandboxed and others silently aren't.

### Warning Format

```
[sandbox] WARNING: OS-level sandboxing unavailable (missing: bubblewrap, socat).
  Servers that require sandboxing will run without OS containment.
  Policy engine remains active. Set SANDBOX_POLICY=enforce to require sandboxing.
  Install dependencies: sudo apt-get install -y bubblewrap socat
```

This warning goes to the session log (via `sessionLogPath`), not to stderr (which is the MCP JSON-RPC transport).

## Session Sandbox Directory Mapping

Each session creates `~/.ironcurtain/sessions/{sessionId}/sandbox/` as the `ALLOWED_DIRECTORY`. This maps to sandbox-runtime as follows:

```typescript
function resolveSandboxConfig(
  serverConfig: MCPServerConfig,
  sessionSandboxDir: string,
  // ...
): ResolvedSandboxConfig {
  if (serverConfig.sandbox === false) {
    return { sandboxed: false, reason: 'opt-out' };
  }

  const sandboxConfig = serverConfig.sandbox ?? {};
  const fsConfig = sandboxConfig.filesystem ?? {};

  // Session sandbox dir is always writable
  const allowWrite = [
    sessionSandboxDir,
    ...(fsConfig.allowWrite ?? []).map(p => resolve(sessionSandboxDir, p)),
  ];

  // ... resolve denyRead, denyWrite, network ...

  return {
    sandboxed: true,
    config: { allowWrite, denyRead, denyWrite, network },
  };
}
```

Key behaviors:
- Relative paths in `allowWrite` are resolved against the session sandbox directory.
- Absolute paths in `allowWrite` are used as-is (for cases like `/tmp`).
- The session sandbox directory itself is always included, even if `allowWrite` is empty.
- `denyRead` defaults include `~/.ssh`, `~/.gnupg`, and the IronCurtain config directory.

## Error Handling: Sandbox-Blocked Operations

### The Disagreement Problem

The policy engine and sandbox can disagree:
- Policy allows `read_file("/home/user/.bashrc")` (not a protected path)
- Sandbox blocks it (`.bashrc` is in sandbox-runtime's hardcoded deny-read list)

The MCP server process receives `EPERM` from the kernel. It returns an MCP error response. The proxy logs this as a normal tool-call error.

### Detection and Annotation

After a tool call that the policy engine allowed but the MCP server returned an error, the proxy checks if the error pattern suggests a sandbox block and annotates the response:

```typescript
function annotateSandboxViolation(
  policyDecision: 'allow',
  errorMessage: string,
  serverSandboxed: boolean,
): string {
  if (!serverSandboxed) return errorMessage;
  // Common patterns from sandbox-blocked operations
  const isSandboxBlock = /EACCES|EPERM|Operation not permitted|Permission denied/i.test(errorMessage);
  if (!isSandboxBlock) return errorMessage;
  return `[SANDBOX BLOCKED] ${errorMessage}`;
}
```

The `[SANDBOX BLOCKED]` prefix serves two purposes:
1. **For the LLM**: a clear signal that this is OS-level containment, not a server bug — discourages retrying the same operation.
2. **For the operator**: visible in the audit log and session log without needing a separate diagnostic event or IPC mechanism.

This is a heuristic, not definitive (a legitimate EPERM unrelated to sandboxing would also be annotated). The audit log records `sandboxed: true` on the entry so operators can filter precisely.

No `DiagnosticEvent` crosses the process boundary. The proxy communicates only through MCP JSON-RPC responses, and the annotation travels through the normal error path.

### No Automatic Retry or Override

When the sandbox blocks an operation, we do **not** retry without the sandbox or automatically widen permissions. The sandbox is the hard boundary. If the policy engine and sandbox disagree, the sandbox wins and the operator must adjust configuration.

## Environment Variable Passing

### Proxy-Level Env Vars

The proxy receives its configuration via environment variables (set by `src/sandbox/index.ts`). New env vars for sandbox support:

```typescript
// In src/sandbox/index.ts, added to proxyEnv:
proxyEnv.SANDBOX_POLICY = config.sandboxPolicy ?? 'warn';
// MCP_SERVERS_CONFIG already contains the full server configs including sandbox fields
```

The `sandbox` field on each server config is already part of `MCP_SERVERS_CONFIG` (the JSON-serialized `mcpServers` object). No additional env var is needed for per-server sandbox config.

### MCP Server Spawn Env: Always Pass Full `process.env`

**Critique addressed**: `StdioClientTransport` has a subtle default behavior when `env` is `undefined`. Instead of inheriting `process.env`, it calls `getDefaultEnvironment()` which only passes through a restricted set of variables: `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER` (on Linux). This is insufficient for sandboxed servers.

The `srt` CLI process needs:
- `PATH` — to locate `bwrap`, `socat`, and the MCP server binary
- `HOME` — to find default settings and `~/.npm` cache
- Potentially `NODE_PATH`, `NODE_OPTIONS` — for Node.js-based MCP servers
- Potentially `PYTHONPATH`, `VIRTUAL_ENV` — for Python-based MCP servers

sandbox-runtime's `wrapCommandWithSandboxLinux()` embeds proxy env vars (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, etc.) directly into the bwrap command string via `env` prefix commands. The sandboxed MCP server process therefore does not need these vars from the parent — they are self-contained in the wrapped command. However, the `srt` CLI process itself (which runs **outside** the sandbox before wrapping the command) does need system env vars to function.

**Rule**: The proxy must **always** pass `{ ...process.env, ...config.env }` to `StdioClientTransport`, never `undefined`. This ensures the `srt` CLI (and unsandboxed servers) have all necessary system paths:

```typescript
// BEFORE (current code — problematic for sandboxed servers):
const transport = new StdioClientTransport({
  command: config.command,
  args: config.args,
  env: config.env
    ? { ...(process.env as Record<string, string>), ...config.env }
    : undefined,  // Falls back to getDefaultEnvironment() — too restrictive
  stderr: 'pipe',
});

// AFTER (always pass full env):
const transport = new StdioClientTransport({
  command: wrappedCommand,
  args: wrappedArgs,
  env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
  stderr: 'pipe',
});
```

This change applies to **all** server spawns (sandboxed and unsandboxed), fixing a pre-existing limitation where unsandboxed servers with no custom `env` received a restricted environment.

## Extension Points

### Custom Sandbox Profiles

The `ServerSandboxConfig` type is an object with optional `filesystem` and `network` fields. New restriction types (e.g., process limits, IPC restrictions) can be added as optional fields without breaking existing configs.

### Runtime Sandbox Expansion

Currently, sandbox restrictions are static for the session lifetime. A future extension could allow escalation-approved operations to expand the sandbox's `allowWrite` list via `SandboxManager.updateConfig()`. This is deliberately excluded from the initial implementation because:
- The policy engine + MCP Roots already handle dynamic path expansion for unsandboxed servers.
- Updating sandbox-runtime config at runtime for a specific already-running child process is not supported (the process was already wrapped at spawn time).
- If needed later, the approach would be to restart the MCP server process with updated sandbox config.

### Per-Server Network Isolation — IMPLEMENTED

Per-server network isolation is the current design (not a future extension). Each sandboxed MCP server runs in its own `srt` process with independent proxy infrastructure. See "Per-Server Network Isolation via `srt` CLI" section above.

If sandbox-runtime later adds per-command network restriction to `customConfig` (eliminating the need for separate processes), `wrapServerCommand()` can be updated to use the library API directly instead of the `srt` CLI. The abstraction boundary (returning command/args) hides this implementation detail from the proxy code.

### Violation Monitoring

sandbox-runtime exposes `SandboxViolationStore` for collecting violation events. A future extension could pipe these into the audit log for richer forensics. The current design captures violations indirectly through MCP error responses.

## Testing Strategy

### Unit Tests: Configuration Resolution

Test `resolveSandboxConfig()` in isolation:

```typescript
// test/sandbox-integration.test.ts

describe('resolveSandboxConfig', () => {
  it('returns opt-out for sandbox: false', () => {
    const result = resolveSandboxConfig(
      { command: 'npx', args: ['server'], sandbox: false },
      '/sessions/abc/sandbox',
      true, 'warn',
    );
    expect(result).toEqual({ sandboxed: false, reason: 'opt-out' });
  });

  it('applies restrictive defaults when sandbox is omitted', () => {
    const result = resolveSandboxConfig(
      { command: 'node', args: ['server.js'] },
      '/sessions/abc/sandbox',
      true, 'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowWrite).toContain('/sessions/abc/sandbox');
      expect(result.config.network).toBe(false);
    }
  });

  it('resolves relative allowWrite paths against session sandbox', () => {
    const result = resolveSandboxConfig(
      { command: 'node', args: ['server.js'], sandbox: { filesystem: { allowWrite: ['.git'] } } },
      '/sessions/abc/sandbox',
      true, 'warn',
    );
    if (result.sandboxed) {
      expect(result.config.allowWrite).toContain('/sessions/abc/sandbox/.git');
    }
  });

  it('degrades gracefully when platform unavailable and policy is warn', () => {
    const result = resolveSandboxConfig(
      { command: 'node', args: ['server.js'] },
      '/sessions/abc/sandbox',
      false, 'warn',
    );
    expect(result).toEqual({ sandboxed: false, reason: 'platform-unavailable' });
  });

  it('throws when platform unavailable and policy is enforce', () => {
    expect(() => resolveSandboxConfig(
      { command: 'node', args: ['server.js'] },
      '/sessions/abc/sandbox',
      false, 'enforce',
    )).toThrow();
  });
});
```

### Unit Tests: Settings File Writing

```typescript
describe('writeServerSettings', () => {
  it('writes valid SandboxRuntimeConfig JSON', () => {
    const settingsDir = mkdtempSync(join(tmpdir(), 'test-srt-'));
    const path = writeServerSettings('exec', {
      allowWrite: ['/sandbox'],
      denyRead: ['~/.ssh'],
      denyWrite: [],
      network: false,
    }, settingsDir);

    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.network.allowedDomains).toEqual([]);
    expect(content.filesystem.allowWrite).toContain('/sandbox');
    expect(content.filesystem.denyRead).toContain('~/.ssh');
    rmSync(settingsDir, { recursive: true });
  });

  it('maps network: false to empty allowedDomains', () => {
    // ...
  });

  it('passes through allowedDomains/deniedDomains for network configs', () => {
    // ...
  });
});
```

### Unit Tests: Command Wrapping and Shell Escaping

```typescript
describe('wrapServerCommand', () => {
  it('passes through unsandboxed servers', () => {
    const result = wrapServerCommand(
      'exec', 'npx', ['server'],
      { sandboxed: false, reason: 'opt-out' },
      '/tmp/settings',
    );
    expect(result).toEqual({ command: 'npx', args: ['server'] });
  });

  it('wraps sandboxed servers with srt -s -c', () => {
    const result = wrapServerCommand(
      'exec', 'node', ['server.js'],
      { sandboxed: true, config: { allowWrite: ['/sandbox'], denyRead: [], denyWrite: [], network: false } },
      '/tmp/settings',
    );
    expect(result.command).toBe('srt');
    expect(result.args[0]).toBe('-s');
    expect(result.args[1]).toBe('/tmp/settings/exec.srt-settings.json');
    expect(result.args[2]).toBe('-c');
    expect(result.args[3]).toContain('server.js');
  });

  it('shell-escapes args with spaces', () => {
    const result = wrapServerCommand(
      'exec', 'node', ['./servers/exec server.js', '--flag=value with spaces'],
      { sandboxed: true, config: { allowWrite: ['/sandbox'], denyRead: [], denyWrite: [], network: false } },
      '/tmp/settings',
    );
    // The -c argument should be a properly escaped shell string
    const cmdString = result.args[3];
    expect(cmdString).toContain("'./servers/exec server.js'");
    expect(cmdString).toContain("'--flag=value with spaces'");
  });

  it('shell-escapes args with shell metacharacters', () => {
    const result = wrapServerCommand(
      'exec', 'node', ['--pattern=$HOME/*.txt'],
      { sandboxed: true, config: { allowWrite: ['/sandbox'], denyRead: [], denyWrite: [], network: false } },
      '/tmp/settings',
    );
    const cmdString = result.args[3];
    // shell-quote should escape the $ and * to prevent shell expansion
    expect(cmdString).not.toContain('$HOME');  // should be escaped
  });
});
```

### Integration Tests

Integration tests for sandbox wrapping require a Linux system with bubblewrap installed. These tests should:

1. Be gated behind a `SANDBOX_INTEGRATION` environment variable or vitest tag
2. Spawn a minimal MCP server inside a sandbox wrapper
3. Verify that:
   - Stdio communication (JSON-RPC) works through the sandbox
   - File writes outside `allowWrite` fail
   - Network access fails when `network: false`
   - Reads of `denyRead` paths fail
4. Verify graceful degradation:
   - On platforms without bubblewrap, tests with `sandboxPolicy: 'warn'` succeed without sandbox
   - On platforms without bubblewrap, tests with `sandboxPolicy: 'enforce'` fail cleanly

```typescript
// test/sandbox-integration.test.ts (gated)
describe.skipIf(!process.env.SANDBOX_INTEGRATION)('sandbox integration', () => {
  it('blocks writes outside allowed directory', async () => {
    // Start a minimal echo MCP server inside sandbox
    // Attempt write_file to /tmp/outside -> EPERM
  });

  it('blocks network when configured', async () => {
    // Start a server that attempts fetch -> connection refused
  });

  it('passes stdio through for MCP JSON-RPC', async () => {
    // Full tool call roundtrip through sandboxed server
  });
});
```

## Migration Notes

### Phase 1: Add sandbox-integration module and types (no behavioral change)

1. Add `SandboxNetworkConfig`, `SandboxFilesystemConfig`, `ServerSandboxConfig`, and `SandboxAvailabilityPolicy` to `src/config/types.ts`.
2. Create `src/trusted-process/sandbox-integration.ts` with `resolveSandboxConfig()`, `writeServerSettings()`, `wrapServerCommand()`, `checkSandboxAvailability()`, `cleanupSettingsFiles()`.
3. Add `sandboxed?: boolean` to `AuditEntry` in `src/types/audit.ts`.
5. Add unit tests for all new functions (including shell escaping edge cases).
6. `@anthropic-ai/sandbox-runtime` is already installed as a regular dependency.

**No existing behavior changes.** All existing servers have no `sandbox` field, so `resolveSandboxConfig()` would sandbox them by default -- but nothing calls it yet.

### Phase 2: Integrate into MCP proxy server

1. Modify `mcp-proxy-server.ts` startup to call `checkSandboxAvailability()`, `resolveSandboxConfig()` for each server, `writeServerSettings()`, and `wrapServerCommand()`.
2. Add `cleanupSettingsFiles()` to shutdown.
3. Add `SANDBOX_POLICY` env var handling with enforce error paths.
4. Update `src/sandbox/index.ts` to pass `SANDBOX_POLICY` env var.
5. **Fix env passing**: change `StdioClientTransport` to always use `{ ...process.env, ...config.env }` instead of `undefined` fallback.
6. Add `sandboxed` field to audit log entries.
7. Update `mcp-servers.json` to set `"sandbox": false` on the filesystem server.

**This is the behavioral change.** The filesystem server explicitly opts out. Any new servers added without a `sandbox` field will be sandboxed by default.

### Phase 3: Sandbox violation annotation

1. Add `annotateSandboxViolation()` heuristic to the proxy's tool-call error handler.
2. Annotate MCP error responses with `[SANDBOX BLOCKED]` prefix when the heuristic matches.
3. Log annotated violations to audit log with `sandboxed: true`.

### Phase 4: Integration tests

1. Add gated integration tests that verify sandbox wrapping with real bubblewrap/Seatbelt.
2. CI pipeline runs these on Linux with bubblewrap installed.

## Open Questions (for implementation)

1. ~~**`customConfig` network support**~~ **RESOLVED**: sandbox-runtime's `customConfig.network` does NOT provide per-command network isolation. Empirically validated — the proxy infrastructure is process-wide. Solution: per-server `srt` processes (see "Per-Server Network Isolation via `srt` CLI" section).

2. **Default `denyRead` list**: What paths should be in the default `denyRead` for sandboxed servers? Candidates: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.ironcurtain/config.json`. sandbox-runtime also has hardcoded protections for `.gitconfig`, `.bashrc`, `.git/` -- are these sufficient or should IronCurtain's defaults be more aggressive?

3. ~~**Optional vs required dependency**~~ **RESOLVED**: `@anthropic-ai/sandbox-runtime` is a regular dependency. It includes platform detection (`isSupportedPlatform()`) and the `warn` policy handles unavailable platforms gracefully. The `srt` CLI binary is installed with the package.

4. **macOS `sandbox-exec` deprecation**: Apple has deprecated `sandbox-exec` though it still works. sandbox-runtime's macOS support depends on it. Monitor for breakage in future macOS versions.
