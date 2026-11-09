import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getConversationStateConfig, hasConversationState } from '../src/docker/conversation-state.js';

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
    const transcript = join(stateDir, relativePath);
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, '{"type":"user"}\n');
    expect(hasConversationState(stateDir, agent)).toBe(true);
  });

  it.each(['claude-code', 'codex'])(
    'does not mistake seeded %s directories and settings for a conversation',
    (agent) => {
      const config = getConversationStateConfig(agent)!;
      for (const entry of config.seed) mkdirSync(join(stateDir, entry.path), { recursive: true });
      writeFileSync(join(stateDir, 'settings.json'), '{}');
      writeFileSync(join(stateDir, 'history.jsonl'), '{"display":"a command"}\n');
      expect(hasConversationState(stateDir, agent)).toBe(false);
    },
  );

  it('rejects empty transcript files', () => {
    const projectDir = join(stateDir, 'projects', '-workspace');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'conversation.jsonl'), '');
    expect(hasConversationState(stateDir, 'claude-code')).toBe(false);
  });

  it('handles missing state and unsupported agents', () => {
    expect(hasConversationState(undefined, 'claude-code')).toBe(false);
    expect(hasConversationState(join(stateDir, 'missing'), 'claude-code')).toBe(false);
    expect(hasConversationState(stateDir, 'goose')).toBe(false);
    expect(getConversationStateConfig('goose')).toBeUndefined();
  });
});
