# Goose Agent Integration -- Design Specification

**Date:** 2026-03-03
**Status:** Design
**Depends on:** Research doc at `docs/brainstorm/goose-agent-integration.md`
**Reference implementation:** `src/docker/adapters/claude-code.ts`

## 1. Overview

This document specifies how to add Goose (by Block) as the second Docker Agent Mode agent in IronCurtain. The implementation creates a `GooseAgentAdapter` that plugs into the existing `AgentAdapter` interface, a `Dockerfile.goose` for building the container image, and an `entrypoint-goose.sh` for container initialization. The existing Docker infrastructure (MITM proxy, Code Mode proxy, escalation handling, session management) is reused with targeted modifications. The main infrastructure change is making credential detection adapter-aware: the current `detectAuthMethod()` / `prepareDockerInfrastructure()` pipeline assumes Anthropic credentials, which fails for Goose with non-Anthropic providers. Beyond that, changes are limited to adapter registration, preflight logic, and configuration hints.

### Goals

1. Validate that the `AgentAdapter` interface is genuinely agent-agnostic (not just Claude Code with an abstraction layer on top)
2. Support both batch mode (`sendMessage()` via `docker exec`) and PTY mode (interactive terminal) for Goose
3. Support multi-provider LLM routing (Anthropic, OpenAI, Google) based on user configuration
4. Maintain the security invariant: real credentials never enter the container

### Non-Goals

- Modifying the policy engine, MCP proxy, or MITM proxy core logic
- Supporting Goose's built-in sandboxing (redundant -- IronCurtain provides sandboxing)
- Supporting all 25+ Goose providers -- initial scope is Anthropic, OpenAI, Google
- Automated Goose version upgrades
- Goose provider selection in the terminal multiplexer (`mux-command.ts`) -- see Section 10.8 for follow-up notes

## 2. Architecture

### How Goose Fits into Docker Agent Mode

```
                    IronCurtain Host Process
                   +---------------------------------------------+
                   |                                             |
                   |  createSession({ mode: { kind: 'docker',   |
                   |    agent: 'goose' } })                      |
                   |         |                                   |
                   |         v                                   |
                   |  agent-registry.ts                          |
                   |    registerBuiltinAdapters()                |
                   |      -> claudeCodeAdapter (existing)        |
                   |      -> gooseAdapter      (NEW)             |
                   |         |                                   |
                   |         v                                   |
                   |  prepareDockerInfrastructure()               |
                   |    (credential detection refactored,        |
                   |     see Section 3.1)                        |
                   |    |                                        |
                   |    +-- adapter.detectCredential()            |
                   |    |     (NEW: replaces detectAuthMethod     |
                   |    |      for adapter-aware credential       |
                   |    |      detection)                         |
                   |    |                                        |
                   |    +-- Code Mode Proxy (UDS/TCP)            |
                   |    |     execute_code -> V8 sandbox         |
                   |    |     -> mcp-proxy-server -> MCP servers |
                   |    |                                        |
                   |    +-- MITM Proxy (UDS/TCP)                 |
                   |    |     TLS termination, key swap,         |
                   |    |     endpoint filtering                 |
                   |    |                                        |
                   |    +-- gooseAdapter.getProviders()           |
                   |    |     -> [anthropic, openai, google]     |
                   |    |     (based on user config)             |
                   |    |                                        |
                   |    +-- gooseAdapter.generateMcpConfig()      |
                   |    |     -> config.yaml (YAML, not JSON)    |
                   |    |                                        |
                   |    +-- ensureImage('ironcurtain-goose')      |
                   |          -> docker/Dockerfile.goose          |
                   |                                             |
                   +---------------------------------------------+
                        |                          |
          Unix Domain Socket              Unix Domain Socket
          (MCP / execute_code)            (MITM HTTPS proxy)
                        |                          |
                   +---------------------------------------------+
                   |  Docker Container (--network=none)           |
                   |                                             |
                   |  entrypoint-goose.sh                        |
                   |    1. socat UDS -> TCP:18080 (MITM bridge)  |
                   |    2. Write ~/.config/goose/config.yaml     |
                   |    3. exec "$@" (CMD)                       |
                   |                                             |
                   |  Non-PTY: CMD = sleep infinity              |
                   |    docker exec: goose run --no-session      |
                   |      -t "message" -i /tmp/instructions.md   |
                   |                                             |
                   |  PTY: CMD = socat ... EXEC:goose-session.sh |
                   |    Interactive goose session via PTY proxy   |
                   |                                             |
                   |  Environment:                               |
                   |    GOOSE_PROVIDER=anthropic (or openai/...) |
                   |    GOOSE_MODEL=claude-sonnet-4-20250514     |
                   |    ANTHROPIC_API_KEY=<fake sentinel key>    |
                   |    GOOSE_MODE=auto (skip permission prompts)|
                   |    HTTPS_PROXY=http://127.0.0.1:18080      |
                   |    GOOSE_MAX_TURNS=200                      |
                   |                                             |
                   |  /workspace/ (bind-mount: sandbox dir)      |
                   |  /etc/ironcurtain/ (orientation, read-only) |
                   |  /run/ironcurtain/ (proxy sockets)          |
                   +---------------------------------------------+
```

### Data Flow: Goose Tool Call

1. Goose agent decides to call an MCP tool
2. Goose sends MCP `tools/call` over stdio to the socat bridge
3. socat bridges to the Code Mode proxy UDS on the host
4. Code Mode proxy dispatches into V8 sandbox
5. V8 sandbox sends MCP request to mcp-proxy-server (stdio child process)
6. PolicyEngine evaluates the request (allow/deny/escalate)
7. If allowed, forwarded to real MCP server; result flows back through the chain

### Data Flow: Goose LLM API Call

1. Goose sends HTTPS request to `api.anthropic.com` (or `api.openai.com`, etc.)
2. `HTTPS_PROXY` routes through socat bridge -> MITM proxy UDS
3. MITM proxy terminates TLS, validates fake key, swaps for real key
4. MITM proxy filters endpoint (only allowed API paths pass)
5. MITM proxy forwards to real API server with real credentials
6. Response streams back through the proxy chain

## 3. Provider Selection and Credential Flow

### Problem

Claude Code always uses Anthropic. Goose can use any of 25+ providers. IronCurtain needs to know which provider Goose will use in order to:
- Configure the MITM proxy's host allowlist
- Generate the correct fake key prefix
- Map the correct real API key for key swapping

### Design Decision: User Config Drives Provider Selection

A new field `gooseProvider` is added to `UserConfig` (in `src/config/user-config.ts`):

```typescript
// In UserConfig (nullable fields)
gooseProvider?: 'anthropic' | 'openai' | 'google';
gooseModel?: string;
```

```typescript
// In ResolvedUserConfig (defaults applied)
gooseProvider: 'anthropic' | 'openai' | 'google';  // default: 'anthropic'
gooseModel: string;  // default: 'claude-sonnet-4-20250514'
```

**Rationale:** IronCurtain already has `agentModelId` and `policyModelId` in user config. Adding `gooseProvider` and `gooseModel` follows the same pattern. The MITM proxy needs to know the provider at session startup time (before Goose runs), so runtime detection is not viable. Limiting to three providers matches the `ProviderConfig` definitions already in `provider-config.ts`.

### Provider-to-Environment Mapping

| `gooseProvider` | `GOOSE_PROVIDER` env | API key env var       | MITM provider config   | Custom endpoint env var |
|-----------------|----------------------|-----------------------|------------------------|-------------------------|
| `anthropic`     | `anthropic`          | `ANTHROPIC_API_KEY`   | `anthropicProvider`    | n/a (via HTTPS_PROXY)   |
| `openai`        | `openai`             | `OPENAI_API_KEY`      | `openaiProvider`       | n/a (via HTTPS_PROXY)   |
| `google`        | `google`             | `GOOGLE_API_KEY`      | `googleProvider`       | n/a (via HTTPS_PROXY)   |

### 3.1 Credential Detection Must Be Adapter-Aware (Infrastructure Change)

