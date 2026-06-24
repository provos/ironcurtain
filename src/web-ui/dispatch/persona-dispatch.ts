/**
 * Persona-related JSON-RPC method dispatch.
 *
 * Handles `personas.*` methods: list, get, the Phase 1b streamed compile + its
 * read methods (compileStream / getCompile / listCompiles), and the Phase 1c
 * CRUD methods. There is a SINGLE compile surface (compileStream) — it is both
 * kill-switch gated and runs the broad-policy validator. The old blocking
 * `personas.compile` method was removed in Phase 1c because it was an ungated,
 * unvalidated second compile path.
 */

import { z } from 'zod';
import type { WebSocket as WsWebSocket } from 'ws';

import { validateParams } from './types.js';
import type { WorkflowDispatchContext } from './workflow-dispatch.js';
import {
  type PersonaDetailDto,
  type PersonaEditResultDto,
  type PersonaCompileStreamAckDto,
  type PersonaCompileOperationDto,
  type PersonaListCompilesDto,
  RpcError,
  MethodNotFoundError,
} from '../web-ui-types.js';
import {
  getPersonaDetail as getPersonaDetailService,
  listPersonas,
  createPersona as createPersonaService,
  setPersonaConstitution as setPersonaConstitutionService,
  setPersonaMemory as setPersonaMemoryService,
  deletePersona as deletePersonaService,
  setPersonaBroadPolicyOptIn as setPersonaBroadPolicyOptInService,
} from '../../persona/persona-service.js';
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
// Phase 1c persona-CRUD param schemas (locked contract; handlers added in the
// implementation stage). Exported so they form part of the wire contract and
// can be unit-tested independently. All mutation methods are additionally
// gated on `ctx.allowPolicyMutation` in the dispatch switch (else
// POLICY_MUTATION_FORBIDDEN); the schemas only validate shape.
// ---------------------------------------------------------------------------

/** `personas.create` -> PersonaDetailDto. Slug is branded inside the service. */
export const createPersonaSchema = z.object({
  name: z.string().min(1).max(63),
  description: z.string().trim().min(1),
  servers: z.array(z.string().trim().min(1)).optional(),
  memoryEnabled: z.boolean().optional(),
  constitution: z.string().optional(), // default '' inside the service (empty persona)
});

/** `personas.editConstitution` -> PersonaEditResultDto { stale }. */
export const editConstitutionSchema = z.object({
  name: z.string().min(1),
  constitution: z.string(),
});

/** `personas.setMemory` -> PersonaDetailDto. */
export const setMemorySchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
});

/**
 * `personas.delete` (soft by default) -> { deleted: true }.
 * `confirmed: z.literal(true)` makes an unconfirmed call a schema error;
 * confirmation lives in the UI. `force: true` => hard delete (revoke policy).
 */
export const deletePersonaSchema = z.object({
  name: z.string().min(1),
  confirmed: z.literal(true),
  force: z.boolean().optional(),
});

/**
 * `personas.setBroadPolicyOptIn` (gated) -> PersonaDetailDto. The ONLY way to
 * set `allowBroadPolicy`; never inferred from the constitution.
 */
export const setBroadPolicyOptInSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// All persona methods are synchronous post-Phase-1c (the streamed compile is
// fire-and-return; the old blocking `personas.compile` that awaited the pipeline
// was removed). The signature stays `async` for uniformity with the sibling
// dispatchers and so a thrown RpcError is normalized into a rejected promise for
// callers that `await` it.
// eslint-disable-next-line @typescript-eslint/require-await
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

    // -----------------------------------------------------------------------
    // Phase 1c CRUD (all gated on ctx.allowPolicyMutation; gate fires BEFORE
    // any fs read). Each mutation emits `personas.changed`.
    // -----------------------------------------------------------------------

    case 'personas.create': {
      requirePolicyMutation(ctx);
      const input = validateParams(createPersonaSchema, params);
      return createPersonaHandler(ctx, input, client);
    }

    case 'personas.editConstitution': {
      requirePolicyMutation(ctx);
      const { name, constitution } = validateParams(editConstitutionSchema, params);
      return editConstitutionHandler(ctx, name, constitution, client);
    }

    case 'personas.setMemory': {
      requirePolicyMutation(ctx);
      const { name, enabled } = validateParams(setMemorySchema, params);
      return setMemoryHandler(ctx, name, enabled, client);
    }

    case 'personas.delete': {
      requirePolicyMutation(ctx);
      const { name, force } = validateParams(deletePersonaSchema, params);
      return deletePersonaHandler(ctx, name, force ?? false, client);
    }

    case 'personas.setBroadPolicyOptIn': {
      requirePolicyMutation(ctx);
      const { name, enabled } = validateParams(setBroadPolicyOptInSchema, params);
      return setBroadPolicyOptInHandler(ctx, name, enabled, client);
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

/**
 * Kill-switch gate shared by all mutation methods. Throws
 * POLICY_MUTATION_FORBIDDEN when the daemon was not launched with
 * `--allow-policy-mutation`. Fires BEFORE any fs/credential read so a read-only
 * client never learns persona/credential state.
 */
function requirePolicyMutation(ctx: WorkflowDispatchContext): void {
  if (ctx.allowPolicyMutation !== true) {
    throw new RpcError('POLICY_MUTATION_FORBIDDEN', 'Policy mutation is not enabled on this daemon.');
  }
}

/**
 * Maps a persona-service thrown error (which carries a discriminant `code`
 * string set via Object.assign) onto a typed RpcError. Unknown errors bubble.
 */
function rethrowServiceError(err: unknown): never {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === 'PERSONA_EXISTS') {
    throw new RpcError('PERSONA_EXISTS', err instanceof Error ? err.message : 'Persona already exists.');
  }
  if (code === 'PERSONA_NOT_FOUND') {
    throw new RpcError('PERSONA_NOT_FOUND', err instanceof Error ? err.message : 'Persona not found.');
  }
  throw err;
}

