/**
 * Constitution Compiler -- LLM-driven compilation of English-language
 * constitution principles into enforceable declarative policy rules.
 *
 * The compiler takes the constitution text, tool annotations, and system
 * config (concrete directory paths) and produces an ordered rule chain
 * that faithfully implements the non-structural principles.
 */

import type { LanguageModel, SystemModelMessage } from 'ai';
import { generateText } from 'ai';
import { z } from 'zod';
import {
  DEFAULT_MAX_TOKENS,
  generateObjectWithRepair,
  parseJsonWithSchema,
  schemaToPromptHint,
} from './generate-with-repair.js';
import type { ToolAnnotation, CompiledRule, RepairContext, ListDefinition, TestScenario } from './types.js';
import { isArgumentRole, getArgumentRoleValues } from '../types/argument-roles.js';
import { formatExecutionResults } from './policy-verifier.js';

export interface CompilerConfig {
  protectedPaths: string[];
}

export interface CompilationOutput {
  rules: CompiledRule[];
  listDefinitions: ListDefinition[];
}

const pathConditionSchema = z.object({
  roles: z.array(z.enum(getArgumentRoleValues())),
  within: z.string(),
});

const domainConditionSchema = z.object({
  roles: z.array(z.enum(getArgumentRoleValues())),
  allowed: z.array(z.string()),
});

const listConditionSchema = z.object({
  roles: z.array(z.enum(getArgumentRoleValues())),
  allowed: z.array(z.string()),
  matchType: z.enum(['domains', 'emails', 'identifiers']),
});

const listDefinitionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  type: z.enum(['domains', 'emails', 'identifiers']),
  principle: z.string(),
  generationPrompt: z.string(),
  requiresMcp: z.boolean(),
  mcpServerHint: z.string().optional(),
});

function buildCompilerResponseSchema(serverNames: [string, ...string[]], toolNames: [string, ...string[]]) {
  const compiledRuleSchema = z.object({
    name: z.string(),
    description: z.string(),
    principle: z.string(),
    if: z.object({
      roles: z.array(z.enum(getArgumentRoleValues())).optional(),
      server: z.array(z.enum(serverNames)).optional(),
      tool: z.array(z.enum(toolNames)).optional(),
      sideEffects: z.boolean().optional(),
      paths: pathConditionSchema.optional(),
      domains: domainConditionSchema.optional(),
      lists: z.array(listConditionSchema).optional(),
    }),
    then: z.enum(['allow', 'deny', 'escalate']),
    reason: z.string(),
  });

  return z.object({
    rules: z.array(compiledRuleSchema),
    listDefinitions: z.array(listDefinitionSchema).optional().default([]),
  });
}

/**
 * Formats handwritten scenarios as ground truth constraints for the compiler LLM.
 */
function formatGroundTruthSection(scenarios?: TestScenario[]): string {
  if (!scenarios || scenarios.length === 0) return '';

  const lines = scenarios.map(
    (s, i) =>
      `${i + 1}. ${s.request.serverName}/${s.request.toolName} ${JSON.stringify(s.request.arguments)} → ${s.expectedDecision}\n   ${s.reasoning}`,
  );

  return `
## Ground Truth Constraints

These test scenarios represent required policy outcomes. Your compiled rules
MUST produce these exact decisions:

${lines.join('\n\n')}
`;
}

/**
 * Builds the stable system prompt portion for the compiler.
 * Contains: role preamble, constitution, annotations, structural invariants, and instructions.
 * This is the cacheable part — it stays the same across repair rounds.
 */
