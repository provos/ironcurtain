/**
 * PolicyEngine -- Two-phase declarative policy evaluation.
 *
 * Phase 1: Hardcoded structural invariants (protected paths, unknown tools).
 *          These are never overridden by compiled rules.
 *
 * Phase 2: Compiled declarative rules loaded from compiled-policy.json.
 *          First matching rule wins; default deny if none match.
 */

import { resolve } from 'node:path';
import type { ToolCallRequest } from '../types/mcp.js';
import type { EvaluationResult } from './policy-types.js';
import type {
  CompiledPolicyFile,
  ToolAnnotationsFile,
  ToolAnnotation,
  CompiledRule,
  ArgumentRole,
} from '../pipeline/types.js';

/**
 * Heuristically extracts filesystem paths from tool call arguments.
 * Any string value starting with '/' or '.' is treated as a path.
 * Handles both single string values and arrays of strings.
 */
function extractPathsHeuristic(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && (value.startsWith('/') || value.startsWith('.'))) {
      paths.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && (item.startsWith('/') || item.startsWith('.'))) {
          paths.push(item);
        }
      }
    }
  }
  return paths;
}

/**
 * Extracts paths from arguments based on annotation roles.
 * Only returns paths for arguments whose annotated roles intersect
 * with the target roles. Handles both string and string[] arguments.
 */
function extractAnnotatedPaths(
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  targetRoles: ArgumentRole[],
): string[] {
  const paths: string[] = [];
  for (const [argName, roles] of Object.entries(annotation.args)) {
    if (!roles.some(r => targetRoles.includes(r))) continue;

    const value = args[argName];
    if (typeof value === 'string') {
      paths.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') paths.push(item);
      }
    }
  }
  return paths;
}

/**
 * Checks whether a target path is contained within a directory.
 * Both paths are resolved to absolute form before comparison,
 * which neutralizes path traversal attacks.
 */
function isWithinDirectory(targetPath: string, directory: string): boolean {
  const resolved = resolve(targetPath);
  const resolvedDir = resolve(directory);
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + '/');
}

/**
 * Checks whether a resolved path matches any protected path.
 * A path is protected if it equals a protected path exactly
 * or is contained within a protected directory.
 */
function isProtectedPath(resolvedPath: string, protectedPaths: string[]): boolean {
  return protectedPaths.some(pp => {
    const resolvedPP = resolve(pp);
    return resolvedPath === resolvedPP || resolvedPath.startsWith(resolvedPP + '/');
  });
}

export class PolicyEngine {
  private annotationMap: Map<string, ToolAnnotation>;
  private compiledPolicy: CompiledPolicyFile;
  private protectedPaths: string[];

  constructor(
    compiledPolicy: CompiledPolicyFile,
    toolAnnotations: ToolAnnotationsFile,
    protectedPaths: string[],
  ) {
    this.compiledPolicy = compiledPolicy;
    this.protectedPaths = protectedPaths;
    this.annotationMap = this.buildAnnotationMap(toolAnnotations);
  }

  private buildAnnotationMap(annotations: ToolAnnotationsFile): Map<string, ToolAnnotation> {
    const map = new Map<string, ToolAnnotation>();
    for (const [serverName, serverData] of Object.entries(annotations.servers)) {
      for (const tool of serverData.tools) {
        const key = `${serverName}__${tool.toolName}`;
        map.set(key, tool);
      }
    }
    return map;
  }

  evaluate(request: ToolCallRequest): EvaluationResult {
    // Phase 1: Structural invariants
    const structuralResult = this.evaluateStructuralInvariants(request);
    if (structuralResult) return structuralResult;

    // Phase 2: Compiled rules
    return this.evaluateCompiledRules(request);
  }

  /**
   * Phase 1: Hardcoded structural invariants.
   *
   * Uses the union of heuristic and annotation-based path extraction
   * for defense-in-depth. Returns a result if a structural rule fires,
   * or undefined to fall through to compiled rules.
   */
  private evaluateStructuralInvariants(request: ToolCallRequest): EvaluationResult | undefined {
    // Extract paths using both methods for defense-in-depth
    const heuristicPaths = extractPathsHeuristic(request.arguments);
    const annotation = this.annotationMap.get(`${request.serverName}__${request.toolName}`);

    const allPathRoles: ArgumentRole[] = ['read-path', 'write-path', 'delete-path'];
    const annotatedPaths = annotation
      ? extractAnnotatedPaths(request.arguments, annotation, allPathRoles)
      : [];

    // Union of both extraction methods, deduplicated
    const allPaths = [...new Set([...heuristicPaths, ...annotatedPaths])];
    const resolvedPaths = allPaths.map(p => resolve(p));

    // Check protected paths
    for (const rp of resolvedPaths) {
      if (isProtectedPath(rp, this.protectedPaths)) {
        return {
          decision: 'deny',
          rule: 'structural-protected-path',
          reason: `Access to protected path is forbidden: ${rp}`,
        };
      }
    }

    // Unknown tool check
    if (!annotation) {
      return {
        decision: 'deny',
        rule: 'structural-unknown-tool',
        reason: `Unknown tool: ${request.serverName}/${request.toolName}`,
      };
    }

    return undefined;
  }

  /**
   * Phase 2: Evaluate compiled declarative rules.
   *
   * Rules are evaluated in order; first matching rule wins.
   * If no rule matches, default deny.
   */
  private evaluateCompiledRules(request: ToolCallRequest): EvaluationResult {
    const annotation = this.annotationMap.get(`${request.serverName}__${request.toolName}`)!;

    for (const rule of this.compiledPolicy.rules) {
      if (this.ruleMatches(rule, request, annotation)) {
        return {
          decision: rule.then,
          rule: rule.name,
          reason: rule.reason,
        };
      }
    }

    return {
      decision: 'deny',
      rule: 'default-deny',
      reason: 'No matching policy rule -- denied by default',
    };
  }

  /**
   * Checks whether all conditions in a rule's `if` block are satisfied.
   */
  private ruleMatches(
    rule: CompiledRule,
    request: ToolCallRequest,
    annotation: ToolAnnotation,
  ): boolean {
    const cond = rule.if;

    // Check roles condition: tool must have at least one argument
    // whose roles include any of the specified roles
    if (cond.roles !== undefined) {
      const toolHasMatchingRole = Object.values(annotation.args).some(
        argRoles => argRoles.some(r => cond.roles!.includes(r)),
      );
      if (!toolHasMatchingRole) return false;
    }

    // Check server condition
    if (cond.server !== undefined && !cond.server.includes(request.serverName)) {
      return false;
    }

    // Check tool condition
    if (cond.tool !== undefined && !cond.tool.includes(request.toolName)) {
      return false;
    }

    // Check sideEffects condition
    if (cond.sideEffects !== undefined && annotation.sideEffects !== cond.sideEffects) {
      return false;
    }

    // Check paths condition
    if (cond.paths !== undefined) {
      const extracted = extractAnnotatedPaths(
        request.arguments,
        annotation,
        cond.paths.roles,
      );

      // Zero paths extracted = condition not satisfied, rule does not match
      if (extracted.length === 0) return false;

      const resolved = extracted.map(p => resolve(p));
      const allWithin = resolved.every(p => isWithinDirectory(p, cond.paths!.within));
      if (!allWithin) return false;
    }

    return true;
  }
}
