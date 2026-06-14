import { describe, it, expect } from 'vitest';
import { modelFlagMisusedAsAgent } from '../src/config/agent-model-guard.js';
import { DOCKER_AGENTS } from '../src/config/user-config.js';

describe('modelFlagMisusedAsAgent', () => {
  it('flags every known agent name passed as a model', () => {
    for (const agent of DOCKER_AGENTS) {
      const msg = modelFlagMisusedAsAgent(agent);
      expect(msg).not.toBeNull();
      expect(msg).toContain(`"${agent}" is an agent, not a model`);
      expect(msg).toContain(`--agent ${agent}`);
    }
  });

  it('returns null for undefined (no --model passed)', () => {
    expect(modelFlagMisusedAsAgent(undefined)).toBeNull();
  });

  it('returns null for a real model ID', () => {
    expect(modelFlagMisusedAsAgent('claude-opus-4-8')).toBeNull();
    expect(modelFlagMisusedAsAgent('openai:gpt-5.5')).toBeNull();
    expect(modelFlagMisusedAsAgent('sonnet')).toBeNull();
  });

  it('is exact-match only — does not flag substrings or prefixes', () => {
    expect(modelFlagMisusedAsAgent('codex-mini')).toBeNull();
    expect(modelFlagMisusedAsAgent('claude-code-fast')).toBeNull();
    expect(modelFlagMisusedAsAgent('')).toBeNull();
  });
});
