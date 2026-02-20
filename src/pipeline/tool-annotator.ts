/**
 * Tool Annotator -- LLM-driven classification of MCP tool capabilities.
 *
 * Given a set of MCP tool schemas from a server, the annotator uses an LLM
 * to classify each tool's effect, side effects, and argument roles. A
 * compile-time heuristic validator catches annotation gaps before they
 * reach runtime.
 */

import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { generateObjectWithRepair } from './generate-with-repair.js';
import type { ToolAnnotation } from './types.js';
import { getArgumentRoleValues, getRoleDefinition, ARGUMENT_ROLE_REGISTRY } from '../types/argument-roles.js';

// Input type matching what MCP's listTools() returns
export interface MCPToolSchema {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

const argumentRoleSchema = z.enum(getArgumentRoleValues());

// LLMs sometimes return a bare string instead of a single-element array.
// Accept both formats and normalize to an array.
const rolesArraySchema = z.union([
  z.array(argumentRoleSchema),
  argumentRoleSchema.transform(r => [r]),
]);

function buildAnnotationsResponseSchema(tools: MCPToolSchema[]) {
  const toolNames = tools.map(t => t.name) as [string, ...string[]];

  // Map tool name → expected argument names from input schemas
  const toolArgNames = new Map<string, string[]>();
  for (const t of tools) {
    const props = (t.inputSchema['properties'] ?? {}) as Record<string, unknown>;
    toolArgNames.set(t.name, Object.keys(props));
  }

  const toolAnnotationSchema = z.object({
    toolName: z.enum(toolNames),
    comment: z.string(),
    sideEffects: z.boolean(),
    args: z.record(z.string(), rolesArraySchema),
  });

  return z.object({
    annotations: z.array(toolAnnotationSchema).superRefine((annotations, ctx) => {
      for (let i = 0; i < annotations.length; i++) {
        const a = annotations[i];
        const expectedArgs = toolArgNames.get(a.toolName) ?? [];
        const missingArgs = expectedArgs.filter(name => !(name in a.args));
        if (missingArgs.length > 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'args'],
            message: `Tool "${a.toolName}" is missing role annotations for arguments: ${missingArgs.join(', ')}. Each argument must have a role array (e.g. ["read-path"] or ["none"]).`,
          });
        }
      }
    }),
  });
}

/** Builds role description lines dynamically from the registry for the LLM prompt. */
export function buildRoleDescriptions(): string {
  const lines: string[] = [];
  for (const [role, def] of ARGUMENT_ROLE_REGISTRY) {
    lines.push(`   - "${role}" -- ${def.description}. ${def.annotationGuidance}`);
  }
  return lines.join('\n');
}