**Problem:** `prepareDockerInfrastructure()` in `src/docker/docker-infrastructure.ts` (lines 90-95) calls `detectAuthMethod(config)` *before* calling `adapter.getProviders()`. `detectAuthMethod()` is Anthropic-only: it checks for Claude OAuth credentials and falls back to `config.userConfig.anthropicApiKey`. When Goose uses OpenAI or Google, `detectAuthMethod()` returns `{ kind: 'none' }` and the function throws:

```
No credentials available for Docker session.
Log in with `claude login` (OAuth) or set ANTHROPIC_API_KEY.
```

This is a **blocker** for non-Anthropic Goose providers.

**Solution:** Add a `detectCredential()` method to the `AgentAdapter` interface. This makes credential detection adapter-aware while keeping the existing Claude Code behavior unchanged.

```typescript
// In AgentAdapter interface (src/docker/agent-adapter.ts)
/**
 * Detects available credentials for this agent.
 * Called by prepareDockerInfrastructure() before getProviders().
 *
 * Returns the detected auth method. The infrastructure layer uses the
 * result to decide whether to proceed, set up OAuth token management, etc.
 *
 * Default behavior (for backward compat): delegates to detectAuthMethod()
 * which checks for Anthropic OAuth and API key.
 */
detectCredential?(config: IronCurtainConfig): AuthMethod;
```

**Claude Code adapter** -- does not implement `detectCredential()`. The infrastructure falls back to the existing `detectAuthMethod(config)` call. Zero behavioral change for Claude Code.

**Goose adapter** -- implements `detectCredential()` to check the provider-specific API key:

```typescript
detectCredential(config: IronCurtainConfig): AuthMethod {
  const provider = this.resolvedUserConfig.gooseProvider;
  let key: string | undefined;
  switch (provider) {
    case 'anthropic': key = config.userConfig.anthropicApiKey; break;
    case 'openai':    key = config.userConfig.openaiApiKey; break;
    case 'google':    key = config.userConfig.googleApiKey; break;
  }
  if (key) return { kind: 'apikey', key };
  return { kind: 'none' };
}
```

**Change to `prepareDockerInfrastructure()`** (lines 90-95):

```typescript
// Before (Anthropic-only):
const authMethod = detectAuthMethod(config);
if (authMethod.kind === 'none') {
  throw new Error(
    'No credentials available for Docker session. '
    + 'Log in with `claude login` (OAuth) or set ANTHROPIC_API_KEY.',
  );
}

// After (adapter-aware):
const authMethod = adapter.detectCredential
  ? adapter.detectCredential(config)
  : detectAuthMethod(config);
if (authMethod.kind === 'none') {
  throw new Error(adapter.credentialHelpText
    ?? 'No credentials available for Docker session. '
    + 'Log in with `claude login` (OAuth) or set ANTHROPIC_API_KEY.');
}
```

The `credentialHelpText` is an optional readonly string on `AgentAdapter` that provides an agent-specific error message. The Goose adapter sets it to:

```typescript
credentialHelpText: `No API key found for Goose provider "${resolvedUserConfig.gooseProvider}". `
  + 'Set the appropriate API key in your environment '
  + '(ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY) '
  + 'or via `ironcurtain config`.',
```

This also addresses **S4** (Anthropic-specific error messages): by delegating the error message to the adapter, each agent can provide contextually appropriate guidance.

**OAuth token management:** When `detectCredential()` returns `{ kind: 'apikey' }` (as Goose always will), the existing OAuth code path in `prepareDockerInfrastructure()` is naturally skipped because `authMethod.kind !== 'oauth'` evaluates to `true`. No further changes needed for the OAuth/token-manager branch.

### Credential Flow (Updated)

1. `prepareDockerInfrastructure()` calls `adapter.detectCredential(config)` (or falls back to `detectAuthMethod(config)` for adapters that do not implement it)
2. If `{ kind: 'none' }`, throws with `adapter.credentialHelpText` or the default Anthropic-oriented message
3. `adapter.getProviders()` returns the `ProviderConfig` for the user's selected provider
4. `generateFakeKey()` creates a sentinel key with the provider's prefix
5. The fake key is passed to `adapter.buildEnv()`, which sets the provider-specific API key env var
6. Inside the container, Goose reads the fake key from the env var and sends it in API requests
7. The MITM proxy validates the fake key and swaps it for the real key

### Why Not Use Custom Endpoint Variables?

Goose supports `ANTHROPIC_HOST` and `OPENAI_HOST` for custom endpoints. However, IronCurtain already uses `HTTPS_PROXY` to route all HTTPS traffic through the MITM proxy. The proxy approach is superior because:
- It works for all providers without per-provider endpoint configuration
- It provides TLS termination (the proxy generates per-host certs signed by the IronCurtain CA)
- It enables endpoint filtering (only allowed API paths pass through)
- It is the pattern already proven with Claude Code

Goose will route through `HTTPS_PROXY` automatically. No custom endpoint env vars are needed.

## 4. GooseAgentAdapter Specification

**File:** `src/docker/adapters/goose.ts`

### 4.1 `id` and `displayName`

```typescript
id: 'goose' as AgentId
displayName: 'Goose'
```

### 4.2 `getImage(): Promise<string>`

Returns `'ironcurtain-goose:latest'`.

The image follows the existing pattern: `ensureImage()` in `docker-infrastructure.ts` looks for `docker/Dockerfile.goose` automatically. No async work needed.

### 4.3 `generateMcpConfig(socketPath: string): AgentConfigFile[]`

Generates Goose's `config.yaml` with a single stdio extension pointing to IronCurtain's MCP proxy via socat.

**Target path in container:** `goose-config.yaml` (written to the orientation directory, then copied to `~/.config/goose/config.yaml` by the entrypoint script).

**Generated content:**

```yaml
extensions:
  ironcurtain:
    name: IronCurtain
    type: stdio
    enabled: true
    cmd: socat
    args:
      - STDIO
      - UNIX-CONNECT:/run/ironcurtain/proxy.sock   # or TCP:<host>:<port>
    timeout: 600
```

The `socketPath` parameter determines whether to use `UNIX-CONNECT:` (Linux UDS) or `TCP:` (macOS TCP mode), exactly as Claude Code's adapter does.

**Implementation note:** The config is YAML. Use template string construction (the structure is simple enough that a YAML library is not needed). The only dynamic value is the socat connection target.

### 4.4 `generateOrientationFiles(context: OrientationContext): AgentConfigFile[]`

Returns files written to `/etc/ironcurtain/` in the container:

1. **`start-goose.sh`** (mode 0o755) -- PTY mode startup script. Reads the system prompt from `$IRONCURTAIN_SYSTEM_PROMPT` env var, writes it to a temp file, and execs `goose run -s` (interactive mode with instructions).

```bash
#!/bin/bash
# Set initial terminal size from host env vars
if [ -n "$IRONCURTAIN_INITIAL_COLS" ] && [ -n "$IRONCURTAIN_INITIAL_ROWS" ]; then
  stty cols "$IRONCURTAIN_INITIAL_COLS" rows "$IRONCURTAIN_INITIAL_ROWS" 2>/dev/null
fi
# Write system prompt to temp file for --instructions
PROMPT_FILE=$(mktemp /tmp/goose-prompt-XXXXXX.md)
trap 'rm -f "$PROMPT_FILE"' EXIT
printf '%s' "$IRONCURTAIN_SYSTEM_PROMPT" > "$PROMPT_FILE"
exec goose run -s -i "$PROMPT_FILE"
```

2. **`resize-pty.sh`** (mode 0o755) -- Terminal resize script for PTY mode. Same pattern as Claude Code's, but targets `goose` process instead of `claude`.

```bash
#!/bin/bash
COLS=$1
ROWS=$2
GOOSE_PID=$(pgrep -x goose | head -1)
if [ -z "$GOOSE_PID" ]; then echo "no-goose" >&2; exit 0; fi
PTS=$(readlink /proc/$GOOSE_PID/fd/0 2>/dev/null)
if [ -z "$PTS" ] || ! [ -e "$PTS" ]; then echo "no-pty" >&2; exit 0; fi
stty -F "$PTS" cols "$COLS" rows "$ROWS" 2>/dev/null
kill -WINCH "$GOOSE_PID" 2>/dev/null
```

