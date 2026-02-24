/**
 * PolicyEngine -- Two-layer declarative policy evaluation.
 *
 * Structural checks: Hardcoded invariants (protected paths, unknown tools).
 *          These are never overridden by compiled rules. Sandbox containment
 *          is checked per-role: roles whose paths are all within the sandbox
 *          are resolved here and skipped in compiled rule evaluation.
 *
 * Compiled rule evaluation: Declarative rules loaded from compiled-policy.json.
 *          Each distinct role from the tool's annotation is evaluated
 *          independently through the rule chain (first-match-wins per role).
 *          The most restrictive result wins: deny > escalate > allow.
 *          Roles already resolved by sandbox containment are skipped.
 */

import type { ToolCallRequest, PolicyDecisionStatus } from '../types/mcp.js';
import type { EvaluationResult } from './policy-types.js';
import type {
  CompiledPolicyFile,
  DynamicListsFile,
  ResolvedList,
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
import { domainMatchesAllowlist, isIpAddress, resolveGitRemote, extractDomainForRole } from './domain-utils.js';
import { getListMatcher } from '../pipeline/dynamic-list-types.js';

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
 * Extracts string values from arguments based on annotation roles.
 * Only returns values for arguments whose annotated roles intersect
 * with the target roles. Handles both string and string[] arguments.
 * Used for paths, URLs, and list values alike.
 */
function extractAnnotatedPaths(
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  targetRoles: ArgumentRole[],
): string[] {
  const paths: string[] = [];
  for (const [argName, roles] of Object.entries(annotation.args)) {
    if (!roles.some((r) => targetRoles.includes(r))) continue;

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
  return protectedPaths.some((pp) => {
    const resolvedPP = resolveRealPath(pp);
    return realPath === resolvedPP || realPath.startsWith(resolvedPP + '/');
  });
}

/**
 * Result of structural invariant evaluation.
 *
 * Three possible outcomes:
 * 1. Final decision (deny for protected paths, allow if all paths in sandbox)
 * 2. Partial sandbox resolution (some roles' paths are all within sandbox)
 * 3. No structural match (empty sandboxResolvedRoles, fall through to compiled rule evaluation)
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
    const matchingRole = roles.find((r) => targetRoles.includes(r));
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
 *   1. Resolve indirection (git-remote-url: named remote → URL)
 *   2. Canonicalize URL format
 *   3. Extract domain for allowlist check
 *
 * Uses role identity to dispatch to the correct functions rather than
 * interface methods -- only 2 of 10 roles need URL-specific handling.
 */
function resolveUrlForDomainCheck(
  value: string,
  role: ArgumentRole,
  roleDef: RoleDefinition,
  allArgs: Record<string, unknown>,
): string {
  const resolved = role === 'git-remote-url' ? resolveGitRemote(value, allArgs) : value;
  const normalized = roleDef.canonicalize(resolved);
  return extractDomainForRole(normalized, role);
}

// Re-export utilities used by sibling modules (mcp-proxy-server, index)
export { domainMatchesAllowlist, extractAnnotatedPaths, isIpAddress };

/**
 * Checks whether a rule has role-related conditions (roles, paths, or domains).
 * Rules without these conditions are role-agnostic and match any role.
 */
function hasRoleConditions(rule: CompiledRule): boolean {
  return (
    rule.if.roles !== undefined ||
    rule.if.paths !== undefined ||
    rule.if.domains !== undefined ||
    (rule.if.lists !== undefined && rule.if.lists.length > 0)
  );
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
  if (cond.lists !== undefined && !cond.lists.some((lc) => lc.roles.includes(role))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Dynamic list expansion (load-time)
// ---------------------------------------------------------------------------

/**
 * Computes the effective values for a named list by combining resolved values,
 * manual additions, and manual removals:
 *   effective = (resolved.values + manualAdditions) - manualRemovals
 */
function getEffectiveListValues(listName: string, lists: DynamicListsFile): string[] {
  const list = lists.lists[listName] as ResolvedList | undefined;
  if (!list) {
    throw new Error(
      `Dynamic list "@${listName}" referenced in policy but not found in dynamic-lists.json. ` +
        `Run "ironcurtain compile-policy" to resolve lists.`,
    );
  }

  const removals = new Set(list.manualRemovals);
  return [...new Set([...list.values, ...list.manualAdditions])].filter((v) => !removals.has(v));
}

/**
 * Expands all `@list-name` references in compiled rules with concrete values
 * from the resolved dynamic lists. Called at load time so the evaluation hot
 * path never sees symbolic references.
 */
function expandListReferences(policy: CompiledPolicyFile, lists: DynamicListsFile): CompiledPolicyFile {
  const expandedRules = policy.rules.map((rule) => {
    let expandedRule = rule;

    // Expand @list-name in domains.allowed
    if (rule.if.domains?.allowed.some((e) => e.startsWith('@'))) {
      const ruleDomains = rule.if.domains;
      const expandedAllowed = ruleDomains.allowed.flatMap((entry) =>
        entry.startsWith('@') ? getEffectiveListValues(entry.slice(1), lists) : [entry],
      );
      expandedRule = {
        ...expandedRule,
        if: {
          ...expandedRule.if,
          domains: { ...ruleDomains, allowed: expandedAllowed },
        },
      };
    }

    // Expand @list-name in each lists[] entry
    if (rule.if.lists?.some((lc) => lc.allowed.some((e) => e.startsWith('@')))) {
      const expandedLists = rule.if.lists.map((listCond) => {
        if (!listCond.allowed.some((e) => e.startsWith('@'))) return listCond;
        const expandedAllowed = listCond.allowed.flatMap((entry) =>
          entry.startsWith('@') ? getEffectiveListValues(entry.slice(1), lists) : [entry],
        );
        return { ...listCond, allowed: expandedAllowed };
      });
      expandedRule = {
        ...expandedRule,
        if: { ...expandedRule.if, lists: expandedLists },
      };
    }

    return expandedRule;
  });

  return { ...policy, rules: expandedRules };
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
    dynamicLists?: DynamicListsFile,
  ) {
    this.compiledPolicy = dynamicLists ? expandListReferences(compiledPolicy, dynamicLists) : compiledPolicy;
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
    // Structural checks (may resolve some roles via sandbox containment)
    const structural = this.evaluateStructuralInvariants(request);
    if (structural.decision) return structural.decision;

    // Compiled rule evaluation (skipping sandbox-resolved roles)
    return this.evaluateCompiledRules(request, structural.sandboxResolvedRoles);
  }

  /**
   * Hardcoded structural invariants.
   *
   * 1. Protected path check (deny)
   * 2. Filesystem sandbox containment for path-category roles (allow/partial)
   * 3. Untrusted domain gate for url-category roles (escalate)
   * 4. Unknown tool denial (deny)
   *
   * Uses the union of heuristic and annotation-based path extraction
   * for defense-in-depth. Returns a StructuralResult with either a
   * final decision or a set of roles resolved by sandbox containment.
   */
  private evaluateStructuralInvariants(request: ToolCallRequest): StructuralResult {
    // Introspection tool: list_allowed_directories has no arguments and no
    // side effects — always allow it without requiring a compiled rule.
    if (request.toolName === 'list_allowed_directories') {
      return finalDecision({
        decision: 'allow',
        rule: 'structural-introspection-allow',
        reason: 'Introspection tool with no side effects is always allowed',
      });
    }

    // Extract paths using both methods for defense-in-depth
    const heuristicPaths = extractPathsHeuristic(request.arguments);
    const annotation = this.annotationMap.get(`${request.serverName}__${request.toolName}`);

    // Protected path check and sandbox containment use path-category roles only (not URL roles)
    const pathRoles = getPathRoles();
    const annotatedPaths = annotation ? extractAnnotatedPaths(request.arguments, annotation, pathRoles) : [];

    // Union of both extraction methods, deduplicated
    const allPaths = [...new Set([...heuristicPaths, ...annotatedPaths])];
    const resolvedPaths = allPaths.map((p) => resolveRealPath(p));

    // Protected path check -- any match is an immediate deny
    for (const rp of resolvedPaths) {
      if (isProtectedPath(rp, this.protectedPaths)) {
        return finalDecision({
          decision: 'deny',
          rule: 'structural-protected-path',
          reason: `Access to protected path is forbidden: ${rp}`,
        });
      }
    }

    // Filesystem sandbox containment (path-category roles)
    //
    // The sandbox auto-allow decision uses annotated paths when annotations
    // exist (not heuristic paths). An arg annotated as 'none' should not
    // grant sandbox containment even if the value looks like a path.
    // Heuristic paths are only used for defense-in-depth on the deny side
    // (protected path check).
    //
    // Only SANDBOX_SAFE_PATH_ROLES (read-path, write-path, delete-path) can
    // be auto-resolved by sandbox containment. Higher-risk path roles like
    // write-history and delete-history always fall through to compiled rule evaluation.
    const sandboxResolvedRoles = new Set<ArgumentRole>();
    const resolvedSandboxPaths = annotation ? annotatedPaths.map((p) => resolveRealPath(p)) : resolvedPaths;

    // Extract URL args once for use in both sandbox containment (fast-path guard) and untrusted domain gate
    const urlArgs = annotation ? extractAnnotatedUrls(request.arguments, annotation, getUrlRoles()) : [];

    // Determine if the tool has any non-sandbox-safe path roles
    const toolHasUnsafePathRoles = annotation
      ? pathRoles.some(
          (role) =>
            !SANDBOX_SAFE_PATH_ROLES.has(role) &&
            Object.values(annotation.args).some((argRoles) => argRoles.includes(role)),
        )
      : false;

    if (this.allowedDirectory && resolvedSandboxPaths.length > 0) {
      const sandboxDir = this.allowedDirectory;

      // Sandbox containment is only a structural allow for filesystem operations.
      // For other servers, paths are locators (e.g. "which repo dir") — the
      // operation itself needs compiled-rule evaluation regardless of path location.
      const isFilesystem = request.serverName === 'filesystem';

      // Fast path: all annotated paths within sandbox -> auto-allow (filesystem only)
      // Only fires when ALL path roles are sandbox-safe and no URL roles need checking
      const allWithinSandbox = resolvedSandboxPaths.every((rp) => isWithinDirectory(rp, sandboxDir));

      if (isFilesystem && allWithinSandbox && urlArgs.length === 0 && !toolHasUnsafePathRoles) {
        return finalDecision({
          decision: 'allow',
          rule: 'structural-sandbox-allow',
          reason: `All paths are within the sandbox directory: ${sandboxDir}`,
        });
      }

      // Partial sandbox resolution (filesystem only): check each path role
      // independently. A role is "sandbox-resolved" if every path for that
      // role is within the sandbox. Only sandbox-safe roles can be resolved.
      // Roles with zero extracted paths are not resolved.
      if (isFilesystem && annotation) {
        for (const role of pathRoles) {
          if (!SANDBOX_SAFE_PATH_ROLES.has(role)) continue;
          const pathsForRole = extractAnnotatedPaths(request.arguments, annotation, [role]);
          if (pathsForRole.length > 0 && pathsForRole.every((p) => isWithinDirectory(p, sandboxDir))) {
            sandboxResolvedRoles.add(role);
          }
        }
      }
    }

    // Untrusted domain gate for URL-category roles
    if (urlArgs.length > 0) {
      const allowlist = this.serverDomainAllowlists.get(request.serverName);

      if (allowlist) {
        for (const { value, role, roleDef } of urlArgs) {
          const domain = resolveUrlForDomainCheck(value, role, roleDef, request.arguments);
          if (!domainMatchesAllowlist(domain, allowlist)) {
            return finalDecision({
              decision: 'escalate',
              rule: 'structural-domain-escalate',
              reason: `URL domain "${domain}" is not in the allowlist for server "${request.serverName}"`,
            });
          }
        }

        // Domain check passed — but this only means "not suspicious enough
        // to block structurally." URL roles are NOT marked as resolved;
        // compiled rules still evaluate the operation (e.g. "escalate all git push").
      }
      // If no allowlist, URL roles are not structurally restricted -- fall through to compiled rule evaluation
    }

    // Unknown tool denial
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
   * Compiled rule evaluation: evaluate declarative rules from compiled-policy.json.
   *
   * For tools with multiple roles (e.g., edit_file has read-path + write-path),
   * each role is evaluated independently through the rule chain. The most
   * restrictive result across all roles wins (deny > escalate > allow).
   * Roles already resolved by sandbox containment are skipped.
   *
   * For tools with no roles (e.g., list_allowed_directories), the chain is
   * evaluated once without role filtering.
   */
  private evaluateCompiledRules(
    request: ToolCallRequest,
    sandboxResolvedRoles: ReadonlySet<ArgumentRole>,
  ): EvaluationResult {
    const annotation = this.annotationMap.get(`${request.serverName}__${request.toolName}`);
    if (!annotation) {
      throw new Error(`Missing annotation for ${request.serverName}/${request.toolName} in compiled rule evaluation`);
    }
    const allRoles = collectDistinctRoles(annotation);

    // Filter out roles already resolved by sandbox containment
    const rolesToEvaluate = allRoles.filter((r) => !sandboxResolvedRoles.has(r));

    // All resource roles were sandbox-resolved → allow
    if (allRoles.length > 0 && rolesToEvaluate.length === 0) {
      return {
        decision: 'allow',
        rule: 'structural-sandbox-allow',
        reason: 'All path roles resolved by sandbox containment',
      };
    }

    if (rolesToEvaluate.length === 0) {
      // No resource roles at all (e.g., list_allowed_directories).
      // Run a plain first-match-wins scan with no role scoping.
      return this.evaluateRulesUnscoped(request, annotation);
    }

    let mostRestrictive: EvaluationResult | undefined;
    for (const role of rolesToEvaluate) {
      const result = this.evaluateRulesForRole(request, annotation, role);
      if (result.decision === 'deny') return result;
      if (!mostRestrictive || DECISION_SEVERITY[result.decision] > DECISION_SEVERITY[mostRestrictive.decision]) {
        mostRestrictive = result;
      }
    }

    if (!mostRestrictive) {
      throw new Error('unreachable: rolesToEvaluate was non-empty but no result was produced');
    }
    return mostRestrictive;
  }

  /**
   * Plain first-match-wins rule scan with no role scoping.
   * Used for tools that have no resource roles (e.g., list_allowed_directories).
   */
  private evaluateRulesUnscoped(request: ToolCallRequest, annotation: ToolAnnotation): EvaluationResult {
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
   * Evaluates the rule chain for a single role.
   *
   * Only rules that are either role-agnostic (no roles/paths conditions)
   * or relevant to the specified role are considered. Path extraction is
   * scoped to the evaluating role so each role can be independently
   * discharged by different rules. First matching rule wins; default deny
   * if none match.
   *
   * For roles with multiple extracted paths, delegates to
   * evaluateRulesForMultiPaths for per-element evaluation.
   */
  private evaluateRulesForRole(
    request: ToolCallRequest,
    annotation: ToolAnnotation,
    evaluatingRole: ArgumentRole,
  ): EvaluationResult {
    // Per-element evaluation: when a role has multiple paths, each path
    // is independently discharged by the first matching rule.
    const rolePaths = extractAnnotatedPaths(request.arguments, annotation, [evaluatingRole]);
    if (rolePaths.length > 1) {
      return this.evaluateRulesForMultiPaths(request, annotation, evaluatingRole, rolePaths);
    }

    for (const rule of this.compiledPolicy.rules) {
      if (hasRoleConditions(rule) && !ruleRelevantToRole(rule, evaluatingRole)) {
        continue;
      }
      if (this.ruleMatches(rule, request, annotation, evaluatingRole)) {
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

    // Any undischarged paths -> default-deny
    if (remainingPaths.size > 0) {
      return {
        decision: 'deny',
        rule: 'default-deny',
        reason: 'No matching policy rule -- denied by default',
      };
    }

    if (!mostRestrictive) {
      throw new Error('unreachable: all paths discharged but no result was produced');
    }
    return mostRestrictive;
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
      const condRoles = cond.roles;
      const toolHasMatchingRole = Object.values(annotation.args).some((argRoles) =>
        argRoles.some((r) => condRoles.includes(r)),
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
   *
   * When evaluatingRole is set, path/domain/list extraction is scoped to
   * just that role. This allows a multi-role tool (e.g., move_file with
   * read-path + delete-path on source, write-path on destination) to have
   * each role independently discharged by different rules targeting
   * different directories.
   */
  private ruleMatches(
    rule: CompiledRule,
    request: ToolCallRequest,
    annotation: ToolAnnotation,
    evaluatingRole?: ArgumentRole,
  ): boolean {
    if (!this.ruleMatchesNonPathConditions(rule, request, annotation)) return false;

    // Check paths condition
    const cond = rule.if;
    if (cond.paths !== undefined) {
      const condPaths = cond.paths;
      // When evaluating a specific role, only extract paths for that role
      // (intersected with the rule's declared roles). Otherwise extract all.
      const extractRoles = evaluatingRole ? [evaluatingRole] : condPaths.roles;
      const extracted = extractAnnotatedPaths(request.arguments, annotation, extractRoles);

      // Zero paths extracted = condition not satisfied, rule does not match
      if (extracted.length === 0) return false;

      // isWithinDirectory resolves paths internally, no pre-resolution needed
      const allWithin = extracted.every((p) => isWithinDirectory(p, condPaths.within));
      if (!allWithin) return false;
    }

    // Check domains condition
    if (cond.domains !== undefined) {
      const condDomains = cond.domains;
      const extractRoles = evaluatingRole ? [evaluatingRole] : condDomains.roles;
      const urlArgs = extractAnnotatedUrls(request.arguments, annotation, extractRoles);

      // Zero URL args extracted = condition not satisfied, rule does not match
      if (urlArgs.length === 0) return false;

      const allMatch = urlArgs.every(({ value, role, roleDef }) => {
        const domain = resolveUrlForDomainCheck(value, role, roleDef, request.arguments);
        return domainMatchesAllowlist(domain, condDomains.allowed);
      });
      if (!allMatch) return false;
    }

    // Check lists conditions (non-domain list matching)
    if (cond.lists !== undefined) {
      for (const listCond of cond.lists) {
        const extractRoles = evaluatingRole ? [evaluatingRole] : listCond.roles;
        const extractedValues = extractAnnotatedPaths(request.arguments, annotation, extractRoles);

        // Zero values extracted = condition not satisfied, rule does not match
        if (extractedValues.length === 0) return false;

        const matcher = getListMatcher(listCond.matchType);
        const allValuesMatch = extractedValues.every((v) => listCond.allowed.some((pattern) => matcher(v, pattern)));
        if (!allValuesMatch) return false;
      }
    }

    return true;
  }
}
