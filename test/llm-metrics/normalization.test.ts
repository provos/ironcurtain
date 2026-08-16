import { describe, expect, it } from 'vitest';
import {
  addCounts,
  asFiniteCost,
  asIdentifier,
  asProviderIdentifier,
  asSafeCount,
  makeNormalizedUsage,
  subtractCount,
  usageCompleteness,
} from '../../src/llm-metrics/normalization.js';

describe('LLM usage normalization primitives', () => {
  it('preserves an explicitly reported zero and rejects invalid counts', () => {
    expect(asSafeCount(0)).toBe(0);
    expect(asSafeCount(-1)).toBeNull();
    expect(asSafeCount(1.5)).toBeNull();
    expect(asSafeCount(Number.NaN)).toBeNull();
    expect(asSafeCount(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });

  it('never substitutes missing arithmetic operands with zero', () => {
    expect(addCounts(3, 4, 0)).toBe(7);
    expect(addCounts(3, null, 0)).toBeNull();
    expect(addCounts(Number.MAX_SAFE_INTEGER, 1)).toBeNull();
    expect(subtractCount(10, 3)).toBe(7);
    expect(subtractCount(3, 10)).toBeNull();
    expect(subtractCount(3, null)).toBeNull();
  });

  it('keeps cost semantics distinct from token integer semantics', () => {
    expect(asFiniteCost(0)).toBe(0);
    expect(asFiniteCost(0.00125)).toBe(0.00125);
    expect(asFiniteCost(-0.01)).toBeNull();
    expect(asFiniteCost(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('accepts only bounded identifier-shaped values', () => {
    expect(asIdentifier('openai/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(asIdentifier('prompt text with spaces')).toBeNull();
    expect(asProviderIdentifier('Google AI Studio')).toBe('Google AI Studio');
    expect(asProviderIdentifier('provider\nheader')).toBeNull();
  });

  it('defaults every absent usage field to null, never zero', () => {
    expect(makeNormalizedUsage()).toMatchObject({
      inputTokensTotal: null,
      toolUseInputTokens: null,
      outputTokensTotal: null,
      thinkingTokens: null,
      canonicalTotalTokens: null,
      costUsd: null,
      usageCompleteness: 'missing',
    });
  });

  it('classifies complete, partial, missing, and wholly invalid usage', () => {
    expect(usageCompleteness(1, 2, true, false)).toBe('complete');
    expect(usageCompleteness(1, null, true, false)).toBe('partial');
    expect(usageCompleteness(null, null, false, false)).toBe('missing');
    expect(usageCompleteness(null, null, true, true)).toBe('invalid');
  });
});
