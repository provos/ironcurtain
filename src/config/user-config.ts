/**
 * User configuration file management.
 *
 * Loads, validates, and provides defaults for ~/.ironcurtain/config.json.
 * All fields are optional in the file; missing fields use defaults.
 * Environment variables override config file values.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { getUserConfigPath } from './paths.js';
import { parseModelId } from './model-provider.js';

export const USER_CONFIG_DEFAULTS = {
  agentModelId: 'anthropic:claude-sonnet-4-6',
  policyModelId: 'anthropic:claude-sonnet-4-6',
  escalationTimeoutSeconds: 300,
} as const;

const ESCALATION_TIMEOUT_MIN = 30;
const ESCALATION_TIMEOUT_MAX = 600;

/**
 * Validates a qualified model ID string: either a bare model name
 * or "provider:model-name" where provider is a known provider.
 * Delegates to parseModelId() so validation logic is not duplicated.
 */
const qualifiedModelId = z.string().min(1).refine(
  (val) => {
    try {
      parseModelId(val);
      return true;
    } catch {
      return false;
    }
  },
  {
    message: 'Model ID must be "model-name" or "provider:model-name" ' +
             'where provider is one of: anthropic, google, openai',
  },
);

/**
 * Zod schema for validating user config. All fields optional.
 * Validates types and constraints without applying defaults --
 * defaults are merged separately so we can distinguish "missing" from "present".
 */
const userConfigSchema = z.object({
  agentModelId: qualifiedModelId.optional(),
  policyModelId: qualifiedModelId.optional(),
  apiKey: z.string().min(1, 'apiKey must be non-empty').optional(),
  googleApiKey: z.string().min(1, 'googleApiKey must be non-empty').optional(),
  openaiApiKey: z.string().min(1, 'openaiApiKey must be non-empty').optional(),
  escalationTimeoutSeconds: z
    .number()
    .int('escalationTimeoutSeconds must be an integer')
    .min(ESCALATION_TIMEOUT_MIN, `escalationTimeoutSeconds must be at least ${ESCALATION_TIMEOUT_MIN}`)
    .max(ESCALATION_TIMEOUT_MAX, `escalationTimeoutSeconds must be at most ${ESCALATION_TIMEOUT_MAX}`)
    .optional(),
});

/** Parsed config from ~/.ironcurtain/config.json. All fields optional. */
export type UserConfig = z.infer<typeof userConfigSchema>;

/** Validated, defaults-applied configuration. All fields present. */
export interface ResolvedUserConfig {
  readonly agentModelId: string;
  readonly policyModelId: string;
  readonly apiKey: string;
  readonly googleApiKey: string;
  readonly openaiApiKey: string;
  readonly escalationTimeoutSeconds: number;
}

/** Known fields derived from the schema. Used for unknown-field detection. */
const KNOWN_FIELDS = new Set<string>(Object.keys(userConfigSchema.shape));

/** Default config file content (apiKey intentionally omitted). */
const DEFAULT_CONFIG_CONTENT = JSON.stringify(
  {
    agentModelId: USER_CONFIG_DEFAULTS.agentModelId,
    policyModelId: USER_CONFIG_DEFAULTS.policyModelId,
    escalationTimeoutSeconds: USER_CONFIG_DEFAULTS.escalationTimeoutSeconds,
  },
  null,
  2,
) + '\n';

/**
 * Loads user configuration from ~/.ironcurtain/config.json.
 *
 * Behavior:
 * 1. If file does not exist: create with defaults, log to stderr
 * 2. If file exists: parse JSON, validate with Zod, merge with defaults
 * 3. Apply env var overrides (ANTHROPIC_API_KEY overrides apiKey)
 * 4. Return ResolvedUserConfig with all fields present
 *
 * @throws Error on invalid JSON or schema validation failure
 */
export function loadUserConfig(): ResolvedUserConfig {
  const configPath = getUserConfigPath();
  const raw = readOrCreateConfigFile(configPath);
  const parsed = parseConfigJson(raw, configPath);
  warnUnknownFields(parsed, configPath);
  const validated = validateConfig(parsed, configPath);
  return applyEnvOverrides(mergeWithDefaults(validated));
}

/**
 * Reads the config file, creating it with defaults if it does not exist.
 */
function readOrCreateConfigFile(configPath: string): string {
  if (!existsSync(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, DEFAULT_CONFIG_CONTENT);
    process.stderr.write(`Created default config at ${configPath}\n`);
    return DEFAULT_CONFIG_CONTENT;
  }
  return readFileSync(configPath, 'utf-8');
}

/**
 * Parses raw JSON string. Throws a descriptive error on invalid JSON.
 */
function parseConfigJson(raw: string, configPath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${configPath}: ${message}`);
  }
}

/**
 * Warns about unknown fields in the parsed config.
 */
function warnUnknownFields(parsed: unknown, configPath: string): void {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
  const keys = Object.keys(parsed as Record<string, unknown>);
  for (const key of keys) {
    if (!KNOWN_FIELDS.has(key)) {
      process.stderr.write(`Warning: unknown field "${key}" in ${configPath}\n`);
    }
  }
}

/**
 * Validates parsed config against the Zod schema.
 * Throws a descriptive error listing invalid fields.
 */
function validateConfig(parsed: unknown, configPath: string): UserConfig {
  const result = userConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid config in ${configPath}:\n${issues}`);
  }
  return result.data;
}

/**
 * Merges validated (partial) config with defaults.
 * API key fields default to empty string when not provided.
 */
function mergeWithDefaults(config: UserConfig): ResolvedUserConfig {
  return {
    agentModelId: config.agentModelId ?? USER_CONFIG_DEFAULTS.agentModelId,
    policyModelId: config.policyModelId ?? USER_CONFIG_DEFAULTS.policyModelId,
    apiKey: config.apiKey ?? '',
    googleApiKey: config.googleApiKey ?? '',
    openaiApiKey: config.openaiApiKey ?? '',
    escalationTimeoutSeconds:
      config.escalationTimeoutSeconds ?? USER_CONFIG_DEFAULTS.escalationTimeoutSeconds,
  };
}

/**
 * Applies environment variable overrides for all provider API keys.
 * Each provider's standard env var takes precedence over config file values.
 */
function applyEnvOverrides(config: ResolvedUserConfig): ResolvedUserConfig {
  return {
    ...config,
    apiKey: process.env.ANTHROPIC_API_KEY || config.apiKey,
    googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || config.googleApiKey,
    openaiApiKey: process.env.OPENAI_API_KEY || config.openaiApiKey,
  };
}