3. **`check-pty-size.sh`** (mode 0o755) -- PTY size verification. Same pattern as Claude Code's but targets `goose`.

**Difference from Claude Code:** Claude Code has `start-claude.sh` which uses `--mcp-config` and `--append-system-prompt` flags. Goose uses `--instructions` (file-based) and the MCP extension is configured via `config.yaml`, not a CLI flag.

### 4.5 `buildCommand(message: string, systemPrompt: string): readonly string[]`

Builds the `docker exec` command for a single turn in batch mode.

```typescript
buildCommand(message: string, systemPrompt: string): readonly string[] {
  // Write instructions to a temp file inside the container via a shell
  // command, then invoke goose run.
  //
  // The system prompt is injected as instructions so Goose has context
  // about the MCP-mediated environment on every turn.
  const instructions = `${systemPrompt}\n\n---\n\nUser request:\n${message}`;

  return [
    '/bin/sh', '-c',
    `PROMPT_FILE=$(mktemp /tmp/goose-prompt-XXXXXX.md) && ` +
    `cat > "$PROMPT_FILE" << 'IRONCURTAIN_EOF'\n${escapeHeredoc(instructions)}\nIRONCURTAIN_EOF\n` +
    `goose run --no-session -i "$PROMPT_FILE" && rm -f "$PROMPT_FILE"`
  ];
}
```

**Key design decisions:**

- **`--no-session`**: Each `docker exec` is stateless. Goose does support `--resume-session`, but the session name would need to be coordinated across turns, and Goose's session storage is internal. Using `--no-session` is simpler and avoids state management complexity. The system prompt provides context on every turn.

- **No `--text`/`-t` flag**: The system prompt + user message combined can exceed shell argument length limits. Writing to a temp file and using `--instructions`/`-i` avoids this.

- **Heredoc escape strategy**: The heredoc delimiter `IRONCURTAIN_EOF` must not appear literally in the instructions, or the shell will terminate the heredoc prematurely. The `escapeHeredoc()` utility implements a two-phase approach:

  1. **Check** whether `IRONCURTAIN_EOF` appears anywhere in the input string.
  2. **If it does**, append a random 8-character hex suffix to the delimiter (e.g., `IRONCURTAIN_EOF_a3f7c1e2`). Repeat until the delimiter is unique in the input. Use `crypto.randomBytes(4).toString('hex')` for the suffix.
  3. **Return** both the escaped content (unchanged -- the content itself is never modified) and the unique delimiter.

  The caller uses the returned delimiter in the heredoc:
  ```typescript
  const { delimiter } = escapeHeredoc(instructions);
  // ... cat > "$PROMPT_FILE" << '${delimiter}'\n${instructions}\n${delimiter}\n ...
  ```

  **Why not escape content?** Modifying the content (e.g., inserting backslashes) risks corrupting the system prompt or user message. Generating a unique delimiter is simpler and side-effect-free.

  **Edge case:** The theoretical probability of a collision with a random suffix is negligible (1 in 4 billion). The loop check guarantees correctness regardless.

**Multi-turn limitation:** Without `--resume-session`, Goose loses conversation history between turns. Each turn starts fresh with only the system prompt + current message. This is acceptable for task execution but poor for extended conversations. See Section 9 for the multi-turn strategy.

### 4.6 `buildSystemPrompt(context: OrientationContext): string`

Builds the system prompt that teaches Goose about the MCP-mediated environment. Composed of two layers, mirroring Claude Code's pattern:

**Layer 1: Code Mode instructions** (`buildSystemPrompt()` from `src/session/prompts.ts`) -- tool discovery via `help.help()`, synchronous call semantics, `return` for output.

**Layer 2: Docker environment context** -- Goose-specific version of `buildDockerEnvironmentPrompt()`:

```
## Docker Environment

### Workspace (`/workspace`)
This is your workspace inside the container. You have full access here.

### External Operations (MCP tools)
Use the IronCurtain MCP extension for operations that require external access:
- Network requests (HTTP fetches, web searches, API calls)
- Git remote operations (clone, push, pull, fetch)
- Reading files outside /workspace

For local file operations inside /workspace, use your built-in tools.

After cloning a repo or writing files via MCP tools, use your built-in
tools for subsequent file operations.

### Network
The container has NO direct internet access. All HTTP requests and
git operations MUST go through the IronCurtain MCP tools.

### Policy Enforcement
Every MCP tool call is evaluated against security policy rules:
- Allowed: proceeds automatically
- Denied: blocked -- do NOT retry denied operations
- Escalated: requires human approval
```

