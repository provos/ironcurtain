/**
 * Persona-related JSON-RPC method dispatch.
 *
 * Handles `personas.*` methods: list, get, compile (blocking, back-compat), and
 * the Phase 1b streamed compile + its read methods (compileStream / getCompile /
 * listCompiles).
 */

import { z } from 'zod';
import type { WebSocket as WsWebSocket } from 'ws';

import { validateParams } from './types.js';
import type { WorkflowDispatchContext } from './workflow-dispatch.js';
import {
  type PersonaDetailDto,
  type PersonaBlockingCompileResultDto,
  type PersonaCompileStreamAckDto,
  type PersonaCompileOperationDto,
  type PersonaListCompilesDto,
  RpcError,
  MethodNotFoundError,
} from '../web-ui-types.js';
import { getPersonaDetail as getPersonaDetailService, listPersonas } from '../../persona/persona-service.js';
import { loadPersona } from '../../persona/resolve.js';
import { createPersonaName, type PersonaName, type PersonaDefinition } from '../../persona/types.js';
import { personaCompileOrchestrator, CompileOrchestratorError } from '../../persona/persona-compile-orchestrator.js';
import { getConnId } from '../conn-registry.js';

// ---------------------------------------------------------------------------
// Param schemas
// ---------------------------------------------------------------------------

const personaNameSchema = z.object({ name: z.string().min(1) });
const getCompileSchema = z.object({ operationId: z.string().min(1) });
const listCompilesSchema = z.object({});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function personaDispatch(
  ctx: WorkflowDispatchContext,
  method: string,
  params: Record<string, unknown>,
  client?: WsWebSocket,
): Promise<unknown> {
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

    case 'personas.compileStream': {
      const { name } = validateParams(personaNameSchema, params);
      return compileStream(ctx, name, client);
    }

    case 'personas.getCompile': {
      const { operationId } = validateParams(getCompileSchema, params);
      return getCompile(operationId);
    }

    case 'personas.listCompiles': {
      validateParams(listCompilesSchema, params);
      return listCompiles();
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

async function compilePersona(nameRaw: string): Promise<PersonaBlockingCompileResultDto> {
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

/**
 * Fire-and-return streamed compile (Phase 1b). Gated behind the daemon's
 * `allowPolicyMutation` kill switch: when off (the DEFAULT), the mutation
 * surface does not exist — return POLICY_MUTATION_FORBIDDEN BEFORE any
 * credential read so a read-only client never learns credential state.
 */
function compileStream(
  ctx: WorkflowDispatchContext,
  nameRaw: string,
  client?: WsWebSocket,
): PersonaCompileStreamAckDto {
  if (ctx.allowPolicyMutation !== true) {
    throw new RpcError('POLICY_MUTATION_FORBIDDEN', 'Policy mutation is not enabled on this daemon.');
  }
  const { name } = resolvePersonaOrThrow(nameRaw);
  const actor = describeActor(client);
  try {
    return personaCompileOrchestrator.startCompile(name, actor, ctx.eventBus);
  } catch (err) {
    if (err instanceof CompileOrchestratorError) {
      throw new RpcError(err.code, err.message, err.data);
    }
    throw err;
  }
}

function getCompile(operationId: string): PersonaCompileOperationDto {
  const op = personaCompileOrchestrator.getCompile(operationId);
  if (!op) {
    throw new RpcError('PERSONA_NOT_FOUND', `No compile operation "${operationId}"`);
  }
  return op;
}

function listCompiles(): PersonaListCompilesDto {
  return personaCompileOrchestrator.listCompiles();
}

/** Builds the audit/actor string: `${remoteAddr}#${connId}` (WS) or 'cli'. */
function describeActor(client?: WsWebSocket): string {
  if (!client) return 'cli';
  const connId = getConnId(client);
  // `_socket` exposes the remote address on the underlying TCP socket.
  const remote = (client as { _socket?: { remoteAddress?: string } })._socket?.remoteAddress ?? 'unknown';
  return `${remote}#${connId ?? 'unknown'}`;
}
