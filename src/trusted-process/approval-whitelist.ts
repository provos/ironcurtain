/**
 * Ephemeral approval whitelist -- session-scoped in-memory store
 * of approval patterns extracted from user-approved escalations.
 *
 * Security invariant: only converts escalate -> allow, never overrides deny.
 * Entries are never persisted to disk.
 */

import { dirname } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { ArgumentRole } from '../types/argument-roles.js';
import { resolveRealPath, getRoleDefinition, isWithinDirectory } from '../types/argument-roles.js';
import { extractDomainForRole } from './domain-utils.js';
import { extractAnnotatedPaths, collectDistinctRoles } from './policy-engine.js';
import type { ToolAnnotation } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Unique identifier for a whitelist entry, for audit trail linkage. */
export type WhitelistEntryId = string & { readonly __brand: 'WhitelistEntryId' };

/**
 * A constraint on a single argument role's value.
 * Discriminated union by `kind`.
 */
export type WhitelistConstraint =
  | {
      readonly kind: 'directory';
      readonly role: ArgumentRole;
      /** Resolved real path of the containing directory. */
      readonly directory: string;
    }
  | {
      readonly kind: 'domain';
      readonly role: ArgumentRole;
      /** Extracted domain (e.g., "github.com"). */
      readonly domain: string;
    }
  | {
      readonly kind: 'exact';
      readonly role: ArgumentRole;
      /** Exact value to match (case-insensitive for identifier roles). */
      readonly value: string;
    };

/**
 * A whitelist pattern extracted from an approved escalation.
 * Matches future calls to the same server/tool with arguments
 * satisfying all constraints.
 */
export interface WhitelistPattern {
  readonly id: WhitelistEntryId;
  readonly serverName: string;
  readonly toolName: string;
  readonly constraints: readonly WhitelistConstraint[];
  /** ISO 8601 timestamp when the pattern was created. */
  readonly createdAt: string;
  /** The escalation ID that produced this pattern (for audit linkage). */
  readonly sourceEscalationId: string;
  /** The original escalation reason (preserved for audit). */
  readonly originalReason: string;
  /** Human-readable description of the pattern. */
  readonly description: string;
}

/**
 * JSON-serializable candidate description for IPC.
 * Included in the escalation request file so the user sees
 * exactly what will be whitelisted.
 */
export interface WhitelistCandidateIpc {
  /** Human-readable summary, e.g. "Allow write_file within /home/user/Documents" */
  readonly description: string;
  /** Warning for zero-constraint side-effectful patterns. */
  readonly warning?: string;
}

/**
 * Result of a whitelist match check.
 */
export type WhitelistMatchResult =
  | { readonly matched: false }
  | { readonly matched: true; readonly patternId: WhitelistEntryId; readonly pattern: WhitelistPattern };

/** Default whitelist options: select the first (and currently only) candidate. */
export const DEFAULT_WHITELIST_OPTIONS = { whitelistSelection: 0 } as const;

/**
 * The ephemeral whitelist store. Session-scoped, in-memory only.
 */
export interface ApprovalWhitelist {
  /**
   * Adds a pattern to the whitelist.
   * Returns the pattern ID for audit linkage.
   */
  add(pattern: Omit<WhitelistPattern, 'id'>): WhitelistEntryId;

  /**
   * Checks whether a tool call matches any whitelist pattern.
   * Returns the matching pattern if found.
   */
  match(
    serverName: string,
    toolName: string,
    resolvedArgs: Record<string, unknown>,
    annotation: ToolAnnotation,
  ): WhitelistMatchResult;

  /** Returns all active patterns (for diagnostics/testing). */
  entries(): readonly WhitelistPattern[];

  /** Number of active patterns. */
  readonly size: number;
}

// ---------------------------------------------------------------------------
// History-rewriting roles excluded from directory generalization
// ---------------------------------------------------------------------------

const HISTORY_REWRITING_ROLES: ReadonlySet<ArgumentRole> = new Set(['write-history', 'delete-history']);

// ---------------------------------------------------------------------------
// Constraint matching
// ---------------------------------------------------------------------------

/**
 * Checks whether a single constraint is satisfied by the tool call's arguments.
 */
