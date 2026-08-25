/** Exact per-session accounting for the strict package-egress proxy. */

export interface PackageEgressClock {
  now(): number;
}

export const systemPackageEgressClock: PackageEgressClock = { now: Date.now };

export interface PackageEgressLimits {
  readonly maxAttempts: number;
  readonly attemptBurst: number;
  readonly attemptRefillPerSecond: number;
  readonly maxConcurrentClients: number;
  readonly maxDerivedPerClient: number;
  readonly maxConcurrentDerived: number;
  readonly maxConcurrentUpstreams: number;
  readonly maxBytesPerRequest: number;
  readonly maxSessionBytes: number;
  readonly absoluteTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly tlsHandshakeMaxBytes: number;
  readonly tlsHandshakeTimeoutMs: number;
  readonly dnsTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxHeaderBytes: number;
  readonly maxTargetBytes: number;
}

export const DEFAULT_PACKAGE_EGRESS_LIMITS: PackageEgressLimits = Object.freeze({
  maxAttempts: 4_096,
  attemptBurst: 120,
  attemptRefillPerSecond: 2,
  maxConcurrentClients: 16,
  maxDerivedPerClient: 2,
  maxConcurrentDerived: 8,
  maxConcurrentUpstreams: 24,
  maxBytesPerRequest: 2 * 1024 * 1024 * 1024,
  maxSessionBytes: 16 * 1024 * 1024 * 1024,
  absoluteTimeoutMs: 10 * 60_000,
  idleTimeoutMs: 60_000,
  tlsHandshakeMaxBytes: 64 * 1024,
  tlsHandshakeTimeoutMs: 5_000,
  dnsTimeoutMs: 5_000,
  connectTimeoutMs: 10_000,
  maxHeaderBytes: 32 * 1024,
  maxTargetBytes: 8 * 1024,
});

export interface PackageEgressLedgerSnapshot {
  readonly attempts: number;
  readonly clientAttempts: number;
  readonly derivedAttempts: number;
  readonly activeClients: number;
  readonly activeDirect: number;
  readonly activeDerived: number;
  readonly activeUpstreams: number;
  readonly transferredBytes: number;
  readonly rateTokens: number;
  readonly stopped: boolean;
}

export interface PackageEgressUpstreamLease {
  charge(bytes: number): boolean;
  release(): void;
}

export interface PackageEgressClientLease {
  charge(bytes: number): boolean;
  admitDirect(): PackageEgressUpstreamLease;
  admitDerived(): PackageEgressUpstreamLease;
  release(): void;
}

export interface PackageEgressLedger {
  readonly snapshot: PackageEgressLedgerSnapshot;
  admitClient(): PackageEgressClientLease;
  stop(): void;
}

interface ClientState {
  active: boolean;
  counted: boolean;
  activeUpstreams: number;
  derivedAttempts: number;
  bytes: number;
}

/**
 * A client connection consumes the shared attempt/rate token before parsing.
 * Direct upstream work uses that admission. Every source-owned metadata fetch
 * consumes a second attempt/token plus its own derived and combined-upstream
 * slots before DNS, while sharing the originating client's byte/lifetime
 * accounting.
 */
