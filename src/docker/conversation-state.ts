/** Persisted conversation layouts shared by adapters and resume discovery. */
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConversationStateConfig } from './agent-adapter.js';

export const CLAUDE_CODE_CONVERSATION_STATE: ConversationStateConfig = {
  hostDirName: 'claude-state',
  containerMountPath: '/home/codespace/.claude/',
  seed: [{ path: 'projects/', content: '' }],
  resumeFlags: ['--continue'],
};

export const CODEX_CONVERSATION_STATE: ConversationStateConfig = {
  hostDirName: 'codex-state',
  containerMountPath: '/home/codespace/.codex/',
  seed: [
    { path: 'sessions/', content: '' },
    { path: 'logs/', content: '' },
  ],
  resumeFlags: [],
};

const layouts = new Map<string, { config: ConversationStateConfig; transcriptsDir: string }>([
  ['claude-code', { config: CLAUDE_CODE_CONVERSATION_STATE, transcriptsDir: 'projects' }],
  ['codex', { config: CODEX_CONVERSATION_STATE, transcriptsDir: 'sessions' }],
]);

export function getConversationStateConfig(agent: string): ConversationStateConfig | undefined {
  return layouts.get(agent)?.config;
}

/** Seed directories, settings, and command history alone cannot resume a conversation. */
export function hasConversationState(stateDir: string | undefined, agent: string): boolean {
  const layout = layouts.get(agent);
  return stateDir !== undefined && layout !== undefined && containsTranscript(resolve(stateDir, layout.transcriptsDir));
}

function containsTranscript(directory: string): boolean {
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && containsTranscript(path)) return true;
      if (entry.isFile() && entry.name.endsWith('.jsonl') && statSync(path).size > 0) return true;
    }
  } catch {
    // Missing/unreadable state (or a concurrent removal) cannot establish resumability.
  }
  return false;
}
