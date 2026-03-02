/**
 * Claude Code agent adapter -- reference implementation.
 *
 * Configures a Docker container running Claude Code CLI with:
 * - MCP server discovery via settings.json (socat bridge to UDS)
 * - System prompt injection via --append-system-prompt
 * - --continue for session resume across turns
 * - --dangerously-skip-permissions (IronCurtain handles security)
 *
 * The system prompt composes two layers:
 * 1. Code Mode instructions (from session/prompts.ts) for tool discovery
 * 2. Docker environment context explaining workspace, host access, and policy
 */

import type { AgentAdapter, AgentConfigFile, AgentId, AgentResponse, OrientationContext } from '../agent-adapter.js';
import type { IronCurtainConfig } from '../../config/types.js';
import type { ProviderConfig } from '../provider-config.js';
import {
  anthropicProvider,
  claudePlatformProvider,
  anthropicOAuthProvider,
  claudePlatformOAuthProvider,
} from '../provider-config.js';
import { buildSystemPrompt } from '../../session/prompts.js';

const CLAUDE_CODE_IMAGE = 'ironcurtain-claude-code:latest';

function buildDockerEnvironmentPrompt(context: OrientationContext): string {
  return `## Docker Environment

### Workspace (\`${context.workspaceDir}\`)
This is YOUR local workspace inside the container. Use your normal built-in
tools (Bash, Read, Write, Edit, etc.) freely here -- no restrictions.

This directory is a bind-mount of \`${context.hostSandboxDir}\` on the host.
Files you create at \`${context.workspaceDir}/foo.txt\` are visible to MCP tools
at \`${context.hostSandboxDir}/foo.txt\` and vice versa.

### Host Filesystem
To read or modify files on the host operating system you MUST use the
\`execute_code\` MCP tool with the sandbox tools listed above. These tools are
mediated by IronCurtain's policy engine: every call is evaluated against
security rules and recorded in the audit log.
Your built-in file tools cannot reach the host filesystem.

### Network
The container has NO direct internet access. All HTTP requests and
git operations MUST go through the sandbox tools via \`execute_code\`.

IMPORTANT: Your built-in server-side web search tool (WebSearch) is DISABLED
and will NOT work — it is stripped by the security proxy. You MUST use the
sandbox tools via \`execute_code\` instead. Do NOT attempt to use your
built-in WebSearch or WebFetch tools.

To search the web:
  \`const results = tools.fetch_web_search({ query: "search terms" });\`
To fetch a URL:
  \`const page = tools.fetch_http_fetch({ url: "https://example.com" });\`

### Policy Enforcement
Every tool call through \`execute_code\` is evaluated against security policy rules:
- **Allowed**: proceeds automatically
- **Denied**: blocked -- do NOT retry denied operations
- **Escalated**: requires human approval -- you will receive the result once approved

### Best Practices
1. Use your built-in tools for work inside ${context.workspaceDir}
2. Use \`execute_code\` for anything on the host filesystem or network
3. Batch external operations to minimize escalation prompts
4. If an operation is denied, explain the denial and suggest alternatives
5. Do not attempt to bypass the sandbox
`;
}

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code' as AgentId,
  displayName: 'Claude Code',

  // eslint-disable-next-line @typescript-eslint/require-await -- interface requires Promise return
  async getImage(): Promise<string> {
    return CLAUDE_CODE_IMAGE;
  },

  // Generates MCP config file passed via --mcp-config on the command line.
  // socketPath is either a UDS path or a TCP host:port address.
  generateMcpConfig(socketPath: string): AgentConfigFile[] {
    const isTcp = socketPath.includes(':');
    const mcpConfig = {
      mcpServers: {
        ironcurtain: {
          command: 'socat',
          args: isTcp ? ['STDIO', `TCP:${socketPath}`] : ['STDIO', `UNIX-CONNECT:${socketPath}`],
        },
      },
    };

    return [
      {
        path: 'claude-mcp-config.json',
        content: JSON.stringify(mcpConfig, null, 2),
      },
    ];
  },

  generateOrientationFiles(): AgentConfigFile[] {
    // Wrapper script for PTY mode -- avoids shell quoting issues by reading
    // the system prompt from $IRONCURTAIN_SYSTEM_PROMPT (set by entrypoint).
    // Sets initial PTY size from host-provided env vars before exec, so the
    // PTY has the correct dimensions before Claude even starts.
    const startScript = `#!/bin/bash
# Set initial terminal size from host env vars
if [ -n "$IRONCURTAIN_INITIAL_COLS" ] && [ -n "$IRONCURTAIN_INITIAL_ROWS" ]; then
  stty cols "$IRONCURTAIN_INITIAL_COLS" rows "$IRONCURTAIN_INITIAL_ROWS" 2>/dev/null
fi
exec claude --dangerously-skip-permissions \\
  --mcp-config /etc/ironcurtain/claude-mcp-config.json \\
  --append-system-prompt "$IRONCURTAIN_SYSTEM_PROMPT"
`;

    // Helper script to resize the PTY that Claude Code is actually running on.
    // docker exec stty targets a transient exec session PTY, not socat's PTY.
    // Falls back to start-claude.sh PID when Claude hasn't started yet.
    // Diagnostic output goes to stderr (captured by host-side logger).
    const resizeScript = `#!/bin/bash
# Called from the host via: docker exec <cid> /etc/ironcurtain/resize-pty.sh <cols> <rows>
COLS=$1
ROWS=$2

# Find the PTY device -- try Claude first, then fall back to start script
PTS=""
CLAUDE_PID=$(pgrep -x claude | head -1)
if [ -n "$CLAUDE_PID" ]; then
  PTS=$(readlink /proc/$CLAUDE_PID/fd/0 2>/dev/null)
fi
if [ -z "$PTS" ]; then
  SCRIPT_PID=$(pgrep -f "start-claude" | head -1)
  if [ -n "$SCRIPT_PID" ]; then
    PTS=$(readlink /proc/$SCRIPT_PID/fd/0 2>/dev/null)
  fi
fi
if [ -z "$PTS" ] || ! [ -e "$PTS" ]; then
  echo "no-pty pid=$CLAUDE_PID pts=$PTS" >&2
  exit 0
fi

stty -F "$PTS" cols "$COLS" rows "$ROWS" 2>/dev/null
RC=$?
if [ -n "$CLAUDE_PID" ]; then
  kill -WINCH "$CLAUDE_PID" 2>/dev/null
fi
echo "ok pid=$CLAUDE_PID pts=$PTS stty=$RC \${COLS}x\${ROWS}" >&2
`;

    // Helper script to report the current PTY size for host-side verification.
    const checkSizeScript = `#!/bin/bash
# Returns "rows cols" of the container PTY
PTS=""
CLAUDE_PID=$(pgrep -x claude | head -1)
if [ -n "$CLAUDE_PID" ]; then
  PTS=$(readlink /proc/$CLAUDE_PID/fd/0 2>/dev/null)
fi
if [ -z "$PTS" ]; then
  SCRIPT_PID=$(pgrep -f "start-claude" | head -1)
  if [ -n "$SCRIPT_PID" ]; then
    PTS=$(readlink /proc/$SCRIPT_PID/fd/0 2>/dev/null)
  fi
fi
if [ -z "$PTS" ] || ! [ -e "$PTS" ]; then echo "0 0"; exit 0; fi
stty -F "$PTS" size 2>/dev/null || echo "0 0"
`;

    return [
      { path: 'start-claude.sh', content: startScript, mode: 0o755 },
      { path: 'resize-pty.sh', content: resizeScript, mode: 0o755 },
      { path: 'check-pty-size.sh', content: checkSizeScript, mode: 0o755 },
    ];
  },

  buildCommand(message: string, systemPrompt: string): readonly string[] {
    return [
      'claude',
      '--continue',
      '--dangerously-skip-permissions',
      '--output-format',
      'json',
      '--mcp-config',
      '/etc/ironcurtain/claude-mcp-config.json',
      '--append-system-prompt',
      systemPrompt,
      '-p',
      message,
    ];
  },

  buildSystemPrompt(context: OrientationContext): string {
    // Layer 1: Code Mode instructions (tool discovery, sync calls, return semantics)
    const codeModePrompt = buildSystemPrompt(context.serverListings, context.hostSandboxDir);

    // Layer 2: Docker environment specifics (workspace, host access, policy)
    const dockerPrompt = buildDockerEnvironmentPrompt(context);

    return `${codeModePrompt}\n${dockerPrompt}`;
  },

  getProviders(authKind?: 'oauth' | 'apikey'): readonly ProviderConfig[] {
    if (authKind === 'oauth') {
      return [anthropicOAuthProvider, claudePlatformOAuthProvider];
    }
    return [anthropicProvider, claudePlatformProvider];
  },

  buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Record<string, string> {
    const env: Record<string, string> = {
      CLAUDE_CODE_DISABLE_UPDATE_CHECK: '1',
      // Node.js does not use the system CA store -- must set this explicitly
      NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/ironcurtain-ca.crt',
    };

    const fakeKey = fakeKeys.get('api.anthropic.com');
    if (!fakeKey) {
      throw new Error('No fake key generated for api.anthropic.com — cannot configure Claude Code authentication');
    }

    if (config.dockerAuth?.kind === 'oauth') {
      // OAuth mode: pass fake token via Claude Code's native env var.
      // Claude Code reads CLAUDE_CODE_OAUTH_TOKEN as its highest-priority auth.
      env.CLAUDE_CODE_OAUTH_TOKEN = fakeKey;
    } else {
      // API key mode: pass the fake key via a non-Claude env var; apiKeyHelper
      // in settings.json echoes it so Claude Code never prompts for approval.
      env.IRONCURTAIN_API_KEY = fakeKey;
    }

    return env;
  },

  extractResponse(exitCode: number, stdout: string): AgentResponse {
    if (exitCode !== 0) {
      return { text: `Agent exited with code ${exitCode}.\n\nOutput:\n${stdout}` };
    }
    return parseClaudeCodeJson(stdout);
  },

  buildPtyCommand(
    _systemPrompt: string,
    ptySockPath: string | undefined,
    ptyPort: number | undefined,
  ): readonly string[] {
    // The socat listener target depends on platform
    const listenArg = ptySockPath
      ? `UNIX-LISTEN:${ptySockPath},fork` // Linux UDS
      : `TCP-LISTEN:${ptyPort},reuseaddr`; // macOS TCP

    // Interactive mode: claude runs via a wrapper script that reads the system
    // prompt from an env var set by the entrypoint. This avoids shell quoting
    // issues that occur when embedding large prompts in socat EXEC: strings.
    return ['socat', listenArg, 'EXEC:/etc/ironcurtain/start-claude.sh,pty,setsid,ctty,stderr'];
  },
};

/**
 * Parses Claude Code's `--output-format json` response.
 * Falls back to raw stdout when the output is not valid JSON.
 */
function parseClaudeCodeJson(stdout: string): AgentResponse {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && 'result' in parsed) {
      const obj = parsed as Record<string, unknown>;
      const text = typeof obj.result === 'string' ? obj.result : stdout.trim();
      if (typeof obj.total_cost_usd === 'number') {
        return { text, costUsd: obj.total_cost_usd };
      }
      return { text };
    }
  } catch {
    // JSON parse failed -- fall through to raw text
  }
  return { text: stdout.trim() };
}
