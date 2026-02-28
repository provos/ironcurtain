/**
 * Signal transport configuration types and resolution.
 *
 * SignalConfig is the raw shape stored in config.json (all fields optional).
 * ResolvedSignalConfig has all fields present with defaults applied.
 * resolveSignalConfig() bridges the two, returning null when Signal
 * is not configured (missing required fields).
 */

import { resolve } from 'node:path';
import { getIronCurtainHome } from '../config/paths.js';
/** Signal transport configuration as stored in the config file. */
export interface SignalConfig {
  /** The bot's registered Signal phone number (e.g., '+15551234567'). */
  botNumber?: string;
  /** The user's Signal phone number to send messages to. */
  recipientNumber?: string;
  /**
   * The user's Signal identity key fingerprint, captured during onboarding.
   * Used to detect identity changes (SIM swap, number reassignment).
   */
  recipientIdentityKey?: string;
  /** Container configuration overrides. */
  container?: {
    /** Docker image. Default: 'bbernhard/signal-cli-rest-api:latest' */
    image?: string;
    /** Host port for REST API. Default: 18080 */
    port?: number;
  };
  /** Maximum number of concurrent sessions. Default: 3 */
  maxConcurrentSessions?: number;
}

/** Resolved Signal config with all fields present. */
export interface ResolvedSignalConfig {
  readonly botNumber: string;
  readonly recipientNumber: string;
  readonly recipientIdentityKey: string;
  readonly container: {
    readonly image: string;
    readonly port: number;
    readonly dataDir: string;
    readonly containerName: string;
  };
  readonly maxConcurrentSessions: number;
}

export const SIGNAL_DEFAULTS = {
  image: 'bbernhard/signal-cli-rest-api:latest',
  port: 18080,
  containerName: 'ironcurtain-signal',
  maxConcurrentSessions: 3,
} as const;

/** Returns the host directory for signal-cli persistent data. */
export function getSignalDataDir(): string {
  return resolve(getIronCurtainHome(), 'signal-data');
}

/**
 * Minimal shape needed to resolve Signal config.
 * Accepts both UserConfig (partial signal) and ResolvedUserConfig
 * (where signal is ResolvedSignalConfig | null).
 */
interface HasSignalConfig {
  signal?: SignalConfig | ResolvedSignalConfig | null | undefined;
}

/**
 * Resolves Signal config from user config, applying defaults.
 * Returns null when Signal is not configured (missing required fields).
 *
 * Accepts both raw UserConfig (from Zod parse) and ResolvedUserConfig
 * (from loadUserConfig). When the input is already resolved, returns
 * it directly.
 */
export function resolveSignalConfig(config: HasSignalConfig): ResolvedSignalConfig | null {
  const signal = config.signal;
  if (!signal) return null;

  // If already resolved (has container.dataDir), return as-is
  if ('container' in signal && signal.container && 'dataDir' in signal.container) {
    return signal as ResolvedSignalConfig;
  }

  // Raw config - resolve with defaults
  const raw = signal as SignalConfig;
  if (!raw.botNumber || !raw.recipientNumber || !raw.recipientIdentityKey) {
    return null;
  }

  return {
    botNumber: raw.botNumber,
    recipientNumber: raw.recipientNumber,
    recipientIdentityKey: raw.recipientIdentityKey,
    container: {
      image: raw.container?.image ?? SIGNAL_DEFAULTS.image,
      port: raw.container?.port ?? SIGNAL_DEFAULTS.port,
      dataDir: getSignalDataDir(),
      containerName: SIGNAL_DEFAULTS.containerName,
    },
    maxConcurrentSessions: raw.maxConcurrentSessions ?? SIGNAL_DEFAULTS.maxConcurrentSessions,
  };
}
