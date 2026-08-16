import { asIdentifier, asProviderIdentifier, asRecord } from '../normalization.js';
import type { GatewayObservation, GatewayResponseHeaders, LlmGatewayAccumulator, LlmGatewayAdapter } from '../types.js';
import { emptyGatewayObservation, parseGatewayRouteAttempts, readHeader } from './common.js';

class IronCurtainGatewayAccumulator implements LlmGatewayAccumulator {
  private model: string | null = null;
  private provider: string | null = null;
  private generationId: string | null = null;
  private attempts: GatewayObservation['routeAttempts'] = [];
  private contractSeen = false;
  private readonly flags = new Set<string>();

  observeHeaders(headers: GatewayResponseHeaders): void {
    const version = readHeader(headers, 'x-ironcurtain-route-version');
    if (version === null) return;
    if (version !== '1') {
      this.flags.add('unsupported_ironcurtain_route_version');
      return;
    }
    this.contractSeen = true;
    this.observeIdentity(
      readHeader(headers, 'x-ironcurtain-served-provider'),
      readHeader(headers, 'x-ironcurtain-served-model'),
    );
    const id = asIdentifier(readHeader(headers, 'x-ironcurtain-request-id'));
    if (id !== null) this.generationId = id;
  }

  observePayload(value: unknown): void {
    const contract = asRecord(asRecord(value)?.['ironcurtain_route']);
    if (!contract) return;
    if (contract['version'] !== 1) {
      this.flags.add('unsupported_ironcurtain_route_version');
      return;
    }
    this.contractSeen = true;
    this.observeIdentity(contract['served_provider'], contract['served_model']);
    const id = asIdentifier(contract['request_id']);
    if (contract['request_id'] !== undefined && id === null) this.flags.add('invalid_ironcurtain_request_id');
    if (id !== null) this.generationId = id;
    this.attempts = parseGatewayRouteAttempts(contract['attempts'], {
      source: 'trusted_gateway_header',
      truncatedFlag: 'ironcurtain_attempts_truncated',
      includeSelected: true,
      flags: this.flags,
    });
  }

  snapshot(): GatewayObservation {
    return {
      ...emptyGatewayObservation(),
      servedModel:
        this.model !== null
          ? { value: this.model, source: 'trusted_gateway_header' }
          : { value: null, source: 'not_exposed' },
      servedProvider:
        this.provider !== null
          ? { value: this.provider, source: 'trusted_gateway_header' }
          : { value: null, source: 'not_exposed' },
      generationId: this.generationId,
      routeAttempts: this.attempts,
      qualityFlags: [...this.flags, ...(this.contractSeen ? [] : ['trusted_route_metadata_missing'])].sort(),
    };
  }

  private observeIdentity(providerValue: unknown, modelValue: unknown): void {
    const provider = asProviderIdentifier(providerValue);
    const model = asIdentifier(modelValue);
    if (providerValue != null && provider === null) this.flags.add('invalid_served_provider');
    if (modelValue != null && model === null) this.flags.add('invalid_served_model');
    if (provider !== null) this.provider = provider;
    if (model !== null) this.model = model;
  }
}

export class IronCurtainGatewayAdapter implements LlmGatewayAdapter {
  readonly id = 'ironcurtain';

  createAccumulator(): LlmGatewayAccumulator {
    return new IronCurtainGatewayAccumulator();
  }
}
