import { describe, it, expect } from 'vitest';
import { agentOutputToEvent } from '../../src/workflow/transition.js';
import type { AgentOutput } from '../../src/workflow/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutput(overrides: Partial<AgentOutput> = {}): AgentOutput {
  return {
    completed: true,
    verdict: 'approved',
    confidence: 'high',
    escalation: null,
    testCount: null,
    notes: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agentOutputToEvent', () => {
  it('maps completed+approved to AGENT_COMPLETED', () => {
    const output = makeOutput({ verdict: 'approved', confidence: 'high' });
    const event = agentOutputToEvent(output);
    expect(event.type).toBe('AGENT_COMPLETED');
    if (event.type === 'AGENT_COMPLETED') {
      expect(event.output.verdict).toBe('approved');
    }
  });

  it('maps completed+rejected to AGENT_COMPLETED', () => {
    const output = makeOutput({ verdict: 'rejected' });
    const event = agentOutputToEvent(output);
    expect(event.type).toBe('AGENT_COMPLETED');
    if (event.type === 'AGENT_COMPLETED') {
      expect(event.output.verdict).toBe('rejected');
    }
  });

  it('maps completed+approved+low to AGENT_COMPLETED (guard handles routing)', () => {
    const output = makeOutput({ verdict: 'approved', confidence: 'low' });
    const event = agentOutputToEvent(output);
    expect(event.type).toBe('AGENT_COMPLETED');
    if (event.type === 'AGENT_COMPLETED') {
      expect(event.output.confidence).toBe('low');
    }
  });

  it('maps completed+spec_flaw to SPEC_FLAW_DETECTED', () => {
    const output = makeOutput({ verdict: 'spec_flaw' });
    const event = agentOutputToEvent(output);
    expect(event.type).toBe('SPEC_FLAW_DETECTED');
  });

  it('maps completed+blocked to AGENT_FAILED', () => {
    const output = makeOutput({ verdict: 'blocked', escalation: 'need API key' });
    const event = agentOutputToEvent(output);
    expect(event.type).toBe('AGENT_FAILED');
    if (event.type === 'AGENT_FAILED') {
      expect(event.error).toBe('need API key');
    }
  });

  it('maps not completed to AGENT_FAILED', () => {
    const output = makeOutput({ completed: false, notes: 'could not finish' });
    const event = agentOutputToEvent(output);
    expect(event.type).toBe('AGENT_FAILED');
    if (event.type === 'AGENT_FAILED') {
      expect(event.error).toBe('could not finish');
    }
  });

  it('uses escalation as error message when available for incomplete', () => {
    const output = makeOutput({ completed: false, escalation: 'need help', notes: 'fallback' });
    const event = agentOutputToEvent(output);
    expect(event.type).toBe('AGENT_FAILED');
    if (event.type === 'AGENT_FAILED') {
      expect(event.error).toBe('need help');
    }
  });

  it('uses default error message when notes and escalation are null', () => {
    const output = makeOutput({ completed: false, escalation: null, notes: null });
    const event = agentOutputToEvent(output);
    expect(event.type).toBe('AGENT_FAILED');
    if (event.type === 'AGENT_FAILED') {
      expect(event.error).toBe('Agent did not complete');
    }
  });

  it('uses notes as fallback for blocked verdict without escalation', () => {
    const output = makeOutput({ verdict: 'blocked', escalation: null, notes: 'stuck' });
    const event = agentOutputToEvent(output);
    expect(event.type).toBe('AGENT_FAILED');
    if (event.type === 'AGENT_FAILED') {
      expect(event.error).toBe('stuck');
    }
  });
});
