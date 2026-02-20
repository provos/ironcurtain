/**
 * PolicyEngine -- Two-phase declarative policy evaluation.
 *
 * Phase 1: Hardcoded structural invariants (protected paths, unknown tools).
 *          These are never overridden by compiled rules. Sandbox containment
 *          is checked per-role: roles whose paths are all within the sandbox
 *          are resolved here and skipped in Phase 2.
 *
 * Phase 2: Compiled declarative rules loaded from compiled-policy.json.
 *          Each distinct role from the tool's annotation is evaluated
 *          independently through the rule chain (first-match-wins per role).
 *          The most restrictive result wins: deny > escalate > allow.
 *          Roles already resolved by Phase 1 sandbox containment are skipped.
 */

import type { ToolCallRequest, PolicyDecisionStatus } from '../types/mcp.js';
import type { EvaluationResult } from './policy-types.js';
import type {
  CompiledPolicyFile,
  ToolAnnotationsFile,
  ToolAnnotation,
  CompiledRule,
  ArgumentRole,
} from '../pipeline/types.js';
import {
  getPathRoles,
  getUrlRoles,
  getRoleDefinition,
  resolveRealPath,
  SANDBOX_SAFE_PATH_ROLES,
  type RoleDefinition,
} from '../types/argument-roles.js';

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
 * Both paths are resolved to their real canonical form (following symlinks)
 * before comparison, which neutralizes both path traversal and symlink attacks.
 */
function isWithinDirectory(targetPath: string, directory: string): boolean {
  const resolved = resolveRealPath(targetPath);
  const resolvedDir = resolveRealPath(directory);
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + '/');
}

/**
 * Checks whether a resolved path matches any protected path.
 * A path is protected if it equals a protected path exactly
 * or is contained within a protected directory.
 * Both sides are resolved through symlinks for accurate comparison.
 */
function isProtectedPath(resolvedPath: string, protectedPaths: string[]): boolean {
  const realPath = resolveRealPath(resolvedPath);
  return protectedPaths.some(pp => {
    const resolvedPP = resolveRealPath(pp);
    return realPath === resolvedPP || realPath.startsWith(resolvedPP + '/');
  });
}

/**
 * Result of Phase 1 structural invariant evaluation.
 *
 * Three possible outcomes:
 * 1. Final decision (deny for protected paths, allow if all paths in sandbox)
 * 2. Partial sandbox resolution (some roles' paths are all within sandbox)
 * 3. No structural match (empty sandboxResolvedRoles, fall through to Phase 2)
 */
interface StructuralResult {
  readonly decision?: EvaluationResult;
  readonly sandboxResolvedRoles: ReadonlySet<ArgumentRole>;
}

const NO_ROLES_RESOLVED: ReadonlySet<ArgumentRole> = new Set();

/** Wraps a final EvaluationResult into a StructuralResult. */
function finalDecision(decision: EvaluationResult): StructuralResult {
  return { decision, sandboxResolvedRoles: NO_ROLES_RESOLVED };
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
      if (getRoleDefinition(role).isResourceIdentifier) roles.add(role);
    }
  }
  return [...roles];
}

/**
 * Extracts URL values from arguments based on annotation roles.
 * Returns an array of { value, role, roleDef } for each URL-category argument.
 */
function extractAnnotatedUrls(
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  targetRoles: ArgumentRole[],
): Array<{ value: string; role: ArgumentRole; roleDef: RoleDefinition }> {
  const urls: Array<{ value: string; role: ArgumentRole; roleDef: RoleDefinition }> = [];
  for (const [argName, roles] of Object.entries(annotation.args)) {
    const matchingRole = roles.find(r => targetRoles.includes(r));
    if (!matchingRole) continue;

    const value = args[argName];
    const roleDef = getRoleDefinition(matchingRole);
    if (typeof value === 'string') {
      urls.push({ value, role: matchingRole, roleDef });
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          urls.push({ value: item, role: matchingRole, roleDef });
        }
      }
    }
  }
  return urls;
}

