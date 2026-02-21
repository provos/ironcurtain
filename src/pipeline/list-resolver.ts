/**
 * List Resolver -- LLM-driven resolution of dynamic list definitions
 * into concrete values.
 *
 * For knowledge-based lists (requiresMcp: false): sends the generation
 * prompt (with format guidance appended) to the LLM and parses the
 * structured response.
 *
 * For data-backed lists (requiresMcp: true): gives the LLM access to
 * MCP tools (via tool-use) so it can query live data sources, then
 * parses the final text response for the structured list values.
 *
 * Applies type-specific validation to filter malformed values.
 * Preserves manual overrides from any existing resolution.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { LanguageModel, ToolSet } from 'ai';
import { generateText, jsonSchema, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { generateObjectWithRepair } from './generate-with-repair.js';
import { LIST_TYPE_REGISTRY } from './dynamic-list-types.js';
import { computeHash } from './pipeline-shared.js';
import type { ListDefinition, ResolvedList, DynamicListsFile } from './types.js';

/**
 * Shape of a pre-connected MCP server with its discovered tools.
 * Matches the ServerConnection pattern from annotate.ts.
 */
export interface McpServerConnection {
  readonly client: Client;
  readonly tools: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
}

export interface ListResolverConfig {
  readonly model: LanguageModel;

  /**
   * Optional pre-connected MCP clients for data-backed list resolution.
   * Keyed by server name. When undefined, lists with requiresMcp: true
   * fail with a descriptive error.
   */
  readonly mcpConnections?: ReadonlyMap<string, McpServerConnection>;
}

const listResponseSchema = z.object({
  values: z.array(z.string()).describe('The list of resolved values'),
});

/**
 * Builds the prompt sent to the LLM for list resolution.
 * Combines the definition's generationPrompt with type-specific format guidance.
 */
function buildResolutionPrompt(definition: ListDefinition): string {
  const typeDef = LIST_TYPE_REGISTRY.get(definition.type);
  const formatGuidance = typeDef?.formatGuidance ?? '';
  return `${definition.generationPrompt}\n\n${formatGuidance}`;
}

/**
 * Computes the content hash for a list definition.
 * Used to determine whether a cached resolution is still valid.
 */
function computeListHash(definition: ListDefinition): string {
  const prompt = buildResolutionPrompt(definition);
  return computeHash(
    definition.name,
    definition.type,
    definition.generationPrompt,
    String(definition.requiresMcp),
    prompt,
  );
}

/**
 * Applies type-specific validation to filter malformed values,
 * deduplicates, and applies manual overrides.
 */
function postProcess(rawValues: string[], definition: ListDefinition, existing?: ResolvedList): string[] {
  const typeDef = LIST_TYPE_REGISTRY.get(definition.type);
  const validate = typeDef?.validate ?? (() => true);

  // Filter invalid values and deduplicate
  const validValues = [
    ...new Set(
      rawValues.filter((v) => {
        const isValid = validate(v);
        if (!isValid) {
          console.error(`  Warning: Dropped invalid ${definition.type} value "${v}" from @${definition.name}`);
        }
        return isValid;
      }),
    ),
  ];

  // Apply manual overrides from existing resolution
  const manualAdditions = existing?.manualAdditions ?? [];
  const removals = new Set(existing?.manualRemovals ?? []);
  return [...new Set([...validValues, ...manualAdditions])].filter((v) => !removals.has(v));
}

/**
 * Resolves a knowledge-based list using structured LLM output.
 * No tool access -- the LLM answers from its training data.
 */
async function resolveViaLlm(
  prompt: string,
  model: LanguageModel,
  onProgress?: (message: string) => void,
): Promise<string[]> {
  const { output } = await generateObjectWithRepair({
    model,
    schema: listResponseSchema,
    prompt,
    onProgress,
  });
  return output.values;
}

/** Maximum tool-use steps for MCP-backed resolution. */
const MAX_MCP_TOOL_STEPS = 5;

/**
 * Bridges MCP server tools as AI SDK tools with execute functions
 * that forward calls to the MCP client.
 */
function bridgeMcpTools(serverName: string, connection: McpServerConnection): ToolSet {
  const tools: ToolSet = {};
  for (const mcpTool of connection.tools) {
    const qualifiedName = `${serverName}__${mcpTool.name}`;
    // Ensure the input schema has "type": "object" (some MCP servers omit it)
    const schema = { type: 'object' as const, ...mcpTool.inputSchema };

    tools[qualifiedName] = tool({
      description: mcpTool.description ?? `Tool: ${mcpTool.name}`,
      inputSchema: jsonSchema(schema),
      execute: async (args: unknown) => {
        const result = await connection.client.callTool({
          name: mcpTool.name,
          arguments: args as Record<string, unknown>,
        });
        // Return the text content from the MCP result
        if (Array.isArray(result.content)) {
          return result.content
            .filter((c: { type: string }) => c.type === 'text')
            .map((c: { text: string }) => c.text)
            .join('\n');
        }
        return JSON.stringify(result.content);
      },
    });
  }
  return tools;
}

/**
 * Selects which MCP connection to use for a definition.
 * Prefers mcpServerHint if it matches a connected server; otherwise
 * uses the first available connection.
 */