export function buildCompilerSystemPrompt(
  constitutionText: string,
  annotations: ToolAnnotation[],
  config: CompilerConfig,
  handwrittenScenarios?: TestScenario[],
): string {
  const annotationsSummary = annotations
    .map((a) => {
      const argsDesc = Object.entries(a.args)
        .map(([name, roles]) => `    ${name}: [${roles.join(', ')}]`)
        .join('\n');
      return `  ${a.serverName}/${a.toolName}: ${a.comment}, sideEffects=${a.sideEffects}\n    args:\n${argsDesc || '    (none)'}`;
    })
    .join('\n');

  return `You are compiling a security policy from a constitution document into enforceable declarative rules.

## Constitution

${constitutionText}

## Tool Annotations

These are the available tools and their classified capabilities:

${annotationsSummary}

## Structural Invariants (handled automatically by the engine -- do NOT generate rules for these)

The following checks are hardcoded and evaluated BEFORE compiled rules:

1. **Protected paths** -- any read, write, or delete targeting these paths is automatically denied:
${config.protectedPaths.map((p) => `- ${p}`).join('\n')}

2. **Sandbox containment** -- any tool call where ALL paths are within the sandbox directory is automatically allowed. Do NOT generate rules for sandbox-internal operations; the engine handles this at runtime with the dynamically configured sandbox path.

3. **Default escalate** -- if no compiled rule matches, the engine escalates to a human for approval. You do NOT need catch-all escalate rules; any operation not covered by your rules will automatically be routed for human review.

## Instructions

Produce an ORDERED list of policy rules (first match wins). Each rule has:
- "name": a kebab-case identifier
- "description": what the rule does
- "principle": which constitution principle this implements
- "if": conditions that must ALL be true for the rule to fire:
  - "roles": array of argument roles to match. The rule fires if the tool has ANY argument with ANY of these roles. Use this for blanket rules (e.g., deny all tools with delete-path arguments). Omit = any tool.
  - "server": array of server names (omit = any server)
  - "tool": array of specific tool names (omit = any matching tool)
  - "sideEffects": match on the tool's sideEffects annotation (omit = don't filter)
  - "paths": path condition with "roles" (which argument roles to extract paths from) and "within" (concrete absolute directory). Rule fires only if ALL extracted paths are within that directory. If zero paths are extracted (tool has no matching path arguments), the condition is NOT satisfied and the rule does NOT match. This implicitly requires matching roles, so top-level "roles" is redundant when "paths" is present.
  - "domains": domain condition with "roles" (which URL argument roles to extract domains from) and "allowed" (list of allowed domain patterns, e.g. ["github.com", "*.github.com"]). Rule fires only if ALL extracted domains match an allowed pattern. Supports exact match, "*.example.com" prefix wildcards, and "*" (any domain). If zero URLs are extracted, the condition is NOT satisfied and the rule does NOT match.
- "then": the policy decision:
  - "allow" — the operation is explicitly permitted by the constitution
  - "deny" — the operation is categorically forbidden by the constitution (absolute prohibition)
  - "escalate" — the operation is not explicitly permitted but also not forbidden; route to a human for approval
- "reason": human-readable explanation

CRITICAL RULES:
1. Do NOT generate rules for protected path checking, unknown tool denial, or sandbox containment -- those are handled by structural invariants in the engine.
2. Use CONCRETE ABSOLUTE paths (e.g., "/home/user/Downloads"), not abstract labels.
3. "Outside a directory" semantics: use rule ordering. A rule with "within" matches the inside case; the next rule without "paths" catches everything else as a fallthrough.
4. The move tool's source argument has both read-path and delete-path roles. A blanket "roles": ["delete-path"] rule will catch all moves.
5. Order matters: more specific rules before more general ones.
6. Use all three decision types. Map each constitution principle to the appropriate decision: "allow" for grants, "deny" for prohibitions, and "escalate" for principles that require human judgment or approval. Unmatched operations are automatically escalated by the engine, so only emit explicit rules for operations the constitution addresses.

Be concise in descriptions and reasons -- one sentence each.
${formatGroundTruthSection(handwrittenScenarios)}
## Dynamic Lists

When the constitution references a CATEGORY of things (e.g., "major news sites",
"my contacts", "tech stocks"), do NOT hardcode specific values. Instead:

1. Choose a descriptive kebab-case name for the category (e.g., "major-news-sites").
2. In the rule condition, use "@major-news-sites" as an entry in the allowed list.
   - For domain categories: put "@list-name" in domains.allowed
   - For email/identifier categories: add a "lists" condition with the appropriate matchType
3. In the listDefinitions output, emit a ListDefinition with:
   - name: the symbolic name (without @)
   - type: "domains" for website/domain categories, "emails" for email address
     categories, "identifiers" for other value categories
   - principle: the constitution text that references this category
   - generationPrompt: a clear prompt describing WHAT to list (quantity, scope).
     Do NOT include format instructions (e.g., "return domain names only") --
     format guidance is added mechanically based on the list type.
   - requiresMcp: true ONLY if the list requires querying live data from an
     MCP server (e.g., "my contacts" needs a contacts database).
     false for knowledge-based lists (e.g., "major news sites").
   - mcpServerHint: the MCP server name if requiresMcp is true

When the constitution says something like "any domain" or "all", do NOT create a
list. Use the wildcard pattern "*" directly.

Examples:
- "major news sites" -> @major-news-sites (type: domains, requiresMcp: false)
- "people in my contacts" -> @my-contacts (type: emails, requiresMcp: true)
- "major tech stocks" -> @tech-stock-tickers (type: identifiers, requiresMcp: false)`;
}

