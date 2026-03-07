/**
 * Persona types -- named profiles bundling a constitution and compiled
 * policy under ~/.ironcurtain/personas/<name>/.
 *
 * Follows the same branded-type pattern as JobId in src/cron/types.ts.
 */

/**
 * Regex for valid persona names: 1-63 chars, lowercase alphanumeric,
 * hyphens, or underscores. Same rules as JobId.
 */
export const PERSONA_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * Branded persona name to prevent mixing with other string identifiers.
 */
export type PersonaName = string & { readonly __brand: 'PersonaName' };

/**
 * Validates and creates a PersonaName from a user-provided string.
 */
export function createPersonaName(raw: string): PersonaName {
  if (!PERSONA_NAME_PATTERN.test(raw)) {
    throw new Error(
      `Invalid persona name "${raw}": must be 1-63 chars, ` +
        `lowercase alphanumeric, hyphens, or underscores, ` +
        `starting with a letter or digit`,
    );
  }
  return raw as PersonaName;
}

/**
 * Persisted persona definition. Stored as JSON at
 * ~/.ironcurtain/personas/{name}/persona.json.
 */
export interface PersonaDefinition {
  /** Persona name. Matches the directory name. */
  readonly name: PersonaName;

  /** Human-readable description of the persona's purpose. */
  readonly description: string;

  /** ISO 8601 timestamp of when the persona was created. */
  readonly createdAt: string;

  /**
   * Optional allowlist of MCP server names from the global
   * mcp-servers.json. When set, only these servers are available.
   * When omitted, all global servers are enabled (default).
   * The "filesystem" server is always included regardless.
   */
  readonly servers?: readonly string[];
}
