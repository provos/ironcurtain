import { asArray, asIdentifier, asProviderIdentifier, asRecord, asSafeCount } from '../normalization.js';
import type { GatewayObservation, GatewayResponseHeaders, GatewayRouteAttempt, SourcedIdentity } from '../types.js';

const MAX_GATEWAY_ROUTE_ATTEMPTS = 64;

export function notExposedIdentity(): SourcedIdentity {
  return { value: null, source: 'not_exposed' };
}

export function emptyGatewayObservation(): GatewayObservation {
  return {
    servedModel: notExposedIdentity(),
    servedProvider: notExposedIdentity(),
    generationId: null,
    costUsd: null,
    routeAttempts: [],
    qualityFlags: [],
  };
}

export function readHeader(headers: GatewayResponseHeaders, wanted: string): string | null {
  const normalized = wanted.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== normalized || value === undefined) continue;
    if (typeof value === 'string') return value;
    return value.length === 1 ? (value[0] ?? null) : null;
  }
  return null;
}

export function parseGatewayRouteAttempts(
  value: unknown,
  options: {
    readonly source: GatewayRouteAttempt['source'];
    readonly truncatedFlag: string;
    readonly includeSelected: boolean;
    readonly flags: Set<string>;
  },
): readonly GatewayRouteAttempt[] {
  const attempts = asArray(value);
  if (!attempts) return [];
  if (attempts.length > MAX_GATEWAY_ROUTE_ATTEMPTS) options.flags.add(options.truncatedFlag);
  return attempts.slice(0, MAX_GATEWAY_ROUTE_ATTEMPTS).map((attempt, index) => {
    const record = asRecord(attempt);
    const provider = asProviderIdentifier(record?.['provider']);
    const model = asIdentifier(record?.['model']);
    const rawStatus = asSafeCount(record?.['status']);
    const status = rawStatus !== null && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;
    if (record?.['provider'] != null && provider === null) options.flags.add('invalid_route_provider');
    if (record?.['model'] != null && model === null) options.flags.add('invalid_route_model');
    if (record?.['status'] != null && status === null) options.flags.add('invalid_route_status');
    return {
      ordinal: index + 1,
      provider,
      model,
      status,
      selected: options.includeSelected && typeof record?.['selected'] === 'boolean' ? record['selected'] : null,
      source: options.source,
    };
  });
}
