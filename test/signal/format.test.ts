import { describe, it, expect } from 'vitest';
import {
  splitMessage,
  formatEscalationBanner,
  formatBudgetMessage,
  formatBudgetSummary,
} from '../../src/signal/format.js';
import type { EscalationRequest, BudgetStatus } from '../../src/session/types.js';

describe('splitMessage', () => {
  it('returns single chunk for short messages', () => {
    expect(splitMessage('hello', 2000)).toEqual(['hello']);
  });

  it('returns single chunk for messages exactly at limit', () => {
    const text = 'x'.repeat(2000);
    expect(splitMessage(text, 2000)).toEqual([text]);
  });

  it('splits at paragraph boundaries when available', () => {
    // Total: 1500 + 2 + 1000 = 2502, exceeds 2000 limit
    const text = 'A'.repeat(1500) + '\n\n' + 'B'.repeat(1000);
    const chunks = splitMessage(text, 2000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('A'.repeat(1500));
    expect(chunks[1]).toBe('B'.repeat(1000));
  });

  it('splits at line boundaries when no paragraph break exists', () => {
    const text = 'A'.repeat(1500) + '\n' + 'B'.repeat(600);
    const chunks = splitMessage(text, 2000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('A'.repeat(1500));
    expect(chunks[1]).toBe('B'.repeat(600));
  });

  it('hard-splits at max length when no break point exists', () => {
    const text = 'A'.repeat(3000);
    const chunks = splitMessage(text, 2000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('A'.repeat(2000));
    expect(chunks[1]).toBe('A'.repeat(1000));
  });

  it('handles multiple splits', () => {
    const text = 'A'.repeat(6000);
    const chunks = splitMessage(text, 2000);
    expect(chunks).toHaveLength(3);
  });

  it('trims whitespace around split points', () => {
    const text = 'A'.repeat(100) + '\n\n' + 'B'.repeat(100);
    const chunks = splitMessage(text, 150);
    expect(chunks[0]).toBe('A'.repeat(100));
    expect(chunks[1]).toBe('B'.repeat(100));
  });

  it('handles empty string', () => {
    expect(splitMessage('', 2000)).toEqual(['']);
  });
});

describe('formatEscalationBanner', () => {
  const request: EscalationRequest = {
    escalationId: 'test-123',
    toolName: 'write_file',
    serverName: 'filesystem',
    arguments: { path: '/etc/hosts' },
    reason: 'Write outside sandbox',
  };

  it('includes tool name with Signal inline code', () => {
    const result = formatEscalationBanner(request);
    expect(result).toContain('`filesystem/write_file`');
  });

  it('includes reason with italic markup', () => {
    const result = formatEscalationBanner(request);
    expect(result).toContain('*Write outside sandbox*');
  });

  it('includes approve/deny instructions', () => {
    const result = formatEscalationBanner(request);
    expect(result).toContain('approve');
    expect(result).toContain('deny');
  });

  it('includes bold header', () => {
    const result = formatEscalationBanner(request);
    expect(result).toContain('**ESCALATION:');
  });

  it('includes arguments as JSON', () => {
    const result = formatEscalationBanner(request);
    expect(result).toContain('/etc/hosts');
  });
});

describe('formatBudgetMessage', () => {
  const status: BudgetStatus = {
    totalInputTokens: 5000,
    totalOutputTokens: 2000,
    totalTokens: 7000,
    stepCount: 5,
    elapsedSeconds: 120,
    estimatedCostUsd: 0.35,
    tokenTrackingAvailable: true,
    limits: {
      maxTotalTokens: 1_000_000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5.0,
      warnThresholdPercent: 80,
    },
    cumulative: {
      totalInputTokens: 10_000,
      totalOutputTokens: 4000,
      totalTokens: 14_000,
      stepCount: 10,
      activeSeconds: 250,
      estimatedCostUsd: 0.7,
    },
  };

  it('includes turn budget section', () => {
    const result = formatBudgetMessage(status);
    expect(result).toContain('Current turn budget');
  });

  it('includes session totals section', () => {
    const result = formatBudgetMessage(status);
    expect(result).toContain('Session totals');
  });

  it('formats token counts', () => {
    const result = formatBudgetMessage(status);
    expect(result).toContain('7,000');
  });

  it('shows N/A when token tracking unavailable', () => {
    const noTokens = { ...status, tokenTrackingAvailable: false };
    const result = formatBudgetMessage(noTokens);
    expect(result).toContain('N/A');
  });
});

describe('formatBudgetSummary', () => {
  const status: BudgetStatus = {
    totalInputTokens: 5000,
    totalOutputTokens: 2000,
    totalTokens: 7000,
    stepCount: 5,
    elapsedSeconds: 120,
    estimatedCostUsd: 0.35,
    tokenTrackingAvailable: true,
    limits: {
      maxTotalTokens: 1_000_000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5.0,
      warnThresholdPercent: 80,
    },
    cumulative: {
      totalInputTokens: 10_000,
      totalOutputTokens: 4000,
      totalTokens: 14_000,
      stepCount: 10,
      activeSeconds: 250,
      estimatedCostUsd: 0.7,
    },
  };

  it('includes cumulative token count', () => {
    const result = formatBudgetSummary(status);
    expect(result).toContain('14,000 tokens');
  });

  it('includes step count', () => {
    const result = formatBudgetSummary(status);
    expect(result).toContain('10 steps');
  });

  it('includes cost', () => {
    const result = formatBudgetSummary(status);
    expect(result).toContain('$0.70');
  });

  it('omits tokens when tracking unavailable', () => {
    const noTokens = { ...status, tokenTrackingAvailable: false };
    const result = formatBudgetSummary(noTokens);
    expect(result).not.toContain('tokens');
  });
});
