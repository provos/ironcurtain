/**
 * Shared fixtures for direct machine-builder tests. For orchestrator-level
 * tests (MockSession, etc.) see test-helpers.ts.
 */

import type { AgentInvokeResult } from '../../src/workflow/machine-builder.js';
import type { AgentConversationId } from '../../src/session/types.js';

export function makeAgentResult(overrides: Partial<AgentInvokeResult> = {}): AgentInvokeResult {
  return {
    output: {
      completed: true,
      verdict: 'approved',
      confidence: 'high',
      escalation: null,
      testCount: null,
      notes: null,
    },
    agentConversationId: 'test-conversation' as AgentConversationId,
    artifacts: {},
    outputHash: 'hash-1',
    responseText: 'Agent response text',
    ...overrides,
  };
}

export function makeVerdictResult(verdict: string, overrides: Partial<AgentInvokeResult> = {}): AgentInvokeResult {
  return makeAgentResult({
    output: {
      completed: true,
      verdict,
      confidence: 'high',
      escalation: null,
      testCount: null,
      notes: null,
    },
    ...overrides,
  });
}

export function makeRejectedResult(opts: { notes?: string; responseText?: string } = {}): AgentInvokeResult {
  return makeAgentResult({
    output: {
      completed: true,
      verdict: 'rejected',
      confidence: 'high',
      escalation: null,
      testCount: null,
      notes: opts.notes ?? 'needs work',
    },
    outputHash: 'rejected-hash',
    ...(opts.responseText !== undefined ? { responseText: opts.responseText } : {}),
  });
}

/** Wait for the machine to settle after an async transition. */
export function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
