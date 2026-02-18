/**
 * Constitution Compiler -- LLM-driven compilation of English-language
 * constitution principles into enforceable declarative policy rules.
 *
 * The compiler takes the constitution text, tool annotations, and system
 * config (concrete directory paths) and produces an ordered rule chain
 * that faithfully implements the non-structural principles.
 */

import type { LanguageModel } from 'ai';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { ToolAnnotation, CompiledRule, ArgumentRole } from './types.js';

export interface CompilerConfig {
  sandboxDirectory: string;
  protectedPaths: string[];
}

const VALID_ROLES: ArgumentRole[] = ['read-path', 'write-path', 'delete-path', 'none'];

const pathConditionSchema = z.object({
  roles: z.array(z.enum(['read-path', 'write-path', 'delete-path', 'none'])),
  within: z.string(),
});

function buildCompilerResponseSchema(
  serverNames: [string, ...string[]],
  toolNames: [string, ...string[]],
) {
  const compiledRuleSchema = z.object({
    name: z.string(),
    description: z.string(),
    principle: z.string(),
    if: z.object({
      roles: z.array(z.enum(['read-path', 'write-path', 'delete-path', 'none'])).optional(),
      server: z.array(z.enum(serverNames)).optional(),
      tool: z.array(z.enum(toolNames)).optional(),
      sideEffects: z.boolean().optional(),
      paths: pathConditionSchema.optional(),
    }),
    then: z.enum(['allow', 'deny', 'escalate']),
    reason: z.string(),
  });

  return z.object({
    rules: z.array(compiledRuleSchema),
  });
}

export function buildCompilerPrompt(
  constitutionText: string,
  annotations: ToolAnnotation[],
  config: CompilerConfig,
): string {
  const annotationsSummary = annotations.map(a => {
    const argsDesc = Object.entries(a.args)
      .map(([name, roles]) => `    ${name}: [${roles.join(', ')}]`)
      .join('\n');
    return `  ${a.serverName}/${a.toolName}: ${a.comment}, sideEffects=${a.sideEffects}\n    args:\n${argsDesc || '    (none)'}`;
  }).join('\n');

  return `You are compiling a security policy from a constitution document into enforceable declarative rules.

## Constitution

${constitutionText}

## Tool Annotations

These are the available tools and their classified capabilities:

${annotationsSummary}

## System Configuration

- Sandbox directory: ${config.sandboxDirectory}

## Protected Paths (Structural Invariants -- handled automatically by the engine)

The following paths are protected by hardcoded structural invariants evaluated BEFORE compiled rules. Any write or delete targeting these paths is automatically denied. Do NOT generate rules for protecting these paths -- the engine handles this:

${config.protectedPaths.map(p => `- ${p}`).join('\n')}

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
- "then": "allow", "deny", or "escalate"
- "reason": human-readable explanation

CRITICAL RULES:
1. Do NOT generate rules for protected path checking or unknown tool denial -- those are handled by structural invariants in the engine.
2. Use CONCRETE ABSOLUTE paths (e.g., "${config.sandboxDirectory}"), not abstract labels.
3. "Outside a directory" semantics: use rule ordering. A rule with "within" matches the inside case; the next rule without "paths" catches everything else as a fallthrough.
4. The move tool's source argument has both read-path and delete-path roles. A blanket "roles": ["delete-path"] rule will catch all moves.
5. Order matters: more specific rules before more general ones.`;
}

export async function compileConstitution(
  constitutionText: string,
  annotations: ToolAnnotation[],
  config: CompilerConfig,
  llm: LanguageModel,
): Promise<CompiledRule[]> {
  const serverNames = [...new Set(annotations.map(a => a.serverName))] as [string, ...string[]];
  const toolNames = [...new Set(annotations.map(a => a.toolName))] as [string, ...string[]];
  const schema = buildCompilerResponseSchema(serverNames, toolNames);
  const prompt = buildCompilerPrompt(constitutionText, annotations, config);

  const { output } = await generateText({
    model: llm,
    output: Output.object({ schema }),
    prompt,
  });

  return output.rules;
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
): RuleValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const rule of rules) {
    // Validate top-level roles
    if (rule.if.roles) {
      for (const role of rule.if.roles) {
        if (!VALID_ROLES.includes(role)) {
          errors.push(`Rule "${rule.name}": invalid role "${role}" in roles`);
        }
      }
    }

    // Validate path roles
    if (rule.if.paths) {
      for (const role of rule.if.paths.roles) {
        if (!VALID_ROLES.includes(role)) {
          errors.push(`Rule "${rule.name}": invalid role "${role}" in paths.roles`);
        }
      }

      // Validate within is an absolute path
      if (!rule.if.paths.within.startsWith('/')) {
        errors.push(`Rule "${rule.name}": paths.within must be an absolute path, got "${rule.if.paths.within}"`);
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

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