function constraintMatches(
  constraint: WhitelistConstraint,
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
): boolean {
  // Find all argument values for the constraint's role
  const values = extractAnnotatedPaths(args, annotation, [constraint.role]);
  if (values.length === 0) return false;

  switch (constraint.kind) {
    case 'directory':
      return values.every((v) => {
        try {
          return isWithinDirectory(v, constraint.directory);
        } catch {
          return false;
        }
      });
    case 'domain': {
      const roleDef = getRoleDefinition(constraint.role);
      return values.every((v) => {
        try {
          const normalized = roleDef.canonicalize(v);
          const domain = extractDomainForRole(normalized, constraint.role);
          return domain.toLowerCase() === constraint.domain.toLowerCase();
        } catch {
          return false;
        }
      });
    }
    case 'exact':
      return values.every((v) => v.toLowerCase() === constraint.value.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// Pattern extraction
// ---------------------------------------------------------------------------

/**
 * Extracts whitelist candidate patterns from an escalated tool call.
 *
 * Only generates constraints for the role(s) that caused the escalation,
 * as identified by `escalatedRoles` on the EvaluationResult.
 *
 * Falls back to all resource-identifier roles when `escalatedRoles` is
 * undefined (defensive robustness for future structural escalation paths).
 *
 * Returns both:
 * - WhitelistPattern[] (full patterns, stored in proxy memory -- without id, added on whitelist.add())
 * - WhitelistCandidateIpc[] (descriptions, serialized into IPC file)
 */
export function extractWhitelistCandidates(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  escalatedRoles: readonly ArgumentRole[] | undefined,
  escalationId: string,
  escalationReason: string,
): { patterns: Array<Omit<WhitelistPattern, 'id'>>; ipcs: WhitelistCandidateIpc[] } {
  // Determine which roles to extract constraints for
  const rolesToExtract = escalatedRoles ?? collectDistinctRoles(annotation);

  const constraints = buildConstraints(rolesToExtract, args, annotation);
  const description = buildDescription(serverName, toolName, constraints);
  const warning = buildWarning(annotation, constraints);

  const pattern: Omit<WhitelistPattern, 'id'> = {
    serverName,
    toolName,
    constraints,
    createdAt: new Date().toISOString(),
    sourceEscalationId: escalationId,
    originalReason: escalationReason,
    description,
  };

  const ipc: WhitelistCandidateIpc = {
    description,
    ...(warning ? { warning } : {}),
  };

  // Phase 1: returns a single candidate pattern. The array-based return type and
  // whitelistSelection index in the IPC protocol are designed to support future
  // multi-candidate expansion (e.g., "allow this directory" vs "allow this exact file").
  return { patterns: [pattern], ipcs: [ipc] };
}

/**
 * Builds constraints from escalated roles and argument values.
 */
function buildConstraints(
  roles: readonly ArgumentRole[],
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
): WhitelistConstraint[] {
  const constraints: WhitelistConstraint[] = [];
  const seen = new Set<string>();

  for (const role of roles) {
    const roleDef = getRoleDefinition(role);
    const values = extractAnnotatedPaths(args, annotation, [role]);

    for (const value of values) {
      const constraint = buildConstraintForRole(role, roleDef.category, value);
      if (!constraint) continue;

      // Deduplicate constraints with identical kind/role/value
      const key = constraintKey(constraint);
      if (seen.has(key)) continue;
      seen.add(key);
      constraints.push(constraint);
    }
  }

  return constraints;
}

/** Returns a stable string key for deduplication. */
function constraintKey(c: WhitelistConstraint): string {
  switch (c.kind) {
    case 'directory':
      return `dir:${c.role}:${c.directory}`;
    case 'domain':
      return `dom:${c.role}:${c.domain}`;
    case 'exact':
      return `exact:${c.role}:${c.value}`;
  }
}

/**
 * Builds a single constraint for a role and value, applying the
 * appropriate generalization for the role's category.
 */
function buildConstraintForRole(role: ArgumentRole, category: string, value: string): WhitelistConstraint | undefined {
  switch (category) {
    case 'path': {
      // History-rewriting roles are excluded from directory generalization
      if (HISTORY_REWRITING_ROLES.has(role)) return undefined;
      try {
        // Note: resolveRealPath uses realpath for existing paths and path.resolve
        // for non-existent ones. If a file is created after whitelisting, the resolved
        // real path at match time may differ (e.g., through new symlinks). This is
        // acceptable for phase 1 -- the constraint still provides meaningful scoping.
        const resolvedPath = resolveRealPath(value);
        const dir = dirname(resolvedPath);
        return { kind: 'directory', role, directory: dir };
      } catch {
        return undefined;
      }
    }
    case 'url': {
      try {
        const roleDef = getRoleDefinition(role);
        const normalized = roleDef.canonicalize(value);
        const domain = extractDomainForRole(normalized, role);
        return { kind: 'domain', role, domain };
      } catch {
        return undefined;
      }
    }
    case 'identifier':
      return { kind: 'exact', role, value: value.toLowerCase() };
    default:
      return undefined;
  }
}

/**
 * Builds a human-readable description from constraints.
 */
function buildDescription(serverName: string, toolName: string, constraints: readonly WhitelistConstraint[]): string {
  if (constraints.length === 0) {
    return `Allow ${serverName}/${toolName} (exact tool match only)`;
  }

  const parts = constraints.map((c) => {
    switch (c.kind) {
      case 'directory':
        return `${c.role} within ${c.directory}`;
      case 'domain':
        return `${c.role} domain ${c.domain}`;
      case 'exact':
        return `${c.role}=${c.value}`;
    }
  });

  return `Allow ${serverName}/${toolName} ${parts.join(', ')}`;
}

/**
 * Generates a warning for zero-constraint side-effectful tools.
 */
function buildWarning(annotation: ToolAnnotation, constraints: readonly WhitelistConstraint[]): string | undefined {
  if (constraints.length === 0 && annotation.sideEffects) {
    return 'Whitelisting will auto-approve ALL future calls to this tool for this session.';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an in-memory approval whitelist.
 */
export function createApprovalWhitelist(): ApprovalWhitelist {
  const patterns: WhitelistPattern[] = [];

  return {
    add(patternData: Omit<WhitelistPattern, 'id'>): WhitelistEntryId {
      const id = uuidv4() as WhitelistEntryId;
      const pattern: WhitelistPattern = { ...patternData, id };
      patterns.push(pattern);
      return id;
    },

    match(
      serverName: string,
      toolName: string,
      resolvedArgs: Record<string, unknown>,
      annotation: ToolAnnotation,
    ): WhitelistMatchResult {
      for (const pattern of patterns) {
        if (pattern.serverName !== serverName) continue;
        if (pattern.toolName !== toolName) continue;

        // All constraints must match (AND semantics)
        const allMatch =
          pattern.constraints.length === 0 ||
          pattern.constraints.every((c) => constraintMatches(c, resolvedArgs, annotation));

        if (allMatch) {
          return { matched: true, patternId: pattern.id, pattern };
        }
      }
      return { matched: false };
    },

    entries(): readonly WhitelistPattern[] {
      return patterns;
    },

    get size(): number {
      return patterns.length;
    },
  };
}
