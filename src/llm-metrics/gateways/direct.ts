import type { GatewayObservation, LlmGatewayAccumulator, LlmGatewayAdapter, LlmProtocolObservation } from '../types.js';
import { asProviderIdentifier } from '../normalization.js';
import { emptyGatewayObservation } from './common.js';

export interface DirectGatewayOptions {
  /** Stable public provider identifier for a verified official origin. */
  readonly providerId: string;
  readonly officialOrigin: boolean;
}

class DirectGatewayAccumulator implements LlmGatewayAccumulator {
  constructor(private readonly options: DirectGatewayOptions) {}

  observeHeaders(): void {}

  observePayload(): void {}

  snapshot(protocol?: LlmProtocolObservation): GatewayObservation {
    if (!this.options.officialOrigin) {
      return { ...emptyGatewayObservation(), qualityFlags: ['unverified_direct_origin'] };
    }
    const provider = asProviderIdentifier(this.options.providerId);
    return {
      ...emptyGatewayObservation(),
      servedModel:
        protocol?.responseModel != null
          ? { value: protocol.responseModel, source: 'protocol_response_direct' }
          : { value: null, source: 'not_exposed' },
      servedProvider:
        provider !== null ? { value: provider, source: 'configured_route' } : { value: null, source: 'not_exposed' },
      qualityFlags: provider === null ? ['invalid_configured_provider_id'] : [],
    };
  }
}

export class DirectGatewayAdapter implements LlmGatewayAdapter {
  readonly id = 'direct';

  constructor(private readonly options: DirectGatewayOptions) {}

  createAccumulator(): LlmGatewayAccumulator {
    return new DirectGatewayAccumulator(this.options);
  }
}
