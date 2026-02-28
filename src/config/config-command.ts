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
  type UserConfig,
  type ResolvedUserConfig,
  type WebSearchProvider,
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

export function maskApiKey(key: string | undefined | null): string {
  if (!key) return 'none';
  if (key.length <= 6) return '***';
  return key.slice(0, 3) + '...' + key.slice(-3);
}

function formatModelShort(id: string): string {
  const known = KNOWN_MODELS.find((m) => m.value === id);
  return known ? known.label : id;
}

// ─── Diff ────────────────────────────────────────────────────

interface DiffEntry {
  from: unknown;
  to: unknown;
}

export function computeDiff(resolved: ResolvedUserConfig, pending: UserConfig): [string, DiffEntry][] {
  const diffs: [string, DiffEntry][] = [];

  const topLevelKeys = ['agentModelId', 'policyModelId', 'escalationTimeoutSeconds'] as const;
  for (const key of topLevelKeys) {
    if (key in pending && pending[key] !== undefined && pending[key] !== resolved[key]) {
      diffs.push([key, { from: resolved[key], to: pending[key] }]);
    }
  }

  const nestedSections = ['resourceBudget', 'autoCompact', 'autoApprove', 'auditRedaction'] as const;
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

  return diffs;
}

function formatDiffValue(key: string, value: unknown): string {
  if (value === null) return 'disabled';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (key.includes('ModelId') || key.includes('modelId')) return formatModelShort(value as string);
  if (key.includes('Tokens') || key === 'resourceBudget.maxTotalTokens') return formatTokens(value as number);
  if (key.includes('Seconds') || key === 'resourceBudget.maxSessionSeconds') return formatSeconds(value as number);
  if (key.includes('Cost')) return formatCost(value as number);
  return String(value as string | number);
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
      if (isNaN(n)) return 'Must be a number';
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

    const field = await p.select({
      message: 'Models',
      options: [
        { value: 'agentModelId', label: 'Agent model', hint: formatModelShort(currentAgent) },
        { value: 'policyModelId', label: 'Policy model', hint: formatModelShort(currentPolicy) },
        { value: 'back', label: 'Back' },
      ],
    });
    if (isCancelled(field) || field === 'back') return;

    const current = field === 'agentModelId' ? currentAgent : currentPolicy;
    const newValue = await promptModelId(
      field === 'agentModelId' ? 'Select agent model:' : 'Select policy model:',
      current,
    );
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

// ─── Menu descriptions ───────────────────────────────────────

function modelsHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const agent = formatModelShort(pending.agentModelId ?? resolved.agentModelId);
  const policy = formatModelShort(pending.policyModelId ?? resolved.policyModelId);
  return `${agent}, ${policy}`;
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

function serverCredentialsHint(resolved: ResolvedUserConfig, pending: UserConfig): string {
  const creds = { ...resolved.serverCredentials, ...pending.serverCredentials };
  const configured = Object.entries(creds).filter(([, v]) => Object.keys(v).length > 0);
  if (configured.length === 0) return 'none';
  return configured.map(([name]) => name).join(', ');
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
        { value: 'credentials', label: `Server Credentials (${serverCredentialsHint(resolved, pending)})` },
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
      case 'credentials':
        await handleServerCredentials(resolved, pending);
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
