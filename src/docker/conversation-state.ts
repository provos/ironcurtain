/** Persisted conversation layouts shared by adapters and resume discovery. */
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConversationStateConfig } from './agent-adapter.js';

export const BUILTIN_CONVERSATION_STATES = {
  'claude-code': {
    hostDirName: 'claude-state',
    containerMountPath: '/home/codespace/.claude/',
    transcriptsDir: 'projects',
    supportsPtyResume: true,
    seed: [{ path: 'projects/', content: '' }],
    resumeFlags: ['--continue'],
  },
  codex: {
    hostDirName: 'codex-state',
    containerMountPath: '/home/codespace/.codex/',
    transcriptsDir: 'sessions',
    supportsPtyResume: false,
    seed: [
      { path: 'sessions/', content: '' },
      { path: 'logs/', content: '' },
    ],
    resumeFlags: [],
  },
} satisfies Record<string, ConversationStateConfig>;

/** Seed directories, settings, and command history alone cannot resume a conversation. */
export function hasConversationState(
  stateDir: string | undefined,
  config: ConversationStateConfig | undefined,
  conversationId?: string,
): boolean {
  return (
    stateDir !== undefined &&
    config !== undefined &&
    containsTranscript(resolve(stateDir, config.transcriptsDir), conversationId)
  );
}

function containsTranscript(directory: string, conversationId?: string): boolean {
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && containsTranscript(path, conversationId)) return true;
      if (!entry.isFile()) continue;
      // Batch re-entry checks the exact conversation file's presence. PTY
      // discovery instead requires at least one nonempty transcript.
      if (
        conversationId !== undefined
          ? entry.name === `${conversationId}.jsonl`
          : entry.name.endsWith('.jsonl') && statSync(path).size > 0
      )
        return true;
    }
  } catch {
    // Missing/unreadable state (or a concurrent removal) cannot establish resumability.
  }
  return false;
}
