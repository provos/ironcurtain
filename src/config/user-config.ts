/**
 * User configuration file management.
 *
 * Loads, validates, and provides defaults for ~/.ironcurtain/config.json.
 * All fields are optional in the file; missing fields use defaults.
 * Environment variables override config file values.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { getUserConfigPath } from './paths.js';
import { parseModelId } from './model-provider.js';

export const USER_CONFIG_DEFAULTS = {
  agentModelId: 'anthropic:claude-sonnet-4-6',
  policyModelId: 'anthropic:claude-sonnet-4-6',
  escalationTimeoutSeconds: 300,
  resourceBudget: {
    maxTotalTokens: 1_000_000,
    maxSteps: 200,
    maxSessionSeconds: 1800,
    maxEstimatedCostUsd: 5.0,
    warnThresholdPercent: 80,
  },
  autoCompact: {
    enabled: true,
    thresholdTokens: 160_000,
    keepRecentMessages: 10,
    summaryModelId: 'anthropic:claude-haiku-4-5',
  },
  autoApprove: {
    enabled: false,
    modelId: 'anthropic:claude-haiku-4-5',
  },
} as const;

const ESCALATION_TIMEOUT_MIN = 30;
const ESCALATION_TIMEOUT_MAX = 600;

const resourceBudgetSchema = z
  .object({
    maxTotalTokens: z.number().int().positive().nullable().optional(),
    maxSteps: z.number().int().positive().nullable().optional(),
    maxSessionSeconds: z.number().positive().nullable().optional(),
    maxEstimatedCostUsd: z.number().positive().nullable().optional(),
    warnThresholdPercent: z.number().min(1).max(99).optional(),
  })
  .optional();

/**
 * Validates a qualified model ID string: either a bare model name
 * or "provider:model-name" where provider is a known provider.
 * Delegates to parseModelId() so validation logic is not duplicated.
 */
const qualifiedModelId = z
  .string()
  .min(1)
  .refine(
    (val) => {
      try {
        parseModelId(val);
        return true;
      } catch {
        return false;
      }
    },
    {
      message:
        'Model ID must be "model-name" or "provider:model-name" ' +
        'where provider is one of: anthropic, google, openai',
    },
  );

const autoCompactSchema = z
  .object({
    enabled: z.boolean().optional(),
    thresholdTokens: z.number().int().positive().optional(),
    keepRecentMessages: z.number().int().positive().optional(),
    summaryModelId: qualifiedModelId.optional(),
  })
  .optional();

const autoApproveSchema = z
  .object({
    enabled: z.boolean().optional(),
    modelId: qualifiedModelId.optional(),
  })
  .optional();

/**
 * Zod schema for validating user config. All fields optional.
 * Validates types and constraints without applying defaults --
 * defaults are merged separately so we can distinguish "missing" from "present".
 */
const userConfigSchema = z.object({
  agentModelId: qualifiedModelId.optional(),
  policyModelId: qualifiedModelId.optional(),
  anthropicApiKey: z.string().min(1, 'anthropicApiKey must be non-empty').optional(),
  googleApiKey: z.string().min(1, 'googleApiKey must be non-empty').optional(),
  openaiApiKey: z.string().min(1, 'openaiApiKey must be non-empty').optional(),
  escalationTimeoutSeconds: z
    .number()
    .int('escalationTimeoutSeconds must be an integer')
    .min(ESCALATION_TIMEOUT_MIN, `escalationTimeoutSeconds must be at least ${ESCALATION_TIMEOUT_MIN}`)
    .max(ESCALATION_TIMEOUT_MAX, `escalationTimeoutSeconds must be at most ${ESCALATION_TIMEOUT_MAX}`)
    .optional(),
  resourceBudget: resourceBudgetSchema,
  autoCompact: autoCompactSchema,
  autoApprove: autoApproveSchema,
  serverCredentials: z.record(z.string(), z.record(z.string(), z.string().min(1))).optional(),
});

/** Parsed config from ~/.ironcurtain/config.json. All fields optional. */
export type UserConfig = z.infer<typeof userConfigSchema>;

/** Resolved resource budget with all fields present. */
export interface ResolvedResourceBudgetConfig {
  readonly maxTotalTokens: number | null;
  readonly maxSteps: number | null;
  readonly maxSessionSeconds: number | null;
  readonly maxEstimatedCostUsd: number | null;
  readonly warnThresholdPercent: number;
}

/** Resolved auto-compaction config with all fields present. */
export interface ResolvedAutoCompactConfig {
  readonly enabled: boolean;
  readonly thresholdTokens: number;
  readonly keepRecentMessages: number;
  readonly summaryModelId: string;
}

/** Resolved auto-approve config with all fields present. */
export interface ResolvedAutoApproveConfig {
  readonly enabled: boolean;
  readonly modelId: string;
}

