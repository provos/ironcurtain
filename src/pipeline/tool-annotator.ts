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
import {
  ARGUMENT_ROLE_REGISTRY,
  extractDefaultRoles,
  getRoleDefinition,
  getRolesForServer,
  isConditionalRoles,
  type ArgumentRole,
} from '../types/argument-roles.js';
import { generateObjectWithRepair } from './generate-with-repair.js';
import type { StoredToolAnnotation } from './types.js';

/** Default number of tools per LLM call. */
export const ANNOTATION_BATCH_SIZE = 25;

/**
 * Splits an array into chunks of at most `size` elements.
 * Returns the original array (wrapped) if it fits in one chunk.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  if (items.length <= size) return [items];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

// Input type matching what MCP's listTools() returns
export interface MCPToolSchema {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

function buildAnnotationsResponseSchema(serverName: string, tools: MCPToolSchema[]) {
  const toolNames = tools.map((t) => t.name) as [string, ...string[]];

  // Build a per-server role enum so the schema rejects irrelevant roles
  const roleValues = getRolesForServer(serverName).map(([role]) => role) as [ArgumentRole, ...ArgumentRole[]];
  const argumentRoleSchema = z.enum(roleValues);

  // LLMs sometimes return a bare string instead of a single-element array.
  // Accept both formats and normalize to an array.
  const rolesArraySchema = z.union([z.array(argumentRoleSchema), argumentRoleSchema.transform((r) => [r])]);

  // Conditional role schemas: a condition on a sibling argument's value
  const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);
  const conditionSchema = z
    .object({
      arg: z.string(),
      equals: scalarSchema.optional(),
      in: z.array(scalarSchema).optional(),
      is: z.enum(['present', 'absent', 'truthy', 'falsy']).optional(),
    })
    .refine(
      (c) => {
        const count = [c.equals !== undefined, c.in !== undefined, c.is !== undefined].filter(Boolean).length;
        return count === 1;
      },
      { message: 'Exactly one of equals, in, or is must be set' },
    );

  const conditionalEntrySchema = z.object({
    condition: conditionSchema,
    roles: rolesArraySchema,
  });

  const conditionalRolesSchema = z
    .object({
      default: rolesArraySchema,
      when: z.array(conditionalEntrySchema),
    })
    .refine(
      (spec) => {
        const defaultSet = new Set(spec.default);
        return spec.when.every((entry) => entry.roles.every((role) => defaultSet.has(role)));
      },
      { message: 'Conditional roles must be a subset of the default roles' },
    );

  // An argument's roles: either a static array or a conditional block
  const argumentRoleSpecSchema = z.union([rolesArraySchema, conditionalRolesSchema]);

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
    args: z.record(z.string(), argumentRoleSpecSchema),
  });

  return z.object({
    annotations: z.array(toolAnnotationSchema).superRefine((annotations, ctx) => {
      for (let i = 0; i < annotations.length; i++) {
        const a = annotations[i];
        const expectedArgs = toolArgNames.get(a.toolName) ?? [];
        const missingArgs = expectedArgs.filter((name) => !(name in a.args));
        if (missingArgs.length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: [i, 'args'],
            message: `Tool "${a.toolName}" is missing role annotations for arguments: ${missingArgs.join(', ')}. Each argument must have a role array (e.g. ["read-path"] or ["none"]).`,
          });
        }

        // Cross-argument validation: conditional role conditions must reference
        // sibling argument names that exist in the same tool's annotation
        for (const [argName, spec] of Object.entries(a.args)) {
          if (isConditionalRoles(spec)) {
            for (const entry of spec.when) {
              const condArg = entry.condition.arg;
              if (!(condArg in a.args)) {
                ctx.addIssue({
                  code: 'custom',
                  path: [i, 'args', argName],
                  message:
                    `Conditional role on "${argName}" references unknown argument "${condArg}". ` +
                    `The condition argument must be another argument in the same tool's input schema.`,
                });
              }
            }
          }
        }
      }
    }),
  });
}

/** Builds role description lines dynamically from the registry for the LLM prompt. */
export function buildRoleDescriptions(serverName?: string): string {
  const entries = serverName ? getRolesForServer(serverName) : [...ARGUMENT_ROLE_REGISTRY.entries()];
  const lines: string[] = [];
  for (const [role, def] of entries) {
    lines.push(`   - "${role}" -- ${def.description}. ${def.annotationGuidance}`);
  }
  return lines.join('\n');
}