**Difference from Claude Code:** The prompt does not mention `execute_code` (Goose does not use Code Mode's execute_code tool). Instead, it refers to "IronCurtain MCP extension" and the tool names available through it. Goose discovers tools via MCP `tools/list` from the IronCurtain extension.

**Note:** This is a significant architectural difference. Claude Code uses the `execute_code` tool to run TypeScript in the V8 sandbox, which then calls MCP tools. Goose will call MCP tools directly through its extension system. The Code Mode proxy's `execute_code` tool still works (it is what the MCP server exposes), but Goose will likely call the underlying tools individually rather than writing TypeScript that batches calls. The system prompt should guide Goose toward efficient tool usage patterns.

### 4.7 `getProviders(authKind?: 'oauth' | 'apikey'): readonly ProviderConfig[]`

Returns the provider configuration based on the user's `gooseProvider` setting.

```typescript
getProviders(authKind?: 'oauth' | 'apikey'): readonly ProviderConfig[] {
  // Read gooseProvider from user config (accessed via closure or module-level import)
  const provider = resolvedUserConfig.gooseProvider;  // 'anthropic' | 'openai' | 'google'

  switch (provider) {
    case 'anthropic':
      // Goose uses standard ANTHROPIC_API_KEY, not OAuth
      return [anthropicProvider];
    case 'openai':
      return [openaiProvider];
    case 'google':
      return [googleProvider];
  }
}
```

**Key difference from Claude Code:** Claude Code always returns Anthropic providers (with OAuth variants). Goose returns exactly one provider based on user config. The `authKind` parameter is ignored because Goose does not support Claude's OAuth flow.

**Access to user config:** The adapter needs `gooseProvider` from the resolved user config. Options:
- **Option A (recommended):** Accept `ResolvedUserConfig` as a construction-time parameter. Change adapter from a plain object to a factory: `createGooseAdapter(userConfig: ResolvedUserConfig): AgentAdapter`. The registry stores the result.
- **Option B:** Read from a module-level config singleton. Less testable.
- **Option C:** Make `getProviders()` accept an optional config parameter. Breaks the interface contract.

**Recommendation:** Option A. Modify `registerBuiltinAdapters()` to accept `ResolvedUserConfig` and pass it to the Goose adapter factory. The Claude Code adapter does not need config (it always returns Anthropic), so it remains a plain object.

### 4.8 `buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Record<string, string>`

Builds the container's environment variables.

```typescript
buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Record<string, string> {
  const provider = resolvedUserConfig.gooseProvider;
  const model = resolvedUserConfig.gooseModel;

  const env: Record<string, string> = {
    // Goose agent configuration
    GOOSE_PROVIDER: provider,
    GOOSE_MODEL: model,
    GOOSE_MODE: 'auto',           // Skip all permission prompts
    GOOSE_MAX_TURNS: '200',       // Prevent runaway execution
    // TLS: Goose is Rust. If it uses rustls with the `rustls-tls-native-roots`
    // feature (via reqwest), it reads /etc/ssl/certs/ -- update-ca-certificates
    // in the Dockerfile handles this. If it uses compiled-in webpki roots instead,
    // SSL_CERT_FILE/SSL_CERT_DIR env vars are the fallback (see Section 5).
    // Prototype 4 (Section 12) must verify which path Goose takes.
    SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt',
    SSL_CERT_DIR: '/etc/ssl/certs',
  };

  // Inject fake API key for the selected provider
  const providerHost = getProviderHost(provider);
  const fakeKey = fakeKeys.get(providerHost);
  if (!fakeKey) {
    throw new Error(`No fake key generated for ${providerHost}`);
  }

  switch (provider) {
    case 'anthropic':
      env.ANTHROPIC_API_KEY = fakeKey;
      break;
    case 'openai':
      env.OPENAI_API_KEY = fakeKey;
      break;
    case 'google':
      env.GOOGLE_API_KEY = fakeKey;
      break;
  }

  return env;
}
```

Helper:
```typescript
function getProviderHost(provider: 'anthropic' | 'openai' | 'google'): string {
  switch (provider) {
    case 'anthropic': return 'api.anthropic.com';
    case 'openai':    return 'api.openai.com';
    case 'google':    return 'generativelanguage.googleapis.com';
  }
}
```

**Key differences from Claude Code:**
- `SSL_CERT_FILE` and `SSL_CERT_DIR` instead of `NODE_EXTRA_CA_CERTS` (Goose is Rust -- these are set defensively; see Section 5 and Prototype 4 in Section 12 for verification)
- No `CLAUDE_CODE_DISABLE_UPDATE_CHECK`
- No OAuth support (Goose uses API keys for all providers)
- No `IRONCURTAIN_API_KEY` / apiKeyHelper pattern (Goose reads standard API key env vars directly)
- Adds `GOOSE_PROVIDER`, `GOOSE_MODEL`, `GOOSE_MODE`, `GOOSE_MAX_TURNS`

### 4.9 `extractResponse(exitCode: number, stdout: string): AgentResponse`

**This is the highest-risk method.** Goose has no `--output-format json` equivalent. The output is human-readable text mixed with tool call traces.

#### Recommended Approach: Last-Block Extraction

Goose's headless output follows a pattern:
1. Tool call traces (with formatting/ANSI codes)
2. Agent's intermediate reasoning
3. **Final text response** (the last block of text after tool execution completes)

**Strategy:**

```typescript
extractResponse(exitCode: number, stdout: string): AgentResponse {
  // Strip ANSI escape codes
  const clean = stripAnsi(stdout);

  if (exitCode !== 0) {
    return { text: `Goose exited with code ${exitCode}.\n\nOutput:\n${clean.trim()}` };
  }

  // Goose's final response is the last contiguous block of non-empty lines.
  // Tool traces are separated by blank lines or special markers.
  // This heuristic extracts the final meaningful text.
  const text = extractFinalResponse(clean);

  return { text };
}
```

`extractFinalResponse()` implementation strategy:
1. Split output into lines
2. Strip ANSI codes
3. Remove lines that look like tool call traces (lines starting with common Goose prefixes: timestamps, tool names, progress indicators)
4. Return the last contiguous block of non-empty, non-trace lines
5. If nothing remains after filtering, return the full cleaned output

**Prototype required.** The exact output format needs to be captured by running Goose in Docker headless mode with representative tasks. See Section 12 (Prototyping Requirements), item 1.

**Fallback options if parsing proves unreliable:**

- **Option A:** Return the full stdout (stripped of ANSI codes) as the response. Noisy but functional. The transport displays it to the user.
- **Option B:** Post-process with a lightweight LLM call to extract the final answer. Adds cost and latency but would be highly reliable.
- **Option C:** Write a small Goose MCP extension that captures the agent's final response and writes it to a known file in the workspace. Read the file after `docker exec` completes. This is the most robust approach but requires maintaining a Goose extension.

**Recommendation:** Start with the heuristic parser (last-block extraction). If it proves unreliable during prototyping, fall back to Option A (full output). Option C is the production-quality solution if Goose does not add JSON output mode.

**Cost tracking:** Goose does not report cost in stdout. The `costUsd` field will be `undefined`. The `BudgetStatus.tokenTrackingAvailable` is already `false` for Docker sessions, so this is consistent.

### 4.10 `buildPtyCommand(systemPrompt, ptySockPath, ptyPort): readonly string[]`

Builds the container command for PTY mode (interactive `goose run -s`).

```typescript
buildPtyCommand(
  _systemPrompt: string,
  ptySockPath: string | undefined,
  ptyPort: number | undefined,
): readonly string[] {
  const listenArg = ptySockPath
    ? `UNIX-LISTEN:${ptySockPath},fork`
    : `TCP-LISTEN:${ptyPort},reuseaddr`;

  return [
    'socat', listenArg,
    'EXEC:/etc/ironcurtain/start-goose.sh,pty,setsid,ctty,stderr,rawer'
  ];
}
```

Identical pattern to Claude Code's `buildPtyCommand()`. The difference is the script name (`start-goose.sh` vs `start-claude.sh`).

**System prompt injection in PTY mode:** The system prompt is written to `orientation/system-prompt.txt` by `pty-session.ts` (line 161). The entrypoint script loads it into `$IRONCURTAIN_SYSTEM_PROMPT`, and `start-goose.sh` writes it to a temp file and passes `--instructions` to Goose.

## 5. Dockerfile.goose Specification

**File:** `docker/Dockerfile.goose`

### Base Image Strategy

**FROM `ironcurtain-base:latest`** (same as Claude Code).

**Rationale:** The base image already provides:
- socat (needed for proxy bridges)
- CA certificate installation (`update-ca-certificates`)
- Standard directory structure (`/workspace`, `/etc/ironcurtain`, `/run/ironcurtain`)
- `codespace` user at UID 1000

Goose's official image (`ghcr.io/block/goose`) uses `debian:bookworm-slim` with UID 1000, which is compatible. However, building FROM the official Goose image would require re-adding all of IronCurtain's base infrastructure. Building FROM `ironcurtain-base` and installing Goose is cleaner and keeps the build pipeline consistent.

### Dockerfile

```dockerfile
FROM ironcurtain-base:latest

# Install Goose CLI
# The official install script handles platform detection (amd64/arm64)
# and installs to ~/.local/bin/. We install as root to /usr/local/bin/ instead.
USER root

# Goose is distributed as a single binary. Download from GitHub releases.
ARG GOOSE_VERSION=1.26.1
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) GOOSE_ARCH=x86_64 ;; \
      arm64) GOOSE_ARCH=aarch64 ;; \
      *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/block/goose/releases/download/v${GOOSE_VERSION}/goose-${GOOSE_ARCH}-unknown-linux-gnu.tar.bz2" \
      -o /tmp/goose.tar.bz2 && \
    tar -xjf /tmp/goose.tar.bz2 -C /usr/local/bin/ && \
    chmod +x /usr/local/bin/goose && \
    rm -f /tmp/goose.tar.bz2 && \
    apt-get purge -y curl && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# Entrypoint: bridges UDS proxy, writes Goose config, hands off to CMD
COPY entrypoint-goose.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Pre-create Goose config directory
USER codespace
RUN mkdir -p /home/codespace/.config/goose

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

**Notes:**
- Goose is a single static binary (Rust). No runtime dependencies beyond libc.
- The `GOOSE_VERSION` ARG enables version pinning. The image build hash includes the Dockerfile content, so version changes trigger rebuilds.
- `curl` is installed temporarily for download, then purged.
- `ca-certificates` may already be in the base image (the base runs `update-ca-certificates`), but including it is defensive.

**Alternative if binary download URL format differs:** The exact release asset naming convention needs verification during prototyping. The Goose GitHub releases page should be checked. If the binary is distributed differently (e.g., as an `install.sh` script), adapt accordingly.

### TLS Certificate Store (Rust/rustls Considerations)

The IronCurtain MITM proxy terminates TLS using a self-signed CA cert baked into the Docker image via `update-ca-certificates`. For this to work, Goose's HTTP client must trust the IronCurtain CA. This is straightforward for Node.js (`NODE_EXTRA_CA_CERTS`) but requires investigation for Rust.

**Rust TLS landscape:**
- **`native-tls`** crate: delegates to OpenSSL on Linux, which reads from `/etc/ssl/certs/`. If Goose uses this, `update-ca-certificates` is sufficient.
- **`rustls` with `rustls-native-certs`** (commonly enabled via `reqwest`'s `rustls-tls-native-roots` feature): reads from the OS cert store (`/etc/ssl/certs/` on Debian). Also works with `update-ca-certificates`.
- **`rustls` with `webpki-roots`** (compiled-in Mozilla roots): ignores `/etc/ssl/certs/` entirely. The IronCurtain CA will NOT be trusted, causing TLS handshake failures.

**Most likely case:** Goose uses `reqwest` (the dominant Rust HTTP library) with `rustls-tls-native-roots`, which reads the OS cert store. This is the common configuration for applications that need to work in enterprise environments with custom CAs.

**Defensive measures in this design:**
1. `update-ca-certificates` in the Dockerfile installs the IronCurtain CA into the OS cert store (covers `native-tls` and `rustls-native-certs`)
2. `SSL_CERT_FILE` and `SSL_CERT_DIR` env vars set in `buildEnv()` (some Rust TLS implementations and their OpenSSL backends respect these)

**Fallback if Goose uses compiled-in webpki roots:**
- **Option A: `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE`** -- some Rust HTTP wrappers check these env vars for compatibility with Python/curl conventions
- **Option B: Goose environment variable** -- check if Goose exposes a config option for custom CA certs (unlikely but worth checking)
- **Option C: Patch at the proxy level** -- configure the MITM proxy to use a real (Let's Encrypt) certificate for the upstream hosts. This defeats the purpose of self-signed certs but would work as a last resort.
- **Option D: Binary patching / LD_PRELOAD** -- extreme measure; not recommended

**Prototype 4 (Section 12) is BLOCKING and must verify which TLS backend Goose uses before implementation proceeds.** The simplest test: run Goose in a container with the IronCurtain CA installed and `HTTPS_PROXY` set; if API calls succeed, the cert store works. If they fail with a TLS error, escalate to the fallback options above.

## 6. entrypoint-goose.sh Specification

**File:** `docker/entrypoint-goose.sh`

```bash
#!/bin/bash
# IronCurtain entrypoint for Goose containers.
# Sets up proxy bridges, writes Goose config, then hands off to CMD.

# 1. Bridge MITM proxy UDS to local TCP (same as Claude Code entrypoint)
MITM_SOCK="/run/ironcurtain/mitm-proxy.sock"
PROXY_PORT=18080
if [ -S "$MITM_SOCK" ]; then
  socat TCP-LISTEN:$PROXY_PORT,fork,reuseaddr UNIX-CONNECT:$MITM_SOCK &
fi

# 2. Copy MCP config from orientation mount to Goose's expected location.
# The orientation dir is read-only mounted at /etc/ironcurtain/.
GOOSE_CONFIG_DIR="$HOME/.config/goose"
mkdir -p "$GOOSE_CONFIG_DIR"
if [ -f /etc/ironcurtain/goose-config.yaml ]; then
  cp /etc/ironcurtain/goose-config.yaml "$GOOSE_CONFIG_DIR/config.yaml"
fi

# 3. Load system prompt into env var for PTY mode scripts.
# Non-PTY mode injects the prompt via --instructions per turn.
if [ -f /etc/ironcurtain/system-prompt.txt ]; then
  export IRONCURTAIN_SYSTEM_PROMPT
  IRONCURTAIN_SYSTEM_PROMPT=$(cat /etc/ironcurtain/system-prompt.txt)
fi

# 4. Hand off to CMD
# Non-PTY: CMD = "sleep infinity" (agent commands arrive via docker exec)
# PTY:     CMD = socat PTY command from buildPtyCommand()
exec "$@"
```

**Differences from `entrypoint-claude-code.sh`:**
- No Claude Code pre-seeding (`.claude.json`, `.claude/settings.json`)
- No apiKeyHelper setup (Goose reads API keys from standard env vars)
- Config file is YAML copied to `~/.config/goose/config.yaml` instead of JSON to `.claude/settings.json`
- No OAuth branch (Goose does not support Claude's OAuth flow)

## 7. MCP Configuration Generation

### Goose Extension Config Format

Goose discovers MCP servers from `~/.config/goose/config.yaml` under the `extensions` key:

```yaml
extensions:
  ironcurtain:
    name: IronCurtain Sandbox
    type: stdio
    enabled: true
    cmd: socat
    args:
      - STDIO
      - UNIX-CONNECT:/run/ironcurtain/proxy.sock
    timeout: 600
```

For TCP mode (macOS):
```yaml
extensions:
  ironcurtain:
    name: IronCurtain Sandbox
    type: stdio
    enabled: true
    cmd: socat
    args:
      - STDIO
      - TCP:host.docker.internal:12345
    timeout: 600
```

### Implementation in `generateMcpConfig()`

```typescript
generateMcpConfig(socketPath: string): AgentConfigFile[] {
  const isTcp = socketPath.includes(':');
  const connectTarget = isTcp ? `TCP:${socketPath}` : `UNIX-CONNECT:${socketPath}`;

  const yaml = [
    'extensions:',
    '  ironcurtain:',
    '    name: IronCurtain Sandbox',
    '    type: stdio',
    '    enabled: true',
    '    cmd: socat',
    '    args:',
    '      - STDIO',
    `      - ${connectTarget}`,
    '    timeout: 600',
    '',
  ].join('\n');

  return [{ path: 'goose-config.yaml', content: yaml }];
}
```

**Why no YAML library:** The config structure is fixed (only the socat target varies). Template strings avoid adding a dependency for trivial serialization.

**`timeout: 600`**: 10 minutes. MCP tool calls that trigger escalations can block for extended periods while waiting for human approval. The default Goose extension timeout (300s) may be too short if an escalation takes several minutes to resolve.

## 8. Response Parsing Strategy

### The Problem

Goose has no `--output-format json`. Its headless output is human-readable text that includes:
- Tool call traces (tool name, arguments, results)
- Agent reasoning
- The final response text
- Possible ANSI escape codes (color, formatting)

### Prototype-First Approach

**Before implementing the parser, run the following prototype experiment:**

1. Build the `ironcurtain-goose` Docker image
2. Run: `docker run --rm -e GOOSE_PROVIDER=anthropic -e GOOSE_MODEL=claude-sonnet-4-20250514 -e ANTHROPIC_API_KEY=... -e GOOSE_MODE=auto ghcr.io/block/goose:v1.26.1 run --no-session -t "What is 2+2?"`
3. Capture the full stdout and stderr
4. Run with a tool-using task: `... -t "List the files in /tmp"`
5. Capture the full stdout and stderr
6. Run with a multi-step task that produces substantial output
7. Document the output structure: delimiters, markers, formatting patterns

### Recommended Parser Design

Based on observed patterns from similar CLI agents, the parser should:

```typescript
function extractFinalResponse(raw: string): string {
  // 1. Strip ANSI escape codes
  const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  // 2. Split into lines
  const lines = clean.split('\n');

  // 3. Find the last block of non-empty lines that are not tool traces.
  // Tool traces typically contain patterns like:
  //   - "Tool: <name>" or "calling <name>"
  //   - Timestamps "[2026-03-03 ...]"
  //   - Spinner characters or progress indicators
  // The final response is the last block after all tool execution.

  // Walk backwards from the end, collecting lines until we hit
  // a blank line preceded by tool-trace-like content.
  const result: string[] = [];
  let foundContent = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '') {
      if (foundContent) break;  // end of final block
      continue;
    }
    foundContent = true;
    result.unshift(line);
  }

  return result.length > 0 ? result.join('\n') : clean.trim();
}
```

**This is a starting point.** The prototype (Section 12) will reveal the actual output structure and the parser will be refined accordingly.

### Fallback: Full Output Mode

If the parser proves unreliable, the fallback is to return the full ANSI-stripped output:

```typescript
extractResponse(exitCode: number, stdout: string): AgentResponse {
  const clean = stripAnsi(stdout).trim();
  if (exitCode !== 0) {
    return { text: `Goose exited with code ${exitCode}.\n\nOutput:\n${clean}` };
  }
  return { text: clean };
}
```

This is noisy but functional. The user sees everything Goose produced, including tool traces.

## 9. Multi-Turn Session Strategy

### Batch Mode (Non-PTY)

Each `sendMessage()` invokes `docker exec` with `goose run --no-session`. This means:

- **No conversation history between turns.** Each turn is independent.
- The system prompt provides context for every turn.
- The user's message is the only variable input per turn.

**Mitigation for lack of history:** The `buildCommand()` method can include a condensed summary of previous turns in the instructions file:

```typescript
buildCommand(message: string, systemPrompt: string): readonly string[] {
  // Include previous turn summaries if available
  // (passed via a session-level mechanism, TBD)
  const instructions = [
    systemPrompt,
    '---',
    `User request:\n${message}`,
  ].join('\n\n');
  // ... write to temp file, invoke goose run
}
```

**Future improvement:** If Goose adds `--resume-session` support in headless mode with reliable session ID management, this can be upgraded to maintain history. The adapter interface's `buildCommand()` receives the message and system prompt, which is sufficient to implement either approach.

### PTY Mode (Interactive)

PTY mode runs `goose run -s` (interactive with instructions), which maintains full conversation history within the session. This is the recommended mode for extended work with Goose.

- The system prompt is injected once via `--instructions` at session start
- Goose maintains its own conversation history
- The user interacts directly via the terminal
- Escalations are surfaced via BEL character (same as Claude Code PTY mode)

**PTY mode is the primary recommended mode for Goose.** Batch mode is available for programmatic/single-shot usage but with the caveat of no inter-turn history.

## 10. Changes to Existing Files

### 10.1 `src/docker/agent-registry.ts`

**Change:** Add Goose adapter registration in `registerBuiltinAdapters()`.

```typescript
export async function registerBuiltinAdapters(userConfig?: ResolvedUserConfig): Promise<void> {
  const { claudeCodeAdapter } = await import('./adapters/claude-code.js');
  if (!registry.has(claudeCodeAdapter.id)) {
    registry.set(claudeCodeAdapter.id, claudeCodeAdapter);
  }

  // Goose adapter is always registered with a default config so it
  // appears in --list-agents even before the user has configured it.
  // The resolved user config (if provided) determines provider selection;
  // without it, defaults apply (anthropic provider, default model).
  const { createGooseAdapter } = await import('./adapters/goose.js');
  const gooseAdapter = createGooseAdapter(userConfig);
  if (!registry.has(gooseAdapter.id)) {
    registry.set(gooseAdapter.id, gooseAdapter);
  }
}
```

**Key design decision:** `createGooseAdapter()` accepts `userConfig` as **optional**. When `undefined`, it uses hardcoded defaults (`gooseProvider: 'anthropic'`, `gooseModel: 'claude-sonnet-4-20250514'`). This means `--list-agents` works without loading config, and the Goose adapter always appears in the list. The actual provider selection only matters at session creation time, when config is always available.

**Impact:** Callers of `registerBuiltinAdapters()`:
- `src/docker/docker-infrastructure.ts` (line 83) -- passes `config.userConfig` (already has access to config)
- `src/index.ts` (line 32, `--list-agents`) -- calls without config (Goose uses defaults, which is fine for listing)
- `src/mux/mux-command.ts` (line 38) -- does NOT call `registerBuiltinAdapters()` directly; registration happens inside child `ironcurtain start` processes. See Section 10.8.

### 10.2 `src/session/preflight.ts`

**Changes:**

1. Replace the hardcoded `DEFAULT_DOCKER_AGENT` with selection logic:
   ```typescript
   // If Docker is available, check credentials for the user's preferred agent.
   // Default to claude-code when no preference is set.
   const defaultAgent = (config.userConfig.preferredDockerAgent ?? 'claude-code') as AgentId;
   ```

2. Update `detectCredentials()` to be provider-aware for Goose. Note that preflight runs *before* the adapter is instantiated (it decides which adapter to use), so it cannot call `adapter.detectCredential()`. Instead, it mirrors the logic inline:
   ```typescript
   function detectCredentials(agentId: AgentId, config: IronCurtainConfig, ...): 'oauth' | 'apikey' | null {
     if (agentId === 'goose') {
       // Goose credential detection: check for the provider's API key.
       // Mirrors GooseAgentAdapter.detectCredential() logic.
       const provider = config.userConfig.gooseProvider ?? 'anthropic';
       switch (provider) {
         case 'anthropic': return config.userConfig.anthropicApiKey ? 'apikey' : null;
         case 'openai':    return config.userConfig.openaiApiKey ? 'apikey' : null;
         case 'google':    return config.userConfig.googleApiKey ? 'apikey' : null;
       }
     }
     // Existing Claude Code detection (OAuth or API key)
     const auth = detectAuthMethod(config, sources ?? preflightSources);
     if (auth.kind === 'none') return null;
     return auth.kind === 'oauth' ? 'oauth' : 'apikey';
   }
   ```

   **Duplication note:** The Goose branch in preflight duplicates logic from `GooseAgentAdapter.detectCredential()`. This is intentional -- preflight must be lightweight and not import the full adapter module. The two code paths must be kept in sync. A shared utility function (e.g., `resolveGooseApiKey(provider, userConfig)`) could reduce the duplication without coupling preflight to the adapter.

### 10.3 `src/config/user-config.ts`

**Changes:** Add new fields to `UserConfig` and `ResolvedUserConfig`:

```typescript
// In UserConfig (nullable)
gooseProvider?: 'anthropic' | 'openai' | 'google';
gooseModel?: string;
preferredDockerAgent?: 'claude-code' | 'goose';