/** Validated, defaults-applied configuration. All fields present. */
export interface ResolvedUserConfig {
  readonly agentModelId: string;
  readonly policyModelId: string;
  readonly anthropicApiKey: string;
  readonly googleApiKey: string;
  readonly openaiApiKey: string;
  readonly escalationTimeoutSeconds: number;
  readonly resourceBudget: ResolvedResourceBudgetConfig;
  readonly autoCompact: ResolvedAutoCompactConfig;
  readonly autoApprove: ResolvedAutoApproveConfig;
  readonly serverCredentials: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Known fields derived from the schema. Used for unknown-field detection. */
const KNOWN_FIELDS = new Set<string>(Object.keys(userConfigSchema.shape));

/** Fields that must never be backfilled into the config file. */
const SENSITIVE_FIELDS = new Set(['anthropicApiKey', 'googleApiKey', 'openaiApiKey', 'serverCredentials']);

/** Type guard for non-null, non-array objects. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Default config file content (anthropicApiKey intentionally omitted). */
const DEFAULT_CONFIG_CONTENT =
  JSON.stringify(
    {
      agentModelId: USER_CONFIG_DEFAULTS.agentModelId,
      policyModelId: USER_CONFIG_DEFAULTS.policyModelId,
      escalationTimeoutSeconds: USER_CONFIG_DEFAULTS.escalationTimeoutSeconds,
      resourceBudget: USER_CONFIG_DEFAULTS.resourceBudget,
      autoCompact: USER_CONFIG_DEFAULTS.autoCompact,
      autoApprove: USER_CONFIG_DEFAULTS.autoApprove,
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
 * 3. Apply env var overrides (ANTHROPIC_API_KEY overrides anthropicApiKey)
 * 4. Return ResolvedUserConfig with all fields present
 *
 * @throws Error on invalid JSON or schema validation failure
 */
export function loadUserConfig(): ResolvedUserConfig {
  const configPath = getUserConfigPath();
  let raw = readOrCreateConfigFile(configPath);
  raw = backfillMissingFields(configPath, raw);
  const parsed = parseConfigJson(raw, configPath);
  warnUnknownFields(parsed, configPath);
  const validated = validateConfig(parsed, configPath);
  return applyEnvOverrides(mergeWithDefaults(validated));
}

/**
 * Detects fields present in USER_CONFIG_DEFAULTS but missing from the file,
 * writes them back with default values, and logs what was added.
 * Returns raw unchanged on parse failure (validation catches this later).
 */
function backfillMissingFields(configPath: string, raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!isPlainObject(parsed)) return raw;
  const fileContent = parsed;

  const patch = computeMissingDefaults(fileContent);
  if (patch === null) return raw;

  const updated = applyPatchToFileContent(fileContent, patch);
  const newRaw = JSON.stringify(updated, null, 2) + '\n';
  writeFileSync(configPath, newRaw);
  process.stderr.write(`Backfilled config fields: ${describeAddedFields(patch)}\n`);
  return newRaw;
}

/**
 * Computes a patch of default values for fields missing from the config file.
 * Skips sensitive fields. One level deep for nested objects.
 * Returns null when nothing is missing.
 */
function computeMissingDefaults(fileContent: Record<string, unknown>): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};

  for (const [key, defaultValue] of Object.entries(USER_CONFIG_DEFAULTS)) {
    if (SENSITIVE_FIELDS.has(key)) continue;

    if (!(key in fileContent)) {
      patch[key] = defaultValue;
      continue;
    }

    // For nested objects, check for missing sub-fields one level deep
    if (!isPlainObject(defaultValue) || !isPlainObject(fileContent[key])) continue;

    const existing = fileContent[key] as Record<string, unknown>;
    const subPatch: Record<string, unknown> = {};
    for (const [subKey, subDefault] of Object.entries(defaultValue)) {
      if (!(subKey in existing)) {
        subPatch[subKey] = subDefault;
      }
    }
    if (Object.keys(subPatch).length > 0) {
      patch[key] = subPatch;
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Merges a patch of missing defaults into the file content.
 * Preserves all user values; only adds missing fields.
 */
function applyPatchToFileContent(
  fileContent: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...fileContent };
  for (const [key, patchValue] of Object.entries(patch)) {
    if (key in result && isPlainObject(result[key])) {
      const existing = result[key] as Record<string, unknown>;
      result[key] = { ...existing, ...(patchValue as Record<string, unknown>) };
    } else {
      result[key] = patchValue;
    }
  }
  return result;
}

/**
 * Produces a human-readable list of added fields for the log message.
 * Sub-field patches (partial nested objects) are listed as "parent.child".
 * Whole new top-level objects are listed by their key name alone.
 */
function describeAddedFields(patch: Record<string, unknown>): string {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const defaultValue = (USER_CONFIG_DEFAULTS as Record<string, unknown>)[key];
    const isSubFieldPatch =
      isPlainObject(value) &&
      isPlainObject(defaultValue) &&
      Object.keys(value).length < Object.keys(defaultValue).length;

    if (isSubFieldPatch) {
      for (const subKey of Object.keys(value as Record<string, unknown>)) {
        fields.push(`${key}.${subKey}`);
      }
    } else {
      fields.push(key);
    }
  }
  return fields.join(', ');
}

/**
 * Reads the config file, creating it with defaults if it does not exist.
 */
function readOrCreateConfigFile(configPath: string): string {
  if (!existsSync(configPath)) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, DEFAULT_CONFIG_CONTENT, { mode: 0o600 });
    process.stderr.write(`Created default config at ${configPath}\n`);
    return DEFAULT_CONFIG_CONTENT;
  }
  warnInsecurePermissions(configPath);
  return readFileSync(configPath, 'utf-8');
}

