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
import { BudgetExhaustedError } from '../src/session/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal IronCurtainConfig with only the fields relevant to auto-save. */
function makeConfig(overrides: {
  memoryEnabled?: boolean;
  autoSave?: boolean;
  hasMemoryServer?: boolean;
}): IronCurtainConfig {
  const { memoryEnabled = true, autoSave = true, hasMemoryServer = true } = overrides;

  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  if (hasMemoryServer) {
    mcpServers.memory = { command: 'memory-server', args: [] };
  }
  // Always include a non-memory server so the map is never empty by accident.
  mcpServers.filesystem = { command: 'fs-server', args: [] };

  return {
    mcpServers,
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
  it('returns true when memory enabled, autoSave true, and memory server present', () => {
    const config = makeConfig({ memoryEnabled: true, autoSave: true, hasMemoryServer: true });
    expect(shouldAutoSaveMemory(config)).toBe(true);
  });

  it('returns false when memory is disabled', () => {
    const config = makeConfig({ memoryEnabled: false, autoSave: true, hasMemoryServer: true });
    expect(shouldAutoSaveMemory(config)).toBe(false);
  });

  it('returns false when autoSave is explicitly false', () => {
    const config = makeConfig({ memoryEnabled: true, autoSave: false, hasMemoryServer: true });
    expect(shouldAutoSaveMemory(config)).toBe(false);
  });

  it('returns false when no memory server in mcpServers', () => {
    const config = makeConfig({ memoryEnabled: true, autoSave: true, hasMemoryServer: false });
    expect(shouldAutoSaveMemory(config)).toBe(false);
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

  it('returns true and skips sendMessage when history is empty', async () => {
    const sendMessage = vi.fn();
    const session = stubSession({ history: [], sendMessage });

    const result = await saveSessionMemory(session);

    expect(result).toBe(true);
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