// In ResolvedUserConfig (defaults applied)
gooseProvider: 'anthropic' | 'openai' | 'google';  // default: 'anthropic'
gooseModel: string;  // default: 'claude-sonnet-4-20250514'
preferredDockerAgent: 'claude-code' | 'goose';  // default: 'claude-code'
```

### 10.4 `src/config/config-command.ts`

**Changes:** Add Goose configuration section to the interactive config editor:
- Goose provider selection (anthropic/openai/google)
- Goose model ID
- Preferred Docker agent (claude-code/goose)

### 10.5 `src/config/first-start.ts`

**Changes:** No changes needed for initial release. The first-start wizard focuses on essential setup (API key). Goose-specific configuration can be set later via `ironcurtain config`.

### 10.6 `src/docker/docker-infrastructure.ts`

**Changes:**

1. Pass `userConfig` to `registerBuiltinAdapters()` (line 83):
   ```typescript
   await registerBuiltinAdapters(config.userConfig);
   ```

2. **Refactor credential detection (lines 90-95)** to be adapter-aware. This is the core fix for blocker B1. Replace the direct `detectAuthMethod()` call with adapter delegation:
   ```typescript
   // Before:
   const authMethod = detectAuthMethod(config);
   if (authMethod.kind === 'none') {
     throw new Error(
       'No credentials available for Docker session. '
       + 'Log in with `claude login` (OAuth) or set ANTHROPIC_API_KEY.',
     );
   }

   // After:
   const authMethod = adapter.detectCredential
     ? adapter.detectCredential(config)
     : detectAuthMethod(config);
   if (authMethod.kind === 'none') {
     throw new Error(adapter.credentialHelpText
       ?? 'No credentials available for Docker session. '
       + 'Log in with `claude login` (OAuth) or set ANTHROPIC_API_KEY.');
   }
   ```

   The existing `detectAuthMethod()` import is retained as the default for adapters that do not implement `detectCredential()` (i.e., Claude Code). This is a backward-compatible change: Claude Code behavior is identical to before.

3. `resolveRealKey()` already handles all three provider hosts (Anthropic, OpenAI, Google). No changes needed.

4. **Error messages (S4):** The `credentialHelpText` field on `AgentAdapter` (optional, readonly string) replaces the hardcoded Anthropic-specific error message. Each adapter provides its own guidance. Adapters that omit the field fall back to the existing message, preserving backward compatibility.

### 10.7 `src/index.ts`

**Changes:**

1. `--list-agents` handler (line 32): Call `registerBuiltinAdapters()` without config. Because `createGooseAdapter()` accepts `undefined` and falls back to defaults, Goose appears in the listing without requiring a config load. No change needed to the existing call site -- the current code already calls `registerBuiltinAdapters()` with no arguments, and the new signature makes `userConfig` optional. Goose will appear with its default display name.

### 10.8 `src/mux/mux-command.ts`

**No changes required for this integration.** The multiplexer (`ironcurtain mux`) does not call `registerBuiltinAdapters()` directly. It spawns child `ironcurtain start --pty --agent <name>` processes, and adapter registration happens inside each child process via `prepareDockerInfrastructure()`. The `agent` variable in `mux-command.ts` (line 38, `let agent = 'claude-code'`) is a string passed through to the child process CLI args.

**Follow-up (not in scope for this integration):** `mux-command.ts` hardcodes `let agent = 'claude-code'` as the default. A small follow-up could read `preferredDockerAgent` from user config to respect the user's preference:
```typescript
// Potential follow-up change:
const userConfig = loadUserConfig({ readOnly: true });
let agent = userConfig.preferredDockerAgent ?? 'claude-code';
```
This is deferred because it is independent of the Goose adapter itself and the multiplexer already accepts `--agent goose` as an explicit override.

### 10.9 `src/docker/agent-adapter.ts`

**Changes:** Add two optional fields to the `AgentAdapter` interface:

```typescript
/**
 * Detects available credentials for this agent.
 * When not implemented, prepareDockerInfrastructure() falls back to
 * detectAuthMethod() (Anthropic OAuth + API key detection).
 */
