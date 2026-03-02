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

### When to use \`execute_code\` (MCP tools)
Use \`execute_code\` ONLY for operations that your built-in tools cannot do:
- **Network requests**: HTTP fetches, web searches, API calls
- **Git remote operations**: clone, push, pull, fetch
- **Reading files outside ${context.workspaceDir}**

For everything else -- listing, reading, searching, writing, and editing files
inside ${context.workspaceDir} -- use your built-in tools (Bash, Read, Write,
Edit, Glob, Grep, etc.). Do NOT use MCP filesystem or git tools for local file
operations inside ${context.workspaceDir}.

After cloning a repo or writing files via \`execute_code\`, switch to built-in
tools for all subsequent file operations on the cloned/written files.
When cloning repos, use ${context.workspaceDir} as the target directory
(e.g. \`${context.workspaceDir}/repo-name\`).

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
    // If Claude hasn't started yet, we exit silently — start-claude.sh sets
    // the initial size from env vars, so no fallback is needed.
    // Diagnostic output goes to stderr (captured by host-side logger).
    const resizeScript = `#!/bin/bash
# Called from the host via: docker exec <cid> /etc/ironcurtain/resize-pty.sh <cols> <rows>
COLS=$1
ROWS=$2

CLAUDE_PID=$(pgrep -x claude | head -1)
if [ -z "$CLAUDE_PID" ]; then
  echo "no-claude" >&2
  exit 0
fi

PTS=$(readlink /proc/$CLAUDE_PID/fd/0 2>/dev/null)
if [ -z "$PTS" ] || ! [ -e "$PTS" ]; then
  echo "no-pty pid=$CLAUDE_PID pts=$PTS" >&2
  exit 0
fi

stty -F "$PTS" cols "$COLS" rows "$ROWS" 2>/dev/null
RC=$?
kill -WINCH "$CLAUDE_PID" 2>/dev/null
echo "ok pid=$CLAUDE_PID pts=$PTS stty=$RC \${COLS}x\${ROWS}" >&2
`;

    // Helper script to report the current PTY size for host-side verification.
    const checkSizeScript = `#!/bin/bash
# Returns "rows cols" of the container PTY
CLAUDE_PID=$(pgrep -x claude | head -1)
if [ -z "$CLAUDE_PID" ]; then echo "0 0"; exit 0; fi
PTS=$(readlink /proc/$CLAUDE_PID/fd/0 2>/dev/null)
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