export function buildAnnotationPrompt(serverName: string, tools: MCPToolSchema[]): string {
  const toolDescriptions = tools
    .map((t) => {
      return [
        `Tool: ${t.name}`,
        t.description ? `Description: ${t.description}` : '',
        `Input Schema: ${JSON.stringify(t.inputSchema, null, 2)}`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n---\n\n');

  return `You are annotating MCP tools for a security policy engine. For each tool on the "${serverName}" server, classify:

1. **comment**: A brief one-sentence description of what the tool does.

2. **sideEffects**: Whether the tool has security-relevant side effects.
   - true if the tool modifies state OR can disclose information from resource paths (information disclosure is a security-relevant side effect)
   - false ONLY if the tool has NO path arguments AND makes no state changes (e.g., a pure configuration query tool)
   - When in doubt, mark as true (conservative)

3. **args**: For each argument in the tool's input schema, assign an ARRAY of one or more roles:
${buildRoleDescriptions(serverName)}

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

## Conditional Roles

When a tool has a mode/operation argument that changes its behavior, use
conditional role assignment instead of assigning the union of all possible
roles. This produces more precise policy evaluation.

Use conditional roles when:
- A tool has an operation/mode/type/action argument that selects between
  read-only and mutating behavior (e.g., "list" vs "create"/"delete")
- A boolean flag (like dryRun or force) changes whether the tool modifies
  state

IMPORTANT: Always check for mode-like arguments (mode, operation, type,
action, command, subcommand). If a mode argument's possible values include
both read-only operations (list, show, get, status) and mutating operations
(create, delete, add, remove, push, pop, apply, drop, rename), the path
argument MUST use conditional roles — not a static union of all roles.

Format for conditional roles:
{
  "default": ["read-path", "write-history", "delete-history"],
  "when": [
    { "condition": { "arg": "operation", "equals": "list" }, "roles": ["read-path"] },
    { "condition": { "arg": "operation", "in": ["create", "rename"] }, "roles": ["read-path", "write-history"] },
    { "condition": { "arg": "operation", "equals": "delete" }, "roles": ["read-path", "delete-history"] }
  ]
}

Rules for conditional roles:
- The "default" MUST be the MOST RESTRICTIVE role set (the union of all
  possible roles). This is the fallback when no condition matches.
- Each "when" entry narrows the roles for a specific mode/flag value.
- The "arg" in a condition must reference another argument in the same
  tool's input schema.
- Use "equals" for single-value matching, "in" for multiple values with
  the same roles, and "is" for presence/truthiness checks.
- Only use conditional roles when the mode argument genuinely changes the
  security profile. Do not add conditions for arguments that do not affect
  which resources are accessed.
- Most arguments will still use static role arrays. Only use conditional
  roles where the tool is clearly multi-mode.

Example: A tool with a mode argument (list is read-only, push/pop mutate):
{
  "path": {
    "default": ["read-path", "write-history"],
    "when": [
      { "condition": { "arg": "mode", "in": ["list", "show"] }, "roles": ["read-path"] }
    ]
  },
  "mode": ["none"],
  "message": ["none"]
}

Example: A tool with dryRun flag:
{
  "path": {
    "default": ["read-path", "write-path"],
    "when": [
      { "condition": { "arg": "dryRun", "equals": true }, "roles": ["read-path"] }
    ]
  },
  "dryRun": ["none"]
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
): Promise<StoredToolAnnotation[]> {
  if (tools.length === 0) return [];

  const batches = chunk(tools, ANNOTATION_BATCH_SIZE);
  const allAnnotations: StoredToolAnnotation[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    if (batches.length > 1) {
      onProgress?.(`Batch ${i + 1}/${batches.length} (${batch.length} tools)`);
    }

    const schema = buildAnnotationsResponseSchema(serverName, batch);
    const prompt = buildAnnotationPrompt(serverName, batch);

    const { output } = await generateObjectWithRepair({
      model: llm,
      schema,
      prompt,
      onProgress: batches.length > 1 ? (msg) => onProgress?.(`Batch ${i + 1}/${batches.length}: ${msg}`) : onProgress,
    });

    const batchAnnotations: StoredToolAnnotation[] = output.annotations.map((a) => ({
      ...a,
      serverName,
    }));

    allAnnotations.push(...batchAnnotations);
  }

  // Validate all input tools are represented across all batches
  const annotatedNames = new Set(allAnnotations.map((a) => a.toolName));
  const missingTools = tools.filter((t) => !annotatedNames.has(t.name));
  if (missingTools.length > 0) {
    const names = missingTools.map((t) => t.name).join(', ');
    throw new Error(`Annotation incomplete: missing tools: ${names}`);
  }

  return allAnnotations;
}

// -----------------------------------------------------------------------
// Compile-time heuristic validation
// -----------------------------------------------------------------------

/**
 * Argument names that strongly suggest filesystem path arguments.
 *
 * Strong indicators are terms that almost always mean "filesystem path" --
 * these trigger a warning even when the LLM explicitly annotated the
 * argument with a non-path role (unless the schema description clearly
 * indicates otherwise).
 *
 * Weak indicators ("source", "destination") are ambiguous across domains:
 * in filesystem tools they mean paths, but in git tools "source" is a
 * branch ref. For these, the heuristic defers to the schema description
 * when the argument has an explicit annotation.
 */
const STRONG_PATH_INDICATORS = ['path', 'dir', 'directory'];
const WEAK_PATH_INDICATORS = ['source', 'destination', 'file'];

/**
 * Description patterns that suggest an argument accepts a filesystem path
 * value. Uses word-boundary regex to avoid false positives from incidental
 * mentions (e.g., "whether to update files" vs "file path to read").
 */
const PATH_DESCRIPTION_PATTERNS = [/\bpath\b/i, /\bfilename\b/i, /\bfilepath\b/i, /\bdirectory\b/i, /\bfolder\b/i];

/**
 * Split an argument name into lowercase word segments by camelCase
 * and snake_case boundaries.
 *
 *   "updateAgentMetaFiles" → ["update", "agent", "meta", "files"]
 *   "source_path"          → ["source", "path"]
 */
function splitArgName(argName: string): string[] {
  // Insert separator before uppercase letters (camelCase boundaries),
  // then split on non-alpha characters (underscores, hyphens, etc.)
  return argName
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

export type PathIndicatorStrength = 'strong' | 'weak' | false;

/**
 * Check if an argument name contains a path indicator as a whole word
 * segment (not as an arbitrary substring). Matches plurals by checking
 * if any segment equals the indicator or its plural form.
 *
 * Returns 'strong', 'weak', or false:
 * - 'strong': short names where the indicator IS the argument (e.g.,
 *   "path", "filePath", "source_dir"). These are flagged even with an
 *   explicit non-path annotation.
 * - 'weak': either uses an ambiguous indicator ("source", "destination")
 *   OR is a long compound name where the indicator is incidental (e.g.,
 *   "updateAgentMetaFiles"). For these, the heuristic defers to the
 *   schema description when the LLM has assigned an explicit annotation.
 */
export function looksLikePathArgument(argName: string): PathIndicatorStrength {
  const segments = splitArgName(argName);

  const matchesIndicator = (indicators: string[]) =>
    indicators.some((indicator) =>
      segments.some((seg) => seg === indicator || seg === indicator + 's' || seg === indicator.replace(/y$/, 'ies')),
    );

  if (matchesIndicator(STRONG_PATH_INDICATORS)) {
    // In long compound names (3+ segments), a path keyword is more likely
    // to be incidental (e.g., "updateAgentMetaFiles") than in short names
    // (e.g., "filePath"). Downgrade to weak so the description check applies.
    return segments.length >= 3 ? 'weak' : 'strong';
  }
  if (matchesIndicator(WEAK_PATH_INDICATORS)) return 'weak';
  return false;
}

/**
 * Check if the schema description for an argument contains keywords
 * suggesting it refers to a filesystem path.
 */
function descriptionSuggestsPath(argSchema: Record<string, unknown>): boolean {
  const desc = argSchema['description'];
  if (typeof desc !== 'string') return false;
  return PATH_DESCRIPTION_PATTERNS.some((pattern) => pattern.test(desc));
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
  annotations: StoredToolAnnotation[],
): HeuristicValidationResult {
  const annotationsByName = new Map<string, StoredToolAnnotation>();
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
      const indicatorStrength = looksLikePathArgument(argName);
      if (!indicatorStrength) continue;

      // Skip non-string arguments (booleans, enums, numbers named "directories" etc.)
      const argType = argSchema['type'];
      if (argType === 'boolean' || argType === 'number' || argType === 'integer') continue;

      const roles = argName in annotation.args ? extractDefaultRoles(annotation.args[argName]) : undefined;
      const hasPathRole = roles && roles.some((r) => getRoleDefinition(r).isResourceIdentifier);

      if (!hasPathRole) {
        // For weak indicators (e.g., "source", "destination"), defer to the
        // schema description when the argument has an explicit annotation.
        // These names are ambiguous: "source" means a path in filesystem
        // tools but a branch ref in git tools.
        if (indicatorStrength === 'weak' && roles && !descriptionSuggestsPath(argSchema)) {
          continue;
        }
        warnings.push(`Tool "${tool.name}" argument "${argName}" looks like a path but has no path role in annotation`);
      }
    }

    // Check for path-like default values or examples
    if (hasPathLikeValues(tool.inputSchema)) {
      const hasAnyPathRole = Object.values(annotation.args).some((spec) =>
        extractDefaultRoles(spec).some((r) => getRoleDefinition(r).isResourceIdentifier),
      );
      if (!hasAnyPathRole) {
        warnings.push(`Tool "${tool.name}" schema has path-like defaults/examples but no path roles in annotation`);
      }
    }
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}
