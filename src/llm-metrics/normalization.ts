import type { NormalizedUsage, OutputTokenSemantics, TokenMeasurementAccuracy, UsageCompleteness } from './types.js';

export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

export function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asSafeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function asFiniteCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

/**
 * Reads a bounded identifier-shaped string. This must not be used for content,
 * errors, arbitrary metadata, or human-readable summaries.
 */
export function asIdentifier(value: unknown, maximumLength = 256): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) return null;
  return SAFE_IDENTIFIER.test(value) ? value : null;
}

const SAFE_PROVIDER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9 ._:/@()+&-]*$/;

/** Bounded public provider label (for example `Google AI Studio`). */
export function asProviderIdentifier(value: unknown, maximumLength = 128): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) return null;
  return SAFE_PROVIDER_IDENTIFIER.test(value) ? value : null;
}

export function asKnownString<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

export function addCounts(...values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  let total = 0;
  for (const value of values) {
    total += value ?? 0;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export function subtractCount(total: number | null, subset: number | null): number | null {
  if (total === null || subset === null || subset > total) return null;
  return total - subset;
}

export function mergeQualityFlags(...groups: readonly (readonly string[])[]): readonly string[] {
  return [...new Set(groups.flat())].sort();
}

export interface NormalizedUsageInput {
  readonly inputTokensReported?: number | null;
  readonly inputTokensTotal?: number | null;
  readonly inputTokensAccuracy?: TokenMeasurementAccuracy;
  readonly inputTokensUncached?: number | null;
  readonly cacheReadInputTokens?: number | null;
  readonly cacheWriteInputTokens?: number | null;
  readonly toolUseInputTokens?: number | null;
  readonly outputTokensReported?: number | null;
  readonly outputTokenSemantics?: OutputTokenSemantics;
  readonly outputTokensTotal?: number | null;
  readonly outputTokensAccuracy?: TokenMeasurementAccuracy;
  readonly thinkingTokens?: number | null;
  readonly thinkingTokensAccuracy?: TokenMeasurementAccuracy;
  readonly nonThinkingOutputTokens?: number | null;
  readonly nonThinkingOutputTokensAccuracy?: TokenMeasurementAccuracy;
  readonly providerTotalTokens?: number | null;
  readonly canonicalTotalTokens?: number | null;
  readonly costUsd?: number | null;
  readonly usageSource?: string | null;
  readonly usageCompleteness?: UsageCompleteness;
  readonly qualityFlags?: readonly string[];
}

export function makeNormalizedUsage(input: NormalizedUsageInput = {}): NormalizedUsage {
  return {
    inputTokensReported: input.inputTokensReported ?? null,
    inputTokensTotal: input.inputTokensTotal ?? null,
    inputTokensAccuracy: input.inputTokensAccuracy ?? 'unknown',
    inputTokensUncached: input.inputTokensUncached ?? null,
    cacheReadInputTokens: input.cacheReadInputTokens ?? null,
    cacheWriteInputTokens: input.cacheWriteInputTokens ?? null,
    toolUseInputTokens: input.toolUseInputTokens ?? null,
    outputTokensReported: input.outputTokensReported ?? null,
    outputTokenSemantics: input.outputTokenSemantics ?? 'unknown',
    outputTokensTotal: input.outputTokensTotal ?? null,
    outputTokensAccuracy: input.outputTokensAccuracy ?? 'unknown',
    thinkingTokens: input.thinkingTokens ?? null,
    thinkingTokensAccuracy: input.thinkingTokensAccuracy ?? 'unknown',
    nonThinkingOutputTokens: input.nonThinkingOutputTokens ?? null,
    nonThinkingOutputTokensAccuracy: input.nonThinkingOutputTokensAccuracy ?? 'unknown',
    providerTotalTokens: input.providerTotalTokens ?? null,
    canonicalTotalTokens: input.canonicalTotalTokens ?? null,
    costUsd: input.costUsd ?? null,
    usageSource: input.usageSource ?? null,
    usageCompleteness: input.usageCompleteness ?? 'missing',
    usageSemanticsVersion: 1,
    qualityFlags: mergeQualityFlags(input.qualityFlags ?? []),
  };
}

export function usageCompleteness(
  inputTotal: number | null,
  outputTotal: number | null,
  sawUsage: boolean,
  invalid: boolean,
): UsageCompleteness {
  if (!sawUsage) return 'missing';
  if (invalid && inputTotal === null && outputTotal === null) return 'invalid';
  return inputTotal !== null && outputTotal !== null ? 'complete' : 'partial';
}

export function qualityForCount(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null || asSafeCount(value) !== null) return [];
  return [`invalid_count:${field}`];
}
