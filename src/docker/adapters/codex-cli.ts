/**
 * Codex CLI agent adapter.
 *
 * Runs Codex CLI inside the same Docker-mediated path as other external
 * agents. Repository reads/writes happen inside /workspace; network and MCP
 * access continue to flow through IronCurtain host-side proxies.
 */

import type { AgentAdapter, AgentConfigFile, AgentId, AgentResponse, OrientationContext } from '../agent-adapter.js';
import { openaiProvider, type ProviderConfig } from '../provider-config.js';
import type { IronCurtainConfig } from '../../config/types.js';
import type { ResolvedUserConfig } from '../../config/user-config.js';
import { parseModelId } from '../../config/model-provider.js';
import { parseCliLlmModelId } from '../../llm/model-spec.js';
import { buildSystemPrompt } from '../../session/prompts.js';
import { buildAttributionSection, buildNetworkSection, buildPolicySection } from './shared-scripts.js';
import type { AuthMethod } from '../oauth-credentials.js';

const CODEX_CLI_IMAGE = 'ironcurtain-codex-cli:latest';

function resolveCodexModel(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  const cliSpec = parseCliLlmModelId(modelId);
  if (cliSpec) return cliSpec.modelId;
  return parseModelId(modelId).modelId;
}

function buildDockerEnvironmentPrompt(context: OrientationContext): string {
  return `## Docker Environment

### Workspace (\`${context.workspaceDir}\`)
Use your normal local tools for files under \`${context.workspaceDir}\`.

### IronCurtain MCP Access
Use MCP tools only for capabilities that need IronCurtain mediation:
- Network requests, searches, or API calls
- Git remote operations
- Reading files outside \`${context.workspaceDir}\`

For repository analysis, scanning, tests, validation fixtures, and patches,
work inside \`${context.workspaceDir}\`.

${buildNetworkSection('the configured IronCurtain MCP server')}

${buildPolicySection('MCP tool call')}

${buildAttributionSection()}
`;
}

export function createCodexCliAdapter(userConfig?: ResolvedUserConfig): AgentAdapter {
  const configuredModel = resolveCodexModel(userConfig?.agentModelId);

  return {
    id: 'codex-cli' as AgentId,
    displayName: 'Codex CLI',

    // eslint-disable-next-line @typescript-eslint/require-await -- interface requires Promise return
    async getImage(): Promise<string> {
      return CODEX_CLI_IMAGE;
    },

    generateMcpConfig(socketPath: string): AgentConfigFile[] {
      const isTcp = socketPath.includes(':');
      const socatArgs = isTcp ? ['STDIO', `TCP:${socketPath}`] : ['STDIO', `UNIX-CONNECT:${socketPath}`];
      const quotedArgs = socatArgs.map((arg) => JSON.stringify(arg)).join(', ');
      const config = ['[mcp_servers.ironcurtain]', 'command = "socat"', `args = [${quotedArgs}]`, ''].join('\n');
      return [{ path: 'codex-config.toml', content: config }];
    },

    generateOrientationFiles(): AgentConfigFile[] {
      return [];
    },

    buildCommand(
      message: string,
      systemPrompt: string,
      options: {
        readonly sessionId: string;
        readonly firstTurn: boolean;
        readonly modelOverride?: string;
      },
    ): readonly string[] {
      const cmd = ['codex', 'exec', '--json'];
      const effectiveModel = resolveCodexModel(options.modelOverride) ?? configuredModel;
      if (effectiveModel) {
        cmd.push('--model', effectiveModel);
      }
      const fullPrompt = `System instructions:\n${systemPrompt}\n\nUser task:\n${message}`;
      cmd.push(fullPrompt);
      return cmd;
    },

    buildSystemPrompt(context: OrientationContext): string {
      const codeModePrompt = buildSystemPrompt(context.serverListings, context.hostSandboxDir);
      return `${codeModePrompt}\n${buildDockerEnvironmentPrompt(context)}`;
    },

    getProviders(): readonly ProviderConfig[] {
      return [openaiProvider];
    },

    buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Readonly<Record<string, string>> {
      const fakeKey = fakeKeys.get('api.openai.com');
      if (!fakeKey) {
        throw new Error('No fake key generated for api.openai.com -- cannot configure Codex CLI authentication');
      }
      return {
        OPENAI_API_KEY: fakeKey,
        NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/ironcurtain-ca.crt',
      };
    },

    detectCredential(config: IronCurtainConfig): AuthMethod {
      const key = process.env.OPENAI_API_KEY || config.userConfig.openaiApiKey;
      return key ? { kind: 'apikey', key } : { kind: 'none' };
    },

    credentialHelpText:
      'Codex CLI Docker sessions require OPENAI_API_KEY (or openaiApiKey in ~/.ironcurtain/config.json).',

    extractResponse(exitCode: number, stdout: string): AgentResponse {
      const text = parseCodexOutput(stdout);
      if (exitCode !== 0) {
        return {
          text: `Agent exited with code ${exitCode}.\n\nOutput:\n${stdout}`,
          hardFailure: stdout.trim().length === 0,
        };
      }
      return { text };
    },
  };
}

function parseCodexOutput(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';

  const parsed = tryParseJson(trimmed);
  const direct = parsed ? extractText(parsed) : undefined;
  if (direct) return direct;

  const lines = trimmed.split(/\r?\n/);
  const texts = lines
    .map((line) => tryParseJson(line))
    .map((value) => (value ? extractText(value) : undefined))
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (texts.length > 0) return texts[texts.length - 1];

  return trimmed;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['result', 'text', 'message', 'output']) {
    const candidate = record[key];
    if (typeof candidate === 'string') return candidate;
  }
  const item = record.item;
  if (item && typeof item === 'object') {
    const itemText = extractText(item);
    if (itemText) return itemText;
  }
  return undefined;
}
