/**
 * Loader-aware memory-gate wrapper for callers that have only a persona
 * NAME in scope (e.g., the workflow orchestrator at relay-derivation
 * time).
 *
 * Lives in `src/persona/` (not `src/memory/`) to avoid closing a
 * `memory/ -> persona/ -> memory/` import cycle: `loadPersona` lives
 * in `src/persona/resolve.ts`, which already imports from
 * `src/memory/memory-annotations.ts`.
 */

import type { ResolvedUserConfig } from '../config/user-config.js';
import { isMemoryEnabledFor } from '../memory/memory-policy.js';
import { loadPersona } from './resolve.js';
import { createPersonaName, type PersonaDefinition } from './types.js';

/**
 * Loads the persona definition by name and runs the memory gate.
 *
 * Fail-closed: if the persona file is missing or malformed (loadPersona
 * throws), returns false. The orchestrator should not spawn a memory
 * relay for a persona it cannot load.
 */
export function isMemoryEnabledForPersonaName(name: string, userConfig: ResolvedUserConfig): boolean {
  if (!userConfig.memory.enabled) return false;
  let persona: PersonaDefinition;
  try {
    persona = loadPersona(createPersonaName(name));
  } catch {
    return false;
  }
  return isMemoryEnabledFor({ persona, userConfig });
}