detectCredential?(config: IronCurtainConfig): AuthMethod;

/**
 * Error message to show when no credentials are detected.
 * When not set, the default Anthropic-oriented message is used.
 */
readonly credentialHelpText?: string;
```

These are optional fields, so the existing Claude Code adapter does not need modification. This is a backward-compatible interface extension.

## 11. Test Strategy

### 11.1 Unit Tests

**File:** `test/goose-adapter.test.ts`

Test the adapter methods in isolation:

1. **`generateMcpConfig()`**
   - UDS path produces `UNIX-CONNECT:` YAML
   - TCP address produces `TCP:` YAML
   - Output is valid YAML (parse with a YAML library in the test)
   - `timeout` field is present

2. **`generateOrientationFiles()`**
   - Returns 3 files: `start-goose.sh`, `resize-pty.sh`, `check-pty-size.sh`
   - All scripts have executable mode (`0o755`)
   - Scripts reference correct process name (`goose`, not `claude`)

3. **`buildCommand()`**
   - Contains `goose run --no-session`
   - Contains `--instructions` or `-i` flag
   - System prompt is included in the instructions
   - Heredoc delimiter is unique when input contains `IRONCURTAIN_EOF`
   - Input containing `IRONCURTAIN_EOF` substring does not corrupt the shell command
   - `escapeHeredoc()` returns a stable delimiter when input has no collision

4. **`buildSystemPrompt()`**
   - Contains workspace path
   - Contains MCP tool guidance
   - Does NOT mention `execute_code` (that is a Claude Code concept)
   - Contains policy enforcement explanation

5. **`getProviders()`**
   - Returns `anthropicProvider` when `gooseProvider: 'anthropic'`
   - Returns `openaiProvider` when `gooseProvider: 'openai'`
   - Returns `googleProvider` when `gooseProvider: 'google'`
   - Returns exactly one provider (not multiple)

6. **`buildEnv()`**
   - Sets `GOOSE_PROVIDER` matching config
   - Sets `GOOSE_MODEL` matching config
   - Sets `GOOSE_MODE=auto`
   - Sets correct API key env var for each provider
   - Sets `GOOSE_MAX_TURNS`
   - Sets `SSL_CERT_FILE` and `SSL_CERT_DIR` (defensive TLS cert env vars)
   - Does NOT set `NODE_EXTRA_CA_CERTS` (Goose is not Node.js)
   - Throws if fake key is missing for the provider

9. **`detectCredential()`**
   - Returns `{ kind: 'apikey' }` when the provider's API key is present in config
   - Returns `{ kind: 'none' }` when the provider's API key is absent
   - Checks `anthropicApiKey` when `gooseProvider: 'anthropic'`
   - Checks `openaiApiKey` when `gooseProvider: 'openai'`
   - Checks `googleApiKey` when `gooseProvider: 'google'`

7. **`extractResponse()`**
   - Non-zero exit code returns error message with output
   - Clean text returns as-is (trimmed)
   - ANSI codes are stripped
   - Empty stdout returns empty string (not crash)

8. **`buildPtyCommand()`**
   - UDS: contains `UNIX-LISTEN:` and `start-goose.sh`
   - TCP: contains `TCP-LISTEN:` and `start-goose.sh`

**File:** `test/docker-infrastructure-credential-detection.test.ts`

Test the refactored credential detection in `prepareDockerInfrastructure()`:

10. **Adapter without `detectCredential()`** (Claude Code path)
    - Falls back to `detectAuthMethod()` -- existing behavior preserved
    - Error message is the default Anthropic-oriented message

11. **Adapter with `detectCredential()`** (Goose path)
    - Calls `adapter.detectCredential()` instead of `detectAuthMethod()`
    - Returns `{ kind: 'apikey' }` when the provider key is set
    - Returns `{ kind: 'none' }` when the provider key is missing
    - Error message uses `adapter.credentialHelpText`
    - Goose with `gooseProvider: 'openai'` + `openaiApiKey` set -> succeeds
    - Goose with `gooseProvider: 'openai'` + only `anthropicApiKey` set -> fails with Goose-specific error

### 11.2 Integration Tests

**File:** `test/goose-docker-session.integration.test.ts`

**Prerequisite:** Docker available, Goose image built.

These tests mirror the existing Claude Code Docker integration tests:

1. **Image build:** `ensureImage('ironcurtain-goose:latest')` succeeds
2. **Container lifecycle:** Create, start, exec, stop, remove
3. **MCP proxy connectivity:** Container can reach the Code Mode proxy via socat
4. **MITM proxy connectivity:** Container can reach the MITM proxy
5. **Environment variables:** Verify env vars are set correctly inside container
6. **Config file placement:** `~/.config/goose/config.yaml` exists and is valid YAML
7. **TLS trust:** Container can make HTTPS requests through the MITM proxy (verifies CA cert trust)

### 11.3 Response Parsing Tests

**File:** `test/goose-response-parser.test.ts`

Test with captured Goose output samples (stored as fixtures):

1. Simple text response (no tool calls)
2. Response with tool call traces
3. Response with ANSI codes
4. Error output (non-zero exit code)
5. Empty output
6. Very long output (truncation behavior)

**These fixtures will be populated during the prototyping phase.**

## 12. Prototyping Requirements

Four items must be prototyped before full implementation. Each can be done independently in 1-2 hours.

### Prototype 1: Response Format Capture (BLOCKING)

**Goal:** Capture actual Goose headless output to design the parser.

**Steps:**
1. Pull the official Goose image: `docker pull ghcr.io/block/goose:v1.26.1`
2. Run simple task:
   ```bash
   docker run --rm \
     -e GOOSE_PROVIDER=anthropic \
     -e GOOSE_MODEL=claude-sonnet-4-20250514 \
     -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
     -e GOOSE_MODE=auto \
     ghcr.io/block/goose:v1.26.1 \
     run --no-session -t "What is 2+2? Reply with just the number."
   ```
3. Capture stdout, stderr separately: `... > stdout.txt 2> stderr.txt`
4. Run a task that triggers tool usage (file listing, etc.)
5. Run a multi-step task with extended output
6. Document: Where does the final answer appear? What separates it from tool traces? Are there reliable markers?

**Output:** A set of stdout/stderr sample files and a written analysis of the output structure. This directly informs the `extractResponse()` implementation.

### Prototype 2: Goose Binary Distribution (BLOCKING for Dockerfile)

**Goal:** Verify the binary download URL format and installation process.

**Steps:**
1. Check `https://github.com/block/goose/releases` for the exact asset naming convention
2. Verify the binary is statically linked (or what shared libraries it needs)
3. Test the download + extraction on both amd64 and arm64
4. Verify `goose --version` works after installation

