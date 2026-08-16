import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { getLlmStatisticsIdentityKeyPath } from '../config/paths.js';
import { asIdentifier, asProviderIdentifier } from './normalization.js';
import type { LlmMetricsRepository } from './persistence/repository.js';
import type { GatewayRouteAttempt, LlmExchangeCompleted, LlmModelIdentity, SourcedIdentity } from './types.js';

const IDENTITY_KEY_BYTES = 32;
const HMAC_BYTES = 16;
const IDENTITY_KEY_FILENAME = 'identity.key';

export type StatisticsIdentityNamespace =
  | 'agent'
  | 'correlation'
  | 'conversation'
  | 'model'
  | 'persona'
  | 'profile'
  | 'provider'
  | 'route'
  | 'state';

export interface PersistenceIdentityProtector {
  /** Stable local pseudonym. Raw input and the key are never exposed. */
  protectLabel(namespace: StatisticsIdentityNamespace, value: string): string;
  /** Immutable copy suitable for durable enqueue. The live event remains untouched. */
  protectExchange(exchange: LlmExchangeCompleted): LlmExchangeCompleted;
}

const OFFICIAL_PUBLIC_ORIGINS = new Set([
  'api.anthropic.com',
  'api.openai.com',
  'chatgpt.com',
  'generativelanguage.googleapis.com',
  'openrouter.ai',
]);

function ensureStatisticsDirectory(statisticsDirectory: string): void {
  if (existsSync(statisticsDirectory)) {
    const status = lstatSync(statisticsDirectory);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error('Statistics path must be a real directory');
    }
  } else {
    mkdirSync(statisticsDirectory, { recursive: true, mode: 0o700 });
  }
  chmodSync(statisticsDirectory, 0o700);
}

function readIdentityKey(keyPath: string): Buffer {
  const status = lstatSync(keyPath);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error('Statistics identity key must be a regular file');
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath);
  if (key.length !== IDENTITY_KEY_BYTES) throw new Error('Statistics identity key has an invalid length');
  return key;
}

