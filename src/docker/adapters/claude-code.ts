/**
 * Claude Code agent adapter -- reference implementation.
 *
 * Configures a Docker container running Claude Code CLI with:
 * - MCP server discovery via settings.json (socat bridge to UDS)
 * - System prompt injection via --append-system-prompt
 * - --continue for session resume across turns
 * - --dangerously-skip-permissions (IronCurtain handles security)
 */

import type { AgentAdapter, AgentConfigFile, AgentId, AgentResponse, OrientationContext } from '../agent-adapter.js';
import type { IronCurtainConfig } from '../../config/types.js';
import type { ProviderConfig } from '../provider-config.js';
import { anthropicProvider } from '../provider-config.js';

const CLAUDE_CODE_IMAGE = 'ironcurtain-claude-code:latest';

function buildOrientationPrompt(context: OrientationContext): string {
  const toolList = context.tools.map((t) => `- \`${t.name}\` -- ${t.description ?? 'no description'}`).join('\n');

  return `You are running inside a sandboxed Docker container managed by IronCurtain.

## Environment Constraints

### Workspace (\`${context.workspaceDir}\`)
This is YOUR local workspace inside the container. Use your normal built-in
tools (Bash, Read, Write, Edit, etc.) freely here -- no restrictions.

This directory is a bind-mount of \`${context.hostSandboxDir}\` on the host.
Files you create at \`${context.workspaceDir}/foo.txt\` are visible to MCP tools
at \`${context.hostSandboxDir}/foo.txt\` and vice versa.

### Host Filesystem
To read or modify files on the host operating system you MUST use the MCP
tools listed below. These tools are mediated by IronCurtain's policy engine:
every call is evaluated against security rules and recorded in the audit log.
Your built-in file tools cannot reach the host filesystem.

### Network
The container has NO network access (--network=none). All HTTP requests and
git operations MUST go through the MCP tools below.

Your built-in web search and web fetch tools route through the Anthropic API
and will work, but they bypass IronCurtain's audit log. Prefer the MCP fetch
tool when an auditable record of network access is required.

### Available MCP Tools
${toolList}

### Policy Enforcement
Every MCP tool call is evaluated against security policy rules:
- **Allowed**: proceeds automatically
- **Denied**: blocked -- do NOT retry denied operations
- **Escalated**: requires human approval -- you will receive the result once approved

### Best Practices
1. Use your built-in tools for work inside ${context.workspaceDir}
2. Use MCP tools for anything on the host filesystem or network
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
  generateMcpConfig(socketPath: string): AgentConfigFile[] {
    const mcpConfig = {
      mcpServers: {
        ironcurtain: {
          command: 'socat',
          args: ['STDIO', `UNIX-CONNECT:${socketPath}`],
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
    return buildOrientationPrompt(context);
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
      const costUsd = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined;
      return costUsd !== undefined ? { text, costUsd } : { text };
    }
  } catch {
    // JSON parse failed -- fall through to raw text
  }
  return { text: stdout.trim() };
}