**Output:** Confirmed Dockerfile `RUN` commands for binary installation, or an alternative approach if the binary distribution does not match the specification in Section 5.

### Prototype 3: MCP Extension Configuration (NON-BLOCKING, can be done during implementation)

**Goal:** Verify that Goose correctly discovers and uses the IronCurtain MCP extension from `config.yaml`.

**Steps:**
1. Create a test `config.yaml` with a simple stdio extension (e.g., the MCP filesystem server)
2. Mount it into a Goose container
3. Run a task that requires the extension
4. Verify Goose discovers the tools and uses them

**Output:** Confirmed config.yaml format and path.

### Prototype 4: TLS Certificate Store Verification (BLOCKING)

**Goal:** Determine whether Goose trusts custom CA certificates installed via `update-ca-certificates` in the Docker image, or whether it uses compiled-in webpki roots that ignore the OS cert store.

**Steps:**
1. Build a test Docker image with the IronCurtain CA cert installed via `update-ca-certificates`
2. Set `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` and `SSL_CERT_DIR=/etc/ssl/certs`
3. Start the MITM proxy on the host with the IronCurtain CA
4. Run Goose inside the container with `HTTPS_PROXY` pointing to the MITM proxy
5. Attempt a simple LLM API call (e.g., `goose run --no-session -t "hello"`)
6. Check whether the call succeeds (CA trusted) or fails with a TLS handshake error

