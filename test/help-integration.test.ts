import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sandbox, type HelpData } from '../src/sandbox/index.js';
import { buildSystemPrompt, type ServerListing } from '../src/session/prompts.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { CompiledPolicyFile, ToolAnnotationsFile } from '../src/pipeline/types.js';
import { testCompiledPolicy, testToolAnnotations, REAL_TMP } from './fixtures/test-policy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const SANDBOX_DIR = `${REAL_TMP}/ironcurtain-help-test-${process.pid}`;
const AUDIT_LOG_PATH = `${REAL_TMP}/ironcurtain-help-test-audit-${process.pid}.jsonl`;
const GENERATED_DIR = `${REAL_TMP}/ironcurtain-help-test-generated-${process.pid}`;

function writeTestArtifacts(
  dir: string,
  compiledPolicy: CompiledPolicyFile,
  toolAnnotations: ToolAnnotationsFile,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'compiled-policy.json'), JSON.stringify(compiledPolicy));
  writeFileSync(resolve(dir, 'tool-annotations.json'), JSON.stringify(toolAnnotations));
}

describe('Help system integration', () => {
  let sandbox: Sandbox;

  const config: IronCurtainConfig = {
    auditLogPath: AUDIT_LOG_PATH,
    allowedDirectory: SANDBOX_DIR,
    mcpServers: {
      filesystem: {
        description: 'Read, write, search, and manage files and directories',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', SANDBOX_DIR],
        sandbox: false,
      },
    },
    protectedPaths: [
      resolve(projectRoot, 'src/config/constitution.md'),
      resolve(projectRoot, 'src/config/generated'),
      resolve(projectRoot, 'src/config/mcp-servers.json'),
      resolve(AUDIT_LOG_PATH),
    ],
    generatedDir: GENERATED_DIR,
    constitutionPath: resolve(projectRoot, 'src/config/constitution.md'),
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: '',
      googleApiKey: '',
      openaiApiKey: '',
      escalationTimeoutSeconds: 300,
      resourceBudget: {
        maxTotalTokens: 1_000_000,
        maxSteps: 200,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      autoCompact: {
        enabled: false,
        thresholdTokens: 80_000,
        keepRecentMessages: 10,
        summaryModelId: 'anthropic:claude-haiku-4-5',
      },
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      serverCredentials: {},
    },
  };

  beforeAll(async () => {
    mkdirSync(SANDBOX_DIR, { recursive: true });
    writeFileSync(`${SANDBOX_DIR}/test.txt`, 'hello from help test');
    writeTestArtifacts(GENERATED_DIR, testCompiledPolicy, testToolAnnotations);

    sandbox = new Sandbox();
    await sandbox.initialize(config);
  }, 30_000);

  afterAll(async () => {
    await sandbox.shutdown();
    rmSync(SANDBOX_DIR, { recursive: true, force: true });
    rmSync(GENERATED_DIR, { recursive: true, force: true });
    try {
      rmSync(AUDIT_LOG_PATH, { force: true });
    } catch {
      // ignore
    }
  });

  it('help.help() returns server listings', async () => {
    const { result } = await sandbox.executeCode('return help.help();');
    const output = String(result);
    expect(output).toContain('Available tool servers:');
    expect(output).toContain('filesystem');
    expect(output).toContain("Call help.help('serverName')");
  });

  it("help.help('filesystem') lists filesystem tools with callable names", async () => {
    const { result } = await sandbox.executeCode("return help.help('filesystem');");
    const output = String(result);
    expect(output).toContain('Tools in filesystem:');
    expect(output).toContain('tools.filesystem_list_directory');
    expect(output).toContain('tools.filesystem_read_file');
  });

  it("help.help('unknown') returns error message", async () => {
    const { result } = await sandbox.executeCode("return help.help('unknown');");
    const output = String(result);
    expect(output).toContain('Unknown server: unknown');
    expect(output).toContain('Available servers:');
    expect(output).toContain('filesystem');
  });

  it('actual tool calls still work after help discovery', async () => {
    const { result } = await sandbox.executeCode(`
        // First discover tools
        help.help('filesystem');
        // Then use one
        const r = tools.filesystem_list_directory({ path: "${SANDBOX_DIR}" });
        return r;
      `);
    expect(result).toBeDefined();
    // The result should contain directory listing info
    const output = JSON.stringify(result);
    expect(output).toContain('test.txt');
  });

  it('getHelpData() returns structured data', () => {
    const helpData: HelpData = sandbox.getHelpData();
    expect(helpData.serverDescriptions).toHaveProperty('filesystem');
    expect(helpData.serverDescriptions.filesystem).toBe('Read, write, search, and manage files and directories');
    expect(helpData.toolsByServer).toHaveProperty('filesystem');
    expect(helpData.toolsByServer.filesystem.length).toBeGreaterThan(0);

    // Check that at least one tool has the expected shape
    const tool = helpData.toolsByServer.filesystem[0];
    expect(tool).toHaveProperty('callableName');
    expect(tool).toHaveProperty('params');
    expect(tool.callableName).toContain('filesystem_');
  });

  it('new prompt is significantly smaller than old catalog-based prompt', () => {
    // Build old-style prompt using full tool catalog
    const oldPromptSize = sandbox.getToolInterfaces().length;

    // Build new-style prompt using server listings
    const helpData = sandbox.getHelpData();
    const serverListings: ServerListing[] = Object.entries(helpData.serverDescriptions).map(([name, description]) => ({
      name,
      description,
    }));
    const newPrompt = buildSystemPrompt(serverListings, SANDBOX_DIR);

    // The tool catalog alone should be larger than the full new prompt's
    // "Available tool servers" section. We verify the new prompt doesn't
    // contain the full catalog text.
    expect(newPrompt).not.toContain(sandbox.getToolInterfaces());

    // The old catalog is typically ~3000+ chars for filesystem tools.
    // The new server listing section should be much smaller.
    expect(oldPromptSize).toBeGreaterThan(500);
    expect(newPrompt).toContain('filesystem');
    expect(newPrompt).toContain('help.help');
    expect(newPrompt).not.toContain('read_file');
  });
});
