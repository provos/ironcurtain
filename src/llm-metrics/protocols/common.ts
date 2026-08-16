import {
  asBoolean,
  asIdentifier,
  asKnownString,
  asRecord,
  asSafeCount,
  mergeQualityFlags,
  type UnknownRecord,
} from '../normalization.js';
import type {
  GatewayResponseHeaders,
  LlmOutcome,
  LlmRequestFacts,
  NormalizedStopReason,
  NormalizedTermination,
  ReasoningMode,
  RefusalSource,
} from '../types.js';

export const SERVICE_TIERS = ['auto', 'default', 'standard', 'priority', 'flex', 'scale', 'batch'] as const;
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const SPEED_MODES = ['standard', 'fast'] as const;

export function readCount(record: UnknownRecord | undefined, key: string, flags: Set<string>): number | null {
  if (!record || !(key in record) || record[key] === null) return null;
  const count = asSafeCount(record[key]);
  if (count === null) flags.add(`invalid_count:${key}`);
  return count;
}

export function readIdentifier(
  record: UnknownRecord | undefined,
  key: string,
  flags: Set<string>,
  maximumLength = 256,
): string | null {
  if (!record || !(key in record) || record[key] === null) return null;
  const identifier = asIdentifier(record[key], maximumLength);
  if (identifier === null) flags.add(`invalid_identifier:${key}`);
  return identifier;
}

/** Read one explicitly allowlisted response header as a bounded opaque identifier. */
export function readResponseHeaderIdentifier(
  headers: GatewayResponseHeaders,
  wanted: string,
  flags: Set<string>,
): string | null {
  const normalized = wanted.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== normalized || value === undefined) continue;
    const raw = typeof value === 'string' ? value : value.length === 1 ? value[0] : undefined;
    const identifier = asIdentifier(raw);
    if (identifier === null) flags.add('invalid_provider_request_id');
    return identifier;
  }
  return null;
}

export function inspectCommonRequest(value: unknown, serviceTiers: readonly string[] = SERVICE_TIERS): LlmRequestFacts {
  const body = asRecord(value);
  const flags = new Set<string>();
  if (!body) flags.add('invalid_request_envelope');

  const model = readIdentifier(body, 'model', flags);
  const stream = body && 'stream' in body ? asBoolean(body['stream']) : null;
  if (body && 'stream' in body && stream === null) flags.add('invalid_boolean:stream');

  const serviceTier = asKnownString(body?.['service_tier'], serviceTiers);
  if (body?.['service_tier'] !== undefined && body['service_tier'] !== null && serviceTier === null) {
    flags.add('unknown_service_tier');
  }

  const reasoning = asRecord(body?.['reasoning']);
  const thinking = asRecord(body?.['thinking']);
  const outputConfig = asRecord(body?.['output_config']);
  const effort = asKnownString(
    reasoning?.['effort'] ?? body?.['reasoning_effort'] ?? outputConfig?.['effort'],
    REASONING_EFFORTS,
  );
  const thinkingType = asKnownString(thinking?.['type'], ['enabled', 'adaptive', 'disabled'] as const);
  let reasoningMode: ReasoningMode = 'unknown';
  if (thinkingType === 'adaptive') reasoningMode = 'adaptive';
  else if (thinkingType === 'enabled') reasoningMode = 'enabled';
  else if (thinkingType === 'disabled' || effort === 'none') reasoningMode = 'disabled';
  else if (effort !== null) reasoningMode = 'effort';

  const thinkingBudgetTokens = readCount(thinking, 'budget_tokens', flags);
  const rawSpeed = body?.['speed'] ?? body?.['speed_mode'];
  const speedMode = asKnownString(rawSpeed, SPEED_MODES);
  if (rawSpeed !== undefined && rawSpeed !== null && speedMode === null) {
    flags.add('unknown_speed_mode');
  }

  return {
    requestedModel: model,
    streaming: stream,
    requestedServiceTier: serviceTier,
    reasoningMode,
    reasoningEffort: effort,
    thinkingBudgetTokens,
    speedMode,
    qualityFlags: [...flags].sort(),
  };
}

export function emptyOutcome(): LlmOutcome {
  return {
    termination: 'unknown',
    providerStopReason: 'not_reported',
    responseStatus: null,
    refusal: null,
    refusalCategory: null,
    refusalSource: 'not_reported',
  };
}

export interface OutcomeInput {
  readonly termination?: NormalizedTermination;
  readonly providerStopReason?: NormalizedStopReason;
  readonly responseStatus?: number | null;
  readonly refusal?: boolean | null;
  readonly refusalCategory?: string | null;
  readonly refusalSource?: RefusalSource;
}

export function makeOutcome(input: OutcomeInput): LlmOutcome {
  return {
    ...emptyOutcome(),
    ...input,
  };
}

export function hasTypedItem(value: unknown, wantedTypes: readonly string[]): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (typeof record['type'] === 'string' && wantedTypes.includes(record['type'])) return true;
  for (const key of ['content', 'output', 'choices']) {
    const collection = record[key];
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (hasTypedItem(item, wantedTypes)) return true;
      const itemRecord = asRecord(item);
      if (itemRecord && hasTypedItem(itemRecord['message'], wantedTypes)) return true;
    }
  }
  return false;
}

export function stableFlags(...groups: readonly (readonly string[])[]): readonly string[] {
  return mergeQualityFlags(...groups);
}

export function sameNullableNumber(left: number | null, right: number | null): boolean {
  return left === right;
}