/**
 * Applies the resolution pipeline for a URL-category value:
 *   1. resolveForPolicy(value, allArgs)  -- resolve named remote to URL
 *   2. normalize(resolvedValue)          -- canonicalize URL format
 *   3. prepareForPolicy(normalizedValue) -- extract domain for allowlist check
 */
function resolveUrlForDomainCheck(
  value: string,
  roleDef: RoleDefinition,
  allArgs: Record<string, unknown>,
): string {
  const resolved = roleDef.resolveForPolicy?.(value, allArgs) ?? value;
  const normalized = roleDef.normalize(resolved);
  return roleDef.prepareForPolicy?.(normalized) ?? normalized;
}

/**
 * Checks whether a domain matches any pattern in an allowlist.
 * Supports exact match, `*` wildcard (matches everything),
 * and `*.example.com` prefix wildcards (matches example.com and *.example.com).
 */
export function domainMatchesAllowlist(
  domain: string,
  allowedDomains: readonly string[],
): boolean {
  return allowedDomains.some(pattern => {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".github.com"
      return domain === pattern.slice(2) || domain.endsWith(suffix);
    }
    return domain === pattern;
  });
}

/**
 * Checks whether a rule has role-related conditions (roles, paths, or domains).
 * Rules without these conditions are role-agnostic and match any role.
 */
function hasRoleConditions(rule: CompiledRule): boolean {
  return rule.if.roles !== undefined || rule.if.paths !== undefined || rule.if.domains !== undefined;
}

/**
 * Checks whether a rule's role-related conditions include a specific role.
 * For `roles` conditions: the role must be in the list.
 * For `paths` conditions: the role must be in the paths.roles list.
 * For `domains` conditions: the role must be in the domains.roles list.
 */
function ruleRelevantToRole(rule: CompiledRule, role: ArgumentRole): boolean {
  const cond = rule.if;
  if (cond.roles !== undefined && !cond.roles.includes(role)) return false;
  if (cond.paths !== undefined && !cond.paths.roles.includes(role)) return false;
  if (cond.domains !== undefined && !cond.domains.roles.includes(role)) return false;
  return true;
}

export class PolicyEngine {
  private annotationMap: Map<string, ToolAnnotation>;
  private compiledPolicy: CompiledPolicyFile;
  private protectedPaths: string[];
  private allowedDirectory?: string;
  private serverDomainAllowlists: ReadonlyMap<string, readonly string[]>;