function selectMcpConnection(
  definition: ListDefinition,
  connections: ReadonlyMap<string, McpServerConnection>,
): { serverName: string; connection: McpServerConnection } | undefined {
  if (definition.mcpServerHint) {
    const connection = connections.get(definition.mcpServerHint);
    if (connection) return { serverName: definition.mcpServerHint, connection };
  }
  // Fall back to first available connection
  const first = connections.entries().next();
  if (!first.done) {
    return { serverName: first.value[0], connection: first.value[1] };
  }
  return undefined;
}

/**
 * Resolves a data-backed list by giving the LLM access to MCP tools.
 * Uses generateText with tool-use, then parses the final text for values.
 */
async function resolveViaMcpTools(
  prompt: string,
  model: LanguageModel,
  mcpTools: ToolSet,
  onProgress?: (message: string) => void,
): Promise<string[]> {
  onProgress?.('Querying MCP tools...');

  const result = await generateText({
    model,
    tools: mcpTools,
    stopWhen: [stepCountIs(MAX_MCP_TOOL_STEPS)],
    prompt: `${prompt}\n\nUse the available tools to query the data source, then provide your final answer as a JSON object with a "values" array containing the list items. Example: {"values": ["item1", "item2"]}`,
    maxOutputTokens: 8192,
  });

  // Parse the final text output for the structured list
  const parsed = parseValuesFromText(result.text);
  if (parsed.length > 0) return parsed;

  // If parsing failed, return empty with a warning
  console.error(`  Warning: Could not parse list values from MCP-backed resolution text`);
  return [];
}

/** Safely extracts string[] from a value that may be an array. */
function extractStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((v: unknown) => typeof v === 'string');
  }
  return undefined;
}

/** Tries to parse JSON from text, returning undefined on failure. */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Extracts a values array from LLM text output.
 * Tries a JSON object with a "values" key first, then a bare JSON array.
 */
function parseValuesFromText(text: string): string[] {
  // Try to find and parse a JSON object with a "values" array
  const jsonMatch = text.match(/\{[\s\S]*"values"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/);
  if (jsonMatch) {
    const parsed = tryParseJson(jsonMatch[0]);
    const values = extractStringArray((parsed as { values?: unknown })?.values);
    if (values) return values;
  }

  // Try parsing the entire text as a JSON array
  const values = extractStringArray(tryParseJson(text));
  if (values) return values;

  return [];
}

/**
 * Resolves a single list definition to concrete values.
 *
 * For knowledge-based lists: uses structured LLM output.
 * For data-backed lists: gives the LLM MCP tools, then parses the result.
 *
 * Applies type-specific validation to filter malformed values.
 * Preserves manual overrides from any existing resolution.
 */
export async function resolveList(
  definition: ListDefinition,
  config: ListResolverConfig,
  existing?: ResolvedList,
  onProgress?: (message: string) => void,
): Promise<ResolvedList> {
  onProgress?.(`Resolving @${definition.name}...`);

  const prompt = buildResolutionPrompt(definition);
  let rawValues: string[];

  if (definition.requiresMcp) {
    const selected = config.mcpConnections ? selectMcpConnection(definition, config.mcpConnections) : undefined;

    if (!selected) {
      throw new Error(
        `List "@${definition.name}" requires MCP server access (requiresMcp: true) ` +
          `but no MCP clients are available. Run with --with-mcp or ensure the ` +
          `"${definition.mcpServerHint ?? 'required'}" MCP server is configured and reachable.`,
      );
    }

    const mcpTools = bridgeMcpTools(selected.serverName, selected.connection);
    rawValues = await resolveViaMcpTools(prompt, config.model, mcpTools, onProgress);
  } else {
    rawValues = await resolveViaLlm(prompt, config.model, onProgress);
  }

  const effectiveValues = postProcess(rawValues, definition, existing);
  const inputHash = computeListHash(definition);

  return {
    values: effectiveValues,
    manualAdditions: existing?.manualAdditions ?? [],
    manualRemovals: existing?.manualRemovals ?? [],
    resolvedAt: new Date().toISOString(),
    inputHash,
  };
}

/**
 * Resolves all list definitions, respecting content-hash caching.
 * Skips resolution for lists whose inputs haven't changed and whose
 * existing resolution is still valid.
 *
 * When bypassCache is true, always re-resolves regardless of hash match.
 * Used by the refresh-lists command to force fresh data.
 */
export async function resolveAllLists(
  definitions: ListDefinition[],
  config: ListResolverConfig,
  existingLists?: DynamicListsFile,
  onProgress?: (message: string) => void,
  bypassCache?: boolean,
): Promise<DynamicListsFile> {
  const lists: Record<string, ResolvedList> = {};

  for (const definition of definitions) {
    const existing = existingLists?.lists[definition.name];
    const expectedHash = computeListHash(definition);

    // Cache hit: skip resolution if inputs haven't changed (unless bypassed)
    if (!bypassCache && existing && existing.inputHash === expectedHash) {
      onProgress?.(`@${definition.name} (cached)`);
      lists[definition.name] = existing;
      continue;
    }

    lists[definition.name] = await resolveList(definition, config, existing, onProgress);
  }

  return {
    generatedAt: new Date().toISOString(),
    lists,
  };
}
