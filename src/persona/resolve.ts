/**
 * Persona resolver -- locates persona directories, loads definitions,
 * and validates compiled policy existence.
 *
 * Follows the same directory-layout pattern as job paths in
 * src/config/paths.ts (getJobDir, getJobGeneratedDir, etc.).
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getIronCurtainHome } from '../config/paths.js';
import { createPersonaName, type PersonaDefinition, type PersonaName } from './types.js';
import type { MCPServerConfig } from '../config/types.js';
import { MEMORY_SERVER_NAME } from '../memory/memory-annotations.js';

/** Servers always included in persona sessions regardless of allowlist. */
const ALWAYS_INCLUDED_SERVERS = new Set(['filesystem', MEMORY_SERVER_NAME]);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Returns the base directory for all personas: {home}/personas/ */
export function getPersonasDir(): string {
  return resolve(getIronCurtainHome(), 'personas');
}

/** Returns the directory for a specific persona: {home}/personas/{name}/ */
export function getPersonaDir(name: PersonaName): string {
  return resolve(getPersonasDir(), name);
}

/** Returns the generated artifacts directory for a persona: {home}/personas/{name}/generated/ */
export function getPersonaGeneratedDir(name: PersonaName): string {
  return resolve(getPersonaDir(name), 'generated');
}

/** Returns the constitution path for a persona: {home}/personas/{name}/constitution.md */
export function getPersonaConstitutionPath(name: PersonaName): string {
  return resolve(getPersonaDir(name), 'constitution.md');
}

/** Returns the workspace directory for a persona: {home}/personas/{name}/workspace/ */
export function getPersonaWorkspaceDir(name: PersonaName): string {
  return resolve(getPersonaDir(name), 'workspace');
}

/** Returns the persona definition file path: {home}/personas/{name}/persona.json */
export function getPersonaDefinitionPath(name: PersonaName): string {
  return resolve(getPersonaDir(name), 'persona.json');
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Loads a persona definition from disk.
 * @throws if the persona directory or persona.json does not exist.
 */
export function loadPersona(name: PersonaName): PersonaDefinition {
  const defPath = getPersonaDefinitionPath(name);
  let raw: string;
  try {
    raw = readFileSync(defPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Persona "${name}" not found: ${defPath} does not exist.`, { cause: err });
    }
    throw err;
  }
  return JSON.parse(raw) as PersonaDefinition;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Result of resolving a persona name to runtime-usable paths. */
export interface ResolvedPersona {
  readonly policyDir: string;
  readonly persona: PersonaDefinition;
  readonly workspacePath: string;
}

/**
 * Resolves a persona name to a validated policyDir, workspace path,
 * and persona definition.
 *
 * @throws if persona does not exist or has no compiled policy.
 */
export function resolvePersona(nameRaw: string): ResolvedPersona {
  const name = createPersonaName(nameRaw);

  // Load persona.json first — validates the persona directory exists and
  // produces a clear error ("not found") before checking for compiled policy.
  const persona = loadPersona(name);

  const generatedDir = getPersonaGeneratedDir(name);
  if (!existsSync(resolve(generatedDir, 'compiled-policy.json'))) {
    throw new Error(`Persona "${name}" has no compiled policy. ` + `Run: ironcurtain persona compile ${name}`);
  }

  return {
    policyDir: generatedDir,
    persona,
    workspacePath: getPersonaWorkspaceDir(name),
  };
}

// ---------------------------------------------------------------------------
// Server allowlist filtering
// ---------------------------------------------------------------------------

/**
 * Filters MCP servers to only those in the allowlist.
 * The "filesystem" server is always included even if omitted from
 * the allowlist -- this is a hardcoded safety invariant since the
 * agent sandbox requires filesystem access to function.
 */
export function applyServerAllowlist(
  mcpServers: Record<string, MCPServerConfig>,
  allowlist: readonly string[],
): Record<string, MCPServerConfig> {
  // Warn about server names in the allowlist that don't exist in the
  // global mcp-servers.json. This catches typos and stale references
  // without breaking the persona (non-fatal warning).
  const knownServers = new Set(Object.keys(mcpServers));
  for (const name of allowlist) {
    if (!knownServers.has(name) && !ALWAYS_INCLUDED_SERVERS.has(name)) {
      process.stderr.write(`Warning: persona allowlist includes unknown server "${name}" (not in mcp-servers.json)\n`);
    }
  }

  const filtered: Record<string, MCPServerConfig> = {};
  for (const [name, config] of Object.entries(mcpServers)) {
    if (allowlist.includes(name) || ALWAYS_INCLUDED_SERVERS.has(name)) {
      filtered[name] = config;
    }
  }
  return filtered;
}