/** Builds the repair instructions sent as the user prompt during repair rounds. */
export function buildRepairInstructions(repairContext: RepairContext): string {
  const rulesText = repairContext.previousRules
    .map((r, i) => `  ${i + 1}. [${r.name}] if: ${JSON.stringify(r.if)} then: ${r.then} -- ${r.reason}`)
    .join('\n');

  const failuresText = formatExecutionResults(repairContext.failedScenarios);

  let existingListsText = '';
  if (repairContext.existingListDefinitions && repairContext.existingListDefinitions.length > 0) {
    const listLines = repairContext.existingListDefinitions.map((d) => `- @${d.name} (type: ${d.type})`).join('\n');
    existingListsText = `

### Available Dynamic Lists

The following dynamic lists have already been resolved and are available for use in rules.
You MUST use these exact names — do NOT rename or create new lists:

${listLines}
`;
  }

  return `## REPAIR INSTRUCTIONS (attempt ${repairContext.attemptNumber})

Your previous compilation produced rules that failed verification. You MUST fix these issues.

### Previous Rules

${rulesText}

### Failed Scenarios

${failuresText}

### Judge Analysis

${repairContext.judgeAnalysis}
${existingListsText}
### Requirements

1. Fix the rule ordering, conditions, or add missing rules to make ALL failed scenarios pass.
2. Do NOT break scenarios that were already passing — only fix the failures.
3. Pay close attention to the judge analysis for specific guidance on what went wrong.
4. Return a complete, corrected rule set (not just the changed rules).
${formatGroundTruthSection(repairContext.handwrittenScenarios)}`;
}

export async function compileConstitution(
  constitutionText: string,
  annotations: ToolAnnotation[],
  config: CompilerConfig,
  llm: LanguageModel,
  repairContext?: RepairContext,
  onProgress?: (message: string) => void,
  system?: string | SystemModelMessage,
): Promise<CompilationOutput> {
  const serverNames = [...new Set(annotations.map((a) => a.serverName))] as [string, ...string[]];
  const toolNames = [...new Set(annotations.map((a) => a.toolName))] as [string, ...string[]];
  const schema = buildCompilerResponseSchema(serverNames, toolNames);

  const effectiveSystem = system ?? buildCompilerSystemPrompt(constitutionText, annotations, config);
  const prompt = repairContext
    ? buildRepairInstructions(repairContext)
    : 'Compile the constitution into policy rules following the instructions above.';

  const { output } = await generateObjectWithRepair({
    model: llm,
    schema,
    system: effectiveSystem,
    prompt,
    onProgress,
  });

  return {
    rules: output.rules,
    listDefinitions: output.listDefinitions,
  };
}

// ---------------------------------------------------------------------------
// Multi-Turn Constitution Compiler Session
// ---------------------------------------------------------------------------

const INITIAL_COMPILE_MESSAGE = 'Compile the constitution into policy rules following the instructions above.';

/**
 * A stateful multi-turn wrapper around the constitution compiler.
 *
 * Maintains a conversation history so that repair feedback (failed scenarios,
 * judge analysis) can be communicated to the LLM in follow-up turns with
 * full context of its prior output. The system prompt is fixed at construction
 * and never changes, enabling prompt caching.
 *
 * Lifecycle:
 *   1. Construct with system prompt, model, and annotations (once per pipeline run)
 *   2. Call compile() for the initial rule set
 *   3. After verification, call recompile(repairContext) with failure feedback
 *   4. Session is GC'd when the pipeline finishes (no explicit close needed)
 */
