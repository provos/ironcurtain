/**
 * Session-related JSON-RPC method dispatch.
 *
 * Handles all `sessions.*` methods: list, get, create, end, send,
 * budget, history, diagnostics.
 */

import { z } from 'zod';
import type { WebSocket as WsWebSocket } from 'ws';

import {
  type DispatchContext,
  validateParams,
  toSessionDto,
  toBudgetDto,
  zeroedBudgetDto,
  labelSchema,
} from './types.js';
import {
  type SessionDto,
  type SessionDetailDto,
  RpcError,
  SessionNotFoundError,
  MethodNotFoundError,
} from '../web-ui-types.js';
import { tokenStreamDispatch } from './token-stream-dispatch.js';
import { ptyDispatch } from './pty-dispatch.js';
import { WebSessionTransport } from '../web-session-transport.js';
import { loadConfig } from '../../config/index.js';
import { createStandaloneSession } from '../../session/index.js';
import { shouldAutoSaveMemory } from '../../memory/auto-save.js';
import { BudgetExhaustedError } from '../../types/errors.js';
import { getTokenStreamBus } from '../../docker/token-stream-bus.js';
import * as logger from '../../logger.js';

// ---------------------------------------------------------------------------
// Param validation schemas
// ---------------------------------------------------------------------------