  constructor(
    compiledPolicy: CompiledPolicyFile,
    toolAnnotations: ToolAnnotationsFile,
    protectedPaths: string[],
    allowedDirectory?: string,
    serverDomainAllowlists?: ReadonlyMap<string, readonly string[]>,
  ) {
    this.compiledPolicy = compiledPolicy;
    this.protectedPaths = protectedPaths;
    this.allowedDirectory = allowedDirectory;
    this.serverDomainAllowlists = serverDomainAllowlists ?? new Map();
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

  /** Returns the annotation for a tool, or undefined if unknown. */
  getAnnotation(serverName: string, toolName: string): ToolAnnotation | undefined {
    return this.annotationMap.get(`${serverName}__${toolName}`);
  }

  evaluate(request: ToolCallRequest): EvaluationResult {
    // Phase 1: Structural invariants (may resolve some roles via sandbox containment)
    const structural = this.evaluateStructuralInvariants(request);
    if (structural.decision) return structural.decision;

    // Phase 2: Compiled rules (skipping sandbox-resolved roles)
    return this.evaluateCompiledRules(request, structural.sandboxResolvedRoles);
  }

  /**
   * Phase 1: Hardcoded structural invariants.
   *
   * 1a. Protected path check (deny)
   * 1b. Sandbox containment for path-category roles (allow/partial)
   * 1c. Domain allowlist for url-category roles (escalate)
   * 1d. Unknown tool denial (deny)
   *
   * Uses the union of heuristic and annotation-based path extraction
   * for defense-in-depth. Returns a StructuralResult with either a
   * final decision or a set of roles resolved by sandbox containment.
   */
  private evaluateStructuralInvariants(request: ToolCallRequest): StructuralResult {
    // Extract paths using both methods for defense-in-depth
    const heuristicPaths = extractPathsHeuristic(request.arguments);
    const annotation = this.annotationMap.get(`${request.serverName}__${request.toolName}`);

    // Phase 1a/1b use path-category roles only (not URL roles)
    const pathRoles = getPathRoles();
    const annotatedPaths = annotation
      ? extractAnnotatedPaths(request.arguments, annotation, pathRoles)
      : [];

    // Union of both extraction methods, deduplicated
    const allPaths = [...new Set([...heuristicPaths, ...annotatedPaths])];
    const resolvedPaths = allPaths.map(p => resolveRealPath(p));

    // Phase 1a: Protected paths -- any match is an immediate deny
    for (const rp of resolvedPaths) {
      if (isProtectedPath(rp, this.protectedPaths)) {
        return finalDecision({
          decision: 'deny',
          rule: 'structural-protected-path',
          reason: `Access to protected path is forbidden: ${rp}`,
        });
      }
    }

    // Phase 1b: Sandbox containment checks (path-category roles)
    //
    // The sandbox auto-allow decision uses annotated paths when annotations
    // exist (not heuristic paths). An arg annotated as 'none' should not
    // grant sandbox containment even if the value looks like a path.
    // Heuristic paths are only used for defense-in-depth on the deny side
    // (Phase 1a protected path check).
    //
    // Only SANDBOX_SAFE_PATH_ROLES (read-path, write-path, delete-path) can
    // be auto-resolved by sandbox containment. Higher-risk path roles like
    // write-history and delete-history always fall through to Phase 2.
    const sandboxResolvedRoles = new Set<ArgumentRole>();
    const resolvedSandboxPaths = annotation
      ? annotatedPaths.map(p => resolveRealPath(p))
      : resolvedPaths;

    // Extract URL args once for use in both Phase 1b (fast-path guard) and Phase 1c
    const urlArgs = annotation
      ? extractAnnotatedUrls(request.arguments, annotation, getUrlRoles())
      : [];

    // Determine if the tool has any non-sandbox-safe path roles
    const toolHasUnsafePathRoles = annotation
      ? pathRoles.some(role =>
          !SANDBOX_SAFE_PATH_ROLES.has(role) &&
          Object.values(annotation.args).some(argRoles => argRoles.includes(role)),
        )
      : false;

    if (this.allowedDirectory && resolvedSandboxPaths.length > 0) {
      // Fast path: all annotated paths within sandbox -> auto-allow
      // Only fires when ALL path roles are sandbox-safe and no URL roles need checking
      const allWithinSandbox = resolvedSandboxPaths.every(
        rp => isWithinDirectory(rp, this.allowedDirectory!),
      );

      if (allWithinSandbox && urlArgs.length === 0 && !toolHasUnsafePathRoles) {
        return finalDecision({
          decision: 'allow',
          rule: 'structural-sandbox-allow',
          reason: `All paths are within the sandbox directory: ${this.allowedDirectory}`,
        });
      }

      // Partial sandbox resolution: check each path role independently.
      // A role is "sandbox-resolved" if every path for that role is within
      // the sandbox. Only sandbox-safe roles can be resolved here.
      // Roles with zero extracted paths are not resolved.
      if (annotation) {
        for (const role of pathRoles) {
          if (!SANDBOX_SAFE_PATH_ROLES.has(role)) continue;
          const pathsForRole = extractAnnotatedPaths(request.arguments, annotation, [role]);
          if (pathsForRole.length > 0 && pathsForRole.every(p => isWithinDirectory(p, this.allowedDirectory!))) {
            sandboxResolvedRoles.add(role);
          }
        }
      }
    }

    // Phase 1c: Domain allowlist for URL-category roles
    if (urlArgs.length > 0) {
      const allowlist = this.serverDomainAllowlists.get(request.serverName);

      if (allowlist) {
        for (const { value, roleDef } of urlArgs) {
          const domain = resolveUrlForDomainCheck(value, roleDef, request.arguments);
          if (!domainMatchesAllowlist(domain, allowlist)) {
            return finalDecision({
              decision: 'escalate',
              rule: 'structural-domain-escalate',
              reason: `URL domain "${domain}" is not in the allowlist for server "${request.serverName}"`,
            });
          }
        }

        // All URLs passed domain check -- mark URL roles as resolved
        for (const { role } of urlArgs) {
          sandboxResolvedRoles.add(role);
        }
      }
      // If no allowlist, URL roles are not structurally restricted -- fall through to Phase 2
    }

    // Phase 1d: Unknown tool check
    if (!annotation) {
      return finalDecision({
        decision: 'deny',
        rule: 'structural-unknown-tool',
        reason: `Unknown tool: ${request.serverName}/${request.toolName}`,
      });
    }

    return { sandboxResolvedRoles: sandboxResolvedRoles.size > 0 ? sandboxResolvedRoles : NO_ROLES_RESOLVED };
  }

  /**
   * Phase 2: Evaluate compiled declarative rules.
   *
   * For tools with multiple roles (e.g., edit_file has read-path + write-path),
   * each role is evaluated independently through the rule chain. The most
   * restrictive result across all roles wins (deny > escalate > allow).
   * Roles already resolved by Phase 1 sandbox containment are skipped.
   *
   * For tools with no roles (e.g., list_allowed_directories), the chain is
   * evaluated once without role filtering.
   */
  private evaluateCompiledRules(
    request: ToolCallRequest,
    sandboxResolvedRoles: ReadonlySet<ArgumentRole>,
  ): EvaluationResult {
    const annotation = this.annotationMap.get(`${request.serverName}__${request.toolName}`)!;
    const allRoles = collectDistinctRoles(annotation);

    // Filter out roles already resolved by sandbox containment
    const rolesToEvaluate = allRoles.filter(r => !sandboxResolvedRoles.has(r));

    // All resource roles were sandbox-resolved → allow
    if (allRoles.length > 0 && rolesToEvaluate.length === 0) {
      return {
        decision: 'allow',
        rule: 'structural-sandbox-allow',
        reason: 'All path roles resolved by sandbox containment',
      };
    }

    if (rolesToEvaluate.length === 0) {
      // No resource roles at all (e.g., list_allowed_directories)
      return this.evaluateRulesForRole(request, annotation, undefined);
    }

    let mostRestrictive: EvaluationResult | undefined;
    for (const role of rolesToEvaluate) {
      const result = this.evaluateRulesForRole(request, annotation, role);
      if (result.decision === 'deny') return result;
      if (!mostRestrictive || DECISION_SEVERITY[result.decision] > DECISION_SEVERITY[mostRestrictive.decision]) {
        mostRestrictive = result;
      }
    }

    return mostRestrictive!;
  }

  /**
   * Evaluates the rule chain for a single role (or all roles if undefined).
   *
   * When evaluatingRole is set, only rules that are either role-agnostic
   * (no roles/paths conditions) or relevant to the specified role are
   * considered. First matching rule wins; default deny if none match.
   *
   * For roles with multiple extracted paths, delegates to
   * evaluateRulesForMultiPaths for per-element evaluation.
   */
  private evaluateRulesForRole(
    request: ToolCallRequest,
    annotation: ToolAnnotation,
    evaluatingRole: ArgumentRole | undefined,
  ): EvaluationResult {
    // Per-element evaluation: when a role has multiple paths, each path
    // is independently discharged by the first matching rule.
    if (evaluatingRole !== undefined) {
      const rolePaths = extractAnnotatedPaths(request.arguments, annotation, [evaluatingRole]);
      if (rolePaths.length > 1) {
        return this.evaluateRulesForMultiPaths(request, annotation, evaluatingRole, rolePaths);
      }
    }

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
   * Per-element path evaluation for roles with multiple paths.
   *
   * Each path is independently "discharged" by the first rule whose
   * paths.within contains it. Rules without path conditions match all
   * remaining paths. The most restrictive decision across all discharged
   * paths wins (deny > escalate > allow). Undischarged paths default-deny.
   */
  private evaluateRulesForMultiPaths(
    request: ToolCallRequest,
    annotation: ToolAnnotation,
    role: ArgumentRole,
    paths: string[],
  ): EvaluationResult {
    const remainingPaths = new Set(paths);
    let mostRestrictive: EvaluationResult | undefined;

    for (const rule of this.compiledPolicy.rules) {
      if (remainingPaths.size === 0) break;

      // Skip rules not relevant to this role
      if (hasRoleConditions(rule) && !ruleRelevantToRole(rule, role)) continue;

      // Skip rules whose non-path conditions don't match
      if (!this.ruleMatchesNonPathConditions(rule, request, annotation)) continue;

      const cond = rule.if;
      let matched: string[];

      if (cond.paths !== undefined) {
        // Rule has a path condition: discharge only paths within the directory
        matched = [];
        for (const p of remainingPaths) {
          if (isWithinDirectory(p, cond.paths.within)) {
            matched.push(p);
          }
        }
        if (matched.length === 0) continue;
      } else {
        // Rule has no path condition: matches all remaining paths
        matched = [...remainingPaths];
      }

      // Discharge matched paths and record decision
      for (const p of matched) remainingPaths.delete(p);

      const result: EvaluationResult = {
        decision: rule.then,
        rule: rule.name,
        reason: rule.reason,
      };
      if (!mostRestrictive || DECISION_SEVERITY[result.decision] > DECISION_SEVERITY[mostRestrictive.decision]) {
        mostRestrictive = result;
      }
    }

    // Any undischarged paths -> default-deny (deny is the most restrictive decision)
    if (remainingPaths.size > 0) {
      return {
        decision: 'deny',
        rule: 'default-deny',
        reason: 'No matching policy rule -- denied by default',
      };
    }

    return mostRestrictive!;
  }

  /**
   * Checks non-path conditions in a rule's `if` block: roles, server, tool, sideEffects.
   */
  private ruleMatchesNonPathConditions(
    rule: CompiledRule,
    request: ToolCallRequest,
    annotation: ToolAnnotation,
  ): boolean {
    const cond = rule.if;

    if (cond.roles !== undefined) {
      const toolHasMatchingRole = Object.values(annotation.args).some(
        argRoles => argRoles.some(r => cond.roles!.includes(r)),
      );
      if (!toolHasMatchingRole) return false;
    }

    if (cond.server !== undefined && !cond.server.includes(request.serverName)) {
      return false;
    }

    if (cond.tool !== undefined && !cond.tool.includes(request.toolName)) {
      return false;
    }

    if (cond.sideEffects !== undefined && annotation.sideEffects !== cond.sideEffects) {
      return false;
    }

    return true;
  }

  /**
   * Checks whether all conditions in a rule's `if` block are satisfied.
   */
  private ruleMatches(
    rule: CompiledRule,
    request: ToolCallRequest,
    annotation: ToolAnnotation,
  ): boolean {
    if (!this.ruleMatchesNonPathConditions(rule, request, annotation)) return false;

    // Check paths condition
    const cond = rule.if;
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

    // Check domains condition
    if (cond.domains !== undefined) {
      const urlArgs = extractAnnotatedUrls(request.arguments, annotation, cond.domains.roles);

      // Zero URL args extracted = condition not satisfied, rule does not match
      if (urlArgs.length === 0) return false;

      const allMatch = urlArgs.every(({ value, roleDef }) => {
        const domain = resolveUrlForDomainCheck(value, roleDef, request.arguments);
        return domainMatchesAllowlist(domain, cond.domains!.allowed);
      });
      if (!allMatch) return false;
    }

    return true;
  }
}
