import { randomBytes } from 'node:crypto';
import type { LlmExchangeAttribution } from './types.js';

const PROXY_USERNAME = 'ironcurtain';
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

export interface MetricsInvocationContext {
  readonly sessionId: string;
  readonly agentConversationId?: string;
  readonly turnId?: string;
  readonly bundleId?: string;
  readonly workflowRunId?: string;
  readonly stateId?: string;
  readonly personaId?: string;
  readonly agentId?: string;
}

export interface MetricsAttributionHandle {
  readonly attribution: LlmExchangeAttribution;
  release(): void;
}

export interface MetricsInvocationLease {
  /** Proxy URL containing only an opaque, short-lived correlation credential. */
  readonly proxyUrl: string;
  end(): Promise<void>;
}

interface RegistryEntry {
  readonly attribution: LlmExchangeAttribution;
  active: boolean;
  inFlight: number;
  readonly drained: Set<() => void>;
}

function exactAttribution(context: MetricsInvocationContext): LlmExchangeAttribution {
  return Object.freeze({
    sessionId: context.sessionId,
    agentConversationId: context.agentConversationId ?? null,
    turnId: context.turnId ?? null,
    bundleId: context.bundleId ?? null,
    workflowRunId: context.workflowRunId ?? null,
    stateId: context.stateId ?? null,
    personaId: context.personaId ?? null,
    agentId: context.agentId ?? null,
    quality: 'exact' as const,
  });
}

/**
 * Maps opaque proxy credentials to immutable invocation context. Credentials
 * are correlation hints for benign concurrency; they grant no forwarding or
 * policy authority.
 */
export class MetricsAttributionRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  createLease(
    baseProxyUrl: string,
    context: MetricsInvocationContext,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  ): MetricsInvocationLease {
    const url = new URL(baseProxyUrl);
    if (url.protocol !== 'http:') throw new Error('metrics proxy URL must use http:');
    if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs < 0) {
      throw new Error('metrics drain timeout must be a nonnegative finite number');
    }
    const token = randomBytes(32).toString('base64url');
    const entry: RegistryEntry = {
      attribution: exactAttribution(context),
      active: true,
      inFlight: 0,
      drained: new Set(),
    };
    this.entries.set(token, entry);

    url.username = PROXY_USERNAME;
    url.password = token;

    let ended = false;
    return Object.freeze({
      proxyUrl: url.toString().replace(/\/$/, ''),
      end: async (): Promise<void> => {
        if (ended) return;
        ended = true;
        entry.active = false;
        if (entry.inFlight === 0) {
          this.entries.delete(token);
          return;
        }

        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            entry.drained.delete(finish);
            resolve();
          };
          const timer = setTimeout(() => {
            this.entries.delete(token);
            finish();
          }, drainTimeoutMs);
          timer.unref();
          entry.drained.add(finish);
        });
      },
    });
  }

  /** Acquires a per-request immutable attribution snapshot. */
  acquire(token: string | undefined): MetricsAttributionHandle | undefined {
    if (!token) return undefined;
    const entry = this.entries.get(token);
    if (!entry?.active) return undefined;
    entry.inFlight += 1;
    let released = false;
    return {
      attribution: entry.attribution,
      release: (): void => {
        if (released) return;
        released = true;
        entry.inFlight -= 1;
        if (entry.inFlight === 0 && !entry.active) {
          this.entries.delete(token);
          for (const notify of [...entry.drained]) notify();
        }
      },
    };
  }

  activeLeaseCount(): number {
    let active = 0;
    for (const entry of this.entries.values()) {
      if (entry.active) active += 1;
    }
    return active;
  }

  registeredLeaseCount(): number {
    return this.entries.size;
  }
}

/** Parse the opaque lease token from a standard Basic proxy-auth header. */
export function parseMetricsProxyAuthorization(value: string | undefined): string | undefined {
  if (!value?.startsWith('Basic ')) return undefined;
  try {
    const decoded = Buffer.from(value.slice('Basic '.length), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0 || decoded.slice(0, separator) !== PROXY_USERNAME) return undefined;
    const token = decoded.slice(separator + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}
