import type { GatewayObservation, LlmGatewayAccumulator, LlmGatewayAdapter } from '../types.js';
import { emptyGatewayObservation } from './common.js';

class OpaqueGatewayAccumulator implements LlmGatewayAccumulator {
  observeHeaders(): void {}

  observePayload(): void {}

  snapshot(): GatewayObservation {
    return emptyGatewayObservation();
  }
}

export class OpaqueGatewayAdapter implements LlmGatewayAdapter {
  readonly id = 'opaque';

  createAccumulator(): LlmGatewayAccumulator {
    return new OpaqueGatewayAccumulator();
  }
}
