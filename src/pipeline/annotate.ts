/**
 * CLI entry point for `ironcurtain annotate-tools`.
 *
 * Connects to MCP servers, classifies tool arguments via LLM, and writes
 * the tool-annotations.json artifact. This is a developer task that only
 * needs to run when MCP servers, their tools, or the argument role
 * registry change.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LanguageModel } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import chalk from 'chalk';
import type { MCPServerConfig } from '../config/types.js';
import {
  computeHash,
  createPipelineLlm,
  loadExistingArtifact,
  loadPipelineConfig,
  showCached,
  writeArtifact,
  withSpinner,
} from './pipeline-shared.js';
import { annotateTools, buildAnnotationPrompt, validateAnnotationsHeuristic } from './tool-annotator.js';
import type { ToolAnnotation, ToolAnnotationsFile } from './types.js';

// ---------------------------------------------------------------------------
// MCP Server Connection & Tool Discovery
// ---------------------------------------------------------------------------

interface ServerConnection {
  client: Client;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
}

async function connectAndDiscoverTools(
  mcpServers: Record<string, MCPServerConfig>,
): Promise<Map<string, ServerConnection>> {
  const { result } = await withSpinner(
    '[1/2] Connecting to MCP servers',
    async (spinner) => {
      const connections = new Map<string, ServerConnection>();
      let totalTools = 0;

      for (const [serverName, config] of Object.entries(mcpServers)) {
        spinner.text = `[1/2] Connecting to MCP server: ${serverName}...`;
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env
            ? { ...(process.env as Record<string, string>), ...config.env }
            : undefined,
          stderr: 'pipe',
        });
        // Drain piped stderr to prevent backpressure (logs are discarded)
        if (transport.stderr) {
          transport.stderr.on('data', () => {});
        }
        const client = new Client({ name: 'ironcurtain-annotator', version: '0.1.0' });
        await client.connect(transport);

        const toolsResult = await client.listTools();
        totalTools += toolsResult.tools.length;

        connections.set(serverName, { client, tools: toolsResult.tools });
      }
      return { connections, totalTools };
    },
    (r, elapsed) => `[1/2] Found ${r.totalTools} tools (${elapsed.toFixed(1)}s)`,
  );

  return result.connections;
}

// ---------------------------------------------------------------------------
// Tool Annotation (LLM step -- cacheable per server + tool schemas)
// ---------------------------------------------------------------------------

interface AnnotationResult {
  annotations: ToolAnnotation[];
  inputHash: string;
}

function computeAnnotationHash(
  serverName: string,
  tools: ServerConnection['tools'],
): string {
  return computeHash(serverName, JSON.stringify(tools), buildAnnotationPrompt(serverName, tools));
}

async function annotateServerTools(
  serverName: string,
  tools: ServerConnection['tools'],
  existingAnnotations: ToolAnnotationsFile | undefined,
  llm: LanguageModel,
): Promise<AnnotationResult> {
  const inputHash = computeAnnotationHash(serverName, tools);
  const stepText = `[2/2] Annotating tools for ${serverName}`;

  // Check cache: skip LLM call if inputs haven't changed
  const cached = existingAnnotations?.servers[serverName];
  if (cached && cached.inputHash === inputHash) {
    showCached(stepText);
    return { annotations: cached.tools, inputHash };
  }

  const { result } = await withSpinner(
    stepText,
    async (spinner) => {
      const annotations = await annotateTools(serverName, tools, llm,
        (msg) => { spinner.text = `${stepText} — ${msg}`; },
      );

      const validation = validateAnnotationsHeuristic(tools, annotations);
      if (!validation.valid) {
        for (const w of validation.warnings) {
          spinner.text = `${stepText} — WARNING: ${w}`;
        }
      }
      return annotations;
    },
    (annotations, elapsed) =>
      `${stepText}: ${annotations.length} tools annotated (${elapsed.toFixed(1)}s)`,
  );

  return { annotations: result, inputHash };
}

// ---------------------------------------------------------------------------
// Artifact Construction & Output
// ---------------------------------------------------------------------------

function buildAnnotationsArtifact(
  annotationResults: Map<string, AnnotationResult>,
): ToolAnnotationsFile {
  const servers: ToolAnnotationsFile['servers'] = {};
  for (const [serverName, result] of annotationResults) {
    servers[serverName] = {
      inputHash: result.inputHash,
      tools: result.annotations,
    };
  }
  return { generatedAt: new Date().toISOString(), servers };
}

// ---------------------------------------------------------------------------
// MCP Client Cleanup
// ---------------------------------------------------------------------------

async function disconnectAll(connections: Map<string, ServerConnection>): Promise<void> {
  for (const conn of connections.values()) {
    try {
      await conn.client.close();
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  // The pipeline only lists tools — it never reads/writes through MCP servers.
  // Set a valid ALLOWED_DIRECTORY so the filesystem server can start.
  if (!process.env.ALLOWED_DIRECTORY) {
    process.env.ALLOWED_DIRECTORY = process.cwd();
  }
  const config = loadPipelineConfig();

  console.error(chalk.bold('Tool Annotation Pipeline'));
  console.error(chalk.bold('========================'));
  console.error(`Output: ${chalk.dim(config.generatedDir + '/')}`);
  console.error('');

  const { model: llm, logContext, logPath } = await createPipelineLlm(
    config.generatedDir, 'annotate',
  );

  const connections = await connectAndDiscoverTools(config.mcpServers);

  try {
    const existingAnnotations = loadExistingArtifact<ToolAnnotationsFile>(
      config.generatedDir, 'tool-annotations.json', config.packageGeneratedDir,
    );

    const annotationResults = new Map<string, AnnotationResult>();
    for (const [serverName, conn] of connections) {
      logContext.stepName = `annotate-${serverName}`;
      const result = await annotateServerTools(serverName, conn.tools, existingAnnotations, llm);
      annotationResults.set(serverName, result);
    }

    const toolAnnotationsFile = buildAnnotationsArtifact(annotationResults);
    writeArtifact(config.generatedDir, 'tool-annotations.json', toolAnnotationsFile);

    const totalTools = [...annotationResults.values()]
      .reduce((sum, r) => sum + r.annotations.length, 0);
    console.error('');
    console.error(`  Tools annotated: ${totalTools}`);
    console.error(`  Artifact written to: ${chalk.dim(config.generatedDir + '/tool-annotations.json')}`);
    console.error(`  LLM interaction log: ${chalk.dim(logPath)}`);
    console.error('');
    console.error(chalk.green.bold('Tool annotation successful!'));
  } finally {
    await disconnectAll(connections);
  }
}

// Only run when executed directly (not when imported by cli.ts)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await import('dotenv/config');
  main().catch((err) => {
    console.error(chalk.red.bold('Tool annotation failed:'), err);
    process.exit(1);
  });
}
