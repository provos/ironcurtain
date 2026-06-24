/**
 * src/persona/broad-policy-validator.ts
 *
 * Broad-policy validator (Phase 1c, §7). Passed as the `validateCompiled` hook
 * to `compilePersonaPolicy` by the persona-compile orchestrator. It runs on the
 * in-memory `CompiledPolicyFile` BEFORE any artifact is written, so a rejection
 * leaves the prior generation's files intact (no partial write).
 *
 * It defeats constitution prompt-injection toward an over-permissive policy in a
 * way that is fully LLM-independent: it inspects the COMPILED rules, not the
 * constitution text. A persona may only emit a "broad" policy if it has been
 * explicitly opted in via the gated `personas.setBroadPolicyOptIn` flow
 * (`persona.allowBroadPolicy === true`). Otherwise the following are rejected:
 *
 *   - any "broad wildcard" `domains.allowed` entry (see isBroadDomainPattern),
 *   - any "broad wildcard" `lists[].allowed` entry,
 *   - any `paths.within` that resolves OUTSIDE the persona's workspace dir.
 *
 * A "broad wildcard" is not just the literal `*`. The runtime matcher
 * (domainMatchesAllowlist in trusted-process/domain-utils.ts) treats any
 * `*.`-prefixed pattern as a hostname suffix match, and the compiler is
 * explicitly allowed to emit prefix wildcards (`*.example.com`). A TLD-level
 * wildcard like `*.com`, `*.gov`, or the empty-suffix `*.` therefore grants
 * near-wildcard egress and must be treated as broad — only a wildcard whose
 * suffix has TWO OR MORE labels (e.g. `*.github.com`, scoped to a single
 * registered domain) is considered narrow and allowed without opt-in.
 *
 * Rejection throws {@link BroadPolicyRejectedError}; the orchestrator maps the
 * `code` (`BROAD_POLICY_REJECTED`) onto a terminal `persona.compile.failed`
 * event.
 *
 * ZERO runtime value-imports from src/pipeline — the `CompiledPolicyFile` shape
 * is a type-only import. Path containment uses the live-layer `resolveRealPath`
 * helper (symlink-aware), consistent with the policy engine.
 *
 * @see docs/designs/web-ui-policy-persona-management.md §7
 */

import { resolveRealPath } from '../types/argument-roles.js';
import type { ErrorCode } from '../web-ui/web-ui-types.js';
// Type-only — no runtime edge to pipeline.
import type { CompiledPolicyFile } from '../pipeline/types.js';

/** Thrown when a compiled policy is "broad" but the persona is not opted in. */
export class BroadPolicyRejectedError extends Error {
  readonly code: ErrorCode = 'BROAD_POLICY_REJECTED';
  constructor(
    message: string,
    readonly data?: { broadenedDomains: string[]; outOfWorkspacePaths: string[] },
  ) {
    super(message);
    this.name = 'BroadPolicyRejectedError';
  }
}

/** Findings produced by inspecting a compiled policy for broadening. */
export interface BroadPolicyFindings {
  /**
   * Broad-wildcard entries found in any `domains.allowed` or `lists[].allowed`
   * (the literal pattern, e.g. `*`, `*.`, `*.com`). See {@link isBroadDomainPattern}.
   */
  readonly broadenedDomains: string[];
  /** `paths.within` values resolving outside the workspace dir. */
  readonly outOfWorkspacePaths: string[];
}

/**
 * Returns true iff `pattern` grants near-wildcard egress and therefore requires
 * the broad-policy opt-in. This mirrors the runtime matcher semantics in
 * `domainMatchesAllowlist` (trusted-process/domain-utils.ts), where `*` matches
 * any non-IP host and `*.<suffix>` matches every host ending in `.<suffix>`.
 *
 * Broad (rejected without opt-in):
 *   - `*`            — matches every (non-IP) host
 *   - `*.`           — empty suffix; `endsWith('.')` matches ~everything
 *   - `*.com`/`*.gov`— TLD-only suffix (<= 1 label after the `*.`)
 *
 * Narrow (allowed without opt-in):
 *   - `*.github.com` — suffix has >= 2 labels (one registered domain)
 *   - `github.com`   — bare hostname (no wildcard)
 */
export function isBroadDomainPattern(pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.startsWith('*.')) return false;
  const suffix = pattern.slice(2); // drop the leading "*."
  // Empty or single-label suffix (TLD-only) => broad. Count non-empty labels.
  const labels = suffix.split('.').filter((l) => l.length > 0);
  return labels.length <= 1;
}

/**
 * Inspects a compiled policy and returns the set of "broad" findings. Pure /
 * side-effect-free so it can also feed the ruleDelta computation. A path is
 * "out of workspace" iff its real-resolved form is neither the workspace dir nor
 * a descendant of it.
 */
export function findBroadPolicy(policy: CompiledPolicyFile, workspaceDir: string): BroadPolicyFindings {
  const broadenedDomains = new Set<string>();
  const outOfWorkspacePaths = new Set<string>();

  const workspaceReal = resolveRealPath(workspaceDir);

  for (const rule of policy.rules) {
    const cond = rule.if;
    // Wildcard domains (record the actual broad pattern, not just '*').
    if (cond.domains?.allowed) {
      for (const d of cond.domains.allowed) {
        if (isBroadDomainPattern(d)) broadenedDomains.add(d);
      }
    }
    // Wildcard list allowances.
    if (cond.lists) {
      for (const list of cond.lists) {
        for (const v of list.allowed) {
          if (isBroadDomainPattern(v)) broadenedDomains.add(v);
        }
      }
    }
    // Out-of-workspace path containment.
    if (cond.paths?.within) {
      const within = cond.paths.within;
      const withinReal = resolveRealPath(within);
      const contained = withinReal === workspaceReal || withinReal.startsWith(workspaceReal + '/');
      if (!contained) outOfWorkspacePaths.add(within);
    }
  }

  return {
    broadenedDomains: [...broadenedDomains],
    outOfWorkspacePaths: [...outOfWorkspacePaths],
  };
}

/**
 * Builds a `validateCompiled` hook bound to a persona's workspace dir and
 * opt-in flag. When `allowBroadPolicy` is true the hook is a no-op (broadening
 * is permitted); otherwise it throws {@link BroadPolicyRejectedError} on any
 * broad finding.
 */
export function makeBroadPolicyValidator(
  workspaceDir: string,
  allowBroadPolicy: boolean,
): (policy: CompiledPolicyFile) => void {
  return (policy: CompiledPolicyFile): void => {
    if (allowBroadPolicy) return;
    const findings = findBroadPolicy(policy, workspaceDir);
    if (findings.broadenedDomains.length === 0 && findings.outOfWorkspacePaths.length === 0) {
      return;
    }
    const parts: string[] = [];
    if (findings.broadenedDomains.length > 0) {
      parts.push(`broad wildcard domain/list access: ${findings.broadenedDomains.join(', ')}`);
    }
    if (findings.outOfWorkspacePaths.length > 0) {
      parts.push(`out-of-workspace path(s): ${findings.outOfWorkspacePaths.join(', ')}`);
    }
    throw new BroadPolicyRejectedError(
      `Compiled policy is too broad (${parts.join('; ')}). Enable broad policy for this persona to allow it.`,
      { broadenedDomains: findings.broadenedDomains, outOfWorkspacePaths: findings.outOfWorkspacePaths },
    );
  };
}
