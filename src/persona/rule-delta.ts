/**
 * src/persona/rule-delta.ts
 *
 * Computes a {@link RuleDeltaDto} between a persona's previous compiled policy
 * and the freshly compiled one (Phase 1c, §7). Surfaced on the `done` event so a
 * reviewer can see, after the fact, exactly how a recompile changed the policy —
 * in particular any broadening that an `allowBroadPolicy` persona was permitted
 * to introduce.
 *
 * The diff is structural, keyed by rule `name` (the compiler's stable rule id):
 *   - `added`    rules present only in the new policy;
 *   - `removed`  rules present only in the old policy;
 *   - `loosened` rules present in both whose access widened (a `deny`/`escalate`
 *                that became `allow`, or that gained a wildcard domain/list).
 * The broadening detail fields (`broadenedDomains` / `outOfWorkspacePaths`)
 * reuse {@link findBroadPolicy} on the NEW policy so they always describe the
 * resulting policy's broad surface.
 *
 * ZERO runtime value-imports from src/pipeline — `CompiledPolicyFile` is a
 * type-only import.
 */

import { findBroadPolicy } from './broad-policy-validator.js';
import type { RuleDeltaDto } from '../web-ui/web-ui-types.js';
// Type-only — no runtime edge to pipeline.
import type { CompiledPolicyFile, CompiledRule } from '../pipeline/types.js';

/** True iff a rule grants a wildcard domain or list allowance. */
function hasWildcard(rule: CompiledRule): boolean {
  if (rule.if.domains?.allowed.includes('*')) return true;
  if (rule.if.lists) {
    for (const l of rule.if.lists) if (l.allowed.includes('*')) return true;
  }
  return false;
}

/**
 * Heuristic "loosened" check for a rule present in both policies. A rule is
 * loosened if its decision moved toward `allow`, or if it newly gained a
 * wildcard allowance.
 */
function isLoosened(oldRule: CompiledRule, newRule: CompiledRule): boolean {
  const decisionLoosened = oldRule.then !== 'allow' && newRule.then === 'allow';
  const wildcardGained = !hasWildcard(oldRule) && hasWildcard(newRule);
  return decisionLoosened || wildcardGained;
}

/**
 * Computes the structural delta between `oldPolicy` (may be undefined on the
 * first compile) and `newPolicy`. When `oldPolicy` is undefined the caller
 * should omit the delta entirely (there is nothing to diff); this function
 * still returns a well-formed all-added delta for completeness.
 */
export function computeRuleDelta(
  oldPolicy: CompiledPolicyFile | undefined,
  newPolicy: CompiledPolicyFile,
  workspaceDir: string,
): RuleDeltaDto {
  const oldByName = new Map<string, CompiledRule>();
  for (const r of oldPolicy?.rules ?? []) oldByName.set(r.name, r);
  const newByName = new Map<string, CompiledRule>();
  for (const r of newPolicy.rules) newByName.set(r.name, r);

  let added = 0;
  let removed = 0;
  let loosened = 0;

  for (const [name, newRule] of newByName) {
    const oldRule = oldByName.get(name);
    if (!oldRule) {
      added += 1;
    } else if (isLoosened(oldRule, newRule)) {
      loosened += 1;
    }
  }
  for (const name of oldByName.keys()) {
    if (!newByName.has(name)) removed += 1;
  }

  const findings = findBroadPolicy(newPolicy, workspaceDir);

  return {
    added,
    removed,
    loosened,
    broadenedDomains: findings.broadenedDomains,
    outOfWorkspacePaths: findings.outOfWorkspacePaths,
  };
}