export class ConstitutionCompilerSession {
  private readonly systemPrompt: string | SystemModelMessage;
  private readonly model: LanguageModel;
  private readonly schema: ReturnType<typeof buildCompilerResponseSchema>;
  private readonly history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private readonly schemaHint: string;
  private turns = 0;

  constructor(options: { system: string | SystemModelMessage; model: LanguageModel; annotations: ToolAnnotation[] }) {
    this.systemPrompt = options.system;
    this.model = options.model;

    const serverNames = [...new Set(options.annotations.map((a) => a.serverName))] as [string, ...string[]];
    const toolNames = [...new Set(options.annotations.map((a) => a.toolName))] as [string, ...string[]];
    this.schema = buildCompilerResponseSchema(serverNames, toolNames);
    this.schemaHint = schemaToPromptHint(this.schema);
  }

  /**
   * Initial compilation: sends the first user message and returns compiled rules.
   * Semantically equivalent to the existing single-shot compileConstitution().
   */
  async compile(onProgress?: (message: string) => void): Promise<CompilationOutput> {
    return this.callAndParse(INITIAL_COMPILE_MESSAGE, onProgress);
  }

  /**
   * Follow-up compilation: feeds back repair context (failed scenarios + judge
   * analysis) and requests corrected rules. The LLM sees its previous output
   * and the failure feedback in the conversation history.
   */
  async recompile(repairContext: RepairContext, onProgress?: (message: string) => void): Promise<CompilationOutput> {
    return this.callAndParse(buildRepairInstructions(repairContext), onProgress);
  }

  /** Returns the number of turns completed so far. */
  get turnCount(): number {
    return this.turns;
  }

  private async callAndParse(userMessage: string, onProgress?: (message: string) => void): Promise<CompilationOutput> {
    const messageWithSchema = userMessage + this.schemaHint;
    this.history.push({ role: 'user', content: messageWithSchema });

    onProgress?.('Compiling...');

    const result = await generateText({
      model: this.model,
      system: this.systemPrompt,
      messages: this.history,
      maxOutputTokens: DEFAULT_MAX_TOKENS,
    });

    // Try to parse; on schema failure, do one internal retry
    const firstAttempt = this.tryParse(result.text);
    if (firstAttempt.ok) {
      this.history.push({ role: 'assistant', content: result.text });
      this.turns++;
      return firstAttempt.value;
    }

    // First parse failed -- attempt one schema repair round.
    // Build the retry messages without mutating history so that only
    // the successful response is persisted in the conversation.
    onProgress?.('Schema repair 1/1...');

    const retryResult = await generateText({
      model: this.model,
      system: this.systemPrompt,
      messages: [
        ...this.history,
        { role: 'assistant' as const, content: result.text },
        {
          role: 'user' as const,
          content: `Your response failed schema validation:\n${firstAttempt.error}\n\nPlease fix the errors and return valid JSON matching the schema.`,
        },
      ],
      maxOutputTokens: DEFAULT_MAX_TOKENS,
    });

    // If retry also fails, remove the dangling user message from
    // history before re-throwing so the session remains usable.
    try {
      const retryOutput = this.parseOutput(retryResult.text);
      this.history.push({ role: 'assistant', content: retryResult.text });
      this.turns++;
      return retryOutput;
    } catch (retryError) {
      this.history.pop(); // remove the user message added at the start
      throw retryError;
    }
  }

