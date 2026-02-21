/**
 * List Type Registry -- taxonomy of dynamic list value types.
 *
 * Each type determines:
 * - How values are validated during resolution
 * - What format guidance is appended to the generation prompt
 * - How values are matched against tool call arguments at evaluation time
 */

import type { ListType } from './types.js';
import { domainMatchesAllowlist } from '../trusted-process/domain-utils.js';

export interface ListTypeDef {
  readonly description: string;

  /**
   * Validates that a resolved value is well-formed for this type.
   * Used during resolution to filter out malformed LLM output.
   */
  readonly validate: (value: string) => boolean;

  /**
   * Suffix mechanically appended to the generation prompt when the
   * resolver LLM is called. The compiler LLM does NOT include format
   * instructions in its generationPrompt -- the type registry handles
   * this automatically based on the list type.
   */
  readonly formatGuidance: string;
}

/**
 * Validates a hostname or wildcard hostname pattern.
 * Accepts bare hostnames (e.g., "example.com") and wildcard prefixes
 * (e.g., "*.example.com"). Rejects whitespace, protocols, and paths.
 */
function isValidDomain(value: string): boolean {
  if (value.length === 0 || /\s/.test(value)) return false;
  // Strip leading wildcard prefix for validation
  const hostname = value.startsWith('*.') ? value.slice(2) : value;
  if (hostname.length === 0) return false;
  // Reject protocol prefixes and paths
  if (hostname.includes('://') || hostname.includes('/')) return false;
  // Basic hostname character check: labels separated by dots
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(hostname);
}

function isValidEmail(value: string): boolean {
  return value.includes('@') && !/\s/.test(value) && value.length > 2;
}

function isValidIdentifier(value: string): boolean {
  return value.length > 0 && !/\s/.test(value);
}

export const LIST_TYPE_REGISTRY: ReadonlyMap<ListType, ListTypeDef> = new Map<ListType, ListTypeDef>([
  [
    'domains',
    {
      description: 'Domain names or wildcard domain patterns',
      validate: isValidDomain,
      formatGuidance: 'Return domain names or wildcard patterns like `*.example.com`.',
    },
  ],
  [
    'emails',
    {
      description: 'Email addresses',
      validate: isValidEmail,
      formatGuidance: 'Return email addresses in `user@domain` format.',
    },
  ],
  [
    'identifiers',
    {
      description: 'Plain string identifiers',
      validate: isValidIdentifier,
      formatGuidance: 'Return identifiers as plain strings, one per entry.',
    },
  ],
]);

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