export function buildAnnotationPrompt(serverName: string, tools: MCPToolSchema[]): string {
  const toolDescriptions = tools.map(t => {
    return [
      `Tool: ${t.name}`,
      t.description ? `Description: ${t.description}` : '',
      `Input Schema: ${JSON.stringify(t.inputSchema, null, 2)}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n---\n\n');

  return `You are annotating MCP tools for a security policy engine. For each tool on the "${serverName}" server, classify:

1. **comment**: A brief one-sentence description of what the tool does.

2. **sideEffects**: Whether the tool has security-relevant side effects.
   - true if the tool modifies state OR can disclose information from resource paths (information disclosure is a security-relevant side effect)
   - false ONLY if the tool has NO path arguments AND makes no state changes (e.g., a pure configuration query tool)
   - When in doubt, mark as true (conservative)

3. **args**: For each argument in the tool's input schema, assign an ARRAY of one or more roles:
${buildRoleDescriptions()}

   IMPORTANT: Each value in the args object MUST be an ARRAY of roles, even for single roles.
   Example: { "path": ["read-path"], "content": ["none"] }
   NOT: { "path": "read-path", "content": "none" }

   An argument can have MULTIPLE roles. For example, the "source" argument of a move operation has both "read-path" and "delete-path" roles because the source is read and then deleted.

   Only include arguments that appear in the tool's input schema. If the tool has no arguments, use an empty object.

Here is a complete example annotation for a move_file tool that shows multi-role arguments:

{
  "toolName": "move_file",
  "comment": "Moves or renames a file or directory from a source path to a destination path in a single operation.",
  "sideEffects": true,
  "args": {
    "source": ["read-path", "delete-path"],
    "destination": ["write-path"]
  }
}

Here are the tools to annotate:

${toolDescriptions}

Return annotations for ALL ${tools.length} tools. Use the exact tool names as provided.`;
}

export async function annotateTools(
  serverName: string,
  tools: MCPToolSchema[],
  llm: LanguageModel,
  onProgress?: (message: string) => void,
): Promise<ToolAnnotation[]> {
  if (tools.length === 0) return [];

  const schema = buildAnnotationsResponseSchema(tools);
  const prompt = buildAnnotationPrompt(serverName, tools);

  const { output } = await generateObjectWithRepair({
    model: llm,
    schema,
    prompt,
    onProgress,
  });

  const annotations: ToolAnnotation[] = output.annotations.map(a => ({
    ...a,
    serverName,
  }));

  // Validate all input tools are represented in the output
  const annotatedNames = new Set(annotations.map(a => a.toolName));
  const missingTools = tools.filter(t => !annotatedNames.has(t.name));
  if (missingTools.length > 0) {
    const names = missingTools.map(t => t.name).join(', ');
    throw new Error(`Annotation incomplete: missing tools: ${names}`);
  }

  return annotations;
}

// -----------------------------------------------------------------------
// Compile-time heuristic validation
// -----------------------------------------------------------------------

/** Argument names that strongly suggest filesystem path arguments. */
const PATH_INDICATOR_NAMES = ['path', 'file', 'dir', 'directory', 'source', 'destination'];

function looksLikePathArgument(argName: string): boolean {
  const lower = argName.toLowerCase();
  return PATH_INDICATOR_NAMES.some(indicator => lower.includes(indicator));
}

function hasPathLikeValues(schema: Record<string, unknown>): boolean {
  const properties = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return false;

  for (const prop of Object.values(properties)) {
    const defaultVal = prop['default'];
    if (typeof defaultVal === 'string' && (defaultVal.startsWith('/') || defaultVal.startsWith('.'))) {
      return true;
    }
    const examples = prop['examples'];
    if (Array.isArray(examples)) {
      for (const ex of examples) {
        if (typeof ex === 'string' && (ex.startsWith('/') || ex.startsWith('.'))) {
          return true;
        }
      }
    }
  }
  return false;
}

export interface HeuristicValidationResult {
  valid: boolean;
  warnings: string[];
}

export function validateAnnotationsHeuristic(
  tools: MCPToolSchema[],
  annotations: ToolAnnotation[],
): HeuristicValidationResult {
  const annotationsByName = new Map<string, ToolAnnotation>();
  for (const a of annotations) {
    annotationsByName.set(a.toolName, a);
  }

  const warnings: string[] = [];

  for (const tool of tools) {
    const annotation = annotationsByName.get(tool.name);
    if (!annotation) {
      warnings.push(`Tool "${tool.name}" has no annotation`);
      continue;
    }

    const properties = (tool.inputSchema['properties'] ?? {}) as Record<string, Record<string, unknown>>;

    for (const [argName, argSchema] of Object.entries(properties)) {
      if (!looksLikePathArgument(argName)) continue;

      // Skip non-string arguments (booleans, enums, numbers named "directories" etc.)
      const argType = argSchema?.['type'];
      if (argType === 'boolean' || argType === 'number' || argType === 'integer') continue;

      const roles = annotation.args[argName];
      const hasPathRole = roles && roles.some(r => getRoleDefinition(r).isResourceIdentifier);

      if (!hasPathRole) {
        warnings.push(
          `Tool "${tool.name}" argument "${argName}" looks like a path but has no path role in annotation`,
        );
      }
    }

    // Check for path-like default values or examples
    if (hasPathLikeValues(tool.inputSchema)) {
      const hasAnyPathRole = Object.values(annotation.args).some(
        roles => roles.some(r => getRoleDefinition(r).isResourceIdentifier),
      );
      if (!hasAnyPathRole) {
        warnings.push(
          `Tool "${tool.name}" schema has path-like defaults/examples but no path roles in annotation`,
        );
      }
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}
