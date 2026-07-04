/**
 * Interactive configuration editor for IronCurtain.
 *
 * Provides a terminal UI using @clack/prompts for viewing and modifying
 * ~/.ironcurtain/config.json. API keys are excluded from the interactive
 * menu — users must set them via environment variables or edit JSON directly.
 */

import * as p from '@clack/prompts';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadUserConfig,
  saveUserConfig,
  validateModelId,
  ESCALATION_TIMEOUT_MIN,
  ESCALATION_TIMEOUT_MAX,
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_PROVIDER_LABELS,
  WEB_SEARCH_PROVIDER_URLS,
  GOOSE_PROVIDERS,
  DOCKER_AGENTS,
  SESSION_MODES,
  CONTAINER_RUNTIMES,
  NATIVE_PROFILE_NAME,
  DEFAULT_GLM_SLUG,
  maskApiKey,
  cloneProviderPreference,
  type UserConfig,
  type ResolvedUserConfig,
  type ResolvedProviderProfile,
  type WebSearchProvider,
  type GooseProvider,
  type DockerAgent,
  type SessionModeKind,
  type ContainerRuntimeSetting,
} from './user-config.js';
import { getUserConfigPath } from './paths.js';
import type { MCPServerConfig } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Known model options for selection prompts. */
const KNOWN_MODELS: { value: string; label: string }[] = [
  { value: 'anthropic:claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'anthropic:claude-opus-4-6', label: 'Claude Opus 4.6' },
  { value: 'anthropic:claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { value: 'google:gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'google:gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'openai:gpt-4o', label: 'GPT-4o' },
  { value: 'openai:gpt-4o-mini', label: 'GPT-4o Mini' },
];

const CUSTOM_MODEL_SENTINEL = '__custom__';

/** Returns true if the user pressed ESC / Ctrl-C on a prompt. */
function isCancelled(value: unknown): boolean {
  return p.isCancel(value);
}

// ─── Formatters ──────────────────────────────────────────────

export function formatTokens(n: number | null): string {
  if (n === null) return 'disabled';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return String(n);
}

export function formatSeconds(n: number | null): string {
  if (n === null) return 'disabled';
  if (n >= 3600) {
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (n >= 60) {
    const m = Math.floor(n / 60);
    const s = n % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${n}s`;
}

export function formatCost(n: number | null): string {
  if (n === null) return 'disabled';
  return `$${n.toFixed(2)}`;
}

function formatModelShort(id: string): string {
  const known = KNOWN_MODELS.find((m) => m.value === id);
  return known ? known.label : id;
}

// ─── Model provider profiles ─────────────────────────────────

/** The pending (input-shape) `modelProviders` section written into `pending`. */
type PendingModelProviders = NonNullable<UserConfig['modelProviders']>;
/** A single pending profile: the discriminated-union input for one profile. */
type PendingProfile = NonNullable<PendingModelProviders['profiles']>[string];
/** The openrouter variant of a pending profile. */
type PendingOpenrouterProfile = Extract<PendingProfile, { type: 'openrouter' }>;

/**
 * The current editor view of the `profiles` record, in input shape (openrouter
 * profiles carry the fields the editor mutates). A pending `profiles` record,
 * when present, is already the whole record (read-modify-write) and replaces the
 * resolved view; otherwise the resolved profiles are converted to input shape.
 * The implicit `native` profile is intentionally excluded — it is never
 * persisted and is always shown separately as read-only.
 */
function currentProfiles(resolved: ResolvedUserConfig, pending: UserConfig): Record<string, PendingProfile> {
  if (pending.modelProviders?.profiles) {
    return { ...pending.modelProviders.profiles };
  }
  const view: Record<string, PendingProfile> = {};
  for (const [name, profile] of Object.entries(resolved.modelProviders.profiles)) {
    if (name === NATIVE_PROFILE_NAME) continue;
    view[name] = resolvedProfileToInput(profile);
  }
  return view;
}

/** Converts a resolved profile back to its input shape (drops resolution-only defaults where empty). */
function resolvedProfileToInput(profile: ResolvedProviderProfile): PendingProfile {
  if (profile.type === 'native') return { type: 'native' };
  const input: PendingOpenrouterProfile = { type: 'openrouter' };
  if (profile.apiKey) input.apiKey = profile.apiKey;
  // A default-tracking profile OMITS `modelMap` so an edit round-trip re-persists
  // the omission rather than pinning today's materialized DEFAULT_MODEL_MAP.
  if (!profile.usesDefaultMap) input.modelMap = profile.modelMap.map((r) => ({ match: r.match, model: r.model }));
  const perAgent: Record<string, string> = {};
  for (const agent of DOCKER_AGENTS) {
    const slug = profile.perAgent[agent];
    if (slug) perAgent[agent] = slug;
  }
  if (Object.keys(perAgent).length > 0) input.perAgent = perAgent;
  if (profile.providerPreference) {
    input.providerPreference = cloneProviderPreference(profile.providerPreference);
  }
  input.sessionAffinity = profile.sessionAffinity;
  return input;
}

/** The current default profile name (pending override wins over the resolved value). */
function currentDefault(resolved: ResolvedUserConfig, pending: UserConfig): string {
  return pending.modelProviders?.default ?? resolved.modelProviders.default;
}

/**
 * F10 — re-point a dangling `default` to `native`. Returns `NATIVE_PROFILE_NAME`
 * when the current default no longer names a profile in `remainingNames` (and is
 * not itself `native`), otherwise returns the current default unchanged. Pure so
 * the delete-repoints-default invariant is unit-testable without the interactive
 * flow. Persisting a `default` that names a missing profile would make the next
 * `loadUserConfig` a HARD error (the Zod `.refine`), so callers must apply this
 * in the same pending write that deletes a profile.
 */
export function repointDefaultAfterDelete(currentDefaultName: string, remainingNames: readonly string[]): string {
  if (currentDefaultName === NATIVE_PROFILE_NAME) return currentDefaultName;
  return remainingNames.includes(currentDefaultName) ? currentDefaultName : NATIVE_PROFILE_NAME;
}

/** Compact one-line summary of an openrouter profile for list/hint rendering. */
function summarizeOpenrouterProfile(profile: PendingOpenrouterProfile): string {
  const parts: string[] = [];
  const map = profile.modelMap;
  if (map && map.length === 0) {
    parts.push('per-agent only');
  } else if (map && map.length > 0) {
    parts.push(map.length === 1 ? `-> ${map[0].model}` : `${map.length} map rules`);
  } else {
    parts.push('default map');
  }
  parts.push(`key: ${maskApiKey(profile.apiKey)}`);
  return parts.join(', ');
}

/** Compact rendering of a modelMap for diffs: `*sonnet*->z-ai/glm-5.2; *opus*->…`. */
function formatModelMap(map: readonly { match: string; model: string }[] | undefined): string {
  if (!map) return 'default';
  if (map.length === 0) return 'per-agent only (empty map)';
  return map.map((r) => `${r.match}->${r.model}`).join('; ');
}

// ─── Diff ────────────────────────────────────────────────────

interface DiffEntry {
  from: unknown;
  to: unknown;
}

export function computeDiff(resolved: ResolvedUserConfig, pending: UserConfig): [string, DiffEntry][] {
  const diffs: [string, DiffEntry][] = [];

  const topLevelKeys = [
    'agentModelId',
    'policyModelId',
    'prefilterModelId',
    'escalationTimeoutSeconds',
    'gooseProvider',
    'gooseModel',
    'preferredDockerAgent',
    'preferredMode',
    'containerRuntime',
  ] as const;
  for (const key of topLevelKeys) {
    if (key in pending && pending[key] !== undefined && pending[key] !== resolved[key]) {
      diffs.push([key, { from: resolved[key], to: pending[key] }]);
    }
  }

  const nestedSections = [
    'resourceBudget',
    'autoCompact',
    'autoApprove',
    'auditRedaction',
    'memory',
    'dockerResources',
    'snapshot',
  ] as const;
  for (const section of nestedSections) {
    const pendingSection = pending[section];
    if (!pendingSection) continue;
    const resolvedSection = resolved[section] as unknown as Record<string, unknown>;
    for (const [subKey, subValue] of Object.entries(pendingSection)) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: runtime data from spread objects
      if (subValue !== undefined && subValue !== resolvedSection[subKey]) {
        diffs.push([`${section}.${subKey}`, { from: resolvedSection[subKey], to: subValue }]);
      }
    }
  }

  // serverCredentials — compare per-server credential blocks
  if (pending.serverCredentials) {
    for (const [server, creds] of Object.entries(pending.serverCredentials)) {
      const resolvedCreds = resolved.serverCredentials[server] ?? {};
      for (const [envVar, value] of Object.entries(creds)) {
        if (value !== resolvedCreds[envVar]) {
          diffs.push([
            `serverCredentials.${server}.${envVar}`,
            { from: maskApiKey(resolvedCreds[envVar]), to: maskApiKey(value) },
          ]);
        }
      }
    }
  }

  // webSearch — compare provider and per-provider blocks
  if (pending.webSearch) {
    const pw = pending.webSearch;
    const rw = resolved.webSearch;
    if (pw.provider !== undefined && pw.provider !== rw.provider) {
      diffs.push(['webSearch.provider', { from: rw.provider ?? 'none', to: pw.provider ?? 'none' }]);
    }
    // Show API key changes as masked values
    for (const prov of ['brave', 'tavily', 'serpapi'] as const) {
      const pendingBlock = pw[prov];
      if (!pendingBlock) continue;
      const resolvedBlock = rw[prov];
      if ('apiKey' in pendingBlock && pendingBlock.apiKey !== resolvedBlock?.apiKey) {
        diffs.push([
          `webSearch.${prov}.apiKey`,
          { from: maskApiKey(resolvedBlock?.apiKey), to: maskApiKey(pendingBlock.apiKey) },
        ]);
      }
    }
  }

  diffModelProviders(resolved, pending, diffs);

  return diffs;
}

/**
 * Dedicated `modelProviders` diff branch (not the generic nestedSections loop,
 * which compares by reference and would spuriously diff freshly-materialized
 * profile objects — m14). Deep-compares each profile field via JSON.stringify so
 * a no-op read-modify-write yields an EMPTY diff; masks every `apiKey`; renders
 * modelMap rows compactly.
 */
function diffModelProviders(resolved: ResolvedUserConfig, pending: UserConfig, diffs: [string, DiffEntry][]): void {
  const pendingMp = pending.modelProviders;
  if (!pendingMp) return;

  // default selector
  const resolvedDefault = resolved.modelProviders.default;
  if (pendingMp.default !== undefined && pendingMp.default !== resolvedDefault) {
    diffs.push(['modelProviders.default', { from: resolvedDefault, to: pendingMp.default }]);
  }

  if (!pendingMp.profiles) return;
  const resolvedProfiles = resolved.modelProviders.profiles;
  const pendingProfiles = pendingMp.profiles;

  // Added / changed profiles.
  for (const [name, pendingProfile] of Object.entries(pendingProfiles)) {
    if (name === NATIVE_PROFILE_NAME) continue;
    const before = name in resolvedProfiles ? resolvedProfileToInput(resolvedProfiles[name]) : undefined;
    diffOneProfile(name, before, pendingProfile, diffs);
  }

  // Removed profiles (present in resolved, absent in the whole-record pending write).
  for (const name of Object.keys(resolvedProfiles)) {
    if (name === NATIVE_PROFILE_NAME) continue;
    if (!(name in pendingProfiles)) {
      diffs.push([`modelProviders.profiles.${name}`, { from: 'configured', to: 'removed' }]);
    }
  }
}

/** Field-by-field diff of one profile, masking apiKey and rendering modelMap compactly. */
function diffOneProfile(
  name: string,
  before: PendingProfile | undefined,
  after: PendingProfile,
  diffs: [string, DiffEntry][],
): void {
  const prefix = `modelProviders.profiles.${name}`;

  if (!before) {
    diffs.push([prefix, { from: 'none', to: `added (${after.type})` }]);
    return;
  }
  if (before.type !== after.type) {
    diffs.push([`${prefix}.type`, { from: before.type, to: after.type }]);
    return;
  }
  if (before.type === 'native' || after.type === 'native') return;

  if (before.apiKey !== after.apiKey) {
    diffs.push([`${prefix}.apiKey`, { from: maskApiKey(before.apiKey), to: maskApiKey(after.apiKey) }]);
  }
  if (JSON.stringify(before.modelMap) !== JSON.stringify(after.modelMap)) {
    diffs.push([`${prefix}.modelMap`, { from: formatModelMap(before.modelMap), to: formatModelMap(after.modelMap) }]);
  }
  if (JSON.stringify(before.perAgent) !== JSON.stringify(after.perAgent)) {
    diffs.push([`${prefix}.perAgent`, { from: before.perAgent ?? {}, to: after.perAgent ?? {} }]);
  }
  if (JSON.stringify(before.providerPreference) !== JSON.stringify(after.providerPreference)) {
    diffs.push([
      `${prefix}.providerPreference`,
      { from: before.providerPreference ?? 'default', to: after.providerPreference ?? 'default' },
    ]);
  }
  if (before.sessionAffinity !== after.sessionAffinity) {
    diffs.push([`${prefix}.sessionAffinity`, { from: before.sessionAffinity, to: after.sessionAffinity }]);
  }
}

function formatDiffValue(key: string, value: unknown): string {
  if (value === null) return 'disabled';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (key.includes('ModelId') || key.includes('modelId')) return formatModelShort(value as string);
  if (key.includes('Tokens') || key === 'resourceBudget.maxTotalTokens') return formatTokens(value as number);
  if (key.includes('Seconds') || key === 'resourceBudget.maxSessionSeconds') return formatSeconds(value as number);
  if (key.includes('Cost')) return formatCost(value as number);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

// ─── Model prompt ────────────────────────────────────────────

async function promptModelId(message: string, current: string): Promise<string | undefined> {
  const options = KNOWN_MODELS.map((m) => ({
    value: m.value,
    label: m.label,
    hint: m.value === current ? '(current)' : undefined,
  }));
  options.push({ value: CUSTOM_MODEL_SENTINEL, label: 'Custom...', hint: undefined });

  const selected = await p.select({ message, options, initialValue: current });
  if (isCancelled(selected)) return undefined;

  if (selected === CUSTOM_MODEL_SENTINEL) {
    const custom = await p.text({
      message: 'Enter model ID (e.g., "anthropic:model-name"):',
      placeholder: current,
      validate: (val) => (val ? validateModelId(val) : 'Model ID is required'),
    });
    if (isCancelled(custom)) return undefined;
    return custom as string;
  }

  return selected as string;
}

// ─── Nullable number prompt ──────────────────────────────────

interface NullableNumberOpts {
  message: string;
  current: number | null;
  validate?: (n: number) => string | undefined;
  format?: (n: number | null) => string;
}

async function promptNullableNumber(opts: NullableNumberOpts): Promise<number | null | undefined> {
  const currentDisplay = opts.format
    ? opts.format(opts.current)
    : opts.current === null
      ? 'disabled'
      : String(opts.current);

  const action = await p.select({
    message: opts.message,
    options: [
      { value: 'set', label: 'Set value', hint: `current: ${currentDisplay}` },
      { value: 'disable', label: 'Disable (set to null)' },
      { value: 'keep', label: 'Keep current', hint: currentDisplay },
    ],
  });
  if (isCancelled(action)) return undefined;

  if (action === 'keep') return undefined;
  if (action === 'disable') return null;

  const input = await p.text({
    message: `Enter value:`,
    placeholder: opts.current !== null ? String(opts.current) : '',
    validate: (val) => {
      if (!val || val.trim() === '') return 'Must be a number';
      const n = Number(val);
      if (!Number.isFinite(n)) return 'Must be a finite number';
      return opts.validate?.(n);
    },
  });
  if (isCancelled(input)) return undefined;
  return Number(input);
}

// ─── Category handlers ───────────────────────────────────────

async function handleModels(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const currentAgent = pending.agentModelId ?? resolved.agentModelId;
    const currentPolicy = pending.policyModelId ?? resolved.policyModelId;
    const currentPrefilter = pending.prefilterModelId ?? resolved.prefilterModelId;

    const field = await p.select({
      message: 'Models',
      options: [
        { value: 'agentModelId', label: 'Agent model', hint: formatModelShort(currentAgent) },
        { value: 'policyModelId', label: 'Policy model', hint: formatModelShort(currentPolicy) },
        { value: 'prefilterModelId', label: 'Pre-filter model', hint: formatModelShort(currentPrefilter) },
        { value: 'back', label: 'Back' },
      ],
    });
    if (isCancelled(field) || field === 'back') return;

    const current =
      field === 'agentModelId' ? currentAgent : field === 'policyModelId' ? currentPolicy : currentPrefilter;
    const promptLabel =
      field === 'agentModelId'
        ? 'Select agent model:'
        : field === 'policyModelId'
          ? 'Select policy model:'
          : 'Select pre-filter model:';
    const newValue = await promptModelId(promptLabel, current);
    if (newValue !== undefined && newValue !== current) {
      (pending as Record<string, unknown>)[field as string] = newValue;
    }
  }
}

async function handleSecurity(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const currentTimeout = pending.escalationTimeoutSeconds ?? resolved.escalationTimeoutSeconds;
    const currentAutoApproveEnabled = pending.autoApprove?.enabled ?? resolved.autoApprove.enabled;
    const currentAutoApproveModel = pending.autoApprove?.modelId ?? resolved.autoApprove.modelId;

    const field = await p.select({
      message: 'Security',
      options: [
        {
          value: 'timeout',
          label: 'Escalation timeout',
          hint: formatSeconds(currentTimeout),
        },
        {
          value: 'autoApproveEnabled',
          label: 'Auto-approve escalations',
          hint: currentAutoApproveEnabled ? 'on' : 'off',
        },
        {
          value: 'autoApproveModel',
          label: 'Auto-approve model',
          hint: formatModelShort(currentAutoApproveModel),
        },
        { value: 'back', label: 'Back' },
      ],
    });
    if (isCancelled(field) || field === 'back') return;

    if (field === 'timeout') {
      const input = await p.text({
        message: `Escalation timeout in seconds (${ESCALATION_TIMEOUT_MIN}-${ESCALATION_TIMEOUT_MAX}):`,
        placeholder: String(currentTimeout),
        validate: (val) => {
          if (!val || val.trim() === '') return 'Must be an integer';
          const n = Number(val);
          if (isNaN(n) || !Number.isInteger(n)) return 'Must be an integer';
          if (n < ESCALATION_TIMEOUT_MIN) return `Minimum: ${ESCALATION_TIMEOUT_MIN}`;
          if (n > ESCALATION_TIMEOUT_MAX) return `Maximum: ${ESCALATION_TIMEOUT_MAX}`;
          return undefined;
        },
      });
      if (isCancelled(input)) continue;
      const newTimeout = Number(input);
      if (newTimeout !== currentTimeout) {
        pending.escalationTimeoutSeconds = newTimeout;
      }
    } else if (field === 'autoApproveEnabled') {
      const enabled = await p.confirm({
        message: 'Enable auto-approve for escalations?',
        initialValue: currentAutoApproveEnabled,
      });
      if (isCancelled(enabled)) continue;
      if (enabled !== currentAutoApproveEnabled) {
        pending.autoApprove = { ...pending.autoApprove, enabled: enabled as boolean };
      }
    } else if (field === 'autoApproveModel') {
      const newModel = await promptModelId('Select auto-approve model:', currentAutoApproveModel);
      if (newModel !== undefined && newModel !== currentAutoApproveModel) {
        pending.autoApprove = { ...pending.autoApprove, modelId: newModel };
      }
    }
  }
}

async function handleMemory(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const currentEnabled = pending.memory?.enabled ?? resolved.memory.enabled;
    const currentAutoSave = pending.memory?.autoSave ?? resolved.memory.autoSave;

    const field = await p.select({
      message: 'Memory',
      options: [
        {
          value: 'enabled',
          label: 'Enabled (kill switch — affects all personas/jobs)',
          hint: currentEnabled ? 'on' : 'off',
        },
        {
          value: 'autoSave',
          label: 'Auto-save session summary to memory',
          hint: currentAutoSave ? 'on' : 'off',
        },
        { value: 'back', label: 'Back' },
      ],
    });
    if (isCancelled(field) || field === 'back') return;

    if (field === 'enabled') {
      const enabled = await p.confirm({
        message: 'Enable memory globally? (turning this off disables memory for all personas and jobs)',
        initialValue: currentEnabled,
      });
      if (isCancelled(enabled)) continue;
      if (enabled !== currentEnabled) {
        pending.memory = { ...pending.memory, enabled: enabled as boolean };
      }
    } else if (field === 'autoSave') {
      const enabled = await p.confirm({
        message: 'Auto-save a session summary to memory when sessions end?',
        initialValue: currentAutoSave,
      });
      if (isCancelled(enabled)) continue;
      if (enabled !== currentAutoSave) {
        pending.memory = { ...pending.memory, autoSave: enabled as boolean };
      }
    }
  }
}

async function handleSnapshot(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const currentEnabled = pending.snapshot?.enabled ?? resolved.snapshot.enabled;
    const currentMaxAge = pending.snapshot?.maxAgeDays ?? resolved.snapshot.maxAgeDays;
    const currentSweep = pending.snapshot?.sweepIntervalHours ?? resolved.snapshot.sweepIntervalHours;

    const field = await p.select({
      message: 'Container Snapshots',
      options: [
        {
          value: 'enabled',
          label: 'Enabled (kill switch — snapshot capture + GC for all workflows)',
          hint: currentEnabled ? 'on' : 'off',
        },
        {
          value: 'maxAgeDays',
          label: 'Max snapshot age before GC (days)',
          hint: currentMaxAge === null ? 'unbounded' : String(currentMaxAge),
        },
        { value: 'sweepIntervalHours', label: 'GC sweep interval (hours)', hint: String(currentSweep) },
        { value: 'back', label: 'Back' },
      ],
    });
    if (isCancelled(field) || field === 'back') return;

    if (field === 'enabled') {
      const enabled = await p.confirm({
        message:
          'Enable workflow container snapshots globally? ' +
          '(off disables snapshot capture on stop and GC for all workflows)',
        initialValue: currentEnabled,
      });
      if (isCancelled(enabled)) continue;
      if (enabled !== currentEnabled) {
        pending.snapshot = { ...pending.snapshot, enabled: enabled as boolean };
      }
    } else if (field === 'maxAgeDays') {
      const next = await promptNullableNumber({
        message: 'Max snapshot age before automatic GC',
        current: currentMaxAge,
        validate: (n) => (n > 0 ? undefined : 'Must be a positive number of days'),
        format: (n) => (n === null ? 'unbounded' : `${n} day(s)`),
      });
      if (next !== undefined && next !== currentMaxAge) {
        pending.snapshot = { ...pending.snapshot, maxAgeDays: next };
      }
    } else if (field === 'sweepIntervalHours') {
      const input = await p.text({
        message: 'GC sweep interval (hours):',
        placeholder: String(currentSweep),
        validate: (val) => {
          if (!val || val.trim() === '') return 'Must be a positive number';
          const n = Number(val);
          if (!Number.isFinite(n) || n <= 0) return 'Must be positive';
          return undefined;
        },
      });
      if (isCancelled(input)) continue;
      const newVal = Number(input);
      if (newVal !== currentSweep) {
        pending.snapshot = { ...pending.snapshot, sweepIntervalHours: newVal };
      }
    }
  }
}

async function handleResourceLimits(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const budget = { ...resolved.resourceBudget, ...pending.resourceBudget };

    const field = await p.select({
      message: 'Resource Limits',
      options: [
        { value: 'maxTotalTokens', label: 'Max tokens', hint: formatTokens(budget.maxTotalTokens) },
        {
          value: 'maxSteps',
          label: 'Max steps',
          hint: budget.maxSteps === null ? 'disabled' : String(budget.maxSteps),
        },
        { value: 'maxSessionSeconds', label: 'Session timeout', hint: formatSeconds(budget.maxSessionSeconds) },
        { value: 'maxEstimatedCostUsd', label: 'Cost cap', hint: formatCost(budget.maxEstimatedCostUsd) },
        { value: 'warnThresholdPercent', label: 'Warning threshold', hint: `${budget.warnThresholdPercent}%` },
        { value: 'back', label: 'Back' },
      ],
    });
    if (isCancelled(field) || field === 'back') return;

    if (field === 'warnThresholdPercent') {
      const input = await p.text({
        message: 'Warning threshold percent (1-99):',
        placeholder: String(budget.warnThresholdPercent),
        validate: (val) => {
          if (!val || val.trim() === '') return 'Must be an integer';
          const n = Number(val);
          if (isNaN(n) || !Number.isInteger(n)) return 'Must be an integer';
          if (n < 1 || n > 99) return 'Must be between 1 and 99';
          return undefined;
        },
      });
      if (isCancelled(input)) continue;
      const newVal = Number(input);
      if (newVal !== budget.warnThresholdPercent) {
        pending.resourceBudget = { ...pending.resourceBudget, warnThresholdPercent: newVal };
      }
    } else {
      const key = field as 'maxTotalTokens' | 'maxSteps' | 'maxSessionSeconds' | 'maxEstimatedCostUsd';
      let formatFn: (n: number | null) => string;
      switch (key) {
        case 'maxTotalTokens':
          formatFn = formatTokens;
          break;
        case 'maxSessionSeconds':
          formatFn = formatSeconds;
          break;
        case 'maxEstimatedCostUsd':
          formatFn = formatCost;
          break;
        default:
          formatFn = (n) => (n === null ? 'disabled' : String(n));
          break;
      }

      const result = await promptNullableNumber({
        message: `${key}:`,
        current: budget[key],
        format: formatFn,
        validate: (n) => {
          if (n <= 0) return 'Must be positive';
          if (key !== 'maxEstimatedCostUsd' && key !== 'maxSessionSeconds' && !Number.isInteger(n)) {
            return 'Must be an integer';
          }
          return undefined;
        },
      });
      if (result !== undefined) {
        pending.resourceBudget = { ...pending.resourceBudget, [key]: result };
      }
    }
  }
}

async function handleAutoCompact(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const compact = { ...resolved.autoCompact, ...pending.autoCompact };

    const field = await p.select({
      message: 'Auto-Compact',
      options: [
        { value: 'enabled', label: 'Enabled', hint: compact.enabled ? 'on' : 'off' },
        { value: 'thresholdTokens', label: 'Threshold', hint: formatTokens(compact.thresholdTokens) },
        { value: 'keepRecentMessages', label: 'Keep recent messages', hint: String(compact.keepRecentMessages) },
        { value: 'summaryModelId', label: 'Summary model', hint: formatModelShort(compact.summaryModelId) },
        { value: 'back', label: 'Back' },
      ],
    });
    if (isCancelled(field) || field === 'back') return;

    if (field === 'enabled') {
      const enabled = await p.confirm({
        message: 'Enable auto-compaction?',
        initialValue: compact.enabled,
      });
      if (isCancelled(enabled)) continue;
      if (enabled !== compact.enabled) {
        pending.autoCompact = { ...pending.autoCompact, enabled: enabled as boolean };
      }
    } else if (field === 'thresholdTokens') {
      const input = await p.text({
        message: 'Compaction threshold in tokens:',
        placeholder: String(compact.thresholdTokens),
        validate: (val) => {
          if (!val || val.trim() === '') return 'Must be a positive integer';
          const n = Number(val);
          if (isNaN(n) || !Number.isInteger(n)) return 'Must be a positive integer';
          if (n <= 0) return 'Must be positive';
          return undefined;
        },
      });
      if (isCancelled(input)) continue;
      const newVal = Number(input);
      if (newVal !== compact.thresholdTokens) {
        pending.autoCompact = { ...pending.autoCompact, thresholdTokens: newVal };
      }
    } else if (field === 'keepRecentMessages') {
      const input = await p.text({
        message: 'Number of recent messages to keep:',
        placeholder: String(compact.keepRecentMessages),
        validate: (val) => {
          if (!val || val.trim() === '') return 'Must be a positive integer';
          const n = Number(val);
          if (isNaN(n) || !Number.isInteger(n)) return 'Must be a positive integer';
          if (n <= 0) return 'Must be positive';
          return undefined;
        },
      });
      if (isCancelled(input)) continue;
      const newVal = Number(input);
      if (newVal !== compact.keepRecentMessages) {
        pending.autoCompact = { ...pending.autoCompact, keepRecentMessages: newVal };
      }
    } else if (field === 'summaryModelId') {
      const newModel = await promptModelId('Select summary model:', compact.summaryModelId);
      if (newModel !== undefined && newModel !== compact.summaryModelId) {
        pending.autoCompact = { ...pending.autoCompact, summaryModelId: newModel };
      }
    }
  }
}

// ─── Web Search ──────────────────────────────────────────────

async function handleWebSearch(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const currentProvider = pending.webSearch?.provider ?? resolved.webSearch.provider;
    const currentLabel = currentProvider ? WEB_SEARCH_PROVIDER_LABELS[currentProvider] : 'not configured';

    const action = await p.select({
      message: 'Web Search',
      options: [
        { value: 'select', label: 'Select provider', hint: currentLabel },
        { value: 'disable', label: 'Disable web search' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (isCancelled(action) || action === 'back') return;

    if (action === 'disable') {
      // Clear all webSearch fields by setting provider to undefined (removes from config)
      pending.webSearch = {};
      return;
    }

    // Select provider
    const providerOptions = WEB_SEARCH_PROVIDERS.map((prov) => ({
      value: prov,
      label: WEB_SEARCH_PROVIDER_LABELS[prov],
      hint: prov === currentProvider ? '(current)' : undefined,
    }));

    const selected = await p.select({
      message: 'Select search provider:',
      options: providerOptions,
    });
    if (isCancelled(selected)) continue;
    const provider = selected as WebSearchProvider;

    p.note(`Get an API key at ${WEB_SEARCH_PROVIDER_URLS[provider]}`, WEB_SEARCH_PROVIDER_LABELS[provider]);

    const currentKey = resolved.webSearch[provider]?.apiKey;
    const apiKey = await p.text({
      message: `${WEB_SEARCH_PROVIDER_LABELS[provider]} API key:`,
      placeholder: currentKey ? '(keep current)' : 'Enter API key',
      validate: (val) => {
        if (!val && !currentKey) return 'API key is required';
        return undefined;
      },
    });
    if (isCancelled(apiKey)) continue;

    pending.webSearch = {
      provider,
      [provider]: { apiKey: (apiKey as string) || currentKey || '' },
    };
  }
}

// ─── Model Providers ─────────────────────────────────────────

/** Returns a shallow copy of `obj` without the given key (avoids `delete obj[dynamicKey]`). */
function omitKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...obj };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- key is intentionally dynamic here
  delete copy[key];
  return copy;
}

/**
 * Writes the whole `profiles` record + `default` into pending (read-modify-write,
 * required by the shallow `deepMergeConfig`). Callers always pass the complete
 * view so no unmentioned profile is dropped unintentionally.
 */
function commitModelProviders(
  pending: UserConfig,
  profiles: Record<string, PendingProfile>,
  defaultName: string,
): void {
  pending.modelProviders = { default: defaultName, profiles };
}

async function handleModelProviders(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const profiles = currentProfiles(resolved, pending);
    const defaultName = currentDefault(resolved, pending);

    const options: { value: string; label: string; hint?: string }[] = [
      {
        value: `profile:${NATIVE_PROFILE_NAME}`,
        label: NATIVE_PROFILE_NAME,
        hint: defaultName === NATIVE_PROFILE_NAME ? 'native routing (default, not editable)' : 'native routing',
      },
    ];
    for (const [name, profile] of Object.entries(profiles)) {
      const summary = profile.type === 'openrouter' ? summarizeOpenrouterProfile(profile) : 'native';
      options.push({
        value: `profile:${name}`,
        label: name,
        hint: `${profile.type}, ${summary}${name === defaultName ? ' (default)' : ''}`,
      });
    }
    options.push({ value: 'add', label: 'Add profile...' });
    options.push({ value: 'default', label: 'Set default', hint: defaultName });
    options.push({ value: 'back', label: 'Back' });

    const action = await p.select({ message: 'Model Providers', options });
    if (isCancelled(action) || action === 'back') return;

    if (action === 'add') {
      await addProfile(resolved, pending);
    } else if (action === 'default') {
      await setDefaultProfile(resolved, pending);
    } else if (typeof action === 'string' && action.startsWith('profile:')) {
      const name = action.slice('profile:'.length);
      if (name === NATIVE_PROFILE_NAME) {
        p.note('The native profile uses today’s canonical routing and cannot be edited or deleted.', 'native');
        continue;
      }
      await editProfile(resolved, pending, name);
    }
  }
}

async function addProfile(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  const profiles = currentProfiles(resolved, pending);
  const name = await p.text({
    message: 'Profile name:',
    placeholder: 'e.g. glm-5.2',
    validate: (val) => {
      if (!val || val.trim() === '') return 'Name is required';
      if (val === NATIVE_PROFILE_NAME) return `"${NATIVE_PROFILE_NAME}" is a reserved profile name.`;
      if (val in profiles) return `Profile "${val}" already exists.`;
      return undefined;
    },
  });
  if (isCancelled(name)) return;

  // v1 supports only the 'openrouter' type; native is implicit and never user-defined.
  p.note(
    'OpenRouter routes Docker agents through openrouter.ai with a bound model map + key.\n' +
      'Paste an sk-or-v1-... key; defaults map *sonnet*/*opus*/*haiku* -> ' +
      `${DEFAULT_GLM_SLUG} with a soft z-ai cache pin.`,
    'openrouter',
  );

  const apiKey = await p.text({
    message: 'OpenRouter API key (sk-or-v1-...):',
    placeholder: 'set via OPENROUTER_API_KEY env, or leave blank',
    validate: () => undefined,
  });
  if (isCancelled(apiKey)) return;

  const profile: PendingOpenrouterProfile = { type: 'openrouter' };
  if (apiKey) profile.apiKey = apiKey as string;
  profiles[name as string] = profile;
  commitModelProviders(pending, profiles, currentDefault(resolved, pending));
}

async function setDefaultProfile(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  const profiles = currentProfiles(resolved, pending);
  const currentName = currentDefault(resolved, pending);

  const options = [
    {
      value: NATIVE_PROFILE_NAME,
      label: NATIVE_PROFILE_NAME,
      hint: currentName === NATIVE_PROFILE_NAME ? '(current)' : undefined,
    },
    ...Object.keys(profiles).map((name) => ({
      value: name,
      label: name,
      hint: name === currentName ? '(current)' : undefined,
    })),
  ];

  const selected = await p.select({
    message: 'Default profile (applies when no per-session choice is made):',
    options,
  });
  if (isCancelled(selected)) return;
  const name = selected as string;
  if (name !== currentName) {
    commitModelProviders(pending, profiles, name);
  }
}

async function editProfile(resolved: ResolvedUserConfig, pending: UserConfig, name: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const profiles = currentProfiles(resolved, pending);
    if (!(name in profiles)) return;
    const profile = profiles[name];
    if (profile.type !== 'openrouter') return;

    const field = await p.select({
      message: `Profile: ${name}`,
      options: [
        { value: 'apiKey', label: 'API key', hint: maskApiKey(profile.apiKey) },
        { value: 'modelMap', label: 'Model map (glob -> slug)', hint: formatModelMap(profile.modelMap) },
        { value: 'perAgent', label: 'Per-agent model overrides', hint: perAgentSummary(profile) },
        {
          value: 'providerPreference',
          label: 'Provider preference (cache pinning)',
          hint: providerPreferenceSummary(profile.providerPreference),
        },
        {
          value: 'sessionAffinity',
          label: 'Session affinity (GLM cache)',
          hint: (profile.sessionAffinity ?? true) ? 'on' : 'off',
        },
        { value: 'delete', label: 'Delete profile' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (isCancelled(field) || field === 'back') return;

    if (field === 'delete') {
      const confirmed = await p.confirm({ message: `Delete profile "${name}"?`, initialValue: false });
      if (isCancelled(confirmed) || !confirmed) continue;
      const remaining = omitKey(profiles, name);
      // F10: never persist a `default` that names the just-deleted profile.
      const nextDefault = repointDefaultAfterDelete(currentDefault(resolved, pending), Object.keys(remaining));
      commitModelProviders(pending, remaining, nextDefault);
      return;
    }

    const updated = await editProfileField(field as string, profile);
    if (updated) {
      profiles[name] = updated;
      commitModelProviders(pending, profiles, currentDefault(resolved, pending));
    }
  }
}

/** Edits one field of an openrouter profile, returning the updated profile or undefined (no change). */
async function editProfileField(
  field: string,
  profile: PendingOpenrouterProfile,
): Promise<PendingOpenrouterProfile | undefined> {
  if (field === 'apiKey') {
    const apiKey = await p.text({
      message: 'OpenRouter API key (sk-or-v1-...):',
      placeholder: profile.apiKey ? '(keep current)' : 'leave blank to use OPENROUTER_API_KEY env',
      validate: () => undefined,
    });
    if (isCancelled(apiKey)) return undefined;
    const next: PendingOpenrouterProfile = { ...profile };
    if (apiKey) next.apiKey = apiKey as string;
    else delete next.apiKey;
    return next;
  }
  if (field === 'modelMap') return editModelMap(profile);
  if (field === 'perAgent') return editPerAgent(profile);
  if (field === 'providerPreference') return editProviderPreference(profile);
  if (field === 'sessionAffinity') {
    const enabled = await p.confirm({
      message: 'Inject a stable session_id for GLM cache affinity?',
      initialValue: profile.sessionAffinity ?? true,
    });
    if (isCancelled(enabled)) return undefined;
    return { ...profile, sessionAffinity: enabled as boolean };
  }
  return undefined;
}

async function editModelMap(profile: PendingOpenrouterProfile): Promise<PendingOpenrouterProfile | undefined> {
  const rows = [...(profile.modelMap ?? [])];
  p.note(
    'Ordered glob -> slug rules; first match wins (matched against the requested model id).\n' +
      'An EMPTY map means "per-agent-only mode": no glob mapping, rely on per-agent overrides.\n' +
      'Leaving the map unset uses the built-in defaults (*sonnet*/*opus*/*haiku* -> ' +
      `${DEFAULT_GLM_SLUG}).`,
    'Model map',
  );

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const options: { value: string; label: string; hint?: string }[] = rows.map((row, i) => ({
      value: `row:${i}`,
      label: `${row.match} -> ${row.model}`,
      hint: 'select to remove',
    }));
    options.push({ value: 'add', label: 'Add rule...' });
    options.push({ value: 'done', label: 'Done', hint: rows.length === 0 ? 'empty = per-agent-only mode' : undefined });

    const action = await p.select({ message: `Model map (${rows.length} rule(s))`, options });
    if (isCancelled(action) || action === 'done') break;

    if (action === 'add') {
      const match = await p.text({
        message: 'Glob to match (e.g. *sonnet*):',
        validate: (val) => (!val ? 'Match glob is required' : undefined),
      });
      if (isCancelled(match)) continue;
      const model = await p.text({
        message: 'Target OpenRouter slug (e.g. z-ai/glm-5.2):',
        placeholder: DEFAULT_GLM_SLUG,
        validate: (val) => (!val ? 'Target slug is required' : undefined),
      });
      if (isCancelled(model)) continue;
      rows.push({ match: match as string, model: model as string });
    } else if (typeof action === 'string' && action.startsWith('row:')) {
      const index = Number(action.slice('row:'.length));
      rows.splice(index, 1);
    }
  }

  return { ...profile, modelMap: rows };
}

async function editPerAgent(profile: PendingOpenrouterProfile): Promise<PendingOpenrouterProfile | undefined> {
  let perAgent: Record<string, string> = { ...(profile.perAgent ?? {}) };

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const options = DOCKER_AGENTS.map((agent) => ({
      value: agent,
      label: DOCKER_AGENT_LABELS[agent],
      hint: perAgent[agent] ?? 'none (use model map)',
    }));

    const selected = await p.select({
      message: 'Per-agent model overrides (wins over the model map)',
      options: [...options, { value: 'back', label: 'Back', hint: '' }],
    });
    if (isCancelled(selected) || selected === 'back') break;

    const agent = selected as DockerAgent;
    const slug = await p.text({
      message: `${DOCKER_AGENT_LABELS[agent]} model slug (blank to clear):`,
      placeholder: perAgent[agent] ?? DEFAULT_GLM_SLUG,
      validate: () => undefined,
    });
    if (isCancelled(slug)) continue;
    if (slug) perAgent[agent] = slug as string;
    else perAgent = omitKey(perAgent, agent);
  }

  const next: PendingOpenrouterProfile = { ...profile };
  if (Object.keys(perAgent).length > 0) next.perAgent = perAgent;
  else delete next.perAgent;
  return next;
}

async function editProviderPreference(
  profile: PendingOpenrouterProfile,
): Promise<PendingOpenrouterProfile | undefined> {
  const pref: NonNullable<PendingOpenrouterProfile['providerPreference']> = { ...(profile.providerPreference ?? {}) };

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const field = await p.select({
      message: 'Provider preference (leave unset for the default soft z-ai pin on z-ai/* slugs)',
      options: [
        { value: 'order', label: 'order (soft pin)', hint: pref.order?.join(', ') ?? 'none' },
        { value: 'only', label: 'only (strict pin)', hint: pref.only?.join(', ') ?? 'none' },
        {
          value: 'allowFallbacks',
          label: 'allowFallbacks',
          hint: pref.allowFallbacks === undefined ? 'default (true)' : pref.allowFallbacks ? 'true' : 'false',
        },
        { value: 'clear', label: 'Clear (revert to default pin)' },
        { value: 'back', label: 'Back' },
      ],
    });
    if (isCancelled(field) || field === 'back') break;

    if (field === 'clear') {
      return { ...profile, providerPreference: undefined };
    }
    if (field === 'order' || field === 'only') {
      const input = await p.text({
        message: `${field} — comma-separated provider slugs (e.g. z-ai), blank to clear:`,
        placeholder: pref[field]?.join(', ') ?? 'z-ai',
        validate: () => undefined,
      });
      if (isCancelled(input)) continue;
      const list = (input as string)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const next = list.length > 0 ? list : undefined;
      if (field === 'order') pref.order = next;
      else pref.only = next;
    } else if (field === 'allowFallbacks') {
      const enabled = await p.confirm({
        message: 'Allow OpenRouter to fall back to other providers?',
        initialValue: pref.allowFallbacks ?? true,
      });
      if (isCancelled(enabled)) continue;
      pref.allowFallbacks = enabled as boolean;
    }
  }

  const cleaned: NonNullable<PendingOpenrouterProfile['providerPreference']> = {};
  if (pref.order !== undefined) cleaned.order = pref.order;
  if (pref.only !== undefined) cleaned.only = pref.only;
  if (pref.allowFallbacks !== undefined) cleaned.allowFallbacks = pref.allowFallbacks;
  const hasAny = Object.keys(cleaned).length > 0;
  return { ...profile, providerPreference: hasAny ? cleaned : undefined };
}

function perAgentSummary(profile: PendingOpenrouterProfile): string {
  const perAgent = profile.perAgent;
  if (!perAgent) return 'none';
  const entries = Object.entries(perAgent).filter(([, v]) => v);
  if (entries.length === 0) return 'none';
  return entries.map(([agent, slug]) => `${agent}=${slug}`).join(', ');
}

function providerPreferenceSummary(pref: PendingOpenrouterProfile['providerPreference'] | undefined): string {
  if (!pref) return 'default (soft z-ai pin)';
  const parts: string[] = [];
  if (pref.only) parts.push(`only: ${pref.only.join(', ')}`);
  if (pref.order) parts.push(`order: ${pref.order.join(', ')}`);
  if (pref.allowFallbacks !== undefined) parts.push(`fallbacks: ${pref.allowFallbacks ? 'on' : 'off'}`);
  return parts.length > 0 ? parts.join(', ') : 'default';
}

// ─── Server Credentials ──────────────────────────────────────

/** Loads server names from mcp-servers.json for the credential editor. */
function loadServerNames(): string[] {
  try {
    const mcpServersPath = resolve(__dirname, 'mcp-servers.json');
    const mcpServers = JSON.parse(readFileSync(mcpServersPath, 'utf-8')) as Record<string, MCPServerConfig>;
    return Object.keys(mcpServers);
  } catch {
    return [];
  }
}

interface CredentialHint {
  envVar: string;
  description: string;
  signupUrl?: string;
}

/** Known credential env vars per server -- guides the user on what to configure. */
const SERVER_CREDENTIAL_HINTS: Partial<Record<string, CredentialHint[]>> = {
  github: [
    {
      envVar: 'GITHUB_PERSONAL_ACCESS_TOKEN',
      description: 'GitHub personal access token',
      signupUrl: 'https://github.com/settings/tokens/new (classic token required)',
    },
  ],
};

async function handleServerCredentials(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  const serverNames = loadServerNames();

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const currentCreds: Record<string, Record<string, string> | undefined> = {
      ...resolved.serverCredentials,
      ...pending.serverCredentials,
    };
    const options = serverNames.map((name) => {
      const creds = currentCreds[name];
      const count = creds ? Object.keys(creds).length : 0;
      return {
        value: name,
        label: name,
        hint: count > 0 ? `${count} credential${count > 1 ? 's' : ''} configured` : 'none',
      };
    });
    options.push({ value: 'back', label: 'Back', hint: '' });

    const selected = await p.select({ message: 'Server Credentials', options });
    if (isCancelled(selected) || selected === 'back') return;

    const serverName = selected as string;
    const hints = SERVER_CREDENTIAL_HINTS[serverName];
    const existingCreds = currentCreds[serverName] ?? {};

    if (hints) {
      // Guided flow for known servers
      for (const hint of hints) {
        const currentValue = existingCreds[hint.envVar];
        if (hint.signupUrl) {
          p.note(`Get a token at ${hint.signupUrl}`, hint.description);
        }
        const input = await p.text({
          message: `${hint.envVar}:`,
          placeholder: currentValue ? '(keep current)' : `Enter ${hint.description}`,
          validate: (val) => {
            if (!val && !currentValue) return `${hint.envVar} is required`;
            return undefined;
          },
        });
        if (isCancelled(input)) break;
        const value = (input as string) || currentValue;
        if (value) {
          const existingServerCreds = resolved.serverCredentials[serverName] ?? {};
          pending.serverCredentials = {
            ...pending.serverCredentials,
            [serverName]: { ...existingServerCreds, ...pending.serverCredentials?.[serverName], [hint.envVar]: value },
          };
        }
      }
    } else {
      // Generic flow for unknown servers
      const action = await p.select({
        message: `Credentials for ${serverName}`,
        options: [
          { value: 'add', label: 'Add credential' },
          { value: 'back', label: 'Back' },
        ],
      });
      if (isCancelled(action) || action === 'back') continue;

      const envVar = await p.text({
        message: 'Environment variable name:',
        validate: (val) => (!val ? 'Name is required' : undefined),
      });
      if (isCancelled(envVar)) continue;

      const value = await p.text({
        message: `Value for ${envVar as string}:`,
        validate: (val) => (!val ? 'Value is required' : undefined),
      });
      if (isCancelled(value)) continue;

      const existingServerCreds = resolved.serverCredentials[serverName] ?? {};
      pending.serverCredentials = {
        ...pending.serverCredentials,
        [serverName]: {
          ...existingServerCreds,
          ...pending.serverCredentials?.[serverName],
          [envVar as string]: value as string,
        },
      };
    }
  }
}

// ─── Session Mode ─────────────────────────────────────────────

/** Human-readable labels for session modes. */
const SESSION_MODE_LABELS: Readonly<Record<SessionModeKind, string>> = {
  docker: 'Docker (recommended)',
  builtin: 'Builtin (V8 sandbox)',
};

/** Short labels used in hints (no parenthetical). */
const SESSION_MODE_SHORT_LABELS: Readonly<Record<SessionModeKind, string>> = {
  docker: 'Docker',
  builtin: 'Builtin',
};

/** Human-readable labels for container runtime backends. */
const CONTAINER_RUNTIME_LABELS: Readonly<Record<ContainerRuntimeSetting, string>> = {
  auto: 'Auto (prefer Apple container when available)',
  docker: 'Docker',
  'apple-container': 'Apple container (macOS 26+, Apple silicon)',
};

async function handleSessionMode(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const currentMode = pending.preferredMode ?? resolved.preferredMode;
    const currentRuntime = pending.containerRuntime ?? resolved.containerRuntime;

    const field = await p.select({
      message: 'Session Mode',
      options: [
        {
          value: 'preferredMode',
          label: 'Preferred mode',
          hint: SESSION_MODE_LABELS[currentMode],
        },
        {
          value: 'containerRuntime',
          label: 'Container runtime',
          hint: CONTAINER_RUNTIME_LABELS[currentRuntime],
        },
        { value: 'back', label: 'Back' },
      ],
    });
    if (isCancelled(field) || field === 'back') return;

    if (field === 'containerRuntime') {
      const runtimeOptions = CONTAINER_RUNTIMES.map((runtime) => ({
        value: runtime,
        label: CONTAINER_RUNTIME_LABELS[runtime],
        hint: runtime === currentRuntime ? '(current)' : undefined,
      }));

      const selected = await p.select({
        message: 'Select container runtime backend:',
        options: runtimeOptions,
        initialValue: currentRuntime,
      });
      if (isCancelled(selected)) continue;
      const runtime = selected as ContainerRuntimeSetting;
      if (runtime !== currentRuntime) {
        pending.containerRuntime = runtime;
      }
      continue;
    }

    if (field === 'preferredMode') {
      const modeOptions = SESSION_MODES.map((mode) => ({
        value: mode,
        label: SESSION_MODE_LABELS[mode],
        hint: mode === currentMode ? '(current)' : undefined,
      }));

      const selected = await p.select({
        message: 'Select preferred session mode:',
        options: modeOptions,
        initialValue: currentMode,
      });
      if (isCancelled(selected)) continue;
      const mode = selected as SessionModeKind;
      if (mode !== currentMode) {
        pending.preferredMode = mode;
      }
    }
  }
}

// ─── Docker Agent Settings ────────────────────────────────────

/** Human-readable labels for Goose providers. */
const GOOSE_PROVIDER_LABELS: Readonly<Record<GooseProvider, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

/** Human-readable labels for Docker agents. */
const DOCKER_AGENT_LABELS: Readonly<Record<DockerAgent, string>> = {
  'claude-code': 'Claude Code',
  goose: 'Goose',
  codex: 'Codex CLI',
};

async function handleDockerAgent(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const currentPreferred = pending.preferredDockerAgent ?? resolved.preferredDockerAgent;

    const options: { value: string; label: string; hint?: string }[] = [
      {
        value: 'preferredDockerAgent',
        label: 'Preferred agent',
        hint: DOCKER_AGENT_LABELS[currentPreferred],
      },
      {
        value: 'dockerResources',
        label: 'Container resources...',
        hint: dockerResourcesSummary(resolved, pending),
      },
      {
        value: 'configureGoose',
        label: 'Configure Goose...',
        hint: gooseConfigHint(resolved, pending),
      },
      { value: 'back', label: 'Back' },
    ];

    const field = await p.select({
      message: 'Docker Agent Settings',
      options,
    });
    if (isCancelled(field) || field === 'back') return;

    if (field === 'preferredDockerAgent') {
      const agentOptions = DOCKER_AGENTS.map((agent) => ({
        value: agent,
        label: DOCKER_AGENT_LABELS[agent],
        hint: agent === currentPreferred ? '(current)' : undefined,
      }));

      const selected = await p.select({
        message: 'Select preferred Docker agent:',
        options: agentOptions,
        initialValue: currentPreferred,
      });
      if (isCancelled(selected)) continue;
      const agent = selected as DockerAgent;
      if (agent !== currentPreferred) {
        pending.preferredDockerAgent = agent;
      }
    } else if (field === 'configureGoose') {
      await handleGooseConfig(resolved, pending);
    } else if (field === 'dockerResources') {
      await handleDockerResources(resolved, pending);
    }
  }
}

/** Submenu for Docker container memory and cpu ceilings. */
async function handleDockerResources(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const current = { ...resolved.dockerResources, ...(pending.dockerResources ?? {}) };

    const field = await p.select({
      message: 'Docker container resources',
      options: [
        {
          value: 'memoryMb',
          label: 'Memory ceiling (MB)',
          hint: current.memoryMb === null ? 'unlimited' : `${current.memoryMb} MB`,
        },
        {
          value: 'cpus',
          label: 'CPU ceiling',
          hint: current.cpus === null ? 'unlimited' : String(current.cpus),
        },
        { value: 'back', label: 'Back' },
      ],
    });
    if (isCancelled(field) || field === 'back') return;

    if (field === 'memoryMb') {
      const result = await promptNullableNumber({
        message: 'Memory ceiling (MB):',
        current: current.memoryMb,
        format: (n) => (n === null ? 'unlimited' : `${n} MB`),
        validate: (n) => {
          if (!Number.isInteger(n)) return 'Must be an integer';
          if (n < 6) return 'Must be at least 6 (Docker minimum)';
          return undefined;
        },
      });
      if (result !== undefined) {
        pending.dockerResources = { ...(pending.dockerResources ?? {}), memoryMb: result };
      }
    } else if (field === 'cpus') {
      const result = await promptNullableNumber({
        message: 'CPU ceiling (decimal allowed, e.g. 1.5):',
        current: current.cpus,
        format: (n) => (n === null ? 'unlimited' : String(n)),
        validate: (n) => {
          if (n < 0.01) return 'Must be at least 0.01 (Docker minimum)';
          return undefined;
        },
      });
      if (result !== undefined) {
        pending.dockerResources = { ...(pending.dockerResources ?? {}), cpus: result };
      }
    }
  }
}

function dockerResourcesSummary(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const r = { ...resolved.dockerResources, ...(pending.dockerResources ?? {}) };
  const cpu = r.cpus === null ? 'unlimited' : `${r.cpus} cpus`;
  const mem = r.memoryMb === null ? 'unlimited' : `${r.memoryMb} MB`;
  return `${cpu}, ${mem}`;
}

/** Goose-specific configuration submenu (provider + model). */
async function handleGooseConfig(resolved: ResolvedUserConfig, pending: UserConfig): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const currentProvider = pending.gooseProvider ?? resolved.gooseProvider;
    const currentModel = pending.gooseModel ?? resolved.gooseModel;

    const field = await p.select({
      message: 'Goose Configuration',
      options: [
        {
          value: 'gooseProvider',
          label: 'LLM provider',
          hint: GOOSE_PROVIDER_LABELS[currentProvider],
        },
        {
          value: 'gooseModel',
          label: 'Model',
          hint: currentModel,
        },
        { value: 'back', label: 'Back' },
      ],
    });
    if (isCancelled(field) || field === 'back') return;

    if (field === 'gooseProvider') {
      const providerOptions = GOOSE_PROVIDERS.map((prov) => ({
        value: prov,
        label: GOOSE_PROVIDER_LABELS[prov],
        hint: prov === currentProvider ? '(current)' : undefined,
      }));

      const selected = await p.select({
        message: 'Select Goose LLM provider:',
        options: providerOptions,
        initialValue: currentProvider,
      });
      if (isCancelled(selected)) continue;
      const provider = selected as GooseProvider;
      if (provider !== currentProvider) {
        pending.gooseProvider = provider;
      }
    } else if (field === 'gooseModel') {
      const input = await p.text({
        message: 'Goose model identifier:',
        placeholder: currentModel,
        validate: (val) => (!val ? 'Model ID is required' : undefined),
      });
      if (isCancelled(input)) continue;
      const model = input as string;
      if (model !== currentModel) {
        pending.gooseModel = model;
      }
    }
  }
}

function gooseConfigHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const provider = GOOSE_PROVIDER_LABELS[pending.gooseProvider ?? resolved.gooseProvider];
  const model = pending.gooseModel ?? resolved.gooseModel;
  return `${provider}, ${model}`;
}

// ─── Menu descriptions ───────────────────────────────────────

function modelsHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const agent = formatModelShort(pending.agentModelId ?? resolved.agentModelId);
  const policy = formatModelShort(pending.policyModelId ?? resolved.policyModelId);
  const prefilter = formatModelShort(pending.prefilterModelId ?? resolved.prefilterModelId);
  return `${agent}, ${policy}, pre-filter: ${prefilter}`;
}

function securityHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const timeout = formatSeconds(pending.escalationTimeoutSeconds ?? resolved.escalationTimeoutSeconds);
  const autoApprove = (pending.autoApprove?.enabled ?? resolved.autoApprove.enabled) ? 'on' : 'off';
  return `timeout: ${timeout}, auto-approve: ${autoApprove}`;
}

function resourceHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const b = { ...resolved.resourceBudget, ...pending.resourceBudget };
  return `tokens: ${formatTokens(b.maxTotalTokens)}, steps: ${b.maxSteps === null ? 'off' : b.maxSteps}, time: ${formatSeconds(b.maxSessionSeconds)}, cost: ${formatCost(b.maxEstimatedCostUsd)}`;
}

function autoCompactHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const c = { ...resolved.autoCompact, ...pending.autoCompact };
  return c.enabled ? `on, threshold: ${formatTokens(c.thresholdTokens)}` : 'off';
}

function webSearchHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const provider = pending.webSearch?.provider ?? resolved.webSearch.provider;
  return provider ? WEB_SEARCH_PROVIDER_LABELS[provider] : 'not configured';
}

function modelProvidersHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const profiles = currentProfiles(resolved, pending);
  const count = Object.keys(profiles).length;
  const defaultName = currentDefault(resolved, pending);
  if (count === 0) return `default: ${defaultName}`;
  return `${count} profile${count > 1 ? 's' : ''}, default: ${defaultName}`;
}

function serverCredentialsHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const creds = { ...resolved.serverCredentials, ...pending.serverCredentials };
  const configured = Object.entries(creds).filter(([, v]) => Object.keys(v).length > 0);
  if (configured.length === 0) return 'none';
  return configured.map(([name]) => name).join(', ');
}

function memoryHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const enabled = pending.memory?.enabled ?? resolved.memory.enabled;
  const autoSave = pending.memory?.autoSave ?? resolved.memory.autoSave;
  if (!enabled) return 'off (kill switch)';
  return `on, auto-save: ${autoSave ? 'on' : 'off'}`;
}

function snapshotHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const enabled = pending.snapshot?.enabled ?? resolved.snapshot.enabled;
  const maxAge = pending.snapshot?.maxAgeDays ?? resolved.snapshot.maxAgeDays;
  if (!enabled) return 'off (kill switch)';
  return `on, max age: ${maxAge === null ? 'unbounded' : `${maxAge}d`}`;
}

function dockerAgentHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const agent = DOCKER_AGENT_LABELS[pending.preferredDockerAgent ?? resolved.preferredDockerAgent];
  return `${agent}, ${dockerResourcesSummary(resolved, pending)}`;
}

function sessionModeHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  return SESSION_MODE_SHORT_LABELS[pending.preferredMode ?? resolved.preferredMode];
}

function changeCount(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const diffs = computeDiff(resolved, pending);
  if (diffs.length === 0) return 'no changes';
  return `${diffs.length} change${diffs.length > 1 ? 's' : ''} pending`;
}

// ─── Main ────────────────────────────────────────────────────

export async function runConfigCommand(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('Error: ironcurtain config requires an interactive terminal (TTY).');
    process.exit(1);
  }

  let resolved: ResolvedUserConfig;
  try {
    resolved = loadUserConfig();
  } catch (err) {
    console.error(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`Check ${getUserConfigPath()} for errors.`);
    process.exit(1);
  }

  p.intro('IronCurtain Configuration');
  p.note(
    `Config path: ${getUserConfigPath()}\n` + 'API keys: set via environment variables or edit JSON directly.',
    'Info',
  );

  const pending: UserConfig = {};

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- interactive loop exited via return
  while (true) {
    const category = await p.select({
      message: 'Select a category to configure',
      options: [
        { value: 'models', label: `Models (${modelsHint(resolved, pending)})` },
        { value: 'security', label: `Security (${securityHint(resolved, pending)})` },
        { value: 'resources', label: `Resource Limits (${resourceHint(resolved, pending)})` },
        { value: 'compact', label: `Auto-Compact (${autoCompactHint(resolved, pending)})` },
        { value: 'websearch', label: `Web Search (${webSearchHint(resolved, pending)})` },
        { value: 'modelProviders', label: `Model Providers (${modelProvidersHint(resolved, pending)})` },
        { value: 'credentials', label: `Server Credentials (${serverCredentialsHint(resolved, pending)})` },
        { value: 'memory', label: `Memory (${memoryHint(resolved, pending)})` },
        { value: 'snapshots', label: `Container Snapshots (${snapshotHint(resolved, pending)})` },
        { value: 'sessionMode', label: `Session Mode (${sessionModeHint(resolved, pending)})` },
        { value: 'dockerAgent', label: `Docker Agent (${dockerAgentHint(resolved, pending)})` },
        { value: 'save', label: 'Save & Exit', hint: changeCount(resolved, pending) },
        { value: 'cancel', label: 'Cancel', hint: 'discard all changes' },
      ],
    });
    if (isCancelled(category)) {
      p.cancel('Changes discarded.');
      return;
    }

    switch (category) {
      case 'models':
        await handleModels(resolved, pending);
        break;
      case 'security':
        await handleSecurity(resolved, pending);
        break;
      case 'resources':
        await handleResourceLimits(resolved, pending);
        break;
      case 'compact':
        await handleAutoCompact(resolved, pending);
        break;
      case 'websearch':
        await handleWebSearch(resolved, pending);
        break;
      case 'modelProviders':
        await handleModelProviders(resolved, pending);
        break;
      case 'credentials':
        await handleServerCredentials(resolved, pending);
        break;
      case 'memory':
        await handleMemory(resolved, pending);
        break;
      case 'snapshots':
        await handleSnapshot(resolved, pending);
        break;
      case 'sessionMode':
        await handleSessionMode(resolved, pending);
        break;
      case 'dockerAgent':
        await handleDockerAgent(resolved, pending);
        break;
      case 'cancel':
        p.cancel('Changes discarded.');
        return;
      case 'save': {
        const diffs = computeDiff(resolved, pending);
        if (diffs.length === 0) {
          p.outro('No changes to save.');
          return;
        }

        const diffText = diffs
          .map(([path, { from, to }]) => `  ${path}: ${formatDiffValue(path, from)} -> ${formatDiffValue(path, to)}`)
          .join('\n');
        p.note(diffText, 'Pending changes');

        const confirmed = await p.confirm({
          message: 'Save these changes?',
          initialValue: true,
        });
        if (isCancelled(confirmed)) continue;

        if (confirmed) {
          saveUserConfig(pending);
          p.outro('Configuration saved.');
        } else {
          p.outro('Save cancelled. Changes not written.');
        }
        return;
      }
    }
  }
}
