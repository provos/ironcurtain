/**
 * Persona scanner -- discovers available personas from disk.
 *
 * Reads persona directories and returns snapshots with compilation
 * status, mirroring the session-scanner pattern.
 */

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPersonasDir, getPersonaGeneratedDir, getPersonaWorkspaceDir, loadPersona } from '../persona/resolve.js';
import { createPersonaName, type PersonaName } from '../persona/types.js';

/** Snapshot of a persona for display in the picker. */
export interface PersonaSnapshot {
  readonly name: PersonaName;
  readonly description: string;
  readonly compiled: boolean;
  readonly workspacePath: string;
}

/**
 * Scans the personas directory for available personas.
 * Returns snapshots sorted alphabetically by name.
 */
export function scanPersonas(): PersonaSnapshot[] {
  const personasDir = getPersonasDir();

  let entries: string[];
  try {
    entries = readdirSync(personasDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const snapshots: PersonaSnapshot[] = [];

  for (const entry of entries) {
    let name: PersonaName;
    try {
      name = createPersonaName(entry);
    } catch {
      continue; // skip invalid persona names
    }

    try {
      const persona = loadPersona(name);
      const generatedDir = getPersonaGeneratedDir(name);
      const compiled = existsSync(resolve(generatedDir, 'compiled-policy.json'));
      snapshots.push({
        name,
        description: persona.description,
        compiled,
        workspacePath: getPersonaWorkspaceDir(name),
      });
    } catch {
      // skip personas with missing/invalid persona.json
    }
  }

  snapshots.sort((a, b) => a.name.localeCompare(b.name));
  return snapshots;
}
