/**
 * List matcher -- runtime value/pattern matching for dynamic list types.
 *
 * Used by the PolicyEngine when evaluating `ListCondition` rules: given a
 * `ListType`, returns a comparator that tests whether a tool-call argument
 * value matches an entry from the resolved allow list.
 *
 * Lives in the trusted-process layer (not the offline pipeline) because it
 * runs on the policy hot path. The compile-time concerns (validators,
 * format guidance, the type registry) stay in `src/pipeline/dynamic-list-types.ts`.
 */

import type { ListType } from '../pipeline/types.js';
import { domainMatchesAllowlist } from './domain-utils.js';

/**
 * Returns a matcher function for the given list type.
 * The matcher checks whether a value matches a pattern from the allowed list.
 */
export function getListMatcher(type: ListType): (value: string, pattern: string) => boolean {
  switch (type) {
    case 'domains':
      return (v, p) => domainMatchesAllowlist(v, [p]);
    case 'emails':
      return (v, p) => v.toLowerCase() === p.toLowerCase();
    case 'identifiers':
      return (v, p) => v === p;
  }
}