const sessionCreateSchema = z.object({
  persona: z.string().min(1).optional(),
  /**
   * Per-session trajectory-capture override. Wins over the
   * daemon-process default set via `--capture-traces`. When undefined,
   * the daemon-process default (or `false`) is used. See
   * docs/designs/mitm-token-trajectory-capture.md §10.
   */
  captureTraces: z.boolean().optional(),
  /**
   * Docker-agent (web-pty) launch options, mirroring mux `/new`. Ignored by the
   * code-mode chatbox path. The child `ironcurtain start --pty` validates the
   * workspace (containment) and resolves the provider profile / model.
   */
  workspacePath: z.string().min(1).optional(),
  providerProfileName: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
const sessionSendSchema = z.object({ label: z.number().int().positive(), text: z.string().min(1) });

// ---------------------------------------------------------------------------
// Session dispatch
// ---------------------------------------------------------------------------

export async function sessionDispatch(
  ctx: DispatchContext,
  method: string,
  params: Record<string, unknown>,
  client?: WsWebSocket,
): Promise<unknown> {
  // Delegate token stream methods to dedicated dispatch module
  if (method.startsWith('sessions.subscribe') || method.startsWith('sessions.unsubscribe')) {
    if (!client) {
      throw new RpcError('INTERNAL_ERROR', 'Token stream methods require a WebSocket client');
    }
    return tokenStreamDispatch(ctx, method, params, client);
  }

  // Delegate PTY terminal methods to dedicated dispatch module
  if (method.startsWith('sessions.pty')) {
    if (!client) {
      throw new RpcError('INTERNAL_ERROR', 'PTY methods require a WebSocket client');
    }
    return ptyDispatch(ctx, method, params, client);
  }

  switch (method) {
    case 'sessions.list':
      return listSessions(ctx);
    case 'sessions.get': {
      const { label } = validateParams(labelSchema, params);
      return getSession(ctx, label);
    }
    case 'sessions.create': {
      const opts = validateParams(sessionCreateSchema, params);
      // Docker mode streams a live terminal (web-pty); code mode keeps the
      // turn-based chatbox session. The daemon's SessionMode is process-global.
      if (ctx.mode.kind === 'docker') {
        return createPtySession(ctx, opts);
      }
      return createWebSession(ctx, opts.persona, opts.captureTraces);
    }
    case 'sessions.end': {
      const { label } = validateParams(labelSchema, params);
      // Route PTY labels to their manager (they are not in SessionManager).
      if (ctx.ptySessionManager?.has(label)) {
        ctx.ptySessionManager.end(label);
        return;
      }
      const endManaged = ctx.sessionManager.get(label);
      const endSessionId = endManaged?.session.getInfo().id;
      await ctx.sessionManager.end(label);
      if (endSessionId) getTokenStreamBus().endSession(endSessionId);
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
      // PTY sessions have no turn/budget accounting; return a zeroed budget
      // rather than throwing, so a stale/racing client degrades cleanly (§11 D2).
      if (ctx.ptySessionManager?.has(label)) return zeroedBudgetDto();
      const managed = ctx.sessionManager.get(label);
      if (!managed) throw new SessionNotFoundError(label);
      return toBudgetDto(managed);
    }
    case 'sessions.history': {
      const { label } = validateParams(labelSchema, params);
      // PTY sessions carry no turn history (§11 D2).
      if (ctx.ptySessionManager?.has(label)) return [];
      const managed = ctx.sessionManager.get(label);
      if (!managed) throw new SessionNotFoundError(label);
      return managed.session.getHistory();
    }
    case 'sessions.diagnostics': {
      const { label } = validateParams(labelSchema, params);
      // PTY sessions carry no diagnostic log (§11 D2).
      if (ctx.ptySessionManager?.has(label)) return [];
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
  const managed = ctx.sessionManager.all().map((m) => toSessionDto(m));
  const pty = ctx.ptySessionManager?.listDtos() ?? [];
  return [...managed, ...pty];
}

function getSession(ctx: DispatchContext, label: number): SessionDetailDto {
  // PTY sessions have no turn history/diagnostics; return the DTO with empty
  // logs rather than throwing, since selecting one drives this call.
  const ptyDto = ctx.ptySessionManager?.getDto(label);
  if (ptyDto) {
    return { ...ptyDto, history: [], diagnosticLog: [] };
  }
  const managed = ctx.sessionManager.get(label);
  if (!managed) throw new SessionNotFoundError(label);
  return {
    ...toSessionDto(managed),
    history: managed.session.getHistory(),
    diagnosticLog: managed.session.getDiagnosticLog(),
  };
}

/**
 * Creates a Docker-agent PTY session (docker mode). Enforces the SAME
 * concurrency cap as the turn-based path, counting PTY sessions (§11 D4) —
 * each is a full container, so an unbounded spawn is a real resource concern.
 */
async function createPtySession(
  ctx: DispatchContext,
  opts: z.infer<typeof sessionCreateSchema>,
): Promise<{ label: number }> {
  const manager = ctx.ptySessionManager;
  if (!manager) {
    throw new RpcError('INTERNAL_ERROR', 'PTY session manager not available');
  }
  if (manager.size >= ctx.maxConcurrentWebSessions) {
    throw new RpcError('RATE_LIMITED', `PTY session limit reached (max ${ctx.maxConcurrentWebSessions})`);
  }
  return manager.create({
    ...(opts.persona ? { persona: opts.persona } : {}),
    ...(opts.captureTraces !== undefined ? { captureTraces: opts.captureTraces } : {}),
    ...(opts.workspacePath ? { workspacePath: opts.workspacePath } : {}),
    ...(opts.providerProfileName ? { providerProfileName: opts.providerProfileName } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  });
}

async function createWebSession(
  ctx: DispatchContext,
  persona?: string,
  captureTracesOverride?: boolean,
): Promise<{ label: number }> {
  const webCount = ctx.sessionManager.byKind('web').length;
  if (webCount >= ctx.maxConcurrentWebSessions) {
    throw new RpcError('RATE_LIMITED', `Web session limit reached (max ${ctx.maxConcurrentWebSessions})`);
  }

  const config = loadConfig();
  const transport = new WebSessionTransport({
    eventBus: ctx.eventBus,
    sessionManager: ctx.sessionManager,
    autoSaveMemory: shouldAutoSaveMemory(config, { persona }),
    dockerMode: ctx.mode.kind === 'docker',
  });

  // Capture precedence: JSON-RPC field > daemon CLI flag > userConfig.
  // The session factory then resolves vs `userConfig.capture?.enabled`
  // as the final fallback (§10).
  const effectiveCapture =
    captureTracesOverride !== undefined
      ? captureTracesOverride
      : (ctx.captureTracesDefault ?? false)
        ? true
        : undefined;

  const session = await createStandaloneSession({
    config,
    mode: ctx.mode,
    persona,
    ...(effectiveCapture !== undefined ? { captureTracesOverride: effectiveCapture } : {}),
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

  const sessionId = session.getInfo().id;
  runPromise
    .then(() => {
      const m = ctx.sessionManager.get(label);
      if (m) {
        ctx.sessionManager.end(label).catch((err: unknown) => {
          logger.error(`[WebUI] Failed to clean up session #${label}: ${String(err)}`);
        });
      }
      getTokenStreamBus().endSession(sessionId);
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
        const budgetSessionId = managed.session.getInfo().id;
        ctx.eventBus.emit('session.ended', { label, reason: `Budget exhausted: ${err.message}` });
        await ctx.sessionManager.end(label);
        getTokenStreamBus().endSession(budgetSessionId);
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
