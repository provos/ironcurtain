/**
 * PolicyEngine -- Two-phase declarative policy evaluation.
 *
 * Phase 1: Hardcoded structural invariants (protected paths, unknown tools).
 *          These are never overridden by compiled rules.
 *
 * Phase 2: Compiled declarative rules loaded from compiled-policy.json.
 *          Each distinct role from the tool's annotation is evaluated
 *          independently through the rule chain (first-match-wins per role).
 *          The most restrictive result wins: deny > escalate > allow.
 */

import { resolve } from 'node:path';
import type { ToolCallRequest, PolicyDecisionStatus } from '../types/mcp.js';
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
 * Any string value starting with '/', '.', or '~' is treated as a path.
 * Handles both single string values and arrays of strings.
 */
function extractPathsHeuristic(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && (value.startsWith('/') || value.startsWith('.') || value.startsWith('~'))) {
      paths.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && (item.startsWith('/') || item.startsWith('.') || item.startsWith('~'))) {
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

/** Higher severity = more restrictive. Used to pick the strictest per-role result. */
const DECISION_SEVERITY: Record<PolicyDecisionStatus, number> = {
  allow: 0,
  escalate: 1,
  deny: 2,
};

/**
 * Collects all distinct non-"none" roles from a tool annotation's arguments.
 * Returns an empty array if the tool has no role-bearing arguments.
 */
function collectDistinctRoles(annotation: ToolAnnotation): ArgumentRole[] {
  const roles = new Set<ArgumentRole>();
  for (const argRoles of Object.values(annotation.args)) {
    for (const role of argRoles) {
      if (role !== 'none') roles.add(role);
    }
  }
  return [...roles];
}

/**
 * Checks whether a rule has role-related conditions (roles or paths).
 * Rules without these conditions are role-agnostic and match any role.
 */
function hasRoleConditions(rule: CompiledRule): boolean {
  return rule.if.roles !== undefined || rule.if.paths !== undefined;
}

/**
 * Checks whether a rule's role-related conditions include a specific role.
 * For `roles` conditions: the role must be in the list.
 * For `paths` conditions: the role must be in the paths.roles list.
 */
function ruleRelevantToRole(rule: CompiledRule, role: ArgumentRole): boolean {
  const cond = rule.if;
  if (cond.roles !== undefined && !cond.roles.includes(role)) return false;
  if (cond.paths !== undefined && !cond.paths.roles.includes(role)) return false;
  return true;
}

export class PolicyEngine {
  private annotationMap: Map<string, ToolAnnotation>;
  private compiledPolicy: CompiledPolicyFile;
  private protectedPaths: string[];
  private allowedDirectory?: string;

  constructor(
    compiledPolicy: CompiledPolicyFile,
    toolAnnotations: ToolAnnotationsFile,
    protectedPaths: string[],
    allowedDirectory?: string,
  ) {
    this.compiledPolicy = compiledPolicy;
    this.protectedPaths = protectedPaths;
    this.allowedDirectory = allowedDirectory;
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

    // Sandbox containment structural check:
    // If ALL resolved paths are within the allowed directory, auto-allow.
    // Requires at least one path (tools with no path args fall through to
    // compiled rules -- the sandbox predicate is about path containment).
    if (this.allowedDirectory && resolvedPaths.length > 0) {
      const allWithinSandbox = resolvedPaths.every(
        rp => isWithinDirectory(rp, this.allowedDirectory!),
      );
      if (allWithinSandbox) {
        return {
          decision: 'allow',
          rule: 'structural-sandbox-allow',
          reason: `All paths are within the sandbox directory: ${this.allowedDirectory}`,
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
   * For tools with multiple roles (e.g., edit_file has read-path + write-path),
   * each role is evaluated independently through the rule chain. The most
   * restrictive result across all roles wins (deny > escalate > allow).
   *
   * For tools with no roles (e.g., list_allowed_directories), the chain is
   * evaluated once without role filtering.
   */
  private evaluateCompiledRules(request: ToolCallRequest): EvaluationResult {
    const annotation = this.annotationMap.get(`${request.serverName}__${request.toolName}`)!;
    const roles = collectDistinctRoles(annotation);

    if (roles.length === 0) {
      return this.evaluateRulesForRole(request, annotation, undefined);
    }

    let mostRestrictive = this.evaluateRulesForRole(request, annotation, roles[0]);
    if (mostRestrictive.decision === 'deny') return mostRestrictive;

    for (let i = 1; i < roles.length; i++) {
      const result = this.evaluateRulesForRole(request, annotation, roles[i]);
      if (DECISION_SEVERITY[result.decision] > DECISION_SEVERITY[mostRestrictive.decision]) {
        mostRestrictive = result;
      }
      if (result.decision === 'deny') return result;
    }

    return mostRestrictive;
  }

  /**
   * Evaluates the rule chain for a single role (or all roles if undefined).
   *
   * When evaluatingRole is set, only rules that are either role-agnostic
   * (no roles/paths conditions) or relevant to the specified role are
   * considered. First matching rule wins; default deny if none match.
   */
  private evaluateRulesForRole(
    request: ToolCallRequest,
    annotation: ToolAnnotation,
    evaluatingRole: ArgumentRole | undefined,
  ): EvaluationResult {
    for (const rule of this.compiledPolicy.rules) {
      if (evaluatingRole !== undefined && hasRoleConditions(rule) && !ruleRelevantToRole(rule, evaluatingRole)) {
        continue;
      }
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

      // isWithinDirectory resolves paths internally, no pre-resolution needed
      const allWithin = extracted.every(p => isWithinDirectory(p, cond.paths!.within));
      if (!allWithin) return false;
    }

    return true;
  }
}
