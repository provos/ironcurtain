import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BUILTIN_CONVERSATION_STATES, hasConversationState } from '../src/docker/conversation-state.js';
import { writeConversationTranscript } from './helpers/conversation-state.js';

describe('persisted conversation state', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'conversation-state-'));
  });

  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  it.each([
    ['claude-code', 'projects/-workspace/conversation.jsonl'],
    ['codex', 'sessions/2026/11/09/rollout.jsonl'],
  ])('finds persisted %s transcripts', (agent, relativePath) => {
    writeConversationTranscript(stateDir, relativePath);
    const config = BUILTIN_CONVERSATION_STATES[agent as keyof typeof BUILTIN_CONVERSATION_STATES];
    expect(hasConversationState(stateDir, config)).toBe(true);
  });

  it.each(['claude-code', 'codex'])(
    'does not mistake seeded %s directories and settings for a conversation',
    (agent) => {
      const config = BUILTIN_CONVERSATION_STATES[agent as keyof typeof BUILTIN_CONVERSATION_STATES];
      for (const entry of config.seed) mkdirSync(join(stateDir, entry.path), { recursive: true });
      writeFileSync(join(stateDir, 'settings.json'), '{}');
      writeFileSync(join(stateDir, 'history.jsonl'), '{"display":"a command"}\n');
      expect(hasConversationState(stateDir, config)).toBe(false);
    },
  );

  it('rejects empty transcript files', () => {
    writeConversationTranscript(stateDir, undefined, '');
    expect(hasConversationState(stateDir, BUILTIN_CONVERSATION_STATES['claude-code'])).toBe(false);
  });

  it('preserves exact-conversation presence checks without accepting another conversation', () => {
    writeConversationTranscript(stateDir, 'projects/-workspace/known.jsonl', '');
    const config = BUILTIN_CONVERSATION_STATES['claude-code'];
    expect(hasConversationState(stateDir, config, 'known')).toBe(true);
    expect(hasConversationState(stateDir, config, 'missing')).toBe(false);
    expect(hasConversationState(stateDir, config)).toBe(false);
  });

  it('uses adapter-provided layouts without a built-in agent lookup', () => {
    const config = {
      ...BUILTIN_CONVERSATION_STATES['claude-code'],
      transcriptsDir: 'custom/transcripts',
      resumeFlags: [],
    };
    writeConversationTranscript(stateDir, 'custom/transcripts/conversation.jsonl');
    expect(hasConversationState(stateDir, config)).toBe(true);
  });

  it('handles missing state and unsupported agents', () => {
    const config = BUILTIN_CONVERSATION_STATES['claude-code'];
    expect(hasConversationState(undefined, config)).toBe(false);
    expect(hasConversationState(join(stateDir, 'missing'), config)).toBe(false);
    expect(hasConversationState(stateDir, undefined)).toBe(false);
  });
});