export function createPackageEgressLedger(
  limits: PackageEgressLimits,
  clock: PackageEgressClock = systemPackageEgressClock,
): PackageEgressLedger {
  validateLimits(limits);
  let attempts = 0;
  let clientAttempts = 0;
  let derivedAttempts = 0;
  let activeClients = 0;
  let activeDirect = 0;
  let activeDerived = 0;
  let transferredBytes = 0;
  let tokens = limits.attemptBurst;
  let lastRefill = clock.now();
  let stopped = false;

  const refill = (): void => {
    const now = clock.now();
    const elapsedSeconds = Math.max(0, now - lastRefill) / 1_000;
    tokens = Math.min(limits.attemptBurst, tokens + elapsedSeconds * limits.attemptRefillPerSecond);
    lastRefill = now;
  };

  const consumeAttempt = (kind: 'client' | 'derived'): void => {
    attempts += 1;
    if (kind === 'client') clientAttempts += 1;
    else derivedAttempts += 1;
    refill();
    if (stopped) throw new Error('package egress ledger is stopped');
    if (attempts > limits.maxAttempts) throw new Error('package egress attempt ceiling reached');
    if (tokens < 1) throw new Error('package egress attempt rate exceeded');
    tokens -= 1;
  };

  const charge = (client: ClientState, count: number): boolean => {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('package egress byte count must be a nonnegative safe integer');
    }
    client.bytes += count;
    transferredBytes += count;
    return client.bytes <= limits.maxBytesPerRequest && transferredBytes <= limits.maxSessionBytes;
  };

  const admitUpstream = (client: ClientState, kind: 'direct' | 'derived'): PackageEgressUpstreamLease => {
    if (!client.active) throw new Error('package egress client lease is released');
    if (stopped) throw new Error('package egress ledger is stopped');
    if (kind === 'derived') consumeAttempt('derived');
    if (activeDirect + activeDerived >= limits.maxConcurrentUpstreams) {
      throw new Error('package egress combined upstream concurrency ceiling reached');
    }
    if (kind === 'direct' && activeDirect >= limits.maxConcurrentClients) {
      throw new Error('package egress direct concurrency ceiling reached');
    }
    if (kind === 'derived') {
      if (client.derivedAttempts >= limits.maxDerivedPerClient) {
        throw new Error('package egress per-client derived request ceiling reached');
      }
      if (activeDerived >= limits.maxConcurrentDerived) {
        throw new Error('package egress derived concurrency ceiling reached');
      }
      client.derivedAttempts += 1;
      activeDerived += 1;
    } else {
      activeDirect += 1;
    }

    client.activeUpstreams += 1;
    let released = false;
    return {
      charge(count): boolean {
        if (released) return false;
        return charge(client, count);
      },
      release(): void {
        if (released) return;
        released = true;
        if (kind === 'direct') activeDirect -= 1;
        else activeDerived -= 1;
        client.activeUpstreams -= 1;
        if (!client.active && client.counted && client.activeUpstreams === 0) {
          client.counted = false;
          activeClients -= 1;
        }
      },
    };
  };

  return {
    get snapshot(): PackageEgressLedgerSnapshot {
      // Observation must be side-effect free and byte-stable: startup canary
      // evidence compares snapshots before/after a no-egress build. Tokens are
      // refilled only at the next admission, where the value is authoritative.
      return {
        attempts,
        clientAttempts,
        derivedAttempts,
        activeClients,
        activeDirect,
        activeDerived,
        activeUpstreams: activeDirect + activeDerived,
        transferredBytes,
        rateTokens: tokens,
        stopped,
      };
    },
    admitClient(): PackageEgressClientLease {
      consumeAttempt('client');
      if (activeClients >= limits.maxConcurrentClients) {
        throw new Error('package egress client concurrency ceiling reached');
      }
      activeClients += 1;
      const client: ClientState = {
        active: true,
        counted: true,
        activeUpstreams: 0,
        derivedAttempts: 0,
        bytes: 0,
      };
      return {
        charge(count): boolean {
          return charge(client, count);
        },
        admitDirect(): PackageEgressUpstreamLease {
          return admitUpstream(client, 'direct');
        },
        admitDerived(): PackageEgressUpstreamLease {
          return admitUpstream(client, 'derived');
        },
        release(): void {
          if (!client.active) return;
          client.active = false;
          if (client.counted && client.activeUpstreams === 0) {
            client.counted = false;
            activeClients -= 1;
          }
        },
      };
    },
    stop(): void {
      stopped = true;
    },
  };
}

function validateLimits(limits: PackageEgressLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`package egress limit ${name} must be positive`);
    }
  }
  for (const name of [
    'maxAttempts',
    'attemptBurst',
    'maxConcurrentClients',
    'maxDerivedPerClient',
    'maxConcurrentDerived',
    'maxConcurrentUpstreams',
    'maxBytesPerRequest',
    'maxSessionBytes',
    'absoluteTimeoutMs',
    'idleTimeoutMs',
    'tlsHandshakeMaxBytes',
    'tlsHandshakeTimeoutMs',
    'dnsTimeoutMs',
    'connectTimeoutMs',
    'maxHeaderBytes',
    'maxTargetBytes',
  ] as const) {
    if (!Number.isSafeInteger(limits[name])) {
      throw new Error(`package egress limit ${name} must be a safe integer`);
    }
  }
  if (limits.maxBytesPerRequest > limits.maxSessionBytes) {
    throw new Error('package egress per-request byte ceiling exceeds the session ceiling');
  }
  if (limits.maxConcurrentClients + limits.maxConcurrentDerived > limits.maxConcurrentUpstreams) {
    throw new Error('package egress direct plus derived concurrency ceilings exceed the combined ceiling');
  }
}