**Expected result:** The call succeeds because Goose most likely uses `reqwest` with `rustls-tls-native-roots`, which reads the OS cert store.

**If TLS verification fails:**
1. Check `ldd /usr/local/bin/goose` to see if it links against OpenSSL (would confirm `native-tls`)
2. Try `REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt` and `CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt` as env vars
3. Run `strings /usr/local/bin/goose | grep -i 'webpki\|native.certs\|rustls'` to identify the TLS backend
4. If all else fails, this becomes a design escalation -- document findings and evaluate Option C/D from Section 5

**Output:** Confirmed TLS strategy (env vars sufficient, or requires alternative approach). This directly determines whether `buildEnv()` needs additional CA-related env vars and whether the Dockerfile needs further changes.

## 13. Rollout Plan (Implementation Order)

### Phase 1: Prototyping (1-2 days)

Complete all four prototypes from Section 12. The critical path items are:
- Prototype 1 (response format capture) -- determines parser design and batch mode viability
- Prototype 2 (binary distribution) -- determines Dockerfile commands
- Prototype 4 (TLS cert store) -- determines whether the MITM proxy can intercept Goose's API calls at all; if this fails, the entire integration approach needs rethinking

Prototype 3 (MCP config) is non-blocking and can be done during Phase 2.

### Phase 2: Infrastructure + Adapter Core (2-3 days)

1. Extend `AgentAdapter` interface with `detectCredential()` and `credentialHelpText` (`src/docker/agent-adapter.ts`)
2. Refactor credential detection in `prepareDockerInfrastructure()` (`src/docker/docker-infrastructure.ts`)
3. Add `gooseProvider`, `gooseModel`, `preferredDockerAgent` to user config (`src/config/user-config.ts`)
4. Create `src/docker/adapters/goose.ts` with all adapter methods
5. Create `docker/Dockerfile.goose` and `docker/entrypoint-goose.sh`
6. Register the adapter in `src/docker/agent-registry.ts` (with optional config parameter)
7. Unit tests for adapter methods and credential detection refactor (`test/goose-adapter.test.ts`)

**Deliverable:** Adapter compiles, passes unit tests, Dockerfile builds. Infrastructure refactor is backward-compatible (Claude Code behavior unchanged).

### Phase 3: Batch Mode Integration (1-2 days)

1. Update preflight logic in `src/session/preflight.ts` (provider-aware credential detection)
2. Verify `--list-agents` in `src/index.ts` shows Goose without requiring config
3. Test end-to-end: `ironcurtain start --agent goose "hello world"`
4. Implement response parser based on prototype findings
5. Response parser tests with captured fixtures

**Deliverable:** Batch mode works end-to-end for simple tasks.

### Phase 4: PTY Mode (1 day)

1. Test `goose run -s` via socat PTY bridge
2. Verify terminal resize works
3. Verify escalation BEL character works
4. Test PTY session end-to-end

**Deliverable:** `ironcurtain start --agent goose --pty` works interactively.

### Phase 5: Configuration UI (0.5 day)

1. Add Goose settings to `ironcurtain config` interactive editor
2. Test the configuration flow

**Deliverable:** Users can configure Goose provider/model via `ironcurtain config`.

### Phase 6: Documentation and Cleanup (0.5 day)

1. Update `src/docker/CLAUDE.md` with Goose adapter documentation
2. Update top-level `CLAUDE.md` if needed
3. Remove any prototype/debugging code
4. Final review of all edge cases

**Total estimated effort:** 6-9 days for one engineer.

## 14. Open Questions Summary

| # | Question | Recommended Resolution | Blocking? |
|---|----------|----------------------|-----------|
| 1 | Goose stdout format for parsing | Prototype 1 captures samples; design parser from real output | Yes |
| 2 | Binary distribution URL format | Prototype 2 verifies download | Yes |
| 3 | TLS cert store: does Goose trust custom CAs? | Prototype 4 verifies; `SSL_CERT_FILE`/`SSL_CERT_DIR` set defensively; fallbacks documented in Section 5 | Yes |
| 4 | MCP config.yaml exact format and path | Prototype 3 or verify from Goose docs | No |
| 5 | Multi-turn history in batch mode | Accept stateless turns initially; upgrade if Goose adds `--resume-session` for headless | No |
| 6 | Goose v1.25.0 built-in sandboxing conflict with `--network=none` | `GOOSE_MODE=auto` likely disables it; verify during Prototype 1 | No |
| 7 | `GOOSE_MAX_TURNS` default value | Start with 200 (matches IronCurtain's default step limit); tune based on usage | No |
| 8 | Goose keyring bypass in Docker | Env vars take priority per Goose docs; verified by the `GOOSE_MODE=auto` pattern | No |
| 9 | System prompt length limits with `--instructions` | File-based injection (`-i /path/to/file`) avoids shell arg limits; verify file size limits during Prototype 1 | No |
| 10 | Goose arm64 binary availability | Check GitHub releases; the official Docker image supports multi-arch, so binaries should exist | No |
| 11 | OAuth support for Goose | Not supported initially; Goose uses API keys for all providers. Can be added later if needed | No |

## 15. Differences from Claude Code Adapter (Summary)

| Aspect | Claude Code | Goose |
|--------|-------------|-------|
| Image | `ironcurtain-claude-code:latest` | `ironcurtain-goose:latest` |
| Runtime | Node.js | Rust (single binary) |
| MCP config format | JSON (`mcpServers` key) | YAML (`extensions` key) |
| Config location | `--mcp-config` CLI flag | `~/.config/goose/config.yaml` |
| System prompt injection | `--append-system-prompt` (inline) | `--instructions`/`-i` (file-based) |
| Batch mode command | `claude --continue -p "msg"` | `goose run --no-session -i file` |
| Session continuity | `--continue` resumes session | No continuity in batch mode |
| Output format | `--output-format json` | Plain text (parsed heuristically) |
| Provider selection | Always Anthropic | User-configurable (anthropic/openai/google) |
| Auth method | API key or OAuth | API key only |
| CA cert env var | `NODE_EXTRA_CA_CERTS` | `SSL_CERT_FILE` + `SSL_CERT_DIR` (defensive; see Prototype 4) |
| Permission bypass | `--dangerously-skip-permissions` | `GOOSE_MODE=auto` |
| Cost tracking | `total_cost_usd` in JSON output | Not available |
| PTY startup script | `start-claude.sh` | `start-goose.sh` |
| Credential detection | `detectAuthMethod()` (Anthropic OAuth + API key) | `detectCredential()` (provider-specific API key) |
| Credential error message | Hardcoded (mentions `claude login`) | `credentialHelpText` (mentions provider-specific env vars) |
| Process name (for resize) | `claude` | `goose` |
