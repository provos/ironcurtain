/**
 * Persona-related JSON-RPC method dispatch.
 *
 * Handles `personas.*` methods: list, get, compile.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { validateParams } from './types.js';
import { type PersonaDetailDto, type PersonaCompileResultDto, RpcError, MethodNotFoundError } from '../web-ui-types.js';
import { scanPersonas } from '../../mux/persona-scanner.js';
import { getPersonaConstitutionPath, getPersonaGeneratedDir, loadPersona } from '../../persona/resolve.js';
import { createPersonaName, type PersonaName, type PersonaDefinition } from '../../persona/types.js';
import type { CompiledPolicyFile } from '../../pipeline/types.js';

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
      return scanPersonas().map((p) => ({
        name: p.name,
        description: p.description,
        compiled: p.compiled,
      }));
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
    throw new RpcError('PERSONA_NOT_FOUND', `Invalid persona name: ${nameRaw}`);
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
  const { name, persona } = resolvePersonaOrThrow(nameRaw);

  let constitution = '';
  const constitutionPath = getPersonaConstitutionPath(name);
  try {
    constitution = readFileSync(constitutionPath, 'utf-8');
  } catch {
    // No constitution yet -- return empty
  }

  const generatedDir = getPersonaGeneratedDir(name);
  const policyPath = resolve(generatedDir, 'compiled-policy.json');
  const hasPolicy = existsSync(policyPath);

  let policyRuleCount: number | undefined;
  if (hasPolicy) {
    try {
      const raw = readFileSync(policyPath, 'utf-8');
      const compiled = JSON.parse(raw) as CompiledPolicyFile;
      policyRuleCount = compiled.rules.length;
    } catch {
      // Ignore parse errors
    }
  }

  return {
    name: persona.name,
    description: persona.description,
    createdAt: persona.createdAt,
    constitution,
    servers: persona.servers,
    hasPolicy,
    policyRuleCount,
  };
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
