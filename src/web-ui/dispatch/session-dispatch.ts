/**
 * Session-related JSON-RPC method dispatch.
 *
 * Handles all `sessions.*` methods: list, get, create, end, send,
 * budget, history, diagnostics.
 */

import { z } from 'zod';

import { type DispatchContext, validateParams, toSessionDto, toBudgetDto } from './types.js';
import {
  type SessionDto,
  type SessionDetailDto,
  RpcError,
  SessionNotFoundError,
  MethodNotFoundError,
} from '../web-ui-types.js';
import { WebSessionTransport } from '../web-session-transport.js';
import { loadConfig } from '../../config/index.js';
import { createSession } from '../../session/index.js';
import { shouldAutoSaveMemory } from '../../memory/auto-save.js';
import { BudgetExhaustedError } from '../../session/errors.js';
import * as logger from '../../logger.js';

// ---------------------------------------------------------------------------
// Param validation schemas
// ---------------------------------------------------------------------------

const labelSchema = z.object({ label: z.number().int().positive() });
const sessionCreateSchema = z.object({ persona: z.string().min(1).optional() });
const sessionSendSchema = z.object({ label: z.number().int().positive(), text: z.string().min(1) });

// ---------------------------------------------------------------------------
// Session dispatch
// ---------------------------------------------------------------------------

export async function sessionDispatch(
  ctx: DispatchContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'sessions.list':
      return listSessions(ctx);
    case 'sessions.get': {
      const { label } = validateParams(labelSchema, params);
      return getSession(ctx, label);
    }
    case 'sessions.create': {
      const { persona } = validateParams(sessionCreateSchema, params);
      return createWebSession(ctx, persona);
    }
    case 'sessions.end': {
      const { label } = validateParams(labelSchema, params);
      await ctx.sessionManager.end(label);
      cleanupSessionQueue(ctx, label);
      ctx.eventBus.emit('session.ended', { label, reason: 'user_ended' });
      return;
    }
    case 'sessions.send': {
      const { label, text } = validateParams(sessionSendSchema, params);
      return sendToSession(ctx, label, text);
    }
    case 'sessions.budget': {
      const { label } = validateParams(labelSchema, params);
      const managed = ctx.sessionManager.get(label);
      if (!managed) throw new SessionNotFoundError(label);
      return toBudgetDto(managed);
    }
    case 'sessions.history': {
      const { label } = validateParams(labelSchema, params);
      const managed = ctx.sessionManager.get(label);
      if (!managed) throw new SessionNotFoundError(label);
      return managed.session.getHistory();
    }
    case 'sessions.diagnostics': {
      const { label } = validateParams(labelSchema, params);
      const managed = ctx.sessionManager.get(label);
      if (!managed) throw new SessionNotFoundError(label);
      return managed.session.getDiagnosticLog();
    }
    default:
      throw new MethodNotFoundError(method);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clean up session queue entry when session ends. */
function cleanupSessionQueue(ctx: DispatchContext, label: number): void {
  ctx.sessionQueues.delete(label);
}

function listSessions(ctx: DispatchContext): SessionDto[] {
  return ctx.sessionManager.all().map((m) => toSessionDto(m));
}

function getSession(ctx: DispatchContext, label: number): SessionDetailDto {
  const managed = ctx.sessionManager.get(label);
  if (!managed) throw new SessionNotFoundError(label);
  return {
    ...toSessionDto(managed),
    history: managed.session.getHistory(),
    diagnosticLog: managed.session.getDiagnosticLog(),
  };
}

async function createWebSession(ctx: DispatchContext, persona?: string): Promise<{ label: number }> {
  const webCount = ctx.sessionManager.byKind('web').length;
  if (webCount >= ctx.maxConcurrentWebSessions) {
    throw new RpcError('RATE_LIMITED', `Web session limit reached (max ${ctx.maxConcurrentWebSessions})`);
  }

  const config = loadConfig();
  const transport = new WebSessionTransport({
    eventBus: ctx.eventBus,
    sessionManager: ctx.sessionManager,
    autoSaveMemory: shouldAutoSaveMemory(config) && !!persona,
    dockerMode: ctx.mode.kind === 'docker',
  });

  const session = await createSession({
    config,
    mode: ctx.mode,
    persona,
    onEscalation: transport.createEscalationHandler(),
    onEscalationExpired: transport.createEscalationExpiredHandler(),
    onEscalationResolved: transport.createEscalationResolvedHandler(),
    onDiagnostic: transport.createDiagnosticHandler(),
  });

  const label = ctx.sessionManager.register(session, transport, { kind: 'web', persona });
  transport.sessionLabel = label;

  const runPromise = transport.run(session);
  const managed = ctx.sessionManager.get(label);
  if (managed) {
    managed.runPromise = runPromise;
  }

  runPromise
    .then(() => {
      const m = ctx.sessionManager.get(label);
      if (m) {
        ctx.sessionManager.end(label).catch((err: unknown) => {
          logger.error(`[WebUI] Failed to clean up session #${label}: ${String(err)}`);
        });
      }
    })
    .catch((err: unknown) => {
      logger.error(`[WebUI] Transport #${label} error: ${String(err)}`);
    })
    .finally(() => {
      cleanupSessionQueue(ctx, label);
    });

  if (managed) {
    ctx.eventBus.emit('session.created', toSessionDto(managed));
  }

  return { label };
}

function sendToSession(ctx: DispatchContext, label: number, text: string): { accepted: true } {
  const managed = ctx.sessionManager.get(label);
  if (!managed) throw new SessionNotFoundError(label);
  if (managed.source.kind !== 'web') {
    throw new RpcError('INVALID_PARAMS', `Session #${label} is not a web session`);
  }

  const transport = managed.transport as WebSessionTransport;

  const prev = ctx.sessionQueues.get(label) ?? Promise.resolve();
  const current = prev.then(async () => {
    const turnNumber = managed.session.getInfo().turnCount + 1;
    ctx.eventBus.emit('session.thinking', { label, turnNumber });
    // Emit session status update so the frontend shows 'processing'
    const freshManaged = ctx.sessionManager.get(label);
    if (freshManaged) {
      ctx.eventBus.emit('session.updated', toSessionDto(freshManaged));
    }
    try {
      const response = await transport.forwardMessage(text);
      ctx.eventBus.emit('session.output', { label, text: response, turnNumber });
      ctx.eventBus.emit('session.budget_update', { label, budget: toBudgetDto(managed) });
      // Emit updated session so frontend picks up status change (e.g. back to 'ready')
      const updatedManaged = ctx.sessionManager.get(label);
      if (updatedManaged) {
        ctx.eventBus.emit('session.updated', toSessionDto(updatedManaged));
      }
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        ctx.eventBus.emit('session.ended', { label, reason: `Budget exhausted: ${err.message}` });
        await ctx.sessionManager.end(label);
        cleanupSessionQueue(ctx, label);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        ctx.eventBus.emit('session.output', { label, text: `Error: ${message}`, turnNumber });
      }
    }
  });
  ctx.sessionQueues.set(
    label,
    current.catch((err: unknown) => {
      logger.error(`[WebUI] Session #${label} queue error: ${err instanceof Error ? err.message : String(err)}`);
    }),
  );

  return { accepted: true };
}