  /** Attempts to parse LLM output, returning a discriminated result. */
  private tryParse(text: string): { ok: true; value: CompilationOutput } | { ok: false; error: string } {
    try {
      return { ok: true, value: this.parseOutput(text) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private parseOutput(text: string): CompilationOutput {
    const parsed = parseJsonWithSchema(text, this.schema);
    return { rules: parsed.rules, listDefinitions: parsed.listDefinitions };
  }
}

// -----------------------------------------------------------------------
// Post-compilation validation
// -----------------------------------------------------------------------

export interface RuleValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateCompiledRules(
  rules: CompiledRule[],
  listDefinitions: ListDefinition[] = [],
): RuleValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const listDefsByName = new Map(listDefinitions.map((d) => [d.name, d]));

  // Track which list definitions are referenced by at least one rule
  const referencedListNames = new Set<string>();

  for (const rule of rules) {
    // Validate top-level roles
    if (rule.if.roles) {
      for (const role of rule.if.roles) {
        if (!isArgumentRole(role)) {
          errors.push(`Rule "${rule.name}": invalid role "${String(role)}" in roles`);
        }
      }
    }

    // Validate path roles
    if (rule.if.paths) {
      for (const role of rule.if.paths.roles) {
        if (!isArgumentRole(role)) {
          errors.push(`Rule "${rule.name}": invalid role "${String(role)}" in paths.roles`);
        }
      }

      // Validate within is an absolute path
      if (!rule.if.paths.within.startsWith('/')) {
        errors.push(`Rule "${rule.name}": paths.within must be an absolute path, got "${rule.if.paths.within}"`);
      }
    }

    // Validate domain roles and @list-name references
    if (rule.if.domains) {
      for (const role of rule.if.domains.roles) {
        if (!isArgumentRole(role)) {
          errors.push(`Rule "${rule.name}": invalid role "${String(role)}" in domains.roles`);
        }
      }
      if (rule.if.domains.allowed.length === 0) {
        warnings.push(`Rule "${rule.name}": domains.allowed is empty (condition will never match)`);
      }

      // Validate @list-name references in domains.allowed
      for (const entry of rule.if.domains.allowed) {
        if (entry.startsWith('@')) {
          const listName = entry.slice(1);
          const listDef = listDefsByName.get(listName);
          if (!listDef) {
            errors.push(`Rule "${rule.name}": @${listName} in domains.allowed has no matching list definition`);
          } else {
            referencedListNames.add(listName);
            // Domain lists must only appear in domains.allowed, not in lists[]
            // (validated on the lists[] side below). Here we just need to ensure
            // the referenced list is actually a domain type.
            if (listDef.type !== 'domains') {
              errors.push(
                `Rule "${rule.name}": @${listName} in domains.allowed references a "${listDef.type}" list, but only "domains" lists belong in domains.allowed`,
              );
            }
          }
        }
      }
    }

    // Validate lists[] conditions
    if (rule.if.lists) {
      for (const listCond of rule.if.lists) {
        for (const role of listCond.roles) {
          if (!isArgumentRole(role)) {
            errors.push(`Rule "${rule.name}": invalid role "${String(role)}" in lists[].roles`);
          }
        }

        for (const entry of listCond.allowed) {
          if (entry.startsWith('@')) {
            const listName = entry.slice(1);
            const listDef = listDefsByName.get(listName);
            if (!listDef) {
              errors.push(`Rule "${rule.name}": @${listName} in lists[].allowed has no matching list definition`);
            } else {
              referencedListNames.add(listName);

              // Domain-type lists must go in domains.allowed, not in lists[]
              if (listDef.type === 'domains') {
                errors.push(
                  `Rule "${rule.name}": @${listName} is a "domains" list and must be in domains.allowed, not in lists[]`,
                );
              }

              // matchType must match the referenced list's type
              if (listCond.matchType !== listDef.type) {
                errors.push(
                  `Rule "${rule.name}": lists[].matchType "${listCond.matchType}" does not match @${listName} list type "${listDef.type}"`,
                );
              }
            }
          }
        }
      }
    }

    // Check for structural invariant concepts that should not be compiled
    const lowerName = rule.name.toLowerCase();
    const lowerDesc = rule.description.toLowerCase();
    if (
      lowerName.includes('protected') ||
      lowerName.includes('structural') ||
      lowerName.includes('unknown-tool') ||
      lowerDesc.includes('protected path') ||
      lowerDesc.includes('unknown tool')
    ) {
      errors.push(
        `Rule "${rule.name}": appears to implement a structural invariant -- these must not be in compiled rules`,
      );
    }
  }

  // Check for orphaned list definitions (defined but never referenced)
  for (const def of listDefinitions) {
    if (!referencedListNames.has(def.name)) {
      warnings.push(`List definition "${def.name}" is not referenced by any rule`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
