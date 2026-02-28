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
import { anthropicProvider } from '../provider-config.js';
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
    // Orientation is delivered via --append-system-prompt, not files
    return [];
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

  getProviders(): readonly ProviderConfig[] {
    return [anthropicProvider];
  },

  buildEnv(_config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Record<string, string> {
    return {
      ANTHROPIC_API_KEY: fakeKeys.get('api.anthropic.com') ?? '',
      CLAUDE_CODE_DISABLE_UPDATE_CHECK: '1',
      // Node.js does not use the system CA store -- must set this explicitly
      NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/ironcurtain-ca.crt',
    };
  },

  extractResponse(exitCode: number, stdout: string): AgentResponse {
    if (exitCode !== 0) {
      return { text: `Agent exited with code ${exitCode}.\n\nOutput:\n${stdout}` };
    }
    return parseClaudeCodeJson(stdout);
  },

  buildPtyCommand(
    _message: string,
    _systemPrompt: string,
    ptySockPath: string | undefined,
    ptyPort: number | undefined,
  ): readonly string[] {
    // The socat listener target depends on platform
    const listenArg = ptySockPath
      ? `UNIX-LISTEN:${ptySockPath},fork` // Linux UDS
      : `TCP-LISTEN:${ptyPort},reuseaddr`; // macOS TCP

    // message and systemPrompt are written to files in the orientation dir
    // by the PTY session module before container start -- not embedded in shell strings
    return [
      'socat',
      listenArg,
      'EXEC:claude --dangerously-skip-permissions' +
        ' --mcp-config /etc/ironcurtain/claude-mcp-config.json' +
        ' --append-system-prompt-file /etc/ironcurtain/system-prompt.txt' +
        ' -p-file /etc/ironcurtain/initial-message.txt' +
        ',pty,setsid,ctty,stderr',
    ];
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
