import { describe, expect, it } from 'vitest';
import {
  createPackageEgressLedger,
  DEFAULT_PACKAGE_EGRESS_LIMITS,
  type PackageEgressClock,
  type PackageEgressLimits,
} from '../../src/docker/package-egress-ledger.js';

function limits(overrides: Partial<PackageEgressLimits> = {}): PackageEgressLimits {
  return { ...DEFAULT_PACKAGE_EGRESS_LIMITS, ...overrides };
}

describe('package egress ledger', () => {
  it('pins the admitted direct-request bounds', () => {
    expect(DEFAULT_PACKAGE_EGRESS_LIMITS).toEqual({
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
  });

  it('ties a direct upstream lease and its bytes to the accepted client request', () => {
    const ledger = createPackageEgressLedger(limits());
    const client = ledger.admitClient();
    const direct = client.admitDirect();

    expect(client.charge(11)).toBe(true);
    expect(direct.charge(7)).toBe(true);
    expect(ledger.snapshot).toMatchObject({
      attempts: 1,
      clientAttempts: 1,
      activeClients: 1,
      activeDirect: 1,
      activeDerived: 0,
      activeUpstreams: 1,
      transferredBytes: 18,
    });
    expect(client.admitDerived).toBeTypeOf('function');

    client.release();
    expect(ledger.snapshot.activeClients).toBe(1);
    direct.release();
    expect(ledger.snapshot).toMatchObject({ activeClients: 0, activeUpstreams: 0 });
  });

  it('charges and bounds source-owned derived work under the originating client', () => {
    const ledger = createPackageEgressLedger(limits());
    const client = ledger.admitClient();
    const first = client.admitDerived();
    const second = client.admitDerived();
    expect(() => client.admitDerived()).toThrow(/per-client derived/u);
    expect(first.charge(7)).toBe(true);
    expect(ledger.snapshot).toMatchObject({
      attempts: 4,
      clientAttempts: 1,
      derivedAttempts: 3,
      activeDerived: 2,
      activeUpstreams: 2,
      transferredBytes: 7,
    });
    client.release();
    first.release();
    second.release();
    expect(ledger.snapshot).toMatchObject({ activeClients: 0, activeDerived: 0, activeUpstreams: 0 });
  });

  it('charges a refused global derived slot and preserves combined concurrency', () => {
    const ledger = createPackageEgressLedger(
      limits({ maxConcurrentClients: 2, maxConcurrentDerived: 1, maxConcurrentUpstreams: 3 }),
    );
    const firstClient = ledger.admitClient();
    const secondClient = ledger.admitClient();
    const direct = firstClient.admitDirect();
    const derived = firstClient.admitDerived();
    expect(() => secondClient.admitDerived()).toThrow(/derived concurrency/u);
    expect(ledger.snapshot).toMatchObject({
      attempts: 4,
      clientAttempts: 2,
      derivedAttempts: 2,
      activeDirect: 1,
      activeDerived: 1,
      activeUpstreams: 2,
    });
    direct.release();
    derived.release();
    firstClient.release();
    secondClient.release();
  });

  it('applies the nonrefundable burst/refill bucket to every client admission', () => {
    let now = 0;
    const clock: PackageEgressClock = { now: () => now };
    const ledger = createPackageEgressLedger(
      limits({ maxAttempts: 10, attemptBurst: 2, attemptRefillPerSecond: 1 }),
      clock,
    );
    ledger.admitClient().release();
    ledger.admitClient().release();
    expect(() => ledger.admitClient()).toThrow(/rate/u);
    expect(ledger.snapshot).toMatchObject({ attempts: 3, clientAttempts: 3, rateTokens: 0 });

    now = 1_000;
    ledger.admitClient().release();
    expect(ledger.snapshot.rateTokens).toBe(0);
  });

  it('charges refused concurrency attempts and releases direct slots idempotently', () => {
    const ledger = createPackageEgressLedger(limits({ maxConcurrentClients: 1 }));
    const client = ledger.admitClient();
    const direct = client.admitDirect();
    expect(() => ledger.admitClient()).toThrow(/client concurrency/u);
    expect(ledger.snapshot.clientAttempts).toBe(2);
    direct.release();
    direct.release();
    client.release();
    expect(ledger.snapshot).toMatchObject({ activeClients: 0, activeDirect: 0 });
  });

  it('charges exact bytes before reporting request and session overflow', () => {
    const ledger = createPackageEgressLedger(limits({ maxBytesPerRequest: 5, maxSessionBytes: 8 }));
    const first = ledger.admitClient();
    const second = ledger.admitClient();
    expect(first.charge(5)).toBe(true);
    expect(first.charge(1)).toBe(false);
    expect(second.charge(2)).toBe(true);
    expect(second.charge(1)).toBe(false);
    expect(ledger.snapshot.transferredBytes).toBe(9);
  });

  it('stops both client and direct admission without corrupting active counts', () => {
    const ledger = createPackageEgressLedger(limits());
    const client = ledger.admitClient();
    const direct = client.admitDirect();
    ledger.stop();
    expect(() => ledger.admitClient()).toThrow(/stopped/u);
    expect(() => client.admitDirect()).toThrow(/stopped/u);
    expect(() => client.admitDerived()).toThrow(/stopped/u);
    client.release();
    direct.release();
    expect(ledger.snapshot).toMatchObject({ stopped: true, activeClients: 0, activeUpstreams: 0 });
  });

  it('rejects incoherent limits at construction', () => {
    expect(() => createPackageEgressLedger(limits({ maxBytesPerRequest: 9, maxSessionBytes: 8 }))).toThrow(
      /per-request/u,
    );
    expect(() => createPackageEgressLedger(limits({ maxAttempts: 0 }))).toThrow(/positive/u);
  });
});
