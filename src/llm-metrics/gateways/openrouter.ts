import { asArray, asFiniteCost, asIdentifier, asProviderIdentifier, asRecord } from '../normalization.js';
import type { GatewayObservation, GatewayResponseHeaders, LlmGatewayAccumulator, LlmGatewayAdapter } from '../types.js';
import { emptyGatewayObservation, parseGatewayRouteAttempts, readHeader } from './common.js';

const MAX_ROUTE_ATTEMPTS = 64;

class OpenRouterGatewayAccumulator implements LlmGatewayAccumulator {
  private servedModel: string | null = null;
  private servedProvider: string | null = null;
  private generationId: string | null = null;
  private costUsd: number | null = null;
  private routeAttempts: GatewayObservation['routeAttempts'] = [];
  private readonly flags = new Set<string>();

  observeHeaders(headers: GatewayResponseHeaders): void {
    const raw = readHeader(headers, 'x-generation-id');
    if (raw === null) return;
    const id = asIdentifier(raw);
    if (id === null) this.flags.add('invalid_generation_id');
    else this.generationId = id;
  }

  observePayload(value: unknown): void {
    const payload = asRecord(value);
    if (!payload) return;
    const response = asRecord(payload['response']);
    const message = asRecord(payload['message']);
    const usage = asRecord(payload['usage']) ?? asRecord(response?.['usage']) ?? asRecord(message?.['usage']);
    if (usage && 'cost' in usage) {
      const cost = asFiniteCost(usage['cost']);
      if (cost === null) this.flags.add('invalid_cost');
      else {
        if (this.costUsd !== null && this.costUsd !== cost) this.flags.add('conflicting_cost');
        this.costUsd = cost;
      }
    }
    const metadata =
      asRecord(payload['openrouter_metadata']) ??
      asRecord(response?.['openrouter_metadata']) ??
      asRecord(message?.['openrouter_metadata']);
    if (metadata) this.observeMetadata(metadata);
  }

  snapshot(): GatewayObservation {
    return {
      ...emptyGatewayObservation(),
      servedModel:
        this.servedModel !== null
          ? { value: this.servedModel, source: 'router_metadata' }
          : { value: null, source: 'not_exposed' },
      servedProvider:
        this.servedProvider !== null
          ? { value: this.servedProvider, source: 'router_metadata' }
          : { value: null, source: 'not_exposed' },
      generationId: this.generationId,
      costUsd: this.costUsd,
      routeAttempts: this.routeAttempts,
      qualityFlags: [...this.flags].sort(),
    };
  }

  private observeMetadata(metadata: Record<string, unknown>): void {
    const available = asArray(asRecord(metadata['endpoints'])?.['available']);
    if (available && available.length > MAX_ROUTE_ATTEMPTS) this.flags.add('router_endpoints_truncated');
    const selected = (available ?? [])
      .slice(0, MAX_ROUTE_ATTEMPTS)
      .find((entry) => asRecord(entry)?.['selected'] === true);
    const selectedRecord = asRecord(selected);
    if (selectedRecord) {
      const provider = asProviderIdentifier(selectedRecord['provider']);
      const model = asIdentifier(selectedRecord['model']);
      if (selectedRecord['provider'] !== undefined && provider === null) this.flags.add('invalid_served_provider');
      if (selectedRecord['model'] !== undefined && model === null) this.flags.add('invalid_served_model');
      if (provider !== null) this.servedProvider = provider;
      if (model !== null) this.servedModel = model;
    }

    this.routeAttempts = parseGatewayRouteAttempts(metadata['attempts'], {
      source: 'router_metadata',
      truncatedFlag: 'router_attempts_truncated',
      includeSelected: false,
      flags: this.flags,
    });
  }
}

export class OpenRouterGatewayAdapter implements LlmGatewayAdapter {
  readonly id = 'openrouter';

  createAccumulator(): LlmGatewayAccumulator {
    return new OpenRouterGatewayAccumulator();
  }
}
