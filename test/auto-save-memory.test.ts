/**
 * Tests for auto-save memory feature.
 *
 * The source module (src/memory/auto-save.ts) is expected to be created
 * by another agent. These tests verify the two exports:
 *
 * - shouldAutoSaveMemory(config) -- pure config check
 * - saveSessionMemory(session, options?) -- prompt-driven memory persistence
 */

import { describe, it, expect, vi } from 'vitest';
import { saveSessionMemory, shouldAutoSaveMemory } from '../src/memory/auto-save.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { Session, SessionInfo, ConversationTurn } from '../src/session/types.js';
import type { PersonaDefinition, PersonaName } from '../src/persona/types.js';
import { BudgetExhaustedError } from '../src/session/errors.js';

/** Minimal persona scope for the auto-save gate (persona present => eligible for memory when not opted out). */
function makePersonaScope(): { persona: PersonaDefinition } {
  return {
    persona: {
      name: 'test-persona' as PersonaName,
      description: 'test',
      createdAt: '2026-04-27T00:00:00.000Z',
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal IronCurtainConfig with only the fields relevant to auto-save. */
function makeConfig(overrides: { memoryEnabled?: boolean; autoSave?: boolean }): IronCurtainConfig {
  const { memoryEnabled = true, autoSave = true } = overrides;

  return {
    mcpServers: {},
    userConfig: {
      memory: {
        enabled: memoryEnabled,
        autoSave,
        llmBaseUrl: undefined,
        llmApiKey: undefined,
      },
    },
  } as unknown as IronCurtainConfig;
}

/** Build a realistic ConversationTurn for testing. */
function makeTurn(turnNumber: number, userMessage: string, assistantResponse: string): ConversationTurn {
  return {
    turnNumber,
    userMessage,
    assistantResponse,
    usage: {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    timestamp: new Date().toISOString(),
  };
}

/** Minimal Session stub with configurable history and sendMessage. */
function stubSession(
  options: {
    history?: ConversationTurn[];
    sendMessage?: ReturnType<typeof vi.fn>;
  } = {},
): Session {
  const { history = [], sendMessage = vi.fn().mockResolvedValue('Memory saved.') } = options;

  return {
    getInfo: () =>
      ({
        id: 'test-session-id',
        status: 'ready',
        turnCount: history.length,
        createdAt: new Date().toISOString(),
      }) as SessionInfo,
    sendMessage,
    getHistory: vi.fn().mockReturnValue(history),
    getDiagnosticLog: vi.fn().mockReturnValue([]),
    resolveEscalation: vi.fn(),
    getPendingEscalation: vi.fn(),
    getBudgetStatus: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// shouldAutoSaveMemory
// ---------------------------------------------------------------------------

describe('shouldAutoSaveMemory', () => {
  it('returns true when memory enabled, autoSave true, and a persona scope is provided', () => {
    const config = makeConfig({ memoryEnabled: true, autoSave: true });
    expect(shouldAutoSaveMemory(config, makePersonaScope())).toBe(true);
  });

  it('returns false when memory is disabled (kill switch)', () => {
    const config = makeConfig({ memoryEnabled: false, autoSave: true });
    expect(shouldAutoSaveMemory(config, makePersonaScope())).toBe(false);
  });

  it('returns false when autoSave is explicitly false', () => {
    const config = makeConfig({ memoryEnabled: true, autoSave: false });
    expect(shouldAutoSaveMemory(config, makePersonaScope())).toBe(false);
  });

  it('returns false for default sessions (no persona, no job)', () => {
    const config = makeConfig({ memoryEnabled: true, autoSave: true });
    expect(shouldAutoSaveMemory(config)).toBe(false);
  });

  it('returns false when persona opts out via memory.enabled = false', () => {
    const config = makeConfig({ memoryEnabled: true, autoSave: true });
    const scope = makePersonaScope();
    const personaOptOut: PersonaDefinition = { ...scope.persona, memory: { enabled: false } };
    expect(shouldAutoSaveMemory(config, { persona: personaOptOut })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// saveSessionMemory
// ---------------------------------------------------------------------------

describe('saveSessionMemory', () => {
  it('calls sendMessage with a prompt containing "memory.store" in Code Mode', async () => {
    const history = [makeTurn(1, 'Fix the login bug', 'I found and fixed the null check in auth.ts')];
    const sendMessage = vi.fn().mockResolvedValue('Stored memory.');
    const session = stubSession({ history, sendMessage });

    const result = await saveSessionMemory(session);

    expect(result).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    const prompt = sendMessage.mock.calls[0][0] as string;
    expect(prompt).toContain('memory.store');
  });

  it('calls sendMessage with a prompt containing "memory_store" when dockerMode is true', async () => {
    const history = [makeTurn(1, 'Refactor the API layer', 'Done, split into controller and service files.')];
    const sendMessage = vi.fn().mockResolvedValue('Stored memory.');
    const session = stubSession({ history, sendMessage });

    const result = await saveSessionMemory(session, { dockerMode: true });

    expect(result).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    const prompt = sendMessage.mock.calls[0][0] as string;
    expect(prompt).toContain('memory_store');
  });

  it('includes condensed conversation history in the prompt', async () => {
    const history = [
      makeTurn(1, 'What files are in src/', 'Found 12 TypeScript files in src/'),
      makeTurn(2, 'Add a logging utility', 'Created src/utils/logger.ts with structured logging'),
    ];
    const sendMessage = vi.fn().mockResolvedValue('Stored.');
    const session = stubSession({ history, sendMessage });

    await saveSessionMemory(session);

    const prompt = sendMessage.mock.calls[0][0] as string;
    // The prompt should include content from the conversation.
    expect(prompt).toContain('logging');
  });

  it('returns true on success', async () => {
    const history = [makeTurn(1, 'Hello', 'Hi there')];
    const session = stubSession({ history });

    const result = await saveSessionMemory(session);
    expect(result).toBe(true);
  });

  it('returns false when sendMessage throws due to budget exhaustion', async () => {
    const history = [makeTurn(1, 'Do something', 'Sure thing')];
    const sendMessage = vi
      .fn()
      .mockRejectedValue(new BudgetExhaustedError('tokens', 'Budget exhausted: token limit exceeded'));
    const session = stubSession({ history, sendMessage });

    const result = await saveSessionMemory(session);
    expect(result).toBe(false);
  });

  it('returns false when sendMessage throws due to session closed', async () => {
    const history = [makeTurn(1, 'Do something', 'Sure thing')];
    const sendMessage = vi.fn().mockRejectedValue(new Error('Session is closed'));
    const session = stubSession({ history, sendMessage });

    const result = await saveSessionMemory(session);
    expect(result).toBe(false);
  });

  it('returns false and skips sendMessage when history is empty', async () => {
    const sendMessage = vi.fn();
    const session = stubSession({ history: [], sendMessage });

    const result = await saveSessionMemory(session);

    expect(result).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('truncates very long conversation history in the prompt', async () => {
    // Build a history with many turns containing large messages.
    const longText = 'x'.repeat(5000);
    const history = Array.from({ length: 50 }, (_, i) =>
      makeTurn(i + 1, `Question ${i + 1}: ${longText}`, `Answer ${i + 1}: ${longText}`),
    );
    const sendMessage = vi.fn().mockResolvedValue('Stored.');
    const session = stubSession({ history, sendMessage });

    await saveSessionMemory(session);

    expect(sendMessage).toHaveBeenCalledOnce();
    const prompt = sendMessage.mock.calls[0][0] as string;
    // The prompt should be substantially shorter than the raw history.
    const rawLength = history.reduce((sum, t) => sum + t.userMessage.length + t.assistantResponse.length, 0);
    expect(prompt.length).toBeLessThan(rawLength);
  });
});