/**
 * Warns if the config file is group- or world-readable.
 * Config files may contain API keys and server credentials.
 */
function warnInsecurePermissions(configPath: string): void {
  try {
    const stats = statSync(configPath);
    // Check for group (0o040) or other (0o004) read bits
    if (stats.mode & 0o044) {
      process.stderr.write(
        `Warning: ${configPath} is readable by other users (mode ${(stats.mode & 0o777).toString(8)}). ` +
          `Run: chmod 600 ${configPath}\n`,
      );
    }
  } catch {
    /* ignore stat failures */
  }
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
    const issues = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid config in ${configPath}:\n${issues}`);
  }
  return result.data;
}

/**
 * Merges validated (partial) config with defaults.
 * API key fields default to empty string when not provided.
 */
function mergeWithDefaults(config: UserConfig): ResolvedUserConfig {
  const budgetDefaults = USER_CONFIG_DEFAULTS.resourceBudget;
  const compactDefaults = USER_CONFIG_DEFAULTS.autoCompact;
  const approveDefaults = USER_CONFIG_DEFAULTS.autoApprove;
  const b = config.resourceBudget;
  const c = config.autoCompact;
  const a = config.autoApprove;
  return {
    agentModelId: config.agentModelId ?? USER_CONFIG_DEFAULTS.agentModelId,
    policyModelId: config.policyModelId ?? USER_CONFIG_DEFAULTS.policyModelId,
    anthropicApiKey: config.anthropicApiKey ?? '',
    googleApiKey: config.googleApiKey ?? '',
    openaiApiKey: config.openaiApiKey ?? '',
    escalationTimeoutSeconds: config.escalationTimeoutSeconds ?? USER_CONFIG_DEFAULTS.escalationTimeoutSeconds,
    resourceBudget: {
      // Nullable fields: null means "disabled", undefined means "use default".
      // Must use !== undefined (not ??) so explicit null is preserved.
      maxTotalTokens: b?.maxTotalTokens !== undefined ? b.maxTotalTokens : budgetDefaults.maxTotalTokens,
      maxSteps: b?.maxSteps !== undefined ? b.maxSteps : budgetDefaults.maxSteps,
      maxSessionSeconds: b?.maxSessionSeconds !== undefined ? b.maxSessionSeconds : budgetDefaults.maxSessionSeconds,
      maxEstimatedCostUsd:
        b?.maxEstimatedCostUsd !== undefined ? b.maxEstimatedCostUsd : budgetDefaults.maxEstimatedCostUsd,
      warnThresholdPercent: b?.warnThresholdPercent ?? budgetDefaults.warnThresholdPercent,
    },
    autoCompact: {
      enabled: c?.enabled ?? compactDefaults.enabled,
      thresholdTokens: c?.thresholdTokens ?? compactDefaults.thresholdTokens,
      keepRecentMessages: c?.keepRecentMessages ?? compactDefaults.keepRecentMessages,
      summaryModelId: c?.summaryModelId ?? compactDefaults.summaryModelId,
    },
    autoApprove: {
      enabled: a?.enabled ?? approveDefaults.enabled,
      modelId: a?.modelId ?? approveDefaults.modelId,
    },
    serverCredentials: config.serverCredentials ?? {},
  };
}

/**
 * Applies environment variable overrides for all provider API keys.
 * Each provider's standard env var takes precedence over config file values.
 */
function applyEnvOverrides(config: ResolvedUserConfig): ResolvedUserConfig {
  return {
    ...config,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || config.anthropicApiKey,
    googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || config.googleApiKey,
    openaiApiKey: process.env.OPENAI_API_KEY || config.openaiApiKey,
  };
}