function createPersonaHandler(
  ctx: WorkflowDispatchContext,
  input: { name: string; description: string; servers?: string[]; memoryEnabled?: boolean; constitution?: string },
  client?: WsWebSocket,
): PersonaDetailDto {
  // Validate the slug up front so a bad name is INVALID_PARAMS (not a raw throw).
  try {
    createPersonaName(input.name);
  } catch {
    throw new RpcError('INVALID_PARAMS', `Invalid persona name: ${input.name}`);
  }
  let detail: PersonaDetailDto;
  try {
    detail = createPersonaService(input, describeActor(client));
  } catch (err) {
    rethrowServiceError(err);
  }
  ctx.eventBus.emit('personas.changed', {});
  return detail;
}

function editConstitutionHandler(
  ctx: WorkflowDispatchContext,
  nameRaw: string,
  constitution: string,
  client?: WsWebSocket,
): PersonaEditResultDto {
  const { name } = resolvePersonaOrThrow(nameRaw);
  let result: PersonaEditResultDto;
  try {
    result = setPersonaConstitutionService(name, constitution, describeActor(client));
  } catch (err) {
    rethrowServiceError(err);
  }
  ctx.eventBus.emit('personas.changed', {});
  return result;
}

function setMemoryHandler(
  ctx: WorkflowDispatchContext,
  nameRaw: string,
  enabled: boolean,
  client?: WsWebSocket,
): PersonaDetailDto {
  const { name } = resolvePersonaOrThrow(nameRaw);
  try {
    setPersonaMemoryService(name, enabled, describeActor(client));
  } catch (err) {
    rethrowServiceError(err);
  }
  ctx.eventBus.emit('personas.changed', {});
  return getPersonaDetailService(name);
}

function deletePersonaHandler(
  ctx: WorkflowDispatchContext,
  nameRaw: string,
  force: boolean,
  client?: WsWebSocket,
): { deleted: true } {
  const { name } = resolvePersonaOrThrow(nameRaw);
  try {
    deletePersonaService(name, describeActor(client), { force });
  } catch (err) {
    rethrowServiceError(err);
  }
  ctx.eventBus.emit('personas.changed', {});
  return { deleted: true };
}

function setBroadPolicyOptInHandler(
  ctx: WorkflowDispatchContext,
  nameRaw: string,
  enabled: boolean,
  client?: WsWebSocket,
): PersonaDetailDto {
  const { name } = resolvePersonaOrThrow(nameRaw);
  let detail: PersonaDetailDto;
  try {
    detail = setPersonaBroadPolicyOptInService(name, enabled, describeActor(client));
  } catch (err) {
    rethrowServiceError(err);
  }
  ctx.eventBus.emit('personas.changed', {});
  return detail;
}

/** Builds the audit/actor string: `${remoteAddr}#${connId}` (WS) or 'cli'. */
function describeActor(client?: WsWebSocket): string {
  if (!client) return 'cli';
  const connId = getConnId(client);
  // `_socket` exposes the remote address on the underlying TCP socket.
  const remote = (client as { _socket?: { remoteAddress?: string } })._socket?.remoteAddress ?? 'unknown';
  return `${remote}#${connId ?? 'unknown'}`;
}