function writeCompleteFile(path: string, contents: Buffer): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let offset = 0;
    while (offset < contents.length) offset += writeSync(descriptor, contents, offset, contents.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Create one complete key inode and publish it with an atomic hard-link.
 * Losing processes observe EEXIST only after the winning inode is fully
 * written and fsynced, so readers can never see a partially initialized key.
 */
function loadOrCreateIdentityKey(statisticsDirectory: string): Buffer {
  ensureStatisticsDirectory(statisticsDirectory);
  const keyPath = getLlmStatisticsIdentityKeyPath(statisticsDirectory);
  if (existsSync(keyPath)) return readIdentityKey(keyPath);

  const candidatePath = join(
    statisticsDirectory,
    `.${IDENTITY_KEY_FILENAME}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
  );
  writeCompleteFile(candidatePath, randomBytes(IDENTITY_KEY_BYTES));
  try {
    try {
      linkSync(candidatePath, keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    unlinkSync(candidatePath);
  }
  return readIdentityKey(keyPath);
}

function recognizedPublicOrigin(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  const hostOnly = value.toLowerCase();
  if (OFFICIAL_PUBLIC_ORIGINS.has(hostOnly)) return hostOnly;
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== 'https:' ||
      origin.username !== '' ||
      origin.password !== '' ||
      (origin.port !== '' && origin.port !== '443') ||
      (origin.pathname !== '' && origin.pathname !== '/') ||
      origin.search !== '' ||
      origin.hash !== '' ||
      !OFFICIAL_PUBLIC_ORIGINS.has(origin.hostname.toLowerCase())
    ) {
      return null;
    }
    return origin.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function sourcedIdentity(
  identity: SourcedIdentity,
  protect: (namespace: StatisticsIdentityNamespace, value: string) => string,
  kind: 'model' | 'provider',
): SourcedIdentity {
  if (identity.value === null) return identity;
  const valid = kind === 'model' ? asIdentifier(identity.value) : asProviderIdentifier(identity.value);
  return { ...identity, value: valid ?? protect(kind, identity.value) };
}

function protectModelIdentity(
  identity: LlmModelIdentity,
  protect: (namespace: StatisticsIdentityNamespace, value: string) => string,
): LlmModelIdentity {
  return {
    requestedModel: sourcedIdentity(identity.requestedModel, protect, 'model'),
    forwardedModel: sourcedIdentity(identity.forwardedModel, protect, 'model'),
    responseModel: sourcedIdentity(identity.responseModel, protect, 'model'),
    servedModel: sourcedIdentity(identity.servedModel, protect, 'model'),
    servedProvider: sourcedIdentity(identity.servedProvider, protect, 'provider'),
  };
}

function protectRouteAttempt(
  attempt: GatewayRouteAttempt,
  protect: (namespace: StatisticsIdentityNamespace, value: string) => string,
): GatewayRouteAttempt {
  return {
    ...attempt,
    provider:
      attempt.provider === null
        ? null
        : (asProviderIdentifier(attempt.provider) ?? protect('provider', attempt.provider)),
    model: attempt.model === null ? null : (asIdentifier(attempt.model) ?? protect('model', attempt.model)),
  };
}

export function createPersistenceIdentityProtector(statisticsDirectory: string): PersistenceIdentityProtector {
  const key = loadOrCreateIdentityKey(statisticsDirectory);
  const protectLabel = (namespace: StatisticsIdentityNamespace, value: string): string => {
    const digest = createHmac('sha256', key)
      .update(namespace, 'utf8')
      .update('\0', 'utf8')
      .update(value, 'utf8')
      .digest()
      .subarray(0, HMAC_BYTES)
      .toString('hex');
    return `hmac:${digest}`;
  };
  const always = (namespace: StatisticsIdentityNamespace, value: string | null): string | null =>
    value === null ? null : protectLabel(namespace, value);
  const safeModel = (value: string | null): string | null =>
    value === null ? null : (asIdentifier(value) ?? protectLabel('model', value));
  const safeCorrelation = (value: string | null): string | null =>
    value === null ? null : (asIdentifier(value) ?? protectLabel('correlation', value));

  return Object.freeze({
    protectLabel,
    protectExchange: (exchange: LlmExchangeCompleted): LlmExchangeCompleted => {
      const clientPublicOrigin = recognizedPublicOrigin(exchange.route.clientRouteId);
      const upstreamPublicOrigin = recognizedPublicOrigin(exchange.route.upstreamRouteId);
      return Object.freeze({
        ...exchange,
        attribution: Object.freeze({
          ...exchange.attribution,
          agentConversationId: always('conversation', exchange.attribution.agentConversationId),
          stateId: always('state', exchange.attribution.stateId),
          personaId: always('persona', exchange.attribution.personaId),
          agentId: always('agent', exchange.attribution.agentId),
        }),
        route: Object.freeze({
          ...exchange.route,
          logicalProvider:
            asIdentifier(exchange.route.logicalProvider) ?? protectLabel('provider', exchange.route.logicalProvider),
          providerProfileId: always('profile', exchange.route.providerProfileId),
          clientRouteId:
            clientPublicOrigin ??
            (exchange.route.clientRouteId === null ? null : protectLabel('route', exchange.route.clientRouteId)),
          upstreamRouteId:
            upstreamPublicOrigin ??
            (exchange.route.upstreamRouteId === null ? null : protectLabel('route', exchange.route.upstreamRouteId)),
        }),
        identity: Object.freeze(protectModelIdentity(exchange.identity, protectLabel)),
        responseMetadata: Object.freeze({
          ...exchange.responseMetadata,
          providerRequestId: safeCorrelation(exchange.responseMetadata.providerRequestId),
          providerResponseId: safeCorrelation(exchange.responseMetadata.providerResponseId),
          gatewayGenerationId: safeCorrelation(exchange.responseMetadata.gatewayGenerationId),
          actualServiceTier:
            exchange.responseMetadata.actualServiceTier === null
              ? null
              : (asIdentifier(exchange.responseMetadata.actualServiceTier) ??
                protectLabel('correlation', exchange.responseMetadata.actualServiceTier)),
        }),
        request: Object.freeze({ ...exchange.request, requestedModel: safeModel(exchange.request.requestedModel) }),
        gatewayRouteAttempts: Object.freeze(
          exchange.gatewayRouteAttempts.map((attempt) => Object.freeze(protectRouteAttempt(attempt, protectLabel))),
        ),
      });
    },
  });
}

/** Wrap every runtime-exposed durable enqueue without changing live bus events. */
export function protectLlmMetricsRepository(
  repository: LlmMetricsRepository,
  protector: PersistenceIdentityProtector,
): LlmMetricsRepository {
  const protectedRepository: LlmMetricsRepository = {
    enqueue: (exchange) => repository.enqueue(protector.protectExchange(exchange)),
    flush: () => repository.flush(),
    close: () => repository.close(),
    health: () => repository.health(),
    snapshotMaxSequence: () => repository.snapshotMaxSequence(),
    scan: (query) => repository.scan(query),
    dimensionValues: (dimension, query) => repository.dimensionValues(dimension, query),
    deleteBefore: (cutoffMs, options) => repository.deleteBefore(cutoffMs, options),
  };
  return Object.freeze(protectedRepository);
}
