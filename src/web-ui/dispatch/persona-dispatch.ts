/**
 * Persona-related JSON-RPC method dispatch.
 *
 * Handles `personas.*` methods: list, get, compile.
 */

import { z } from 'zod';

import { validateParams } from './types.js';
import { type PersonaDetailDto, type PersonaCompileResultDto, RpcError, MethodNotFoundError } from '../web-ui-types.js';
import { getPersonaDetail as getPersonaDetailService, listPersonas } from '../../persona/persona-service.js';
import { loadPersona } from '../../persona/resolve.js';
import { createPersonaName, type PersonaName, type PersonaDefinition } from '../../persona/types.js';

// ---------------------------------------------------------------------------
// Param schemas
// ---------------------------------------------------------------------------

const personaNameSchema = z.object({ name: z.string().min(1) });

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function personaDispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'personas.list': {
      return listPersonas();
    }

    case 'personas.get': {
      const { name } = validateParams(personaNameSchema, params);
      return getPersonaDetail(name);
    }

    case 'personas.compile': {
      const { name } = validateParams(personaNameSchema, params);
      return compilePersona(name);
    }

    default:
      throw new MethodNotFoundError(method);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validates the raw name string and loads the persona, throwing RpcError on failure. */
function resolvePersonaOrThrow(nameRaw: string): { name: PersonaName; persona: PersonaDefinition } {
  let name;
  try {
    name = createPersonaName(nameRaw);
  } catch {
    throw new RpcError('INVALID_PARAMS', `Invalid persona name: ${nameRaw}`);
  }

  let persona;
  try {
    persona = loadPersona(name);
  } catch {
    throw new RpcError('PERSONA_NOT_FOUND', `Persona "${nameRaw}" not found`);
  }

  return { name, persona };
}

function getPersonaDetail(nameRaw: string): PersonaDetailDto {
  // Validate + map to RpcError consistently with the other persona methods,
  // then delegate the fs reads to the headless service (Phase 1a).
  const { name } = resolvePersonaOrThrow(nameRaw);
  return getPersonaDetailService(name);
}

async function compilePersona(nameRaw: string): Promise<PersonaCompileResultDto> {
  const { name } = resolvePersonaOrThrow(nameRaw);

  try {
    // Dynamic import to avoid loading heavy pipeline deps at startup
    const { compilePersonaPolicy } = await import('../../persona/compile-persona-policy.js');
    const result = await compilePersonaPolicy(name);
    return {
      success: true,
      ruleCount: result.rules.length,
    };
  } catch (err) {
    return {
      success: false,
      ruleCount: 0,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}
